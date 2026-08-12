import { afterEach, describe, expect, it } from "vitest";
import { createFakePluginHost } from "@bb/plugin-sdk/testing";
import type { FakeSdkOverrides } from "@bb/plugin-sdk/testing";
import plugin from "./server.js";

const project = {
  id: "project-one",
  kind: "standard" as const,
  name: "Project One",
  gitRemoteUrl: null,
};
const otherProject = { ...project, id: "project-two", name: "Project Two" };
const tasksProjectId = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const tasksTaskId = "01ARZ3NDEKTSV4RRFFQ69G5FBV";
const tasksProject = {
  id: tasksProjectId,
  name: "Tasks Project",
  prefix: "CP",
  nextTaskNumber: 2,
  color: "blue",
  folderId: null,
  linkedBbProjectId: "proj_personal",
  createdAt: "2026-08-12T00:00:00.000Z",
};
const tasksTask = {
  id: tasksTaskId,
  projectId: tasksProjectId,
  number: 1,
  key: "CP-1",
  title: "Existing task",
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

const hosts: Array<ReturnType<typeof createFakePluginHost>> = [];
afterEach(async () => {
  for (const host of hosts.splice(0)) await host.harness.dispose();
});

async function load(
  settings: Record<string, string> = {},
  sdk?: FakeSdkOverrides,
) {
  const host = createFakePluginHost({
    pluginId: "control-plane-spike",
    settings,
    sdk,
  });
  hosts.push(host);
  await plugin(host.bb);
  return host;
}

describe("control-plane capability spike", () => {
  it("persists observations across reload and emits realtime signals", async () => {
    const host = await load({ configuredProject: project.id });
    expect(
      await host.harness.callRpc("snapshot", { projectId: project.id }),
    ).toMatchObject({
      observationCount: 0,
      projectId: project.id,
    });
    const result = await host.harness.callRpc("recordObservation", {
      projectId: project.id,
      message: "storage works",
    });
    expect(result).toMatchObject({ observationCount: 1 });
    await expect(
      host.harness.callRpc("recordObservation", {
        projectId: otherProject.id,
        message: "must be rejected",
      }),
    ).resolves.toMatchObject({
      projectId: null,
      observationCount: 0,
      error: expect.stringContaining("write access denied"),
    });
    await expect(
      host.harness.callRpc("snapshot", { projectId: otherProject.id }),
    ).resolves.toMatchObject({
      projectId: null,
      observationCount: 0,
      error: expect.stringContaining("read access denied"),
    });
    expect(host.harness.realtimeSignals).toEqual([
      {
        channel: "control-plane-spike-changed",
        payload: { projectId: project.id, revision: 1 },
      },
    ]);

    const reloaded = await host.harness.reload(plugin);
    hosts.push(reloaded);
    await expect(
      reloaded.harness.callRpc("snapshot", { projectId: project.id }),
    ).resolves.toMatchObject({
      observationCount: 1,
    });
  });

  it("limits tool configuration and instructions to the configured project", async () => {
    const host = await load({ configuredProject: project.id });
    const enabled = await host.harness.resolveAgentConfiguration({
      thread: {
        id: "thread-one",
        title: null,
        parentThreadId: null,
        sourceThreadId: null,
      },
      project,
      environment: {
        id: "environment",
        name: null,
        path: null,
        workspaceProvisionType: "unmanaged",
        branchName: null,
      },
      host: { id: "host", name: "Host" },
      provider: { id: "provider", model: "model" },
      origin: { kind: null, pluginId: null },
    });
    expect(enabled.tools.map((tool) => tool.name)).toContain("cp_spike_record");
    expect(enabled.instructions).toBeNull();
    const instructionProvider =
      host.harness.inspection.registrations.instructionProvider;
    expect(instructionProvider).not.toBeNull();
    if (!instructionProvider)
      throw new Error("instruction provider was not registered");
    expect(
      instructionProvider({ threadId: "thread-one", projectId: project.id }),
    ).toContain("capability spike");

    const disabled = await host.harness.resolveAgentConfiguration({
      thread: {
        id: "thread-two",
        title: null,
        parentThreadId: null,
        sourceThreadId: null,
      },
      project: otherProject,
      environment: {
        id: "environment",
        name: null,
        path: null,
        workspaceProvisionType: "unmanaged",
        branchName: null,
      },
      host: { id: "host", name: "Host" },
      provider: { id: "provider", model: "model" },
      origin: { kind: null, pluginId: null },
    });
    expect(disabled.tools).toHaveLength(0);
    expect(disabled.instructions).toBeNull();
    expect(
      instructionProvider({
        threadId: "thread-two",
        projectId: otherProject.id,
      }),
    ).toBeNull();
  });

  it("switches the configured project without exposing the previous scope", async () => {
    const host = await load({ configuredProject: project.id });
    await host.harness.setSettings({ configuredProject: otherProject.id });
    await expect(
      host.harness.callRpc("recordObservation", {
        projectId: project.id,
        message: "old scope",
      }),
    ).resolves.toMatchObject({
      projectId: null,
      error: expect.stringContaining("write access denied"),
    });
    await expect(
      host.harness.callRpc("recordObservation", {
        projectId: otherProject.id,
        message: "new scope",
      }),
    ).resolves.toMatchObject({ observationCount: 1 });
    await expect(
      host.harness.callRpc("snapshot", { projectId: project.id }),
    ).resolves.toMatchObject({
      projectId: null,
      error: expect.stringContaining("read access denied"),
    });
  });

  it("validates and executes the configured agent tool", async () => {
    const host = await load({ configuredProject: project.id });
    await expect(
      host.harness.callAgentTool(
        "cp_spike_record",
        { message: "tool works" },
        { projectId: project.id },
      ),
    ).resolves.toEqual({
      content: [{ type: "text", text: "Recorded observation 1." }],
    });
    await expect(
      host.harness.callAgentTool(
        "cp_spike_record",
        { message: "blocked" },
        { projectId: otherProject.id },
      ),
    ).resolves.toMatchObject({ isError: true });
    await expect(
      host.harness.callAgentTool(
        "cp_spike_record",
        { message: "" },
        { projectId: project.id },
      ),
    ).rejects.toThrow();
  });

  it("exposes Tasks RPCs through the real SDK gateway and denies another project", async () => {
    const calls: Array<{ method: string; input: unknown }> = [];
    const sdk = {
      plugins: {
        list: async () => ({
          plugins: [
            { id: "tasks", version: "0.1.1", enabled: true, status: "running" },
          ],
        }),
        callRpc: async (input: { method: string; input?: unknown }) => {
          calls.push({ method: input.method, input: input.input });
          switch (input.method) {
            case "ping":
              return { ok: true, version: "0.1.1" };
            case "listProjects":
              return { projects: [tasksProject] };
            case "getTask":
              return { task: tasksTask };
            case "createTask":
              return { ok: true, task: tasksTask };
            case "updateTask":
              return { ok: true, task: tasksTask };
            case "createComment":
              return {
                comment: {
                  id: "01ARZ3NDEKTSV4RRFFQ69G5FEV",
                  taskId: tasksTaskId,
                  kind: "agent",
                  authorName: "Spike",
                  presetName: null,
                  threadId: null,
                  body: "ok",
                  notifiedCount: 0,
                  createdAt: "2026-08-12T00:00:00.000Z",
                },
              };
            case "delegate":
              return { threadId: "thr_01ARZ3NDEKTSV4RRFFQ69G5FDV" };
            case "taskThreadsAttach":
              return { threadId: "thr_01ARZ3NDEKTSV4RRFFQ69G5FDV" };
            default:
              throw new Error(`unexpected Tasks method ${input.method}`);
          }
        },
      },
      threads: {
        get: async () => ({ projectId: "proj_personal" }),
      },
    };
    const host = await load({ configuredProject: "proj_personal" }, sdk);
    const capability = await host.harness.callRpc("tasksCapability", {});
    expect(capability).toMatchObject({
      status: "available",
      verifiedMethods: ["ping", "listProjects"],
    });
    await expect(
      host.harness.callRpc("tasksListProjects", {}),
    ).resolves.toMatchObject({ ok: true });
    await expect(
      host.harness.callRpc("tasksCreateTask", {
        tasksProjectId: tasksProjectId,
        title: "New task",
      }),
    ).resolves.toMatchObject({ ok: true });
    await expect(
      host.harness.callRpc("tasksUpdateTask", {
        taskId: tasksTaskId,
        status: "todo",
      }),
    ).resolves.toMatchObject({ ok: true });
    await expect(
      host.harness.callRpc("tasksCreateComment", {
        taskId: tasksTaskId,
        body: "hello",
        notify: true,
      }),
    ).resolves.toMatchObject({ ok: true });
    await expect(
      host.harness.callRpc("tasksDelegate", {
        taskId: tasksTaskId,
        presetId: "01ARZ3NDEKTSV4RRFFQ69G5FCV",
      }),
    ).resolves.toMatchObject({ ok: true });
    await expect(
      host.harness.callRpc("tasksAttachThread", {
        taskId: tasksTaskId,
        threadId: "thr_01ARZ3NDEKTSV4RRFFQ69G5FDV",
      }),
    ).resolves.toMatchObject({ ok: true });
    expect(calls.some((call) => call.method === "createTask")).toBe(true);
    const denied = await host.harness.callRpc("tasksCreateTask", {
      tasksProjectId: "01ARZ3NDEKTSV4RRFFQ69G5FZZ",
      title: "Denied",
    });
    expect(denied).toMatchObject({
      ok: false,
      error: { code: "scope_denied" },
    });
    expect(calls.filter((call) => call.method === "createTask")).toHaveLength(
      1,
    );
  });

  it("stops its abort-sensitive background service on dispose", async () => {
    const host = await load();
    const service = host.harness.runService("control-plane-spike-heartbeat");
    await host.harness.dispose();
    await expect(service.done).resolves.toBeUndefined();
  });
});
