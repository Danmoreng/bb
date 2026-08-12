import type { BbPluginApi } from "@bb/plugin-sdk";
import { z } from "zod";
import {
  controlPlaneSpikeRpcContract,
  recordObservationInputSchema,
  type SpikeSnapshot,
} from "./src/contract.js";
import {
  createTasksAdapter,
  createTasksRpcGateway,
  tasksAdapterSchemas,
  TasksDomainError,
  type TasksScopeGuard,
} from "./src/tasks-adapter.js";

const TOOL_NAME = "cp_spike_record";
const REALTIME_CHANNEL = "control-plane-spike-changed";
const MAX_EVENTS = 50;
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
  settings.onChange((next) => {
    configuredProjectId = next.configuredProject ?? null;
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
  ]);

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

  bb.rpc.register(controlPlaneSpikeRpcContract, {
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
