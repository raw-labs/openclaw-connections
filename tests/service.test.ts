import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { managementOutputs, type Receipt } from "../src/contracts.js";
import { ComposioCatalog, packagedCatalog } from "../src/catalog.js";
import { ComposioHttp } from "../src/providers/composio/http.js";
import { ConnectionsService } from "../src/service.js";
import { ConnectionStore, type StateRuntime } from "../src/store.js";
import { stateRuntime } from "./helpers/state.mjs";
import {
  ConnectorProviderError,
  type ConnectorProvider,
  type ConnectorProviderBinding,
  type ConnectorProviderExecution,
} from "../src/types/provider.js";

class Provider implements ConnectorProvider {
  readonly id = "composio";
  active = true;
  executions = 0;
  deletions = 0;
  setups = 0;
  failDelete = false;
  deleteCompletion: "outcome_unknown" | "rejected" = "outcome_unknown";
  unknownSetup = false;
  unknownAuthConfiguration = false;
  authConfigurations = 0;
  unknownExecution = false;
  sentArguments: unknown;
  onExecute: (() => Promise<void>) | undefined;
  onInspect: (() => void) | undefined;
  async resolveAuthConfiguration() {
    this.authConfigurations++;
    if (this.unknownAuthConfiguration)
      throw new ConnectorProviderError(
        "connector_provider_unknown_outcome",
        "Auth configuration outcome unknown.",
        "outcome_unknown",
      );
    return {
      id: "ac_github",
      toolkit: "github",
      auth: { kind: "managed" as const },
    };
  }
  async createSetup() {
    this.setups++;
    if (this.unknownSetup)
      throw new ConnectorProviderError(
        "connector_provider_unknown_outcome",
        "Setup outcome unknown.",
        "outcome_unknown",
      );
    return {
      accountId: `ca_${this.setups}`,
      connectUrl: "https://connect.composio.dev/synthetic",
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    };
  }
  async completeIdentity() {
    return { accountId: "ca_1", toolkit: "github" };
  }
  async inspectAccount(binding: ConnectorProviderBinding) {
    this.onInspect?.();
    return {
      binding,
      label: "Work",
      state: this.active ? ("active" as const) : ("pending" as const),
    };
  }
  async deleteAccount() {
    this.deletions++;
    if (this.failDelete)
      throw new ConnectorProviderError(
        this.deleteCompletion === "outcome_unknown"
          ? "connector_provider_unknown_outcome"
          : "connector_provider_rejected",
        `Cleanup ${this.deleteCompletion}.`,
        this.deleteCompletion,
      );
    return { status: "deleted" as const, revocationJobId: null };
  }
  async execute(
    input: Parameters<ConnectorProvider["execute"]>[0],
  ): Promise<ConnectorProviderExecution> {
    this.executions++;
    this.sentArguments = input.arguments;
    await this.onExecute?.();
    if (this.unknownExecution) throw Error("Synthetic lost response");
    return {
      status: "succeeded",
      result: { kind: "inline", data: { text: "𝄞 response ".repeat(10_000) } },
    };
  }
}
async function fixture(
  transform: (state: StateRuntime) => StateRuntime = (state) => state,
) {
  const directory = await mkdtemp(join(tmpdir(), "connections-service-"));
  const provider = new Provider();
  const store = await ConnectionStore.open(
    transform(stateRuntime(directory)),
    "local-user",
  );
  const http = new ComposioHttp({
    apiKey: "synthetic-provider-key",
    fetchImpl: async (url) => {
      assert.match(String(url), /\/api\/v3\.1\/tools\?/);
      return Response.json({
        items: [
          {
            slug: "GITHUB_CREATE_ISSUE",
            toolkit: { slug: "github" },
            name: "Create issue",
            description: "Create an issue",
            version: "20260910_00",
            input_parameters: {
              type: "object",
              properties: { undocumented: { type: "number" } },
            },
            output_parameters: {},
          },
        ],
        next_cursor: null,
      });
    },
  });
  const service = new ConnectionsService(
    store,
    provider,
    new ComposioCatalog(packagedCatalog(), http),
  );
  let admitted = true;
  const current = () => {
    if (!admitted) throw Error("Administrator revoked");
  };
  const manage = (
    method: Parameters<typeof service.manage>[0],
    input: unknown,
    actor = "admin-one",
  ) => service.manage(method, input, actor, ["main", "researcher"], current);
  async function pending() {
    const created = managementOutputs.create.parse(
      await manage("create", {
        connectorId: "github",
        name: "GitHub",
        grant: { mode: "all" },
      }),
    );
    const started = managementOutputs.start.parse(
      await manage("start", {
        connectionId: created.id,
        revision: created.revision,
      }),
    );
    assert.ok(started.setup);
    return { created, started };
  }
  async function linked() {
    const { created, started } = await pending();
    assert.ok(started.setup);
    const connected = managementOutputs.complete.parse(
      await manage("complete", {
        connectionId: created.id,
        setupId: started.setup.id,
        ticket: started.ticket,
      }),
    );
    return { connected, started };
  }
  return {
    async close() {
      await service.close();
      await rm(directory, { recursive: true, force: true });
    },
    reopen: () =>
      ConnectionStore.open(transform(stateRuntime(directory)), "local-user"),
    service,
    store,
    provider,
    manage,
    linked,
    pending,
    revoke: () => {
      admitted = false;
    },
  };
}
const context = {
  agentId: "main",
  sessionKey: "agent:main:test",
  toolCallId: "call-one",
};
const execute = (connectionId: string, generation: number) => ({
  mode: "execute",
  connectionId,
  generation,
  actionId: "GITHUB_CREATE_ISSUE",
  version: "20260910_00",
  arguments: { undocumented: "7", arbitrary: null },
});

