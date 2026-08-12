// @vitest-environment jsdom
import { cleanup } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { loadPluginApp, renderSlot } from "@bb/plugin-sdk/testing/app";

const app = await loadPluginApp(() => import("./app"));
afterEach(cleanup);

describe("control-plane production app", () => {
  it("registers a diagnostics panel", () => {
    expect(app.navPanels[0]).toMatchObject({ id: "control-plane", path: "control-plane" });
  });

  it("renders diagnostics from RPC", async () => {
    const slot = renderSlot(app.navPanels[0]!, { subPath: "" }, {
      context: { projectId: "proj_test" },
      rpc: { diagnostics: () => ({ pluginVersion: "0.0.1", domainPackage: "0.0.1", projectId: "proj_test", status: "ready", message: "ready" }) },
    });
    expect(await slot.findByText("ready")).toBeTruthy();
  });
});
