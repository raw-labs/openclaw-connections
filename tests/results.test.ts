import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ConnectionStore, type StateRuntime } from "../src/store.js";
import type { Receipt } from "../src/contracts.js";
import { stateRuntime } from "./helpers/state.mjs";
function pending(): Receipt {
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
    result: null,
    failure: null,
    createdAt: new Date().toISOString(),
    completedAt: null,
    expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
  };
}
const resultOptions = {
  namespace: "connections.results.v1",
  retention: "retained" as const,
};
await test("results larger than a keyed value survive reopen intact and prune without losing the call claim", async () => {
  const directory = await mkdtemp(join(tmpdir(), "connections-result-chunks-"));
  const runtime = stateRuntime(directory);
  const store = await ConnectionStore.open(runtime);
  const receipt = pending();
  const result = JSON.stringify('𝄞\u0000 control " data'.repeat(100_000));
  assert.ok(Buffer.byteLength(result) > 1024 * 1024);
  try {
    await store.claim(receipt);
    await store.saveReceipt({ ...receipt, state: "succeeded", result });
    assert.equal(
      (await store.lookup("main", "session", "call")).result,
      result,
    );
    await store.close();
    const reopened = await ConnectionStore.open(runtime);
    assert.equal(
      (await reopened.receipt(receipt.id, "main", "session")).result,
      result,
    );
    assert.equal(
      (await reopened.claim({ ...receipt, id: randomUUID() })).result,
      result,
    );
    await reopened.prune(new Date(Date.now() + 8 * 86_400_000).toISOString());
    assert.equal(
      (await runtime.openKeyedStore(resultOptions).entries()).length,
      0,
    );
    const duplicate = await reopened.claim({ ...receipt, id: randomUUID() });
    assert.equal(duplicate.id, receipt.id);
    assert.equal(duplicate.state, "succeeded");
    assert.equal(duplicate.result, null);
    await reopened.close();
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});
await test("partial result writes retain confirmed success, surface the storage error and clean orphan chunks", async () => {
  const directory = await mkdtemp(
    join(tmpdir(), "connections-result-failure-"),
  );
  const runtime = stateRuntime(directory);
  const error = new Error("Synthetic second chunk write failure");
  let writes = 0;
  const failing: StateRuntime = {
    openKeyedStore<T>(options: Parameters<StateRuntime["openKeyedStore"]>[0]) {
      const store = runtime.openKeyedStore<T>(options);
      if (options.namespace !== resultOptions.namespace) return store;
      const adapted: typeof store = {
        ...store,
        registerIfAbsent: async (key, value, opts) => {
          if (++writes === 2) throw error;
          return store.registerIfAbsent(key, value, opts);
        },
      };
      return adapted;
    },
  };
  const store = await ConnectionStore.open(failing);
  const receipt = pending();
  try {
    await store.claim(receipt);
    await assert.rejects(
      () =>
        store.saveReceipt({
          ...receipt,
          state: "succeeded",
          result: JSON.stringify("x".repeat(150_000)),
        }),
      (failure) => failure === error,
    );
    assert.equal(writes, 2);
    const saved = await store.lookup("main", "session", "call");
    assert.equal(saved.state, "succeeded");
    assert.equal(saved.result, null);
    assert.match(saved.failure?.detail ?? "", /result could not be saved/);
    assert.equal(
      (await runtime.openKeyedStore(resultOptions).entries()).length,
      1,
    );
    await store.close();
    const reopened = await ConnectionStore.open(runtime);
    assert.equal(
      (await reopened.lookup("main", "session", "call")).state,
      "succeeded",
    );
    await reopened.prune(new Date(Date.now() + 8 * 86_400_000).toISOString());
    assert.equal(
      (await runtime.openKeyedStore(resultOptions).entries()).length,
      0,
    );
    await reopened.close();
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});
await test("corrupt or missing result chunks never turn a committed call into a new claim", async () => {
  const directory = await mkdtemp(
    join(tmpdir(), "connections-result-integrity-"),
  );
  const runtime = stateRuntime(directory);
  const store = await ConnectionStore.open(runtime);
  const receipt = pending();
  try {
    await store.claim(receipt);
    await store.saveReceipt({
      ...receipt,
      state: "succeeded",
      result: '"original"',
    });
    const chunks = runtime.openKeyedStore(resultOptions);
    const entry = (await chunks.entries())[0];
    assert.ok(entry);
    await chunks.register(entry.key, { text: '"changed"' });
    await assert.rejects(
      () => store.lookup("main", "session", "call"),
      /integrity check/,
    );
    await chunks.delete(entry.key);
    await assert.rejects(
      () => store.claim({ ...receipt, id: randomUUID() }),
      /saved result is unavailable/,
    );
    const ledger = await runtime
      .openKeyedStore({
        namespace: "connections.receipts.v1",
        retention: "retained",
      })
      .entries();
    assert.equal(ledger.length, 1);
    assert.equal((await store.usage()).succeeded, 1);
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

await test("native action authority revoked after observation prevents the CAS write", async () => {
  const directory = await mkdtemp(join(tmpdir(), "connections-authority-"));
  const runtime = stateRuntime(directory);
  let admitted = true;
  const guarded: StateRuntime = {
    openKeyedStore<T>(options: Parameters<StateRuntime["openKeyedStore"]>[0]) {
      const store = runtime.openKeyedStore<T>(options);
      if (options.namespace !== "connections.registry.v1") return store;
      const bind = store.withCurrent;
      assert.ok(bind);
      const adapted: typeof store = {
        ...store,
        withCurrent: (authority) => {
          const bound = bind(authority);
          return {
            ...bound,
            observe: async (key) => {
              const observed = await bound.observe(key);
              admitted = false;
              return observed;
            },
          };
        },
      };
      return adapted;
    },
  };
  const store = await ConnectionStore.open(guarded);
  try {
    await assert.rejects(
      () =>
        store.insert(
          {
            id: randomUUID(),
            connectorId: "github",
            name: "Work",
            grant: { mode: "all" },
            generation: 0,
            revision: 0,
            state: "not_connected",
            binding: null,
            setup: null,
            failure: null,
          },
          () => {
            if (!admitted)
              throw new Error("Authority revoked while preparing the write");
          },
        ),
      /Authority revoked/,
    );
    assert.deepEqual(await store.list(), []);
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});
