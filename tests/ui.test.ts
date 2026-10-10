import assert from "node:assert/strict";
import { test } from "node:test";
import { setImmediate } from "node:timers/promises";
import { JSDOM } from "jsdom";
import {
  connections,
  type ConnectionsViewContext,
} from "../src/ui/connections-page.js";
import { packagedCatalog } from "../src/catalog.js";
import type { Connection } from "../src/contracts.js";

function fixture(
  handle: (method: string, params: Record<string, unknown>) => Promise<unknown>,
) {
  const dom = new JSDOM("<!doctype html><body><main></main></body>", {
    url: "http://localhost:18789",
  });
  const originals = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries({
    document: dom.window.document,
    window: dom.window,
    HTMLElement: dom.window.HTMLElement,
    sessionStorage: dom.window.sessionStorage,
  })) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, {
      configurable: true,
      writable: true,
      value,
    });
  }
  const listeners = new Set<() => void>();
  const context: ConnectionsViewContext = {
    signal: new AbortController().signal,
    host: {
      connection: {
        connected: true,
        canRead: true,
        canWrite: true,
        canGrant: true,
        canAdmin: true,
        assistantAgentId: "main",
      },
      components: {
        mountDialog(container, props) {
          container.append(props.content);
          return {
            dispose: () => container.replaceChildren(),
            update: (next) => container.replaceChildren(next.content),
          };
        },
      },
      subscribe(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      request: (method, params) => handle(method, params ?? {}),
    },
  };
  const main = dom.window.document.querySelector("main");
  assert.ok(main);
  const view = connections(main, context);
  const button = (label: string) => {
    const node = [
      ...dom.window.document.querySelectorAll<HTMLButtonElement>("button"),
    ].find((node) => node.textContent === label && !node.hidden);
    assert.ok(node, `Missing button: ${label}`);
    return node;
  };
  return {
    dom,
    main,
    context,
    button,
    update: () => {
      for (const listener of listeners) listener();
    },
    close() {
      view.dispose();
      dom.window.close();
      for (const [key, descriptor] of originals) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
    },
  };
}
const flush = async () => {
  for (let i = 0; i < 4; i++) await setImmediate();
};
const connection: Connection = {
  id: "11111111-1111-4111-8111-111111111111",
  connectorId: "github",
  name: "Work GitHub",
  state: "connected",
  generation: 1,
  revision: 1,
  grant: { mode: "all" },
  setup: null,
  failure: null,
};

