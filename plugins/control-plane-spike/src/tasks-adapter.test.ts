import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { ZodType } from "zod";

import {
  createTasksAdapter,
  createTasksRpcGateway,
  TasksDomainError,
  TasksIncompatibleError,
  TasksUnavailableError,
  TasksTransientError,
  type TasksPluginSdk,
  type TasksRpcCall,
  type TasksRpcGateway,
  type TasksScopeGuard,
} from "./tasks-adapter.js";

const projectId = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const taskId = "01ARZ3NDEKTSV4RRFFQ69G5FBV";
const presetId = "01ARZ3NDEKTSV4RRFFQ69G5FCV";
const threadId = "thr_01ARZ3NDEKTSV4RRFFQ69G5FDV";

const project = {
  id: projectId,
  name: "Control Plane",
  prefix: "CP",
  nextTaskNumber: 4,
  color: "blue",
  folderId: null,
  linkedBbProjectId: "proj_123",
  createdAt: "2026-08-12T00:00:00.000Z",
};

const task = {
  id: taskId,
  projectId,
  number: 3,
  key: "CP-3",
  title: "Connect Tasks",
  description: "",
  status: "backlog",
  priority: "none",
  dueDate: null,
  parentTaskId: null,
  position: 1,
  createdAt: "2026-08-12T00:00:00.000Z",
  updatedAt: "2026-08-12T00:00:00.000Z",
  labelIds: [],
};

const comment = {
  id: "01ARZ3NDEKTSV4RRFFQ69G5FEV",
  taskId,
  kind: "agent",
  authorName: "Steward",
  presetName: null,
  threadId,
  body: "Started",
  notifiedCount: 1,
  createdAt: "2026-08-12T00:00:00.000Z",
};

class FakeScopeGuard implements TasksScopeGuard {
  readonly delegation: string[] = [];
  readonly links: Array<{ taskId: string; threadId: string }> = [];
  denied = false;

  async authorizeTasksProject(input: { projectId: string }): Promise<void> {
    if (this.denied || input.projectId !== project.id) {
      throw new TasksDomainError({
        code: "scope_denied",
        message: "Project is outside the actor scope",
      });
    }
  }

  async authorizeTask(input: { taskId: string }): Promise<void> {
    if (this.denied || input.taskId !== taskId) {
      throw new TasksDomainError({
        code: "scope_denied",
        message: "Task is outside the actor scope",
      });
    }
  }

  async authorizeTaskThreadLink(input: {
    taskId: string;
    threadId: string;
  }): Promise<void> {
    if (this.denied) {
      throw new TasksDomainError({
        code: "scope_denied",
        message: "Thread is outside the actor scope",
      });
    }
    this.links.push(input);
  }
}

class FakeGateway implements TasksRpcGateway {
  readonly calls: Array<{ pluginId: string; method: string; input: unknown }> =
    [];
  pluginList: unknown = {
    plugins: [
      { id: "tasks", version: "0.1.1", enabled: true, status: "running" },
    ],
  };
  responses = new Map<string, unknown>();
  thrown = new Map<string, unknown>();

  pluginsList(): Promise<unknown> {
    return Promise.resolve(this.pluginList);
  }

  callRpc<T>(call: TasksRpcCall<T>): Promise<unknown> {
    this.calls.push({
      pluginId: call.pluginId,
      method: call.method,
      input: call.input,
    });
    const failure = this.thrown.get(call.method);
    if (failure !== undefined) return Promise.reject(failure);
    return Promise.resolve(this.responses.get(call.method));
  }
}

function readyGateway(): FakeGateway {
  const gateway = new FakeGateway();
  gateway.responses.set("ping", { ok: true, version: "0.1.1" });
  gateway.responses.set("listProjects", { projects: [project] });
  gateway.responses.set("getTask", { task });
  gateway.responses.set("createTask", { ok: true, task });
  gateway.responses.set("updateTask", { ok: true, task });
  gateway.responses.set("createComment", { comment });
  gateway.responses.set("delegate", { threadId });
  gateway.responses.set("taskThreadsAttach", { threadId });
  return gateway;
}

function readyAdapter(gateway: TasksRpcGateway = readyGateway()): {
  adapter: ReturnType<typeof createTasksAdapter>;
  scopeGuard: FakeScopeGuard;
} {
  const scopeGuard = new FakeScopeGuard();
  return { adapter: createTasksAdapter(gateway, scopeGuard), scopeGuard };
}

