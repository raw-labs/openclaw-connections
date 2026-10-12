import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { z } from "zod";
import {
  managementInputs,
  searchInput,
  describeInput,
  callInput,
  publicConnection,
  type ManagementMethod,
  type StoredConnection,
  type Receipt,
} from "./contracts.js";
import { ConnectionStore } from "./store.js";
import { ComposioCatalog } from "./catalog.js";
import type {
  ConnectorProvider,
  ConnectorProviderBinding,
} from "./types/provider.js";
import { ConnectorProviderError } from "./types/provider.js";
import { ConnectionError, failure } from "./errors.js";
import { canonicalJson, parseJson } from "./shared/json.js";

export interface NativeContext {
  agentId: string;
  toolCallId: string;
  sessionId?: string;
  sessionKey?: string;
  signal?: AbortSignal;
}
const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");
function matches(values: string[], query: string) {
  const haystack = values.join(" ").toLowerCase().replaceAll("_", " ");
  return query
    .trim()
    .toLowerCase()
    .split(/\s+/u)
    .every((term) => haystack.includes(term.replaceAll("_", " ")));
}
const signalFor = (signal?: AbortSignal) =>
  signal
    ? AbortSignal.any([signal, AbortSignal.timeout(90_000)])
    : AbortSignal.timeout(90_000);

