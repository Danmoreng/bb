import { createHash } from "node:crypto";
import type { BbPluginApi } from "@bb/plugin-sdk";
import { z } from "zod";
import { CONTROL_PLANE_SCHEMA_VERSION } from "./schema.js";

type PluginDatabase = ReturnType<BbPluginApi["storage"]["database"]>;
type Migrate = BbPluginApi["storage"]["migrate"];

const JSON_VALUE = "CHECK (json_valid(payload_json))";
const TIMES = "CHECK (updated_at >= created_at)";
const VERSION = "CHECK (version >= 1)";

export const CONTROL_PLANE_PUBLISHED_MIGRATION_HASHES = [
  "e4869212a6fecda8c49fb4ddffb2742eb632099e900b669cb02960f6cabf22f8",
  "6b73d0e40555198543edb80232930f6186119ed74bccc3286746952ec40869b9",
  "990619dcccc71cdbb3d1f4a65dcd8406038960e996eb8b28d2b3877ce891f7c0",
  "4838116f05e54404bf86a462ad214a85ed1ebca011506990d734d793764573d4",
  "55f60a3cb8887b4410d4473333dc99365aec427069806e6d7cd1c3d04d587a29",
] as const;

export function migrationSha256(sql: string): string {
  return createHash("sha256").update(sql, "utf8").digest("hex");
}

export function verifyPublishedMigrationHashes(
  migrations: readonly string[],
): void {
  if (migrations.length < CONTROL_PLANE_PUBLISHED_MIGRATION_HASHES.length) {
    throw new Error("Control Plane published migration set is incomplete");
  }
  for (const [
    index,
    expected,
  ] of CONTROL_PLANE_PUBLISHED_MIGRATION_HASHES.entries()) {
    const actual = migrationSha256(migrations[index] ?? "");
    if (actual !== expected) {
      throw new Error(`Control Plane migration ${index} hash mismatch`);
    }
  }
}

/**
 * Positional and append-only. Once CP-102 ships, never edit or reorder an
 * entry; append a new entry for every schema change.
 */