await test("setup requires the originating administrator, browser ticket and active exact account", async () => {
  const f = await fixture();
  try {
    const created = managementOutputs.create.parse(
      await f.manage("create", {
        connectorId: "github",
        name: "Work",
        grant: { mode: "all" },
      }),
    );
    const started = managementOutputs.start.parse(
      await f.manage("start", { connectionId: created.id, revision: 0 }),
    );
    assert.ok(started.setup);
    const input = {
      connectionId: created.id,
      setupId: started.setup.id,
      ticket: started.ticket,
    };
    await assert.rejects(f.manage("complete", input, "other-admin"), /browser/);
    await assert.rejects(
      f.manage("complete", { ...input, ticket: "wrong" }),
      /browser/,
    );
    f.provider.active = false;
    await assert.rejects(f.manage("complete", input), /not complete/);
    assert.equal((await f.store.get(created.id)).state, "not_connected");
    f.provider.active = true;
    const linked = managementOutputs.complete.parse(
      await f.manage("complete", input),
    );
    assert.equal(linked.state, "connected");
    assert.deepEqual(await f.manage("complete", input), linked);
    assert.doesNotMatch(
      JSON.stringify(await f.manage("list", {})),
      /ticketHash|local-user|ca_1/,
    );
  } finally {
    await f.close();
  }
});
await test("revoked authority cannot activate after provider inspection", async () => {
  const f = await fixture();
  try {
    const created = managementOutputs.create.parse(
      await f.manage("create", {
        connectorId: "github",
        name: "Work",
        grant: { mode: "all" },
      }),
    );
    const started = managementOutputs.start.parse(
      await f.manage("start", { connectionId: created.id, revision: 0 }),
    );
    assert.ok(started.setup);
    f.provider.onInspect = f.revoke;
    await assert.rejects(
      f.manage("complete", {
        connectionId: created.id,
        setupId: started.setup.id,
        ticket: started.ticket,
      }),
      /revoked/,
    );
    assert.equal((await f.store.get(created.id)).state, "not_connected");
  } finally {
    await f.close();
  }
});
await test("unknown setup is durable and start never blindly allocates another account", async () => {
  const f = await fixture();
  try {
    const created = managementOutputs.create.parse(
      await f.manage("create", {
        connectorId: "github",
        name: "Work",
        grant: { mode: "all" },
      }),
    );
    f.provider.unknownSetup = true;
    await assert.rejects(
      f.manage("start", { connectionId: created.id, revision: 0 }),
      /unknown/,
    );
    const item = await f.store.get(created.id);
    assert.equal(item.setup?.state, "unknown");
    assert.match(item.failure?.detail ?? "", /unknown/);
    await assert.rejects(
      f.manage("start", { connectionId: item.id, revision: item.revision }),
      /already exists/,
    );
    assert.equal(f.provider.setups, 1);
  } finally {
    await f.close();
  }
});
await test("unknown setup preparation remains unknown and cannot allocate another auth configuration", async () => {
  const f = await fixture();
  try {
    const created = managementOutputs.create.parse(
      await f.manage("create", {
        connectorId: "github",
        name: "Work",
        grant: { mode: "all" },
      }),
    );
    f.provider.unknownAuthConfiguration = true;
    await assert.rejects(
      f.manage("start", {
        connectionId: created.id,
        revision: created.revision,
      }),
      /outcome unknown/,
    );
    const saved = await f.store.get(created.id);
    assert.equal(saved.setup?.state, "unknown");
    await assert.rejects(
      f.manage("start", { connectionId: saved.id, revision: saved.revision }),
      /already exists/,
    );
    assert.equal(f.provider.authConfigurations, 1);
    assert.equal(f.provider.setups, 0);
  } finally {
    await f.close();
  }
});
await test("native agent grants apply to search, describe, execute and saved-result reads", async () => {
  const f = await fixture();
  try {
    const { connected } = await f.linked();
    const result = await f.service.call(
      execute(connected.id, connected.generation),
      context,
    );
    await f.manage("update", {
      connectionId: connected.id,
      revision: (await f.store.get(connected.id)).revision,
      name: "Work",
      grant: { mode: "selected", agentIds: ["researcher"] },
    });
    const search = await f.service.search({}, context);
    assert.equal(search.items.length, 0);
    await assert.rejects(
      f.service.describe(
        { connectionId: connected.id, actionId: "GITHUB_CREATE_ISSUE" },
        context,
      ),
      /unavailable/,
    );
    await assert.rejects(
      f.service.call(execute(connected.id, connected.generation), {
        ...context,
        toolCallId: "new-call",
      }),
      /unavailable/,
    );
    await assert.rejects(
      f.service.call(
        { mode: "lookup", toolCallId: context.toolCallId },
        context,
      ),
      /unavailable/,
    );
    assert.ok("invocation" in result);
    await assert.rejects(
      f.service.call(
        { mode: "result", invocationId: result.invocation.id },
        context,
      ),
      /unavailable/,
    );
    assert.equal(f.provider.executions, 1);
  } finally {
    await f.close();
  }
});
await test("search matches separate account/action terms without choosing another account", async () => {
  const f = await fixture();
  try {
    const { connected } = await f.linked();
    const found = await f.service.search(
      { query: "github create issue" },
      context,
    );
    assert.equal(found.items.length, 1);
    assert.equal(found.items[0]?.connectionId, connected.id);
    assert.equal(found.items[0]?.action.id, "GITHUB_CREATE_ISSUE");
    assert.equal(
      (await f.service.search({ query: "different-service-action" }, context))
        .items.length,
      0,
    );
  } finally {
    await f.close();
  }
});
await test("exact generation/version and native session are mandatory; schemas remain advisory", async () => {
  const f = await fixture();
  try {
    const { connected } = await f.linked();
    await assert.rejects(
      f.service.call(execute(connected.id, connected.generation + 1), context),
      /account changed/,
    );
    await assert.rejects(
      f.service.call(
        { ...execute(connected.id, connected.generation), version: "other" },
        context,
      ),
      /version changed/,
    );
    await assert.rejects(
      f.service.call(execute(connected.id, connected.generation), {
        agentId: "main",
        toolCallId: "none",
      }),
      /native agent session/,
    );
    await f.service.call(execute(connected.id, connected.generation), context);
    assert.deepEqual(f.provider.sentArguments, {
      undocumented: "7",
      arbitrary: null,
    });
    assert.equal(f.provider.executions, 1);
  } finally {
    await f.close();
  }
});
await test("lost execute response remains unknown and duplicate call identity never replays", async () => {
  const f = await fixture();
  try {
    const { connected } = await f.linked();
    f.provider.unknownExecution = true;
    const args = execute(connected.id, connected.generation);
    const result = await f.service.call(args, context);
    assert.equal(result.invocation.state, "unknown");
    assert.deepEqual(await f.service.call(args, context), result);
    assert.deepEqual(
      await f.service.call(
        { mode: "lookup", toolCallId: context.toolCallId },
        context,
      ),
      result,
    );
    await assert.rejects(
      f.service.call({ ...args, arguments: { different: true } }, context),
      /different operation/,
    );
    assert.equal(f.provider.executions, 1);
    await assert.rejects(
      f.service.call(
        { mode: "lookup", toolCallId: context.toolCallId },
        { ...context, sessionKey: "another-session" },
      ),
      /No retained call/,
    );
  } finally {
    await f.close();
  }
});
await test("complete large Unicode JSON is paged without another provider execution", async () => {
  const f = await fixture();
  try {
    const { connected } = await f.linked();
    const result = await f.service.call(
      execute(connected.id, connected.generation),
      context,
    );
    assert.equal(result.result.kind, "reference");
    let cursor = "0",
      text = "";
    for (;;) {
      const page = await f.service.call(
        { mode: "result", invocationId: result.invocation.id, cursor },
        context,
      );
      assert.ok("text" in page.result);
      text += page.result.text;
      if (!page.result.nextCursor) break;
      cursor = page.result.nextCursor;
    }
    assert.deepEqual(JSON.parse(text), { text: "𝄞 response ".repeat(10_000) });
    assert.equal(f.provider.executions, 1);
  } finally {
    await f.close();
  }
});
await test("successful cancellation clears cleanup bindings and one Remove deletes the row without another provider request", async () => {
  const f = await fixture();
  try {
    const { created, started } = await f.pending();
    assert.ok(started.setup);
    const before = await f.store.get(created.id);
    assert.ok(before.setup?.binding);
    const cancelled = managementOutputs.cancel.parse(
      await f.manage("cancel", {
        connectionId: created.id,
        setupId: started.setup.id,
        revision: before.revision,
      }),
    );
    const saved = await f.store.get(created.id);
    assert.equal(saved.state, "disconnected");
    assert.equal(saved.setup?.state, "cancelled");
    assert.equal(saved.setup?.binding, null);
    assert.equal(saved.binding, null);
    assert.equal(saved.failure, null);
    assert.equal(f.provider.deletions, 1);
    await assert.rejects(
      f.manage("disconnect", {
        connectionId: created.id,
        revision: before.revision,
      }),
      /changed/,
    );
    assert.deepEqual(
      await f.manage("disconnect", {
        connectionId: created.id,
        revision: cancelled.revision,
      }),
      { removed: true },
    );
    assert.equal((await f.store.list()).length, 0);
    assert.equal(f.provider.deletions, 1);
  } finally {
    await f.close();
  }
});
await test("Remove cleans a retained cancelled binding from an older version and removes the row in one operation", async () => {
  const f = await fixture();
  try {
    const { created } = await f.pending();
    const item = await f.store.get(created.id);
    assert.ok(item.setup);
    const retained = await f.store.save({
      ...item,
      state: "disconnected",
      setup: { ...item.setup, state: "cancelled", url: null },
    });
    assert.deepEqual(
      await f.manage("disconnect", {
        connectionId: created.id,
        revision: retained.revision,
      }),
      { removed: true },
    );
    assert.equal(f.provider.deletions, 1);
    assert.equal((await f.store.list()).length, 0);
  } finally {
    await f.close();
  }
});
for (const completion of ["outcome_unknown", "rejected"] as const)
  await test(`${completion} cancellation retains the exact cleanup binding and requires explicit recovery`, async () => {
    const f = await fixture();
    try {
      const { created, started } = await f.pending();
      assert.ok(started.setup);
      const before = await f.store.get(created.id);
      f.provider.failDelete = true;
      f.provider.deleteCompletion = completion;
      await assert.rejects(
        f.manage("cancel", {
          connectionId: created.id,
          setupId: started.setup.id,
          revision: before.revision,
        }),
        /Cleanup/,
      );
      const saved = await f.store.get(created.id);
      assert.equal(saved.state, "needs_attention");
      assert.deepEqual(saved.setup?.binding, before.setup?.binding);
      assert.match(
        saved.failure?.detail ?? "",
        /cleanup could not be confirmed.*Disconnect/,
      );
      assert.equal(f.provider.deletions, 1);
      const reopened = await f.reopen();
      assert.deepEqual(
        (await reopened.get(saved.id)).setup?.binding,
        before.setup?.binding,
      );
      await reopened.close();
      assert.equal(f.provider.deletions, 1);
      f.provider.failDelete = false;
      assert.deepEqual(
        await f.manage("disconnect", {
          connectionId: saved.id,
          revision: saved.revision,
        }),
        { removed: false },
      );
      const recovered = await f.store.get(saved.id);
      assert.equal(recovered.state, "disconnected");
      assert.equal(recovered.binding, null);
      assert.equal(recovered.setup, null);
      assert.equal(recovered.failure, null);
      assert.deepEqual(
        await f.manage("disconnect", {
          connectionId: recovered.id,
          revision: recovered.revision,
        }),
        { removed: true },
      );
      assert.equal(f.provider.deletions, 2);
    } finally {
      await f.close();
    }
  });
