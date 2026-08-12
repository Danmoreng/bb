import { describe, expect, it } from "vitest";
import {
  createThreadSdkGateway,
  DeliveryUnknownError,
  SdkThreadHost,
  ThreadAdapterError,
  type GatewayQueueCreateInput,
  type GatewaySendInput,
  type GatewaySpawnInput,
  type ThreadSdkGateway,
  type ThreadSdkSurface,
} from "./thread-adapter.js";

function thread(id: string, parentThreadId: string | null = null) {
  return {
    id,
    projectId: "project-1",
    parentThreadId,
    status: "idle",
    providerThreadId: `provider-${id}`,
    updatedAt: "2026-08-12T00:00:00.000Z",
  };
}

function queuedMessage(id: string, content = `queued-${id}`) {
  return {
    id,
    content: [{ type: "text", text: content, mentions: [] }],
    model: "model",
    reasoningLevel: "default",
    permissionMode: "default",
    serviceTier: "standard",
    groupWithNext: false,
    createdAt: 1,
    updatedAt: 1,
  };
}

function gateway() {
  const calls: {
    spawn: GatewaySpawnInput[];
    send: GatewaySendInput[];
    checkpoint: GatewayQueueCreateInput[];
    events: Array<Record<string, unknown>>;
    stop: Array<Record<string, unknown>>;
  } = { spawn: [], send: [], checkpoint: [], events: [], stop: [] };
  const queue = queuedMessage("queued-1");
  const value: ThreadSdkGateway = {
    spawn: async (input) => {
      calls.spawn.push(input);
      return thread(
        input.parentThreadId ? "child-1" : "thread-1",
        input.parentThreadId ?? null,
      );
    },
    get: async () => thread("thread-1"),
    wait: async () => ({
      matched: true,
      threadId: "thread-1",
      target: { kind: "status" },
      thread: thread("thread-1"),
    }),
    events: {
      list: async (input) => {
        calls.events.push(input);
        return [
          {
            id: "event-1",
            seq: 7,
            threadId: "thread-1",
            type: "turn/started",
            createdAt: "2026-08-12T00:00:00.000Z",
          },
        ];
      },
    },
    timeline: async () => ({
      rows: [{ id: "row-1", kind: "message", text: "hello" }],
      maxSeq: 7,
    }),
    output: async () => ({ output: "done" }),
    interactions: {
      list: async () => [
        {
          id: "interaction-1",
          threadId: "thread-1",
          status: "pending",
          payload: { kind: "user_question" },
          origin: { kind: "provider" },
        },
      ],
    },
    send: async (input) => {
      calls.send.push(input);
      return { ok: true };
    },
    queuedMessages: {
      create: async (input) => {
        calls.checkpoint.push(input);
        return { ...queue, content: input.input };
      },
      list: async () => [queue],
      update: async (input) => ({
        ...queue,
        id: input.queuedMessageId,
        content: input.input,
        updatedAt: input.expectedUpdatedAt + 1,
      }),
      delete: async () => ({ ok: true }),
      reorder: async () => [queue],
      send: async (input) => ({
        ok: true,
        queuedMessage: { ...queue, id: input.queuedMessageId },
      }),
    },
    stop: async (input) => {
      calls.stop.push(input);
      return { ok: true };
    },
  };
  return { gateway: value, calls };
}

function createHost() {
  const fake = gateway();
  return {
    fake,
    host: new SdkThreadHost({
      gateway: fake.gateway,
      pluginId: "control-plane-spike",
      receiptIds: { nextId: ({ threadId, intent }) => `${intent}:${threadId}` },
    }),
  };
}

const environment = { type: "project-default" } as const;

describe("createThreadSdkGateway", () => {
  it("maps the public SDK surface without changing its request semantics", async () => {
    const fake = gateway();
    const calls: GatewaySpawnInput[] = [];
    const sdk: ThreadSdkSurface = {
      threads: {
        ...fake.gateway,
        spawn: async (input) => {
          calls.push(input);
          return fake.gateway.spawn(input);
        },
      },
    };
    const mapped = createThreadSdkGateway(sdk);
    await mapped.spawn({
      projectId: "project-1",
      input: [{ type: "text", text: "hi", mentions: [] }],
      environment,
      origin: "plugin",
      originPluginId: "control-plane-spike",
    });
    expect(calls[0]).toMatchObject({
      projectId: "project-1",
      environment,
      origin: "plugin",
      originPluginId: "control-plane-spike",
    });
  });
});

