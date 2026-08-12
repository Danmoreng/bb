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
  "id, project_id, source_agent_id, source_run_id, source_task_id, question, category, options_json, recommendation, risk_json, scope_json, evidence_json, blocking_scope, status, version, created_at, updated_at";
const summaryColumns =
  "id, project_id, source_agent_id, source_run_id, source_task_id, question, category, recommendation, blocking_scope, status, version, created_at, updated_at";
const statusSchema = z.enum([
  "open",
  "clustered",
  "resolved",
  "rejected",
  "superseded",
]);
const jsonArraySchema = z.array(z.json());
const jsonObjectSchema = z.record(z.string(), z.json());
const storedRowSchema = z
  .object({
    id: z.string(),
    project_id: z.string(),
    source_agent_id: z.string().nullable(),
    source_run_id: z.string().nullable(),
    source_task_id: z.string().nullable(),
    question: z.string(),
    category: z.string(),
    options_json: z.string(),
    recommendation: z.string().nullable(),
    risk_json: z.string(),
    scope_json: z.string(),
    evidence_json: z.string(),
    blocking_scope: z.string().nullable(),
    status: statusSchema,
    version: z.number().int().min(1),
    created_at: z.number().int().nonnegative(),
    updated_at: z.number().int().nonnegative(),
  })
  .strict();
const storedSummarySchema = storedRowSchema.omit({
  options_json: true,
  risk_json: true,
  scope_json: true,
  evidence_json: true,
});

type StoredDecisionRequest = z.infer<typeof storedRowSchema>;
type StoredDecisionRequestSummary = z.infer<typeof storedSummarySchema>;
type DecisionJsonArray = z.infer<typeof jsonArraySchema>;
type DecisionJsonObject = z.infer<typeof jsonObjectSchema>;

export type DecisionRequest = {
  id: string;
  projectId: string;
  sourceAgentId: string | null;
  sourceRunId: string | null;
  sourceTaskId: string | null;
  question: string;
  category: string;
  options: DecisionJsonArray;
  recommendation: string | null;
  risk: DecisionJsonObject;
  scope: DecisionJsonObject;
  evidence: DecisionJsonArray;
  blockingScope: string | null;
  status: z.infer<typeof statusSchema>;
  version: number;
  createdAt: number;
  updatedAt: number;
};
export type DecisionRequestSummary = Omit<
  DecisionRequest,
  "options" | "risk" | "scope" | "evidence"
>;
export type CreateDecisionRequest = {
  id: string;
  projectId: string;
  question: string;
  category: string;
  options: DecisionJsonArray;
  risk?: DecisionJsonObject;
  scope?: DecisionJsonObject;
  evidence?: DecisionJsonArray;
  sourceAgentId?: string | null;
  sourceRunId?: string | null;
  sourceTaskId?: string | null;
  recommendation?: string | null;
  blockingScope?: string | null;
  status?: DecisionRequest["status"];
  now: number;
};
type DecisionRequestUpdateBase = {
  projectId: string;
  id: string;
  expectedVersion: number;
  now: number;
};
export type DecisionRequestUpdate = DecisionRequestUpdateBase &
  (
    | {
        recommendation: string | null;
        blockingScope?: string | null;
        status?: DecisionRequest["status"];
      }
    | {
        recommendation?: never;
        blockingScope: string | null;
        status?: DecisionRequest["status"];
      }
    | {
        recommendation?: never;
        blockingScope?: never;
        status: DecisionRequest["status"];
      }
  );
export type DecisionRequestPage = {
  items: DecisionRequestSummary[];
  nextCursor: string | null;
};

