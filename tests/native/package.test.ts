import assert from "node:assert/strict";
import { test } from "node:test";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { z } from "zod";
import { GatewayClient } from "openclaw/plugin-sdk/gateway-runtime";

const execute = promisify(execFile);
const root = resolve(import.meta.dirname, "../..");
const runtime = join(root, "node_modules/openclaw/openclaw.mjs");
async function freePort() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return address.port;
}
await test(
  "packed plugin installs in vanilla OpenClaw, loads native UI/RPC/tools, survives restart and disablement",
  { timeout: 180_000 },
  async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "openclaw-connections-native-"),
    );
    const state = join(directory, "state"),
      home = join(directory, "home"),
      configPath = join(directory, "openclaw.json");
    const port = await freePort();
    const token = "synthetic-native-gateway-test-token";
    const env = {
      ...process.env,
      HOME: home,
      OPENCLAW_STATE_DIR: state,
      OPENCLAW_CONFIG_PATH: configPath,
      COMPOSIO_API_KEY: "synthetic-never-sent-project-key",
    };
    await mkdir(home);
    await mkdir(state);
    let gateway: ChildProcess | undefined;
    let diagnostics = "";
    const native = (...args: string[]) =>
      execute(process.execPath, [runtime, ...args], {
        cwd: directory,
        env,
        maxBuffer: 4 * 1024 * 1024,
      });
    async function stop() {
      if (!gateway || gateway.exitCode !== null) return;
      const ended = once(gateway, "exit");
      gateway.kill("SIGTERM");
      await ended;
    }
    async function start() {
      diagnostics = "";
      gateway = spawn(process.execPath, [runtime, "gateway", "run"], {
        cwd: directory,
        env,
        stdio: ["ignore", "pipe", "pipe"],
      });
      for (const stream of [gateway.stdout, gateway.stderr])
        stream?.setEncoding("utf8").on("data", (chunk: string) => {
          diagnostics = (diagnostics + chunk).slice(-16_000);
        });
      for (let i = 0; i < 160; i++) {
        if (gateway.exitCode !== null)
          throw Error(`Gateway exited: ${diagnostics}`);
        try {
          if (
            (
              await fetch(`http://127.0.0.1:${port}/readyz`, {
                signal: AbortSignal.timeout(500),
              })
            ).ok
          )
            return;
        } catch {
          /* Wait for the isolated listener. */
        }
        await delay(250);
      }
      throw Error(`Gateway readiness timed out: ${diagnostics}`);
    }
    const config = {
      gateway: {
        mode: "local",
        bind: "loopback",
        port,
        auth: { mode: "token", token },
        controlUi: { experimental: { customPlugins: true } },
      },
    };
    try {
      await writeFile(configPath, JSON.stringify(config));
      const packed = z
        .array(z.object({ filename: z.string() }))
        .parse(
          JSON.parse(
            (
              await execute(
                "npm",
                ["pack", "--json", "--pack-destination", directory],
                { cwd: root, env },
              )
            ).stdout,
          ),
        );
      const archive = packed[0];
      assert.ok(archive);
      const path = join(directory, archive.filename);
      const listing = (await execute("tar", ["-tzf", path])).stdout;
      assert.match(listing, /package\/dist\/control-ui\//);
      assert.match(listing, /package\/assets\/catalog.json/);
      assert.doesNotMatch(listing, /node_modules\/openclaw|state.sqlite|\.env/);
      await native(
        "plugins",
        "install",
        `npm-pack:${path}`,
        "--force",
        "--accept-capabilities",
      );
      const installed = z
        .object({
          plugins: z
            .object({ entries: z.record(z.string(), z.unknown()) })
            .passthrough(),
        })
        .passthrough()
        .parse(JSON.parse(await readFile(configPath, "utf8")));
      await writeFile(
        configPath,
        JSON.stringify({
          ...installed,
          gateway: config.gateway,
          plugins: {
            ...installed.plugins,
            entries: {
              ...installed.plugins.entries,
              "openclaw-connections": {
                enabled: true,
                config: {
                  apiKey: {
                    source: "env",
                    provider: "default",
                    id: "COMPOSIO_API_KEY",
                  },
                },
              },
            },
          },
        }),
      );
      const inspected = await native(
        "plugins",
        "inspect",
        "openclaw-connections",
        "--runtime",
        "--json",
      );
      assert.match(inspected.stdout, /connections_search/);
      assert.match(inspected.stdout, /connections_call/);
      assert.doesNotMatch(inspected.stdout, /synthetic-never-sent-project-key/);
      await start();
      const status = await native(
        "gateway",
        "call",
        "connections.status",
        "--url",
        `ws://127.0.0.1:${port}`,
        "--token",
        token,
        "--json",
      );
      assert.match(status.stdout, /"configured": true/);
      assert.doesNotMatch(status.stdout, /synthetic-never-sent-project-key/);
      let admitted: () => void = () => {};
      let rejected: (error: Error) => void = () => {};
      const hello = new Promise<void>((resolve, reject) => {
        admitted = resolve;
        rejected = reject;
      });
      const limited = new GatewayClient({
        url: `ws://127.0.0.1:${port}`,
        token,
        clientName: "cli",
        mode: "cli",
        role: "operator",
        scopes: ["operator.read"],
        deviceIdentity: null,
        env,
        onHelloOk: admitted,
        onConnectError: rejected,
      });
      try {
        limited.start();
        await Promise.race([
          hello,
          delay(10_000).then(() => {
            throw Error("Limited-client handshake timed out.");
          }),
        ]);
        await assert.rejects(
          limited.request("connections.status", {}),
          /scope|admin/i,
        );
      } finally {
        limited.stop();
      }
      const search = await fetch(`http://127.0.0.1:${port}/tools/invoke`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          tool: "connections_search",
          args: {},
          agentId: "main",
          idempotencyKey: "native-empty-search",
        }),
        signal: AbortSignal.timeout(15_000),
      });
      const result = await search.text();
      assert.equal(search.status, 200, result);
      assert.match(result, /no_usable_connections/);
      assert.doesNotMatch(result, /synthetic-never-sent-project-key/);
      await stop();
      await start();
      const restart = await native(
        "gateway",
        "call",
        "connections.status",
        "--url",
        `ws://127.0.0.1:${port}`,
        "--token",
        token,
        "--json",
      );
      const first = z
        .object({ userId: z.string() })
        .passthrough()
        .parse(JSON.parse(status.stdout));
      const second = z
        .object({ userId: z.string() })
        .passthrough()
        .parse(JSON.parse(restart.stdout));
      assert.equal(first.userId, second.userId);
      await stop();
      await native("plugins", "disable", "openclaw-connections");
      await start();
      const disabled = await fetch(`http://127.0.0.1:${port}/tools/invoke`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          tool: "connections_search",
          args: {},
          agentId: "main",
          idempotencyKey: "native-disabled-search",
        }),
      });
      assert.equal(disabled.status, 404);
    } finally {
      await stop();
      await rm(directory, { recursive: true, force: true });
    }
  },
);
