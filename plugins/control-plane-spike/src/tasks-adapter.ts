import { z } from "zod";

const ULID_PATTERN = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;
const taskIdSchema = z.string().regex(ULID_PATTERN, "must be a ULID");
const threadIdSchema = z.string().startsWith("thr_");
const projectIdSchema = taskIdSchema;
const nonBlankStringSchema = z.string().trim().min(1);

export const TASKS_PLUGIN_ID = "tasks";
export const TASKS_SUPPORTED_VERSION = /^0\.1\./;

const taskStatusSchema = z.enum([
  "backlog",
  "todo",
  "in_progress",
  "in_review",
  "done",
  "canceled",
]);
const taskPrioritySchema = z.enum(["urgent", "high", "medium", "low", "none"]);

function isCalendarDate(value: string): boolean {
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

const dueDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "must use YYYY-MM-DD")
  .refine(isCalendarDate, "must be a real calendar date")
  .nullable();

export const projectSchema = z
  .object({
    id: projectIdSchema,
    name: z.string(),
    prefix: z.string(),
    nextTaskNumber: z.number().int().positive(),
    color: z.string(),
    folderId: projectIdSchema.nullable(),
    linkedBbProjectId: z.string().startsWith("proj_").nullable(),
    createdAt: z.string(),
  })
  .passthrough();

export const taskSchema = z
  .object({
    id: taskIdSchema,
    projectId: projectIdSchema,
    number: z.number().int().positive(),
    key: z.string(),
    title: z.string(),
    description: z.string(),
    status: taskStatusSchema,
    priority: taskPrioritySchema,
    dueDate: dueDateSchema,
    parentTaskId: taskIdSchema.nullable(),
    position: z.number(),
    createdAt: z.string(),
    updatedAt: z.string(),
    labelIds: z.array(taskIdSchema),
  })
  .passthrough();

export const commentSchema = z
  .object({
    id: taskIdSchema,
    taskId: taskIdSchema,
    kind: z.enum(["user", "agent", "system"]),
    authorName: z.string(),
    presetName: z.string().nullable(),
    threadId: threadIdSchema.nullable(),
    body: z.string(),
    notifiedCount: z.number().int().nonnegative(),
    createdAt: z.string(),
  })
  .passthrough();

const domainErrorSchema = z
  .object({
    code: z.string(),
    message: z.string(),
  })
  .passthrough();

const taskMutationSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), task: taskSchema }).passthrough(),
  z.object({ ok: z.literal(false), error: domainErrorSchema }).passthrough(),
]);

const projectListOutputSchema = z
  .object({ projects: z.array(projectSchema) })
  .passthrough();
const taskOutputSchema = z
  .object({ task: taskSchema.nullable() })
  .passthrough();
const commentOutputSchema = z.object({ comment: commentSchema }).passthrough();
const delegationOutputSchema = z
  .object({ threadId: threadIdSchema })
  .passthrough();

const pluginStatusSchema = z.enum([
  "running",
  "error",
  "incompatible",
  "missing",
  "disabled",
  "degraded",
  "needs-configuration",
]);
const installedPluginSchema = z
  .object({
    id: z.string(),
    version: z.string(),
    enabled: z.boolean(),
    status: pluginStatusSchema,
  })
  .passthrough();
const pluginListOutputSchema = z
  .object({ plugins: z.array(installedPluginSchema) })
  .passthrough();
const pingOutputSchema = z
  .object({ ok: z.literal(true), version: z.string() })
  .passthrough();

export type Task = z.infer<typeof taskSchema>;
export type Project = z.infer<typeof projectSchema>;
export type Comment = z.infer<typeof commentSchema>;
export type TasksDomainErrorValue = z.infer<typeof domainErrorSchema>;

export type CreateTaskInput = {
  projectId: string;
  title: string;
  description?: string;
  status?: z.infer<typeof taskStatusSchema>;
  priority?: z.infer<typeof taskPrioritySchema>;
  dueDate?: string | null;
  parentTaskId?: string | null;
  labelIds?: string[];
};

