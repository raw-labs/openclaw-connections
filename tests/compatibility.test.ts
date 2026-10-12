import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";
import pkg from "../package.json" with { type: "json" };
const root = resolve(import.meta.dirname, "..");
await test("compatibility admits the exact source host label and qualification verifies its revision", async () => {
  const pin = z
    .strictObject({
      version: z.string(),
      commit: z.string().regex(/^[a-f0-9]{40}$/),
      archiveSha256: z.string().regex(/^[a-f0-9]{64}$/),
      builtAt: z.string(),
      pnpmVersion: z.string(),
      buildProfile: z.literal("ciArtifacts"),
      compatibleVersions: z.array(z.string()),
    })
    .parse(
      JSON.parse(await readFile(resolve(root, "openclaw-host.json"), "utf8")),
    );
  const info = z
    .object({ version: z.string(), commit: z.string() })
    .parse(
      JSON.parse(
        await readFile(
          resolve(root, "node_modules/openclaw/dist/build-info.json"),
          "utf8",
        ),
      ),
    );
  assert.equal(info.commit, pin.commit);
  assert.equal(info.version, pin.version);
  assert.equal(pkg.devDependencies.openclaw, pin.version);
  assert.equal(pkg.devDependencies["@openclaw/codex"], pin.version);
  assert.equal(pkg.openclaw.build.openclawVersion, pin.version);
  assert.equal(pkg.openclaw.build.pluginSdkVersion, pin.version);
  assert.equal(pkg.openclaw.compat.minGatewayVersion, pin.version);
  assert.equal(
    pkg.openclaw.compat.pluginApi,
    `>=${pin.version} <=${pin.compatibleVersions.at(-1)}`,
  );
  assert.equal(
    pkg.peerDependencies.openclaw,
    pin.compatibleVersions.join(" || "),
  );
});