describe("SdkThreadHost", () => {
  it("preserves environment, plugin attribution, and parent/child relationships", async () => {
    const { fake, host } = createHost();
    const root = await host.spawnRoot({
      projectId: "project-1",
      prompt: "root",
      environment,
    });
    const child = await host.spawnChild({
      projectId: "project-1",
      parentThreadId: root.threadId,
      prompt: "child",
      environment: { type: "reuse", environmentId: "env-1" },
    });
    expect(root).toMatchObject({
      threadId: "thread-1",
      parentThreadId: null,
      origin: "plugin",
    });
    expect(child).toMatchObject({
      threadId: "child-1",
      parentThreadId: "thread-1",
    });
    expect(fake.calls.spawn).toEqual([
      expect.objectContaining({
        environment,
        origin: "plugin",
        originPluginId: "control-plane-spike",
      }),
      expect.objectContaining({
        environment: { type: "reuse", environmentId: "env-1" },
        parentThreadId: "thread-1",
      }),
    ]);
  });

  it("maps send modes but never claims steering or provider execution", async () => {
    const { fake, host } = createHost();
    const now = await host.sendNow({ threadId: "thread-1", prompt: "nudge" });
    const next = await host.sendNextTurn({
      threadId: "thread-1",
      prompt: "next",
    });
    expect(fake.calls.send.map((call) => call.mode)).toEqual([
      "steer-if-active",
      "queue-if-active",
    ]);
    expect(now).toMatchObject({
      acceptance: "accepted",
      application: "unknown",
    });
    expect(next).toMatchObject({
      acceptance: "accepted",
      application: "unknown",
    });
  });

  it("uses an explicit checkpoint queue and supports queue CRUD", async () => {
    const { fake, host } = createHost();
    const checkpoint = await host.queueCheckpointInput({
      threadId: "thread-1",
      prompt: "at checkpoint",
    });
    const list = await host.queue.list({ threadId: "thread-1" });
    const updated = await host.queue.update({
      threadId: "thread-1",
      queuedMessageId: "queued-1",
      expectedUpdatedAt: 1,
      prompt: "updated",
    });
    await host.queue.delete({
      threadId: "thread-1",
      queuedMessageId: "queued-1",
    });
    const reordered = await host.queue.reorder({
      threadId: "thread-1",
      queuedMessageId: "queued-1",
      previousQueuedMessageId: null,
      nextQueuedMessageId: null,
    });
    const sent = await host.queue.send({
      threadId: "thread-1",
      queuedMessageId: "queued-1",
      mode: "auto",
    });
    expect(fake.calls.checkpoint).toHaveLength(1);
    expect(checkpoint).toMatchObject({
      intent: "checkpoint",
      acceptance: "accepted",
      application: "queued",
      queuedMessageId: "queued-1",
    });
    expect(list[0]).toMatchObject({ queuedMessageId: "queued-1" });
    expect(updated.input[0]).toMatchObject({ type: "text", text: "updated" });
    expect(reordered).toHaveLength(1);
    expect(sent).toMatchObject({
      acceptance: "accepted",
      application: "unknown",
      queuedMessageId: "queued-1",
    });
  });

  it("normalizes real event, timeline, output, and pending interaction shapes", async () => {
    const { fake, host } = createHost();
    await expect(
      host.events({ threadId: "thread-1", afterSequence: "6", limit: 10 }),
    ).resolves.toMatchObject({
      events: [{ eventId: "event-1", sequence: "7", type: "turn/started" }],
    });
    expect(fake.calls.events[0]).toMatchObject({ afterSeq: "6", limit: "10" });
    await expect(host.timeline({ threadId: "thread-1" })).resolves.toEqual({
      rows: [{ rowId: "row-1", kind: "message", text: "hello" }],
      maxSequence: "7",
    });
    await expect(host.output({ threadId: "thread-1" })).resolves.toEqual({
      output: "done",
    });
    await expect(
      host.pendingInteractions({ threadId: "thread-1" }),
    ).resolves.toEqual([
      {
        interactionId: "interaction-1",
        kind: "user_question",
        originKind: "provider",
        status: "pending",
      },
    ]);
  });

  it("passes AbortSignal to wait and maps specific host errors", async () => {
    const { fake, host } = createHost();
    const controller = new AbortController();
    const wait = host.wait({
      threadId: "thread-1",
      target: { kind: "status", status: "idle" },
      signal: controller.signal,
    });
    expect(await wait).toMatchObject({ matched: true });
    fake.gateway.send = async () => {
      throw { status: 409, body: { code: "stale_queued_message" } };
    };
    await expect(
      host.sendNow({ threadId: "thread-1", prompt: "stale" }),
    ).rejects.toMatchObject({
      kind: "domain-error",
      code: "stale_queued_message",
    });
    fake.gateway.get = async () => {
      throw { status: 404, body: { code: "thread_not_found" } };
    };
    await expect(host.get({ threadId: "thread-1" })).rejects.toMatchObject({
      kind: "domain-error",
      code: "thread_not_found",
    });
  });

  it("returns a stable unknown-delivery receipt after a mutation transport failure", async () => {
    const { fake, host } = createHost();
    fake.gateway.send = async () => {
      throw { status: 503 };
    };
    await expect(
      host.sendNow({ threadId: "thread-1", prompt: "maybe accepted" }),
    ).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof DeliveryUnknownError &&
        error.receipt.acceptance === "unknown" &&
        error.receipt.receiptId === "send-now:thread-1",
    );
  });

  it("rejects malformed responses and does not retry mutations", async () => {
    const { fake, host } = createHost();
    fake.gateway.spawn = async () => ({ malformed: true });
    await expect(
      host.spawnRoot({ projectId: "project-1", prompt: "root", environment }),
    ).rejects.toMatchObject({
      kind: "invalid-response",
      operation: "threads.spawnRoot",
    });
    let attempts = 0;
    fake.gateway.send = async () => {
      attempts += 1;
      throw { status: 503 };
    };
    await expect(
      host.sendNow({ threadId: "thread-1", prompt: "do not retry" }),
    ).rejects.toBeInstanceOf(DeliveryUnknownError);
    expect(attempts).toBe(1);
  });

  it("reports stop as an accepted server request, not provider completion", async () => {
    const { fake, host } = createHost();
    const receipt = await host.stop({ threadId: "thread-1" });
    expect(fake.calls.stop).toEqual([{ threadId: "thread-1" }]);
    expect(receipt).toMatchObject({
      acceptance: "accepted",
      application: "stop-requested",
    });
  });

  it("keeps the adapter error type available for callers", () => {
    expect(
      new ThreadAdapterError({
        kind: "domain-error",
        operation: "test",
        code: "x",
        message: "x",
      }),
    ).toBeInstanceOf(Error);
  });
});
