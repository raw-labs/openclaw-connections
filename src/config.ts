import { Type } from "typebox";
import { z } from "zod";

export const configSchema = Type.Object(
  {
    apiKey: Type.Optional(
      Type.Union([
        Type.String({ minLength: 1 }),
        Type.Object(
          {
            source: Type.Union([
              Type.Literal("env"),
              Type.Literal("file"),
              Type.Literal("exec"),
            ]),
            provider: Type.String({ minLength: 1 }),
            id: Type.String({ minLength: 1 }),
          },
          { additionalProperties: false },
        ),
      ]),
    ),
    userId: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
    authConfigIds: Type.Optional(
      Type.Record(Type.String(), Type.String({ minLength: 1, maxLength: 256 })),
    ),
  },
  { additionalProperties: false },
);
// Native preparation retains the authored reference when its optional capability
// is unavailable. Accept that envelope without treating it as a credential.
export const runtimeConfigSchema = z
  .strictObject({
    apiKey: z
      .union([
        z.string().trim().min(1),
        z.strictObject({
          source: z.enum(["env", "file", "exec"]),
          provider: z.string().min(1),
          id: z.string().min(1),
        }),
      ])
      .optional(),
    userId: z.string().trim().min(1).max(256).optional(),
    authConfigIds: z
      .record(z.string(), z.string().trim().min(1).max(256))
      .optional(),
  })
  .refine(
    (value) => value.apiKey || (!value.userId && !value.authConfigIds),
    "Configure a Composio apiKey before other settings.",
  );
