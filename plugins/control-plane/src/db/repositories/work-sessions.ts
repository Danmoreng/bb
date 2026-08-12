import type { BbPluginApi } from "@bb/plugin-sdk";
import {
  aggregateVersionSchema,
  VersionConflictError,
} from "@bb-private/control-plane-domain";
import { z } from "zod";
import {
  assertPageCursorBinding,
  decodePageCursor,
  pageLimit,
  pageResult,
} from "./cursor.js";

type PluginDatabase = ReturnType<BbPluginApi["storage"]["database"]>;

const detailColumns =
  "id, project_id, task_id, agent_id, thread_id, environment_ref, branch_ref, plan, plan_version, current_checkpoint, context_cursor, result_summary, status, version, created_at, updated_at";
const summaryColumns =
  "id, project_id, task_id, agent_id, thread_id, environment_ref, branch_ref, plan_version, current_checkpoint, context_cursor, status, version, created_at, updated_at";
const statusSchema = z.enum([
  "created",
  "active",
  "checkpointed",
  "idle",
  "failed",
  "finished",
  "cancelled",
]);
const rowSchema = z
  .object({
    id: z.string(),
    project_id: z.string(),
    task_id: z.string().nullable(),
    agent_id: z.string().nullable(),
    thread_id: z.string().nullable(),
    environment_ref: z.string().nullable(),
    branch_ref: z.string().nullable(),
    plan: z.string().nullable(),
    plan_version: z.number().int().min(1),
    current_checkpoint: z.string().nullable(),
    context_cursor: z.string().nullable(),
    result_summary: z.string().nullable(),
    status: statusSchema,
    version: z.number().int().min(1),
    created_at: z.number().int().nonnegative(),
    updated_at: z.number().int().nonnegative(),
  })
  .strict();
const summarySchema = rowSchema.omit({ plan: true, result_summary: true });

export type WorkSession = z.infer<typeof rowSchema>;
export type WorkSessionSummary = z.infer<typeof summarySchema>;
export type CreateWorkSession = {
  id: string;
  projectId: string;
  /** Null means the session is planned and has not been dispatched yet. */
  agentId?: string | null;
  now: number;
  taskId?: string | null;
  threadId?: string | null;
  environmentRef?: string | null;
  branchRef?: string | null;
  plan?: string | null;
  currentCheckpoint?: string | null;
  contextCursor?: string | null;
  resultSummary?: string | null;
  status?: WorkSession["status"];
};
export type WorkSessionPage = {
  items: WorkSessionSummary[];
  nextCursor: string | null;
};

function parseDetail(value: unknown): WorkSession | null {
  if (value === undefined) return null;
  const result = rowSchema.safeParse(value);
  if (!result.success)
    throw new Error(`Invalid work session row: ${result.error.message}`);
  if (
    requiresAssignedAgent(result.data.status) &&
    result.data.agent_id === null
  ) {
    throw new Error(
      `Invalid work session row: status ${result.data.status} requires an assigned agent`,
    );
  }
  return result.data;
}
function parseSummary(value: unknown): WorkSessionSummary {
  const result = summarySchema.safeParse(value);
  if (!result.success)
    throw new Error(`Invalid work session summary: ${result.error.message}`);
  if (
    requiresAssignedAgent(result.data.status) &&
    result.data.agent_id === null
  ) {
    throw new Error(
      `Invalid work session summary: status ${result.data.status} requires an assigned agent`,
    );
  }
  return result.data;
}

function requiresAssignedAgent(status: WorkSession["status"]): boolean {
  return ["active", "checkpointed", "idle", "finished"].includes(status);
}

function assertAgentCanBeAssigned(
  db: PluginDatabase,
  projectId: string,
  agentId: string,
): void {
  if (agentId.trim() === "") throw new Error("agentId is required");
  const agent = db
    .prepare(
      "SELECT status FROM managed_agents WHERE project_id = ? AND id = ?",
    )
    .get(projectId, agentId);
  if (typeof agent !== "object" || agent === null || !("status" in agent)) {
    throw new Error("agent must belong to the work-session project");
  }
  const status = agent.status;
  if (
    status !== "created" &&
    status !== "starting" &&
    status !== "active" &&
    status !== "idle"
  ) {
    throw new Error("agent is not assignable in its current status");
  }
}

