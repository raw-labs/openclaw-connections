import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { createReadStream, createWriteStream } from "node:fs";
import {
  access,
  lstat,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  assertHostBuild,
  assertPinnedHost,
  readHostPin,
  root,
} from "./pinned-host.mjs";
const pin = await readHostPin();
const cache = resolve(root, ".local/openclaw-host");
const host = resolve(cache, pin.commit);
const archive = resolve(cache, `${pin.commit}.tar.gz`);
const marker = resolve(host, ".connections-qualified.json");
await mkdir(cache, { recursive: true });
async function run(command, args, cwd = host) {
  await new Promise((resolveRun, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: "inherit",
      env: {
        ...process.env,
        GIT_CEILING_DIRECTORIES: cache,
        GIT_COMMIT: pin.commit,
        OPENCLAW_BUILD_TIMESTAMP: pin.builtAt,
        npm_config_cache: resolve(cache, "npm-cache"),
      },
    });
    child.once("error", reject);
    child.once("exit", (code, signal) =>
      code === 0
        ? resolveRun()
        : reject(new Error(`${command} failed (${code ?? signal})`)),
    );
  });
}
let ready = false;
try {
  ready = (await readFile(marker, "utf8")) === JSON.stringify(pin);
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
if (!ready) {
  let present = false;
  try {
    await access(archive);
    present = true;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (!present) {
    const response = await fetch(
      `https://codeload.github.com/openclaw/openclaw/tar.gz/${pin.commit}`,
    );
    assert.ok(
      response.ok && response.body,
      `Source download failed: ${response.status}`,
    );
    try {
      await pipeline(
        Readable.fromWeb(response.body),
        createWriteStream(archive, { flags: "wx" }),
      );
    } catch (error) {
      await rm(archive, { force: true });
      throw error;
    }
  }
  const hash = createHash("sha256");
  for await (const bytes of createReadStream(archive)) hash.update(bytes);
  assert.equal(
    hash.digest("hex"),
    pin.archiveSha256,
    "Pinned source checksum mismatch; no source will be executed.",
  );
  await mkdir(host, { recursive: true });
  await run("tar", ["-xzf", archive, "--strip-components=1", "-C", host], root);
  const upstream = JSON.parse(
    await readFile(resolve(host, "package.json"), "utf8"),
  );
  assert.equal(upstream.version, pin.version);
  assert.ok(upstream.packageManager.startsWith(`pnpm@${pin.pnpmVersion}+`));
  await run("npm", [
    "exec",
    "--yes",
    `--package=pnpm@${pin.pnpmVersion}`,
    "--",
    "pnpm",
    "install",
    "--frozen-lockfile",
  ]);
  await run("npm", [
    "exec",
    "--yes",
    `--package=pnpm@${pin.pnpmVersion}`,
    "--",
    "pnpm",
    "build:package",
  ]);
  await assertHostBuild(host, pin);
  await writeFile(marker, JSON.stringify(pin));
}
await assertHostBuild(host, pin);
const link = resolve(root, "node_modules/openclaw");
let existing;
try {
  existing = await lstat(link);
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
assert.ok(
  !existing || existing.isSymbolicLink(),
  "Refusing to replace a non-symlink OpenClaw dependency.",
);
if (existing) await rm(link);
await symlink(host, link, "dir");
await assertPinnedHost();
process.stdout.write(`Prepared source host ${pin.version} at ${pin.commit}\n`);
