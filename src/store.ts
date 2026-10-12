import { createHash, randomUUID } from "node:crypto";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { z } from "zod";
import {
  receiptSchema,
  storedConnectionSchema,
  type Receipt,
  type StoredConnection,
} from "./contracts.js";
import { ConnectionError } from "./errors.js";

export type StateRuntime = Pick<
  OpenClawPluginApi["runtime"]["state"],
  "openKeyedStore"
>;
type KeyedStore = ReturnType<StateRuntime["openKeyedStore"]>;
const registrySchema = z
  .array(storedConnectionSchema)
  .max(1000)
  .superRefine((items, ctx) => {
    if (new Set(items.map((item) => item.id)).size !== items.length)
      ctx.addIssue({
        code: "custom",
        message: "Duplicate connection identity",
      });
  });
const identitySchema = z.strictObject({ userId: z.string().min(1) });
const resultReferenceSchema = z.strictObject({
  chunks: z.number().int().min(1).max(128),
  digest: z.string().regex(/^[a-f0-9]{64}$/),
  byteLength: z
    .number()
    .int()
    .min(1)
    .max(8 * 1024 * 1024),
});
type ResultReference = z.infer<typeof resultReferenceSchema>;
const resultChunkSchema = z.strictObject({ text: z.string().max(65536) });
const receiptRecordSchema = z.strictObject({
  receipt: receiptSchema,
  resultReference: resultReferenceSchema.nullable(),
  pruned: z.boolean(),
});
const conflict = () =>
  new ConnectionError(
    "revision_conflict",
    "This connection changed. Refresh before saving or removing it.",
  );
function capabilities(store: KeyedStore) {
  const { observe, compareAndApply, entriesInKeyRange, withCurrent } = store;
  if (
    !observe ||
    !compareAndApply ||
    !entriesInKeyRange ||
    !store.registerIfAbsent
  )
    throw new ConnectionError(
      "state_unsupported",
      "Connections requires retained OpenClaw plugin state with atomic claims, observe/compareAndApply and paged key ranges.",
    );
  return {
    withCurrent: withCurrent?.bind(store),
    lookup: store.lookup.bind(store),
    registerIfAbsent: store.registerIfAbsent.bind(store),
    observe: observe.bind(store),
    compareAndApply: compareAndApply.bind(store),
    entriesInKeyRange: entriesInKeyRange.bind(store),
  };
}
type DurableStore = ReturnType<typeof capabilities>;
// Hash the unambiguous tuple to stay within the SDK's 512-byte key limit.
const callKey = (agent: string, session: string, call: string) =>
  `r:${createHash("sha256")
    .update(JSON.stringify([agent, session, call]))
    .digest("hex")}`;