function parseJson<T>(schema: z.ZodType<T>, value: string, name: string): T {
  let decoded: unknown;
  try {
    decoded = JSON.parse(value);
  } catch {
    throw new Error(`${name} is not valid JSON`);
  }
  const result = schema.safeParse(decoded);
  if (!result.success) throw new Error(`${name} has an invalid shape`);
  return result.data;
}
function validateCreateJson(input: CreateDecisionRequest): void {
  jsonArraySchema.parse(input.options);
  jsonObjectSchema.parse(input.risk ?? {});
  jsonObjectSchema.parse(input.scope ?? {});
  jsonArraySchema.parse(input.evidence ?? []);
}
function fromStored(row: StoredDecisionRequest): DecisionRequest {
  return {
    id: row.id,
    projectId: row.project_id,
    sourceAgentId: row.source_agent_id,
    sourceRunId: row.source_run_id,
    sourceTaskId: row.source_task_id,
    question: row.question,
    category: row.category,
    options: parseJson(jsonArraySchema, row.options_json, "options"),
    recommendation: row.recommendation,
    risk: parseJson(jsonObjectSchema, row.risk_json, "risk"),
    scope: parseJson(jsonObjectSchema, row.scope_json, "scope"),
    evidence: parseJson(jsonArraySchema, row.evidence_json, "evidence"),
    blockingScope: row.blocking_scope,
    status: row.status,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
function parse(value: unknown): DecisionRequest {
  const result = storedRowSchema.safeParse(value);
  if (!result.success)
    throw new Error(`Invalid decision request row: ${result.error.message}`);
  return fromStored(result.data);
}
function parseSummary(value: unknown): DecisionRequestSummary {
  const result = storedSummarySchema.safeParse(value);
  if (!result.success)
    throw new Error(
      `Invalid decision request summary: ${result.error.message}`,
    );
  const row: StoredDecisionRequestSummary = result.data;
  return {
    id: row.id,
    projectId: row.project_id,
    sourceAgentId: row.source_agent_id,
    sourceRunId: row.source_run_id,
    sourceTaskId: row.source_task_id,
    question: row.question,
    category: row.category,
    recommendation: row.recommendation,
    blockingScope: row.blocking_scope,
    status: row.status,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface DecisionRequestRepository {
  get(projectId: string, id: string): DecisionRequest | null;
  create(input: CreateDecisionRequest): DecisionRequest;
  update(input: DecisionRequestUpdate): DecisionRequest;
  list(input: {
    projectId: string;
    status?: DecisionRequest["status"];
    limit?: number;
    cursor?: string;
  }): DecisionRequestPage;
}

function compareAndSwapDecisionRequest(
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
      `UPDATE decision_requests SET ${assignments.join(", ")} WHERE project_id = ? AND id = ? AND version = ?`,
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
      "SELECT version FROM decision_requests WHERE project_id = ? AND id = ?",
    )
    .get(input.projectId, input.id);
  let actualVersion: number | null = null;
  if (typeof row === "object" && row !== null && "version" in row) {
    const value = row.version;
    if (typeof value === "number") actualVersion = value;
  }
  throw new VersionConflictError({ expectedVersion, actualVersion });
}

export function createDecisionRequestRepository(
  db: PluginDatabase,
): DecisionRequestRepository {
  const get = (projectId: string, id: string): DecisionRequest | null => {
    const value = db
      .prepare(
        `SELECT ${detailColumns} FROM decision_requests WHERE project_id = ? AND id = ?`,
      )
      .get(projectId, id);
    return value === undefined ? null : parse(value);
  };
  const readOrThrow = (projectId: string, id: string): DecisionRequest => {
    const row = get(projectId, id);
    if (!row) throw new Error("Decision request was not found");
    return row;
  };
  return {
    get,
    create(input) {
      validateCreateJson(input);
      db.prepare(
        `INSERT INTO decision_requests
         (id, project_id, source_agent_id, source_run_id, source_task_id, question, category,
          options_json, recommendation, risk_json, scope_json, evidence_json, blocking_scope,
          status, version, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
      ).run(
        input.id,
        input.projectId,
        input.sourceAgentId ?? null,
        input.sourceRunId ?? null,
        input.sourceTaskId ?? null,
        input.question,
        input.category,
        JSON.stringify(input.options),
        input.recommendation ?? null,
        JSON.stringify(input.risk ?? {}),
        JSON.stringify(input.scope ?? {}),
        JSON.stringify(input.evidence ?? []),
        input.blockingScope ?? null,
        input.status ?? "open",
        input.now,
        input.now,
      );
      return readOrThrow(input.projectId, input.id);
    },
    update(input) {
      readOrThrow(input.projectId, input.id);
      const updates = {
        ...(input.recommendation === undefined
          ? {}
          : { recommendation: input.recommendation }),
        ...(input.blockingScope === undefined
          ? {}
          : { blocking_scope: input.blockingScope }),
        ...(input.status === undefined ? {} : { status: input.status }),
      };
      compareAndSwapDecisionRequest(db, {
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
          `SELECT ${summaryColumns} FROM decision_requests
           WHERE project_id = ?${where}${cursorWhere}
           ORDER BY updated_at DESC, id DESC LIMIT ?`,
        )
        .all(...params)
        .map(parseSummary);
      return pageResult(
        rows,
        limit,
        { projectId: input.projectId, status },
        (row) => ({ updatedAt: row.updatedAt, id: row.id }),
      );
    },
  };
}

export function getDecisionRequest(
  db: PluginDatabase,
  projectId: string,
  id: string,
) {
  return createDecisionRequestRepository(db).get(projectId, id);
}
export function createDecisionRequest(
  db: PluginDatabase,
  input: CreateDecisionRequest,
) {
  return createDecisionRequestRepository(db).create(input);
}
export function updateDecisionRequest(
  db: PluginDatabase,
  input: DecisionRequestUpdate,
) {
  return createDecisionRequestRepository(db).update(input);
}
export function listDecisionRequests(
  db: PluginDatabase,
  input: Parameters<DecisionRequestRepository["list"]>[0],
) {
  return createDecisionRequestRepository(db).list(input);
}
