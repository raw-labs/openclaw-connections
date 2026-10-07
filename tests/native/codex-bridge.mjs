// The pinned official plugin's built bridge is a test boundary, never a runtime dependency.
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { z } from "zod";
const [base, token, connectionId, generationText] = process.argv.slice(2);
assert.ok(base && token && connectionId && generationText);
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
const tools = names.map((name) => ({
  name,
  label: name,
  description: name,
  parameters: { type: "object", additionalProperties: true },
  async execute(callId, args, signal) {
    const response = await fetch(`${base}/tools/invoke`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        tool: name,
        args,
        agentId: "main",
        sessionKey: "agent:main:connections-test",
        idempotencyKey: callId,
      }),
      signal,
    });
    const result = z
      .object({
        ok: z.literal(true),
        result: z.object({
          content: z.array(
            z.object({ type: z.literal("text"), text: z.string() }),
          ),
          details: z.unknown(),
        }),
      })
      .parse(await response.json());
    assert.equal(response.status, 200);
    return result.result;
  },
}));
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
        toolCallId: z.literal("http-direct-operator-codex-call"),
        state: z.literal("succeeded"),
      }),
    })
    .parse(called.data);
  assert.ok(invocation);
  assert.deepEqual(await call(names[2], args, "codex-call"), called);
  const lookup = await call(
    names[2],
    { mode: "lookup", toolCallId: "http-direct-operator-codex-call" },
    "codex-lookup",
  );
  assert.deepEqual(lookup, called);
}
process.stdout.write(
  "All three tools passed the official Codex bridge in direct and searchable modes; native identity and replay verified.\n",
);
