import type { BbPluginApi } from "@bb/plugin-sdk";
import { z } from "zod";
import { compareAndSwap } from "../concurrency.js";

type PluginDatabase = ReturnType<BbPluginApi["storage"]["database"]>;

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
    status: z.enum([
      "created",
      "active",
      "checkpointed",
      "idle",
      "failed",
      "finished",
      "cancelled",
    ]),
    version: z.number().int().min(1),
    created_at: z.number().int().nonnegative(),
    updated_at: z.number().int().nonnegative(),
  })
  .strict();

export type WorkSession = z.infer<typeof rowSchema>;

function parse(value: unknown): WorkSession | null {
  if (value === undefined) return null;
  const result = rowSchema.safeParse(value);
  if (!result.success)
    throw new Error(`Invalid work session row: ${result.error.message}`);
  return result.data;
}

export function getWorkSession(
  db: PluginDatabase,
  id: string,
): WorkSession | null {
  return parse(db.prepare("SELECT * FROM work_sessions WHERE id = ?").get(id));
}

export function listWorkSessions(
  db: PluginDatabase,
  input: { projectId: string; status?: WorkSession["status"]; limit?: number },
): WorkSession[] {
  const limit = Math.max(1, Math.min(input.limit ?? 50, 200));
  const rows =
    input.status === undefined
      ? db
          .prepare(
            "SELECT * FROM work_sessions WHERE project_id = ? ORDER BY updated_at DESC, id DESC LIMIT ?",
          )
          .all(input.projectId, limit)
      : db
          .prepare(
            "SELECT * FROM work_sessions WHERE project_id = ? AND status = ? ORDER BY updated_at DESC, id DESC LIMIT ?",
          )
          .all(input.projectId, input.status, limit);
  return rows.map((value) => {
    const parsed = parse(value);
    if (!parsed) throw new Error("Unexpected missing work session row");
    return parsed;
  });
}

export function updateWorkSession(
  db: PluginDatabase,
  input: {
    id: string;
    expectedVersion: number;
    now: number;
    status?: WorkSession["status"];
    currentCheckpoint?: string | null;
    resultSummary?: string | null;
  },
): WorkSession {
  const updates = {
    ...(input.status === undefined ? {} : { status: input.status }),
    ...(input.currentCheckpoint === undefined
      ? {}
      : { current_checkpoint: input.currentCheckpoint }),
    ...(input.resultSummary === undefined
      ? {}
      : { result_summary: input.resultSummary }),
  };
  if (Object.keys(updates).length === 0)
    throw new Error("A work-session field is required");
  compareAndSwap(db, {
    table: "work_sessions",
    id: input.id,
    expectedVersion: input.expectedVersion,
    updates,
    now: input.now,
  });
  const updated = getWorkSession(db, input.id);
  if (!updated) throw new Error("Work session disappeared after update");
  return updated;
}
