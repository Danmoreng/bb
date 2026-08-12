import { afterEach, describe, expect, it } from "vitest";
import { createFakePluginHost } from "@bb/plugin-sdk/testing";
import {
  controlPlaneMigrations,
  initializeControlPlaneDatabase,
} from "./migrations.js";
import { controlPlaneSchemaManifest } from "./schema.js";

const hosts: Array<ReturnType<typeof createFakePluginHost>> = [];

afterEach(async () => {
  await Promise.all(hosts.splice(0).map((host) => host.harness.dispose()));
});

function load() {
  const host = createFakePluginHost({ pluginId: "control-plane" });
  hosts.push(host);
  const db = host.bb.storage.database();
  db.pragma("foreign_keys = ON");
  db.pragma("journal_mode = WAL");
  return { host, db };
}

function initialize(prefix = controlPlaneMigrations.length) {
  const { host, db } = load();
  host.bb.storage.migrate(db, [...controlPlaneMigrations.slice(0, prefix)]);
  return { host, db };
}

function names(db: ReturnType<typeof load>["db"], type: string): string[] {
  return db
    .prepare("SELECT name FROM sqlite_master WHERE type = ? ORDER BY name")
    .all(type)
    .map((row) => {
      if (typeof row !== "object" || row === null || !("name" in row)) {
        throw new Error("Invalid sqlite_master row");
      }
      const name = row.name;
      if (typeof name !== "string") throw new Error("Invalid sqlite name");
      return name;
    });
}