export const controlPlaneMigrations: readonly string[] = [
  `
    CREATE TABLE control_projects (
      id TEXT PRIMARY KEY,
      bb_project_id TEXT NOT NULL UNIQUE,
      tasks_project_id TEXT UNIQUE,
      status TEXT NOT NULL CHECK (status IN ('draft','initializing','active','degraded','archived')),
      onboarding_version INTEGER NOT NULL DEFAULT 1 CHECK (onboarding_version >= 1),
      policy_version INTEGER NOT NULL DEFAULT 1 CHECK (policy_version >= 1),
      version INTEGER NOT NULL DEFAULT 1 ${VERSION},
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL ${TIMES}
    );
    CREATE TABLE agent_profiles (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      role_kind TEXT NOT NULL CHECK (role_kind IN ('steward','worker','investigator','reviewer')),
      name TEXT NOT NULL CHECK (length(trim(name)) > 0),
      provider_id TEXT,
      model_id TEXT,
      reasoning_level TEXT,
      permission_mode TEXT,
      environment_strategy TEXT NOT NULL CHECK (environment_strategy IN ('project-default','reuse','new-worktree')),
      tool_set_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(tool_set_json)),
      instructions_version INTEGER NOT NULL DEFAULT 1 CHECK (instructions_version >= 1),
      slot_class TEXT NOT NULL DEFAULT 'default',
      budget_class TEXT NOT NULL DEFAULT 'default',
      active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
      version INTEGER NOT NULL DEFAULT 1 ${VERSION},
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL ${TIMES},
      UNIQUE (project_id, id),
      FOREIGN KEY (project_id) REFERENCES control_projects(id) ON DELETE RESTRICT
    );
    CREATE TABLE managed_agents (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      profile_id TEXT,
      profile_version INTEGER NOT NULL DEFAULT 1 CHECK (profile_version >= 1),
      kind TEXT NOT NULL CHECK (kind IN ('steward','worker','investigator','reviewer')),
      role TEXT NOT NULL,
      thread_id TEXT,
      status TEXT NOT NULL CHECK (status IN ('created','starting','active','idle','failed','retired')),
      last_health_check_at INTEGER,
      retired_at INTEGER,
      version INTEGER NOT NULL DEFAULT 1 ${VERSION},
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL ${TIMES},
      UNIQUE (project_id, id),
      FOREIGN KEY (project_id, profile_id) REFERENCES agent_profiles(project_id, id) ON DELETE RESTRICT
    );
    CREATE TABLE work_sessions (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      task_id TEXT,
      agent_id TEXT,
      thread_id TEXT,
      environment_ref TEXT,
      branch_ref TEXT,
      plan TEXT,
      plan_version INTEGER NOT NULL DEFAULT 1 CHECK (plan_version >= 1),
      current_checkpoint TEXT,
      context_cursor TEXT,
      result_summary TEXT,
      status TEXT NOT NULL CHECK (status IN ('created','active','checkpointed','idle','failed','finished','cancelled')),
      version INTEGER NOT NULL DEFAULT 1 ${VERSION},
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL ${TIMES},
      UNIQUE (project_id, id),
      FOREIGN KEY (project_id) REFERENCES control_projects(id) ON DELETE RESTRICT,
      FOREIGN KEY (project_id, agent_id) REFERENCES managed_agents(project_id, id) ON DELETE RESTRICT
    );
    CREATE TABLE task_dependencies (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      from_task_id TEXT NOT NULL,
      to_task_id TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('hard','soft','informational')),
      reason TEXT,
      expected_artifact TEXT,
      status TEXT NOT NULL CHECK (status IN ('active','satisfied','blocked','cancelled')),
      version INTEGER NOT NULL DEFAULT 1 ${VERSION},
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL ${TIMES},
      UNIQUE (project_id, id), UNIQUE (project_id, from_task_id, to_task_id),
      CHECK (from_task_id <> to_task_id),
      FOREIGN KEY (project_id) REFERENCES control_projects(id) ON DELETE RESTRICT
    );
    CREATE INDEX work_sessions_project_status ON work_sessions(project_id, status, updated_at DESC);
    CREATE INDEX task_dependencies_project ON task_dependencies(project_id, status);
  `,
  `
    CREATE TABLE decision_clusters (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      fingerprint TEXT NOT NULL,
      title TEXT NOT NULL,
      summary TEXT NOT NULL,
      attention_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(attention_json)),
      status TEXT NOT NULL CHECK (status IN ('open','resolved','dismissed')),
      version INTEGER NOT NULL DEFAULT 1 ${VERSION},
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL ${TIMES},
      UNIQUE (project_id, id), UNIQUE (project_id, fingerprint),
      FOREIGN KEY (project_id) REFERENCES control_projects(id) ON DELETE RESTRICT
    );
    CREATE TABLE decision_requests (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      source_agent_id TEXT,
      source_run_id TEXT,
      source_task_id TEXT,
      question TEXT NOT NULL,
      category TEXT NOT NULL,
      options_json TEXT NOT NULL CHECK (json_valid(options_json)),
      recommendation TEXT,
      risk_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(risk_json)),
      scope_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(scope_json)),
      evidence_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(evidence_json)),
      blocking_scope TEXT,
      status TEXT NOT NULL CHECK (status IN ('open','clustered','resolved','rejected','superseded')),
      version INTEGER NOT NULL DEFAULT 1 ${VERSION},
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL ${TIMES},
      UNIQUE (project_id, id),
      FOREIGN KEY (project_id) REFERENCES control_projects(id) ON DELETE RESTRICT,
      FOREIGN KEY (project_id, source_agent_id) REFERENCES managed_agents(project_id, id) ON DELETE RESTRICT
    );
    CREATE TABLE decision_cluster_requests (
      project_id TEXT NOT NULL,
      cluster_id TEXT NOT NULL,
      request_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (project_id, cluster_id, request_id),
      FOREIGN KEY (project_id, cluster_id) REFERENCES decision_clusters(project_id, id) ON DELETE RESTRICT,
      FOREIGN KEY (project_id, request_id) REFERENCES decision_requests(project_id, id) ON DELETE RESTRICT
    );
    CREATE TABLE decision_request_impacts (
      project_id TEXT NOT NULL,
      request_id TEXT NOT NULL,
      impact_type TEXT NOT NULL,
      external_ref TEXT NOT NULL,
      PRIMARY KEY (project_id, request_id, impact_type, external_ref),
      FOREIGN KEY (project_id, request_id) REFERENCES decision_requests(project_id, id) ON DELETE RESTRICT
    );
    CREATE TABLE decisions (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      chosen_option TEXT NOT NULL,
      rationale TEXT NOT NULL,
      scope_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(scope_json)),
      exceptions_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(exceptions_json)),
      authority TEXT NOT NULL,
      actor_type TEXT NOT NULL CHECK (actor_type IN ('human','agent','system')),
      actor_id TEXT,
      status TEXT NOT NULL CHECK (status IN ('draft','effective','superseded','revoked')),
      supersedes_id TEXT,
      effective_at INTEGER,
      version INTEGER NOT NULL DEFAULT 1 ${VERSION},
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL ${TIMES},
      UNIQUE (project_id, id),
      FOREIGN KEY (project_id) REFERENCES control_projects(id) ON DELETE RESTRICT,
      FOREIGN KEY (project_id, supersedes_id) REFERENCES decisions(project_id, id) ON DELETE RESTRICT,
      CHECK (supersedes_id IS NULL OR supersedes_id <> id)
    );
    CREATE UNIQUE INDEX decisions_one_successor ON decisions(project_id, supersedes_id) WHERE supersedes_id IS NOT NULL;
    CREATE TABLE decision_resolutions (
      project_id TEXT NOT NULL,
      decision_id TEXT NOT NULL,
      request_id TEXT NOT NULL,
      resolved_at INTEGER NOT NULL,
      PRIMARY KEY (project_id, decision_id, request_id),
      UNIQUE (project_id, request_id),
      FOREIGN KEY (project_id, decision_id) REFERENCES decisions(project_id, id) ON DELETE RESTRICT,
      FOREIGN KEY (project_id, request_id) REFERENCES decision_requests(project_id, id) ON DELETE RESTRICT
    );
    CREATE TABLE assumptions (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      run_id TEXT,
      task_id TEXT,
      work_session_id TEXT,
      statement TEXT NOT NULL,
      class TEXT NOT NULL CHECK (class IN ('A','B','C','D')),
      confidence INTEGER NOT NULL CHECK (confidence BETWEEN 0 AND 100),
      reversibility INTEGER NOT NULL CHECK (reversibility BETWEEN 0 AND 100),
      blast_radius INTEGER NOT NULL CHECK (blast_radius BETWEEN 0 AND 100),
      scope_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(scope_json)),
      evidence_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(evidence_json)),
      status TEXT NOT NULL CHECK (status IN ('review-pending','accepted','rejected','expired','superseded')),
      version INTEGER NOT NULL DEFAULT 1 ${VERSION},
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL ${TIMES},
      UNIQUE (project_id, id),
      FOREIGN KEY (project_id) REFERENCES control_projects(id) ON DELETE RESTRICT,
      FOREIGN KEY (project_id, work_session_id) REFERENCES work_sessions(project_id, id) ON DELETE RESTRICT
    );
    CREATE TABLE human_inputs (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      target_type TEXT NOT NULL CHECK (target_type IN ('thread','run','checkpoint','task')),
      target_id TEXT NOT NULL,
      delivery_mode TEXT NOT NULL CHECK (delivery_mode IN ('steer','queue','checkpoint')),
      message TEXT NOT NULL,
      priority INTEGER NOT NULL DEFAULT 50 CHECK (priority BETWEEN 0 AND 100),
      status TEXT NOT NULL CHECK (status IN ('queued','delivered','acknowledged','stale','cancelled')),
      promotion_decision_id TEXT,
      version INTEGER NOT NULL DEFAULT 1 ${VERSION},
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL ${TIMES},
      UNIQUE (project_id, id),
      FOREIGN KEY (project_id) REFERENCES control_projects(id) ON DELETE RESTRICT,
      FOREIGN KEY (project_id, promotion_decision_id) REFERENCES decisions(project_id, id) ON DELETE RESTRICT
    );
    CREATE INDEX decision_requests_project_status ON decision_requests(project_id, status, updated_at DESC);
    CREATE INDEX decision_cluster_requests_request ON decision_cluster_requests(project_id, request_id);
    CREATE INDEX decision_request_impacts_request ON decision_request_impacts(project_id, request_id);
    CREATE INDEX decision_resolutions_decision ON decision_resolutions(project_id, decision_id);
    CREATE INDEX assumptions_project_status ON assumptions(project_id, status, updated_at DESC);
    CREATE INDEX human_inputs_project_status ON human_inputs(project_id, status, priority DESC, created_at);
    CREATE TRIGGER decisions_immutable_content BEFORE UPDATE OF chosen_option, rationale, scope_json, exceptions_json, authority, actor_type, actor_id ON decisions
    WHEN OLD.chosen_option <> NEW.chosen_option OR OLD.rationale <> NEW.rationale OR OLD.scope_json <> NEW.scope_json OR OLD.exceptions_json <> NEW.exceptions_json OR OLD.authority <> NEW.authority OR OLD.actor_type <> NEW.actor_type OR coalesce(OLD.actor_id,'') <> coalesce(NEW.actor_id,'')
    BEGIN SELECT RAISE(ABORT, 'decision content is immutable; create a successor'); END;
  `,
  `
    CREATE TABLE agent_messages (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      message_type TEXT NOT NULL,
      sender_agent_id TEXT,
      scope_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(scope_json)),
      payload_summary TEXT NOT NULL,
      payload_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(payload_json)),
      references_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(references_json)),
      expected_response TEXT,
      urgency INTEGER NOT NULL DEFAULT 50 CHECK (urgency BETWEEN 0 AND 100),
      status TEXT NOT NULL CHECK (status IN ('draft','sent','delivered','acknowledged','expired','cancelled')),
      version INTEGER NOT NULL DEFAULT 1 ${VERSION},
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL ${TIMES},
      UNIQUE (project_id, id),
      FOREIGN KEY (project_id) REFERENCES control_projects(id) ON DELETE RESTRICT,
      FOREIGN KEY (project_id, sender_agent_id) REFERENCES managed_agents(project_id, id) ON DELETE RESTRICT
    );
    CREATE TABLE agent_message_recipients (
      project_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      recipient_agent_id TEXT NOT NULL,
      delivery_status TEXT NOT NULL CHECK (delivery_status IN ('pending','delivered','failed','expired')),
      ack_status TEXT NOT NULL CHECK (ack_status IN ('pending','acknowledged','declined')),
      delivered_at INTEGER,
      acknowledged_at INTEGER,
      PRIMARY KEY (project_id, message_id, recipient_agent_id),
      FOREIGN KEY (project_id, message_id) REFERENCES agent_messages(project_id, id) ON DELETE RESTRICT,
      FOREIGN KEY (project_id, recipient_agent_id) REFERENCES managed_agents(project_id, id) ON DELETE RESTRICT
    );
    CREATE TABLE investigations (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      question TEXT NOT NULL,
      fingerprint TEXT NOT NULL,
      scope_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(scope_json)),
      revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
      owner_agent_id TEXT,
      status TEXT NOT NULL CHECK (status IN ('open','running','completed','cancelled')),
      result_finding_id TEXT,
      version INTEGER NOT NULL DEFAULT 1 ${VERSION},
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL ${TIMES},
      UNIQUE (project_id, id), UNIQUE (project_id, fingerprint),
      FOREIGN KEY (project_id) REFERENCES control_projects(id) ON DELETE RESTRICT,
      FOREIGN KEY (project_id, owner_agent_id) REFERENCES managed_agents(project_id, id) ON DELETE RESTRICT
    );
    CREATE TABLE investigation_subscribers (
      project_id TEXT NOT NULL,
      investigation_id TEXT NOT NULL,
      subscriber_type TEXT NOT NULL CHECK (subscriber_type IN ('agent','task','run')),
      subscriber_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (project_id, investigation_id, subscriber_type, subscriber_id),
      FOREIGN KEY (project_id, investigation_id) REFERENCES investigations(project_id, id) ON DELETE RESTRICT
    );
    CREATE TABLE findings (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      source_run_id TEXT,
      source_work_session_id TEXT,
      source_investigation_id TEXT,
      finding_type TEXT NOT NULL,
      summary TEXT NOT NULL,
      details TEXT NOT NULL,
      confidence INTEGER NOT NULL CHECK (confidence BETWEEN 0 AND 100),
      references_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(references_json)),
      fingerprint TEXT NOT NULL,
      validity_status TEXT NOT NULL CHECK (validity_status IN ('active','superseded','retracted','unverified')),
      superseded_by_id TEXT,
      version INTEGER NOT NULL DEFAULT 1 ${VERSION},
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL ${TIMES},
      UNIQUE (project_id, id),
      FOREIGN KEY (project_id) REFERENCES control_projects(id) ON DELETE RESTRICT,
      FOREIGN KEY (project_id, source_work_session_id) REFERENCES work_sessions(project_id, id) ON DELETE RESTRICT,
      FOREIGN KEY (project_id, source_investigation_id) REFERENCES investigations(project_id, id) ON DELETE RESTRICT,
      FOREIGN KEY (project_id, superseded_by_id) REFERENCES findings(project_id, id) ON DELETE RESTRICT
    );
    CREATE TABLE investigation_results (
      project_id TEXT NOT NULL,
      investigation_id TEXT NOT NULL,
      finding_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (project_id, investigation_id, finding_id),
      FOREIGN KEY (project_id, investigation_id) REFERENCES investigations(project_id, id) ON DELETE RESTRICT,
      FOREIGN KEY (project_id, finding_id) REFERENCES findings(project_id, id) ON DELETE RESTRICT
    );
    CREATE TABLE resource_claims (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      resource_type TEXT NOT NULL,
      selector TEXT NOT NULL,
      intent TEXT NOT NULL CHECK (intent IN ('shared-read','exclusive')),
      owner_run_id TEXT,
      owner_agent_id TEXT,
      expires_at INTEGER NOT NULL,
      heartbeat_at INTEGER NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('active','released','expired')),
      version INTEGER NOT NULL DEFAULT 1 ${VERSION},
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL ${TIMES},
      UNIQUE (project_id, id),
      FOREIGN KEY (project_id) REFERENCES control_projects(id) ON DELETE RESTRICT,
      FOREIGN KEY (project_id, owner_agent_id) REFERENCES managed_agents(project_id, id) ON DELETE RESTRICT
    );
    CREATE TABLE review_requests (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      task_id TEXT,
      work_session_id TEXT,
      environment_ref TEXT,
      diff_fingerprint TEXT,
      scope_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(scope_json)),
      policy_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(policy_json)),
      reviewer_run_id TEXT,
      status TEXT NOT NULL CHECK (status IN ('requested','in_progress','passed','failed','cancelled')),
      version INTEGER NOT NULL DEFAULT 1 ${VERSION},
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL ${TIMES},
      UNIQUE (project_id, id),
      FOREIGN KEY (project_id) REFERENCES control_projects(id) ON DELETE RESTRICT,
      FOREIGN KEY (project_id, work_session_id) REFERENCES work_sessions(project_id, id) ON DELETE RESTRICT
    );
    CREATE TABLE review_findings (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      review_id TEXT NOT NULL,
      severity TEXT NOT NULL CHECK (severity IN ('critical','high','medium','low','info')),
      category TEXT NOT NULL,
      location TEXT,
      evidence TEXT NOT NULL,
      suggestion TEXT,
      disposition TEXT CHECK (disposition IS NULL OR disposition IN ('open','accepted','dismissed','fixed','wont_fix')),
      snapshot_fingerprint TEXT NOT NULL,
      version INTEGER NOT NULL DEFAULT 1 ${VERSION},
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL ${TIMES},
      UNIQUE (project_id, id),
      FOREIGN KEY (project_id, review_id) REFERENCES review_requests(project_id, id) ON DELETE RESTRICT
    );
    CREATE INDEX agent_messages_project_status ON agent_messages(project_id, status, created_at DESC);
    CREATE INDEX agent_message_recipients_recipient_status ON agent_message_recipients(project_id, recipient_agent_id, delivery_status, ack_status);
    CREATE INDEX investigation_subscribers_subscriber ON investigation_subscribers(project_id, subscriber_type, subscriber_id);
    CREATE INDEX investigations_project_status ON investigations(project_id, status, updated_at DESC);
    CREATE INDEX findings_project_type_fingerprint ON findings(project_id, finding_type, fingerprint);
    CREATE INDEX investigation_results_finding ON investigation_results(project_id, finding_id);
    CREATE INDEX resource_claims_project_status_expiry ON resource_claims(project_id, status, expires_at);
    CREATE INDEX review_requests_project_status ON review_requests(project_id, status, updated_at DESC);
    CREATE INDEX review_findings_review ON review_findings(project_id, review_id, severity);
    CREATE TRIGGER resource_claims_exclusive_insert BEFORE INSERT ON resource_claims
    WHEN NEW.status = 'active' AND NEW.intent = 'exclusive' AND EXISTS (SELECT 1 FROM resource_claims WHERE project_id = NEW.project_id AND resource_type = NEW.resource_type AND selector = NEW.selector AND status = 'active')
    BEGIN SELECT RAISE(ABORT, 'active resource claim conflicts'); END;
    CREATE TRIGGER resource_claims_exclusive_update BEFORE UPDATE OF status, intent, resource_type, selector ON resource_claims
    WHEN NEW.status = 'active' AND NEW.intent = 'exclusive' AND EXISTS (SELECT 1 FROM resource_claims WHERE id <> NEW.id AND project_id = NEW.project_id AND resource_type = NEW.resource_type AND selector = NEW.selector AND status = 'active')
    BEGIN SELECT RAISE(ABORT, 'active resource claim conflicts'); END;
    CREATE TRIGGER resource_claims_shared_insert BEFORE INSERT ON resource_claims
    WHEN NEW.status = 'active' AND NEW.intent = 'shared-read' AND EXISTS (SELECT 1 FROM resource_claims WHERE project_id = NEW.project_id AND resource_type = NEW.resource_type AND selector = NEW.selector AND status = 'active' AND intent = 'exclusive')
    BEGIN SELECT RAISE(ABORT, 'shared claim conflicts with exclusive claim'); END;
    CREATE TRIGGER resource_claims_shared_update BEFORE UPDATE OF status, intent, resource_type, selector ON resource_claims
    WHEN NEW.status = 'active' AND NEW.intent = 'shared-read' AND EXISTS (SELECT 1 FROM resource_claims WHERE id <> NEW.id AND project_id = NEW.project_id AND resource_type = NEW.resource_type AND selector = NEW.selector AND status = 'active' AND intent = 'exclusive')
    BEGIN SELECT RAISE(ABORT, 'shared claim conflicts with exclusive claim'); END;
  `,
  `
    CREATE TABLE outbox (
      id TEXT PRIMARY KEY,
      message_type TEXT NOT NULL,
      aggregate_type TEXT NOT NULL,
      aggregate_id TEXT NOT NULL,
      correlation_id TEXT NOT NULL,
      payload_json TEXT NOT NULL ${JSON_VALUE},
      idempotency_key TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL CHECK (status IN ('pending','processing','delivered','failed','dead-letter')),
      attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
      next_attempt_at INTEGER NOT NULL,
      lease_until INTEGER,
      last_error TEXT,
      version INTEGER NOT NULL DEFAULT 1 ${VERSION},
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL ${TIMES}
    );
    CREATE TABLE processed_events (
      source TEXT NOT NULL,
      external_key TEXT NOT NULL,
      handler_version TEXT NOT NULL,
      processed_at INTEGER NOT NULL,
      result_digest TEXT,
      PRIMARY KEY (source, external_key, handler_version)
    );
    CREATE INDEX outbox_delivery ON outbox(status, next_attempt_at, lease_until);
  `,
  `
    CREATE TABLE domain_events (
      id TEXT PRIMARY KEY,
      event_type TEXT NOT NULL,
      event_version INTEGER NOT NULL CHECK (event_version >= 1),
      aggregate_type TEXT NOT NULL,
      aggregate_id TEXT NOT NULL,
      actor TEXT NOT NULL,
      correlation_id TEXT NOT NULL,
      payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
      occurred_at INTEGER NOT NULL
    );
    CREATE INDEX domain_events_aggregate ON domain_events(aggregate_type, aggregate_id, occurred_at, id);
  `,
  `
    -- Preserve legacy investigation pointers before installing the deprecation
    -- guard. A pointer is a fact: valid same-project pointers are copied to the
    -- normalized relation, while dangling pointers fail the upgrade explicitly.
    CREATE TEMP TABLE cp_result_pointer_preflight (id INTEGER NOT NULL);
    CREATE TEMP TRIGGER cp_result_pointer_preflight_guard
    BEFORE INSERT ON cp_result_pointer_preflight
    WHEN EXISTS (SELECT 1 FROM main.investigations AS i WHERE i.result_finding_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM main.findings AS f WHERE f.project_id = i.project_id AND f.id = i.result_finding_id))
    BEGIN SELECT RAISE(ABORT, 'CP-102 upgrade cannot preserve investigations.result_finding_id: no finding exists in the same project; repair the pointer and retry'); END;
    INSERT INTO cp_result_pointer_preflight VALUES (1);
    DROP TRIGGER cp_result_pointer_preflight_guard;
    DROP TABLE cp_result_pointer_preflight;
    INSERT OR IGNORE INTO investigation_results (project_id, investigation_id, finding_id, created_at)
      SELECT project_id, id, result_finding_id, MAX(0, CAST(created_at AS INTEGER))
      FROM investigations WHERE result_finding_id IS NOT NULL;

    -- Legacy rows are valid JSON and foreign-key checked, but older writers did
    -- not enforce shape, integer affinity, or one-result cardinality. Normalize
    -- those values before installing the stricter CP-102 guards.
    DROP TRIGGER decisions_immutable_content;
    CREATE TEMP TABLE cp_legacy_scopes (project_id TEXT NOT NULL, owner_type TEXT NOT NULL, owner_id TEXT NOT NULL, scope_json TEXT NOT NULL, created_at INTEGER NOT NULL);
    INSERT INTO cp_legacy_scopes SELECT project_id, 'decision_request', id, scope_json, MAX(0, CAST(created_at AS INTEGER)) FROM decision_requests WHERE json(scope_json) <> '{}';
    INSERT INTO cp_legacy_scopes SELECT project_id, 'decision', id, scope_json, MAX(0, CAST(created_at AS INTEGER)) FROM decisions WHERE json(scope_json) <> '{}';
    INSERT INTO cp_legacy_scopes SELECT project_id, 'assumption', id, scope_json, MAX(0, CAST(created_at AS INTEGER)) FROM assumptions WHERE json(scope_json) <> '{}';
    INSERT INTO cp_legacy_scopes SELECT project_id, 'agent_message', id, scope_json, MAX(0, CAST(created_at AS INTEGER)) FROM agent_messages WHERE json(scope_json) <> '{}';
    INSERT INTO cp_legacy_scopes SELECT project_id, 'investigation', id, scope_json, MAX(0, CAST(created_at AS INTEGER)) FROM investigations WHERE json(scope_json) <> '{}';
    INSERT INTO cp_legacy_scopes SELECT project_id, 'review_request', id, scope_json, MAX(0, CAST(created_at AS INTEGER)) FROM review_requests WHERE json(scope_json) <> '{}';
    UPDATE agent_profiles SET tool_set_json = CASE WHEN json_type(tool_set_json) = 'array' THEN tool_set_json ELSE json_array(json(tool_set_json)) END;
    UPDATE decision_clusters SET attention_json = CASE WHEN json_type(attention_json) = 'object' THEN attention_json ELSE json_object('legacyValue', json(attention_json)) END;
    UPDATE decision_requests SET options_json = CASE WHEN json_type(options_json) = 'array' THEN options_json ELSE json_array(json(options_json)) END,
      risk_json = CASE WHEN json_type(risk_json) = 'object' THEN risk_json ELSE json_object('legacyValue', json(risk_json)) END,
      scope_json = CASE WHEN json_type(scope_json) = 'object' THEN scope_json ELSE json_object('legacyValue', json(scope_json)) END,
      evidence_json = CASE WHEN json_type(evidence_json) = 'array' THEN evidence_json ELSE json_array(json(evidence_json)) END;
    UPDATE decisions SET scope_json = CASE WHEN json_type(scope_json) = 'object' THEN scope_json ELSE json_object('legacyValue', json(scope_json)) END,
      exceptions_json = CASE WHEN json_type(exceptions_json) = 'array' THEN exceptions_json ELSE json_array(json(exceptions_json)) END;
    UPDATE assumptions SET scope_json = CASE WHEN json_type(scope_json) = 'object' THEN scope_json ELSE json_object('legacyValue', json(scope_json)) END,
      evidence_json = CASE WHEN json_type(evidence_json) = 'array' THEN evidence_json ELSE json_array(json(evidence_json)) END;
    UPDATE agent_messages SET scope_json = CASE WHEN json_type(scope_json) = 'object' THEN scope_json ELSE json_object('legacyValue', json(scope_json)) END,
      payload_json = CASE WHEN json_type(payload_json) = 'object' THEN payload_json ELSE json_object('legacyValue', json(payload_json)) END,
      references_json = CASE WHEN json_type(references_json) = 'array' THEN references_json ELSE json_array(json(references_json)) END;
    UPDATE investigations SET scope_json = CASE WHEN json_type(scope_json) = 'object' THEN scope_json ELSE json_object('legacyValue', json(scope_json)) END;
    UPDATE findings SET references_json = CASE WHEN json_type(references_json) = 'array' THEN references_json ELSE json_array(json(references_json)) END;
    UPDATE review_requests SET scope_json = CASE WHEN json_type(scope_json) = 'object' THEN scope_json ELSE json_object('legacyValue', json(scope_json)) END,
      policy_json = CASE WHEN json_type(policy_json) = 'object' THEN policy_json ELSE json_object('legacyValue', json(policy_json)) END;

    UPDATE control_projects SET onboarding_version = MAX(1, CAST(onboarding_version AS INTEGER)), policy_version = MAX(1, CAST(policy_version AS INTEGER)), version = MAX(1, CAST(version AS INTEGER)), created_at = MAX(0, CAST(created_at AS INTEGER)), updated_at = MAX(0, CAST(updated_at AS INTEGER));
    UPDATE agent_profiles SET instructions_version = MAX(1, CAST(instructions_version AS INTEGER)), version = MAX(1, CAST(version AS INTEGER)), created_at = MAX(0, CAST(created_at AS INTEGER)), updated_at = MAX(0, CAST(updated_at AS INTEGER));
    UPDATE managed_agents SET profile_version = MAX(1, CAST(profile_version AS INTEGER)), version = MAX(1, CAST(version AS INTEGER)), created_at = MAX(0, CAST(created_at AS INTEGER)), updated_at = MAX(0, CAST(updated_at AS INTEGER)), last_health_check_at = CASE WHEN last_health_check_at IS NULL THEN NULL ELSE MAX(0, CAST(last_health_check_at AS INTEGER)) END, retired_at = CASE WHEN retired_at IS NULL THEN NULL ELSE MAX(0, CAST(retired_at AS INTEGER)) END;
    UPDATE work_sessions SET plan_version = MAX(1, CAST(plan_version AS INTEGER)), version = MAX(1, CAST(version AS INTEGER)), created_at = MAX(0, CAST(created_at AS INTEGER)), updated_at = MAX(0, CAST(updated_at AS INTEGER));
    UPDATE task_dependencies SET version = MAX(1, CAST(version AS INTEGER)), created_at = MAX(0, CAST(created_at AS INTEGER)), updated_at = MAX(0, CAST(updated_at AS INTEGER));
    UPDATE decision_clusters SET version = MAX(1, CAST(version AS INTEGER)), created_at = MAX(0, CAST(created_at AS INTEGER)), updated_at = MAX(0, CAST(updated_at AS INTEGER));
    UPDATE decision_requests SET version = MAX(1, CAST(version AS INTEGER)), created_at = MAX(0, CAST(created_at AS INTEGER)), updated_at = MAX(0, CAST(updated_at AS INTEGER));
    UPDATE decisions SET version = MAX(1, CAST(version AS INTEGER)), created_at = MAX(0, CAST(created_at AS INTEGER)), updated_at = MAX(0, CAST(updated_at AS INTEGER)), effective_at = CASE WHEN effective_at IS NULL THEN NULL ELSE MAX(0, CAST(effective_at AS INTEGER)) END;
    UPDATE assumptions SET confidence = MIN(100, MAX(0, CAST(confidence AS INTEGER))), reversibility = MIN(100, MAX(0, CAST(reversibility AS INTEGER))), blast_radius = MIN(100, MAX(0, CAST(blast_radius AS INTEGER))), version = MAX(1, CAST(version AS INTEGER)), created_at = MAX(0, CAST(created_at AS INTEGER)), updated_at = MAX(0, CAST(updated_at AS INTEGER));
    UPDATE human_inputs SET priority = MIN(100, MAX(0, CAST(priority AS INTEGER))), version = MAX(1, CAST(version AS INTEGER)), created_at = MAX(0, CAST(created_at AS INTEGER)), updated_at = MAX(0, CAST(updated_at AS INTEGER));
    UPDATE agent_messages SET urgency = MIN(100, MAX(0, CAST(urgency AS INTEGER))), version = MAX(1, CAST(version AS INTEGER)), created_at = MAX(0, CAST(created_at AS INTEGER)), updated_at = MAX(0, CAST(updated_at AS INTEGER));
    UPDATE investigations SET revision = MAX(1, CAST(revision AS INTEGER)), version = MAX(1, CAST(version AS INTEGER)), created_at = MAX(0, CAST(created_at AS INTEGER)), updated_at = MAX(0, CAST(updated_at AS INTEGER));
    UPDATE findings SET confidence = MIN(100, MAX(0, CAST(confidence AS INTEGER))), version = MAX(1, CAST(version AS INTEGER)), created_at = MAX(0, CAST(created_at AS INTEGER)), updated_at = MAX(0, CAST(updated_at AS INTEGER));
    UPDATE resource_claims SET expires_at = MAX(0, CAST(expires_at AS INTEGER)), heartbeat_at = MAX(0, CAST(heartbeat_at AS INTEGER)), version = MAX(1, CAST(version AS INTEGER)), created_at = MAX(0, CAST(created_at AS INTEGER)), updated_at = MAX(0, CAST(updated_at AS INTEGER));
    UPDATE review_requests SET version = MAX(1, CAST(version AS INTEGER)), created_at = MAX(0, CAST(created_at AS INTEGER)), updated_at = MAX(0, CAST(updated_at AS INTEGER));
    UPDATE review_findings SET version = MAX(1, CAST(version AS INTEGER)), created_at = MAX(0, CAST(created_at AS INTEGER)), updated_at = MAX(0, CAST(updated_at AS INTEGER));
    UPDATE domain_events SET event_version = MAX(1, CAST(event_version AS INTEGER)), occurred_at = MAX(0, CAST(occurred_at AS INTEGER));
    UPDATE processed_events SET processed_at = MAX(0, CAST(processed_at AS INTEGER));
    UPDATE decision_cluster_requests SET created_at = MAX(0, CAST(created_at AS INTEGER));
    UPDATE investigation_results SET created_at = MAX(0, CAST(created_at AS INTEGER));
    UPDATE decision_resolutions SET resolved_at = MAX(0, CAST(resolved_at AS INTEGER));
    UPDATE investigation_subscribers SET created_at = MAX(0, CAST(created_at AS INTEGER));
    UPDATE agent_message_recipients SET delivered_at = CASE WHEN delivered_at IS NULL THEN NULL ELSE MAX(0, CAST(delivered_at AS INTEGER)) END, acknowledged_at = CASE WHEN acknowledged_at IS NULL THEN NULL ELSE MAX(0, CAST(acknowledged_at AS INTEGER)) END;

    -- Historical relation cardinality is retained. Application-level cleanup
    -- may resolve duplicate cluster membership or multiple findings later.
    CREATE TABLE control_plane_migration_hashes (
      migration_id INTEGER PRIMARY KEY CHECK (migration_id BETWEEN 0 AND 4),
      sha256 TEXT NOT NULL CHECK (length(sha256) = 64)
    );
    INSERT INTO control_plane_migration_hashes (migration_id, sha256) VALUES
      (0, 'e4869212a6fecda8c49fb4ddffb2742eb632099e900b669cb02960f6cabf22f8'),
      (1, '6b73d0e40555198543edb80232930f6186119ed74bccc3286746952ec40869b9'),
      (2, '990619dcccc71cdbb3d1f4a65dcd8406038960e996eb8b28d2b3877ce891f7c0'),
      (3, '4838116f05e54404bf86a462ad214a85ed1ebca011506990d734d793764573d4'),
      (4, '55f60a3cb8887b4410d4473333dc99365aec427069806e6d7cd1c3d04d587a29');

    CREATE TABLE decision_request_scope_refs (
      project_id TEXT NOT NULL,
      request_id TEXT NOT NULL,
      scope_type TEXT NOT NULL CHECK (length(trim(scope_type)) > 0),
      external_ref TEXT NOT NULL CHECK (length(trim(external_ref)) > 0),
      created_at INTEGER NOT NULL CHECK (typeof(created_at) = 'integer' AND created_at >= 0),
      PRIMARY KEY (project_id, request_id, scope_type, external_ref),
      FOREIGN KEY (project_id, request_id) REFERENCES decision_requests(project_id, id) ON DELETE RESTRICT
    );
    CREATE INDEX decision_request_scope_refs_reverse ON decision_request_scope_refs(project_id, scope_type, external_ref, request_id);
    CREATE TABLE decision_scope_refs (
      project_id TEXT NOT NULL,
      decision_id TEXT NOT NULL,
      scope_type TEXT NOT NULL CHECK (length(trim(scope_type)) > 0),
      external_ref TEXT NOT NULL CHECK (length(trim(external_ref)) > 0),
      created_at INTEGER NOT NULL CHECK (typeof(created_at) = 'integer' AND created_at >= 0),
      PRIMARY KEY (project_id, decision_id, scope_type, external_ref),
      FOREIGN KEY (project_id, decision_id) REFERENCES decisions(project_id, id) ON DELETE RESTRICT
    );
    CREATE INDEX decision_scope_refs_reverse ON decision_scope_refs(project_id, scope_type, external_ref, decision_id);
    CREATE TABLE assumption_scope_refs (
      project_id TEXT NOT NULL,
      assumption_id TEXT NOT NULL,
      scope_type TEXT NOT NULL CHECK (length(trim(scope_type)) > 0),
      external_ref TEXT NOT NULL CHECK (length(trim(external_ref)) > 0),
      created_at INTEGER NOT NULL CHECK (typeof(created_at) = 'integer' AND created_at >= 0),
      PRIMARY KEY (project_id, assumption_id, scope_type, external_ref),
      FOREIGN KEY (project_id, assumption_id) REFERENCES assumptions(project_id, id) ON DELETE RESTRICT
    );
    CREATE INDEX assumption_scope_refs_reverse ON assumption_scope_refs(project_id, scope_type, external_ref, assumption_id);
    CREATE TABLE agent_message_scope_refs (
      project_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      scope_type TEXT NOT NULL CHECK (length(trim(scope_type)) > 0),
      external_ref TEXT NOT NULL CHECK (length(trim(external_ref)) > 0),
      created_at INTEGER NOT NULL CHECK (typeof(created_at) = 'integer' AND created_at >= 0),
      PRIMARY KEY (project_id, message_id, scope_type, external_ref),
      FOREIGN KEY (project_id, message_id) REFERENCES agent_messages(project_id, id) ON DELETE RESTRICT
    );
    CREATE INDEX agent_message_scope_refs_reverse ON agent_message_scope_refs(project_id, scope_type, external_ref, message_id);
    CREATE TABLE investigation_scope_refs (
      project_id TEXT NOT NULL,
      investigation_id TEXT NOT NULL,
      scope_type TEXT NOT NULL CHECK (length(trim(scope_type)) > 0),
      external_ref TEXT NOT NULL CHECK (length(trim(external_ref)) > 0),
      created_at INTEGER NOT NULL CHECK (typeof(created_at) = 'integer' AND created_at >= 0),
      PRIMARY KEY (project_id, investigation_id, scope_type, external_ref),
      FOREIGN KEY (project_id, investigation_id) REFERENCES investigations(project_id, id) ON DELETE RESTRICT
    );
    CREATE INDEX investigation_scope_refs_reverse ON investigation_scope_refs(project_id, scope_type, external_ref, investigation_id);
    CREATE TABLE review_request_scope_refs (
      project_id TEXT NOT NULL,
      review_request_id TEXT NOT NULL,
      scope_type TEXT NOT NULL CHECK (length(trim(scope_type)) > 0),
      external_ref TEXT NOT NULL CHECK (length(trim(external_ref)) > 0),
      created_at INTEGER NOT NULL CHECK (typeof(created_at) = 'integer' AND created_at >= 0),
      PRIMARY KEY (project_id, review_request_id, scope_type, external_ref),
      FOREIGN KEY (project_id, review_request_id) REFERENCES review_requests(project_id, id) ON DELETE RESTRICT
    );
    CREATE INDEX review_request_scope_refs_reverse ON review_request_scope_refs(project_id, scope_type, external_ref, review_request_id);

    CREATE TABLE agent_message_targets (
      project_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      target_type TEXT NOT NULL CHECK (target_type IN ('agent','role','task','run')),
      target_id TEXT NOT NULL CHECK (length(trim(target_id)) > 0),
      delivery_status TEXT NOT NULL CHECK (delivery_status IN ('pending','delivered','failed','expired')),
      ack_status TEXT NOT NULL CHECK (ack_status IN ('pending','acknowledged','declined')),
      delivered_at INTEGER CHECK (delivered_at IS NULL OR (typeof(delivered_at) = 'integer' AND delivered_at >= 0)),
      acknowledged_at INTEGER CHECK (acknowledged_at IS NULL OR (typeof(acknowledged_at) = 'integer' AND acknowledged_at >= 0)),
      created_at INTEGER NOT NULL CHECK (typeof(created_at) = 'integer' AND created_at >= 0),
      PRIMARY KEY (project_id, message_id, target_type, target_id),
      FOREIGN KEY (project_id, message_id) REFERENCES agent_messages(project_id, id) ON DELETE RESTRICT
    );
    CREATE INDEX agent_message_targets_lookup ON agent_message_targets(project_id, target_type, target_id, delivery_status, ack_status);
    INSERT INTO agent_message_targets (project_id, message_id, target_type, target_id, delivery_status, ack_status, delivered_at, acknowledged_at, created_at)
      SELECT project_id, message_id, 'agent', recipient_agent_id, delivery_status, ack_status, delivered_at, acknowledged_at,
        COALESCE((SELECT created_at FROM agent_messages WHERE agent_messages.project_id = agent_message_recipients.project_id AND agent_messages.id = agent_message_recipients.message_id), 0)
      FROM agent_message_recipients;

    CREATE TABLE command_receipts (
      idempotency_key TEXT PRIMARY KEY,
      command_type TEXT NOT NULL,
      project_id TEXT,
      request_hash TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('processing','completed','failed')),
      response_json TEXT CHECK (response_json IS NULL OR json_valid(response_json)),
      error_json TEXT CHECK (error_json IS NULL OR json_valid(error_json)),
      version INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL CHECK (typeof(created_at) = 'integer' AND created_at >= 0),
      updated_at INTEGER NOT NULL CHECK (typeof(updated_at) = 'integer' AND updated_at >= created_at),
      FOREIGN KEY (project_id) REFERENCES control_projects(id) ON DELETE RESTRICT
    );
    CREATE INDEX command_receipts_lookup ON command_receipts(project_id, command_type, status, updated_at DESC);

    INSERT INTO decision_request_scope_refs (project_id, request_id, scope_type, external_ref, created_at)
      SELECT project_id, owner_id, 'legacy-json', scope_json, created_at FROM cp_legacy_scopes WHERE owner_type = 'decision_request';
    INSERT INTO decision_scope_refs (project_id, decision_id, scope_type, external_ref, created_at)
      SELECT project_id, owner_id, 'legacy-json', scope_json, created_at FROM cp_legacy_scopes WHERE owner_type = 'decision';
    INSERT INTO assumption_scope_refs (project_id, assumption_id, scope_type, external_ref, created_at)
      SELECT project_id, owner_id, 'legacy-json', scope_json, created_at FROM cp_legacy_scopes WHERE owner_type = 'assumption';
    INSERT INTO agent_message_scope_refs (project_id, message_id, scope_type, external_ref, created_at)
      SELECT project_id, owner_id, 'legacy-json', scope_json, created_at FROM cp_legacy_scopes WHERE owner_type = 'agent_message';
    INSERT INTO investigation_scope_refs (project_id, investigation_id, scope_type, external_ref, created_at)
      SELECT project_id, owner_id, 'legacy-json', scope_json, created_at FROM cp_legacy_scopes WHERE owner_type = 'investigation';
    INSERT INTO review_request_scope_refs (project_id, review_request_id, scope_type, external_ref, created_at)
      SELECT project_id, owner_id, 'legacy-json', scope_json, created_at FROM cp_legacy_scopes WHERE owner_type = 'review_request';
    DROP TABLE cp_legacy_scopes;

    CREATE INDEX work_sessions_project_order ON work_sessions(project_id, updated_at DESC, id DESC);
    CREATE INDEX work_sessions_project_status_order ON work_sessions(project_id, status, updated_at DESC, id DESC);
    CREATE INDEX control_projects_order ON control_projects(updated_at DESC, id DESC);
    CREATE INDEX control_projects_status_order ON control_projects(status, updated_at DESC, id DESC);
    CREATE INDEX decision_requests_project_order ON decision_requests(project_id, updated_at DESC, id DESC);
    CREATE INDEX decision_requests_project_status_order ON decision_requests(project_id, status, updated_at DESC, id DESC);

    DROP TRIGGER resource_claims_exclusive_update;
    DROP TRIGGER resource_claims_shared_update;
    CREATE TRIGGER decisions_immutable_content BEFORE UPDATE OF chosen_option, rationale, scope_json, exceptions_json, authority, actor_type, actor_id ON decisions
    WHEN OLD.chosen_option IS NOT NEW.chosen_option OR OLD.rationale IS NOT NEW.rationale OR OLD.scope_json IS NOT NEW.scope_json OR OLD.exceptions_json IS NOT NEW.exceptions_json OR OLD.authority IS NOT NEW.authority OR OLD.actor_type IS NOT NEW.actor_type OR OLD.actor_id IS NOT NEW.actor_id
    BEGIN SELECT RAISE(ABORT, 'decision content is immutable; create a successor'); END;
    CREATE TRIGGER resource_claims_exclusive_update BEFORE UPDATE OF project_id, status, intent, resource_type, selector ON resource_claims
    WHEN NEW.status = 'active' AND NEW.intent = 'exclusive' AND EXISTS (SELECT 1 FROM resource_claims WHERE id <> NEW.id AND project_id = NEW.project_id AND resource_type = NEW.resource_type AND selector = NEW.selector AND status = 'active')
    BEGIN SELECT RAISE(ABORT, 'active resource claim conflicts'); END;
    CREATE TRIGGER resource_claims_shared_update BEFORE UPDATE OF project_id, status, intent, resource_type, selector ON resource_claims
    WHEN NEW.status = 'active' AND NEW.intent = 'shared-read' AND EXISTS (SELECT 1 FROM resource_claims WHERE id <> NEW.id AND project_id = NEW.project_id AND resource_type = NEW.resource_type AND selector = NEW.selector AND status = 'active' AND intent = 'exclusive')
    BEGIN SELECT RAISE(ABORT, 'shared claim conflicts with exclusive claim'); END;

    CREATE TRIGGER control_projects_no_delete BEFORE DELETE ON control_projects
    BEGIN SELECT RAISE(ABORT, 'control projects are logically archived; physical deletion is forbidden'); END;
    CREATE TRIGGER managed_agents_project_guard BEFORE INSERT ON managed_agents
    WHEN NOT EXISTS (SELECT 1 FROM control_projects WHERE id = NEW.project_id)
    BEGIN SELECT RAISE(ABORT, 'managed agent project does not exist'); END;
    CREATE TRIGGER managed_agents_project_update_guard BEFORE UPDATE OF project_id ON managed_agents
    WHEN NOT EXISTS (SELECT 1 FROM control_projects WHERE id = NEW.project_id)
    BEGIN SELECT RAISE(ABORT, 'managed agent project does not exist'); END;
    CREATE TRIGGER managed_agents_target_reference_update_guard BEFORE UPDATE OF project_id, id ON managed_agents
    WHEN (NEW.project_id IS NOT OLD.project_id OR NEW.id IS NOT OLD.id) AND EXISTS (SELECT 1 FROM agent_message_targets WHERE target_type = 'agent' AND project_id = OLD.project_id AND target_id = OLD.id)
    BEGIN SELECT RAISE(ABORT, 'managed agent identity is referenced by agent message targets'); END;
    CREATE TRIGGER managed_agents_target_reference_delete_guard BEFORE DELETE ON managed_agents
    WHEN EXISTS (SELECT 1 FROM agent_message_targets WHERE target_type = 'agent' AND project_id = OLD.project_id AND target_id = OLD.id)
    BEGIN SELECT RAISE(ABORT, 'managed agent is referenced by agent message targets'); END;
    CREATE TRIGGER decision_findings_no_self_supersession BEFORE INSERT ON findings
    WHEN NEW.superseded_by_id = NEW.id
    BEGIN SELECT RAISE(ABORT, 'finding cannot supersede itself'); END;
    CREATE TRIGGER decision_findings_no_self_supersession_update BEFORE UPDATE OF superseded_by_id ON findings
    WHEN NEW.superseded_by_id = NEW.id
    BEGIN SELECT RAISE(ABORT, 'finding cannot supersede itself'); END;
    CREATE TRIGGER investigations_result_finding_deprecated BEFORE INSERT ON investigations
    WHEN NEW.result_finding_id IS NOT NULL
    BEGIN SELECT RAISE(ABORT, 'investigation_results is authoritative; result_finding_id is deprecated'); END;
    CREATE TRIGGER investigations_result_finding_deprecated_update BEFORE UPDATE OF result_finding_id ON investigations
    WHEN NEW.result_finding_id IS NOT NULL AND NEW.result_finding_id IS NOT OLD.result_finding_id
    BEGIN SELECT RAISE(ABORT, 'investigation_results is authoritative; result_finding_id is deprecated'); END;

    CREATE TRIGGER control_projects_integer_fields_insert BEFORE INSERT ON control_projects
    WHEN typeof(NEW.version) <> 'integer' OR NEW.version < 1 OR typeof(NEW.onboarding_version) <> 'integer' OR NEW.onboarding_version < 1 OR typeof(NEW.policy_version) <> 'integer' OR NEW.policy_version < 1 OR typeof(NEW.created_at) <> 'integer' OR NEW.created_at < 0 OR typeof(NEW.updated_at) <> 'integer' OR NEW.updated_at < 0
    BEGIN SELECT RAISE(ABORT, 'control project versions and timestamps must be integers'); END;
    CREATE TRIGGER control_projects_integer_fields_update BEFORE UPDATE ON control_projects
    WHEN typeof(NEW.version) <> 'integer' OR NEW.version < 1 OR typeof(NEW.onboarding_version) <> 'integer' OR NEW.onboarding_version < 1 OR typeof(NEW.policy_version) <> 'integer' OR NEW.policy_version < 1 OR typeof(NEW.created_at) <> 'integer' OR NEW.created_at < 0 OR typeof(NEW.updated_at) <> 'integer' OR NEW.updated_at < 0
    BEGIN SELECT RAISE(ABORT, 'control project versions and timestamps must be integers'); END;
    CREATE TRIGGER agent_profiles_integer_fields_insert BEFORE INSERT ON agent_profiles
    WHEN typeof(NEW.version) <> 'integer' OR NEW.version < 1 OR typeof(NEW.instructions_version) <> 'integer' OR NEW.instructions_version < 1 OR typeof(NEW.created_at) <> 'integer' OR NEW.created_at < 0 OR typeof(NEW.updated_at) <> 'integer' OR NEW.updated_at < 0
    BEGIN SELECT RAISE(ABORT, 'agent profile versions and timestamps must be integers'); END;
    CREATE TRIGGER agent_profiles_integer_fields_update BEFORE UPDATE ON agent_profiles
    WHEN typeof(NEW.version) <> 'integer' OR NEW.version < 1 OR typeof(NEW.instructions_version) <> 'integer' OR NEW.instructions_version < 1 OR typeof(NEW.created_at) <> 'integer' OR NEW.created_at < 0 OR typeof(NEW.updated_at) <> 'integer' OR NEW.updated_at < 0
    BEGIN SELECT RAISE(ABORT, 'agent profile versions and timestamps must be integers'); END;
    CREATE TRIGGER managed_agents_integer_fields_insert BEFORE INSERT ON managed_agents
    WHEN typeof(NEW.version) <> 'integer' OR NEW.version < 1 OR typeof(NEW.profile_version) <> 'integer' OR NEW.profile_version < 1 OR typeof(NEW.created_at) <> 'integer' OR NEW.created_at < 0 OR typeof(NEW.updated_at) <> 'integer' OR NEW.updated_at < 0 OR (NEW.last_health_check_at IS NOT NULL AND (typeof(NEW.last_health_check_at) <> 'integer' OR NEW.last_health_check_at < 0)) OR (NEW.retired_at IS NOT NULL AND (typeof(NEW.retired_at) <> 'integer' OR NEW.retired_at < 0))
    BEGIN SELECT RAISE(ABORT, 'managed agent versions and timestamps must be integers'); END;
    CREATE TRIGGER managed_agents_integer_fields_update BEFORE UPDATE ON managed_agents
    WHEN typeof(NEW.version) <> 'integer' OR NEW.version < 1 OR typeof(NEW.profile_version) <> 'integer' OR NEW.profile_version < 1 OR typeof(NEW.created_at) <> 'integer' OR NEW.created_at < 0 OR typeof(NEW.updated_at) <> 'integer' OR NEW.updated_at < 0 OR (NEW.last_health_check_at IS NOT NULL AND (typeof(NEW.last_health_check_at) <> 'integer' OR NEW.last_health_check_at < 0)) OR (NEW.retired_at IS NOT NULL AND (typeof(NEW.retired_at) <> 'integer' OR NEW.retired_at < 0))
    BEGIN SELECT RAISE(ABORT, 'managed agent versions and timestamps must be integers'); END;
    CREATE TRIGGER work_sessions_integer_fields_insert BEFORE INSERT ON work_sessions
    WHEN typeof(NEW.version) <> 'integer' OR NEW.version < 1 OR typeof(NEW.plan_version) <> 'integer' OR NEW.plan_version < 1 OR typeof(NEW.created_at) <> 'integer' OR NEW.created_at < 0 OR typeof(NEW.updated_at) <> 'integer' OR NEW.updated_at < 0
    BEGIN SELECT RAISE(ABORT, 'work session versions and timestamps must be integers'); END;
    CREATE TRIGGER work_sessions_integer_fields_update BEFORE UPDATE ON work_sessions
    WHEN typeof(NEW.version) <> 'integer' OR NEW.version < 1 OR typeof(NEW.plan_version) <> 'integer' OR NEW.plan_version < 1 OR typeof(NEW.created_at) <> 'integer' OR NEW.created_at < 0 OR typeof(NEW.updated_at) <> 'integer' OR NEW.updated_at < 0
    BEGIN SELECT RAISE(ABORT, 'work session versions and timestamps must be integers'); END;
    CREATE TRIGGER task_dependencies_integer_fields_insert BEFORE INSERT ON task_dependencies
    WHEN typeof(NEW.version) <> 'integer' OR NEW.version < 1 OR typeof(NEW.created_at) <> 'integer' OR NEW.created_at < 0 OR typeof(NEW.updated_at) <> 'integer' OR NEW.updated_at < 0
    BEGIN SELECT RAISE(ABORT, 'task dependency versions and timestamps must be integers'); END;
    CREATE TRIGGER task_dependencies_integer_fields_update BEFORE UPDATE ON task_dependencies
    WHEN typeof(NEW.version) <> 'integer' OR NEW.version < 1 OR typeof(NEW.created_at) <> 'integer' OR NEW.created_at < 0 OR typeof(NEW.updated_at) <> 'integer' OR NEW.updated_at < 0
    BEGIN SELECT RAISE(ABORT, 'task dependency versions and timestamps must be integers'); END;
    CREATE TRIGGER decision_clusters_integer_fields_insert BEFORE INSERT ON decision_clusters WHEN typeof(NEW.version) <> 'integer' OR NEW.version < 1 OR typeof(NEW.created_at) <> 'integer' OR NEW.created_at < 0 OR typeof(NEW.updated_at) <> 'integer' OR NEW.updated_at < 0 BEGIN SELECT RAISE(ABORT, 'decision cluster versions and timestamps must be integers'); END;
    CREATE TRIGGER decision_clusters_integer_fields_update BEFORE UPDATE ON decision_clusters WHEN typeof(NEW.version) <> 'integer' OR NEW.version < 1 OR typeof(NEW.created_at) <> 'integer' OR NEW.created_at < 0 OR typeof(NEW.updated_at) <> 'integer' OR NEW.updated_at < 0 BEGIN SELECT RAISE(ABORT, 'decision cluster versions and timestamps must be integers'); END;
    CREATE TRIGGER decision_requests_integer_fields_insert BEFORE INSERT ON decision_requests WHEN typeof(NEW.version) <> 'integer' OR NEW.version < 1 OR typeof(NEW.created_at) <> 'integer' OR NEW.created_at < 0 OR typeof(NEW.updated_at) <> 'integer' OR NEW.updated_at < 0 BEGIN SELECT RAISE(ABORT, 'decision request versions and timestamps must be integers'); END;
    CREATE TRIGGER decision_requests_integer_fields_update BEFORE UPDATE ON decision_requests WHEN typeof(NEW.version) <> 'integer' OR NEW.version < 1 OR typeof(NEW.created_at) <> 'integer' OR NEW.created_at < 0 OR typeof(NEW.updated_at) <> 'integer' OR NEW.updated_at < 0 BEGIN SELECT RAISE(ABORT, 'decision request versions and timestamps must be integers'); END;
    CREATE TRIGGER decisions_integer_fields_insert BEFORE INSERT ON decisions WHEN typeof(NEW.version) <> 'integer' OR NEW.version < 1 OR typeof(NEW.created_at) <> 'integer' OR NEW.created_at < 0 OR typeof(NEW.updated_at) <> 'integer' OR NEW.updated_at < 0 OR (NEW.effective_at IS NOT NULL AND (typeof(NEW.effective_at) <> 'integer' OR NEW.effective_at < 0)) BEGIN SELECT RAISE(ABORT, 'decision versions and timestamps must be integers'); END;
    CREATE TRIGGER decisions_integer_fields_update BEFORE UPDATE ON decisions WHEN typeof(NEW.version) <> 'integer' OR NEW.version < 1 OR typeof(NEW.created_at) <> 'integer' OR NEW.created_at < 0 OR typeof(NEW.updated_at) <> 'integer' OR NEW.updated_at < 0 OR (NEW.effective_at IS NOT NULL AND (typeof(NEW.effective_at) <> 'integer' OR NEW.effective_at < 0)) BEGIN SELECT RAISE(ABORT, 'decision versions and timestamps must be integers'); END;
    CREATE TRIGGER assumptions_integer_fields_insert BEFORE INSERT ON assumptions WHEN typeof(NEW.version) <> 'integer' OR NEW.version < 1 OR typeof(NEW.confidence) <> 'integer' OR NEW.confidence < 0 OR NEW.confidence > 100 OR typeof(NEW.reversibility) <> 'integer' OR NEW.reversibility < 0 OR NEW.reversibility > 100 OR typeof(NEW.blast_radius) <> 'integer' OR NEW.blast_radius < 0 OR NEW.blast_radius > 100 OR typeof(NEW.created_at) <> 'integer' OR NEW.created_at < 0 OR typeof(NEW.updated_at) <> 'integer' OR NEW.updated_at < 0 BEGIN SELECT RAISE(ABORT, 'assumption scores, versions and timestamps must be integers'); END;
    CREATE TRIGGER assumptions_integer_fields_update BEFORE UPDATE ON assumptions WHEN typeof(NEW.version) <> 'integer' OR NEW.version < 1 OR typeof(NEW.confidence) <> 'integer' OR NEW.confidence < 0 OR NEW.confidence > 100 OR typeof(NEW.reversibility) <> 'integer' OR NEW.reversibility < 0 OR NEW.reversibility > 100 OR typeof(NEW.blast_radius) <> 'integer' OR NEW.blast_radius < 0 OR NEW.blast_radius > 100 OR typeof(NEW.created_at) <> 'integer' OR NEW.created_at < 0 OR typeof(NEW.updated_at) <> 'integer' OR NEW.updated_at < 0 BEGIN SELECT RAISE(ABORT, 'assumption scores, versions and timestamps must be integers'); END;
    CREATE TRIGGER human_inputs_integer_fields_insert BEFORE INSERT ON human_inputs WHEN typeof(NEW.version) <> 'integer' OR NEW.version < 1 OR typeof(NEW.priority) <> 'integer' OR NEW.priority < 0 OR NEW.priority > 100 OR typeof(NEW.created_at) <> 'integer' OR NEW.created_at < 0 OR typeof(NEW.updated_at) <> 'integer' OR NEW.updated_at < 0 BEGIN SELECT RAISE(ABORT, 'human input versions and timestamps must be integers'); END;
    CREATE TRIGGER human_inputs_integer_fields_update BEFORE UPDATE ON human_inputs WHEN typeof(NEW.version) <> 'integer' OR NEW.version < 1 OR typeof(NEW.priority) <> 'integer' OR NEW.priority < 0 OR NEW.priority > 100 OR typeof(NEW.created_at) <> 'integer' OR NEW.created_at < 0 OR typeof(NEW.updated_at) <> 'integer' OR NEW.updated_at < 0 BEGIN SELECT RAISE(ABORT, 'human input versions and timestamps must be integers'); END;
    CREATE TRIGGER agent_messages_integer_fields_insert BEFORE INSERT ON agent_messages WHEN typeof(NEW.version) <> 'integer' OR NEW.version < 1 OR typeof(NEW.urgency) <> 'integer' OR NEW.urgency < 0 OR NEW.urgency > 100 OR typeof(NEW.created_at) <> 'integer' OR NEW.created_at < 0 OR typeof(NEW.updated_at) <> 'integer' OR NEW.updated_at < 0 BEGIN SELECT RAISE(ABORT, 'agent message versions and timestamps must be integers'); END;
    CREATE TRIGGER agent_messages_integer_fields_update BEFORE UPDATE ON agent_messages WHEN typeof(NEW.version) <> 'integer' OR NEW.version < 1 OR typeof(NEW.urgency) <> 'integer' OR NEW.urgency < 0 OR NEW.urgency > 100 OR typeof(NEW.created_at) <> 'integer' OR NEW.created_at < 0 OR typeof(NEW.updated_at) <> 'integer' OR NEW.updated_at < 0 BEGIN SELECT RAISE(ABORT, 'agent message versions and timestamps must be integers'); END;
    CREATE TRIGGER investigations_integer_fields_insert BEFORE INSERT ON investigations WHEN typeof(NEW.version) <> 'integer' OR NEW.version < 1 OR typeof(NEW.revision) <> 'integer' OR NEW.revision < 1 OR typeof(NEW.created_at) <> 'integer' OR NEW.created_at < 0 OR typeof(NEW.updated_at) <> 'integer' OR NEW.updated_at < 0 BEGIN SELECT RAISE(ABORT, 'investigation versions and timestamps must be integers'); END;
    CREATE TRIGGER investigations_integer_fields_update BEFORE UPDATE ON investigations WHEN typeof(NEW.version) <> 'integer' OR NEW.version < 1 OR typeof(NEW.revision) <> 'integer' OR NEW.revision < 1 OR typeof(NEW.created_at) <> 'integer' OR NEW.created_at < 0 OR typeof(NEW.updated_at) <> 'integer' OR NEW.updated_at < 0 BEGIN SELECT RAISE(ABORT, 'investigation versions and timestamps must be integers'); END;
    CREATE TRIGGER findings_integer_fields_insert BEFORE INSERT ON findings WHEN typeof(NEW.version) <> 'integer' OR NEW.version < 1 OR typeof(NEW.confidence) <> 'integer' OR typeof(NEW.created_at) <> 'integer' OR NEW.created_at < 0 OR typeof(NEW.updated_at) <> 'integer' OR NEW.updated_at < 0 BEGIN SELECT RAISE(ABORT, 'finding versions and timestamps must be integers'); END;
    CREATE TRIGGER findings_integer_fields_update BEFORE UPDATE ON findings WHEN typeof(NEW.version) <> 'integer' OR NEW.version < 1 OR typeof(NEW.confidence) <> 'integer' OR typeof(NEW.created_at) <> 'integer' OR NEW.created_at < 0 OR typeof(NEW.updated_at) <> 'integer' OR NEW.updated_at < 0 BEGIN SELECT RAISE(ABORT, 'finding versions and timestamps must be integers'); END;
    CREATE TRIGGER resource_claims_integer_fields_insert BEFORE INSERT ON resource_claims WHEN typeof(NEW.version) <> 'integer' OR NEW.version < 1 OR typeof(NEW.expires_at) <> 'integer' OR NEW.expires_at < 0 OR typeof(NEW.heartbeat_at) <> 'integer' OR NEW.heartbeat_at < 0 OR typeof(NEW.created_at) <> 'integer' OR NEW.created_at < 0 OR typeof(NEW.updated_at) <> 'integer' OR NEW.updated_at < 0 BEGIN SELECT RAISE(ABORT, 'resource claim versions and timestamps must be integers'); END;
    CREATE TRIGGER resource_claims_integer_fields_update BEFORE UPDATE ON resource_claims WHEN typeof(NEW.version) <> 'integer' OR NEW.version < 1 OR typeof(NEW.expires_at) <> 'integer' OR NEW.expires_at < 0 OR typeof(NEW.heartbeat_at) <> 'integer' OR NEW.heartbeat_at < 0 OR typeof(NEW.created_at) <> 'integer' OR NEW.created_at < 0 OR typeof(NEW.updated_at) <> 'integer' OR NEW.updated_at < 0 BEGIN SELECT RAISE(ABORT, 'resource claim versions and timestamps must be integers'); END;
    CREATE TRIGGER review_requests_integer_fields_insert BEFORE INSERT ON review_requests WHEN typeof(NEW.version) <> 'integer' OR NEW.version < 1 OR typeof(NEW.created_at) <> 'integer' OR NEW.created_at < 0 OR typeof(NEW.updated_at) <> 'integer' OR NEW.updated_at < 0 BEGIN SELECT RAISE(ABORT, 'review request versions and timestamps must be integers'); END;
    CREATE TRIGGER review_requests_integer_fields_update BEFORE UPDATE ON review_requests WHEN typeof(NEW.version) <> 'integer' OR NEW.version < 1 OR typeof(NEW.created_at) <> 'integer' OR NEW.created_at < 0 OR typeof(NEW.updated_at) <> 'integer' OR NEW.updated_at < 0 BEGIN SELECT RAISE(ABORT, 'review request versions and timestamps must be integers'); END;
    CREATE TRIGGER review_findings_integer_fields_insert BEFORE INSERT ON review_findings WHEN typeof(NEW.version) <> 'integer' OR NEW.version < 1 OR typeof(NEW.created_at) <> 'integer' OR NEW.created_at < 0 OR typeof(NEW.updated_at) <> 'integer' OR NEW.updated_at < 0 BEGIN SELECT RAISE(ABORT, 'review finding versions and timestamps must be integers'); END;
    CREATE TRIGGER review_findings_integer_fields_update BEFORE UPDATE ON review_findings WHEN typeof(NEW.version) <> 'integer' OR NEW.version < 1 OR typeof(NEW.created_at) <> 'integer' OR NEW.created_at < 0 OR typeof(NEW.updated_at) <> 'integer' OR NEW.updated_at < 0 BEGIN SELECT RAISE(ABORT, 'review finding versions and timestamps must be integers'); END;
    CREATE TRIGGER domain_events_integer_fields_insert BEFORE INSERT ON domain_events WHEN typeof(NEW.event_version) <> 'integer' OR NEW.event_version < 1 OR typeof(NEW.occurred_at) <> 'integer' OR NEW.occurred_at < 0 BEGIN SELECT RAISE(ABORT, 'domain event versions and timestamps must be integers'); END;
    CREATE TRIGGER domain_events_integer_fields_update BEFORE UPDATE ON domain_events WHEN typeof(NEW.event_version) <> 'integer' OR NEW.event_version < 1 OR typeof(NEW.occurred_at) <> 'integer' OR NEW.occurred_at < 0 BEGIN SELECT RAISE(ABORT, 'domain event versions and timestamps must be integers'); END;
    CREATE TRIGGER outbox_integer_fields_insert BEFORE INSERT ON outbox WHEN typeof(NEW.version) <> 'integer' OR NEW.version < 1 OR typeof(NEW.attempt_count) <> 'integer' OR NEW.attempt_count < 0 OR typeof(NEW.next_attempt_at) <> 'integer' OR NEW.next_attempt_at < 0 OR typeof(NEW.created_at) <> 'integer' OR NEW.created_at < 0 OR typeof(NEW.updated_at) <> 'integer' OR NEW.updated_at < 0 OR (NEW.lease_until IS NOT NULL AND (typeof(NEW.lease_until) <> 'integer' OR NEW.lease_until < 0)) BEGIN SELECT RAISE(ABORT, 'outbox versions and timestamps must be integers'); END;
    CREATE TRIGGER outbox_integer_fields_update BEFORE UPDATE ON outbox WHEN typeof(NEW.version) <> 'integer' OR NEW.version < 1 OR typeof(NEW.attempt_count) <> 'integer' OR NEW.attempt_count < 0 OR typeof(NEW.next_attempt_at) <> 'integer' OR NEW.next_attempt_at < 0 OR typeof(NEW.created_at) <> 'integer' OR NEW.created_at < 0 OR typeof(NEW.updated_at) <> 'integer' OR NEW.updated_at < 0 OR (NEW.lease_until IS NOT NULL AND (typeof(NEW.lease_until) <> 'integer' OR NEW.lease_until < 0)) BEGIN SELECT RAISE(ABORT, 'outbox versions and timestamps must be integers'); END;
    CREATE TRIGGER command_receipts_integer_fields_insert BEFORE INSERT ON command_receipts WHEN typeof(NEW.version) <> 'integer' OR NEW.version < 1 OR typeof(NEW.created_at) <> 'integer' OR NEW.created_at < 0 OR typeof(NEW.updated_at) <> 'integer' OR NEW.updated_at < 0 BEGIN SELECT RAISE(ABORT, 'command receipt versions and timestamps must be integers'); END;
    CREATE TRIGGER command_receipts_integer_fields_update BEFORE UPDATE ON command_receipts WHEN typeof(NEW.version) <> 'integer' OR NEW.version < 1 OR typeof(NEW.created_at) <> 'integer' OR NEW.created_at < 0 OR typeof(NEW.updated_at) <> 'integer' OR NEW.updated_at < 0 BEGIN SELECT RAISE(ABORT, 'command receipt versions and timestamps must be integers'); END;

    CREATE TRIGGER agent_profiles_json_shape_insert BEFORE INSERT ON agent_profiles WHEN json_type(NEW.tool_set_json) <> 'array' BEGIN SELECT RAISE(ABORT, 'tool_set_json must be a JSON array'); END;
    CREATE TRIGGER agent_profiles_json_shape_update BEFORE UPDATE OF tool_set_json ON agent_profiles WHEN json_type(NEW.tool_set_json) <> 'array' BEGIN SELECT RAISE(ABORT, 'tool_set_json must be a JSON array'); END;
    CREATE TRIGGER decision_clusters_json_shape_insert BEFORE INSERT ON decision_clusters WHEN json_type(NEW.attention_json) <> 'object' BEGIN SELECT RAISE(ABORT, 'attention_json must be a JSON object'); END;
    CREATE TRIGGER decision_clusters_json_shape_update BEFORE UPDATE OF attention_json ON decision_clusters WHEN json_type(NEW.attention_json) <> 'object' BEGIN SELECT RAISE(ABORT, 'attention_json must be a JSON object'); END;
    CREATE TRIGGER decision_requests_json_shape_insert BEFORE INSERT ON decision_requests WHEN json_type(NEW.options_json) <> 'array' OR json_type(NEW.risk_json) <> 'object' OR json_type(NEW.scope_json) <> 'object' OR json_type(NEW.evidence_json) <> 'array' BEGIN SELECT RAISE(ABORT, 'decision request JSON shapes are invalid'); END;
    CREATE TRIGGER decision_requests_json_shape_update BEFORE UPDATE OF options_json, risk_json, scope_json, evidence_json ON decision_requests WHEN json_type(NEW.options_json) <> 'array' OR json_type(NEW.risk_json) <> 'object' OR json_type(NEW.scope_json) <> 'object' OR json_type(NEW.evidence_json) <> 'array' BEGIN SELECT RAISE(ABORT, 'decision request JSON shapes are invalid'); END;
    CREATE TRIGGER decisions_json_shape_insert BEFORE INSERT ON decisions WHEN json_type(NEW.scope_json) <> 'object' OR json_type(NEW.exceptions_json) <> 'array' BEGIN SELECT RAISE(ABORT, 'decision JSON shapes are invalid'); END;
    CREATE TRIGGER decisions_json_shape_update BEFORE UPDATE OF scope_json, exceptions_json ON decisions WHEN json_type(NEW.scope_json) <> 'object' OR json_type(NEW.exceptions_json) <> 'array' BEGIN SELECT RAISE(ABORT, 'decision JSON shapes are invalid'); END;
    CREATE TRIGGER assumptions_json_shape_insert BEFORE INSERT ON assumptions WHEN json_type(NEW.scope_json) <> 'object' OR json_type(NEW.evidence_json) <> 'array' BEGIN SELECT RAISE(ABORT, 'assumption JSON shapes are invalid'); END;
    CREATE TRIGGER assumptions_json_shape_update BEFORE UPDATE OF scope_json, evidence_json ON assumptions WHEN json_type(NEW.scope_json) <> 'object' OR json_type(NEW.evidence_json) <> 'array' BEGIN SELECT RAISE(ABORT, 'assumption JSON shapes are invalid'); END;
    CREATE TRIGGER agent_messages_json_shape_insert BEFORE INSERT ON agent_messages WHEN json_type(NEW.scope_json) <> 'object' OR json_type(NEW.payload_json) <> 'object' OR json_type(NEW.references_json) <> 'array' BEGIN SELECT RAISE(ABORT, 'agent message JSON shapes are invalid'); END;
    CREATE TRIGGER agent_messages_json_shape_update BEFORE UPDATE OF scope_json, payload_json, references_json ON agent_messages WHEN json_type(NEW.scope_json) <> 'object' OR json_type(NEW.payload_json) <> 'object' OR json_type(NEW.references_json) <> 'array' BEGIN SELECT RAISE(ABORT, 'agent message JSON shapes are invalid'); END;
    CREATE TRIGGER investigations_json_shape_insert BEFORE INSERT ON investigations WHEN json_type(NEW.scope_json) <> 'object' BEGIN SELECT RAISE(ABORT, 'investigation scope_json must be a JSON object'); END;
    CREATE TRIGGER investigations_json_shape_update BEFORE UPDATE OF scope_json ON investigations WHEN json_type(NEW.scope_json) <> 'object' BEGIN SELECT RAISE(ABORT, 'investigation scope_json must be a JSON object'); END;
    CREATE TRIGGER findings_json_shape_insert BEFORE INSERT ON findings WHEN json_type(NEW.references_json) <> 'array' BEGIN SELECT RAISE(ABORT, 'finding references_json must be a JSON array'); END;
    CREATE TRIGGER findings_json_shape_update BEFORE UPDATE OF references_json ON findings WHEN json_type(NEW.references_json) <> 'array' BEGIN SELECT RAISE(ABORT, 'finding references_json must be a JSON array'); END;
    CREATE TRIGGER review_requests_json_shape_insert BEFORE INSERT ON review_requests WHEN json_type(NEW.scope_json) <> 'object' OR json_type(NEW.policy_json) <> 'object' BEGIN SELECT RAISE(ABORT, 'review request JSON shapes are invalid'); END;
    CREATE TRIGGER review_requests_json_shape_update BEFORE UPDATE OF scope_json, policy_json ON review_requests WHEN json_type(NEW.scope_json) <> 'object' OR json_type(NEW.policy_json) <> 'object' BEGIN SELECT RAISE(ABORT, 'review request JSON shapes are invalid'); END;

    CREATE TABLE outbox_new (
      id TEXT PRIMARY KEY,
      message_type TEXT NOT NULL,
      aggregate_type TEXT NOT NULL,
      aggregate_id TEXT NOT NULL,
      correlation_id TEXT NOT NULL,
      payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
      idempotency_key TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL CHECK (status IN ('pending','processing','delivered','failed','dead-letter','outcome-unknown')),
      delivery_kind TEXT NOT NULL DEFAULT 'retryable' CHECK (delivery_kind IN ('retryable','reconcile-before-retry','non-retryable')),
      reconciliation_key TEXT CHECK (reconciliation_key IS NULL OR length(trim(reconciliation_key)) > 0),
      attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (typeof(attempt_count) = 'integer' AND attempt_count >= 0),
      next_attempt_at INTEGER NOT NULL,
      lease_until INTEGER,
      lease_token TEXT,
      last_error TEXT,
      version INTEGER NOT NULL DEFAULT 1 CHECK (typeof(version) = 'integer' AND version >= 1),
      created_at INTEGER NOT NULL CHECK (typeof(created_at) = 'integer' AND created_at >= 0),
      updated_at INTEGER NOT NULL CHECK (typeof(updated_at) = 'integer' AND updated_at >= created_at),
      CHECK (
        (message_type = 'realtime.invalidate' AND delivery_kind = 'retryable' AND reconciliation_key IS NULL) OR
        (message_type IN ('tasks.comment','thread.send') AND delivery_kind = 'reconcile-before-retry' AND reconciliation_key IS NOT NULL) OR
        (message_type NOT IN ('realtime.invalidate','tasks.comment','thread.send') AND delivery_kind = 'non-retryable' AND reconciliation_key IS NULL)
      ),
      CHECK (status <> 'outcome-unknown' OR (delivery_kind = 'reconcile-before-retry' AND reconciliation_key IS NOT NULL)),
      CHECK ((status = 'processing' AND lease_until IS NOT NULL AND lease_token IS NOT NULL) OR (status <> 'processing' AND lease_until IS NULL AND lease_token IS NULL))
    );
    INSERT INTO outbox_new (id, message_type, aggregate_type, aggregate_id, correlation_id, payload_json, idempotency_key, status, delivery_kind, reconciliation_key, attempt_count, next_attempt_at, lease_until, lease_token, last_error, version, created_at, updated_at)
      SELECT id, message_type, aggregate_type, aggregate_id, correlation_id,
        CASE
          WHEN message_type IN ('realtime.invalidate', 'tasks.comment', 'thread.send') AND json_type(payload_json) = 'object' AND json_type(payload_json, '$.version') IS NULL THEN json_set(payload_json, '$.version', 1)
          WHEN json_type(payload_json) = 'object' THEN payload_json
          ELSE json_object('version', 1, 'legacyPayload', json(payload_json))
        END,
        idempotency_key,
        CASE
          WHEN message_type = 'realtime.invalidate' AND status IN ('failed', 'processing') THEN 'pending'
          WHEN message_type IN ('tasks.comment', 'thread.send') AND status IN ('failed', 'processing') THEN 'outcome-unknown'
          WHEN message_type NOT IN ('realtime.invalidate', 'tasks.comment', 'thread.send') AND status IN ('pending', 'failed', 'processing') THEN 'dead-letter'
          ELSE status
        END,
        CASE WHEN message_type = 'realtime.invalidate' THEN 'retryable' WHEN message_type IN ('tasks.comment', 'thread.send') THEN 'reconcile-before-retry' ELSE 'non-retryable' END,
        CASE WHEN message_type IN ('tasks.comment', 'thread.send') THEN idempotency_key ELSE NULL END,
        MAX(0, CAST(attempt_count AS INTEGER)), MAX(0, CAST(next_attempt_at AS INTEGER)),
        NULL,
        NULL, last_error,
        MAX(1, CAST(version AS INTEGER)), MAX(0, CAST(created_at AS INTEGER)), MAX(0, CAST(updated_at AS INTEGER)) FROM outbox;
    DROP INDEX outbox_delivery;
    DROP TABLE outbox;
    ALTER TABLE outbox_new RENAME TO outbox;
    CREATE INDEX outbox_delivery ON outbox(status, next_attempt_at, lease_until, id);
    CREATE INDEX outbox_reconciliation ON outbox(reconciliation_key, status) WHERE reconciliation_key IS NOT NULL;
    CREATE TABLE outbox_reconciliation_evidence (
      id TEXT PRIMARY KEY,
      outbox_id TEXT NOT NULL,
      reconciliation_key TEXT NOT NULL CHECK (length(trim(reconciliation_key)) > 0),
      outcome TEXT NOT NULL CHECK (outcome IN ('remote-applied','remote-not-applied','operator-requeue')),
      evidence TEXT NOT NULL CHECK (length(trim(evidence)) > 0),
      created_at INTEGER NOT NULL CHECK (typeof(created_at) = 'integer' AND created_at >= 0),
      FOREIGN KEY (outbox_id) REFERENCES outbox(id) ON DELETE RESTRICT
    );
    CREATE INDEX outbox_reconciliation_evidence_lookup ON outbox_reconciliation_evidence(outbox_id, created_at, id);
    CREATE TRIGGER outbox_reconciliation_evidence_immutable BEFORE UPDATE ON outbox_reconciliation_evidence
    BEGIN SELECT RAISE(ABORT, 'outbox reconciliation evidence is append-only'); END;
    CREATE TRIGGER outbox_reconciliation_evidence_no_delete BEFORE DELETE ON outbox_reconciliation_evidence
    BEGIN SELECT RAISE(ABORT, 'outbox reconciliation evidence deletion is forbidden'); END;
    CREATE INDEX resource_claims_conflict_lookup ON resource_claims(project_id, resource_type, selector, status, intent);
    CREATE TRIGGER outbox_integer_fields_insert BEFORE INSERT ON outbox WHEN typeof(NEW.version) <> 'integer' OR NEW.version < 1 OR typeof(NEW.attempt_count) <> 'integer' OR NEW.attempt_count < 0 OR typeof(NEW.next_attempt_at) <> 'integer' OR NEW.next_attempt_at < 0 OR typeof(NEW.created_at) <> 'integer' OR NEW.created_at < 0 OR typeof(NEW.updated_at) <> 'integer' OR NEW.updated_at < 0 OR (NEW.lease_until IS NOT NULL AND (typeof(NEW.lease_until) <> 'integer' OR NEW.lease_until < 0)) BEGIN SELECT RAISE(ABORT, 'outbox versions and timestamps must be integers'); END;
    CREATE TRIGGER outbox_integer_fields_update BEFORE UPDATE ON outbox WHEN typeof(NEW.version) <> 'integer' OR NEW.version < 1 OR typeof(NEW.attempt_count) <> 'integer' OR NEW.attempt_count < 0 OR typeof(NEW.next_attempt_at) <> 'integer' OR NEW.next_attempt_at < 0 OR typeof(NEW.created_at) <> 'integer' OR NEW.created_at < 0 OR typeof(NEW.updated_at) <> 'integer' OR NEW.updated_at < 0 OR (NEW.lease_until IS NOT NULL AND (typeof(NEW.lease_until) <> 'integer' OR NEW.lease_until < 0)) BEGIN SELECT RAISE(ABORT, 'outbox versions and timestamps must be integers'); END;
    CREATE TRIGGER outbox_reconciliation_key_immutable BEFORE UPDATE OF reconciliation_key ON outbox
    WHEN OLD.reconciliation_key IS NOT NEW.reconciliation_key
    BEGIN SELECT RAISE(ABORT, 'outbox reconciliation_key is immutable'); END;
    CREATE TRIGGER outbox_identity_replace_guard BEFORE INSERT ON outbox
    WHEN EXISTS (SELECT 1 FROM outbox AS old WHERE old.id = NEW.id OR old.idempotency_key = NEW.idempotency_key)
    BEGIN SELECT RAISE(ABORT, 'outbox identity replacement is forbidden'); END;
    CREATE TRIGGER outbox_payload_json_shape_insert BEFORE INSERT ON outbox WHEN json_type(NEW.payload_json) <> 'object' BEGIN SELECT RAISE(ABORT, 'outbox payload_json must be a JSON object'); END;
    CREATE TRIGGER outbox_payload_json_shape_update BEFORE UPDATE OF payload_json ON outbox WHEN json_type(NEW.payload_json) <> 'object' BEGIN SELECT RAISE(ABORT, 'outbox payload_json must be a JSON object'); END;
    CREATE TRIGGER command_receipts_state_insert BEFORE INSERT ON command_receipts
    WHEN (NEW.status = 'completed' AND (NEW.response_json IS NULL OR NEW.error_json IS NOT NULL)) OR (NEW.status = 'failed' AND (NEW.error_json IS NULL OR NEW.response_json IS NOT NULL)) OR (NEW.status = 'processing' AND (NEW.response_json IS NOT NULL OR NEW.error_json IS NOT NULL))
    BEGIN SELECT RAISE(ABORT, 'command receipt response/error does not match status'); END;
    CREATE TRIGGER command_receipts_state_update BEFORE UPDATE OF status, response_json, error_json ON command_receipts
    WHEN (NEW.status = 'completed' AND (NEW.response_json IS NULL OR NEW.error_json IS NOT NULL)) OR (NEW.status = 'failed' AND (NEW.error_json IS NULL OR NEW.response_json IS NOT NULL)) OR (NEW.status = 'processing' AND (NEW.response_json IS NOT NULL OR NEW.error_json IS NOT NULL))
    BEGIN SELECT RAISE(ABORT, 'command receipt response/error does not match status'); END;
    CREATE TRIGGER command_receipts_identity_immutable BEFORE UPDATE OF idempotency_key, command_type, project_id, request_hash ON command_receipts
    WHEN OLD.idempotency_key IS NOT NEW.idempotency_key OR OLD.command_type IS NOT NEW.command_type OR OLD.project_id IS NOT NEW.project_id OR OLD.request_hash IS NOT NEW.request_hash
    BEGIN SELECT RAISE(ABORT, 'command receipt identity is immutable'); END;
    CREATE TRIGGER command_receipts_terminal_immutable BEFORE UPDATE ON command_receipts
    WHEN OLD.status IN ('completed','failed')
    BEGIN SELECT RAISE(ABORT, 'terminal command receipt is immutable'); END;
    CREATE TRIGGER command_receipts_terminal_delete_guard BEFORE DELETE ON command_receipts
    WHEN OLD.status IN ('completed','failed')
    BEGIN SELECT RAISE(ABORT, 'terminal command receipt deletion is forbidden'); END;
    CREATE TRIGGER command_receipts_terminal_replace_guard BEFORE INSERT ON command_receipts
    WHEN EXISTS (SELECT 1 FROM command_receipts WHERE idempotency_key = NEW.idempotency_key)
    BEGIN SELECT RAISE(ABORT, 'command receipt replacement is forbidden'); END;
    CREATE TRIGGER managed_agents_target_replace_guard BEFORE INSERT ON managed_agents
    WHEN EXISTS (SELECT 1 FROM managed_agents AS old WHERE old.id = NEW.id AND old.project_id = NEW.project_id AND EXISTS (SELECT 1 FROM agent_message_targets WHERE target_type = 'agent' AND project_id = old.project_id AND target_id = old.id))
    BEGIN SELECT RAISE(ABORT, 'managed agent identity replacement is forbidden while referenced'); END;
    CREATE TRIGGER command_receipts_transition_guard BEFORE UPDATE OF status ON command_receipts
    WHEN OLD.status = 'processing' AND NEW.status NOT IN ('completed','failed')
    BEGIN SELECT RAISE(ABORT, 'command receipt transition must be processing to completed or failed'); END;

    CREATE TRIGGER decision_requests_scope_legacy_fallback_insert AFTER INSERT ON decision_requests
    WHEN json(NEW.scope_json) <> '{}'
    BEGIN INSERT OR IGNORE INTO decision_request_scope_refs (project_id, request_id, scope_type, external_ref, created_at) VALUES (NEW.project_id, NEW.id, 'legacy-json', NEW.scope_json, NEW.created_at); END;
    CREATE TRIGGER decision_requests_scope_legacy_fallback_update AFTER UPDATE OF scope_json ON decision_requests
    BEGIN
      DELETE FROM decision_request_scope_refs WHERE project_id = OLD.project_id AND request_id = OLD.id AND scope_type = 'legacy-json';
      INSERT INTO decision_request_scope_refs (project_id, request_id, scope_type, external_ref, created_at) SELECT NEW.project_id, NEW.id, 'legacy-json', NEW.scope_json, NEW.created_at WHERE json(NEW.scope_json) <> '{}';
    END;
    CREATE TRIGGER decisions_scope_legacy_fallback_insert AFTER INSERT ON decisions
    WHEN json(NEW.scope_json) <> '{}'
    BEGIN INSERT INTO decision_scope_refs (project_id, decision_id, scope_type, external_ref, created_at) VALUES (NEW.project_id, NEW.id, 'legacy-json', NEW.scope_json, NEW.created_at); END;
    CREATE TRIGGER decisions_scope_legacy_fallback_update AFTER UPDATE OF scope_json ON decisions
    BEGIN
      DELETE FROM decision_scope_refs WHERE project_id = OLD.project_id AND decision_id = OLD.id AND scope_type = 'legacy-json';
      INSERT INTO decision_scope_refs (project_id, decision_id, scope_type, external_ref, created_at) SELECT NEW.project_id, NEW.id, 'legacy-json', NEW.scope_json, NEW.created_at WHERE json(NEW.scope_json) <> '{}';
    END;
    CREATE TRIGGER assumptions_scope_legacy_fallback_insert AFTER INSERT ON assumptions
    WHEN json(NEW.scope_json) <> '{}'
    BEGIN INSERT INTO assumption_scope_refs (project_id, assumption_id, scope_type, external_ref, created_at) VALUES (NEW.project_id, NEW.id, 'legacy-json', NEW.scope_json, NEW.created_at); END;
    CREATE TRIGGER assumptions_scope_legacy_fallback_update AFTER UPDATE OF scope_json ON assumptions
    BEGIN
      DELETE FROM assumption_scope_refs WHERE project_id = OLD.project_id AND assumption_id = OLD.id AND scope_type = 'legacy-json';
      INSERT INTO assumption_scope_refs (project_id, assumption_id, scope_type, external_ref, created_at) SELECT NEW.project_id, NEW.id, 'legacy-json', NEW.scope_json, NEW.created_at WHERE json(NEW.scope_json) <> '{}';
    END;
    CREATE TRIGGER agent_messages_scope_legacy_fallback_insert AFTER INSERT ON agent_messages
    WHEN json(NEW.scope_json) <> '{}'
    BEGIN INSERT INTO agent_message_scope_refs (project_id, message_id, scope_type, external_ref, created_at) VALUES (NEW.project_id, NEW.id, 'legacy-json', NEW.scope_json, NEW.created_at); END;
    CREATE TRIGGER agent_messages_scope_legacy_fallback_update AFTER UPDATE OF scope_json ON agent_messages
    BEGIN
      DELETE FROM agent_message_scope_refs WHERE project_id = OLD.project_id AND message_id = OLD.id AND scope_type = 'legacy-json';
      INSERT INTO agent_message_scope_refs (project_id, message_id, scope_type, external_ref, created_at) SELECT NEW.project_id, NEW.id, 'legacy-json', NEW.scope_json, NEW.created_at WHERE json(NEW.scope_json) <> '{}';
    END;
    CREATE TRIGGER investigations_scope_legacy_fallback_insert AFTER INSERT ON investigations
    WHEN json(NEW.scope_json) <> '{}'
    BEGIN INSERT INTO investigation_scope_refs (project_id, investigation_id, scope_type, external_ref, created_at) VALUES (NEW.project_id, NEW.id, 'legacy-json', NEW.scope_json, NEW.created_at); END;
    CREATE TRIGGER investigations_scope_legacy_fallback_update AFTER UPDATE OF scope_json ON investigations
    BEGIN
      DELETE FROM investigation_scope_refs WHERE project_id = OLD.project_id AND investigation_id = OLD.id AND scope_type = 'legacy-json';
      INSERT INTO investigation_scope_refs (project_id, investigation_id, scope_type, external_ref, created_at) SELECT NEW.project_id, NEW.id, 'legacy-json', NEW.scope_json, NEW.created_at WHERE json(NEW.scope_json) <> '{}';
    END;
    CREATE TRIGGER review_requests_scope_legacy_fallback_insert AFTER INSERT ON review_requests
    WHEN json(NEW.scope_json) <> '{}'
    BEGIN INSERT INTO review_request_scope_refs (project_id, review_request_id, scope_type, external_ref, created_at) VALUES (NEW.project_id, NEW.id, 'legacy-json', NEW.scope_json, NEW.created_at); END;
    CREATE TRIGGER review_requests_scope_legacy_fallback_update AFTER UPDATE OF scope_json ON review_requests
    BEGIN
      DELETE FROM review_request_scope_refs WHERE project_id = OLD.project_id AND review_request_id = OLD.id AND scope_type = 'legacy-json';
      INSERT INTO review_request_scope_refs (project_id, review_request_id, scope_type, external_ref, created_at) SELECT NEW.project_id, NEW.id, 'legacy-json', NEW.scope_json, NEW.created_at WHERE json(NEW.scope_json) <> '{}';
    END;
    CREATE TRIGGER processed_events_integer_fields_insert BEFORE INSERT ON processed_events
    WHEN typeof(NEW.processed_at) <> 'integer' OR NEW.processed_at < 0
    BEGIN SELECT RAISE(ABORT, 'processed event timestamps must be nonnegative integers'); END;
    CREATE TRIGGER processed_events_integer_fields_update BEFORE UPDATE OF processed_at ON processed_events
    WHEN typeof(NEW.processed_at) <> 'integer' OR NEW.processed_at < 0
    BEGIN SELECT RAISE(ABORT, 'processed event timestamps must be nonnegative integers'); END;
    CREATE TRIGGER decision_cluster_requests_integer_fields_insert BEFORE INSERT ON decision_cluster_requests
    WHEN typeof(NEW.created_at) <> 'integer' OR NEW.created_at < 0
    BEGIN SELECT RAISE(ABORT, 'decision cluster request timestamps must be nonnegative integers'); END;
    CREATE TRIGGER decision_cluster_requests_integer_fields_update BEFORE UPDATE OF created_at ON decision_cluster_requests
    WHEN typeof(NEW.created_at) <> 'integer' OR NEW.created_at < 0
    BEGIN SELECT RAISE(ABORT, 'decision cluster request timestamps must be nonnegative integers'); END;
    CREATE TRIGGER investigation_results_integer_fields_insert BEFORE INSERT ON investigation_results
    WHEN typeof(NEW.created_at) <> 'integer' OR NEW.created_at < 0
    BEGIN SELECT RAISE(ABORT, 'investigation result timestamps must be nonnegative integers'); END;
    CREATE TRIGGER investigation_results_integer_fields_update BEFORE UPDATE OF created_at ON investigation_results
    WHEN typeof(NEW.created_at) <> 'integer' OR NEW.created_at < 0
    BEGIN SELECT RAISE(ABORT, 'investigation result timestamps must be nonnegative integers'); END;
    CREATE TRIGGER decision_resolutions_integer_fields_insert BEFORE INSERT ON decision_resolutions
    WHEN typeof(NEW.resolved_at) <> 'integer' OR NEW.resolved_at < 0
    BEGIN SELECT RAISE(ABORT, 'decision resolution timestamps must be nonnegative integers'); END;
    CREATE TRIGGER decision_resolutions_integer_fields_update BEFORE UPDATE OF resolved_at ON decision_resolutions
    WHEN typeof(NEW.resolved_at) <> 'integer' OR NEW.resolved_at < 0
    BEGIN SELECT RAISE(ABORT, 'decision resolution timestamps must be nonnegative integers'); END;
    CREATE TRIGGER investigation_subscribers_integer_fields_insert BEFORE INSERT ON investigation_subscribers
    WHEN typeof(NEW.created_at) <> 'integer' OR NEW.created_at < 0
    BEGIN SELECT RAISE(ABORT, 'investigation subscriber timestamps must be nonnegative integers'); END;
    CREATE TRIGGER investigation_subscribers_integer_fields_update BEFORE UPDATE OF created_at ON investigation_subscribers
    WHEN typeof(NEW.created_at) <> 'integer' OR NEW.created_at < 0
    BEGIN SELECT RAISE(ABORT, 'investigation subscriber timestamps must be nonnegative integers'); END;
    CREATE TRIGGER agent_message_targets_agent_guard BEFORE INSERT ON agent_message_targets
    WHEN NEW.target_type = 'agent' AND NOT EXISTS (SELECT 1 FROM managed_agents WHERE project_id = NEW.project_id AND id = NEW.target_id)
    BEGIN SELECT RAISE(ABORT, 'agent message target agent must belong to its project'); END;
    CREATE TRIGGER agent_message_targets_agent_update_guard BEFORE UPDATE OF project_id, target_type, target_id ON agent_message_targets
    WHEN NEW.target_type = 'agent' AND NOT EXISTS (SELECT 1 FROM managed_agents WHERE project_id = NEW.project_id AND id = NEW.target_id)
    BEGIN SELECT RAISE(ABORT, 'agent message target agent must belong to its project'); END;
    CREATE TRIGGER agent_message_targets_integer_fields_insert BEFORE INSERT ON agent_message_targets
    WHEN typeof(NEW.created_at) <> 'integer' OR NEW.created_at < 0 OR (NEW.delivered_at IS NOT NULL AND (typeof(NEW.delivered_at) <> 'integer' OR NEW.delivered_at < 0)) OR (NEW.acknowledged_at IS NOT NULL AND (typeof(NEW.acknowledged_at) <> 'integer' OR NEW.acknowledged_at < 0))
    BEGIN SELECT RAISE(ABORT, 'agent message target timestamps must be nonnegative integers'); END;
    CREATE TRIGGER agent_message_targets_integer_fields_update BEFORE UPDATE OF created_at, delivered_at, acknowledged_at ON agent_message_targets
    WHEN typeof(NEW.created_at) <> 'integer' OR NEW.created_at < 0 OR (NEW.delivered_at IS NOT NULL AND (typeof(NEW.delivered_at) <> 'integer' OR NEW.delivered_at < 0)) OR (NEW.acknowledged_at IS NOT NULL AND (typeof(NEW.acknowledged_at) <> 'integer' OR NEW.acknowledged_at < 0))
    BEGIN SELECT RAISE(ABORT, 'agent message target timestamps must be nonnegative integers'); END;
    CREATE TRIGGER agent_message_recipients_mirror_insert AFTER INSERT ON agent_message_recipients
    BEGIN
      INSERT INTO agent_message_targets (project_id, message_id, target_type, target_id, delivery_status, ack_status, delivered_at, acknowledged_at, created_at)
      SELECT NEW.project_id, NEW.message_id, 'agent', NEW.recipient_agent_id, NEW.delivery_status, NEW.ack_status, NEW.delivered_at, NEW.acknowledged_at, COALESCE((SELECT created_at FROM agent_messages WHERE project_id = NEW.project_id AND id = NEW.message_id), 0)
      ON CONFLICT (project_id, message_id, target_type, target_id) DO UPDATE SET delivery_status = excluded.delivery_status, ack_status = excluded.ack_status, delivered_at = excluded.delivered_at, acknowledged_at = excluded.acknowledged_at;
    END;
    CREATE TRIGGER agent_message_recipients_mirror_update AFTER UPDATE ON agent_message_recipients
    BEGIN
      DELETE FROM agent_message_targets WHERE project_id = OLD.project_id AND message_id = OLD.message_id AND target_type = 'agent' AND target_id = OLD.recipient_agent_id;
      INSERT INTO agent_message_targets (project_id, message_id, target_type, target_id, delivery_status, ack_status, delivered_at, acknowledged_at, created_at)
      SELECT NEW.project_id, NEW.message_id, 'agent', NEW.recipient_agent_id, NEW.delivery_status, NEW.ack_status, NEW.delivered_at, NEW.acknowledged_at, COALESCE((SELECT created_at FROM agent_messages WHERE project_id = NEW.project_id AND id = NEW.message_id), 0)
      ON CONFLICT (project_id, message_id, target_type, target_id) DO UPDATE SET delivery_status = excluded.delivery_status, ack_status = excluded.ack_status, delivered_at = excluded.delivered_at, acknowledged_at = excluded.acknowledged_at;
    END;
    CREATE TRIGGER agent_message_recipients_mirror_delete AFTER DELETE ON agent_message_recipients
    BEGIN DELETE FROM agent_message_targets WHERE project_id = OLD.project_id AND message_id = OLD.message_id AND target_type = 'agent' AND target_id = OLD.recipient_agent_id; END;
    CREATE TRIGGER agent_message_recipients_integer_fields_insert BEFORE INSERT ON agent_message_recipients
    WHEN (NEW.delivered_at IS NOT NULL AND (typeof(NEW.delivered_at) <> 'integer' OR NEW.delivered_at < 0)) OR (NEW.acknowledged_at IS NOT NULL AND (typeof(NEW.acknowledged_at) <> 'integer' OR NEW.acknowledged_at < 0))
    BEGIN SELECT RAISE(ABORT, 'legacy recipient timestamps must be nonnegative integers'); END;
    CREATE TRIGGER agent_message_recipients_integer_fields_update BEFORE UPDATE OF delivered_at, acknowledged_at ON agent_message_recipients
    WHEN (NEW.delivered_at IS NOT NULL AND (typeof(NEW.delivered_at) <> 'integer' OR NEW.delivered_at < 0)) OR (NEW.acknowledged_at IS NOT NULL AND (typeof(NEW.acknowledged_at) <> 'integer' OR NEW.acknowledged_at < 0))
    BEGIN SELECT RAISE(ABORT, 'legacy recipient timestamps must be nonnegative integers'); END;
    CREATE TRIGGER decision_request_scope_refs_integer_fields_insert BEFORE INSERT ON decision_request_scope_refs WHEN typeof(NEW.created_at) <> 'integer' OR NEW.created_at < 0 BEGIN SELECT RAISE(ABORT, 'scope reference timestamps must be nonnegative integers'); END;
    CREATE TRIGGER decision_request_scope_refs_integer_fields_update BEFORE UPDATE OF created_at ON decision_request_scope_refs WHEN typeof(NEW.created_at) <> 'integer' OR NEW.created_at < 0 BEGIN SELECT RAISE(ABORT, 'scope reference timestamps must be nonnegative integers'); END;
    CREATE TRIGGER decision_scope_refs_integer_fields_insert BEFORE INSERT ON decision_scope_refs WHEN typeof(NEW.created_at) <> 'integer' OR NEW.created_at < 0 BEGIN SELECT RAISE(ABORT, 'scope reference timestamps must be nonnegative integers'); END;
    CREATE TRIGGER decision_scope_refs_integer_fields_update BEFORE UPDATE OF created_at ON decision_scope_refs WHEN typeof(NEW.created_at) <> 'integer' OR NEW.created_at < 0 BEGIN SELECT RAISE(ABORT, 'scope reference timestamps must be nonnegative integers'); END;
    CREATE TRIGGER assumption_scope_refs_integer_fields_insert BEFORE INSERT ON assumption_scope_refs WHEN typeof(NEW.created_at) <> 'integer' OR NEW.created_at < 0 BEGIN SELECT RAISE(ABORT, 'scope reference timestamps must be nonnegative integers'); END;
    CREATE TRIGGER assumption_scope_refs_integer_fields_update BEFORE UPDATE OF created_at ON assumption_scope_refs WHEN typeof(NEW.created_at) <> 'integer' OR NEW.created_at < 0 BEGIN SELECT RAISE(ABORT, 'scope reference timestamps must be nonnegative integers'); END;
    CREATE TRIGGER agent_message_scope_refs_integer_fields_insert BEFORE INSERT ON agent_message_scope_refs WHEN typeof(NEW.created_at) <> 'integer' OR NEW.created_at < 0 BEGIN SELECT RAISE(ABORT, 'scope reference timestamps must be nonnegative integers'); END;
    CREATE TRIGGER agent_message_scope_refs_integer_fields_update BEFORE UPDATE OF created_at ON agent_message_scope_refs WHEN typeof(NEW.created_at) <> 'integer' OR NEW.created_at < 0 BEGIN SELECT RAISE(ABORT, 'scope reference timestamps must be nonnegative integers'); END;
    CREATE TRIGGER investigation_scope_refs_integer_fields_insert BEFORE INSERT ON investigation_scope_refs WHEN typeof(NEW.created_at) <> 'integer' OR NEW.created_at < 0 BEGIN SELECT RAISE(ABORT, 'scope reference timestamps must be nonnegative integers'); END;
    CREATE TRIGGER investigation_scope_refs_integer_fields_update BEFORE UPDATE OF created_at ON investigation_scope_refs WHEN typeof(NEW.created_at) <> 'integer' OR NEW.created_at < 0 BEGIN SELECT RAISE(ABORT, 'scope reference timestamps must be nonnegative integers'); END;
    CREATE TRIGGER review_request_scope_refs_integer_fields_insert BEFORE INSERT ON review_request_scope_refs WHEN typeof(NEW.created_at) <> 'integer' OR NEW.created_at < 0 BEGIN SELECT RAISE(ABORT, 'scope reference timestamps must be nonnegative integers'); END;
    CREATE TRIGGER review_request_scope_refs_integer_fields_update BEFORE UPDATE OF created_at ON review_request_scope_refs WHEN typeof(NEW.created_at) <> 'integer' OR NEW.created_at < 0 BEGIN SELECT RAISE(ABORT, 'scope reference timestamps must be nonnegative integers'); END;
  `,
] as const;

