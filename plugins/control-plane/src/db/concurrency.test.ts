import { afterEach, describe, expect, it } from "vitest";
import { createFakePluginHost } from "@bb/plugin-sdk/testing";
import { VersionConflictError } from "@bb-private/control-plane-domain";
import { compareAndSwap } from "./concurrency.js";

const hosts: Array<ReturnType<typeof createFakePluginHost>> = [];
afterEach(async () => {
  await Promise.all(hosts.splice(0).map((host) => host.harness.dispose()));
});

describe("compareAndSwap", () => {
  it("updates an aggregate only at its expected version", async () => {
    const host = createFakePluginHost({ pluginId: "control-plane" });
    hosts.push(host);
    const db = host.bb.storage.database();
    db.exec(
      "CREATE TABLE records (id TEXT PRIMARY KEY, status TEXT NOT NULL, version INTEGER NOT NULL, updated_at INTEGER NOT NULL)",
    );
    db.prepare("INSERT INTO records VALUES ('r1', 'open', 1, 1)").run();

    expect(
      compareAndSwap(db, {
        table: "records",
        id: "r1",
        expectedVersion: 1,
        updates: { status: "closed" },
        now: 2,
      }),
    ).toBe(2);
    expect(
      db
        .prepare(
          "SELECT status, version, updated_at FROM records WHERE id = 'r1'",
        )
        .get(),
    ).toEqual({
      status: "closed",
      version: 2,
      updated_at: 2,
    });
    expect(() =>
      compareAndSwap(db, {
        table: "records",
        id: "r1",
        expectedVersion: 1,
        updates: { status: "stale" },
        now: 3,
      }),
    ).toThrowError(VersionConflictError);
  });

  it("reports deleted aggregates and rejects unsafe managed columns", async () => {
    const host = createFakePluginHost({ pluginId: "control-plane" });
    hosts.push(host);
    const db = host.bb.storage.database();
    db.exec(
      "CREATE TABLE records (id TEXT PRIMARY KEY, version INTEGER NOT NULL, updated_at INTEGER NOT NULL)",
    );
    expect(() =>
      compareAndSwap(db, {
        table: "records",
        id: "missing",
        expectedVersion: 1,
        updates: {},
        now: 2,
      }),
    ).toThrowError(/no longer exists/);
    expect(() =>
      compareAndSwap(db, {
        table: "records; DROP TABLE records",
        id: "x",
        expectedVersion: 1,
        updates: {},
        now: 2,
      }),
    ).toThrowError(/Invalid SQL table/);
    expect(() =>
      compareAndSwap(db, {
        table: "records",
        id: "x",
        expectedVersion: 1,
        updates: { version: 3 },
        now: 2,
      }),
    ).toThrowError(/managed/);
  });
});
