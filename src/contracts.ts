import { z } from "zod";

const id = z.string().trim().min(1).max(256);
export const grantSchema = z.discriminatedUnion("mode", [
  z.strictObject({ mode: z.literal("all") }),
  z.strictObject({
    mode: z.literal("selected"),
    agentIds: z.array(id).max(500),
  }),
]);
export type ConnectorAgentGrant = z.infer<typeof grantSchema>;
export const bindingSchema = z.strictObject({
  accountId: id,
  subjectId: id,
  toolkit: id,
  authConfigurationId: id,
});
const failureSchema = z.strictObject({ detail: z.string().max(4096) });
export const setupSchema = z.strictObject({
  id: z.uuid(),
  state: z.enum(["creating", "pending", "completed", "cancelled", "unknown"]),
  actor: id,
  ticketHash: z.string().regex(/^[a-f0-9]{64}$/),
  binding: bindingSchema.nullable(),
  url: z.string().nullable(),
  expiresAt: z.string(),
  failure: failureSchema.nullable(),
});
export const storedConnectionSchema = z.strictObject({
  id: z.uuid(),
  connectorId: id,
  name: z.string().trim().min(1).max(120),
  grant: grantSchema,
  generation: z.number().int().nonnegative(),
  revision: z.number().int().nonnegative(),
  state: z.enum([
    "connected",
    "not_connected",
    "needs_attention",
    "disconnected",
  ]),
  binding: bindingSchema.nullable(),
  setup: setupSchema.nullable(),
  failure: failureSchema.nullable(),
});
export type StoredConnection = z.infer<typeof storedConnectionSchema>;
export const connectionSchema = storedConnectionSchema
  .omit({ binding: true, setup: true })
  .extend({
    setup: setupSchema
      .pick({ id: true, state: true, failure: true, expiresAt: true })
      .nullable(),
  });
export type Connection = z.infer<typeof connectionSchema>;
export const connectorSchema = z.strictObject({
  id,
  toolkitSlug: id,
  name: z.string(),
  description: z.string(),
  category: z.string(),
  iconUrl: z.string(),
  auth: z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("managed") }),
    z.strictObject({ kind: z.literal("custom"), scheme: id }),
  ]),
});
export type Connector = z.infer<typeof connectorSchema>;
export const actionSchema = z.strictObject({
  id,
  connectorId: id,
  name: z.string(),
  description: z.string(),
  version: id.refine(
    (v) => v !== "latest",
    "An exact action version is required.",
  ),
  schemaDigest: z.string(),
  inputSchema: z.unknown(),
  outputSchema: z.unknown(),
});
export type Action = z.infer<typeof actionSchema>;
export const receiptSchema = z.strictObject({
  id: z.uuid(),
  connectionId: z.uuid(),
  generation: z.number().int(),
  agentId: id,
  session: id,
  toolCallId: id,
  requestHash: z.string(),
  actionId: id,
  version: id,
  state: z.enum(["dispatching", "succeeded", "rejected", "unknown"]),
  createdAt: z.string(),
  expiresAt: z.string(),
  completedAt: z.string().nullable(),
  failure: failureSchema.nullable(),
  result: z.string().nullable(),
});
export type Receipt = z.infer<typeof receiptSchema>;
const revision = z.number().int().nonnegative();
const connectionId = z.uuid();
export const managementInputs = {
  status: z.strictObject({}),
  list: z.strictObject({}),
  catalog: z.strictObject({}),
  agents: z.strictObject({}),
  create: z.strictObject({
    connectorId: id,
    name: z.string().trim().min(1).max(120),
    grant: grantSchema,
  }),
  update: z.strictObject({
    connectionId,
    revision,
    name: z.string().trim().min(1).max(120),
    grant: grantSchema,
  }),
  start: z.strictObject({ connectionId, revision }),
  setup: z.strictObject({ connectionId, setupId: z.uuid() }),
  complete: z.strictObject({ connectionId, setupId: z.uuid(), ticket: id }),
  cancel: z.strictObject({ connectionId, setupId: z.uuid(), revision }),
  disconnect: z.strictObject({ connectionId, revision }),
  usage: z.strictObject({}),
};
export type ManagementMethod = keyof typeof managementInputs;
export const managementOutputs = {
  status: z.strictObject({
    configured: z.boolean(),
    userId: z.string().nullable(),
  }),
  list: z.strictObject({
    items: z.array(connectionSchema),
    nextCursor: z.null(),
  }),
  catalog: z.strictObject({
    items: z.array(connectorSchema),
    nextCursor: z.null(),
  }),
  agents: z.strictObject({ agents: z.array(z.strictObject({ id })) }),
  create: connectionSchema,
  update: connectionSchema,
  start: z.strictObject({
    setup: connectionSchema.shape.setup,
    url: z.string().nullable(),
    ticket: id,
  }),
  setup: z.strictObject({
    setup: connectionSchema.shape.setup,
    url: z.string().nullable(),
  }),
  complete: connectionSchema,
  cancel: connectionSchema,
  disconnect: z.strictObject({ removed: z.boolean() }),
  usage: z.strictObject({
    calls: z.number(),
    succeeded: z.number(),
    rejected: z.number(),
    unknown: z.number(),
    retainedDays: z.number(),
  }),
};
export const searchInput = z.strictObject({
  query: z.string().max(500).optional(),
  connectionId: z.uuid().optional(),
  connectorId: id.optional(),
  limit: z.number().int().min(1).max(25).optional(),
  cursor: z.string().max(2000).optional(),
});
export const describeInput = z.strictObject({ connectionId, actionId: id });
export const callInput = z.discriminatedUnion("mode", [
  z.strictObject({
    mode: z.literal("execute"),
    connectionId,
    actionId: id,
    generation: z.number().int().positive(),
    version: id.refine((v) => v !== "latest"),
    arguments: z.record(z.string(), z.unknown()),
  }),
  z.strictObject({ mode: z.literal("lookup"), toolCallId: id }),
  z.strictObject({
    mode: z.literal("result"),
    invocationId: z.uuid(),
    cursor: z.string().regex(/^\d+$/).max(12).optional(),
  }),
]);
export function publicConnection(value: StoredConnection): Connection {
  const { binding: _binding, setup, ...item } = value;
  return {
    ...item,
    setup: setup
      ? {
          id: setup.id,
          state: setup.state,
          failure: setup.failure,
          expiresAt: setup.expiresAt,
        }
      : null,
  };
}