export type UpdateTaskInput = {
  taskId: string;
  title?: string;
  description?: string;
  status?: z.infer<typeof taskStatusSchema>;
  priority?: z.infer<typeof taskPrioritySchema>;
  dueDate?: string | null;
  parentTaskId?: string | null;
  labelIds?: string[];
  authorName?: string;
};

export type CreateCommentInput = {
  taskId: string;
  body: string;
  notify: boolean;
  allowEmptyBody?: boolean;
};

export type ListProjectsInput = { folderId?: string | null };
export type DelegateInput = {
  taskId: string;
  presetId: string;
  extraInstructions?: string;
};
export type AttachThreadInput = { taskId: string; threadId: string };

const listProjectsInputSchema = z
  .object({ folderId: taskIdSchema.nullable().optional() })
  .strict();
const createTaskInputSchema = z
  .object({
    projectId: projectIdSchema,
    title: nonBlankStringSchema,
    description: z.string(),
    status: taskStatusSchema,
    priority: taskPrioritySchema,
    dueDate: dueDateSchema,
    parentTaskId: taskIdSchema.nullable(),
    labelIds: z.array(taskIdSchema),
  })
  .strict();
const updateTaskInputSchema = z
  .object({
    taskId: taskIdSchema,
    title: nonBlankStringSchema.optional(),
    description: z.string().optional(),
    status: taskStatusSchema.optional(),
    priority: taskPrioritySchema.optional(),
    dueDate: dueDateSchema.optional(),
    parentTaskId: taskIdSchema.nullable().optional(),
    labelIds: z.array(taskIdSchema).optional(),
    authorName: nonBlankStringSchema,
  })
  .strict()
  .refine(
    (input) =>
      input.title !== undefined ||
      input.description !== undefined ||
      input.status !== undefined ||
      input.priority !== undefined ||
      input.dueDate !== undefined ||
      input.parentTaskId !== undefined ||
      input.labelIds !== undefined,
    { message: "At least one task field must be updated" },
  );
const createCommentInputSchema = z
  .object({
    taskId: taskIdSchema,
    body: z.string(),
    notify: z.boolean(),
    allowEmptyBody: z.boolean(),
  })
  .strict()
  .refine((input) => input.allowEmptyBody || input.body.trim().length > 0, {
    path: ["body"],
    message: "Comment body cannot be empty",
  });
const delegateInputSchema = z
  .object({
    taskId: taskIdSchema,
    presetId: taskIdSchema,
    extraInstructions: z.string().optional(),
  })
  .strict();
const attachThreadInputSchema = z
  .object({ taskId: taskIdSchema, threadId: threadIdSchema })
  .strict();

export type TasksCapabilityStatus =
  | "available"
  | "unavailable"
  | "incompatible";
export type TasksCapability = {
  status: TasksCapabilityStatus;
  pluginId: "tasks";
  version: string | null;
  expectedMethods: readonly string[];
  verifiedMethods: readonly string[];
  reason: string;
};

export type TasksRpcCall<T> = {
  pluginId: string;
  method: string;
  input: unknown;
  outputSchema: z.ZodType<T>;
};

export interface TasksRpcGateway {
  pluginsList(): Promise<unknown>;
  callRpc<T>(call: TasksRpcCall<T>): Promise<unknown>;
}

/** Structural subset of BbPluginApi used by the real gateway factory. */
export interface TasksPluginSdk {
  plugins: {
    list(input?: { signal?: AbortSignal }): Promise<unknown>;
    callRpc<T>(input: {
      pluginId: string;
      method: string;
      input?: unknown;
      outputSchema: z.ZodType<T>;
    }): Promise<T>;
  };
}

export interface TasksScopeGuard {
  authorizeTasksProject(input: { projectId: string }): Promise<void>;
  authorizeTask(input: { taskId: string }): Promise<void>;
  authorizeTaskThreadLink(input: {
    taskId: string;
    threadId: string;
  }): Promise<void>;
}

export type TasksErrorKind =
  | "unavailable"
  | "incompatible"
  | "domain-error"
  | "transient";

export class TasksAdapterError extends Error {
  readonly kind: TasksErrorKind;
  readonly code: string;

  constructor(
    kind: TasksErrorKind,
    code: string,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "TasksAdapterError";
    this.kind = kind;
    this.code = code;
  }
}

