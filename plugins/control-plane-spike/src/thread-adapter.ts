import { z } from "zod";

const nonEmptyStringSchema = z.string().min(1);
const idSchema = nonEmptyStringSchema;
const jsonObjectSchema = z.record(z.string(), z.unknown());
const promptInputSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("text"),
      text: z.string(),
      mentions: z.array(z.unknown()).default([]),
    })
    .passthrough(),
  z.object({ type: z.literal("image"), url: z.string().url() }).passthrough(),
  z.object({ type: z.literal("localImage"), path: z.string() }).passthrough(),
  z
    .object({
      type: z.literal("localFile"),
      path: z.string(),
      name: z.string().optional(),
      sizeBytes: z.number().int().nonnegative().optional(),
      mimeType: z.string().optional(),
    })
    .passthrough(),
]);

export type ThreadStatus =
  | "idle"
  | "starting"
  | "active"
  | "stopping"
  | "error";

export type PromptInput =
  | { type: "text"; text: string; mentions: [] }
  | { type: "image"; url: string }
  | { type: "localImage"; path: string }
  | {
      type: "localFile";
      path: string;
      name?: string;
      sizeBytes?: number;
      mimeType?: string;
    };

export type ThreadEnvironment =
  | { type: "project-default" }
  | { type: "reuse"; environmentId: string };

export interface SpawnRootInput {
  projectId: string;
  prompt: string;
  environment: ThreadEnvironment;
  title?: string;
}

export interface SpawnChildInput {
  parentThreadId: string;
  projectId: string;
  prompt: string;
  environment: ThreadEnvironment;
  title?: string;
}

export interface ThreadSnapshot {
  threadId: string;
  projectId: string | null;
  parentThreadId: string | null;
  status: ThreadStatus;
  providerThreadId: string | null;
  originPluginId: string | null;
  updatedAt: string | null;
}

export interface SpawnReceipt {
  threadId: string;
  projectId: string;
  parentThreadId: string | null;
  origin: "plugin";
  originPluginId: string;
  acceptance: "accepted";
}

export type WaitTarget =
  | { kind: "status"; status: ThreadStatus }
  | { kind: "event"; eventType: string };

export interface WaitInput {
  threadId: string;
  target: WaitTarget;
  timeoutMs?: number;
  pollIntervalMs?: number;
  signal?: AbortSignal;
}

export interface WaitReceipt {
  threadId: string;
  matched: true;
  target: WaitTarget;
  snapshot: ThreadSnapshot | null;
  event: ThreadEvent | null;
}

export interface ThreadEvent {
  eventId: string;
  sequence: string;
  threadId: string;
  type: string;
  occurredAt: string | null;
}

export interface EventQuery {
  threadId: string;
  afterSequence?: string;
  limit?: number;
  signal?: AbortSignal;
}

export interface EventPage {
  events: ThreadEvent[];
}

export interface TimelineRow {
  rowId: string;
  kind: string;
  text: string | null;
}

export interface TimelineSnapshot {
  rows: TimelineRow[];
  maxSequence: string | null;
}

export interface OutputSnapshot {
  output: string | null;
}

export interface PendingInteraction {
  interactionId: string;
  kind: string;
  originKind: string | null;
  status: string;
}

export interface QueueMessage {
  queuedMessageId: string;
  threadId: string;
  input: PromptInput[];
  updatedAt: number;
  position: number;
}

export interface DeliveryReceipt {
  receiptId: string;
  threadId: string;
  intent: "send-now" | "send-next-turn" | "checkpoint" | "stop";
  acceptance: "accepted" | "rejected" | "unknown";
  application:
    | "queued"
    | "steered"
    | "new-turn"
    | "stop-requested"
    | "noop"
    | "unknown";
  queuedMessageId: string | null;
}

export interface ReceiptIdGenerator {
  nextId(input: {
    threadId: string;
    intent: DeliveryReceipt["intent"];
  }): string;
}

