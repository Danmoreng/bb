import { describe, expect, it } from "vitest";
import { createFakePluginHost } from "@bb/plugin-sdk/testing";
import plugin from "./server.js";

async function load() {
  const host = createFakePluginHost({ pluginId: "control-plane" });
  await plugin(host.bb);
  return host;
}

describe("control-plane production scaffold", () => {
  it("registers diagnostics and ping RPCs", async () => {
    const host = await load();
    await expect(host.harness.callRpc("ping", {})).resolves.toEqual({
      ok: true,
      version: "0.0.1",
    });
    await expect(
      host.harness.callRpc("diagnostics", { projectId: "proj_test" }),
    ).resolves.toMatchObject({ status: "ready" });
    await host.harness.dispose();
  });

  it("initializes an idempotent WAL/FK database and keeps it after reload", async () => {
    const host = await load();
    const db = host.bb.storage.database();
    expect(db.pragma("journal_mode", { simple: true })).toBe("wal");
    expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
    expect(
      db.prepare("SELECT count(*) AS count FROM control_projects").get(),
    ).toEqual({ count: 0 });
    const reloaded = await host.harness.reload(plugin);
    const reloadedDb = reloaded.bb.storage.database();
    expect(reloadedDb.pragma("foreign_keys", { simple: true })).toBe(1);
    expect(
      reloadedDb.prepare("SELECT count(*) AS count FROM _bb_migrations").get(),
    ).toEqual({ count: 4 });
    await reloaded.harness.dispose();
  });
});
