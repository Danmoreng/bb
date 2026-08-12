import { defineRpcContract } from "@bb/plugin-sdk";
import { z } from "zod";

export const controlPlaneRpcContract = defineRpcContract({
  ping: {
    input: z.object({}).strict(),
    output: z.object({ ok: z.literal(true), version: z.string() }).strict(),
  },
  diagnostics: {
    input: z.object({ projectId: z.string().min(1).nullable() }).strict(),
    output: z
      .object({
        pluginVersion: z.string(),
        domainPackage: z.string(),
        projectId: z.string().nullable(),
        status: z.enum(["ready", "no-project"]),
        message: z.string(),
      })
      .strict(),
  },
});