/** All management and execution share one queue, so a grant edit cannot race a dispatch. */
export class ConnectionsService {
  private tail: Promise<void> = Promise.resolve();
  constructor(
    readonly store: ConnectionStore,
    private readonly provider: ConnectorProvider,
    readonly catalog: ComposioCatalog,
    private readonly authConfigIds: Readonly<Record<string, string>> = {},
  ) {}
  async serial<T>(work: () => Promise<T>): Promise<T> {
    const previous = this.tail;
    let release: () => void = () => {};
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await work();
    } finally {
      release();
    }
  }
  async close() {
    await this.tail;
    await this.store.close();
  }
  manage(
    method: ManagementMethod,
    raw: unknown,
    actor: string,
    agents: readonly string[],
    current: () => void,
  ): Promise<unknown> {
    return this.serial(async () => {
      current();
      const signal = signalFor();
      const get = async (id: string, revision?: number) => {
        const item = await this.store.get(id);
        current();
        if (revision !== undefined && item.revision !== revision)
          throw new ConnectionError(
            "revision_conflict",
            "This connection changed. Refresh before continuing.",
          );
        return item;
      };
      const validGrant = (grant: StoredConnection["grant"]) => {
        if (
          grant.mode === "selected" &&
          grant.agentIds.some((id) => !agents.includes(id))
        )
          throw new ConnectionError(
            "invalid_grant",
            "One of the selected agents is unavailable. Refresh the agent list.",
          );
      };
      switch (method) {
        case "status":
          managementInputs.status.parse(raw);
          return { configured: true, userId: this.store.userId };
        case "list": {
          managementInputs.list.parse(raw);
          return {
            items: (await this.store.list()).map(publicConnection),
            nextCursor: null,
          };
        }
        case "catalog":
          managementInputs.catalog.parse(raw);
          return { items: this.catalog.connectors, nextCursor: null };
        case "agents":
          managementInputs.agents.parse(raw);
          return { agents: agents.map((id) => ({ id })) };
        case "usage":
          managementInputs.usage.parse(raw);
          return this.store.usage();
        case "create": {
          const input = managementInputs.create.parse(raw);
          this.catalog.connector(input.connectorId);
          validGrant(input.grant);
          const item: StoredConnection = {
            ...input,
            id: randomUUID(),
            generation: 0,
            revision: 0,
            state: "not_connected",
            binding: null,
            setup: null,
            failure: null,
          };
          await this.store.insert(item, current);
          return publicConnection(item);
        }
        case "update": {
          const input = managementInputs.update.parse(raw);
          validGrant(input.grant);
          return publicConnection(
            await this.store.save(
              {
                ...(await get(input.connectionId, input.revision)),
                name: input.name,
                grant: input.grant,
              },
              current,
            ),
          );
        }
        case "start": {
          const input = managementInputs.start.parse(raw);
          let item = await get(input.connectionId, input.revision);
          if (
            item.setup &&
            ["creating", "pending", "unknown"].includes(item.setup.state)
          )
            throw new ConnectionError(
              "setup_exists",
              "A setup already exists. Continue or cancel it before starting another.",
            );
          const connector = this.catalog.connector(item.connectorId);
          const ticket = randomBytes(32).toString("base64url");
          // Disable execution and retire the old generation before touching Composio.
          item = await this.store.save(
            {
              ...item,
              state: "not_connected",
              generation: item.generation + 1,
              failure: null,
              setup: {
                id: randomUUID(),
                state: "creating",
                actor,
                ticketHash: digest(ticket),
                binding: null,
                url: null,
                expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
                failure: null,
              },
            },
            current,
          );
          const setup = item.setup;
          if (!setup)
            throw new ConnectionError(
              "invalid_setup",
              "The setup is unavailable.",
            );
          let setupDispatched = false;
          try {
            if (item.binding) {
              current();
              await this.provider.deleteAccount(item.binding, signal);
              item = await this.store.save({ ...item, binding: null }, current);
            }
            let authId = this.authConfigIds[item.connectorId];
            if (!authId) {
              if (connector.auth.kind === "custom")
                throw new ConnectionError(
                  "auth_config_required",
                  "This service requires an existing Composio auth configuration. Set its ID in authConfigIds before linking.",
                );
              authId = (
                await this.provider.resolveAuthConfiguration(
                  { toolkit: connector.toolkitSlug, auth: connector.auth },
                  signal,
                )
              ).id;
            }
            current();
            setupDispatched = true;
            const result = await this.provider.createSetup(
              { authConfigurationId: authId, subjectId: this.store.userId },
              signal,
            );
            const binding: ConnectorProviderBinding = {
              accountId: result.accountId,
              subjectId: this.store.userId,
              toolkit: connector.toolkitSlug,
              authConfigurationId: authId,
            };
            item = await this.store.save(
              {
                ...item,
                setup: {
                  ...setup,
                  state: "pending",
                  binding,
                  url: result.connectUrl,
                  expiresAt: result.expiresAt,
                },
              },
              current,
            );
            current();
            return {
              setup: publicConnection(item).setup,
              url: result.connectUrl,
              ticket,
            };
          } catch (error) {
            // Never silently allocate a second provider account after a lost response.
            const uncertain =
              error instanceof ConnectorProviderError
                ? error.completion === "outcome_unknown"
                : setupDispatched;
            item = await this.store.save(
              {
                ...item,
                state: "needs_attention",
                failure: { detail: failure(error).message },
                setup: {
                  ...(item.setup ?? setup),
                  state: uncertain ? "unknown" : "cancelled",
                  failure: { detail: failure(error).message },
                },
              },
              current,
            );
            throw error;
          }
        }
        case "setup": {
          const input = managementInputs.setup.parse(raw);
          const item = await get(input.connectionId);
          if (
            !item.setup ||
            item.setup.id !== input.setupId ||
            item.setup.actor !== actor
          )
            throw new ConnectionError(
              "access_denied",
              "This setup belongs to another administrator.",
            );
          return {
            setup: publicConnection(item).setup,
            url: item.setup.state === "pending" ? item.setup.url : null,
          };
        }
        case "complete": {
          const input = managementInputs.complete.parse(raw);
          const item = await get(input.connectionId);
          const setup = item.setup;
          if (
            !setup ||
            setup.id !== input.setupId ||
            setup.actor !== actor ||
            !timingSafeEqual(
              Buffer.from(digest(input.ticket)),
              Buffer.from(setup.ticketHash),
            )
          )
            throw new ConnectionError(
              "access_denied",
              "Finish this setup in the browser that started it.",
            );
          if (setup.state === "completed") return publicConnection(item);
          if (
            setup.state !== "pending" ||
            !setup.binding ||
            Date.parse(setup.expiresAt) <= Date.now()
          )
            throw new ConnectionError(
              "setup_expired",
              "This setup is unavailable or expired. Cancel it before starting another.",
            );
          const account = await this.provider.inspectAccount(
            setup.binding,
            signal,
          );
          if (!account || account.state !== "active")
            throw new ConnectionError(
              "account_pending",
              "Sign-in is not complete. Finish it in the Composio tab, then try Finish connecting again. Projects with callback identity verification require their configured verifier and are not supported by this standalone flow.",
            );
          current();
          return publicConnection(
            await this.store.save(
              {
                ...item,
                state: "connected",
                binding: setup.binding,
                failure: null,
                setup: { ...setup, state: "completed", url: null },
              },
              current,
            ),
          );
        }
        case "cancel": {
          const input = managementInputs.cancel.parse(raw);
          let item = await get(input.connectionId, input.revision);
          if (!item.setup || item.setup.id !== input.setupId)
            throw new ConnectionError(
              "not_found",
              "The setup could not be found.",
            );
          const pending = item.setup.binding;
          item = await this.store.save(
            {
              ...item,
              state: "disconnected",
              setup: { ...item.setup, state: "cancelled", url: null },
            },
            current,
          );
          if (pending) {
            try {
              current();
              await this.provider.deleteAccount(pending, signal);
            } catch (error) {
              await this.store.save(
                {
                  ...item,
                  binding: pending,
                  state: "needs_attention",
                  failure: {
                    detail:
                      "Access is disabled locally. Composio cleanup could not be confirmed; use Disconnect again to inspect and retry cleanup explicitly.",
                  },
                },
                current,
              );
              throw error;
            }
          }
          return publicConnection(item);
        }
        case "disconnect": {
          const input = managementInputs.disconnect.parse(raw);
          let item = await get(input.connectionId, input.revision);
          const bindings = [item.binding, item.setup?.binding].filter(
            (v) => v !== null && v !== undefined,
          );
          item = await this.store.save(
            {
              ...item,
              state: "disconnected",
              generation: item.generation + 1,
              setup: item.setup
                ? { ...item.setup, state: "cancelled", url: null }
                : null,
            },
            current,
          );
          try {
            for (const binding of new Map(
              bindings.map((b) => [b.accountId, b]),
            ).values()) {
              current();
              await this.provider.deleteAccount(binding, signal);
            }
          } catch (error) {
            await this.store.save(
              {
                ...item,
                state: "needs_attention",
                failure: {
                  detail:
                    "Access is disabled locally. Composio cleanup could not be confirmed. Refresh before retrying Disconnect explicitly.",
                },
              },
              current,
            );
            throw error;
          }
          if (!bindings.length) {
            await this.store.remove(item.id, item.revision, current);
            return { removed: true };
          }
          await this.store.save(
            {
              ...item,
              binding: null,
              setup: null,
              failure: null,
            },
            current,
          );
          return { removed: false };
        }
      }
    });
  }
  private async authorized(
    id: string,
    agent: string,
  ): Promise<StoredConnection> {
    const item = await this.store.get(id);
    if (
      item.state !== "connected" ||
      !item.binding ||
      (item.grant.mode === "selected" && !item.grant.agentIds.includes(agent))
    )
      throw new ConnectionError(
        "access_denied",
        "This connection is unavailable to this agent.",
      );
    return item;
  }
  search(raw: unknown, context: NativeContext) {
    return this.serial(async () => {
      const input = searchInput.parse(raw);
      const usable = (await this.store.list()).filter(
        (item) =>
          item.state === "connected" &&
          item.binding &&
          (item.grant.mode === "all" ||
            item.grant.agentIds.includes(context.agentId)),
      );
      const selected = usable.filter(
        (item) =>
          (!input.connectionId || item.id === input.connectionId) &&
          (!input.connectorId || item.connectorId === input.connectorId),
      );
      const found = [];
      for (const item of selected) {
        const actions = await this.catalog.actions(
          item.connectorId,
          signalFor(context.signal),
        );
        for (const {
          inputSchema: _input,
          outputSchema: _output,
          ...action
        } of actions)
          if (
            matches(
              [action.name, action.description, action.id, item.name],
              input.query ?? "",
            )
          )
            found.push({
              connectionId: item.id,
              connectionName: item.name,
              generation: item.generation,
              action: {
                ...action,
                description: action.description.slice(0, 500),
              },
            });
      }
      const offset = input.cursor ? Number(input.cursor) : 0;
      if (!Number.isSafeInteger(offset) || offset < 0)
        throw new ConnectionError(
          "invalid_cursor",
          "The search cursor is invalid.",
        );
      const limit = input.limit ?? 10;
      return {
        items: found.slice(offset, offset + limit),
        nextCursor:
          offset + limit < found.length ? String(offset + limit) : null,
        guidance: usable.length
          ? null
          : {
              code: "no_usable_connections",
              message:
                "No connections are available. An OpenClaw administrator can link an account or grant access on Connections.",
            },
      };
    });
  }
  describe(raw: unknown, context: NativeContext) {
    return this.serial(async () => {
      const input = describeInput.parse(raw);
      const item = await this.authorized(input.connectionId, context.agentId);
      const action = (
        await this.catalog.actions(item.connectorId, signalFor(context.signal))
      ).find((a) => a.id === input.actionId);
      if (!action)
        throw new ConnectionError(
          "not_found",
          "The action was not found on this connection.",
        );
      return { connectionId: item.id, generation: item.generation, action };
    });
  }
  call(raw: unknown, context: NativeContext) {
    return this.serial(async () => {
      const input = callInput.parse(raw);
      const session = context.sessionKey ?? context.sessionId;
      if (!session)
        throw new ConnectionError(
          "native_context_unavailable",
          "A native agent session is required.",
        );
      await this.store.prune();
      if (input.mode === "lookup")
        return this.presentReceipt(
          await this.store.lookup(context.agentId, session, input.toolCallId),
        );
      if (input.mode === "result") {
        const receipt = await this.store.receipt(
          input.invocationId,
          context.agentId,
          session,
        );
        await this.authorized(receipt.connectionId, context.agentId);
        const result = receipt.result;
        if (result === null) return this.presentReceipt(receipt);
        const offset = Number(input.cursor ?? 0);
        if (!Number.isSafeInteger(offset) || offset > result.length)
          throw new ConnectionError(
            "invalid_cursor",
            "The result cursor is invalid.",
          );
        const page = result.slice(offset, offset + 8192);
        return {
          invocation: this.invocation(receipt),
          result: {
            kind: "page",
            text: page,
            offset,
            nextCursor:
              offset + page.length < result.length
                ? String(offset + page.length)
                : null,
          },
        };
      }
      const item = await this.authorized(input.connectionId, context.agentId);
      if (item.generation !== input.generation)
        throw new ConnectionError(
          "generation_changed",
          "This account changed. Describe the connection again.",
        );
      const args = parseJson(input.arguments, {
        maximumDepth: 80,
        maximumBytes: 128 * 1024,
        plainObjectsOnly: true,
        invalid: () => {
          throw new ConnectionError(
            "invalid_arguments",
            "Arguments must be bounded JSON.",
          );
        },
      });
      const argumentsValue = z.record(z.string(), z.unknown()).parse(args);
      // parseJson establishes the recursive provider JSON contract without an unsafe cast.
      const providerArguments = Object.fromEntries(
        Object.entries(argumentsValue).map(([key, value]) => [
          key,
          parseJson(value, {
            maximumDepth: 80,
            invalid: () => {
              throw new ConnectionError(
                "invalid_arguments",
                "Arguments must be JSON.",
              );
            },
          }),
        ]),
      );
      const requestHash = digest(canonicalJson(input));
      let existing: Receipt | undefined;
      try {
        existing = await this.store.lookup(
          context.agentId,
          session,
          context.toolCallId,
        );
      } catch (error) {
        if (
          !(error instanceof ConnectionError) ||
          error.code !== "receipt_not_found"
        )
          throw error;
      }
      if (existing) {
        if (existing.requestHash !== requestHash)
          throw new ConnectionError(
            "idempotency_conflict",
            "This native tool call already identifies a different operation.",
          );
        return this.presentReceipt(existing);
      }
      const action = (
        await this.catalog.actions(item.connectorId, signalFor(context.signal))
      ).find((a) => a.id === input.actionId && a.version === input.version);
      if (!action)
        throw new ConnectionError(
          "version_changed",
          "The action version changed or is unavailable. Describe it again before executing.",
        );
      const binding = item.binding;
      if (!binding)
        throw new ConnectionError(
          "access_denied",
          "The connection is unavailable.",
        );
      const account = await this.provider.inspectAccount(
        binding,
        signalFor(context.signal),
      );
      if (!account || account.state !== "active") {
        await this.store.save({
          ...item,
          state: "needs_attention",
          failure: { detail: "The account needs to be reconnected." },
        });
        throw new ConnectionError(
          "account_unavailable",
          "The account needs to be reconnected.",
        );
      }
      if (context.signal?.aborted)
        throw new ConnectionError(
          "cancelled",
          "The call was cancelled before dispatch.",
        );
      const receipt: Receipt = {
        id: randomUUID(),
        connectionId: item.id,
        generation: item.generation,
        agentId: context.agentId,
        session,
        toolCallId: context.toolCallId,
        requestHash,
        actionId: input.actionId,
        version: input.version,
        state: "dispatching",
        createdAt: new Date().toISOString(),
        completedAt: null,
        expiresAt: new Date(Date.now() + 7 * 86_400_000).toISOString(),
        failure: null,
        result: null,
      };
      const claimed = await this.store.claim(receipt);
      if (claimed.id !== receipt.id) {
        if (claimed.requestHash !== requestHash)
          throw new ConnectionError(
            "idempotency_conflict",
            "This tool call already identifies a different operation.",
          );
        return this.presentReceipt(claimed);
      }
      let completed: Receipt;
      try {
        const response = await this.provider.execute(
          {
            binding,
            actionId: action.id,
            version: action.version,
            arguments: providerArguments,
          },
          signalFor(context.signal),
        );
        completed = {
          ...receipt,
          completedAt: new Date().toISOString(),
          state:
            response.status === "succeeded"
              ? "succeeded"
              : response.status === "rejected"
                ? "rejected"
                : "unknown",
          failure:
            response.status === "succeeded"
              ? response.result.kind === "unavailable"
                ? {
                    detail:
                      "The operation succeeded, but its result could not be read. Do not execute again to retrieve it.",
                  }
                : null
              : { detail: response.failure.message },
          result:
            response.status === "succeeded" && response.result.kind === "inline"
              ? JSON.stringify(response.result.data)
              : null,
        };
      } catch {
        completed = {
          ...receipt,
          state: "unknown",
          failure: {
            detail:
              "The external outcome could not be confirmed. Do not execute again to recover it.",
          },
        };
      }
      await this.store.saveReceipt(completed);
      return this.presentReceipt(completed);
    });
  }
  private invocation(receipt: Receipt) {
    const {
      result: _result,
      requestHash: _hash,
      session: _session,
      ...invocation
    } = receipt;
    return invocation;
  }
  private async presentReceipt(receipt: Receipt) {
    await this.authorized(receipt.connectionId, receipt.agentId);
    const data: unknown =
      receipt.result === null ? null : JSON.parse(receipt.result);
    return {
      invocation: this.invocation(receipt),
      result:
        receipt.result === null
          ? { kind: "unavailable" }
          : Buffer.byteLength(receipt.result) <= 32 * 1024
            ? { kind: "inline", data }
            : {
                kind: "reference",
                invocationId: receipt.id,
                byteLength: Buffer.byteLength(receipt.result),
                expiresAt: receipt.expiresAt,
              },
    };
  }
}
