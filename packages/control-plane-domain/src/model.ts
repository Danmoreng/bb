import type {
  AgentRoleId,
  ArtifactRefId,
  DecisionRefId,
  ProjectControlId,
  RunRefId,
  TaskRefId,
} from "./ids.js";

export type AgentRoleKind = "steward" | "worker" | "investigator" | "reviewer";

export interface ProjectControl {
  id: ProjectControlId;
  bbProjectId: string;
  name: string;
  policyVersion: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface AgentRole {
  id: AgentRoleId;
  kind: AgentRoleKind;
  name: string;
  instructionsVersion: number;
}

export interface TaskRef {
  id: TaskRefId;
  externalProjectId: string;
  externalTaskId: string;
  titleSnapshot: string;
}

export interface RunRef {
  id: RunRefId;
  taskId: TaskRefId;
  threadId: string;
  status: "created" | "active" | "idle" | "failed" | "finished";
}

export interface DecisionRef {
  id: DecisionRefId;
  title: string;
  status: "open" | "resolved" | "superseded";
}

export interface ArtifactRef {
  id: ArtifactRefId;
  kind: "diff" | "file" | "commit" | "pull-request";
  locator: string;
}