export class TasksUnavailableError extends TasksAdapterError {
  constructor(code: string, message: string, options?: ErrorOptions) {
    super("unavailable", code, message, options);
    this.name = "TasksUnavailableError";
  }
}

export class TasksIncompatibleError extends TasksAdapterError {
  constructor(code: string, message: string, options?: ErrorOptions) {
    super("incompatible", code, message, options);
    this.name = "TasksIncompatibleError";
  }
}

export class TasksDomainError extends TasksAdapterError {
  readonly domain: TasksDomainErrorValue;

  constructor(domain: TasksDomainErrorValue, options?: ErrorOptions) {
    super("domain-error", domain.code, domain.message, options);
    this.name = "TasksDomainError";
    this.domain = domain;
  }
}

export class TasksTransientError extends TasksAdapterError {
  constructor(code: string, message: string, options?: ErrorOptions) {
    super("transient", code, message, options);
    this.name = "TasksTransientError";
  }
}

const EXPECTED_METHODS = [
  "ping",
  "listProjects",
  "getTask",
  "createTask",
  "updateTask",
  "createComment",
  "delegate",
  "taskThreadsAttach",
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

const errorEnvelopeSchema = z.object({
  code: z.string().nullable().optional(),
  message: z.string().optional(),
  status: z.number().int().optional(),
  body: z.unknown().optional(),
});
const nestedErrorSchema = z
  .object({
    code: z.string().optional(),
    message: z.string().optional(),
  })
  .passthrough();

type ErrorDetails = z.infer<typeof errorEnvelopeSchema>;

function errorDetails(error: unknown): ErrorDetails {
  if (error instanceof TasksAdapterError)
    return { code: error.code, message: error.message };
  if (isRecord(error)) {
    const parsed = errorEnvelopeSchema.safeParse(error);
    if (parsed.success) return parsed.data;
  }
  if (error instanceof Error) return { message: error.message };
  return {};
}

function errorBody(details: ErrorDetails): Record<string, unknown> | null {
  if (!isRecord(details.body)) return null;
  const envelope = z.object({ error: z.unknown() }).safeParse(details.body);
  if (envelope.success) {
    const parsed = nestedErrorSchema.safeParse(envelope.data.error);
    if (parsed.success) return parsed.data;
  }
  const nested = nestedErrorSchema.safeParse(details.body);
  return nested.success ? nested.data : details.body;
}

function mapGatewayError(error: unknown): TasksAdapterError {
  if (error instanceof TasksAdapterError) return error;
  const details = errorDetails(error);
  const body = errorBody(details);
  const code =
    details.code ??
    (typeof body?.code === "string" ? body.code : "gateway_error");
  const message =
    details.message ??
    (typeof body?.message === "string"
      ? body.message
      : "Tasks RPC request failed");
  const status =
    details.status ?? (typeof body?.status === "number" ? body.status : null);

  if (
    code === "unknown_method" ||
    code === "invalid_output" ||
    code === "invalid_json" ||
    code === "invalid_input" ||
    code === "incompatible_version"
  ) {
    return new TasksIncompatibleError(code, message, { cause: error });
  }
  if (
    code === "project_not_linked" ||
    code === "task_not_found" ||
    code === "thread_not_found"
  ) {
    return new TasksDomainError({ code, message }, { cause: error });
  }
  if (status === 404 && code === "gateway_error") {
    return new TasksUnavailableError("plugin_missing", message, {
      cause: error,
    });
  }
  if (status === 503 || status === 424 || code === "plugin_unavailable") {
    return new TasksUnavailableError(code, message, { cause: error });
  }
  if (status !== null && (status === 408 || status === 429 || status >= 500)) {
    return new TasksTransientError(code, message, { cause: error });
  }
  return new TasksTransientError(code, message, { cause: error });
}

function parseOutput<T>(
  schema: z.ZodType<T>,
  value: unknown,
  method: string,
): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new TasksIncompatibleError(
      "invalid_output",
      `Tasks RPC ${method} returned an incompatible response: ${parsed.error.message}`,
      { cause: parsed.error },
    );
  }
  return parsed.data;
}

