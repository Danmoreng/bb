// @vitest-environment jsdom
import { cleanup } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadPluginApp, renderSlot } from "@bb/plugin-sdk/testing/app";

const app = await loadPluginApp(() => import("./app"));
afterEach(cleanup);

function projectIdFromInput(input: unknown): string {
  if (
    typeof input !== "object" ||
    input === null ||
    !("projectId" in input) ||
    typeof input.projectId !== "string"
  ) {
    throw new Error("Expected a project-scoped RPC input");
  }
  return input.projectId;
}

describe("control-plane spike app", () => {
  it("registers a diagnostics nav panel", () => {
    expect(app.navPanels[0]).toMatchObject({
      id: "control-plane-spike",
      title: "Control Plane Spike",
      path: "control-plane-spike",
    });
  });

  it("renders the no-project state", async () => {
    const slot = renderSlot(
      app.navPanels[0]!,
      { subPath: "" },
      {
        context: { projectId: null },
        rpc: {
          projectContext: () => ({
            status: "unconfigured",
            configuredProject: null,
            error: "Configure a project first.",
          }),
        },
      },
    );
    expect(
      await slot.findByText(/No Control Plane project configured/),
    ).toBeTruthy();
  });

  it("uses the configured project on the global nav route", async () => {
    const snapshotProjectIds: string[] = [];
    const stewardProjectIds: string[] = [];
    const slot = renderSlot(
      app.navPanels[0]!,
      { subPath: "" },
      {
        context: { projectId: null },
        rpc: {
          projectContext: () => ({
            status: "ready",
            configuredProject: { id: "project-one", name: "Project One" },
            error: null,
          }),
          snapshot: (input) => {
            snapshotProjectIds.push(projectIdFromInput(input));
            return {
              projectId: "project-one",
              observationCount: 3,
              lifecycleEvents: [],
              revision: 1,
              error: null,
            };
          },
          stewardStatus: (input) => {
            stewardProjectIds.push(projectIdFromInput(input));
            return { status: "uninitialized", threadId: null, error: null };
          },
          tasksCapability: () => ({
            status: "unavailable",
            pluginId: "tasks",
            version: null,
            expectedMethods: [],
            verifiedMethods: [],
            reason: "not configured",
          }),
        },
      },
    );
    expect(await slot.findByText("Project One")).toBeTruthy();
    expect((await slot.findByLabelText("Observation count")).textContent).toBe(
      "3",
    );
    expect(snapshotProjectIds).toEqual(["project-one"]);
    expect(stewardProjectIds).toEqual(["project-one"]);
  });

  it("blocks a route for a different project before loading project data", async () => {
    const calls: string[] = [];
    const slot = renderSlot(
      app.navPanels[0]!,
      { subPath: "" },
      {
        context: { projectId: "project-two" },
        rpc: {
          projectContext: () => ({
            status: "ready",
            configuredProject: { id: "project-one", name: "Project One" },
            error: null,
          }),
          snapshot: () => {
            calls.push("snapshot");
            return {
              projectId: "project-one",
              observationCount: 1,
              lifecycleEvents: [],
              revision: 1,
              error: null,
            };
          },
        },
      },
    );
    expect(await slot.findByRole("alert")).toBeTruthy();
    expect(slot.getByText(/configured for project-one/)).toBeTruthy();
    expect(calls).toEqual([]);
  });

  it("clears the old Steward when the configured project changes", async () => {
    let configuredId = "project-one";
    const snapshotProjectIds: string[] = [];
    const stewardProjectIds: string[] = [];
    const slot = renderSlot(
      app.navPanels[0]!,
      { subPath: "" },
      {
        context: { projectId: null },
        rpc: {
          projectContext: () => ({
            status: "ready",
            configuredProject: {
              id: configuredId,
              name:
                configuredId === "project-one" ? "Project One" : "Project Two",
            },
            error: null,
          }),
          snapshot: (input) => {
            snapshotProjectIds.push(projectIdFromInput(input));
            return {
              projectId: configuredId,
              observationCount: 1,
              lifecycleEvents: [],
              revision: 1,
              error: null,
            };
          },
          tasksCapability: () => ({
            status: "unavailable",
            pluginId: "tasks",
            version: null,
            expectedMethods: [],
            verifiedMethods: [],
            reason: "not configured",
          }),
          stewardStatus: (input) => {
            stewardProjectIds.push(projectIdFromInput(input));
            return {
              status: "ready",
              threadId: `thr_${configuredId}`,
              error: null,
            };
          },
        },
      },
    );
    expect(
      await slot.findByText(/ThreadChat stub \(thr_project-one\)/),
    ).toBeTruthy();
    configuredId = "project-two";
    await slot.emitRealtime("control-plane-spike-context-changed", {
      revision: 2,
    });
    expect(
      await slot.findByText(/ThreadChat stub \(thr_project-two\)/),
    ).toBeTruthy();
    expect(slot.queryByText(/ThreadChat stub \(thr_project-one\)/)).toBeNull();
    expect(snapshotProjectIds).toEqual(["project-one", "project-two"]);
    expect(stewardProjectIds).toEqual(["project-one", "project-two"]);
  });

  it("loads data and refetches after a realtime signal", async () => {
    let calls = 0;
    const slot = renderSlot(
      app.navPanels[0]!,
      { subPath: "" },
      {
        context: { projectId: "project-one" },
        rpc: {
          projectContext: () => ({
            status: "ready",
            configuredProject: { id: "project-one", name: "Project One" },
            error: null,
          }),
          snapshot: () => {
            calls += 1;
            return {
              projectId: "project-one",
              observationCount: calls,
              lifecycleEvents: [],
              revision: calls,
              error: null,
            };
          },
        },
      },
    );
    expect((await slot.findByLabelText("Observation count")).textContent).toBe(
      "1",
    );
    await slot.emitRealtime("control-plane-spike-changed", {
      projectId: "project-one",
      revision: 2,
    });
    expect((await slot.findByLabelText("Observation count")).textContent).toBe(
      "2",
    );
    expect(calls).toBe(2);
  });

  it("renders the host-owned ThreadChat for a persistent Steward", async () => {
    const slot = renderSlot(
      app.navPanels[0]!,
      { subPath: "" },
      {
        context: { projectId: "project-one" },
        rpc: {
          projectContext: () => ({
            status: "ready",
            configuredProject: { id: "project-one", name: "Project One" },
            error: null,
          }),
          snapshot: () => ({
            projectId: "project-one",
            observationCount: 0,
            lifecycleEvents: [],
            revision: 1,
            error: null,
          }),
          tasksCapability: () => ({
            status: "unavailable",
            pluginId: "tasks",
            version: null,
            expectedMethods: [],
            verifiedMethods: [],
            reason: "not configured",
          }),
          stewardStatus: () => ({
            status: "ready",
            threadId: "thr_steward",
            error: null,
          }),
        },
      },
    );
    expect(
      await slot.findByText(/ThreadChat stub \(thr_steward\)/),
    ).toBeTruthy();
  });

  it("ignores stale realtime responses and refetches after reconnect", async () => {
    const resolvers: Array<
      (snapshot: {
        projectId: string;
        observationCount: number;
        lifecycleEvents: string[];
        revision: number;
        error: null;
      }) => void
    > = [];
    const slot = renderSlot(
      app.navPanels[0]!,
      { subPath: "" },
      {
        context: { projectId: "project-one" },
        realtimeConnectionState: "connected",
        rpc: {
          projectContext: () => ({
            status: "ready",
            configuredProject: { id: "project-one", name: "Project One" },
            error: null,
          }),
          snapshot: () =>
            new Promise((resolve) => {
              resolvers.push(resolve);
            }),
        },
      },
    );
    await vi.waitFor(() => expect(resolvers).toHaveLength(1));
    await slot.emitRealtime("control-plane-spike-changed", {
      projectId: "project-one",
      revision: 2,
    });
    expect(resolvers).toHaveLength(1);
    resolvers[0]!({
      projectId: "project-one",
      observationCount: 1,
      lifecycleEvents: [],
      revision: 1,
      error: null,
    });
    await vi.waitFor(() => expect(resolvers).toHaveLength(2));
    resolvers[1]!({
      projectId: "project-one",
      observationCount: 2,
      lifecycleEvents: [],
      revision: 2,
      error: null,
    });
    expect((await slot.findByLabelText("Observation count")).textContent).toBe(
      "2",
    );

    let reconnectCalls = 0;
    const reconnectSlot = renderSlot(
      app.navPanels[0]!,
      { subPath: "" },
      {
        context: { projectId: "project-one" },
        realtimeConnectionState: "connected",
        rpc: {
          projectContext: () => ({
            status: "ready",
            configuredProject: { id: "project-one", name: "Project One" },
            error: null,
          }),
          snapshot: () => {
            reconnectCalls += 1;
            return {
              projectId: "project-one",
              observationCount: reconnectCalls,
              lifecycleEvents: [],
              revision: reconnectCalls,
              error: null,
            };
          },
        },
      },
    );
    await reconnectSlot.findByLabelText("Observation count");
    await reconnectSlot.setRealtimeConnectionState("reconnecting");
    await new Promise((resolve) => setTimeout(resolve, 0));
    await reconnectSlot.setRealtimeConnectionState("connected");
    await vi.waitFor(() => expect(reconnectCalls).toBe(2));
  });

  it("shows RPC failures with a retry action", async () => {
    const slot = renderSlot(
      app.navPanels[0]!,
      { subPath: "" },
      {
        context: { projectId: "project-one" },
        rpc: {
          projectContext: () => ({
            status: "ready",
            configuredProject: { id: "project-one", name: "Project One" },
            error: null,
          }),
          snapshot: () => Promise.reject(new Error("backend unavailable")),
        },
      },
    );
    expect(await slot.findByRole("alert")).toBeTruthy();
    expect(slot.getByText("backend unavailable")).toBeTruthy();
    expect(slot.getByRole("button", { name: "Retry" })).toBeTruthy();
  });
});
