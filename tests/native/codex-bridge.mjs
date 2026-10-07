// The public SDK host fixture registers the actual packed tools. The official
// Codex bridge is a test boundary, never a runtime dependency.
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { z } from "zod";
import { getToolPluginMetadata } from "openclaw/plugin-sdk/tool-plugin";
const [entryPath, connectionId, generationText] = process.argv.slice(2);
assert.ok(entryPath && connectionId && generationText);
assert.ok(process.env.OPENCLAW_STATE_DIR);
assert.equal(process.env.COMPOSIO_API_KEY, "synthetic-never-sent-project-key");
const { default: plugin } = await import(pathToFileURL(entryPath).href);
const metadata = getToolPluginMetadata(plugin);
assert.ok(metadata);
const factories = new Map();
const services = [];
const methods = new Map();
// Fail on an unexpected SDK dependency rather than silently mocking it.
const api = new Proxy(
  {
    pluginConfig: {
      apiKey: process.env.COMPOSIO_API_KEY,
      userId: "native-test-owner",
      authConfigIds: { github: "ac_native" },
    },
    config: {},
    runtime: {
      state: { resolveStateDir: () => process.env.OPENCLAW_STATE_DIR },
    },
    registerTool(factory, options) {
      assert.equal(typeof factory, "function");
      assert.equal(factories.has(options.name), false);
      factories.set(options.name, factory);
    },
    registerService(service) {
      services.push(service);
    },
    registerGatewayMethod(name, handler, options) {
      assert.equal(options.scope, "operator.admin");
      methods.set(name, handler);
    },
  },
  {
    get(target, key) {
      assert.ok(
        Object.hasOwn(target, key),
        `Unexpected SDK property ${String(key)}`,
      );
      return Reflect.get(target, key);
    },
  },
);
await plugin.register(api);
assert.equal(methods.size, 12);
assert.equal(services.length, 1);
await services[0].start();
try {
  const folder = resolve("node_modules/@openclaw/codex/dist/.setup");
  const candidates = (await readdir(folder)).filter((name) =>
    /^dynamic-tools-.*\.mjs$/.test(name),
  );
  assert.equal(candidates.length, 1);
  const modulePath = resolve(folder, candidates[0]);
  assert.match(
    await readFile(modulePath, "utf8"),
    /createCodexDynamicToolBridge as t/,
  );
  const { t: createBridge } = await import(pathToFileURL(modulePath).href);
  assert.equal(typeof createBridge, "function");
  const names = [
    "connections_search",
    "connections_describe",
    "connections_call",
  ];
  assert.deepEqual([...factories.keys()], names);
  const toolsFor = (toolContext) =>
    names.map((name) => {
      const tool = factories.get(name)(toolContext);
      assert.equal(tool.name, name);
      assert.deepEqual(
        tool.parameters,
        metadata.tools.find((item) => item.name === name).parameters,
      );
      return tool;
    });
  const tools = toolsFor({
    agentId: "main",
    sessionKey: "agent:main:connections-test",
  });
  const responseSchema = z.object({
    contentItems: z.array(
      z.object({ type: z.literal("inputText"), text: z.string() }),
    ),
    success: z.boolean(),
  });
  for (const loading of ["searchable", "direct"]) {
    const bridge = createBridge({
      tools,
      signal: new AbortController().signal,
      loading,
      hookContext: {
        agentId: "main",
        sessionKey: "agent:main:connections-test",
        runId: "synthetic-codex-run",
      },
    });
    assert.deepEqual(bridge.telemetry.quarantinedTools, []);
    assert.deepEqual(
      bridge.availableTools.map((tool) => tool.name),
      names,
    );
    for (const name of names)
      assert.match(JSON.stringify(bridge.specs), new RegExp(name));
    if (loading === "searchable")
      assert.match(JSON.stringify(bridge.specs), /deferLoading/);
    const call = async (tool, args, callId) => {
      const response = responseSchema.parse(
        await bridge.handleToolCall({
          tool,
          arguments: args,
          callId,
          threadId: "synthetic-thread",
          turnId: "synthetic-turn",
        }),
      );
      assert.ok(response.success, JSON.stringify(response));
      return z
        .object({
          ok: z.boolean(),
          data: z.unknown().optional(),
          error: z.unknown().optional(),
        })
        .parse(
          JSON.parse(response.contentItems.map((item) => item.text).join("")),
        );
    };
    const found = await call(names[0], {}, `search-${loading}`);
    assert.ok(found.ok, JSON.stringify(found));
    assert.match(JSON.stringify(found.data), /GITHUB_CREATE_ISSUE/);
    const described = await call(
      names[1],
      { connectionId, actionId: "GITHUB_CREATE_ISSUE" },
      `describe-${loading}`,
    );
    assert.ok(described.ok, JSON.stringify(described));
    const args = {
      mode: "execute",
      connectionId,
      generation: Number(generationText),
      actionId: "GITHUB_CREATE_ISSUE",
      version: "20260910_00",
      arguments: { synthetic: true },
    };
    const called = await call(names[2], args, "codex-call");
    assert.ok(called.ok, JSON.stringify(called));
    const invocation = z
      .object({
        invocation: z.object({
          agentId: z.literal("main"),
          toolCallId: z.literal("codex-call"),
          state: z.literal("succeeded"),
        }),
      })
      .parse(called.data);
    assert.ok(invocation);
    assert.deepEqual(await call(names[2], args, "codex-call"), called);
    const lookup = await call(
      names[2],
      { mode: "lookup", toolCallId: "codex-call" },
      "codex-lookup",
    );
    assert.deepEqual(lookup, called);
    // The actual factory must retain its native session and agent, rather than
    // deriving authority from bridge metadata or model-supplied arguments.
    for (const context of [
      { agentId: "main", sessionKey: "agent:main:another-session" },
      { agentId: "another-agent", sessionKey: "agent:main:connections-test" },
    ]) {
      const isolated = createBridge({
        tools: toolsFor(context),
        loading,
        hookContext: { ...context, runId: "synthetic-isolated-run" },
      });
      const response = responseSchema.parse(
        await isolated.handleToolCall({
          tool: names[2],
          arguments: { mode: "lookup", toolCallId: "codex-call" },
          callId: "isolated-lookup",
          threadId: "synthetic-thread",
          turnId: "synthetic-turn",
        }),
      );
      const denied = JSON.parse(
        response.contentItems.map((item) => item.text).join(""),
      );
      assert.equal(denied.ok, false);
      assert.equal(denied.error.code, "receipt_not_found");
    }
  }
  process.stdout.write(
    "All three tools passed the official Codex bridge with packed factories and schemas in direct and searchable modes; native identity, session isolation and replay verified.\n",
  );
} finally {
  await services[0].stop();
}