function mutationTask(value: z.infer<typeof taskMutationSchema>): Task {
  if (!value.ok) throw new TasksDomainError(value.error);
  return value.task;
}

export function createTasksRpcGateway(sdk: TasksPluginSdk): TasksRpcGateway {
  return {
    pluginsList: () => sdk.plugins.list(),
    callRpc: <T>(call: TasksRpcCall<T>) =>
      sdk.plugins.callRpc({
        pluginId: call.pluginId,
        method: call.method,
        input: call.input,
        outputSchema: call.outputSchema,
      }),
  };
}

export class TasksAdapter {
  private capability: TasksCapability | null = null;

  constructor(
    private readonly gateway: TasksRpcGateway,
    private readonly scopeGuard: TasksScopeGuard,
  ) {}

  async probe(): Promise<TasksCapability> {
    try {
      const pluginList = parseOutput(
        pluginListOutputSchema,
        await this.gateway.pluginsList(),
        "plugins.list",
      );
      const tasks = pluginList.plugins.find(
        (plugin) => plugin.id === TASKS_PLUGIN_ID,
      );
      if (
        !tasks ||
        !tasks.enabled ||
        tasks.status === "missing" ||
        tasks.status === "disabled" ||
        tasks.status === "needs-configuration"
      ) {
        return this.remember({
          status: "unavailable",
          pluginId: TASKS_PLUGIN_ID,
          version: tasks?.version ?? null,
          expectedMethods: EXPECTED_METHODS,
          verifiedMethods: [],
          reason: "Tasks plugin is not enabled and running",
        });
      }
      if (tasks.status !== "running") {
        return this.remember({
          status: "unavailable",
          pluginId: TASKS_PLUGIN_ID,
          version: tasks.version,
          expectedMethods: EXPECTED_METHODS,
          verifiedMethods: [],
          reason: `Tasks plugin status is ${tasks.status}`,
        });
      }
      if (!TASKS_SUPPORTED_VERSION.test(tasks.version)) {
        return this.remember({
          status: "incompatible",
          pluginId: TASKS_PLUGIN_ID,
          version: tasks.version,
          expectedMethods: EXPECTED_METHODS,
          verifiedMethods: [],
          reason: `Tasks version ${tasks.version} is outside the supported 0.1.x range`,
        });
      }
      const ping = await this.call("ping", null, pingOutputSchema);
      if (!TASKS_SUPPORTED_VERSION.test(ping.version)) {
        return this.remember({
          status: "incompatible",
          pluginId: TASKS_PLUGIN_ID,
          version: ping.version,
          expectedMethods: EXPECTED_METHODS,
          verifiedMethods: [],
          reason: `Tasks ping version ${ping.version} is outside the supported 0.1.x range`,
        });
      }
      await this.call("listProjects", {}, projectListOutputSchema);
      return this.remember({
        status: "available",
        pluginId: TASKS_PLUGIN_ID,
        version: ping.version,
        expectedMethods: EXPECTED_METHODS,
        verifiedMethods: ["ping", "listProjects"],
        reason:
          "Tasks plugin, ping, and read-only project listing are available",
      });
    } catch (error) {
      const mapped = mapGatewayError(error);
      return this.remember({
        status: mapped.kind === "incompatible" ? "incompatible" : "unavailable",
        pluginId: TASKS_PLUGIN_ID,
        version: null,
        expectedMethods: EXPECTED_METHODS,
        verifiedMethods: [],
        reason: mapped.message,
      });
    }
  }

  async listProjects(input: ListProjectsInput = {}): Promise<Project[]> {
    await this.requireAvailable();
    const normalized = listProjectsInputSchema.parse(
      input.folderId === undefined ? {} : { folderId: input.folderId },
    );
    const output = await this.call(
      "listProjects",
      normalized,
      projectListOutputSchema,
    );
    const visible: Project[] = [];
    for (const project of output.projects) {
      try {
        await this.scopeGuard.authorizeTasksProject({ projectId: project.id });
        visible.push(project);
      } catch (error) {
        if (
          !(error instanceof TasksAdapterError) ||
          error.kind !== "domain-error"
        ) {
          throw error;
        }
      }
    }
    return visible;
  }