export type ThreadAdapterErrorKind =
  | "unavailable"
  | "incompatible"
  | "domain-error"
  | "transient"
  | "invalid-response"
  | "unknown";

export class ThreadAdapterError extends Error {
  readonly kind: ThreadAdapterErrorKind;
  readonly operation: string;
  readonly code: string | null;

  constructor(input: {
    kind: ThreadAdapterErrorKind;
    operation: string;
    message: string;
    code?: string | null;
    cause?: unknown;
  }) {
    super(input.message, { cause: input.cause });
    this.name = "ThreadAdapterError";
    this.kind = input.kind;
    this.operation = input.operation;
    this.code = input.code ?? null;
  }
}

export class DeliveryUnknownError extends ThreadAdapterError {
  readonly receipt: DeliveryReceipt;

  constructor(input: {
    operation: string;
    receipt: DeliveryReceipt;
    cause?: unknown;
  }) {
    super({
      kind: "unknown",
      operation: input.operation,
      code: "delivery_unknown",
      message: `The server may have accepted ${input.operation}, but the delivery result is unknown. Reconcile before retrying.`,
      cause: input.cause,
    });
    this.name = "DeliveryUnknownError";
    this.receipt = input.receipt;
  }
}

export interface GatewaySpawnInput {
  projectId: string;
  input: PromptInput[];
  environment: ThreadEnvironment;
  title?: string;
  parentThreadId?: string;
  origin: "plugin";
  originPluginId: string;
}

export interface GatewaySendInput {
  threadId: string;
  input: PromptInput[];
  mode: "steer-if-active" | "queue-if-active" | "start";
  signal?: AbortSignal;
}

export interface GatewayWaitInput {
  threadId: string;
  status?: ThreadStatus;
  event?: string;
  timeoutMs?: number;
  pollIntervalMs?: number;
  signal?: AbortSignal;
}

export interface GatewayQueueCreateInput {
  threadId: string;
  input: PromptInput[];
}

export interface GatewayQueueUpdateInput {
  threadId: string;
  queuedMessageId: string;
  expectedUpdatedAt: number;
  input: PromptInput[];
}

export interface GatewayQueueTarget {
  threadId: string;
  queuedMessageId: string;
}

export interface GatewayQueueReorderInput extends GatewayQueueTarget {
  previousQueuedMessageId: string | null;
  nextQueuedMessageId: string | null;
}

export interface GatewayQueueSendInput extends GatewayQueueTarget {
  mode: "auto" | "steer";
}

export interface ThreadSdkGateway {
  spawn(input: GatewaySpawnInput): Promise<unknown>;
  get(input: { threadId: string; signal?: AbortSignal }): Promise<unknown>;
  wait(input: GatewayWaitInput): Promise<unknown>;
  events: {
    list(input: {
      threadId: string;
      afterSeq?: string;
      limit?: string;
      signal?: AbortSignal;
    }): Promise<unknown>;
  };
  timeline(input: { threadId: string; signal?: AbortSignal }): Promise<unknown>;
  output(input: { threadId: string; signal?: AbortSignal }): Promise<unknown>;
  interactions: {
    list(input: { threadId: string; signal?: AbortSignal }): Promise<unknown>;
  };
  send(input: GatewaySendInput): Promise<unknown>;
  queuedMessages: {
    create(input: GatewayQueueCreateInput): Promise<unknown>;
    list(input: { threadId: string; signal?: AbortSignal }): Promise<unknown>;
    update(input: GatewayQueueUpdateInput): Promise<unknown>;
    delete(input: GatewayQueueTarget): Promise<unknown>;
    reorder(input: GatewayQueueReorderInput): Promise<unknown>;
    send(input: GatewayQueueSendInput): Promise<unknown>;
  };
  stop(input: { threadId: string }): Promise<unknown>;
}

