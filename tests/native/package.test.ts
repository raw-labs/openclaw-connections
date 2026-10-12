import assert from "node:assert/strict";
import { test } from "node:test";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { z } from "zod";
import { chromium } from "playwright";
import { managementOutputs } from "../../src/contracts.js";
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
  "packed plugin installs in the qualified source OpenClaw, loads native UI/RPC/tools, survives restart and disablement",
  { timeout: 600_000 },
  async (context) => {
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
      CONNECTIONS_TEST_EXECUTIONS: join(directory, "executions.log"),
      CONNECTIONS_TEST_REQUESTS: join(directory, "provider-requests.log"),
    };
    await mkdir(home);
    await mkdir(state);
    let gateway: ChildProcess | undefined;
    let packedDirectory: string | undefined;
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
      gateway = spawn(
        process.execPath,
        [
          "--import",
          join(root, "tests/native/composio-fixture.mjs"),
          runtime,
          "gateway",
          "run",
        ],
        {
          cwd: directory,
          env,
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      for (const stream of [gateway.stdout, gateway.stderr])
        stream?.setEncoding("utf8").on("data", (chunk: string) => {
          diagnostics = (diagnostics + chunk).slice(-16_000);
        });
      // Cold hosted runners need time to load the complete native plugin runtime.
      const readinessDeadline = Date.now() + 120_000;
      while (Date.now() < readinessDeadline) {
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
      await mkdir(join(root, ".local"), { recursive: true });
      packedDirectory = await mkdtemp(join(root, ".local/native-packed-"));
      await execute("tar", ["-xzf", path, "-C", packedDirectory]);
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
      const missingFile = join(directory, "empty-secrets.json");
      await writeFile(missingFile, "{}", { mode: 0o600 });
      const states = [
        { label: "omitted", pluginConfig: {}, secrets: {} },
        {
          label: "env reference not found",
          pluginConfig: {
            apiKey: {
              source: "env",
              provider: "default",
              id: "CONNECTIONS_NATIVE_MISSING_KEY",
            },
            userId: "native-test-owner",
            authConfigIds: { github: "ac_native" },
          },
          secrets: {},
        },
        {
          label: "file reference not found",
          pluginConfig: {
            apiKey: { source: "file", provider: "fixture", id: "/missing" },
          },
          secrets: {
            providers: {
              fixture: { source: "file", path: missingFile, mode: "json" },
            },
          },
        },
        {
          label: "exec provider failed",
          pluginConfig: {
            apiKey: { source: "exec", provider: "fixture", id: "missing" },
          },
          secrets: {
            providers: {
              fixture: {
                source: "exec",
                command: process.execPath,
                args: ["-e", "process.exit(1)"],
              },
            },
          },
        },
        {
          label: "env provider policy denied",
          startupRejected: true,
          pluginConfig: {
            apiKey: {
              source: "env",
              provider: "fixture",
              id: "COMPOSIO_API_KEY",
            },
          },
          secrets: {
            providers: {
              fixture: { source: "env", allowlist: ["ANOTHER_ALLOWED_KEY"] },
            },
          },
        },
      ];
      assert.equal(process.env.CONNECTIONS_NATIVE_MISSING_KEY, undefined);
      for (const scenario of states) {
        context.diagnostic(`Checking ${scenario.label}`);
        await writeFile(
          configPath,
          JSON.stringify({
            ...installed,
            gateway: config.gateway,
            secrets: scenario.secrets,
            plugins: {
              ...installed.plugins,
              entries: {
                ...installed.plugins.entries,
                "openclaw-connections": {
                  enabled: true,
                  config: scenario.pluginConfig,
                },
              },
            },
          }),
        );
        if ("startupRejected" in scenario) {
          // OpenClaw deliberately rejects non-retryable provider-policy failures
          // before plugin registration. The plugin must not weaken that policy.
          await assert.rejects(start(), /required secrets are unavailable/);
          await assert.rejects(access(join(state, "connections")));
          await assert.rejects(access(env.CONNECTIONS_TEST_REQUESTS));
          assert.doesNotMatch(diagnostics, /synthetic-never-sent-project-key/);
          await stop();
          continue;
        }
        try {
          await start();
        } catch (error) {
          throw new Error(`Secret scenario failed: ${scenario.label}`, {
            cause: error,
          });
        }
        let ready: () => void = () => {};
        let reject: (error: Error) => void = () => {};
        const connected = new Promise<void>((resolve, failed) => {
          ready = resolve;
          reject = failed;
        });
        const client = new GatewayClient({
          url: `ws://127.0.0.1:${port}`,
          token,
          clientName: "cli",
          mode: "cli",
          role: "operator",
          scopes: ["operator.admin"],
          deviceIdentity: null,
          env,
          onHelloOk: ready,
          onConnectError: reject,
        });
        try {
          client.start();
          await connected;
          if (scenario.label === "omitted")
            assert.deepEqual(await client.request("connections.status", {}), {
              configured: false,
              userId: null,
            });
          else
            await assert.rejects(
              client.request("connections.status", {}),
              (error: unknown) => {
                const diagnostic = z
                  .object({
                    message: z.string(),
                    details: z.object({
                      code: z.literal("SECRET_SURFACE_UNAVAILABLE"),
                    }),
                  })
                  .parse(error);
                assert.match(
                  diagnostic.message,
                  /capability:.*apiKey.*unavailable/,
                );
                assert.doesNotMatch(
                  diagnostic.message,
                  /synthetic-never-sent|CONNECTIONS_NATIVE_MISSING_KEY/,
                );
                return true;
              },
            );
          await assert.rejects(
            client.request("connections.list", {}),
            scenario.label === "omitted"
              ? /Configure the plugin/
              : /unavailable/,
          );
          const catalog = z
            .object({
              plugins: z.array(
                z.object({ pluginId: z.string(), entryUrl: z.string() }),
              ),
            })
            .parse(await client.request("plugins.controlUi.list", {}));
          const ui = catalog.plugins.find(
            (item) => item.pluginId === "openclaw-connections",
          );
          assert.ok(ui, scenario.label);
          const browser = await chromium.launch();
          try {
            const page = await browser.newPage({
              extraHTTPHeaders: { authorization: `Bearer ${token}` },
            });
            await page.exposeFunction(
              "nativeRequest",
              (method: string, params: Record<string, unknown>) =>
                client.request(method, params),
            );
            await page.goto(`http://127.0.0.1:${port}/`);
            await page.evaluate(
              `globalThis.connectionsTestEntry = ${JSON.stringify(ui.entryUrl)}`,
            );
            await page.evaluate(
              await readFile(
                join(root, "tests/native/browser-fixture.mjs"),
                "utf8",
              ),
            );
            await page
              .getByText(
                scenario.label === "omitted"
                  ? "Configure Composio"
                  : /Secret owner capability:.*unavailable/,
              )
              .waitFor();
            assert.equal(
              await page
                .getByRole("button", { name: "Add connection", exact: true })
                .isVisible(),
              false,
            );
            assert.doesNotMatch(
              await page.locator("body").innerText(),
              /synthetic-never-sent/,
            );
          } finally {
            await browser.close();
          }
          for (const tool of [
            "connections_search",
            "connections_describe",
            "connections_call",
          ]) {
            const result = await fetch(
              `http://127.0.0.1:${port}/tools/invoke`,
              {
                method: "POST",
                headers: {
                  "content-type": "application/json",
                  authorization: `Bearer ${token}`,
                },
                body: JSON.stringify({ tool, args: {}, agentId: "main" }),
              },
            );
            assert.equal(
              result.status,
              404,
              `${scenario.label}: ${await result.text()}`,
            );
          }
          assert.doesNotMatch(
            diagnostics,
            /openclaw-connections failed during register|synthetic-never-sent-project-key/,
          );
          await assert.rejects(access(join(state, "connections")));
          await assert.rejects(access(env.CONNECTIONS_TEST_REQUESTS));
        } finally {
          client.stop();
          await stop();
        }
      }
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
                  userId: "native-test-owner",
                  authConfigIds: { github: "ac_native", slack: "ac_invalid" },
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
      let adminReady: () => void = () => {};
      let adminRejected: (error: Error) => void = () => {};
      const adminHello = new Promise<void>((resolve, reject) => {
        adminReady = resolve;
        adminRejected = reject;
      });
      const admin = new GatewayClient({
        url: `ws://127.0.0.1:${port}`,
        token,
        clientName: "cli",
        mode: "cli",
        role: "operator",
        scopes: ["operator.admin"],
        deviceIdentity: null,
        env,
        onHelloOk: adminReady,
        onConnectError: adminRejected,
      });
      admin.start();
      const rpc = (
        method: string,
        params: Record<string, unknown> = {},
      ): Promise<unknown> => admin.request(method, params);
      try {
        await adminHello;
        const invalid = managementOutputs.create.parse(
          await rpc("connections.create", {
            connectorId: "slack",
            name: "Rejected provider credential",
            grant: { mode: "all" },
          }),
        );
        await assert.rejects(
          rpc("connections.start", {
            connectionId: invalid.id,
            revision: invalid.revision,
          }),
          /Invalid synthetic project credential/,
        );
        const failed = managementOutputs.list
          .parse(await rpc("connections.list"))
          .items.find((item) => item.id === invalid.id);
        assert.ok(failed);
        assert.equal(failed.state, "needs_attention");
        assert.equal(failed.setup?.state, "cancelled");
        assert.match(
          failed.failure?.detail ?? "",
          /Invalid synthetic project credential/,
        );
        await rpc("connections.disconnect", {
          connectionId: failed.id,
          revision: failed.revision,
        });
        const created = managementOutputs.create.parse(
          await rpc("connections.create", {
            connectorId: "github",
            name: "Native test account",
            grant: { mode: "all" },
          }),
        );
        const setup = managementOutputs.start.parse(
          await rpc("connections.start", {
            connectionId: created.id,
            revision: created.revision,
          }),
        );
        assert.ok(setup.setup);
        const beforeConsent = await fetch(
          `http://127.0.0.1:${port}/tools/invoke`,
          {
            method: "POST",
            headers: {
              "content-type": "application/json",
              authorization: `Bearer ${token}`,
            },
            body: JSON.stringify({
              tool: "connections_search",
              args: {},
              agentId: "main",
            }),
          },
        );
        assert.equal(beforeConsent.status, 200);
        assert.match(await beforeConsent.text(), /no_usable_connections/);
        const beforeWrongTicket = await readFile(
          env.CONNECTIONS_TEST_REQUESTS,
          "utf8",
        );
        await assert.rejects(
          rpc("connections.complete", {
            connectionId: created.id,
            setupId: setup.setup.id,
            ticket: "wrong-browser-ticket",
          }),
          /browser that started/,
        );
        assert.equal(
          await readFile(env.CONNECTIONS_TEST_REQUESTS, "utf8"),
          beforeWrongTicket,
        );
        const connected = managementOutputs.complete.parse(
          await rpc("connections.complete", {
            connectionId: created.id,
            setupId: setup.setup.id,
            ticket: setup.ticket,
          }),
        );
        const catalog = z
          .object({
            plugins: z.array(
              z.object({ pluginId: z.string(), entryUrl: z.string() }),
            ),
          })
          .parse(await rpc("plugins.controlUi.list"));
        const ui = catalog.plugins.find(
          (item) => item.pluginId === "openclaw-connections",
        );
        assert.ok(ui, JSON.stringify(catalog));
        const browser = await chromium.launch();
        try {
          const page = await browser.newPage({
            extraHTTPHeaders: { authorization: `Bearer ${token}` },
          });
          await page.exposeFunction("nativeRequest", rpc);
          await page.goto(`http://127.0.0.1:${port}/`);
          // Load the actual installed, authenticated native asset in Chromium. The
          // small host implements the public SDK boundary; native RPC remains real.
          await page.evaluate(
            `globalThis.connectionsTestEntry = ${JSON.stringify(ui.entryUrl)}`,
          );
          await page.evaluate(
            await readFile(
              join(root, "tests/native/browser-fixture.mjs"),
              "utf8",
            ),
          );
          await page
            .getByText("Native test account", { exact: true })
            .waitFor();
          await page
            .getByRole("button", { name: "Add connection", exact: true })
            .click();
          await page.getByText("GitHub", { exact: true }).first().waitFor();
          await page.setViewportSize({ width: 390, height: 844 });
          assert.ok(
            await page.getByText("GitHub", { exact: true }).first().isVisible(),
          );
          assert.equal(
            await page.evaluate(
              () => document.documentElement.scrollWidth > innerWidth,
            ),
            false,
          );
        } finally {
          await browser.close();
        }
        // A single process owns SQLite: stop the Gateway before the SDK fixture
        // opens the retained database, then restart for the retained-result checks.
        await stop();
        const bridged = await execute(
          process.execPath,
          [
            "--import",
            join(root, "tests/native/composio-fixture.mjs"),
            join(root, "tests/native/codex-bridge.mjs"),
            join(packedDirectory, "package/dist/index.js"),
            connected.id,
            String(connected.generation),
          ],
          { cwd: root, env, maxBuffer: 4 * 1024 * 1024 },
        );
        assert.match(bridged.stdout, /All three tools passed/);
        assert.equal(
          await readFile(env.CONNECTIONS_TEST_EXECUTIONS, "utf8"),
          "executed\n",
        );
      } finally {
        admin.stop();
      }
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
      const restored = managementOutputs.list.parse(
        JSON.parse(
          (
            await native(
              "gateway",
              "call",
              "connections.list",
              "--url",
              `ws://127.0.0.1:${port}`,
              "--token",
              token,
              "--json",
            )
          ).stdout,
        ),
      );
      const retained = restored.items[0];
      assert.ok(retained);
      assert.equal(retained.state, "connected");
      assert.deepEqual(retained.grant, { mode: "all" });
      const savedResult = await fetch(`http://127.0.0.1:${port}/tools/invoke`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          tool: "connections_call",
          args: {
            mode: "lookup",
            toolCallId: "codex-call",
          },
          agentId: "main",
          sessionKey: "agent:main:connections-test",
          idempotencyKey: "after-restart-lookup",
        }),
      });
      assert.equal(savedResult.status, 200);
      assert.match(await savedResult.text(), /synthetic native result/);
      await native(
        "gateway",
        "call",
        "connections.update",
        "--params",
        JSON.stringify({
          connectionId: retained.id,
          revision: retained.revision,
          name: retained.name,
          grant: { mode: "selected", agentIds: [] },
        }),
        "--url",
        `ws://127.0.0.1:${port}`,
        "--token",
        token,
        "--json",
      );
      const revokedResult = await fetch(
        `http://127.0.0.1:${port}/tools/invoke`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({
            tool: "connections_call",
            args: {
              mode: "lookup",
              toolCallId: "codex-call",
            },
            agentId: "main",
            sessionKey: "agent:main:connections-test",
            idempotencyKey: "revoked-lookup",
          }),
        },
      );
      assert.match(await revokedResult.text(), /access_denied/);
      assert.equal(
        await readFile(env.CONNECTIONS_TEST_EXECUTIONS, "utf8"),
        "executed\n",
      );

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
    } catch (error) {
      context.diagnostic(
        diagnostics
          .split("\n")
          .filter(
            (line) =>
              line.includes("plugin service failed") ||
              line.includes("connections.status"),
          )
          .join("\n"),
      );
      throw error;
    } finally {
      await stop();
      if (packedDirectory)
        await rm(packedDirectory, { recursive: true, force: true });
      await rm(directory, { recursive: true, force: true });
    }
  },
);
