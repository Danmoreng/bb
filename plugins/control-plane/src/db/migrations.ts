import type { BbPluginApi } from "@bb/plugin-sdk";
import { CONTROL_PLANE_SCHEMA_VERSION } from "./schema.js";

type PluginDatabase = ReturnType<BbPluginApi["storage"]["database"]>;
type Migrate = BbPluginApi["storage"]["migrate"];

const JSON_VALUE = "CHECK (json_valid(payload_json))";
const TIMES = "CHECK (updated_at >= created_at)";
const VERSION = "CHECK (version >= 1)";

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
] as const;

export function initializeControlPlaneDatabase(
  db: PluginDatabase,
  migrate: Migrate,
): void {
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  db.pragma("foreign_keys = ON");
  migrate(db, [...controlPlaneMigrations]);
  const fk = db.pragma("foreign_keys", { simple: true });
  if (fk !== 1)
    throw new Error("Control Plane requires SQLite foreign_keys=ON");
  if (controlPlaneMigrations.length !== CONTROL_PLANE_SCHEMA_VERSION) {
    throw new Error("Control Plane schema manifest and migrations disagree");
  }
}

/** Backward-compatible name used by early local CP-102 experiments. */
export const migrateControlPlaneDatabase = initializeControlPlaneDatabase;