await test("native UI shows unconfigured guidance without catalog/account requests", async () => {
  const calls: string[] = [];
  const f = fixture(async (method) => {
    calls.push(method);
    return { configured: false, userId: null };
  });
  try {
    await flush();
    assert.match(f.main.textContent ?? "", /Configure Composio/);
    assert.deepEqual(calls, ["connections.status"]);
    assert.equal(f.dom.window.document.querySelector("a"), null);
  } finally {
    f.close();
  }
});
await test("native UI displays capability unavailability and keeps linking inactive", async () => {
  const calls: string[] = [];
  const f = fixture(async (method) => {
    calls.push(method);
    throw Error(
      "Secret owner capability:plugins.entries.openclaw-connections.config.apiKey is configured but unavailable (secret reference was not found).",
    );
  });
  try {
    await flush();
    assert.match(f.main.textContent ?? "", /configured but unavailable/);
    assert.deepEqual(calls, ["connections.status"]);
    assert.equal(f.dom.window.document.querySelector("a"), null);
    assert.equal(
      [...f.dom.window.document.querySelectorAll("button")].some(
        (node) => node.textContent === "Add connection" && !node.hidden,
      ),
      false,
    );
  } finally {
    f.close();
  }
});
await test("empty UI opens the same grouped searchable catalog using native RPC", async () => {
  const f = fixture(async (method) => {
    if (method === "connections.status")
      return { configured: true, userId: "local" };
    if (method === "connections.list") return { items: [], nextCursor: null };
    if (method === "connections.catalog")
      return { items: packagedCatalog(), nextCursor: null };
    throw Error(`Unexpected RPC ${method}`);
  });
  try {
    await flush();
    assert.match(f.main.textContent ?? "", /Connect your services/);
    f.button("Add connection").click();
    await flush();
    const search = f.dom.window.document.querySelector<HTMLInputElement>(
      '[aria-label="Search services"]',
    );
    assert.ok(search);
    search.value = "microsoft";
    search.dispatchEvent(new f.dom.window.Event("input"));
    const catalog = f.dom.window.document.querySelector(".oc-catalog");
    assert.ok(catalog);
    assert.match(catalog.textContent ?? "", /Microsoft/);
    assert.doesNotMatch(catalog.textContent ?? "", /GitHub/);
    assert.ok(
      f.dom.window.document.querySelector('[aria-label="Service category"]'),
    );
    for (const image of f.dom.window.document.querySelectorAll("img"))
      assert.match(image.src, /^data:/);
  } finally {
    f.close();
  }
});
await test("refresh preserves visible accounts during loading and after errors; revocation clears data", async () => {
  let reads = 0;
  let fail: (error: Error) => void = () => {};
  const pending = new Promise<unknown>((_resolve, reject) => {
    fail = reject;
  });
  const f = fixture(async (method) => {
    if (method === "connections.status")
      return { configured: true, userId: "local" };
    if (method === "connections.list") {
      if (++reads === 1) return { items: [connection], nextCursor: null };
      return pending;
    }
    throw Error(`Unexpected RPC ${method}`);
  });
  try {
    await flush();
    f.button("Refresh").click();
    await flush();
    assert.match(f.main.textContent ?? "", /Work GitHub/);
    assert.equal(
      f.main.querySelector(".oc-page-content")?.getAttribute("aria-busy"),
      "true",
    );
    fail(Error("Composio unavailable"));
    await flush();
    assert.match(f.main.textContent ?? "", /Work GitHub/);
    assert.match(
      f.main.querySelector('[role="alert"]')?.textContent ?? "",
      /unavailable/,
    );
    f.context.host.connection.canAdmin = false;
    f.update();
    assert.doesNotMatch(f.main.textContent ?? "", /Work GitHub/);
  } finally {
    f.close();
  }
});
await test("link opens a separate tab and completion sends only the original browser ticket", async () => {
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  const setupId = "22222222-2222-4222-8222-222222222222";
  const f = fixture(async (method, params) => {
    calls.push({ method, params });
    if (method === "connections.status")
      return { configured: true, userId: "local" };
    if (method === "connections.list")
      return {
        items: [{ ...connection, state: "not_connected" }],
        nextCursor: null,
      };
    if (method === "connections.start")
      return {
        setup: {
          id: setupId,
          state: "pending",
          failure: null,
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        },
        url: "https://connect.composio.dev/synthetic",
        ticket: "browser-only-ticket",
      };
    if (method === "connections.complete") return connection;
    throw Error(`Unexpected RPC ${method}`);
  });
  try {
    await flush();
    f.button("Connect").click();
    await flush();
    const link = f.dom.window.document.querySelector<HTMLAnchorElement>("a");
    assert.ok(link);
    assert.equal(link.target, "_blank");
    assert.equal(link.rel, "noopener noreferrer");
    assert.equal(f.dom.window.location.href, "http://localhost:18789/");
    f.button("Finish connecting").click();
    await flush();
    const complete = calls.find(
      (call) => call.method === "connections.complete",
    );
    assert.ok(complete);
    assert.deepEqual(complete.params, {
      connectionId: connection.id,
      setupId,
      ticket: "browser-only-ticket",
    });
    assert.equal(
      f.dom.window.sessionStorage.getItem(`connections.setup.${setupId}`),
      null,
    );
    assert.doesNotMatch(
      JSON.stringify(calls),
      /apiKey|x-api-key|managementKey|clawscarf/,
    );
  } finally {
    f.close();
  }
});