await test("connected Disconnect retains a reusable row and retires the generation", async () => {
  const f = await fixture();
  try {
    const { connected } = await f.linked();
    assert.deepEqual(
      await f.manage("disconnect", {
        connectionId: connected.id,
        revision: connected.revision,
      }),
      { removed: false },
    );
    const saved = await f.store.get(connected.id);
    assert.equal(saved.state, "disconnected");
    assert.equal(saved.generation, connected.generation + 1);
    assert.equal(saved.binding, null);
    assert.equal(saved.setup, null);
    assert.deepEqual(saved.grant, connected.grant);
    assert.equal(f.provider.deletions, 1);
    await assert.rejects(
      f.service.call(execute(connected.id, connected.generation), context),
      /unavailable/,
    );
  } finally {
    await f.close();
  }
});
await test("disconnect disables locally even when provider cleanup is uncertain", async () => {
  const f = await fixture();
  try {
    const { connected } = await f.linked();
    f.provider.failDelete = true;
    await assert.rejects(
      f.manage("disconnect", {
        connectionId: connected.id,
        revision: (await f.store.get(connected.id)).revision,
      }),
      /unknown/,
    );
    assert.equal((await f.store.get(connected.id)).state, "needs_attention");
    await assert.rejects(
      f.service.call(execute(connected.id, connected.generation), context),
      /unavailable/,
    );
    f.provider.failDelete = false;
    await f.manage("disconnect", {
      connectionId: connected.id,
      revision: (await f.store.get(connected.id)).revision,
    });
    assert.equal((await f.store.get(connected.id)).binding, null);
    await f.manage("disconnect", {
      connectionId: connected.id,
      revision: (await f.store.get(connected.id)).revision,
    });
    assert.equal((await f.store.list()).length, 0);
  } finally {
    await f.close();
  }
});
await test("conflicting grant changes serialize behind admitted execution", async () => {
  const f = await fixture();
  try {
    const { connected } = await f.linked();
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let dispatched: () => void = () => {};
    const admitted = new Promise<void>((resolve) => {
      dispatched = resolve;
    });
    f.provider.onExecute = async () => {
      dispatched();
      await gate;
    };
    const execution = f.service.call(
      execute(connected.id, connected.generation),
      context,
    );
    await admitted;
    const edit = f.manage("update", {
      connectionId: connected.id,
      revision: connected.revision,
      name: "Restricted",
      grant: { mode: "selected", agentIds: [] },
    });
    assert.equal((await f.store.get(connected.id)).name, "GitHub");
    release();
    await execution;
    await edit;
    assert.equal((await f.store.get(connected.id)).name, "Restricted");
    await assert.rejects(
      f.service.call(execute(connected.id, connected.generation), {
        ...context,
        toolCallId: "after-edit",
      }),
      /unavailable/,
    );
  } finally {
    await f.close();
  }
});
await test("separate Gateway stores generate independent identities and retain them across restart", async () => {
  const directory = await mkdtemp(
    join(tmpdir(), "openclaw-connections-identities-"),
  );
  try {
    const firstPath = join(directory, "first");
    const first = await ConnectionStore.open(stateRuntime(firstPath));
    const second = await ConnectionStore.open(
      stateRuntime(join(directory, "second")),
    );
    const firstId = first.userId;
    assert.match(firstId, /^openclaw-/);
    assert.notEqual(firstId, second.userId);
    await first.close();
    await second.close();
    const restarted = await ConnectionStore.open(stateRuntime(firstPath));
    assert.equal(restarted.userId, firstId);
    await restarted.close();
    await assert.rejects(
      () => ConnectionStore.open(stateRuntime(firstPath), "different-identity"),
      /retained identity/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
await test("restart marks interrupted dispatch and setup unknown and retains identity without provider keys", async () => {
  const directory = await mkdtemp(
    join(tmpdir(), "openclaw-connections-store-"),
  );
  const path = directory;
  try {
    const store = await ConnectionStore.open(stateRuntime(path), "owner");
    const receipt: Receipt = {
      id: randomUUID(),
      connectionId: randomUUID(),
      generation: 1,
      agentId: "main",
      session: "session",
      toolCallId: "call",
      actionId: "ACTION",
      version: "v1",
      requestHash: "hash",
      state: "dispatching",
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      completedAt: null,
      failure: null,
      result: null,
    };
    await store.claim(receipt);
    await store.insert({
      id: receipt.connectionId,
      connectorId: "github",
      name: "Work",
      grant: { mode: "all" },
      generation: 1,
      revision: 0,
      state: "not_connected",
      binding: null,
      failure: null,
      setup: {
        id: randomUUID(),
        state: "creating",
        actor: "admin",
        ticketHash: "a".repeat(64),
        binding: null,
        url: null,
        expiresAt: receipt.expiresAt,
        failure: null,
      },
    });
    await store.close();
    const restarted = await ConnectionStore.open(stateRuntime(path));
    assert.equal(restarted.userId, "owner");
    assert.equal(
      (await restarted.lookup("main", "session", "call")).state,
      "unknown",
    );
    const interrupted = await restarted.get(receipt.connectionId);
    assert.equal(interrupted.setup?.state, "unknown");
    assert.equal(interrupted.state, "needs_attention");
    assert.match(interrupted.failure?.detail ?? "", /stopped during setup/);
    await restarted.close();
    await assert.rejects(
      () => ConnectionStore.open(stateRuntime(path), "other"),
      /differs/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
await test("expired results are pruned but their call identities still block replay", async () => {
  const directory = await mkdtemp(join(tmpdir(), "connections-prune-"));
  const runtime = stateRuntime(directory);
  const store = await ConnectionStore.open(runtime);
  try {
    const expired: Receipt = {
      id: randomUUID(),
      connectionId: randomUUID(),
      generation: 1,
      agentId: "main",
      session: "session",
      toolCallId: "old-call",
      actionId: "ACTION",
      version: "v1",
      requestHash: "hash",
      state: "succeeded",
      createdAt: "2020-01-01T00:00:00Z",
      expiresAt: "2020-01-08T00:00:00Z",
      completedAt: "2020-01-01T00:00:01Z",
      failure: null,
      result: '"sensitive historical data"',
    };
    await store.claim(expired);
    await store.prune();
    await assert.rejects(
      () =>
        store.claim({
          ...expired,
          id: randomUUID(),
          expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
        }),
      /No operation was replayed/,
    );
    assert.doesNotMatch(
      JSON.stringify(
        await runtime
          .openKeyedStore({
            namespace: "connections.receipts.v1",
            retention: "retained",
          })
          .entries(),
      ),
      /sensitive historical data/,
    );
    assert.equal((await store.usage()).calls, 0);
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

function durableReceipt(overrides: Partial<Receipt> = {}): Receipt {
  return {
    id: randomUUID(),
    connectionId: randomUUID(),
    generation: 1,
    agentId: "main",
    session: "session",
    toolCallId: "call",
    requestHash: "hash",
    actionId: "ACTION",
    version: "v1",
    state: "dispatching",
    createdAt: new Date().toISOString(),
    completedAt: null,
    expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    failure: null,
    result: null,
    ...overrides,
  };
}
await test("real retained SDK atomically races claims and connection revisions across handles", async () => {
  const directory = await mkdtemp(join(tmpdir(), "connections-cas-"));
  const runtime = stateRuntime(directory);
  const first = await ConnectionStore.open(runtime, "owner");
  const second = await ConnectionStore.open(runtime, "owner");
  try {
    const receipt = durableReceipt();
    const claims = await Promise.all(
      Array.from({ length: 16 }, (_, i) =>
        (i % 2 ? first : second).claim({ ...receipt, id: randomUUID() }),
      ),
    );
    assert.equal(new Set(claims.map((claim) => claim.id)).size, 1);
    const item = {
      id: receipt.connectionId,
      connectorId: "github",
      name: "Work",
      grant: { mode: "all" as const },
      generation: 0,
      revision: 0,
      state: "not_connected" as const,
      binding: null,
      setup: null,
      failure: null,
    };
    await first.insert(item);
    const writes = await Promise.allSettled([
      first.save({ ...item, name: "First" }),
      second.save({ ...item, name: "Second" }),
    ]);
    assert.equal(
      writes.filter((write) => write.status === "fulfilled").length,
      1,
    );
    const rejected = writes.find((write) => write.status === "rejected");
    assert.ok(rejected && rejected.status === "rejected");
    assert.match(String(rejected.reason), /changed/);
    assert.equal((await first.get(item.id)).revision, 1);
    await assert.rejects(() => second.remove(item.id, 0), /changed/);
    // A sibling connection edit retries only a pure decision and is not lost.
    await Promise.all([
      first.insert({ ...item, id: randomUUID() }),
      second.insert({ ...item, id: randomUUID() }),
    ]);
    assert.equal((await first.list()).length, 3);
    const winner = claims[0];
    assert.ok(winner);
    await first.saveReceipt({
      ...winner,
      state: "succeeded",
      result: '"saved"',
    });
    await first.close();
    await second.close();
    const reopened = await ConnectionStore.open(runtime);
    assert.equal(
      (await reopened.lookup("main", "session", "call")).state,
      "succeeded",
    );
    assert.equal(
      (await reopened.lookup("main", "session", "call")).result,
      '"saved"',
    );
    await assert.rejects(
      () => reopened.saveReceipt({ ...winner, state: "unknown" }),
      /already been recorded/,
    );
    await reopened.close();
  } finally {
    await first.close();
    await second.close();
    await rm(directory, { recursive: true, force: true });
  }
});
await test("runtime plugin namespaces and exact agent/session tuples isolate retained receipts", async () => {
  const directory = await mkdtemp(join(tmpdir(), "connections-isolation-"));
  const first = await ConnectionStore.open(
    stateRuntime(directory, "plugin-a"),
    "user-a",
  );
  const other = await ConnectionStore.open(
    stateRuntime(directory, "plugin-b"),
    "user-b",
  );
  try {
    const receipt = durableReceipt();
    await first.claim(receipt);
    await assert.rejects(
      () => other.lookup("main", "session", "call"),
      /No retained call/,
    );
    await assert.rejects(
      () => first.receipt(receipt.id, "another-agent", "session"),
      /unavailable/,
    );
    const anotherAgent = await first.claim({
      ...receipt,
      id: randomUUID(),
      agentId: "another-agent",
    });
    const anotherSession = await first.claim({
      ...receipt,
      id: randomUUID(),
      session: "another-session",
    });
    assert.notEqual(anotherAgent.id, receipt.id);
    assert.notEqual(anotherSession.id, receipt.id);
    // Tuple boundaries cannot alias even when native IDs contain delimiters.
    const one = await first.claim({
      ...receipt,
      id: randomUUID(),
      agentId: "a:b",
      session: "c",
    });
    const two = await first.claim({
      ...receipt,
      id: randomUUID(),
      agentId: "a",
      session: "b:c",
    });
    assert.notEqual(one.id, two.id);
    assert.equal(other.userId, "user-b");
    await assert.rejects(
      () => ConnectionStore.open(stateRuntime(directory, "plugin-a"), "user-b"),
      /differs/,
    );
  } finally {
    await first.close();
    await other.close();
    await rm(directory, { recursive: true, force: true });
  }
});
await test("pruning over multiple pages keeps unknown outcomes and permanent deduplication", async () => {
  const directory = await mkdtemp(join(tmpdir(), "connections-pages-"));
  const runtime = stateRuntime(directory);
  const store = await ConnectionStore.open(runtime);
  try {
    for (let i = 0; i < 140; i++)
      await store.claim(
        durableReceipt({
          toolCallId: `call-${i}`,
          state: "unknown",
          result: '"sensitive"',
          expiresAt: "2020-01-01T00:00:00Z",
        }),
      );
    await store.prune();
    const values = await runtime
      .openKeyedStore({
        namespace: "connections.receipts.v1",
        retention: "retained",
      })
      .entries();
    assert.equal(values.length, 140);
    assert.doesNotMatch(JSON.stringify(values), /sensitive/);
    assert.match(JSON.stringify(values), /outcome remains unknown/);
    await store.close();
    const reopened = await ConnectionStore.open(runtime);
    await assert.rejects(
      () => reopened.claim(durableReceipt({ toolCallId: "call-139" })),
      /No operation was replayed/,
    );
    await reopened.close();
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

await test("missing CAS and failed state reads stop without a storage fallback", async () => {
  const directory = await mkdtemp(join(tmpdir(), "connections-fail-closed-"));
  const runtime = stateRuntime(directory);
  try {
    const unsupported: StateRuntime = {
      openKeyedStore<T>(
        options: Parameters<StateRuntime["openKeyedStore"]>[0],
      ) {
        const { observe: _observe, ...rest } =
          runtime.openKeyedStore<T>(options);
        return rest;
      },
    };
    await assert.rejects(
      () => ConnectionStore.open(unsupported),
      /requires retained/,
    );
    assert.equal(
      await runtime
        .openKeyedStore({
          namespace: "connections.identity.v1",
          retention: "retained",
        })
        .lookup("identity"),
      undefined,
    );
    const error = new Error("Synthetic storage read failure");
    let reads = 0;
    const failing: StateRuntime = {
      openKeyedStore<T>(
        options: Parameters<StateRuntime["openKeyedStore"]>[0],
      ) {
        const store = runtime.openKeyedStore<T>(options);
        return {
          ...store,
          lookup: async () => {
            reads++;
            throw error;
          },
        };
      },
    };
    await assert.rejects(
      () => ConnectionStore.open(failing),
      (failure) => failure === error,
    );
    assert.equal(reads, 1);
    // Invalid authoritative data must fail, never become an empty registry.
    await runtime
      .openKeyedStore({
        namespace: "connections.registry.v1",
        retention: "retained",
      })
      .register("registry", { malformed: true });
    await assert.rejects(() => ConnectionStore.open(runtime));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
await test("failed dispatch claims prevent provider effects and failed outcome writes recover unknown", async () => {
  let failClaim = false;
  let failOutcome = false;
  const error = new Error("Synthetic retained write failure");
  const f = await fixture((runtime) => ({
    openKeyedStore<T>(options: Parameters<StateRuntime["openKeyedStore"]>[0]) {
      const store = runtime.openKeyedStore<T>(options);
      if (options.namespace !== "connections.receipts.v1") return store;
      const compare = store.compareAndApply;
      assert.ok(compare);
      const adapted: typeof store = {
        ...store,
        registerIfAbsent: async (key, value, opts) => {
          if (failClaim) throw error;
          return store.registerIfAbsent(key, value, opts);
        },
        compareAndApply: async (key, observation, intent) => {
          if (failOutcome) throw error;
          return compare(key, observation, intent);
        },
      };
      return adapted;
    },
  }));
  try {
    const { connected } = await f.linked();
    failClaim = true;
    await assert.rejects(
      () =>
        f.service.call(execute(connected.id, connected.generation), context),
      (failure) => failure === error,
    );
    assert.equal(f.provider.executions, 0);
    failClaim = false;
    failOutcome = true;
    await assert.rejects(
      () =>
        f.service.call(execute(connected.id, connected.generation), context),
      (failure) => failure === error,
    );
    assert.equal(f.provider.executions, 1);
    failOutcome = false;
    const saved = await f.store.lookup(
      context.agentId,
      context.sessionKey,
      context.toolCallId,
    );
    assert.equal(saved.state, "dispatching");
    // A failed write is not retried or turned into a fabricated successful receipt.
    await f.service.call(execute(connected.id, connected.generation), context);
    assert.equal(f.provider.executions, 1);
    await f.service.close();
    const reopened = await f.reopen();
    assert.equal(
      (
        await reopened.lookup(
          context.agentId,
          context.sessionKey,
          context.toolCallId,
        )
      ).state,
      "unknown",
    );
    await reopened.close();
  } finally {
    await f.close();
  }
});