/** Structural shape of the public SDK used by the real gateway factory. */
export interface ThreadSdkSurface {
  threads: {
    spawn(input: GatewaySpawnInput): Promise<unknown>;
    get(input: { threadId: string; signal?: AbortSignal }): Promise<unknown>;
    wait(input: GatewayWaitInput): Promise<unknown>;
    events: ThreadSdkGateway["events"];
    timeline(input: {
      threadId: string;
      signal?: AbortSignal;
    }): Promise<unknown>;
    output(input: { threadId: string; signal?: AbortSignal }): Promise<unknown>;
    interactions: ThreadSdkGateway["interactions"];
    send(input: GatewaySendInput): Promise<unknown>;
    queuedMessages: ThreadSdkGateway["queuedMessages"];
    stop(input: { threadId: string }): Promise<unknown>;
  };
}

/** Maps the public bb SDK, without importing private server implementation code. */
export function createThreadSdkGateway(
  sdk: ThreadSdkSurface,
): ThreadSdkGateway {
  return {
    spawn: (input) => sdk.threads.spawn(input),
    get: (input) => sdk.threads.get(input),
    wait: (input) => sdk.threads.wait(input),
    events: {
      list: (input) => sdk.threads.events.list(input),
    },
    timeline: (input) => sdk.threads.timeline(input),
    output: (input) => sdk.threads.output(input),
    interactions: {
      list: (input) => sdk.threads.interactions.list(input),
    },
    send: (input) => sdk.threads.send(input),
    queuedMessages: {
      create: (input) => sdk.threads.queuedMessages.create(input),
      list: (input) => sdk.threads.queuedMessages.list(input),
      update: (input) => sdk.threads.queuedMessages.update(input),
      delete: (input) => sdk.threads.queuedMessages.delete(input),
      reorder: (input) => sdk.threads.queuedMessages.reorder(input),
      send: (input) => sdk.threads.queuedMessages.send(input),
    },
    stop: (input) => sdk.threads.stop(input),
  };
}

export interface ThreadHost {
  spawnRoot(input: SpawnRootInput): Promise<SpawnReceipt>;
  spawnChild(input: SpawnChildInput): Promise<SpawnReceipt>;
  get(input: {
    threadId: string;
    signal?: AbortSignal;
  }): Promise<ThreadSnapshot>;
  wait(input: WaitInput): Promise<WaitReceipt>;
  events(input: EventQuery): Promise<EventPage>;
  timeline(input: {
    threadId: string;
    signal?: AbortSignal;
  }): Promise<TimelineSnapshot>;
  output(input: {
    threadId: string;
    signal?: AbortSignal;
  }): Promise<OutputSnapshot>;
  pendingInteractions(input: {
    threadId: string;
    signal?: AbortSignal;
  }): Promise<PendingInteraction[]>;
  sendNow(input: {
    threadId: string;
    prompt: string;
    signal?: AbortSignal;
  }): Promise<DeliveryReceipt>;
  sendNextTurn(input: {
    threadId: string;
    prompt: string;
    signal?: AbortSignal;
  }): Promise<DeliveryReceipt>;
  queueCheckpointInput(input: {
    threadId: string;
    prompt: string;
  }): Promise<DeliveryReceipt>;
  queue: {
    list(input: {
      threadId: string;
      signal?: AbortSignal;
    }): Promise<QueueMessage[]>;
    update(input: {
      threadId: string;
      queuedMessageId: string;
      expectedUpdatedAt: number;
      prompt: string;
    }): Promise<QueueMessage>;
    delete(input: GatewayQueueTarget): Promise<void>;
    reorder(input: GatewayQueueReorderInput): Promise<QueueMessage[]>;
    send(input: GatewayQueueSendInput): Promise<DeliveryReceipt>;
  };
  stop(input: { threadId: string }): Promise<DeliveryReceipt>;
}

const threadStatusSchema = z.enum([
  "idle",
  "starting",
  "active",
  "stopping",
  "error",
]);
const threadRecordSchema = z
  .object({
    id: idSchema,
    projectId: idSchema.nullable().optional(),
    parentThreadId: idSchema.nullable().optional(),
    originPluginId: idSchema.nullable().optional(),
    status: threadStatusSchema,
    providerThreadId: idSchema.nullable().optional(),
    updatedAt: z.union([z.string(), z.number()]).nullable().optional(),
  })
  .passthrough();
