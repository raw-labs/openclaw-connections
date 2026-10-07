import { join } from "node:path";
import { Type } from "typebox";
import { defineToolPlugin } from "openclaw/plugin-sdk/tool-plugin";
import type {
  OpenClawPluginApi,
  OpenClawPluginToolContext,
} from "openclaw/plugin-sdk/plugin-entry";
import type { AgentToolResult } from "openclaw/plugin-sdk/tool-results";
import { z } from "zod";
import { configSchema, resolvedConfigSchema } from "./config.js";
import { managementInputs, managementOutputs } from "./contracts.js";
import { ConnectionError, failure } from "./errors.js";
import { ConnectionsService, type NativeContext } from "./service.js";
import { ConnectionStore } from "./store.js";
import { ComposioCatalog, packagedCatalog } from "./catalog.js";
import { ComposioHttp } from "./providers/composio/http.js";
import { createComposioProvider } from "./providers/composio/provider.js";

const holders = new WeakMap<
  OpenClawPluginApi,
  { service?: ConnectionsService; configured: boolean }
>();
const identity = Type.String({ minLength: 1, maxLength: 256 });
const searchParameters = Type.Object(
  {
    query: Type.Optional(Type.String({ maxLength: 500 })),
    connectionId: Type.Optional(identity),
    connectorId: Type.Optional(identity),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 25 })),
    cursor: Type.Optional(Type.String({ maxLength: 2000 })),
  },
  { additionalProperties: false },
);
const describeParameters = Type.Object(
  { connectionId: identity, actionId: identity },
  { additionalProperties: false },
);
const callParameters = Type.Union([
  Type.Object(
    {
      mode: Type.Literal("execute"),
      connectionId: identity,
      actionId: identity,
      generation: Type.Integer({ minimum: 1 }),
      version: identity,
      arguments: Type.Record(Type.String(), Type.Unknown()),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    { mode: Type.Literal("lookup"), toolCallId: identity },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      mode: Type.Literal("result"),
      invocationId: identity,
      cursor: Type.Optional(Type.String({ maxLength: 12 })),
    },
    { additionalProperties: false },
  ),
]);
function runtime(api: OpenClawPluginApi) {
  const service = holders.get(api)?.service;
  if (!service)
    throw new ConnectionError(
      "not_configured",
      "Configure the plugin's Composio apiKey through OpenClaw Settings, then restart the Gateway.",
    );
  return service;
}
function native(
  toolContext: OpenClawPluginToolContext,
  toolCallId: string,
  signal?: AbortSignal,
): NativeContext {
  if (!toolContext.agentId?.trim() || !toolCallId.trim())
    throw new ConnectionError(
      "native_context_unavailable",
      "A native agent and tool call are required.",
    );
  return {
    agentId: toolContext.agentId,
    toolCallId,
    ...(toolContext.sessionId ? { sessionId: toolContext.sessionId } : {}),
    ...(toolContext.sessionKey ? { sessionKey: toolContext.sessionKey } : {}),
    ...(signal ? { signal } : {}),
  };
}
async function toolResult(
  work: () => Promise<unknown>,
  maximum = 128 * 1024,
): Promise<AgentToolResult<unknown>> {
  try {
    const data = await work();
    const invocation = z
      .object({ invocation: z.object({ state: z.string() }) })
      .safeParse(data);
    const details = {
      ok: invocation.success
        ? invocation.data.invocation.state === "succeeded"
        : true,
      data,
    };
    const encoded = JSON.stringify(details);
    if (Buffer.byteLength(encoded) > maximum)
      throw new ConnectionError(
        "result_too_large",
        "The description exceeds the supported size. The operation was not executed.",
      );
    return { content: [{ type: "text", text: encoded }], details };
  } catch (error) {
    const safe =
      error instanceof z.ZodError
        ? {
            code: "invalid_arguments",
            message: "The connection arguments are invalid.",
          }
        : failure(error);
    const details = { ok: false, error: safe };
    return {
      content: [{ type: "text", text: JSON.stringify(details) }],
      details,
    };
  }
}
const plugin = defineToolPlugin({
  id: "openclaw-connections",
  name: "Connections",
  description: "Connect your services through your own Composio project.",
  configSchema,
  tools: (tool) => [
    tool({
      name: "connections_search",
      description:
        "Find operations on accounts available to this agent. Use exact connection and action IDs from these results.",
      parameters: searchParameters,
      factory: ({ api, config, toolContext }) =>
        !config.apiKey
          ? null
          : {
              name: "connections_search",
              label: "Search connections",
              description: "Find available account operations.",
              parameters: searchParameters,
              execute: (callId, args, signal) =>
                toolResult(
                  () =>
                    runtime(api).search(
                      args,
                      native(toolContext, callId, signal),
                    ),
                  64 * 1024,
                ),
            },
    }),
    tool({
      name: "connections_describe",
      description:
        "Describe an exact account operation before calling it. Provider schemas are advisory; preserve the returned account generation and action version.",
      parameters: describeParameters,
      factory: ({ api, config, toolContext }) =>
        !config.apiKey
          ? null
          : {
              name: "connections_describe",
              label: "Describe connection",
              description: "Describe an operation on an exact account.",
              parameters: describeParameters,
              execute: (callId, args, signal) =>
                toolResult(() =>
                  runtime(api).describe(
                    args,
                    native(toolContext, callId, signal),
                  ),
                ),
            },
    }),
    tool({
      name: "connections_call",
      description:
        "Execute a described operation, look up a prior native toolCallId in this session, or read a saved result. Execute can affect external systems. Never execute again to recover an unknown outcome or missing result.",
      parameters: callParameters,
      factory: ({ api, config, toolContext }) =>
        !config.apiKey
          ? null
          : {
              name: "connections_call",
              label: "Call connection",
              description: "Execute or read a saved account operation.",
              parameters: callParameters,
              execute: (callId, args, signal) =>
                toolResult(
                  () =>
                    runtime(api).call(
                      args,
                      native(toolContext, callId, signal),
                    ),
                  64 * 1024,
                ),
            },
    }),
  ],
});
const registerTools = plugin.register;
plugin.register = (api) => {
  const config = resolvedConfigSchema.parse(api.pluginConfig ?? {});
  const holder: { service?: ConnectionsService; configured: boolean } = {
    configured: Boolean(config.apiKey),
  };
  holders.set(api, holder);
  registerTools(api);
  api.registerService({
    id: "openclaw-connections",
    start() {
      if (!config.apiKey) return;
      const store = new ConnectionStore(
        join(
          api.runtime.state.resolveStateDir(),
          "connections",
          "connections.sqlite",
        ),
        config.userId,
      );
      holder.service = new ConnectionsService(
        store,
        createComposioProvider({ apiKey: config.apiKey }),
        new ComposioCatalog(
          packagedCatalog(),
          new ComposioHttp({
            apiKey: config.apiKey,
            maximumJsonBytes: 32 * 1024 * 1024,
          }),
        ),
        config.authConfigIds,
      );
    },
    async stop() {
      await holder.service?.close();
      delete holder.service;
    },
  });
  for (const method of Object.keys(managementInputs)) {
    const name = z
      .enum([
        "status",
        "list",
        "catalog",
        "agents",
        "create",
        "update",
        "start",
        "setup",
        "complete",
        "cancel",
        "disconnect",
        "usage",
      ])
      .parse(method);
    api.registerGatewayMethod(
      `connections.${name}`,
      async ({ params, client, respond }) => {
        const current = () => {
          if (
            !client ||
            client.invalidated ||
            client.connect.role !== "operator" ||
            !client.connect.scopes?.includes("operator.admin")
          )
            throw new ConnectionError(
              "access_denied",
              "Current OpenClaw administrator authority is required.",
            );
        };
        try {
          current();
          let result: unknown;
          if (name === "status" && !holder.configured) {
            managementInputs.status.parse(params);
            result = { configured: false, userId: null };
          } else {
            const actor =
              client?.authenticatedUserProfile?.profileId ??
              client?.authenticatedUserId ??
              client?.connect.device?.id ??
              client?.connId;
            if (!actor)
              throw new ConnectionError(
                "native_context_unavailable",
                "A native administrator identity or device is required.",
              );
            const configuredAgents =
              api.config.agents?.list?.map((agent) => agent.id) ?? [];
            const agents = configuredAgents.length
              ? configuredAgents
              : ["main"];
            result = await runtime(api).manage(
              name,
              params,
              actor,
              agents,
              current,
            );
          }
          respond(true, managementOutputs[name].parse(result));
        } catch (error) {
          const safe =
            error instanceof z.ZodError
              ? {
                  code: "invalid_arguments",
                  message: "The connection request or response is invalid.",
                }
              : failure(error);
          respond(false, undefined, {
            code: "INVALID_REQUEST",
            message: safe.message,
            details: { code: safe.code },
          });
        }
      },
      { scope: "operator.admin" },
    );
  }
};
export default plugin;
