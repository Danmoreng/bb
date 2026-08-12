import { afterEach, describe, expect, it } from "vitest";
import { createFakePluginHost } from "@bb/plugin-sdk/testing";
import {
  controlPlaneMigrations,
  CONTROL_PLANE_PUBLISHED_MIGRATION_HASHES,
  initializeControlPlaneDatabase,
  migrationSha256,
  verifyPublishedMigrationHashes,
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

function seedLegacyPrefixFive(db: ReturnType<typeof load>["db"]): void {
  db.prepare(
    "INSERT INTO control_projects (id, bb_project_id, status, version, created_at, updated_at) VALUES ('p', 'bb-p', 'active', 1.5, 1.5, 2.5)",
  ).run();
  db.prepare(
    "INSERT INTO agent_profiles (id, project_id, role_kind, name, environment_strategy, tool_set_json, instructions_version, version, created_at, updated_at) VALUES ('profile', 'p', 'worker', 'Worker', 'project-default', '\"legacy-tool\"', 1.5, 1.5, 1.5, 2.5)",
  ).run();
  db.prepare(
    "INSERT INTO managed_agents (id, project_id, profile_id, kind, role, status, profile_version, version, created_at, updated_at) VALUES ('agent', 'p', 'profile', 'worker', 'Worker', 'active', 1.5, 1.5, 1.5, 2.5)",
  ).run();
  db.prepare(
    "INSERT INTO work_sessions (id, project_id, status, plan_version, version, created_at, updated_at) VALUES ('ws', 'p', 'created', 1.5, 1.5, 1.5, 2.5)",
  ).run();
  db.prepare(
    "INSERT INTO decision_clusters (id, project_id, fingerprint, title, summary, attention_json, status, version, created_at, updated_at) VALUES ('cluster-a', 'p', 'fp-a', 'A', 'A', '[]', 'open', 1.5, 1.5, 2.5), ('cluster-b', 'p', 'fp-b', 'B', 'B', '[]', 'open', 1.5, 1.5, 2.5)",
  ).run();
  db.prepare(
    "INSERT INTO decision_requests (id, project_id, question, category, options_json, risk_json, scope_json, evidence_json, status, version, created_at, updated_at) VALUES ('request', 'p', 'Q', 'design', '{}', '[]', '\"task-1\"', '{}', 'open', 1.5, 1.5, 2.5)",
  ).run();
  db.prepare(
    "INSERT INTO decision_cluster_requests (project_id, cluster_id, request_id, created_at) VALUES ('p', 'cluster-a', 'request', 1.5), ('p', 'cluster-b', 'request', 2.5)",
  ).run();
  db.prepare(
    "INSERT INTO decisions (id, project_id, chosen_option, rationale, scope_json, exceptions_json, authority, actor_type, status, version, created_at, updated_at) VALUES ('decision', 'p', 'a', 'because', '\"scope\"', '{}', 'human', 'human', 'effective', 1.5, 1.5, 2.5)",
  ).run();
  db.prepare(
    "INSERT INTO assumptions (id, project_id, statement, class, confidence, reversibility, blast_radius, scope_json, evidence_json, status, version, created_at, updated_at) VALUES ('assumption', 'p', 'S', 'A', 20.5, 30.5, 40.5, '\"scope\"', '{}', 'accepted', 1.5, 1.5, 2.5)",
  ).run();
  db.prepare(
    "INSERT INTO agent_messages (id, project_id, message_type, payload_summary, scope_json, payload_json, references_json, status, version, created_at, updated_at) VALUES ('message', 'p', 'tasks.comment', 'legacy', '\"scope\"', '[]', '{}', 'sent', 1.5, 1.5, 2.5)",
  ).run();
  db.prepare(
    "INSERT INTO agent_message_recipients (project_id, message_id, recipient_agent_id, delivery_status, ack_status, delivered_at, acknowledged_at) VALUES ('p', 'message', 'agent', 'delivered', 'acknowledged', 2.5, 2.5)",
  ).run();
  db.prepare(
    "INSERT INTO investigations (id, project_id, question, fingerprint, scope_json, revision, status, version, created_at, updated_at) VALUES ('investigation', 'p', 'Q', 'investigation-fp', '\"scope\"', 1.5, 'completed', 1.5, 1.5, 2.5)",
  ).run();
  db.prepare(
    "INSERT INTO findings (id, project_id, finding_type, summary, details, confidence, references_json, fingerprint, validity_status, version, created_at, updated_at) VALUES ('finding-a', 'p', 'fact', 'A', 'A', 50.5, '\"ref\"', 'finding-a-fp', 'active', 1.5, 1.5, 2.5), ('finding-b', 'p', 'fact', 'B', 'B', 60.5, '[]', 'finding-b-fp', 'active', 1.5, 1.5, 2.5)",
  ).run();
  db.prepare(
    "INSERT INTO investigation_results (project_id, investigation_id, finding_id, created_at) VALUES ('p', 'investigation', 'finding-a', 1.5), ('p', 'investigation', 'finding-b', 2.5)",
  ).run();
  db.prepare(
    "INSERT INTO investigation_subscribers (project_id, investigation_id, subscriber_type, subscriber_id, created_at) VALUES ('p', 'investigation', 'agent', 'agent', 1.5)",
  ).run();
  db.prepare(
    "INSERT INTO human_inputs (id, project_id, target_type, target_id, delivery_mode, message, priority, status, version, created_at, updated_at) VALUES ('input', 'p', 'task', 'task-1', 'queue', 'M', 50.5, 'queued', 1.5, 1.5, 2.5)",
  ).run();
  db.prepare(
    "INSERT INTO resource_claims (id, project_id, resource_type, selector, intent, expires_at, heartbeat_at, status, version, created_at, updated_at) VALUES ('claim', 'p', 'file', 'x', 'shared-read', 10.5, 2.5, 'active', 1.5, 1.5, 2.5)",
  ).run();
  db.prepare(
    "INSERT INTO review_requests (id, project_id, scope_json, policy_json, status, version, created_at, updated_at) VALUES ('review', 'p', '\"scope\"', '[]', 'requested', 1.5, 1.5, 2.5)",
  ).run();
  db.prepare(
    "INSERT INTO review_findings (id, project_id, review_id, severity, category, evidence, snapshot_fingerprint, version, created_at, updated_at) VALUES ('review-finding', 'p', 'review', 'low', 'quality', 'E', 'fp', 1.5, 1.5, 2.5)",
  ).run();
  db.prepare(
    "INSERT INTO decision_resolutions (project_id, decision_id, request_id, resolved_at) VALUES ('p', 'decision', 'request', 2.5)",
  ).run();
  db.prepare(
    "INSERT INTO domain_events (id, event_type, event_version, aggregate_type, aggregate_id, actor, correlation_id, payload_json, occurred_at) VALUES ('event', 'test', 1.5, 'project', 'p', 'system', 'corr', '{}', 2.5)",
  ).run();
  db.prepare(
    "INSERT INTO processed_events (source, external_key, handler_version, processed_at) VALUES ('test', 'event', '1', 2.5)",
  ).run();
  db.prepare(
    "INSERT INTO outbox (id, message_type, aggregate_type, aggregate_id, correlation_id, payload_json, idempotency_key, status, attempt_count, next_attempt_at, last_error, version, created_at, updated_at) VALUES ('outbox-realtime', 'realtime.invalidate', 'project', 'p', 'corr', '\"legacy\"', 'key-realtime', 'pending', 1.5, 2.5, NULL, 1.5, 1.5, 2.5), ('outbox-realtime-processing', 'realtime.invalidate', 'project', 'p', 'corr-processing', '{}', 'key-realtime-processing', 'processing', 1.5, 3.5, NULL, 1.5, 1.5, 2.5), ('outbox-task', 'tasks.comment', 'project', 'p', 'corr-2', '{}', 'key-task', 'failed', 2.5, 2.5, 'error', 1.5, 1.5, 2.5)",
  ).run();
}

function names(db: ReturnType<typeof load>["db"], type: string): string[] {
  return db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = ? AND name NOT LIKE 'sqlite_autoindex_%' AND (? <> 'table' OR name <> '_bb_migrations') ORDER BY name",
    )
    .all(type, type)
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
    ).toEqual([0, 1, 2, 3, 4, 5]);
    expect(names(db, "table")).toEqual(
      [...controlPlaneSchemaManifest.tables].sort(),
    );
    expect(names(db, "index")).toEqual(
      [...controlPlaneSchemaManifest.indexes].sort(),
    );
    expect(names(db, "trigger")).toEqual(
      [...controlPlaneSchemaManifest.triggers].sort(),
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
      ).toEqual({ count: 6 });
      hostMigrateToFull(db);
      expect(
        db.prepare("SELECT count(*) AS count FROM _bb_migrations").get(),
      ).toEqual({ count: 6 });
    },
  );

  it("upgrades populated prefix-five data without losing legacy facts", () => {
    const { db } = initialize(5);
    seedLegacyPrefixFive(db);
    hostMigrateToFull(db);

    expect(
      db
        .prepare(
          "SELECT agent_id, version, plan_version FROM work_sessions WHERE id = 'ws'",
        )
        .get(),
    ).toEqual({ agent_id: null, version: 1, plan_version: 1 });
    expect(
      db
        .prepare(
          "SELECT count(*) AS count FROM decision_cluster_requests WHERE project_id = 'p' AND request_id = 'request'",
        )
        .get(),
    ).toEqual({ count: 2 });
    expect(
      db
        .prepare(
          "SELECT cluster_id FROM decision_cluster_requests WHERE project_id = 'p' AND request_id = 'request' ORDER BY cluster_id",
        )
        .all(),
    ).toEqual([{ cluster_id: "cluster-a" }, { cluster_id: "cluster-b" }]);
    expect(
      db
        .prepare(
          "SELECT count(*) AS count FROM investigation_results WHERE project_id = 'p' AND investigation_id = 'investigation'",
        )
        .get(),
    ).toEqual({ count: 2 });
    expect(
      db
        .prepare(
          "SELECT finding_id FROM investigation_results WHERE project_id = 'p' AND investigation_id = 'investigation' ORDER BY finding_id",
        )
        .all(),
    ).toEqual([{ finding_id: "finding-a" }, { finding_id: "finding-b" }]);
    expect(
      db
        .prepare(
          "SELECT target_type, target_id, delivery_status, ack_status, delivered_at, acknowledged_at FROM agent_message_targets",
        )
        .get(),
    ).toEqual({
      target_type: "agent",
      target_id: "agent",
      delivery_status: "delivered",
      ack_status: "acknowledged",
      delivered_at: 2,
      acknowledged_at: 2,
    });
    expect(
      db
        .prepare(
          "SELECT scope_type, external_ref FROM decision_request_scope_refs",
        )
        .get(),
    ).toEqual({ scope_type: "legacy-json", external_ref: '\"task-1\"' });
    expect(
      db
        .prepare(
          "SELECT json_type(tool_set_json) AS tool_set, json_type(options_json) AS options, json_type(risk_json) AS risk, json_type(scope_json) AS scope, json_type(evidence_json) AS evidence FROM decision_requests JOIN agent_profiles ON agent_profiles.project_id = decision_requests.project_id",
        )
        .get(),
    ).toEqual({
      tool_set: "array",
      options: "array",
      risk: "object",
      scope: "object",
      evidence: "array",
    });
    expect(
      db
        .prepare(
          "SELECT json_type(payload_json) AS payload_type, json_extract(payload_json, '$.legacyPayload') AS legacy_payload, delivery_kind, reconciliation_key, attempt_count, version FROM outbox WHERE id = 'outbox-realtime'",
        )
        .get(),
    ).toEqual({
      payload_type: "object",
      legacy_payload: "legacy",
      delivery_kind: "retryable",
      reconciliation_key: null,
      attempt_count: 1,
      version: 1,
    });
    expect(
      db
        .prepare(
          "SELECT delivery_kind, reconciliation_key, status FROM outbox WHERE id = 'outbox-task'",
        )
        .get(),
    ).toEqual({
      delivery_kind: "reconcile-before-retry",
      reconciliation_key: "key-task",
      status: "outcome-unknown",
    });
    expect(
      db
        .prepare(
          "SELECT status, delivery_kind, lease_until, lease_token FROM outbox WHERE id = 'outbox-realtime-processing'",
        )
        .get(),
    ).toEqual({
      status: "pending",
      delivery_kind: "retryable",
      lease_until: null,
      lease_token: null,
    });
    expect(
      db
        .prepare(
          "SELECT typeof(confidence) AS confidence, typeof(reversibility) AS reversibility, typeof(blast_radius) AS blast_radius FROM assumptions",
        )
        .get(),
    ).toEqual({
      confidence: "integer",
      reversibility: "integer",
      blast_radius: "integer",
    });
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  it("versions known legacy outbox objects without changing their payload facts", () => {
    const { db } = initialize(5);
    db.prepare(
      "INSERT INTO control_projects (id, bb_project_id, status, created_at, updated_at) VALUES ('p', 'bb-p', 'active', 1, 1)",
    ).run();
    db.prepare(
      "INSERT INTO outbox (id, message_type, aggregate_type, aggregate_id, correlation_id, payload_json, idempotency_key, status, attempt_count, next_attempt_at, version, created_at, updated_at) VALUES ('realtime', 'realtime.invalidate', 'project', 'p', 'c1', '{\"projectId\":\"p\"}', 'realtime-key', 'pending', 0, 1, 1, 1, 1), ('comment', 'tasks.comment', 'project', 'p', 'c2', '{\"taskId\":\"task-1\",\"body\":\"hello\"}', 'comment-key', 'pending', 0, 1, 1, 1, 1)",
    ).run();
    hostMigrateToFull(db);
    expect(
      db
        .prepare(
          "SELECT id, json_extract(payload_json, '$.version') AS payload_version, json_extract(payload_json, '$.projectId') AS project_id, delivery_kind, reconciliation_key FROM outbox ORDER BY id",
        )
        .all(),
    ).toEqual([
      {
        id: "comment",
        payload_version: 1,
        project_id: null,
        delivery_kind: "reconcile-before-retry",
        reconciliation_key: "comment-key",
      },
      {
        id: "realtime",
        payload_version: 1,
        project_id: "p",
        delivery_kind: "retryable",
        reconciliation_key: null,
      },
    ]);
  });

  it("backfills a valid legacy result pointer without deleting other results", () => {
    const { db } = initialize(5);
    db.prepare(
      "INSERT INTO control_projects (id, bb_project_id, status, created_at, updated_at) VALUES ('p', 'bb-p', 'active', 1, 1)",
    ).run();
    db.prepare(
      "INSERT INTO investigations (id, project_id, question, fingerprint, status, result_finding_id, created_at, updated_at) VALUES ('i', 'p', 'Q', 'fp', 'completed', 'f', 1, 1)",
    ).run();
    db.prepare(
      "INSERT INTO findings (id, project_id, finding_type, summary, details, confidence, fingerprint, validity_status, created_at, updated_at) VALUES ('f', 'p', 'fact', 'F', 'F', 50, 'f-fp', 'active', 1, 1), ('other', 'p', 'fact', 'O', 'O', 50, 'other-fp', 'active', 1, 1)",
    ).run();
    db.prepare(
      "INSERT INTO investigation_results (project_id, investigation_id, finding_id, created_at) VALUES ('p', 'i', 'other', 2)",
    ).run();
    hostMigrateToFull(db);
    expect(
      db
        .prepare(
          "SELECT finding_id FROM investigation_results WHERE investigation_id = 'i' ORDER BY finding_id",
        )
        .all(),
    ).toEqual([{ finding_id: "f" }, { finding_id: "other" }]);
    expect(
      db
        .prepare("SELECT result_finding_id FROM investigations WHERE id = 'i'")
        .get(),
    ).toEqual({ result_finding_id: "f" });
    expect(() =>
      db
        .prepare(
          "UPDATE investigations SET result_finding_id = 'other' WHERE id = 'i'",
        )
        .run(),
    ).toThrow(/deprecated/i);
    db.prepare(
      "UPDATE investigations SET result_finding_id = NULL WHERE id = 'i'",
    ).run();
  });

  it("rejects dangling legacy result pointers before changing the schema", () => {
    const { db } = initialize(5);
    db.prepare(
      "INSERT INTO control_projects (id, bb_project_id, status, created_at, updated_at) VALUES ('p', 'bb-p', 'active', 1, 1)",
    ).run();
    db.prepare(
      "INSERT INTO investigations (id, project_id, question, fingerprint, status, result_finding_id, created_at, updated_at) VALUES ('i', 'p', 'Q', 'fp', 'completed', 'legacy-finding', 1, 1)",
    ).run();
    expect(() => hostMigrateToFull(db)).toThrow(
      /cannot preserve.*same project/i,
    );
    expect(
      db
        .prepare(
          "SELECT count(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'agent_message_targets'",
        )
        .get(),
    ).toEqual({ count: 0 });
  });

  it("rejects a changed stored hash before invoking the host migrator", () => {
    const { db, host } = initialize();
    db.prepare(
      "UPDATE control_plane_migration_hashes SET sha256 = ? WHERE migration_id = 0",
    ).run("0".repeat(64));
    let invoked = false;
    expect(() =>
      initializeControlPlaneDatabase(db, (database, migrations) => {
        invoked = true;
        host.bb.storage.migrate(database, migrations);
        database.prepare("CREATE TABLE sentinel (id INTEGER)").run();
      }),
    ).toThrow(/hash ledger mismatch/);
    expect(invoked).toBe(false);
    expect(
      db
        .prepare(
          "SELECT count(*) AS count FROM sqlite_master WHERE name = 'sentinel'",
        )
        .get(),
    ).toEqual({ count: 0 });
  });

  it("rejects a missing hash table when migration 5 is already recorded", () => {
    const { db } = initialize();
    db.prepare("DROP TABLE control_plane_migration_hashes").run();
    let invoked = false;
    expect(() =>
      initializeControlPlaneDatabase(db, () => {
        invoked = true;
      }),
    ).toThrow(/missing.*migration 5|migration 5.*recorded/i);
    expect(invoked).toBe(false);
  });

  it.each(["missing", "reordered"])(
    "rejects a %s stored hash ledger before invoking the host migrator",
    (kind) => {
      const { db, host } = initialize();
      if (kind === "missing") {
        db.prepare(
          "DELETE FROM control_plane_migration_hashes WHERE migration_id = 4",
        ).run();
      } else {
        const first = db
          .prepare(
            "SELECT sha256 FROM control_plane_migration_hashes WHERE migration_id = 0",
          )
          .get();
        const second = db
          .prepare(
            "SELECT sha256 FROM control_plane_migration_hashes WHERE migration_id = 1",
          )
          .get();
        if (
          typeof first !== "object" ||
          first === null ||
          !("sha256" in first) ||
          typeof first.sha256 !== "string" ||
          typeof second !== "object" ||
          second === null ||
          !("sha256" in second) ||
          typeof second.sha256 !== "string"
        )
          throw new Error("Invalid test ledger rows");
        db.prepare(
          "UPDATE control_plane_migration_hashes SET sha256 = ? WHERE migration_id = 0",
        ).run(second.sha256);
        db.prepare(
          "UPDATE control_plane_migration_hashes SET sha256 = ? WHERE migration_id = 1",
        ).run(first.sha256);
      }
      let invoked = false;
      expect(() =>
        initializeControlPlaneDatabase(db, () => {
          invoked = true;
        }),
      ).toThrow(/hash ledger mismatch/);
      expect(invoked).toBe(false);
      expect(
        host.bb.storage
          .database()
          .prepare(
            "SELECT count(*) AS count FROM sqlite_master WHERE name = 'sentinel'",
          )
          .get(),
      ).toEqual({ count: 0 });
    },
  );

  it("clamps negative legacy scope timestamps during populated upgrade", () => {
    const { db } = initialize(5);
    db.prepare(
      "INSERT INTO control_projects (id, bb_project_id, status, created_at, updated_at) VALUES ('p', 'bb-p', 'active', 1, 1)",
    ).run();
    db.prepare(
      "INSERT INTO decision_requests (id, project_id, question, category, options_json, scope_json, status, created_at, updated_at) VALUES ('r', 'p', 'q', 'design', '[]', '{\"task\":\"t\"}', 'open', -10, 1)",
    ).run();
    hostMigrateToFull(db);
    expect(
      db
        .prepare(
          "SELECT created_at FROM decision_request_scope_refs WHERE request_id = 'r'",
        )
        .get(),
    ).toEqual({ created_at: 0 });
  });

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
    ).toEqual({ id: 5 });
  });

  it("synchronizes legacy scope fallback rows while preserving typed rows", () => {
    const { db } = initialize();
    db.prepare(
      "INSERT INTO control_projects (id, bb_project_id, status, created_at, updated_at) VALUES ('p', 'proj', 'active', 1, 1)",
    ).run();
    db.prepare(
      "INSERT INTO decision_requests (id, project_id, question, category, options_json, scope_json, status, created_at, updated_at) VALUES ('request', 'p', 'q', 'design', '[]', '{\"old\":true}', 'open', 1, 1)",
    ).run();
    db.prepare(
      "INSERT INTO decision_request_scope_refs (project_id, request_id, scope_type, external_ref, created_at) VALUES ('p', 'request', 'typed', 'task-1', 1)",
    ).run();
    db.prepare(
      "UPDATE decision_requests SET scope_json = '{\"new\":true}' WHERE id = 'request'",
    ).run();
    expect(
      db
        .prepare(
          "SELECT scope_type, external_ref FROM decision_request_scope_refs WHERE request_id = 'request' ORDER BY scope_type",
        )
        .all(),
    ).toEqual([
      { scope_type: "legacy-json", external_ref: '{"new":true}' },
      { scope_type: "typed", external_ref: "task-1" },
    ]);
    db.prepare(
      "UPDATE decision_requests SET scope_json = '{ }' WHERE id = 'request'",
    ).run();
    expect(
      db
        .prepare(
          "SELECT scope_type FROM decision_request_scope_refs WHERE request_id = 'request'",
        )
        .all(),
    ).toEqual([{ scope_type: "typed" }]);
  });

  it("synchronizes legacy scope fallbacks for every owner table", () => {
    const { db } = initialize(5);
    seedLegacyPrefixFive(db);
    hostMigrateToFull(db);
    db.prepare("DROP TRIGGER decisions_immutable_content").run();
    const owners = [
      [
        "decision_requests",
        "decision_request_scope_refs",
        "request_id",
        "request",
      ],
      ["decisions", "decision_scope_refs", "decision_id", "decision"],
      ["assumptions", "assumption_scope_refs", "assumption_id", "assumption"],
      ["agent_messages", "agent_message_scope_refs", "message_id", "message"],
      [
        "investigations",
        "investigation_scope_refs",
        "investigation_id",
        "investigation",
      ],
      [
        "review_requests",
        "review_request_scope_refs",
        "review_request_id",
        "review",
      ],
    ] as const;
    for (const [ownerTable, relationTable, ownerColumn, ownerId] of owners) {
      db.prepare(
        `UPDATE ${ownerTable} SET scope_json = '{"replacement":true}' WHERE id = ?`,
      ).run(ownerId);
      expect(
        db
          .prepare(
            `SELECT external_ref FROM ${relationTable} WHERE ${ownerColumn} = ? AND scope_type = 'legacy-json'`,
          )
          .get(ownerId),
      ).toEqual({ external_ref: '{"replacement":true}' });
      db.prepare(`UPDATE ${ownerTable} SET scope_json = '{}' WHERE id = ?`).run(
        ownerId,
      );
      expect(
        db
          .prepare(
            `SELECT count(*) AS count FROM ${relationTable} WHERE ${ownerColumn} = ? AND scope_type = 'legacy-json'`,
          )
          .get(ownerId),
      ).toEqual({ count: 0 });
    }
  });

  it("mirrors legacy recipients and blocks referenced agent identity changes", () => {
    const { db } = initialize();
    db.prepare(
      "INSERT INTO control_projects (id, bb_project_id, status, created_at, updated_at) VALUES ('p', 'proj', 'active', 1, 1), ('p2', 'proj-2', 'active', 1, 1)",
    ).run();
    db.prepare(
      "INSERT INTO managed_agents (id, project_id, kind, role, status, version, created_at, updated_at) VALUES ('agent', 'p', 'worker', 'worker', 'active', 1, 1, 1)",
    ).run();
    db.prepare(
      "INSERT INTO agent_messages (id, project_id, message_type, payload_summary, status, created_at, updated_at) VALUES ('m', 'p', 'test', 'test', 'draft', 1, 1)",
    ).run();
    db.prepare(
      "INSERT INTO agent_message_recipients (project_id, message_id, recipient_agent_id, delivery_status, ack_status) VALUES ('p', 'm', 'agent', 'pending', 'pending')",
    ).run();
    expect(
      db
        .prepare("SELECT target_type, target_id FROM agent_message_targets")
        .all(),
    ).toEqual([{ target_type: "agent", target_id: "agent" }]);
    db.prepare(
      "UPDATE agent_message_recipients SET delivery_status = 'failed' WHERE message_id = 'm'",
    ).run();
    expect(
      db.prepare("SELECT delivery_status FROM agent_message_targets").get(),
    ).toEqual({ delivery_status: "failed" });
    expect(() =>
      db
        .prepare(
          "UPDATE managed_agents SET project_id = 'p2' WHERE id = 'agent'",
        )
        .run(),
    ).toThrow(/referenced/i);
    expect(() =>
      db.prepare("DELETE FROM managed_agents WHERE id = 'agent'").run(),
    ).toThrow(/referenced/i);
    expect(() =>
      db
        .prepare(
          "INSERT OR REPLACE INTO managed_agents (id, project_id, kind, role, status, version, created_at, updated_at) VALUES ('agent', 'p', 'worker', 'replacement', 'active', 1, 2, 2)",
        )
        .run(),
    ).toThrow(/replacement|referenced/i);
    db.prepare(
      "DELETE FROM agent_message_recipients WHERE message_id = 'm'",
    ).run();
    expect(
      db.prepare("SELECT count(*) AS count FROM agent_message_targets").get(),
    ).toEqual({ count: 0 });
  });

  it("enforces outbox delivery-kind, reconciliation, and lease invariants", () => {
    const { db } = initialize();
    expect(() =>
      db
        .prepare(
          "INSERT INTO outbox (id, message_type, aggregate_type, aggregate_id, correlation_id, payload_json, idempotency_key, status, delivery_kind, next_attempt_at, created_at, updated_at) VALUES ('bad-reconcile', 'tasks.comment', 'project', 'p', 'c', '{}', 'bad-reconcile', 'pending', 'reconcile-before-retry', 1, 1, 1)",
        )
        .run(),
    ).toThrow();
    expect(() =>
      db
        .prepare(
          "INSERT INTO outbox (id, message_type, aggregate_type, aggregate_id, correlation_id, payload_json, idempotency_key, status, delivery_kind, reconciliation_key, next_attempt_at, created_at, updated_at) VALUES ('bad-lease', 'realtime.invalidate', 'project', 'p', 'c', '{}', 'bad-lease', 'processing', 'retryable', NULL, 1, 1, 1)",
        )
        .run(),
    ).toThrow();
    db.prepare(
      "INSERT INTO outbox (id, message_type, aggregate_type, aggregate_id, correlation_id, payload_json, idempotency_key, status, delivery_kind, reconciliation_key, next_attempt_at, lease_until, lease_token, created_at, updated_at) VALUES ('good-lease', 'tasks.comment', 'project', 'p', 'c', '{}', 'good-lease', 'processing', 'reconcile-before-retry', 'remote-key', 1, 2, 'token', 1, 1)",
    ).run();
    expect(() =>
      db
        .prepare(
          "UPDATE outbox SET reconciliation_key = 'changed' WHERE id = 'good-lease'",
        )
        .run(),
    ).toThrow(/immutable/i);
    expect(() =>
      db
        .prepare(
          "UPDATE outbox SET status = 'outcome-unknown', delivery_kind = 'retryable', reconciliation_key = NULL WHERE id = 'good-lease'",
        )
        .run(),
    ).toThrow();
    expect(() =>
      db
        .prepare(
          "INSERT OR REPLACE INTO outbox (id, message_type, aggregate_type, aggregate_id, correlation_id, payload_json, idempotency_key, status, delivery_kind, reconciliation_key, next_attempt_at, created_at, updated_at) VALUES ('good-lease', 'tasks.comment', 'project', 'p', 'changed', '{}', 'good-lease', 'pending', 'reconcile-before-retry', 'changed-key', 2, 2, 2)",
        )
        .run(),
    ).toThrow(/replacement/i);
  });

  it("rejects terminal receipt updates and deletes", () => {
    const { db } = initialize();
    db.prepare(
      "INSERT INTO control_projects (id, bb_project_id, status, created_at, updated_at) VALUES ('p', 'proj', 'active', 1, 1)",
    ).run();
    db.prepare(
      "INSERT INTO command_receipts (idempotency_key, command_type, project_id, request_hash, status, response_json, created_at, updated_at) VALUES ('terminal', 'x', 'p', 'h', 'completed', '{}', 1, 1)",
    ).run();
    expect(() =>
      db
        .prepare(
          "UPDATE command_receipts SET updated_at = 2 WHERE idempotency_key = 'terminal'",
        )
        .run(),
    ).toThrow(/terminal/i);
    expect(() =>
      db
        .prepare(
          "DELETE FROM command_receipts WHERE idempotency_key = 'terminal'",
        )
        .run(),
    ).toThrow(/deletion/i);
    expect(() =>
      db
        .prepare(
          "INSERT OR REPLACE INTO command_receipts (idempotency_key, command_type, project_id, request_hash, status, response_json, created_at, updated_at) VALUES ('terminal', 'replacement', 'p', 'new-hash', 'completed', '{}', 2, 2)",
        )
        .run(),
    ).toThrow(/replacement|terminal/i);
    db.prepare(
      "INSERT INTO command_receipts (idempotency_key, command_type, project_id, request_hash, status, created_at, updated_at) VALUES ('processing-receipt', 'x', 'p', 'h', 'processing', 1, 1)",
    ).run();
    expect(() =>
      db
        .prepare(
          "INSERT OR REPLACE INTO command_receipts (idempotency_key, command_type, project_id, request_hash, status, created_at, updated_at) VALUES ('processing-receipt', 'replacement', 'p', 'new-hash', 'processing', 2, 2)",
        )
        .run(),
    ).toThrow(/replacement/i);
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
          "INSERT INTO control_projects (id, bb_project_id, status, created_at, updated_at) VALUES ('negative', 'proj_negative', 'active', -1, 0)",
        )
        .run(),
    ).toThrow(/timestamp|nonnegative/i);
    expect(
      db.prepare("SELECT id FROM control_projects WHERE id = 'negative'").get(),
    ).toBeUndefined();
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

  it("pins the released migration payloads and rejects altered history", () => {
    expect(controlPlaneMigrations).toHaveLength(6);
    expect(controlPlaneMigrations.slice(0, 5).map(migrationSha256)).toEqual([
      ...CONTROL_PLANE_PUBLISHED_MIGRATION_HASHES,
    ]);
    expect(() =>
      verifyPublishedMigrationHashes([
        `${controlPlaneMigrations[0]} `,
        ...controlPlaneMigrations.slice(1),
      ]),
    ).toThrow(/hash mismatch/);
  });

  it("enforces correction tables, normalized references, JSON shapes, and integer versions", () => {
    const { db } = initialize();
    db.prepare(
      "INSERT INTO control_projects (id, bb_project_id, status, created_at, updated_at) VALUES ('p', 'proj', 'active', 1, 1)",
    ).run();
    expect(() =>
      db.prepare("DELETE FROM control_projects WHERE id = 'p'").run(),
    ).toThrow(/logically archived/);
    expect(() =>
      db
        .prepare(
          "INSERT INTO command_receipts (idempotency_key, command_type, project_id, request_hash, status, version, created_at, updated_at) VALUES ('k', 'x', 'p', 'h', 'completed', 1, 1, 1)",
        )
        .run(),
    ).toThrow(/response\/error/);
    db.prepare(
      "INSERT INTO command_receipts (idempotency_key, command_type, project_id, request_hash, status, response_json, version, created_at, updated_at) VALUES ('k', 'x', 'p', 'h', 'completed', '{}', 1, 1, 1)",
    ).run();
    db.prepare(
      "INSERT INTO command_receipts (idempotency_key, command_type, project_id, request_hash, status, version, created_at, updated_at) VALUES ('processing', 'x', 'p', 'hash', 'processing', 1, 1, 1)",
    ).run();
    db.prepare(
      "UPDATE command_receipts SET status = 'completed', response_json = '{\"ok\":true}', updated_at = 2 WHERE idempotency_key = 'processing'",
    ).run();
    expect(() =>
      db
        .prepare(
          "UPDATE command_receipts SET status = 'processing', updated_at = 3 WHERE idempotency_key = 'processing'",
        )
        .run(),
    ).toThrow(/terminal.*immutable/i);
    expect(() =>
      db
        .prepare(
          "UPDATE command_receipts SET request_hash = 'replay', updated_at = 3 WHERE idempotency_key = 'processing'",
        )
        .run(),
    ).toThrow(/immutable/i);
    db.prepare(
      "INSERT INTO managed_agents (id, project_id, kind, role, status, version, created_at, updated_at) VALUES ('agent', 'p', 'worker', 'worker', 'active', 1, 1, 1)",
    ).run();
    expect(() =>
      db
        .prepare(
          "INSERT INTO agent_message_targets (project_id, message_id, target_type, target_id, delivery_status, ack_status, created_at) VALUES ('p', 'missing-message', 'agent', 'other-agent', 'pending', 'pending', 1)",
        )
        .run(),
    ).toThrow(/belong to its project/i);
    db.prepare(
      "INSERT INTO agent_messages (id, project_id, message_type, payload_summary, status, created_at, updated_at) VALUES ('m', 'p', 'test', 'test', 'draft', 1, 1)",
    ).run();
    db.prepare(
      "UPDATE agent_messages SET scope_json = '{\"task\":\"t1\"}' WHERE id = 'm'",
    ).run();
    expect(
      db
        .prepare(
          "SELECT scope_type, external_ref FROM agent_message_scope_refs WHERE message_id = 'm'",
        )
        .get(),
    ).toEqual({ scope_type: "legacy-json", external_ref: '{\"task\":\"t1\"}' });
    expect(() =>
      db
        .prepare(
          "INSERT INTO agent_profiles (id, project_id, role_kind, name, environment_strategy, tool_set_json, version, created_at, updated_at) VALUES ('bad-json', 'p', 'worker', 'Bad', 'project-default', '{}', 1, 1, 1)",
        )
        .run(),
    ).toThrow(/array/);
    expect(() =>
      db
        .prepare(
          "INSERT INTO agent_profiles (id, project_id, role_kind, name, environment_strategy, tool_set_json, version, created_at, updated_at) VALUES ('bad-version', 'p', 'worker', 'Bad', 'project-default', '[]', 1.5, 1, 1)",
        )
        .run(),
    ).toThrow(/integer/);
    db.prepare(
      "INSERT INTO decision_requests (id, project_id, question, category, options_json, status, created_at, updated_at) VALUES ('r', 'p', 'q', 'design', '[]', 'open', 1, 1)",
    ).run();
    db.prepare(
      "INSERT INTO decision_request_scope_refs (project_id, request_id, scope_type, external_ref, created_at) VALUES ('p', 'r', 'task', 't1', 1)",
    ).run();
    expect(() =>
      db
        .prepare(
          "INSERT INTO decision_request_scope_refs (project_id, request_id, scope_type, external_ref, created_at) VALUES ('p', 'missing', 'task', 't1', 1)",
        )
        .run(),
    ).toThrow();
    expect(
      db
        .prepare(
          "SELECT delivery_kind, reconciliation_key, lease_token FROM outbox LIMIT 1",
        )
        .get(),
    ).toBeUndefined();
  });

  it("exposes the composite and conflict indexes used by integrity guards", () => {
    const { db } = initialize();
    const fk = db.prepare("PRAGMA foreign_key_list(work_sessions)").all();
    expect(fk).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          table: "managed_agents",
          from: "agent_id",
          to: "id",
        }),
        expect.objectContaining({
          table: "managed_agents",
          from: "project_id",
          to: "project_id",
        }),
      ]),
    );
    const indexes = db.prepare("PRAGMA index_list(resource_claims)").all();
    expect(indexes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "resource_claims_conflict_lookup" }),
      ]),
    );
    const plan = db
      .prepare(
        "EXPLAIN QUERY PLAN SELECT 1 FROM resource_claims WHERE project_id = ? AND resource_type = ? AND selector = ? AND status = 'active' AND intent = 'exclusive'",
      )
      .all("p", "file", "x");
    expect(
      plan.some(
        (entry) =>
          typeof entry === "object" &&
          entry !== null &&
          "detail" in entry &&
          typeof entry.detail === "string" &&
          entry.detail.includes("resource_claims_conflict_lookup"),
      ),
    ).toBe(true);
    const projectMovePlan = db
      .prepare(
        "EXPLAIN QUERY PLAN SELECT 1 FROM resource_claims WHERE id <> ? AND project_id = ? AND resource_type = ? AND selector = ? AND status = 'active'",
      )
      .all("claim", "p", "file", "x");
    expect(
      projectMovePlan.some(
        (entry) =>
          typeof entry === "object" &&
          entry !== null &&
          "detail" in entry &&
          typeof entry.detail === "string" &&
          entry.detail.includes("resource_claims_conflict_lookup"),
      ),
    ).toBe(true);
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
