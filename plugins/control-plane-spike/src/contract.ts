import { defineRpcContract } from "@bb/plugin-sdk";
import { z } from "zod";

export const spikeSnapshotSchema = z
  .object({
    projectId: z.string().nullable(),
    observationCount: z.number().int().nonnegative(),
    lifecycleEvents: z.array(z.string()),
    revision: z.number().int().nonnegative(),
    error: z.string().nullable(),
  })
  .strict();

export const recordObservationInputSchema = z
  .object({
    message: z.string().min(1).max(500),
  })
  .strict();

const projectScopedInputSchema = z
  .object({
    projectId: z.string().min(1),
    message: z.string().min(1).max(500),
  })
  .strict();

export const controlPlaneSpikeRpcContract = defineRpcContract({
  snapshot: {
    input: z.object({ projectId: z.string().min(1).nullable() }).strict(),
    output: spikeSnapshotSchema,
  },
  recordObservation: {
    input: projectScopedInputSchema,
    output: spikeSnapshotSchema,
  },
});

export type SpikeSnapshot = z.infer<typeof spikeSnapshotSchema>;