describe("TasksAdapter", () => {
  it("probes a running compatible Tasks plugin and separates expected from verified methods", async () => {
    const gateway = readyGateway();
    const { adapter } = readyAdapter(gateway);

    await expect(adapter.probe()).resolves.toEqual({
      status: "available",
      pluginId: "tasks",
      version: "0.1.1",
      expectedMethods: [
        "ping",
        "listProjects",
        "getTask",
        "createTask",
        "updateTask",
        "createComment",
        "delegate",
        "taskThreadsAttach",
      ],
      verifiedMethods: ["ping", "listProjects"],
      reason: "Tasks plugin, ping, and read-only project listing are available",
    });
    expect(gateway.calls.map((call) => call.method)).toEqual([
      "ping",
      "listProjects",
    ]);
    expect(gateway.calls[0]?.input).toBeNull();
    expect(gateway.calls[1]?.input).toEqual({});
  });

  it.each([
    ["missing", [], "unavailable"],
    [
      "disabled",
      [{ id: "tasks", version: "0.1.1", enabled: false, status: "disabled" }],
      "unavailable",
    ],
    [
      "degraded",
      [{ id: "tasks", version: "0.1.1", enabled: true, status: "degraded" }],
      "unavailable",
    ],
    [
      "error",
      [{ id: "tasks", version: "0.1.1", enabled: true, status: "error" }],
      "unavailable",
    ],
  ])(
    "reports %s Tasks state without calling RPCs",
    async (_name, plugins, status) => {
      const gateway = readyGateway();
      gateway.pluginList = { plugins };
      const capability = await readyAdapter(gateway).adapter.probe();
      expect(capability.status).toBe(status);
      expect(gateway.calls).toHaveLength(0);
    },
  );

  it("classifies unsupported versions and malformed read-only responses as incompatible", async () => {
    const oldVersion = readyGateway();
    oldVersion.pluginList = {
      plugins: [
        { id: "tasks", version: "1.0.0", enabled: true, status: "running" },
      ],
    };
    await expect(
      readyAdapter(oldVersion).adapter.probe(),
    ).resolves.toMatchObject({
      status: "incompatible",
      version: "1.0.0",
    });

    const malformedList = readyGateway();
    malformedList.responses.set("listProjects", {
      projects: [{ id: "not-a-ulid" }],
    });
    await expect(
      readyAdapter(malformedList).adapter.probe(),
    ).resolves.toMatchObject({
      status: "incompatible",
      verifiedMethods: [],
    });
  });

  it("sends omitted and explicit-null project filters distinctly and sends defaults", async () => {
    const gateway = readyGateway();
    gateway.responses.set("listProjects", {
      projects: [{ ...project, futureField: "accepted" }],
    });
    const { adapter } = readyAdapter(gateway);
    await adapter.probe();

    await expect(adapter.listProjects()).resolves.toHaveLength(1);
    expect(gateway.calls.at(-1)?.input).toEqual({});
    await adapter.listProjects({ folderId: null });
    expect(gateway.calls.at(-1)?.input).toEqual({ folderId: null });

    await adapter.createTask({ projectId, title: "Create" });
    expect(gateway.calls.at(-1)?.input).toEqual({
      projectId,
      title: "Create",
      description: "",
      status: "backlog",
      priority: "none",
      dueDate: null,
      parentTaskId: null,
      labelIds: [],
    });
  });

  it("maps task update, comment, delegation, and attach through the public RPCs", async () => {
    const gateway = readyGateway();
    const { adapter, scopeGuard } = readyAdapter(gateway);
    await adapter.probe();

    await adapter.updateTask({ taskId, status: "in_progress" });
    expect(gateway.calls.at(-1)?.input).toEqual({
      taskId,
      status: "in_progress",
      authorName: "You",
    });
    await adapter.createComment({ taskId, body: "hello", notify: true });
    expect(gateway.calls.at(-1)?.input).toEqual({
      taskId,
      body: "hello",
      notify: true,
      allowEmptyBody: false,
    });
    await expect(adapter.delegate({ taskId, presetId })).resolves.toBe(
      threadId,
    );
    await expect(adapter.attachThread({ taskId, threadId })).resolves.toBe(
      threadId,
    );
    expect(scopeGuard.links).toEqual([{ taskId, threadId }]);
  });

  it("maps realistic mutation domain errors without retrying", async () => {
    const gateway = readyGateway();
    gateway.responses.set("createTask", {
      ok: false,
      error: { code: "project_not_linked", message: "Project is not linked" },
    });
    const { adapter } = readyAdapter(gateway);
    await adapter.probe();
    await expect(
      adapter.createTask({ projectId, title: "Create" }),
    ).rejects.toMatchObject({
      kind: "domain-error",
      code: "project_not_linked",
    });
    expect(
      gateway.calls.filter((call) => call.method === "createTask"),
    ).toHaveLength(1);
  });

  it("maps malformed outputs, unknown methods, and transient failures", async () => {
    const malformed = readyGateway();
    malformed.responses.set("listProjects", {
      projects: [{ id: "not-a-ulid" }],
    });
    const malformedAdapter = readyAdapter(malformed).adapter;
    await expect(malformedAdapter.probe()).resolves.toMatchObject({
      status: "incompatible",
    });

    const unknownMethod = readyGateway();
    unknownMethod.thrown.set("listProjects", {
      code: "unknown_method",
      message: "not supported",
    });
    const unknownAdapter = readyAdapter(unknownMethod).adapter;
    await expect(unknownAdapter.probe()).resolves.toMatchObject({
      status: "incompatible",
    });

    const missingPlugin = readyGateway();
    missingPlugin.thrown.set("listProjects", {
      status: 404,
      body: { message: "plugin missing" },
    });
    const missingAdapter = readyAdapter(missingPlugin).adapter;
    await missingAdapter.probe();
    await expect(missingAdapter.listProjects()).rejects.toBeInstanceOf(
      TasksUnavailableError,
    );

    const transient = readyGateway();
    transient.thrown.set("listProjects", {
      status: 500,
      body: { message: "temporarily unavailable" },
    });
    const transientAdapter = readyAdapter(transient).adapter;
    await expect(transientAdapter.probe()).resolves.toMatchObject({
      status: "unavailable",
    });
    await expect(transientAdapter.listProjects()).rejects.toBeInstanceOf(
      TasksUnavailableError,
    );
  });

  it("requires scope authorization before delegation and attachment", async () => {
    const gateway = readyGateway();
    const scopeGuard = new FakeScopeGuard();
    scopeGuard.denied = true;
    const adapter = createTasksAdapter(gateway, scopeGuard);
    await adapter.probe();
    await expect(adapter.delegate({ taskId, presetId })).rejects.toMatchObject({
      code: "scope_denied",
    });
    await expect(
      adapter.attachThread({ taskId, threadId }),
    ).rejects.toMatchObject({ code: "scope_denied" });
    expect(
      gateway.calls.filter(
        (call) =>
          call.method === "delegate" || call.method === "taskThreadsAttach",
      ),
    ).toHaveLength(0);
  });

  it("rejects invalid calendar dates and empty updates", async () => {
    const { adapter } = readyAdapter();
    await adapter.probe();
    await expect(
      adapter.createTask({ projectId, title: "bad", dueDate: "2026-02-30" }),
    ).rejects.toThrow("real calendar date");
    await expect(adapter.updateTask({ taskId })).rejects.toThrow(
      "At least one task field",
    );
  });

  it("creates a gateway from the structural SDK surface", async () => {
    const gateway = readyGateway();
    const sdk: TasksPluginSdk = {
      plugins: {
        list: () => gateway.pluginsList(),
        callRpc: async <T>(input: {
          pluginId: string;
          method: string;
          input?: unknown;
          outputSchema: ZodType<T>;
        }): Promise<T> => {
          const response = await gateway.callRpc({
            pluginId: input.pluginId,
            method: input.method,
            input: input.input ?? null,
            outputSchema: input.outputSchema,
          });
          return input.outputSchema.parse(response);
        },
      },
    };
    const { adapter } = readyAdapter(createTasksRpcGateway(sdk));
    await expect(adapter.probe()).resolves.toMatchObject({
      verifiedMethods: ["ping", "listProjects"],
    });
    expect(gateway.calls.map((call) => call.method)).toEqual([
      "ping",
      "listProjects",
    ]);
  });

  it("does not import the Tasks plugin implementation", () => {
    const source = readFileSync(
      resolve(import.meta.dirname, "tasks-adapter.ts"),
      "utf8",
    );
    expect(source).not.toContain("plugins/tasks");
  });
});