const acceptedResponseSchema = z.object({ ok: z.literal(true) }).passthrough();
const eventRecordSchema = z
  .object({
    id: idSchema,
    seq: z.union([z.string(), z.number()]),
    threadId: idSchema,
    type: nonEmptyStringSchema,
    createdAt: z.union([z.string(), z.number()]).nullable().optional(),
  })
  .passthrough();
const eventListSchema = z.array(eventRecordSchema);
const timelineSchema = z
  .object({
    rows: z.array(jsonObjectSchema),
    maxSeq: z.number().int().nonnegative(),
  })
  .passthrough();
const outputSchema = z.object({ output: z.string().nullable() }).passthrough();
const interactionListSchema = z.array(
  z
    .object({
      id: idSchema,
      status: nonEmptyStringSchema,
      payload: z.object({ kind: nonEmptyStringSchema }).passthrough(),
      origin: z.object({ kind: nonEmptyStringSchema }).passthrough().optional(),
    })
    .passthrough(),
);
const queueMessageSchema = z
  .object({
    id: idSchema,
    content: z.array(promptInputSchema).min(1),
    updatedAt: z.number().int().nonnegative(),
  })
  .passthrough();
const queueListSchema = z.array(queueMessageSchema);
const waitSchema = z
  .object({
    matched: z.literal(true),
    threadId: idSchema,
    target: z.object({ kind: z.enum(["status", "event"]) }).passthrough(),
    thread: z.unknown().optional(),
    event: z.unknown().optional(),
  })
  .passthrough();

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  return Object.fromEntries(Object.entries(value));
}

function stringField(
  record: Record<string, unknown>,
  key: string,
): string | null {
  const value = record[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function normalizeDate(
  value: string | number | null | undefined,
): string | null {
  if (value === undefined || value === null) return null;
  return typeof value === "number" ? new Date(value).toISOString() : value;
}

function normalizeThread(value: unknown, operation: string): ThreadSnapshot {
  const parsed = parseAtBoundary(threadRecordSchema, value, operation);
  return {
    threadId: parsed.id,
    projectId: parsed.projectId ?? null,
    parentThreadId: parsed.parentThreadId ?? null,
    status: parsed.status,
    providerThreadId: parsed.providerThreadId ?? null,
    originPluginId: parsed.originPluginId ?? null,
    updatedAt: normalizeDate(parsed.updatedAt),
  };
}

function parseAtBoundary<T>(
  schema: z.ZodType<T>,
  value: unknown,
  operation: string,
): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new ThreadAdapterError({
      kind: "invalid-response",
      operation,
      message: `Invalid ${operation} response: ${result.error.message}`,
      code: "invalid_output",
      cause: result.error,
    });
  }
  return result.data;
}

function errorCode(value: unknown): string | null {
  const record = asRecord(value);
  const direct = record?.code;
  if (typeof direct === "string") return direct;
  const body = asRecord(record?.body);
  const nested = asRecord(body?.error);
  if (typeof nested?.code === "string") return nested.code;
  return typeof body?.code === "string" ? body.code : null;
}

function errorStatus(value: unknown): number | null {
  const record = asRecord(value);
  return typeof record?.status === "number" ? record.status : null;
}