describe("CP-102 schema migrations", () => {
  it("creates the complete schema with WAL, foreign keys, and a stable ledger", () => {
    const { db } = initialize();
    expect(db.pragma("journal_mode", { simple: true })).toBe("wal");
    expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(
      db
        .prepare("SELECT id FROM _bb_migrations ORDER BY id")
        .all()
        .map((row) => {
          if (typeof row !== "object" || row === null || !("id" in row)) {
            throw new Error("Invalid migration row");
          }
          return row.id;
        }),
    ).toEqual([0, 1, 2, 3, 4]);
    expect(names(db, "table")).toEqual(
      expect.arrayContaining([...controlPlaneSchemaManifest.tables]),
    );
    expect(names(db, "index")).toEqual(
      expect.arrayContaining([...controlPlaneSchemaManifest.indexes]),
    );
    expect(names(db, "trigger")).toEqual(
      expect.arrayContaining([...controlPlaneSchemaManifest.triggers]),
    );
  });

  it.each([1, 2, 3, 4, 5])(
    "supports a valid migration prefix %s and deterministic upgrade",
    (prefix) => {
      const { db } = initialize(prefix);
      expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      hostMigrateToFull(db);
      expect(
        db.prepare("SELECT count(*) AS count FROM _bb_migrations").get(),
      ).toEqual({ count: 5 });
      hostMigrateToFull(db);
      expect(
        db.prepare("SELECT count(*) AS count FROM _bb_migrations").get(),
      ).toEqual({ count: 5 });
    },
  );

  it("rolls back a failed appended migration without partial DDL", () => {
    const { host, db } = initialize();
    const failed = [
      ...controlPlaneMigrations,
      "CREATE TABLE should_rollback (id TEXT PRIMARY KEY); INSERT INTO missing_table VALUES ('x');",
    ];
    expect(() => host.bb.storage.migrate(db, failed)).toThrow();
    expect(
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'should_rollback'",
        )
        .get(),
    ).toBeUndefined();
    expect(
      db.prepare("SELECT max(id) AS id FROM _bb_migrations").get(),
    ).toEqual({ id: 4 });
  });

  it("rejects invalid states and cross-project references", () => {
    const { db } = initialize();
    const insertProject = db.prepare(
      "INSERT INTO control_projects (id, bb_project_id, status, created_at, updated_at) VALUES (?, ?, 'active', ?, ?)",
    );
    insertProject.run("p1", "proj_one", 1, 1);
    insertProject.run("p2", "proj_two", 1, 1);
    expect(() =>
      db
        .prepare(
          "INSERT INTO control_projects (id, bb_project_id, status, created_at, updated_at) VALUES ('bad', 'proj_bad', 'unknown', 1, 1)",
        )
        .run(),
    ).toThrow();
    expect(() =>
      db
        .prepare(
          "INSERT INTO agent_profiles (id, project_id, role_kind, name, environment_strategy, tool_set_json, version, created_at, updated_at) VALUES ('profile', 'p1', 'worker', 'Worker', 'project-default', 'not-json', 1, 1, 1)",
        )
        .run(),
    ).toThrow();
    db.prepare(
      "INSERT INTO agent_profiles (id, project_id, role_kind, name, environment_strategy, tool_set_json, version, created_at, updated_at) VALUES ('profile', 'p1', 'worker', 'Worker', 'project-default', '[]', 1, 1, 1)",
    ).run();
    expect(() =>
      db
        .prepare(
          "INSERT INTO managed_agents (id, project_id, profile_id, kind, role, status, version, created_at, updated_at) VALUES ('agent', 'p2', 'profile', 'worker', 'Worker', 'created', 1, 1, 1)",
        )
        .run(),
    ).toThrow();
    expect(() =>
      db
        .prepare(
          "INSERT INTO resource_claims (id, project_id, resource_type, selector, intent, expires_at, heartbeat_at, status, version, created_at, updated_at) VALUES ('claim', 'p1', 'file', 'a.ts', 'shared-read', 1, 1, 'active', 0, 1, 1)",
        )
        .run(),
    ).toThrow();
  });

  it("allows compatible shared claims but rejects exclusive conflicts on insert and update", () => {
    const { db } = initialize();
    db.prepare(
      "INSERT INTO control_projects (id, bb_project_id, status, created_at, updated_at) VALUES ('p', 'proj', 'active', 1, 1)",
    ).run();
    const insert = db.prepare(
      "INSERT INTO resource_claims (id, project_id, resource_type, selector, intent, expires_at, heartbeat_at, status, version, created_at, updated_at) VALUES (?, 'p', 'file', 'a.ts', ?, 10, 1, 'active', 1, 1, 1)",
    );
    insert.run("shared-1", "shared-read");
    insert.run("shared-2", "shared-read");
    expect(() => insert.run("exclusive", "exclusive")).toThrow();
    db.prepare(
      "UPDATE resource_claims SET status = 'released' WHERE id IN ('shared-1', 'shared-2')",
    ).run();
    insert.run("exclusive", "exclusive");
    expect(() =>
      db
        .prepare(
          "UPDATE resource_claims SET status = 'active' WHERE id = 'shared-2'",
        )
        .run(),
    ).toThrow();
  });

  it("models one-resolution-per-request and immutable decision content", () => {
    const { db } = initialize();
    db.prepare(
      "INSERT INTO control_projects (id, bb_project_id, status, created_at, updated_at) VALUES ('p', 'proj', 'active', 1, 1)",
    ).run();
    db.prepare(
      "INSERT INTO decision_requests (id, project_id, question, category, options_json, status, created_at, updated_at) VALUES ('request', 'p', 'Choose?', 'design', '[]', 'open', 1, 1)",
    ).run();
    db.prepare(
      "INSERT INTO decisions (id, project_id, chosen_option, rationale, authority, actor_type, status, created_at, updated_at) VALUES ('decision', 'p', 'a', 'because', 'human', 'human', 'effective', 1, 1)",
    ).run();
    expect(() =>
      db
        .prepare(
          "UPDATE decisions SET chosen_option = 'b' WHERE id = 'decision'",
        )
        .run(),
    ).toThrow();
    db.prepare(
      "INSERT INTO decision_resolutions (project_id, decision_id, request_id, resolved_at) VALUES ('p', 'decision', 'request', 1)",
    ).run();
    expect(() =>
      db
        .prepare(
          "INSERT INTO decision_resolutions (project_id, decision_id, request_id, resolved_at) VALUES ('p', 'decision', 'request', 2)",
        )
        .run(),
    ).toThrow();
    expect(() =>
      db
        .prepare(
          "UPDATE decisions SET supersedes_id = id WHERE id = 'decision'",
        )
        .run(),
    ).toThrow();
    expect(() =>
      db.prepare("DELETE FROM control_projects WHERE id = 'p'").run(),
    ).toThrow();
  });
});

function hostMigrateToFull(db: ReturnType<typeof load>["db"]): void {
  const host = hosts.at(-1);
  if (!host) throw new Error("Missing migration host");
  host.bb.storage.migrate(db, [...controlPlaneMigrations]);
}
