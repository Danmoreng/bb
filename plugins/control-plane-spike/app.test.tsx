// @vitest-environment jsdom
import { cleanup } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { loadPluginApp, renderSlot } from "@bb/plugin-sdk/testing/app";

const app = await loadPluginApp(() => import("./app"));
afterEach(cleanup);

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
      { context: { projectId: null } },
    );
    expect(await slot.findByText(/Select a project/)).toBeTruthy();
  });

  it("loads data and refetches after a realtime signal", async () => {
    let calls = 0;
    const slot = renderSlot(
      app.navPanels[0]!,
      { subPath: "" },
      {
        context: { projectId: "project-one" },
        rpc: {
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
          snapshot: () =>
            new Promise((resolve) => {
              resolvers.push(resolve);
            }),
        },
      },
    );
    await slot.emitRealtime("control-plane-spike-changed", {
      projectId: "project-one",
      revision: 2,
    });
    expect(resolvers).toHaveLength(2);
    resolvers[0]!({
      projectId: "project-one",
      observationCount: 1,
      lifecycleEvents: [],
      revision: 1,
      error: null,
    });
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
        rpc: {
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
    await reconnectSlot.setRealtimeConnectionState("connected");
    expect(reconnectCalls).toBe(2);
  });

  it("shows RPC failures with a retry action", async () => {
    const slot = renderSlot(
      app.navPanels[0]!,
      { subPath: "" },
      {
        context: { projectId: "project-one" },
        rpc: {
          snapshot: () => Promise.reject(new Error("backend unavailable")),
        },
      },
    );
    expect(await slot.findByRole("alert")).toBeTruthy();
    expect(slot.getByText("backend unavailable")).toBeTruthy();
    expect(slot.getByRole("button", { name: "Retry" })).toBeTruthy();
  });
});
