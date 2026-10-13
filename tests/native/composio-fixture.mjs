// Runs only in isolated test Gateways. Every Composio request is intercepted.
import assert from "node:assert/strict";
import { appendFile } from "node:fs/promises";
const originalFetch = globalThis.fetch;
let setups = 0;
globalThis.fetch = async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (url.hostname !== "backend.composio.dev")
    return originalFetch(input, init);
  if (process.env.CONNECTIONS_TEST_REQUESTS)
    await appendFile(
      process.env.CONNECTIONS_TEST_REQUESTS,
      `${init?.method ?? "GET"} ${url.pathname}\n`,
    );
  assert.equal(
    new Headers(init?.headers).get("x-api-key"),
    "synthetic-never-sent-project-key",
  );
  const body = typeof init?.body === "string" ? JSON.parse(init.body) : {};
  const path = url.pathname;
  if (
    path === "/api/v3.1/connected_accounts/link" &&
    body.auth_config_id === "ac_invalid"
  )
    return Response.json(
      { error: { message: "Invalid synthetic project credential" } },
      { status: 401 },
    );
  if (path === "/api/v3.1/connected_accounts/link") {
    assert.equal(body.auth_config_id, "ac_native");
    return Response.json({
      connected_account_id: ++setups === 1 ? "ca_native" : "ca_cancel",
      redirect_url: "https://connect.composio.dev/synthetic",
      expires_at: new Date(Date.now() + 3600000).toISOString(),
    });
  }
  if (
    path === "/api/v3.1/connected_accounts/ca_native" ||
    path === "/api/v3.1/connected_accounts/ca_cancel"
  ) {
    if (init?.method === "DELETE") {
      assert.equal(url.searchParams.get("revoke_on_delete"), "true");
      return Response.json({
        success: true,
        revoke_job_id: "synthetic-revoke-job",
      });
    }
    return Response.json({
      id: path.split("/").at(-1),
      user_id: "native-test-owner",
      toolkit: { slug: "github" },
      auth_config: { id: "ac_native" },
      status: "ACTIVE",
    });
  }
  if (path === "/api/v3.1/tools") {
    return Response.json({
      items: [
        {
          slug: "GITHUB_CREATE_ISSUE",
          toolkit: { slug: "github" },
          name: "Create issue",
          description: "Synthetic test action",
          version: "20260910_00",
          input_parameters: { type: "object" },
          output_parameters: { type: "object" },
        },
      ],
      next_cursor: null,
    });
  }
  if (path === "/api/v3.1/tools/execute/GITHUB_CREATE_ISSUE") {
    assert.equal(body.connected_account_id, "ca_native");
    assert.equal(body.user_id, "native-test-owner");
    assert.equal(body.version, "20260910_00");
    assert.ok(process.env.CONNECTIONS_TEST_EXECUTIONS);
    await appendFile(process.env.CONNECTIONS_TEST_EXECUTIONS, "executed\n");
    return Response.json({
      successful: true,
      data: { message: "synthetic native result" },
    });
  }
  throw Error(`Unexpected synthetic Composio endpoint: ${path}`);
};