function mapGatewayError(
  value: unknown,
  operation: string,
): ThreadAdapterError {
  if (value instanceof ThreadAdapterError) return value;
  const code = errorCode(value);
  const status = errorStatus(value);
  if (code === "unknown_method" || code === "invalid_output") {
    return new ThreadAdapterError({
      kind: "incompatible",
      operation,
      message: `The thread host does not support ${operation}.`,
      code,
      cause: value,
    });
  }
  if (status === 404) {
    const kind =
      code === "thread_not_found" || code === "not_found"
        ? "domain-error"
        : "unavailable";
    return new ThreadAdapterError({
      kind,
      operation,
      message:
        code === "thread_not_found" || code === "not_found"
          ? `Thread was not found during ${operation}.`
          : `The thread host is unavailable during ${operation}.`,
      code,
      cause: value,
    });
  }
  if (status === 503 || code === "plugin_unavailable") {
    return new ThreadAdapterError({
      kind: "unavailable",
      operation,
      message: `The thread host is unavailable during ${operation}.`,
      code,
      cause: value,
    });
  }
  if (
    code === "awaiting_user_interaction" ||
    code === "stale_queued_message" ||
    code === "queue_claim_conflict" ||
    code === "expected_updated_at_mismatch"
  ) {
    return new ThreadAdapterError({
      kind: "domain-error",
      operation,
      message: `The thread rejected ${operation} with ${code}.`,
      code,
      cause: value,
    });
  }
  return new ThreadAdapterError({
    kind: "transient",
    operation,
    message: `The thread host failed during ${operation}.`,
    code,
    cause: value,
  });
}

async function callGateway<T>(
  operation: string,
  call: () => Promise<unknown>,
  schema: z.ZodType<T>,
): Promise<T> {
  try {
    return parseAtBoundary(schema, await call(), operation);
  } catch (error) {
    if (error instanceof ThreadAdapterError) throw error;
    throw mapGatewayError(error, operation);
  }
}

function textInput(prompt: string): PromptInput[] {
  return [{ type: "text", text: prompt, mentions: [] }];
}

function normalizeReceipt(input: {
  receiptId: string;
  threadId: string;
  intent: DeliveryReceipt["intent"];
  acceptance: DeliveryReceipt["acceptance"];
  application: DeliveryReceipt["application"];
  queuedMessageId?: string | null;
}): DeliveryReceipt {
  return {
    receiptId: input.receiptId,
    threadId: input.threadId,
    intent: input.intent,
    acceptance: input.acceptance,
    application: input.application,
    queuedMessageId: input.queuedMessageId ?? null,
  };
}

function normalizeQueueMessage(
  value: unknown,
  operation: string,
  context: { threadId: string; position: number },
): QueueMessage {
  const parsed = parseAtBoundary(queueMessageSchema, value, operation);
  return {
    queuedMessageId: parsed.id,
    threadId: context.threadId,
    input: parsed.content.map((entry) => {
      if (entry.type === "text")
        return {
          type: "text" as const,
          text: entry.text,
          mentions: [] as const,
        };
      if (entry.type === "image")
        return { type: "image" as const, url: entry.url };
      if (entry.type === "localImage")
        return { type: "localImage" as const, path: entry.path };
      return {
        type: "localFile" as const,
        path: entry.path,
        ...(entry.name ? { name: entry.name } : {}),
        ...(entry.sizeBytes === undefined
          ? {}
          : { sizeBytes: entry.sizeBytes }),
        ...(entry.mimeType ? { mimeType: entry.mimeType } : {}),
      };
    }),
    updatedAt: parsed.updatedAt,
    position: context.position,
  };
}

export class SdkThreadHost implements ThreadHost {
  private readonly gateway: ThreadSdkGateway;
  private readonly pluginId: string;
  private readonly receiptIds: ReceiptIdGenerator;

  constructor(input: {
    gateway: ThreadSdkGateway;
    pluginId: string;
    receiptIds: ReceiptIdGenerator;
  }) {
    this.gateway = input.gateway;
    this.pluginId = input.pluginId;
    this.receiptIds = input.receiptIds;
  }

