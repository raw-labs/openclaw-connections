import { build } from "esbuild";
import { mkdir, readFile, writeFile, rm, copyFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { configSchema } from "../src/config.ts";

await rm("dist", { recursive: true, force: true });
await mkdir("dist/licenses", { recursive: true });
await mkdir(".local", { recursive: true });
await build({
  entryPoints: ["src/index.ts"],
  bundle: true,
  platform: "node",
  target: "node24",
  format: "esm",
  outfile: "dist/index.js",
  external: ["openclaw/*"],
  legalComments: "linked",
});
for (const [dependency, filename] of [
  ["zod", "LICENSE"],
  ["typebox", "license"],
]) {
  await copyFile(
    `node_modules/${dependency}/${filename}`,
    `dist/licenses/${dependency}.txt`,
  );
}
const packageInfo = JSON.parse(await readFile("package.json", "utf8"));
const manifest = {
  id: "openclaw-connections",
  name: "Connections",
  version: packageInfo.version,
  description: "Connect your services through your own Composio project.",
  skills: ["./skills"],
  activation: { onStartup: true },
  configSchema,
  configContracts: {
    secretInputs: {
      paths: [{ path: "apiKey", expected: "string", ownerKind: "capability" }],
    },
  },
  uiHints: {
    apiKey: {
      label: "Composio API key",
      sensitive: true,
      help: "Use a native secret reference. This key stays in the Gateway.",
    },
    userId: {
      label: "Composio user ID",
      help: "Optional. A stable installation identity is created when omitted.",
    },
    authConfigIds: {
      label: "Auth configuration IDs",
      help: "Optional map from service ID to an existing Composio auth config ID.",
    },
  },
};
await writeFile(
  "openclaw.plugin.json",
  `${JSON.stringify(manifest, null, 2)}\n`,
);
await promisify(execFile)(
  process.execPath,
  [
    "node_modules/openclaw/openclaw.mjs",
    "plugins",
    "build",
    "--root",
    process.cwd(),
  ],
  { maxBuffer: 4 * 1024 * 1024 },
);
const generated = JSON.parse(await readFile("openclaw.plugin.json", "utf8"));
if (
  !generated.controlUi?.entry ||
  !generated.contracts?.tools?.includes("connections_call")
)
  throw Error("Native plugin build did not produce UI and tool metadata.");
await writeFile(
  "openclaw.plugin.json",
  `${JSON.stringify(generated, null, 2)}\n`,
);
process.stdout.write(
  "Built native Connections plugin, tools and Control UI.\n",
);
