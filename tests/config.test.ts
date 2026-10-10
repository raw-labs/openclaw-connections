import assert from "node:assert/strict";
import { test } from "node:test";
import { runtimeConfigSchema } from "../src/config.js";

await test("runtime config retains optional native references while rejecting malformed envelopes", () => {
  assert.deepEqual(runtimeConfigSchema.parse({}), {});
  assert.equal(
    runtimeConfigSchema.parse({ apiKey: " synthetic " }).apiKey,
    "synthetic",
  );
  for (const source of ["env", "file", "exec"]) {
    const apiKey = { source, provider: "fixture", id: "exact-binding" };
    assert.deepEqual(
      runtimeConfigSchema.parse({
        apiKey,
        userId: "owner",
        authConfigIds: { github: "ac_exact" },
      }).apiKey,
      apiKey,
    );
  }
  for (const config of [
    { apiKey: {} },
    { apiKey: { source: "env", provider: "default", id: 1 } },
    { apiKey: { source: "env", provider: "default", id: "KEY", extra: true } },
    { apiKey: " " },
    { userId: "owner" },
    { apiKey: "synthetic", unexpected: true },
  ])
    assert.equal(runtimeConfigSchema.safeParse(config).success, false);
});
