import { managementOutputs } from "../contracts.js";
export interface RequestOptions {
  host: {
    request(method: string, params?: Record<string, unknown>): Promise<unknown>;
  };
  revision?: number;
  signal?: AbortSignal;
}
interface ConnectionOptions extends RequestOptions {
  path: { connectionId: string };
}
interface SetupOptions extends RequestOptions {
  path: { connectionId: string; setupId: string };
}
const request = async (
  options: RequestOptions,
  method: string,
  params: Record<string, unknown> = {},
) => {
  options.signal?.throwIfAborted();
  const result = await options.host.request(`connections.${method}`, params);
  options.signal?.throwIfAborted();
  return result;
};
const revision = (options: RequestOptions) => options.revision ?? 0;
export async function status(options: RequestOptions) {
  return managementOutputs.status.parse(await request(options, "status"));
}
export async function listConnections(
  options: RequestOptions & { query?: { limit: number; cursor?: string } },
) {
  return { data: managementOutputs.list.parse(await request(options, "list")) };
}
export async function listConnectors(
  options: RequestOptions & { query?: { limit: number; cursor?: string } },
) {
  return {
    data: managementOutputs.catalog.parse(await request(options, "catalog")),
  };
}
export async function listConnectionAgents(options: RequestOptions) {
  return {
    data: managementOutputs.agents.parse(await request(options, "agents")),
  };
}
export async function createConnection(
  options: RequestOptions & {
    body: { connectorId: string; name: string; grant: { mode: "all" } };
  },
) {
  return {
    data: managementOutputs.create.parse(
      await request(options, "create", options.body),
    ),
  };
}
export async function updateConnection(
  options: ConnectionOptions & {
    body: {
      name: string;
      grant: import("../contracts.js").ConnectorAgentGrant;
    };
  },
) {
  return {
    data: managementOutputs.update.parse(
      await request(options, "update", {
        ...options.body,
        ...options.path,
        revision: revision(options),
      }),
    ),
  };
}
export async function startConnectionSetup(
  options: ConnectionOptions & { body: { kind: "initial" | "reconnect" } },
) {
  return {
    data: managementOutputs.start.parse(
      await request(options, "start", {
        ...options.path,
        revision: revision(options),
      }),
    ),
  };
}
export async function getConnectionSetup(options: SetupOptions) {
  return {
    data: managementOutputs.setup.parse(
      await request(options, "setup", options.path),
    ),
  };
}
export async function cancelConnectionSetup(options: SetupOptions) {
  return {
    data: managementOutputs.cancel.parse(
      await request(options, "cancel", {
        ...options.path,
        revision: revision(options),
      }),
    ),
  };
}
export async function completeConnectionSetup(
  options: SetupOptions & { body: { ticket: string } },
) {
  return {
    data: managementOutputs.complete.parse(
      await request(options, "complete", { ...options.path, ...options.body }),
    ),
  };
}
export async function disconnectConnection(options: ConnectionOptions) {
  return {
    data: managementOutputs.disconnect.parse(
      await request(options, "disconnect", {
        ...options.path,
        revision: revision(options),
      }),
    ),
  };
}
export async function getConnectionUsage(options: RequestOptions) {
  return {
    data: managementOutputs.usage.parse(await request(options, "usage")),
  };
}
