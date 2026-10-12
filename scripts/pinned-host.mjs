import assert from "node:assert/strict";
import { readFile, realpath } from "node:fs/promises";
import { resolve } from "node:path";
export const root = resolve(import.meta.dirname, "..");
export async function readHostPin() {
  const pin = JSON.parse(
    await readFile(resolve(root, "openclaw-host.json"), "utf8"),
  );
  assert.match(pin.version, /^\d{4}\.\d+\.\d+$/);
  assert.match(pin.commit, /^[a-f0-9]{40}$/);
  assert.match(pin.archiveSha256, /^[a-f0-9]{64}$/);
  assert.match(pin.pnpmVersion, /^\d+\.\d+\.\d+$/);
  assert.ok(Number.isFinite(Date.parse(pin.builtAt)));
  assert.ok(
    Array.isArray(pin.compatibleVersions) &&
      pin.compatibleVersions.includes(pin.version) &&
      pin.compatibleVersions.every(
        (version) =>
          typeof version === "string" && /^\d{4}\.\d+\.\d+$/.test(version),
      ),
  );
  return pin;
}
export async function assertPinnedHost() {
  const pin = await readHostPin();
  const host = await realpath(resolve(root, "node_modules/openclaw"));
  assert.equal(
    host,
    await realpath(resolve(root, ".local/openclaw-host", pin.commit)),
    "Run pnpm prepare:host: the published package is not the qualified source build.",
  );
  await assertHostBuild(host, pin);
  return { pin, host };
}

export async function assertHostBuild(host, pin) {
  const pkg = JSON.parse(await readFile(resolve(host, "package.json"), "utf8"));
  const info = JSON.parse(
    await readFile(resolve(host, "dist/build-info.json"), "utf8"),
  );
  assert.equal(pkg.version, pin.version);
  assert.equal(info.version, pin.version);
  assert.equal(info.commit, pin.commit);
}
