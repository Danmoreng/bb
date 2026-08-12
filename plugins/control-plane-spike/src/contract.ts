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

const projectContextProjectSchema = z
  .object({ id: z.string().min(1), name: z.string().min(1) })
  .strict();

export const projectContextSchema = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("ready"),
      configuredProject: projectContextProjectSchema,
      error: z.null(),
    })
    .strict(),
  z
    .object({
      status: z.literal("unconfigured"),
      configuredProject: z.null(),
      error: z.string().nullable(),
    })
    .strict(),
  z
    .object({
      status: z.literal("missing"),
      configuredProject: z.null(),
      error: z.string().min(1),
    })
    .strict(),
  z
    .object({
      status: z.literal("error"),
      configuredProject: z.null(),
      error: z.string().min(1),
    })
    .strict(),
]);

export const tasksCapabilitySchema = z
  .object({
    status: z.enum(["available", "unavailable", "incompatible"]),
    pluginId: z.literal("tasks"),
    version: z.string().nullable(),
    expectedMethods: z.array(z.string()),
    verifiedMethods: z.array(z.string()),
    reason: z.string(),
  })
  .strict();

const tasksOperationErrorSchema = z
  .object({
    code: z.string(),
    message: z.string(),
  })
  .strict();

export const tasksListProjectsInputSchema = z
  .object({
    folderId: z.string().nullable().optional(),
  })
  .strict();
const tasksStatusSchema = z.enum([
  "backlog",
  "todo",
  "in_progress",
  "in_review",
  "done",
  "canceled",
]);
const tasksPrioritySchema = z.enum(["urgent", "high", "medium", "low", "none"]);
export const tasksCreateTaskInputSchema = z
  .object({
    tasksProjectId: z.string().min(1),
    title: z.string().min(1),
    description: z.string().optional(),
    status: tasksStatusSchema.optional(),
    priority: tasksPrioritySchema.optional(),
    dueDate: z.string().nullable().optional(),
  })
  .strict();
export const tasksUpdateTaskInputSchema = z
  .object({
    taskId: z.string().min(1),
    title: z.string().min(1).optional(),
    description: z.string().optional(),
    status: tasksStatusSchema.optional(),
    priority: tasksPrioritySchema.optional(),
    dueDate: z.string().nullable().optional(),
  })
  .strict();
export const tasksCreateCommentInputSchema = z
  .object({
    taskId: z.string().min(1),
    body: z.string(),
    notify: z.boolean(),
  })
  .strict();
export const tasksDelegateInputSchema = z
  .object({
    taskId: z.string().min(1),
    presetId: z.string().min(1),
    extraInstructions: z.string().optional(),
  })
  .strict();
export const tasksAttachThreadInputSchema = z
  .object({
    taskId: z.string().min(1),
    threadId: z.string().startsWith("thr_"),
  })
  .strict();

const tasksResultSchema = z
  .object({
    ok: z.boolean(),
    error: tasksOperationErrorSchema.optional(),
    data: z.unknown().optional(),
  })
  .strict();

const threadEnvironmentSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("project-default") }).strict(),
  z
    .object({ type: z.literal("reuse"), environmentId: z.string().min(1) })
    .strict(),
]);
export const threadSpawnRootInputSchema = z
  .object({
    projectId: z.string().min(1),
    prompt: z.string().min(1),
    environment: threadEnvironmentSchema,
    title: z.string().min(1).optional(),
  })
  .strict();
export const threadSpawnChildInputSchema = threadSpawnRootInputSchema.extend({
  parentThreadId: z.string().min(1),
});
export const threadRefInputSchema = z
  .object({ threadId: z.string().min(1) })
  .strict();
export const threadPromptInputSchema = threadRefInputSchema.extend({
  prompt: z.string().min(1),
});
const threadResultSchema = z
  .object({
    ok: z.boolean(),
    error: tasksOperationErrorSchema.optional(),
    data: z.unknown().optional(),
  })
  .strict();
export const stewardStatusInputSchema = z
  .object({ projectId: z.string().min(1).nullable() })
  .strict();
export const stewardStatusSchema = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("uninitialized"),
      threadId: z.null(),
      error: z.string().nullable(),
    })
    .strict(),
  z
    .object({
      status: z.literal("ready"),
      threadId: z.string().min(1),
      error: z.null(),
    })
    .strict(),
  z
    .object({
      status: z.literal("missing"),
      threadId: z.string().min(1).nullable(),
      error: z.string().min(1),
    })
    .strict(),
  z
    .object({
      status: z.literal("error"),
      threadId: z.string().min(1).nullable(),
      error: z.string().min(1),
    })
    .strict(),
]);

export const controlPlaneSpikeRpcContract = defineRpcContract({
  projectContext: {
    input: z.object({}).strict(),
    output: projectContextSchema,
  },
  snapshot: {
    input: z.object({ projectId: z.string().min(1).nullable() }).strict(),
    output: spikeSnapshotSchema,
  },
  recordObservation: {
    input: projectScopedInputSchema,
    output: spikeSnapshotSchema,
  },
  tasksCapability: {
    input: z.object({}).strict(),
    output: tasksCapabilitySchema,
  },
  tasksListProjects: {
    input: tasksListProjectsInputSchema,
    output: tasksResultSchema,
  },
  tasksCreateTask: {
    input: tasksCreateTaskInputSchema,
    output: tasksResultSchema,
  },
  tasksUpdateTask: {
    input: tasksUpdateTaskInputSchema,
    output: tasksResultSchema,
  },
  tasksCreateComment: {
    input: tasksCreateCommentInputSchema,
    output: tasksResultSchema,
  },
  tasksDelegate: {
    input: tasksDelegateInputSchema,
    output: tasksResultSchema,
  },
  tasksAttachThread: {
    input: tasksAttachThreadInputSchema,
    output: tasksResultSchema,
  },
  threadSpawnRoot: {
    input: threadSpawnRootInputSchema,
    output: threadResultSchema,
  },
  threadSpawnChild: {
    input: threadSpawnChildInputSchema,
    output: threadResultSchema,
  },
  threadGet: {
    input: threadRefInputSchema,
    output: threadResultSchema,
  },
  threadSendNow: {
    input: threadPromptInputSchema,
    output: threadResultSchema,
  },
  threadSendNextTurn: {
    input: threadPromptInputSchema,
    output: threadResultSchema,
  },
  threadCheckpoint: {
    input: threadPromptInputSchema,
    output: threadResultSchema,
  },
  threadQueueList: {
    input: threadRefInputSchema,
    output: threadResultSchema,
  },
  threadStop: {
    input: threadRefInputSchema,
    output: threadResultSchema,
  },
  stewardStatus: {
    input: stewardStatusInputSchema,
    output: stewardStatusSchema,
  },
  stewardEnsure: {
    input: z.object({ projectId: z.string().min(1) }).strict(),
    output: stewardStatusSchema,
  },
});

export type ProjectContext = z.infer<typeof projectContextSchema>;
export type SpikeSnapshot = z.infer<typeof spikeSnapshotSchema>;
export type TasksCapability = z.infer<typeof tasksCapabilitySchema>;
