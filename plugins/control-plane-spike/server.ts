import type { BbPluginApi } from "@bb/plugin-sdk";
import { z } from "zod";
import {
  controlPlaneSpikeRpcContract,
  recordObservationInputSchema,
  type SpikeSnapshot,
  stewardStatusSchema,
} from "./src/contract.js";
import {
  createTasksAdapter,
  createTasksRpcGateway,
  tasksAdapterSchemas,
  TasksDomainError,
  type TasksScopeGuard,
} from "./src/tasks-adapter.js";
import {
  createThreadSdkGateway,
  SdkThreadHost,
  type GatewaySpawnInput,
} from "./src/thread-adapter.js";

const TOOL_NAME = "cp_spike_record";
const REALTIME_CHANNEL = "control-plane-spike-changed";
const CONTEXT_REALTIME_CHANNEL = "control-plane-spike-context-changed";
const MAX_EVENTS = 50;
type StewardStatus = z.infer<typeof stewardStatusSchema>;

const stewardThreadSchema = z
  .object({
    id: z.string().min(1),
    projectId: z.string().min(1),
    originPluginId: z.literal("control-plane-spike"),
  })
  .passthrough();
const lifecycleEventRowSchema = z.object({ event_name: z.string() });
const countRowSchema = z.object({ count: z.number() });

function waitForAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const finish = () => {
      signal.removeEventListener("abort", finish);
      resolve();
    };
    signal.addEventListener("abort", finish, { once: true });
  });
}

function publishChanged(
  bb: BbPluginApi,
  projectId: string | null,
  revision: number,
) {
  bb.realtime.publish(REALTIME_CHANNEL, { projectId, revision });
}

const errorShapeSchema = z
  .object({
    code: z.string().nullable().optional(),
    status: z.number().int().optional(),
    body: z.unknown().optional(),
    error: z.unknown().optional(),
  })
  .passthrough();

function errorCode(error: unknown): string | null {
  const parsed = errorShapeSchema.safeParse(error);
  if (!parsed.success) return null;
  if (parsed.data.code) return parsed.data.code;
  const body = errorShapeSchema.safeParse(parsed.data.body);
  if (body.success && body.data.code) return body.data.code;
  const nested = errorShapeSchema.safeParse(
    body.success ? body.data.error : parsed.data.error,
  );
  return nested.success && nested.data.code ? nested.data.code : null;
}

function errorStatus(error: unknown): number | null {
  const parsed = errorShapeSchema.safeParse(error);
  return parsed.success && parsed.data.status !== undefined
    ? parsed.data.status
    : null;
}

function isMissingThreadError(error: unknown): boolean {
  return errorCode(error) === "thread_not_found";
}

