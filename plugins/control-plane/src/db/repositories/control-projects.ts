import type { BbPluginApi } from "@bb/plugin-sdk";
import { z } from "zod";
import { compareAndSwap } from "../concurrency.js";

type PluginDatabase = ReturnType<BbPluginApi["storage"]["database"]>;

const rowSchema = z
  .object({
    id: z.string(),
    bb_project_id: z.string(),
    tasks_project_id: z.string().nullable(),
    status: z.enum(["draft", "initializing", "active", "degraded", "archived"]),
    onboarding_version: z.number().int().min(1),
    policy_version: z.number().int().min(1),
    version: z.number().int().min(1),
    created_at: z.number().int().nonnegative(),
    updated_at: z.number().int().nonnegative(),
  })
  .strict();

export type ControlProject = z.infer<typeof rowSchema>;
export type CreateControlProject = Pick<
  ControlProject,
  "id" | "bb_project_id"
> & {
  tasks_project_id?: string | null;
  now: number;
};

function parse(value: unknown): ControlProject | null {
  if (value === undefined) return null;
  const result = rowSchema.safeParse(value);
  if (!result.success)
    throw new Error(`Invalid control project row: ${result.error.message}`);
  return result.data;
}

export function getControlProject(
  db: PluginDatabase,
  id: string,
): ControlProject | null {
  return parse(
    db.prepare("SELECT * FROM control_projects WHERE id = ?").get(id),
  );
}

export function getControlProjectByBbProject(
  db: PluginDatabase,
  bbProjectId: string,
): ControlProject | null {
  return parse(
    db
      .prepare("SELECT * FROM control_projects WHERE bb_project_id = ?")
      .get(bbProjectId),
  );
}

export function createControlProject(
  db: PluginDatabase,
  input: CreateControlProject,
): ControlProject {
  db.prepare(
    `INSERT INTO control_projects
     (id, bb_project_id, tasks_project_id, status, onboarding_version, policy_version, version, created_at, updated_at)
     VALUES (?, ?, ?, 'draft', 1, 1, 1, ?, ?)`,
  ).run(
    input.id,
    input.bb_project_id,
    input.tasks_project_id ?? null,
    input.now,
    input.now,
  );
  const created = getControlProject(db, input.id);
  if (!created) throw new Error("Control project was not created");
  return created;
}

export function updateControlProjectStatus(
  db: PluginDatabase,
  input: {
    id: string;
    expectedVersion: number;
    status: ControlProject["status"];
    now: number;
  },
): ControlProject {
  compareAndSwap(db, {
    table: "control_projects",
    id: input.id,
    expectedVersion: input.expectedVersion,
    updates: { status: input.status },
    now: input.now,
  });
  const updated = getControlProject(db, input.id);
  if (!updated) throw new Error("Control project disappeared after update");
  return updated;
}

export function archiveControlProject(
  db: PluginDatabase,
  input: { id: string; expectedVersion: number; now: number },
): ControlProject {
  return updateControlProjectStatus(db, { ...input, status: "archived" });
}