function compareAndSwapWorkSession(
  db: PluginDatabase,
  input: {
    projectId: string;
    id: string;
    expectedVersion: number;
    updates: Readonly<Record<string, string | number | null>>;
    now: number;
  },
): number {
  const expectedVersion = aggregateVersionSchema.parse(input.expectedVersion);
  const assignments = Object.entries(input.updates).map(
    ([column]) => `${column} = ?`,
  );
  assignments.push("version = version + 1", "updated_at = ?");
  const result = db
    .prepare(
      `UPDATE work_sessions SET ${assignments.join(", ")} WHERE project_id = ? AND id = ? AND version = ?`,
    )
    .run(
      ...Object.values(input.updates),
      input.now,
      input.projectId,
      input.id,
      expectedVersion,
    );
  if (result.changes === 1) return expectedVersion + 1;
  const row = db
    .prepare(
      "SELECT version FROM work_sessions WHERE project_id = ? AND id = ?",
    )
    .get(input.projectId, input.id);
  let actualVersion: number | null = null;
  if (typeof row === "object" && row !== null && "version" in row) {
    const value = row.version;
    if (typeof value === "number") actualVersion = value;
  }
  throw new VersionConflictError({ expectedVersion, actualVersion });
}

function assertExpectedVersion(
  expectedVersion: number,
  actualVersion: number,
): void {
  const expected = aggregateVersionSchema.parse(expectedVersion);
  if (expected !== actualVersion) {
    throw new VersionConflictError({
      expectedVersion: expected,
      actualVersion,
    });
  }
}

type WorkSessionUpdateBase = {
  projectId: string;
  id: string;
  expectedVersion: number;
  now: number;
};
export type WorkSessionUpdate = WorkSessionUpdateBase &
  (
    | {
        status: WorkSession["status"];
        currentCheckpoint?: string | null;
        resultSummary?: string | null;
      }
    | {
        status?: WorkSession["status"];
        currentCheckpoint: string | null;
        resultSummary?: string | null;
      }
    | {
        status?: WorkSession["status"];
        currentCheckpoint?: string | null;
        resultSummary: string | null;
      }
  );

export interface WorkSessionRepository {
  get(projectId: string, id: string): WorkSession | null;
  create(input: CreateWorkSession): WorkSession;
  assignAgent(input: {
    projectId: string;
    id: string;
    expectedVersion: number;
    agentId: string;
    now: number;
  }): WorkSession;
  activate(input: {
    projectId: string;
    id: string;
    expectedVersion: number;
    now: number;
  }): WorkSession;
  update(input: WorkSessionUpdate): WorkSession;
  list(input: {
    projectId: string;
    status?: WorkSession["status"];
    limit?: number;
    cursor?: string;
  }): WorkSessionPage;
}