  async spawnRoot(input: SpawnRootInput): Promise<SpawnReceipt> {
    const thread = normalizeThread(
      await callGateway(
        "threads.spawnRoot",
        () =>
          this.gateway.spawn({
            projectId: input.projectId,
            input: textInput(input.prompt),
            environment: input.environment,
            ...(input.title ? { title: input.title } : {}),
            origin: "plugin",
            originPluginId: this.pluginId,
          }),
        threadRecordSchema,
      ),
      "threads.spawnRoot",
    );
    if (
      (thread.projectId !== null && thread.projectId !== input.projectId) ||
      (thread.originPluginId !== null &&
        thread.originPluginId !== this.pluginId)
    ) {
      throw new ThreadAdapterError({
        kind: "invalid-response",
        operation: "threads.spawnRoot",
        code: "project_mismatch",
        message: "The host returned a different project.",
      });
    }
    return {
      threadId: thread.threadId,
      projectId: thread.projectId ?? input.projectId,
      parentThreadId: thread.parentThreadId,
      origin: "plugin",
      originPluginId: this.pluginId,
      acceptance: "accepted",
    };
  }

  async spawnChild(input: SpawnChildInput): Promise<SpawnReceipt> {
    const thread = normalizeThread(
      await callGateway(
        "threads.spawnChild",
        () =>
          this.gateway.spawn({
            projectId: input.projectId,
            input: textInput(input.prompt),
            environment: input.environment,
            ...(input.title ? { title: input.title } : {}),
            parentThreadId: input.parentThreadId,
            origin: "plugin",
            originPluginId: this.pluginId,
          }),
        threadRecordSchema,
      ),
      "threads.spawnChild",
    );
    if (
      thread.parentThreadId !== input.parentThreadId ||
      (thread.projectId !== null && thread.projectId !== input.projectId) ||
      (thread.originPluginId !== null &&
        thread.originPluginId !== this.pluginId)
    ) {
      throw new ThreadAdapterError({
        kind: "invalid-response",
        operation: "threads.spawnChild",
        code: "relationship_mismatch",
        message:
          "The host did not preserve the requested parent/project relationship.",
      });
    }
    return {
      threadId: thread.threadId,
      projectId: thread.projectId ?? input.projectId,
      parentThreadId: thread.parentThreadId,
      origin: "plugin",
      originPluginId: this.pluginId,
      acceptance: "accepted",
    };
  }

  async get(input: {
    threadId: string;
    signal?: AbortSignal;
  }): Promise<ThreadSnapshot> {
    return normalizeThread(
      await callGateway(
        "threads.get",
        () => this.gateway.get(input),
        threadRecordSchema,
      ),
      "threads.get",
    );
  }

  async wait(input: WaitInput): Promise<WaitReceipt> {
    const response = await callGateway(
      "threads.wait",
      () =>
        this.gateway.wait({
          threadId: input.threadId,
          ...(input.target.kind === "status"
            ? { status: input.target.status }
            : { event: input.target.eventType }),
          ...(input.timeoutMs === undefined
            ? {}
            : { timeoutMs: input.timeoutMs }),
          ...(input.pollIntervalMs === undefined
            ? {}
            : { pollIntervalMs: input.pollIntervalMs }),
          signal: input.signal,
        }),
      waitSchema,
    );
    const thread =
      response.thread === undefined
        ? null
        : normalizeThread(response.thread, "threads.wait.thread");
    const eventRecord =
      response.event === undefined
        ? null
        : parseAtBoundary(
            eventRecordSchema,
            response.event,
            "threads.wait.event",
          );
    return {
      threadId: response.threadId,
      matched: true,
      target: input.target,
      snapshot: thread,
      event: eventRecord
        ? {
            eventId: eventRecord.id,
            sequence: String(eventRecord.seq),
            threadId: eventRecord.threadId,
            type: eventRecord.type,
            occurredAt: normalizeDate(eventRecord.createdAt),
          }
        : null,
    };
  }

  async events(input: EventQuery): Promise<EventPage> {
    const events = await callGateway(
      "threads.events.list",
      () =>
        this.gateway.events.list({
          threadId: input.threadId,
          ...(input.afterSequence === undefined
            ? {}
            : { afterSeq: input.afterSequence }),
          ...(input.limit === undefined ? {} : { limit: String(input.limit) }),
          signal: input.signal,
        }),
      eventListSchema,
    );
    return {
      events: events.map((event) => ({
        eventId: event.id,
        sequence: String(event.seq),
        threadId: event.threadId,
        type: event.type,
        occurredAt: normalizeDate(event.createdAt),
      })),
    };
  }

