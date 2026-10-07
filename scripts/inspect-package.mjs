import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile, mkdir } from "node:fs/promises";
import { promisify } from "node:util";
import { posix } from "node:path";
const execute = promisify(execFile);
const pkg = JSON.parse(await readFile("package.json", "utf8"));
const manifest = JSON.parse(await readFile("openclaw.plugin.json", "utf8"));
assert.equal(pkg.name, "@raw-labs/openclaw-connections");
assert.equal(manifest.id, "openclaw-connections");
assert.equal(manifest.version, pkg.version);
assert.equal(pkg.peerDependencies.openclaw, pkg.devDependencies.openclaw);
assert.equal(
  pkg.openclaw.compat.minGatewayVersion,
  pkg.devDependencies.openclaw,
);
assert.equal(pkg.openclaw.build.pluginSdkVersion, pkg.devDependencies.openclaw);
assert.equal(pkg.publishConfig.registry, "https://npm.pkg.github.com");
assert.notEqual(pkg.private, true);
await mkdir(".local", { recursive: true });
const packs = JSON.parse(
  (await execute("npm", ["pack", "--json", "--pack-destination", ".local"]))
    .stdout,
);
assert.equal(packs.length, 1);
const pack = packs[0];
for (const file of pack.files) {
  assert.match(
    file.path,
    /^(?:dist\/|assets\/|skills\/|package\.json$|openclaw\.plugin\.json$|README\.md$|AGENTS\.md$|RELEASING\.md$|LICENSE$|NOTICE$|THIRD_PARTY_NOTICES\.md$)/,
  );
  assert.doesNotMatch(
    file.path,
    /(?:^|\/)(?:node_modules|\.env|\.local|tests|src|state)(?:\/|$)/,
  );
}
for (const path of [
  "dist/index.js",
  "assets/catalog.json",
  "skills/connections/SKILL.md",
  "README.md",
  "AGENTS.md",
  "RELEASING.md",
  "LICENSE",
  "NOTICE",
  "THIRD_PARTY_NOTICES.md",
  "dist/licenses/zod.txt",
  "dist/licenses/typebox.txt",
]) {
  assert.ok(
    pack.files.some((file) => file.path === path),
    `Missing ${path}`,
  );
}
assert.ok(
  pack.files.some(
    (file) =>
      file.path.startsWith("dist/control-ui/") && file.path.endsWith(".js"),
  ),
);
const packagedPaths = new Set(pack.files.map((file) => file.path));
for (const path of [
  "README.md",
  "AGENTS.md",
  "RELEASING.md",
  "THIRD_PARTY_NOTICES.md",
]) {
  const markdown = await readFile(path, "utf8");
  for (const match of markdown.matchAll(/\[[^\]]*\]\(([^\s)]+)\)/g)) {
    const target = match[1];
    if (/^(?:[a-z]+:|#|\/)/i.test(target)) continue;
    const relative = decodeURIComponent(target.split("#")[0]);
    assert.ok(
      packagedPaths.has(posix.join(posix.dirname(path), relative)),
      `Broken packaged link in ${path}: ${target}`,
    );
  }
}
process.stdout.write(
  `Verified ${pack.filename}: ${pack.files.length} files, ${pack.shasum}\n`,
);