export function createWorkSessionRepository(
  db: PluginDatabase,
): WorkSessionRepository {
  const get = (projectId: string, id: string): WorkSession | null =>
    parseDetail(
      db
        .prepare(
          `SELECT ${detailColumns} FROM work_sessions WHERE project_id = ? AND id = ?`,
        )
        .get(projectId, id),
    );
  const readOrThrow = (projectId: string, id: string): WorkSession => {
    const row = get(projectId, id);
    if (!row) throw new Error("Work session was not found");
    return row;
  };
  return {
    get,
    create(input) {
      const agentId = input.agentId ?? null;
      const status = input.status ?? "created";
      if (agentId !== null) {
        assertAgentCanBeAssigned(db, input.projectId, agentId);
      }
      if (requiresAssignedAgent(status) && agentId === null) {
        throw new Error(`status ${status} requires an assigned agent`);
      }
      db.prepare(
        `INSERT INTO work_sessions
         (id, project_id, task_id, agent_id, thread_id, environment_ref, branch_ref, plan,
          plan_version, current_checkpoint, context_cursor, result_summary, status, version, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, 1, ?, ?)`,
      ).run(
        input.id,
        input.projectId,
        input.taskId ?? null,
        agentId,
        input.threadId ?? null,
        input.environmentRef ?? null,
        input.branchRef ?? null,
        input.plan ?? null,
        input.currentCheckpoint ?? null,
        input.contextCursor ?? null,
        input.resultSummary ?? null,
        input.status ?? "created",
        input.now,
        input.now,
      );
      return readOrThrow(input.projectId, input.id);
    },
    assignAgent(input) {
      const current = readOrThrow(input.projectId, input.id);
      assertAgentCanBeAssigned(db, input.projectId, input.agentId);
      if (current.status !== "created") {
        throw new Error("Only created work sessions can be assigned");
      }
      if (current.agent_id !== null) {
        if (current.agent_id !== input.agentId) {
          throw new Error("A work session cannot be reassigned");
        }
        assertExpectedVersion(input.expectedVersion, current.version);
        return current;
      }
      compareAndSwapWorkSession(db, {
        projectId: input.projectId,
        id: input.id,
        expectedVersion: input.expectedVersion,
        updates: { agent_id: input.agentId },
        now: input.now,
      });
      return readOrThrow(input.projectId, input.id);
    },
    activate(input) {
      const current = readOrThrow(input.projectId, input.id);
      if (current.status !== "created") {
        throw new Error("Only created work sessions can be activated");
      }
      if (current.agent_id === null) {
        throw new Error("A work session must have an assigned agent");
      }
      compareAndSwapWorkSession(db, {
        projectId: input.projectId,
        id: input.id,
        expectedVersion: input.expectedVersion,
        updates: { status: "active" },
        now: input.now,
      });
      return readOrThrow(input.projectId, input.id);
    },
    update(input) {
      const current = readOrThrow(input.projectId, input.id);
      if (
        input.status !== undefined &&
        requiresAssignedAgent(input.status) &&
        current.agent_id === null
      ) {
        throw new Error(`status ${input.status} requires an assigned agent`);
      }
      if (
        ["failed", "finished", "cancelled"].includes(current.status) &&
        input.status !== undefined &&
        input.status !== current.status
      ) {
        throw new Error("Terminal work sessions cannot change status");
      }
      const updates = {
        ...(input.status === undefined ? {} : { status: input.status }),
        ...(input.currentCheckpoint === undefined
          ? {}
          : { current_checkpoint: input.currentCheckpoint }),
        ...(input.resultSummary === undefined
          ? {}
          : { result_summary: input.resultSummary }),
      };
      compareAndSwapWorkSession(db, {
        projectId: input.projectId,
        id: input.id,
        expectedVersion: input.expectedVersion,
        updates,
        now: input.now,
      });
      return readOrThrow(input.projectId, input.id);
    },
    list(input) {
      const limit = pageLimit(input.limit);
      const cursor = decodePageCursor(input.cursor);
      const status = input.status ?? null;
      assertPageCursorBinding(cursor, {
        projectId: input.projectId,
        status,
      });
      const where = input.status === undefined ? "" : " AND status = ?";
      const cursorWhere = cursor
        ? " AND (updated_at < ? OR (updated_at = ? AND id < ?))"
        : "";
      const params: Array<string | number> = [input.projectId];
      if (input.status !== undefined) params.push(input.status);
      if (cursor) params.push(cursor.updatedAt, cursor.updatedAt, cursor.id);
      params.push(limit + 1);
      const rows = db
        .prepare(
          `SELECT ${summaryColumns} FROM work_sessions
           WHERE project_id = ?${where}${cursorWhere}
           ORDER BY updated_at DESC, id DESC LIMIT ?`,
        )
        .all(...params)
        .map(parseSummary);
      return pageResult(
        rows,
        limit,
        { projectId: input.projectId, status },
        (row) => ({ updatedAt: row.updated_at, id: row.id }),
      );
    },
  };
}

// Compatibility wrappers for the first CP-105 slice.
export function getWorkSession(
  db: PluginDatabase,
  projectId: string,
  id: string,
) {
  return createWorkSessionRepository(db).get(projectId, id);
}
export function createWorkSession(
  db: PluginDatabase,
  input: CreateWorkSession,
) {
  return createWorkSessionRepository(db).create(input);
}
export function updateWorkSession(
  db: PluginDatabase,
  input: WorkSessionUpdate,
) {
  return createWorkSessionRepository(db).update(input);
}
export function assignWorkSessionAgent(
  db: PluginDatabase,
  input: Parameters<WorkSessionRepository["assignAgent"]>[0],
) {
  return createWorkSessionRepository(db).assignAgent(input);
}
export function activateWorkSession(
  db: PluginDatabase,
  input: Parameters<WorkSessionRepository["activate"]>[0],
) {
  return createWorkSessionRepository(db).activate(input);
}
export function listWorkSessions(
  db: PluginDatabase,
  input: Parameters<WorkSessionRepository["list"]>[0],
) {
  return createWorkSessionRepository(db).list(input);
}