  async timeline(input: {
    threadId: string;
    signal?: AbortSignal;
  }): Promise<TimelineSnapshot> {
    const response = await callGateway(
      "threads.timeline",
      () => this.gateway.timeline(input),
      timelineSchema,
    );
    return {
      rows: response.rows.map((row, index) => ({
        rowId: stringField(row, "id") ?? `row-${index}`,
        kind: stringField(row, "kind") ?? "unknown",
        text: stringField(row, "text") ?? stringField(row, "content"),
      })),
      maxSequence: String(response.maxSeq),
    };
  }

  async output(input: {
    threadId: string;
    signal?: AbortSignal;
  }): Promise<OutputSnapshot> {
    return callGateway(
      "threads.output",
      () => this.gateway.output(input),
      outputSchema,
    );
  }

  async pendingInteractions(input: {
    threadId: string;
    signal?: AbortSignal;
  }): Promise<PendingInteraction[]> {
    const interactions = await callGateway(
      "threads.interactions.list",
      () => this.gateway.interactions.list(input),
      interactionListSchema,
    );
    return interactions.map((interaction) => ({
      interactionId: interaction.id,
      kind: interaction.payload.kind,
      originKind: interaction.origin?.kind ?? null,
      status: interaction.status,
    }));
  }

  async sendNow(input: {
    threadId: string;
    prompt: string;
    signal?: AbortSignal;
  }): Promise<DeliveryReceipt> {
    return this.send(input, "send-now", "steer-if-active");
  }

  async sendNextTurn(input: {
    threadId: string;
    prompt: string;
    signal?: AbortSignal;
  }): Promise<DeliveryReceipt> {
    return this.send(input, "send-next-turn", "queue-if-active");
  }

  private async send(
    input: { threadId: string; prompt: string; signal?: AbortSignal },
    intent: "send-now" | "send-next-turn",
    mode: GatewaySendInput["mode"],
  ): Promise<DeliveryReceipt> {
    const receipt = normalizeReceipt({
      receiptId: this.receiptIds.nextId({ threadId: input.threadId, intent }),
      threadId: input.threadId,
      intent,
      acceptance: "unknown",
      application: "unknown",
    });
    try {
      await callGateway(
        `threads.send.${intent}`,
        () =>
          this.gateway.send({
            threadId: input.threadId,
            input: textInput(input.prompt),
            mode,
            signal: input.signal,
          }),
        acceptedResponseSchema,
      );
    } catch (error) {
      if (
        error instanceof ThreadAdapterError &&
        (error.kind === "transient" || error.kind === "unavailable")
      )
        throw new DeliveryUnknownError({
          operation: `threads.send.${intent}`,
          receipt,
          cause: error,
        });
      throw error;
    }
    return normalizeReceipt({ ...receipt, acceptance: "accepted" });
  }

  async queueCheckpointInput(input: {
    threadId: string;
    prompt: string;
  }): Promise<DeliveryReceipt> {
    const receipt = normalizeReceipt({
      receiptId: this.receiptIds.nextId({
        threadId: input.threadId,
        intent: "checkpoint",
      }),
      threadId: input.threadId,
      intent: "checkpoint",
      acceptance: "unknown",
      application: "unknown",
    });
    try {
      const queued = await callGateway(
        "threads.queuedMessages.create.checkpoint",
        () =>
          this.gateway.queuedMessages.create({
            threadId: input.threadId,
            input: textInput(input.prompt),
          }),
        queueMessageSchema,
      );
      const message = normalizeQueueMessage(
        queued,
        "threads.queuedMessages.create.checkpoint",
        { threadId: input.threadId, position: 0 },
      );
      return normalizeReceipt({
        ...receipt,
        acceptance: "accepted",
        application: "queued",
        queuedMessageId: message.queuedMessageId,
      });
    } catch (error) {
      if (
        error instanceof ThreadAdapterError &&
        (error.kind === "transient" || error.kind === "unavailable")
      )
        throw new DeliveryUnknownError({
          operation: "threads.queuedMessages.create.checkpoint",
          receipt,
          cause: error,
        });
      throw error;
    }
  }

