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
import { ConnectionStore } from "../src/store.js";
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
  unknownSetup = false;
  unknownExecution = false;
  sentArguments: unknown;
  onExecute: (() => Promise<void>) | undefined;
  onInspect: (() => void) | undefined;
  async resolveAuthConfiguration() {
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
        "connector_provider_unknown_outcome",
        "Cleanup outcome unknown.",
        "outcome_unknown",
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
function fixture(path = ":memory:") {
  const provider = new Provider();
  const store = new ConnectionStore(path, "local-user");
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
  async function linked() {
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
    service,
    store,
    provider,
    manage,
    linked,
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
  const f = fixture();
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
    assert.equal(f.store.get(created.id).state, "not_connected");
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
    await f.service.close();
  }
});
await test("revoked authority cannot activate after provider inspection", async () => {
  const f = fixture();
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
    assert.equal(f.store.get(created.id).state, "not_connected");
  } finally {
    await f.service.close();
  }
});
await test("unknown setup is durable and start never blindly allocates another account", async () => {
  const f = fixture();
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
    const item = f.store.get(created.id);
    assert.equal(item.setup?.state, "unknown");
    assert.match(item.failure?.detail ?? "", /unknown/);
    await assert.rejects(
      f.manage("start", { connectionId: item.id, revision: item.revision }),
      /already exists/,
    );
    assert.equal(f.provider.setups, 1);
  } finally {
    await f.service.close();
  }
});
await test("native agent grants apply to search, describe, execute and saved-result reads", async () => {
  const f = fixture();
  try {
    const { connected } = await f.linked();
    const result = await f.service.call(
      execute(connected.id, connected.generation),
      context,
    );
    await f.manage("update", {
      connectionId: connected.id,
      revision: f.store.get(connected.id).revision,
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
    await f.service.close();
  }
});
await test("search matches separate account/action terms without choosing another account", async () => {
  const f = fixture();
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
    await f.service.close();
  }
});
await test("exact generation/version and native session are mandatory; schemas remain advisory", async () => {
  const f = fixture();
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
    await f.service.close();
  }
});
await test("lost execute response remains unknown and duplicate call identity never replays", async () => {
  const f = fixture();
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
    await f.service.close();
  }
});
await test("complete large Unicode JSON is paged without another provider execution", async () => {
  const f = fixture();
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
    await f.service.close();
  }
});
await test("disconnect disables locally even when provider cleanup is uncertain", async () => {
  const f = fixture();
  try {
    const { connected } = await f.linked();
    f.provider.failDelete = true;
    await assert.rejects(
      f.manage("disconnect", {
        connectionId: connected.id,
        revision: f.store.get(connected.id).revision,
      }),
      /unknown/,
    );
    assert.equal(f.store.get(connected.id).state, "needs_attention");
    await assert.rejects(
      f.service.call(execute(connected.id, connected.generation), context),
      /unavailable/,
    );
    f.provider.failDelete = false;
    await f.manage("disconnect", {
      connectionId: connected.id,
      revision: f.store.get(connected.id).revision,
    });
    assert.equal(f.store.get(connected.id).binding, null);
    await f.manage("disconnect", {
      connectionId: connected.id,
      revision: f.store.get(connected.id).revision,
    });
    assert.equal(f.store.list().length, 0);
  } finally {
    await f.service.close();
  }
});
await test("conflicting grant changes serialize behind admitted execution", async () => {
  const f = fixture();
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
    assert.equal(f.store.get(connected.id).name, "GitHub");
    release();
    await execution;
    await edit;
    assert.equal(f.store.get(connected.id).name, "Restricted");
    await assert.rejects(
      f.service.call(execute(connected.id, connected.generation), {
        ...context,
        toolCallId: "after-edit",
      }),
      /unavailable/,
    );
  } finally {
    await f.service.close();
  }
});
await test("restart marks interrupted dispatch and setup unknown and retains identity without provider keys", async () => {
  const directory = await mkdtemp(
    join(tmpdir(), "openclaw-connections-store-"),
  );
  const path = join(directory, "state.sqlite");
  try {
    const store = new ConnectionStore(path, "owner");
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
    store.claim(receipt);
    store.insert({
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
    store.close();
    const restarted = new ConnectionStore(path);
    assert.equal(restarted.userId, "owner");
    assert.equal(restarted.lookup("main", "session", "call").state, "unknown");
    const interrupted = restarted.get(receipt.connectionId);
    assert.equal(interrupted.setup?.state, "unknown");
    assert.equal(interrupted.state, "needs_attention");
    assert.match(interrupted.failure?.detail ?? "", /stopped during setup/);
    restarted.close();
    assert.throws(() => new ConnectionStore(path, "other"), /differs/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
await test("expired results are pruned but their call identities still block replay", async () => {
  const store = new ConnectionStore(":memory:");
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
    store.db
      .prepare(
        "INSERT INTO receipts(id,agent,session,call,expires,payload) VALUES(?,?,?,?,?,?)",
      )
      .run(
        expired.id,
        expired.agentId,
        expired.session,
        expired.toolCallId,
        expired.expiresAt,
        JSON.stringify(expired),
      );
    store.prune();
    assert.throws(
      () =>
        store.claim({
          ...expired,
          id: randomUUID(),
          expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
        }),
      /No operation was replayed/,
    );
    assert.doesNotMatch(
      JSON.stringify(store.db.prepare("SELECT payload FROM receipts").all()),
      /sensitive historical data/,
    );
    assert.equal(store.usage().calls, 0);
  } finally {
    store.close();
  }
});
