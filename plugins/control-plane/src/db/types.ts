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
  | "dead-letter"
  | "outcome-unknown";
export type OutboxDeliveryKind =
  | "retryable"
  | "reconcile-before-retry"
  | "non-retryable";

export interface ControlProjectRow {
  id: string;
  bb_project_id: string;
  tasks_project_id: string | null;
  status: ControlProjectStatus;
  onboarding_version: number;
  policy_version: number;
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
  delivery_kind: OutboxDeliveryKind;
  reconciliation_key: string | null;
  attempt_count: number;
  next_attempt_at: number;
  lease_until: number | null;
  lease_token: string | null;
  last_error: string | null;
  version: number;
  created_at: number;
  updated_at: number;
}
