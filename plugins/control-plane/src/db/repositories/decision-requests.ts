import type { BbPluginApi } from "@bb/plugin-sdk";
import { z } from "zod";

type PluginDatabase = ReturnType<BbPluginApi["storage"]["database"]>;

const rowSchema = z
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
    status: z.enum(["open", "clustered", "resolved", "rejected", "superseded"]),
    version: z.number().int().min(1),
    created_at: z.number().int().nonnegative(),
    updated_at: z.number().int().nonnegative(),
  })
  .strict();

export type DecisionRequest = z.infer<typeof rowSchema>;

function parse(value: unknown): DecisionRequest {
  const result = rowSchema.safeParse(value);
  if (!result.success)
    throw new Error(`Invalid decision request row: ${result.error.message}`);
  return result.data;
}

export function getDecisionRequest(
  db: PluginDatabase,
  id: string,
): DecisionRequest | null {
  const value = db
    .prepare("SELECT * FROM decision_requests WHERE id = ?")
    .get(id);
  return value === undefined ? null : parse(value);
}

export function listDecisionRequests(
  db: PluginDatabase,
  input: {
    projectId: string;
    status?: DecisionRequest["status"];
    limit?: number;
    offset?: number;
  },
): DecisionRequest[] {
  const limit = Math.max(1, Math.min(input.limit ?? 50, 200));
  const offset = Math.max(0, input.offset ?? 0);
  const rows =
    input.status === undefined
      ? db
          .prepare(
            "SELECT * FROM decision_requests WHERE project_id = ? ORDER BY updated_at DESC, id DESC LIMIT ? OFFSET ?",
          )
          .all(input.projectId, limit, offset)
      : db
          .prepare(
            "SELECT * FROM decision_requests WHERE project_id = ? AND status = ? ORDER BY updated_at DESC, id DESC LIMIT ? OFFSET ?",
          )
          .all(input.projectId, input.status, limit, offset);
  return rows.map(parse);
}