const migrationLedgerRowSchema = z.object({
  migration_id: z.number().int().nonnegative(),
  sha256: z.string().length(64),
});

/** Verify an existing ledger before the host can apply any pending migration. */
export function verifyStoredMigrationHashes(
  db: PluginDatabase,
  requireLedger = false,
): void {
  const table = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'control_plane_migration_hashes'",
    )
    .get();
  if (table === undefined) {
    const migrationsTable = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = '_bb_migrations'",
      )
      .get();
    if (migrationsTable !== undefined) {
      const appliedMigration = db
        .prepare("SELECT 1 AS present FROM _bb_migrations WHERE id = 5 LIMIT 1")
        .get();
      if (appliedMigration !== undefined) {
        throw new Error(
          "Control Plane migration hash ledger is missing although migration 5 is recorded",
        );
      }
    }
    if (requireLedger) {
      throw new Error("Control Plane migration hash ledger is missing");
    }
    return;
  }
  const parsed = z
    .array(migrationLedgerRowSchema)
    .safeParse(
      db
        .prepare(
          "SELECT migration_id, sha256 FROM control_plane_migration_hashes ORDER BY migration_id",
        )
        .all(),
    );
  if (!parsed.success) {
    throw new Error(
      `Control Plane migration hash ledger has invalid rows: ${parsed.error.message}`,
    );
  }
  const storedHashes = parsed.data;
  if (
    storedHashes.length !== CONTROL_PLANE_PUBLISHED_MIGRATION_HASHES.length ||
    storedHashes.some(
      (entry, index) =>
        entry.migration_id !== index ||
        entry.sha256 !== CONTROL_PLANE_PUBLISHED_MIGRATION_HASHES[index],
    )
  ) {
    throw new Error("Control Plane migration hash ledger mismatch");
  }
}

export function initializeControlPlaneDatabase(
  db: PluginDatabase,
  migrate: Migrate,
): void {
  // Hash and ledger checks must happen before PRAGMA mutation: a tampered or
  // partially recorded database must remain untouched by initialization.
  verifyPublishedMigrationHashes(controlPlaneMigrations);
  if (controlPlaneMigrations.length !== CONTROL_PLANE_SCHEMA_VERSION) {
    throw new Error("Control Plane schema manifest and migrations disagree");
  }
  verifyStoredMigrationHashes(db);
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  db.pragma("foreign_keys = ON");
  db.pragma("recursive_triggers = ON");
  migrate(db, [...controlPlaneMigrations]);
  verifyStoredMigrationHashes(db, true);
  const fk = db.pragma("foreign_keys", { simple: true });
  if (fk !== 1)
    throw new Error("Control Plane requires SQLite foreign_keys=ON");
  const recursiveTriggers = db.pragma("recursive_triggers", { simple: true });
  if (recursiveTriggers !== 1)
    throw new Error("Control Plane requires SQLite recursive_triggers=ON");
}

/** Backward-compatible name used by early local CP-102 experiments. */
export const migrateControlPlaneDatabase = initializeControlPlaneDatabase;
