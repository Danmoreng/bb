import { describe, expect, it } from "vitest";
import { createFakePluginHost } from "@bb/plugin-sdk/testing";
import plugin from "./server.js";

describe("control-plane production scaffold", () => {
  it("registers diagnostics and ping RPCs", async () => {
    const host = createFakePluginHost({ pluginId: "control-plane" });
    await plugin(host.bb);
    await expect(host.harness.callRpc("ping", {})).resolves.toEqual({
      ok: true,
      version: "0.0.1",
    });
    await expect(
      host.harness.callRpc("diagnostics", { projectId: "proj_test" }),
    ).resolves.toMatchObject({ status: "ready" });
    await host.harness.dispose();
  });
});