  readonly queue = {
    list: async (input: {
      threadId: string;
      signal?: AbortSignal;
    }): Promise<QueueMessage[]> => {
      const messages = await callGateway(
        "threads.queuedMessages.list",
        () => this.gateway.queuedMessages.list(input),
        queueListSchema,
      );
      return messages.map((message, position) =>
        normalizeQueueMessage(message, "threads.queuedMessages.list", {
          threadId: input.threadId,
          position,
        }),
      );
    },
    update: async (input: {
      threadId: string;
      queuedMessageId: string;
      expectedUpdatedAt: number;
      prompt: string;
    }): Promise<QueueMessage> => {
      const message = await callGateway(
        "threads.queuedMessages.update",
        () =>
          this.gateway.queuedMessages.update({
            threadId: input.threadId,
            queuedMessageId: input.queuedMessageId,
            expectedUpdatedAt: input.expectedUpdatedAt,
            input: textInput(input.prompt),
          }),
        queueMessageSchema,
      );
      return normalizeQueueMessage(message, "threads.queuedMessages.update", {
        threadId: input.threadId,
        position: 0,
      });
    },
    delete: async (input: GatewayQueueTarget): Promise<void> => {
      await callGateway(
        "threads.queuedMessages.delete",
        () => this.gateway.queuedMessages.delete(input),
        acceptedResponseSchema,
      );
    },
    reorder: async (
      input: GatewayQueueReorderInput,
    ): Promise<QueueMessage[]> => {
      const messages = await callGateway(
        "threads.queuedMessages.reorder",
        () => this.gateway.queuedMessages.reorder(input),
        queueListSchema,
      );
      return messages.map((message, position) =>
        normalizeQueueMessage(message, "threads.queuedMessages.reorder", {
          threadId: input.threadId,
          position,
        }),
      );
    },
    send: async (input: GatewayQueueSendInput): Promise<DeliveryReceipt> => {
      const receipt = normalizeReceipt({
        receiptId: this.receiptIds.nextId({
          threadId: input.threadId,
          intent: "send-next-turn",
        }),
        threadId: input.threadId,
        intent: "send-next-turn",
        acceptance: "unknown",
        application: "unknown",
        queuedMessageId: input.queuedMessageId,
      });
      try {
        await callGateway(
          "threads.queuedMessages.send",
          () => this.gateway.queuedMessages.send(input),
          z
            .object({ ok: z.literal(true), queuedMessage: queueMessageSchema })
            .passthrough(),
        );
      } catch (error) {
        if (
          error instanceof ThreadAdapterError &&
          (error.kind === "transient" || error.kind === "unavailable")
        )
          throw new DeliveryUnknownError({
            operation: "threads.queuedMessages.send",
            receipt,
            cause: error,
          });
        throw error;
      }
      return normalizeReceipt({ ...receipt, acceptance: "accepted" });
    },
  };

  async stop(input: { threadId: string }): Promise<DeliveryReceipt> {
    const receipt = normalizeReceipt({
      receiptId: this.receiptIds.nextId({
        threadId: input.threadId,
        intent: "stop",
      }),
      threadId: input.threadId,
      intent: "stop",
      acceptance: "unknown",
      application: "stop-requested",
    });
    try {
      await callGateway(
        "threads.stop",
        () => this.gateway.stop(input),
        acceptedResponseSchema,
      );
    } catch (error) {
      if (
        error instanceof ThreadAdapterError &&
        (error.kind === "transient" || error.kind === "unavailable")
      )
        throw new DeliveryUnknownError({
          operation: "threads.stop",
          receipt,
          cause: error,
        });
      throw error;
    }
    return normalizeReceipt({ ...receipt, acceptance: "accepted" });
  }
}