/** The host binds plugin identity, owns the database and closes its capabilities. */
export class ConnectionStore {
  private closed = false;
  private constructor(
    private readonly connections: DurableStore,
    private readonly receipts: DurableStore,
    private readonly results: DurableStore,
    readonly userId: string,
  ) {}
  static async open(
    state: StateRuntime,
    userId?: string,
  ): Promise<ConnectionStore> {
    if (typeof state.openKeyedStore !== "function")
      throw new ConnectionError(
        "state_unsupported",
        "Connections requires OpenClaw retained plugin state; custom-file and bounded storage are not supported.",
      );
    const identity = capabilities(
      state.openKeyedStore({
        namespace: "connections.identity.v1",
        retention: "retained",
      }),
    );
    const connections = capabilities(
      state.openKeyedStore({
        namespace: "connections.registry.v1",
        retention: "retained",
      }),
    );
    const receipts = capabilities(
      state.openKeyedStore({
        namespace: "connections.receipts.v1",
        retention: "retained",
      }),
    );
    const results = capabilities(
      state.openKeyedStore({
        namespace: "connections.results.v1",
        retention: "retained",
      }),
    );
    if (!connections.withCurrent)
      throw new ConnectionError(
        "state_unsupported",
        "Connections requires action-bound plugin state (withCurrent).",
      );
    await identity.registerIfAbsent("identity", {
      userId: userId ?? `openclaw-${randomUUID()}`,
    });
    const saved = identitySchema.parse(await identity.lookup("identity"));
    if (userId && saved.userId !== userId)
      throw new ConnectionError(
        "identity_changed",
        "The configured Composio userId differs from this plugin's retained identity. Use a separate OpenClaw state directory for a different identity.",
      );
    const store = new ConnectionStore(
      connections,
      receipts,
      results,
      saved.userId,
    );
    await store.recover();
    await store.prune();
    return store;
  }
  private active() {
    if (this.closed)
      throw new ConnectionError(
        "state_closed",
        "The Connections state handle is closed.",
      );
  }
  private async *records() {
    this.active();
    let cursor = "r:";
    for (;;) {
      const page = await this.receipts.entriesInKeyRange({
        keyStartInclusive: cursor,
        keyEndExclusive: "r;",
        limit: 128,
      });
      if (!page.length) return;
      for (const entry of page) {
        const record = receiptRecordSchema.parse(entry.value);
        if (
          entry.key !==
          callKey(
            record.receipt.agentId,
            record.receipt.session,
            record.receipt.toolCallId,
          )
        )
          throw new ConnectionError(
            "invalid_state",
            "A receipt does not match its retained call identity.",
          );
        yield { key: entry.key, ...record };
      }
      const last = page.at(-1);
      if (!last) return;
      cursor = `${last.key}!`;
    }
  }
  private async recover() {
    for await (const { receipt } of this.records()) {
      if (receipt.state === "dispatching")
        await this.changeReceipt(receipt, "recover");
    }
    for (const connection of await this.list()) {
      if (connection.setup?.state === "creating")
        await this.save({
          ...connection,
          state: "needs_attention",
          failure: {
            detail:
              "The Gateway stopped during setup. Cancel this setup and inspect your Composio project before starting another.",
          },
          setup: {
            ...connection.setup,
            state: "unknown",
            failure: {
              detail:
                "The Gateway stopped during setup. Its provider outcome is unknown. Cancel this setup and inspect your Composio project before starting another.",
            },
          },
        });
    }
  }
  async prune(now = new Date().toISOString()) {
    for await (const { receipt, pruned } of this.records())
      if (!pruned && receipt.expiresAt < now)
        await this.changeReceipt(receipt, "prune", now);
    // Publish payload pruning before removing expired chunks. This also cleans
    // orphan chunks after a crash or failed outcome write, without a multi-key transaction.
    let cursor = "p:";
    for (;;) {
      const page = await this.results.entriesInKeyRange({
        keyStartInclusive: cursor,
        keyEndExclusive: `p:${now}`,
        limit: 128,
      });
      if (!page.length) break;
      for (const entry of page) {
        const observed = await this.results.observe(entry.key);
        const removed = await this.results.compareAndApply(
          entry.key,
          observed.comparison,
          { operation: "delete", action: "delete" },
        );
        if (removed.status === "conflict")
          throw new ConnectionError(
            "receipt_conflict",
            "Expired result data changed during pruning.",
          );
      }
      const last = page.at(-1);
      if (!last) break;
      cursor = `${last.key}!`;
    }
  }
  async list(): Promise<StoredConnection[]> {
    this.active();
    const value = await this.connections.lookup("registry");
    return value === undefined
      ? []
      : registrySchema.parse(value).sort((a, b) => a.id.localeCompare(b.id));
  }
  async get(id: string): Promise<StoredConnection> {
    const item = (await this.list()).find((item) => item.id === id);
    if (!item)
      throw new ConnectionError(
        "not_found",
        "The connection could not be found.",
      );
    return item;
  }
  // One CAS record keeps the count limit and every connection revision atomic.
  // Only explicit conflicts retry a pure decision; storage failures never retry.
  private async edit(
    decide: (items: StoredConnection[]) => StoredConnection[],
    current?: () => void,
  ) {
    this.active();
    if (current && !this.connections.withCurrent)
      throw new ConnectionError(
        "state_unsupported",
        "Connections management requires action-bound plugin state.",
      );
    const store =
      current && this.connections.withCurrent
        ? capabilities(this.connections.withCurrent({ assertCurrent: current }))
        : this.connections;
    let observed = await store.observe("registry");
    for (let attempts = 0; attempts < 32; attempts++) {
      const items =
        observed.value === undefined
          ? []
          : registrySchema.parse(observed.value);
      const value = registrySchema.parse(decide(items));
      const result = await store.compareAndApply(
        "registry",
        observed.comparison,
        { operation: "update", action: "set", value },
      );
      if (result.status !== "conflict") return;
      observed = result.current;
    }
    throw conflict();
  }
  async insert(connection: StoredConnection, current?: () => void) {
    const value = storedConnectionSchema.parse(connection);
    await this.edit((items) => {
      if (items.some((item) => item.id === value.id)) throw conflict();
      if (items.length >= 1000)
        throw new ConnectionError(
          "limit",
          "This installation supports up to 1,000 connections.",
        );
      return [...items, value];
    }, current);
  }
  async save(
    connection: StoredConnection,
    current?: () => void,
  ): Promise<StoredConnection> {
    const value = storedConnectionSchema.parse({
      ...connection,
      revision: connection.revision + 1,
    });
    await this.edit((items) => {
      if (
        !items.some(
          (item) =>
            item.id === value.id && item.revision === connection.revision,
        )
      )
        throw conflict();
      return items.map((item) => (item.id === value.id ? value : item));
    }, current);
    return value;
  }
  async remove(id: string, revision: number, current?: () => void) {
    await this.edit((items) => {
      if (!items.some((item) => item.id === id && item.revision === revision))
        throw conflict();
      return items.filter((item) => item.id !== id);
    }, current);
  }
  async claim(receipt: Receipt): Promise<Receipt> {
    this.active();
    const value = receiptSchema.parse(receipt);
    const key = callKey(value.agentId, value.session, value.toolCallId);
    const inserted = await this.receipts.registerIfAbsent(key, {
      receipt: value,
      resultReference: null,
      pruned: false,
    });
    const record = receiptRecordSchema.parse(await this.receipts.lookup(key));
    const saved = record.receipt;
    this.sameCall(saved, value);
    if (!inserted && saved.expiresAt < new Date().toISOString())
      throw new ConnectionError(
        "receipt_expired",
        "This native call was recorded previously and its result has expired. No operation was replayed.",
      );
    return this.readResult(record);
  }
  private sameCall(
    saved: Receipt,
    expected: Pick<Receipt, "agentId" | "session" | "toolCallId">,
  ) {
    if (
      saved.agentId !== expected.agentId ||
      saved.session !== expected.session ||
      saved.toolCallId !== expected.toolCallId
    )
      throw new ConnectionError(
        "invalid_state",
        "The retained receipt has a different call identity.",
      );
  }
  async lookup(agent: string, session: string, call: string): Promise<Receipt> {
    this.active();
    const value = await this.receipts.lookup(callKey(agent, session, call));
    if (value === undefined)
      throw new ConnectionError(
        "receipt_not_found",
        "No retained call was found in this agent session. No operation was executed by this read.",
      );
    const record = receiptRecordSchema.parse(value);
    const saved = record.receipt;
    this.sameCall(saved, { agentId: agent, session, toolCallId: call });
    if (saved.expiresAt < new Date().toISOString())
      throw new ConnectionError(
        "receipt_not_found",
        "No retained call was found in this agent session. No operation was executed by this read.",
      );
    return this.readResult(record);
  }
  async receipt(id: string, agent: string, session: string): Promise<Receipt> {
    for await (const record of this.records()) {
      const { receipt } = record;
      if (
        receipt.id === id &&
        receipt.agentId === agent &&
        receipt.session === session &&
        receipt.expiresAt >= new Date().toISOString()
      )
        return this.readResult(record);
    }
    throw new ConnectionError(
      "receipt_not_found",
      "The saved result is unavailable to this agent session.",
    );
  }
  private async changeReceipt(
    receipt: Receipt,
    mode: "complete" | "recover" | "prune",
    now = new Date().toISOString(),
    resultReference: ResultReference | null = null,
  ) {
    this.active();
    const key = callKey(receipt.agentId, receipt.session, receipt.toolCallId);
    let observed = await this.receipts.observe(key);
    for (let attempts = 0; attempts < 32; attempts++) {
      const saved = receiptRecordSchema.parse(observed.value);
      this.sameCall(saved.receipt, receipt);
      if (
        saved.receipt.id !== receipt.id ||
        saved.receipt.requestHash !== receipt.requestHash ||
        saved.receipt.connectionId !== receipt.connectionId ||
        saved.receipt.generation !== receipt.generation ||
        saved.receipt.actionId !== receipt.actionId ||
        saved.receipt.version !== receipt.version ||
        saved.receipt.createdAt !== receipt.createdAt ||
        saved.receipt.expiresAt !== receipt.expiresAt
      )
        throw new ConnectionError(
          "idempotency_conflict",
          "The saved call identifies a different operation.",
        );
      let value = saved;
      if (mode === "prune") {
        if (saved.pruned || saved.receipt.expiresAt >= now) return;
        value = {
          pruned: true,
          resultReference: null,
          receipt: {
            ...saved.receipt,
            result: null,
            failure: ["unknown", "dispatching"].includes(saved.receipt.state)
              ? {
                  detail:
                    "The outcome remains unknown; its saved details have expired. Do not execute again to recover it.",
                }
              : null,
          },
        };
      } else {
        if (saved.receipt.state !== "dispatching") {
          if (mode === "recover") return;
          throw new ConnectionError(
            "receipt_conflict",
            "The call outcome has already been recorded. No operation was replayed.",
          );
        }
        const next =
          mode === "recover"
            ? {
                ...saved.receipt,
                state: "unknown" as const,
                failure: {
                  detail:
                    "The Gateway stopped before recording the external outcome. Do not execute again to recover it.",
                },
              }
            : receiptSchema.parse(receipt);
        value = {
          pruned: saved.pruned,
          resultReference: saved.pruned ? null : resultReference,
          receipt: saved.pruned
            ? {
                ...next,
                result: null,
                failure:
                  next.state === "unknown"
                    ? {
                        detail:
                          "The outcome remains unknown; its saved details have expired. Do not execute again to recover it.",
                      }
                    : null,
              }
            : next,
        };
      }
      const result = await this.receipts.compareAndApply(
        key,
        observed.comparison,
        { operation: "update", action: "set", value },
      );
      if (result.status !== "conflict") return;
      observed = result.current;
    }
    throw new ConnectionError(
      "receipt_conflict",
      "The retained call changed concurrently.",
    );
  }
  private resultKey(receipt: Receipt, index: number) {
    return `p:${receipt.expiresAt}:${receipt.id}:${index}`;
  }
  private async readResult(
    record: z.infer<typeof receiptRecordSchema>,
  ): Promise<Receipt> {
    const { receipt, resultReference } = record;
    if (!resultReference) return receipt;
    let text = "";
    for (let i = 0; i < resultReference.chunks; i++) {
      const value = await this.results.lookup(this.resultKey(receipt, i));
      if (value === undefined)
        throw new ConnectionError(
          "result_unavailable",
          "The operation is recorded, but its saved result is unavailable. Do not execute again to retrieve it.",
        );
      text += resultChunkSchema.parse(value).text;
    }
    if (
      Buffer.byteLength(text) !== resultReference.byteLength ||
      createHash("sha256").update(text).digest("hex") !== resultReference.digest
    )
      throw new ConnectionError(
        "invalid_state",
        "The recorded result failed its integrity check. Do not execute again to retrieve it.",
      );
    return receiptSchema.parse({ ...receipt, result: text });
  }
  async saveReceipt(receipt: Receipt) {
    this.active();
    const completed = receiptSchema.parse(receipt);
    if (completed.state === "dispatching")
      throw new ConnectionError(
        "invalid_state",
        "A completed receipt must have a recorded outcome.",
      );
    let reference: ResultReference | null = null;
    if (completed.result !== null) {
      try {
        reference = resultReferenceSchema.parse({
          chunks: Math.ceil(completed.result.length / 65536),
          byteLength: Buffer.byteLength(completed.result),
          digest: createHash("sha256").update(completed.result).digest("hex"),
        });
        for (let i = 0; i < reference.chunks; i++) {
          const key = this.resultKey(completed, i);
          const text = completed.result.slice(i * 65536, (i + 1) * 65536);
          const inserted = await this.results.registerIfAbsent(key, { text });
          if (
            !inserted &&
            resultChunkSchema.parse(await this.results.lookup(key)).text !==
              text
          )
            throw new ConnectionError(
              "receipt_conflict",
              "The call's result data changed concurrently.",
            );
        }
      } catch (error) {
        // Keep a confirmed external outcome even if its payload cannot be saved.
        // Report the original storage error; no provider effect is repeated.
        await this.changeReceipt(
          {
            ...completed,
            result: null,
            failure: {
              detail:
                "The operation's outcome is recorded, but its result could not be saved. Do not execute again to retrieve it.",
            },
          },
          "complete",
        );
        throw error;
      }
    }
    await this.changeReceipt(
      { ...completed, result: null },
      "complete",
      new Date().toISOString(),
      reference,
    );
  }
  async usage() {
    await this.prune();
    const counts = {
      calls: 0,
      succeeded: 0,
      rejected: 0,
      unknown: 0,
      retainedDays: 7,
    };
    const now = new Date().toISOString();
    for await (const { receipt } of this.records()) {
      if (receipt.expiresAt < now) continue;
      counts.calls++;
      if (receipt.state === "succeeded") counts.succeeded++;
      if (receipt.state === "rejected") counts.rejected++;
      if (receipt.state === "unknown" || receipt.state === "dispatching")
        counts.unknown++;
    }
    return counts;
  }
  async close() {
    this.closed = true;
  }
}