  async getTask(taskId: string): Promise<Task | null> {
    await this.requireAvailable();
    const normalized = z
      .object({ taskId: taskIdSchema })
      .strict()
      .parse({ taskId });
    const output = await this.call("getTask", normalized, taskOutputSchema);
    if (output.task)
      await this.scopeGuard.authorizeTasksProject({
        projectId: output.task.projectId,
      });
    return output.task;
  }

  async createTask(input: CreateTaskInput): Promise<Task> {
    await this.requireAvailable();
    const normalized = createTaskInputSchema.parse({
      projectId: input.projectId,
      title: input.title,
      description: input.description ?? "",
      status: input.status ?? "backlog",
      priority: input.priority ?? "none",
      dueDate: input.dueDate ?? null,
      parentTaskId: input.parentTaskId ?? null,
      labelIds: input.labelIds ?? [],
    });
    await this.scopeGuard.authorizeTasksProject({
      projectId: normalized.projectId,
    });
    return mutationTask(
      await this.call("createTask", normalized, taskMutationSchema),
    );
  }

  async updateTask(input: UpdateTaskInput): Promise<Task> {
    await this.requireAvailable();
    const normalized = updateTaskInputSchema.parse({
      ...input,
      authorName: input.authorName ?? "You",
    });
    await this.scopeGuard.authorizeTask({ taskId: normalized.taskId });
    return mutationTask(
      await this.call("updateTask", normalized, taskMutationSchema),
    );
  }

  async createComment(input: CreateCommentInput): Promise<Comment> {
    await this.requireAvailable();
    const normalized = createCommentInputSchema.parse({
      ...input,
      allowEmptyBody: input.allowEmptyBody ?? false,
    });
    await this.scopeGuard.authorizeTask({ taskId: normalized.taskId });
    const output = await this.call(
      "createComment",
      normalized,
      commentOutputSchema,
    );
    return output.comment;
  }

  async delegate(input: DelegateInput): Promise<string> {
    await this.requireAvailable();
    const normalized = delegateInputSchema.parse(input);
    await this.scopeGuard.authorizeTask({ taskId: normalized.taskId });
    const output = await this.call(
      "delegate",
      normalized,
      delegationOutputSchema,
    );
    return output.threadId;
  }

  async attachThread(input: AttachThreadInput): Promise<string> {
    await this.requireAvailable();
    const normalized = attachThreadInputSchema.parse(input);
    await this.scopeGuard.authorizeTask({ taskId: normalized.taskId });
    await this.scopeGuard.authorizeTaskThreadLink(normalized);
    const output = await this.call(
      "taskThreadsAttach",
      normalized,
      delegationOutputSchema,
    );
    return output.threadId;
  }

  private remember(capability: TasksCapability): TasksCapability {
    this.capability = capability;
    return capability;
  }

  private async requireAvailable(): Promise<void> {
    const capability = this.capability ?? (await this.probe());
    if (capability.status === "available") return;
    if (capability.status === "incompatible") {
      throw new TasksIncompatibleError("tasks_incompatible", capability.reason);
    }
    throw new TasksUnavailableError("tasks_unavailable", capability.reason);
  }

  private async call<T>(
    method: string,
    input: unknown,
    schema: z.ZodType<T>,
  ): Promise<T> {
    try {
      const output = await this.gateway.callRpc({
        pluginId: TASKS_PLUGIN_ID,
        method,
        input,
        outputSchema: schema,
      });
      return parseOutput(schema, output, method);
    } catch (error) {
      if (error instanceof z.ZodError) {
        throw new TasksIncompatibleError(
          "invalid_output",
          `Tasks RPC ${method} returned invalid data`,
          { cause: error },
        );
      }
      throw mapGatewayError(error);
    }
  }
}

export function createTasksAdapter(
  gateway: TasksRpcGateway,
  scopeGuard: TasksScopeGuard,
): TasksAdapter {
  return new TasksAdapter(gateway, scopeGuard);
}

export const tasksAdapterSchemas = {
  project: projectSchema,
  task: taskSchema,
  taskOutput: taskOutputSchema,
  comment: commentSchema,
  pluginList: pluginListOutputSchema,
  ping: pingOutputSchema,
};
