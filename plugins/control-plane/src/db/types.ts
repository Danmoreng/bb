export type ControlProjectStatus =
  | "draft"
  | "initializing"
  | "active"
  | "degraded"
  | "archived";

export type AgentRoleKind = "steward" | "worker" | "investigator" | "reviewer";
export type ClaimIntent = "shared-read" | "exclusive";
export type ClaimStatus = "active" | "released" | "expired";
export type OutboxStatus =
  | "pending"
  | "processing"
  | "delivered"
  | "failed"
  | "dead-letter";

export interface ControlProjectRow {
  id: string;
  bb_project_id: string;
  tasks_project_id: string | null;
  status: ControlProjectStatus;
  version: number;
  created_at: number;
  updated_at: number;
}

export interface OutboxRow {
  id: string;
  message_type: string;
  aggregate_type: string;
  aggregate_id: string;
  correlation_id: string;
  payload_json: string;
  idempotency_key: string;
  status: OutboxStatus;
  attempt_count: number;
  next_attempt_at: number;
  lease_until: number | null;
  last_error: string | null;
  created_at: number;
  updated_at: number;
}