export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    configuredProject: {
      type: "project",
      label: "Capability spike project",
      description: "The only project where the spike agent tool is enabled.",
    },
  });
  const configured = await settings.get();
  let configuredProjectId = configured.configuredProject ?? null;
  let configuredProjectRevision = 0;
  const stewardEnsureInFlight = new Map<string, Promise<StewardStatus>>();
  settings.onChange((next) => {
    const nextProjectId = next.configuredProject ?? null;
    if (nextProjectId === configuredProjectId) return;
    configuredProjectId = nextProjectId;
    configuredProjectRevision += 1;
    bb.realtime.publish(CONTEXT_REALTIME_CHANNEL, { revision: Date.now() });
  });

  const tasksGateway = createTasksRpcGateway(bb.sdk);
  const projectListSchema = z
    .object({ projects: z.array(tasksAdapterSchemas.project) })
    .passthrough();
  const taskOutputSchema = z
    .object({ task: tasksAdapterSchemas.task.nullable() })
    .passthrough();
  const threadProjectSchema = z
    .object({ projectId: z.string().min(1) })
    .passthrough();
  async function callTasksRpc<T>(
    method: string,
    input: unknown,
    schema: z.ZodType<T>,
  ): Promise<T> {
    const result = await tasksGateway.callRpc({
      pluginId: "tasks",
      method,
      input,
      outputSchema: schema,
    });
    const parsed = schema.safeParse(result);
    if (!parsed.success) {
      throw new TasksDomainError({
        code: "invalid_output",
        message: `Invalid Tasks ${method} response`,
      });
    }
    return parsed.data;
  }
  const taskScopeGuard: TasksScopeGuard = {
    async authorizeTasksProject(input) {
      if (!configuredProjectId) {
        throw new TasksDomainError({
          code: "scope_denied",
          message: "No configured bb project",
        });
      }
      const response = await callTasksRpc(
        "listProjects",
        {},
        projectListSchema,
      );
      const project = response.projects.find(
        (candidate) => candidate.id === input.projectId,
      );
      if (!project || project.linkedBbProjectId !== configuredProjectId) {
        throw new TasksDomainError({
          code: "scope_denied",
          message: "Tasks project is outside the configured bb project",
        });
      }
    },
    async authorizeTask(input) {
      const response = await callTasksRpc(
        "getTask",
        { taskId: input.taskId },
        taskOutputSchema,
      );
      const task = response.task;
      if (!task) {
        throw new TasksDomainError({
          code: "task_not_found",
          message: "Tasks task was not found",
        });
      }
      await this.authorizeTasksProject({ projectId: task.projectId });
    },
    async authorizeTaskThreadLink(input) {
      await this.authorizeTask({ taskId: input.taskId });
      if (!configuredProjectId) {
        throw new TasksDomainError({
          code: "scope_denied",
          message: "No configured bb project",
        });
      }
      const thread = threadProjectSchema.parse(
        await bb.sdk.threads.get({ threadId: input.threadId }),
      );
      if (thread.projectId !== configuredProjectId) {
        throw new TasksDomainError({
          code: "scope_denied",
          message: "Thread is outside the configured bb project",
        });
      }
    },
  };
  const tasksAdapter = createTasksAdapter(tasksGateway, taskScopeGuard);

  const db = bb.storage.database();
  bb.storage.migrate(db, [
    `CREATE TABLE IF NOT EXISTS spike_observations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id TEXT NOT NULL,
      message TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS spike_observations_project_created
      ON spike_observations (project_id, created_at DESC)`,
    `CREATE TABLE IF NOT EXISTS spike_lifecycle_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      event_name TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS spike_thread_receipts (
      receipt_id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      intent TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS spike_thread_refs (
      thread_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      parent_thread_id TEXT,
      created_at INTEGER NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS spike_stewards (
      project_id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    )`,
  ]);

  let receiptSequence = 0;
  const threadSdk = {
    threads: {
      spawn: (input: GatewaySpawnInput) =>
        bb.sdk.threads.spawn({
          projectId: input.projectId,
          input: input.input,
          environment: input.environment,
          ...(input.title ? { title: input.title } : {}),
          ...(input.parentThreadId
            ? { parentThreadId: input.parentThreadId }
            : {}),
          origin: input.origin,
          originPluginId: input.originPluginId,
        }),
      get: (input: { threadId: string; signal?: AbortSignal }) =>
        bb.sdk.threads.get(input),
      wait: (input: Parameters<typeof bb.sdk.threads.wait>[0]) =>
        bb.sdk.threads.wait(input),
      events: {
        list: (input: Parameters<typeof bb.sdk.threads.events.list>[0]) =>
          bb.sdk.threads.events.list(input),
      },
      timeline: (input: Parameters<typeof bb.sdk.threads.timeline>[0]) =>
        bb.sdk.threads.timeline(input),
      output: (input: Parameters<typeof bb.sdk.threads.output>[0]) =>
        bb.sdk.threads.output(input),
      interactions: {
        list: (input: Parameters<typeof bb.sdk.threads.interactions.list>[0]) =>
          bb.sdk.threads.interactions.list(input),
      },
      send: (input: Parameters<typeof bb.sdk.threads.send>[0]) =>
        bb.sdk.threads.send(input),
      queuedMessages: {
        create: (
          input: Parameters<typeof bb.sdk.threads.queuedMessages.create>[0],
        ) => bb.sdk.threads.queuedMessages.create(input),
        list: (
          input: Parameters<typeof bb.sdk.threads.queuedMessages.list>[0],
        ) => bb.sdk.threads.queuedMessages.list(input),
        update: (
          input: Parameters<typeof bb.sdk.threads.queuedMessages.update>[0],
        ) => bb.sdk.threads.queuedMessages.update(input),
        delete: (
          input: Parameters<typeof bb.sdk.threads.queuedMessages.delete>[0],
        ) => bb.sdk.threads.queuedMessages.delete(input),
        reorder: (
          input: Parameters<typeof bb.sdk.threads.queuedMessages.reorder>[0],
        ) => bb.sdk.threads.queuedMessages.reorder(input),
        send: (
          input: Parameters<typeof bb.sdk.threads.queuedMessages.send>[0],
        ) => bb.sdk.threads.queuedMessages.send(input),
      },
      stop: (input: Parameters<typeof bb.sdk.threads.stop>[0]) =>
        bb.sdk.threads.stop(input),
    },
  };
  const threadHost = new SdkThreadHost({
    gateway: createThreadSdkGateway(threadSdk),
    pluginId: "control-plane-spike",
    receiptIds: {
      nextId({ threadId, intent }) {
        receiptSequence += 1;
        const receiptId = `spike-receipt-${receiptSequence}`;
        db.prepare(
          "INSERT INTO spike_thread_receipts (receipt_id, thread_id, intent, created_at) VALUES (?, ?, ?, ?)",
        ).run(receiptId, threadId, intent, Date.now());
        return receiptId;
      },
    },
  });

  let revision = 0;
  function unauthorizedSnapshot(
    projectId: string,
    reason: string,
  ): SpikeSnapshot {
    return {
      projectId: null,
      observationCount: 0,
      lifecycleEvents: [],
      revision,
      error: `Project ${projectId} is not configured for this capability spike: ${reason}`,
    };
  }

  async function stewardStatus(
    projectId: string | null,
  ): Promise<StewardStatus> {
    const configuredIdAtStart = configuredProjectId;
    const configuredRevisionAtStart = configuredProjectRevision;
    if (!projectId)
      return {
        status: "uninitialized",
        threadId: null,
        error: "Select a project first.",
      };
    if (projectId !== configuredIdAtStart)
      return {
        status: "missing",
        threadId: null,
        error: "Project is not configured for this spike.",
      };
    const row = db
      .prepare("SELECT thread_id FROM spike_stewards WHERE project_id = ?")
      .get(projectId);
    const parsedRow = z.object({ thread_id: z.string().min(1) }).safeParse(row);
    if (!parsedRow.success)
      return { status: "uninitialized", threadId: null, error: null };
    try {
      const thread = stewardThreadSchema.parse(
        await bb.sdk.threads.get({ threadId: parsedRow.data.thread_id }),
      );
      if (configuredProjectId !== configuredIdAtStart)
        return {
          status: "error",
          threadId: null,
          error: "Project configuration changed; retry.",
        };
      if (
        thread.id !== parsedRow.data.thread_id ||
        thread.projectId !== projectId ||
        thread.originPluginId !== "control-plane-spike"
      ) {
        return {
          status: "error",
          threadId: null,
          error: "The saved Steward identity could not be verified.",
        };
      }
      return { status: "ready", threadId: thread.id, error: null };
    } catch (error) {
      if (
        configuredProjectId !== configuredIdAtStart ||
        configuredProjectRevision !== configuredRevisionAtStart
      ) {
        return {
          status: "error",
          threadId: null,
          error: "Project configuration changed; retry.",
        };
      }
      if (isMissingThreadError(error))
        return {
          status: "missing",
          threadId: parsedRow.data.thread_id,
          error: "The saved Steward thread is unavailable.",
        };
      return {
        status: "error",
        threadId: null,
        error:
          error instanceof Error ? error.message : "Steward lookup failed.",
      };
    }
  }

  async function ensureSteward(projectId: string): Promise<StewardStatus> {
    const existing = stewardEnsureInFlight.get(projectId);
    if (existing) return existing;
    const operation = (async (): Promise<StewardStatus> => {
      const configuredIdAtStart = configuredProjectId;
      const configuredRevisionAtStart = configuredProjectRevision;
      if (projectId !== configuredIdAtStart)
        return {
          status: "error",
          threadId: null,
          error: "Project is not configured for this spike.",
        };
      const current = await stewardStatus(projectId);
      if (
        configuredProjectId !== configuredIdAtStart ||
        configuredProjectRevision !== configuredRevisionAtStart
      )
        return {
          status: "error",
          threadId: null,
          error: "Project configuration changed; retry.",
        };
      if (current.status === "ready" || current.status === "error")
        return current;
      if (
        configuredProjectId !== configuredIdAtStart ||
        configuredProjectRevision !== configuredRevisionAtStart
      )
        return {
          status: "error",
          threadId: null,
          error: "Project configuration changed; retry.",
        };
      const thread = stewardThreadSchema.parse(
        await bb.sdk.threads.spawn({
          projectId,
          prompt:
            "You are the persistent Control Plane project steward. Help initialize and coordinate this project.",
          title: "Project Steward",
          environment: { type: "project-default" },
        }),
      );
      const trustedThread =
        thread.projectId === projectId &&
        thread.originPluginId === "control-plane-spike";
      if (!trustedThread) {
        return {
          status: "error",
          threadId: null,
          error: "The created Steward identity could not be verified.",
        };
      }
      if (
        configuredProjectId !== configuredIdAtStart ||
        configuredProjectRevision !== configuredRevisionAtStart
      ) {
        try {
          await bb.sdk.threads.archive({ threadId: thread.id });
        } catch (error) {
          bb.log.warn(
            `Could not clean up stale Steward ${thread.id}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        return {
          status: "error",
          threadId: null,
          error:
            "Project configuration changed while creating the Steward; retry.",
        };
      }
      db.prepare(
        "INSERT OR REPLACE INTO spike_stewards (project_id, thread_id, updated_at) VALUES (?, ?, ?)",
      ).run(projectId, thread.id, Date.now());
      return { status: "ready", threadId: thread.id, error: null };
    })();
    stewardEnsureInFlight.set(projectId, operation);
    try {
      return await operation;
    } finally {
      stewardEnsureInFlight.delete(projectId);
    }
  }

  function snapshot(projectId: string | null): SpikeSnapshot {
    if (!projectId) {
      return {
        projectId: null,
        observationCount: 0,
        lifecycleEvents: [],
        revision,
        error: "Select a project before inspecting the capability spike.",
      };
    }
    if (projectId !== configuredProjectId) {
      return unauthorizedSnapshot(projectId, "read access denied");
    }
    const count = countRowSchema.parse(
      db
        .prepare(
          "SELECT COUNT(*) AS count FROM spike_observations WHERE project_id = ?",
        )
        .get(projectId),
    ).count;
    const events = db
      .prepare(
        "SELECT event_name FROM spike_lifecycle_events WHERE project_id = ? ORDER BY id DESC LIMIT ?",
      )
      .all(projectId, MAX_EVENTS)
      .map((row) => lifecycleEventRowSchema.parse(row).event_name);
    return {
      projectId,
      observationCount: count,
      lifecycleEvents: events,
      revision,
      error: null,
    };
  }

  function record(projectId: string, message: string): SpikeSnapshot {
    if (projectId !== configuredProjectId) {
      return unauthorizedSnapshot(projectId, "write access denied");
    }
    db.prepare(
      "INSERT INTO spike_observations (project_id, message, created_at) VALUES (?, ?, ?)",
    ).run(projectId, message, Date.now());
    revision += 1;
    publishChanged(bb, projectId, revision);
    return snapshot(projectId);
  }

  const projectContextProjectSchema = z
    .object({ id: z.string().min(1), name: z.string().min(1) })
    .passthrough();

  async function projectContext() {
    const requestedProjectId = configuredProjectId;
    if (!requestedProjectId) {
      return {
        status: "unconfigured" as const,
        configuredProject: null,
        error: "Configure a project for this capability spike first.",
      };
    }
    try {
      const project = projectContextProjectSchema.parse(
        await bb.sdk.projects.get({ projectId: requestedProjectId }),
      );
      if (project.id !== requestedProjectId) {
        return {
          status: "error" as const,
          configuredProject: null,
          error: "The project lookup returned a different project.",
        };
      }
      if (configuredProjectId !== requestedProjectId) {
        return {
          status: "error" as const,
          configuredProject: null,
          error: "Project configuration changed while loading; retry.",
        };
      }
      return {
        status: "ready" as const,
        configuredProject: { id: project.id, name: project.name },
        error: null,
      };
    } catch (error) {
      if (configuredProjectId !== requestedProjectId) {
        return {
          status: "error" as const,
          configuredProject: null,
          error: "Project configuration changed while loading; retry.",
        };
      }
      const status = errorStatus(error);
      return {
        status: status === 404 ? ("missing" as const) : ("error" as const),
        configuredProject: null,
        error:
          error instanceof Error
            ? error.message
            : "The configured project could not be loaded.",
      };
    }
  }

  function taskError(error: unknown): { code: string; message: string } {
    if (error instanceof TasksDomainError) {
      return { code: error.code, message: error.message };
    }
    const structured = z
      .object({ code: z.string(), message: z.string() })
      .safeParse(error);
    if (structured.success) return structured.data;
    return {
      code: "tasks_operation_failed",
      message:
        error instanceof Error ? error.message : "Tasks operation failed",
    };
  }

  async function taskOperation<T>(operation: () => Promise<T>) {
    try {
      return { ok: true as const, data: await operation() };
    } catch (error) {
      return { ok: false as const, error: taskError(error) };
    }
  }

  async function threadOperation<T>(operation: () => Promise<T>) {
    if (!configuredProjectId) {
      return {
        ok: false as const,
        error: { code: "scope_denied", message: "No configured bb project" },
      };
    }
    return taskOperation(operation);
  }

  bb.rpc.register(controlPlaneSpikeRpcContract, {
    projectContext,
    snapshot({ projectId }) {
      return snapshot(projectId);
    },
    recordObservation({ projectId, message }) {
      return record(projectId, message);
    },
    tasksCapability: async () => {
      const capability = await tasksAdapter.probe();
      return {
        ...capability,
        expectedMethods: [...capability.expectedMethods],
        verifiedMethods: [...capability.verifiedMethods],
      };
    },
    tasksListProjects: (input) =>
      taskOperation(() => tasksAdapter.listProjects(input)),
    tasksCreateTask: (input) =>
      taskOperation(() =>
        tasksAdapter.createTask({
          projectId: input.tasksProjectId,
          title: input.title,
          description: input.description,
          status: input.status,
          priority: input.priority,
          dueDate: input.dueDate,
        }),
      ),
    tasksUpdateTask: (input) =>
      taskOperation(() => tasksAdapter.updateTask(input)),
    tasksCreateComment: (input) =>
      taskOperation(() => tasksAdapter.createComment(input)),
    tasksDelegate: (input) => taskOperation(() => tasksAdapter.delegate(input)),
    tasksAttachThread: (input) =>
      taskOperation(() => tasksAdapter.attachThread(input)),
    threadSpawnRoot: (input) =>
      threadOperation(async () => {
        if (input.projectId !== configuredProjectId) {
          throw new TasksDomainError({
            code: "scope_denied",
            message: "Thread project is outside the configured bb project",
          });
        }
        const receipt = await threadHost.spawnRoot(input);
        db.prepare(
          "INSERT OR REPLACE INTO spike_thread_refs (thread_id, project_id, parent_thread_id, created_at) VALUES (?, ?, ?, ?)",
        ).run(
          receipt.threadId,
          receipt.projectId,
          receipt.parentThreadId,
          Date.now(),
        );
        return receipt;
      }),
    threadSpawnChild: (input) =>
      threadOperation(async () => {
        if (input.projectId !== configuredProjectId) {
          throw new TasksDomainError({
            code: "scope_denied",
            message: "Thread project is outside the configured bb project",
          });
        }
        const receipt = await threadHost.spawnChild(input);
        db.prepare(
          "INSERT OR REPLACE INTO spike_thread_refs (thread_id, project_id, parent_thread_id, created_at) VALUES (?, ?, ?, ?)",
        ).run(
          receipt.threadId,
          receipt.projectId,
          receipt.parentThreadId,
          Date.now(),
        );
        return receipt;
      }),
    threadGet: (input) => threadOperation(() => threadHost.get(input)),
    threadSendNow: (input) => threadOperation(() => threadHost.sendNow(input)),
    threadSendNextTurn: (input) =>
      threadOperation(() => threadHost.sendNextTurn(input)),
    threadCheckpoint: (input) =>
      threadOperation(() => threadHost.queueCheckpointInput(input)),
    threadQueueList: (input) =>
      threadOperation(() => threadHost.queue.list(input)),
    threadStop: (input) => threadOperation(() => threadHost.stop(input)),
    stewardStatus: (input) => stewardStatus(input.projectId),
    stewardEnsure: (input) => ensureSteward(input.projectId),
  });

  bb.agents.registerTool({
    name: TOOL_NAME,
    description:
      "Record a short capability-spike observation for the current project.",
    instructions:
      "Use this only for a concise observation about the Control Plane capability spike.",
    parameters: recordObservationInputSchema,
    execute({ message }, context) {
      if (context.projectId !== configuredProjectId) {
        return {
          content: [
            {
              type: "text",
              text: "This spike tool is not configured for the current project.",
            },
          ],
          isError: true,
        };
      }
      const result = record(context.projectId, message);
      return {
        content: [
          {
            type: "text",
            text: `Recorded observation ${result.observationCount}.`,
          },
        ],
      };
    },
  });

  bb.agents.configure((context) => ({
    tools: context.project.id === configuredProjectId ? [TOOL_NAME] : [],
    skills: [],
  }));

  bb.agents.contributeInstructions((context) =>
    context.projectId === configuredProjectId
      ? "Control Plane capability spike is enabled for this project. Keep observations concise and explicitly label uncertainty."
      : null,
  );

  const lifecycleNames = [
    "thread.created",
    "thread.active",
    "thread.idle",
    "thread.failed",
    "thread.archived",
    "thread.deleted",
  ] as const;
  for (const eventName of lifecycleNames) {
    bb.events.on(eventName, ({ thread }) => {
      const projectId = thread.projectId;
      if (projectId !== configuredProjectId) return;
      db.prepare(
        "INSERT INTO spike_lifecycle_events (project_id, thread_id, event_name, created_at) VALUES (?, ?, ?, ?)",
      ).run(projectId, thread.id, eventName, Date.now());
      revision += 1;
      publishChanged(bb, projectId, revision);
    });
  }

  bb.background.service("control-plane-spike-heartbeat", {
    async start(signal) {
      await waitForAbort(signal);
    },
  });

  bb.onDispose(() => {
    // The host owns the database handle. This hook is intentionally present to
    // prove plugin-owned resources are disposed without closing host storage.
    revision = 0;
  });
}
