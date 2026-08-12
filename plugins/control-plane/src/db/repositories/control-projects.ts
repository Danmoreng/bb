import type { BbPluginApi } from "@bb/plugin-sdk";
import { z } from "zod";
import { compareAndSwap } from "../concurrency.js";
import {
  assertPageCursorBinding,
  decodePageCursor,
  pageLimit,
  pageResult,
} from "./cursor.js";

type PluginDatabase = ReturnType<BbPluginApi["storage"]["database"]>;

const projectColumns =
  "id, bb_project_id, tasks_project_id, status, onboarding_version, policy_version, version, created_at, updated_at";
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
export type ControlProjectPage = {
  items: ControlProject[];
  nextCursor: string | null;
};
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

export interface ControlProjectRepository {
  get(id: string): ControlProject | null;
  getByBbProject(bbProjectId: string): ControlProject | null;
  create(input: CreateControlProject): ControlProject;
  updateStatus(input: {
    id: string;
    expectedVersion: number;
    status: ControlProject["status"];
    now: number;
  }): ControlProject;
  archive(input: {
    id: string;
    expectedVersion: number;
    now: number;
  }): ControlProject;
  list(input: {
    status?: ControlProject["status"];
    limit?: number;
    cursor?: string;
  }): ControlProjectPage;
}

export function createControlProjectRepository(
  db: PluginDatabase,
): ControlProjectRepository {
  const get = (id: string): ControlProject | null =>
    parse(
      db
        .prepare(`SELECT ${projectColumns} FROM control_projects WHERE id = ?`)
        .get(id),
    );
  const getByBbProject = (bbProjectId: string): ControlProject | null =>
    parse(
      db
        .prepare(
          `SELECT ${projectColumns} FROM control_projects WHERE bb_project_id = ?`,
        )
        .get(bbProjectId),
    );
  const readOrThrow = (id: string): ControlProject => {
    const row = get(id);
    if (!row) throw new Error("Control project was not found");
    return row;
  };
  const updateStatus = (input: {
    id: string;
    expectedVersion: number;
    status: ControlProject["status"];
    now: number;
  }): ControlProject => {
    compareAndSwap(db, {
      table: "control_projects",
      id: input.id,
      expectedVersion: input.expectedVersion,
      updates: { status: input.status },
      now: input.now,
    });
    return readOrThrow(input.id);
  };
  return {
    get,
    getByBbProject,
    create(input) {
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
      return readOrThrow(input.id);
    },
    updateStatus,
    archive(input) {
      return updateStatus({ ...input, status: "archived" });
    },
    list(input) {
      const limit = pageLimit(input.limit);
      const cursor = decodePageCursor(input.cursor);
      const status = input.status ?? null;
      assertPageCursorBinding(cursor, { projectId: null, status });
      const statusWhere = input.status === undefined ? "" : " AND status = ?";
      const cursorWhere = cursor
        ? " AND (updated_at < ? OR (updated_at = ? AND id < ?))"
        : "";
      const params: Array<string | number> = [];
      if (input.status !== undefined) params.push(input.status);
      if (cursor) params.push(cursor.updatedAt, cursor.updatedAt, cursor.id);
      params.push(limit + 1);
      const rows = db
        .prepare(
          `SELECT ${projectColumns} FROM control_projects
           WHERE 1 = 1${statusWhere}${cursorWhere}
           ORDER BY updated_at DESC, id DESC LIMIT ?`,
        )
        .all(...params)
        .map((value) => {
          const row = parse(value);
          if (!row) throw new Error("Unexpected missing control project row");
          return row;
        });
      return pageResult(rows, limit, { projectId: null, status }, (row) => ({
        updatedAt: row.updated_at,
        id: row.id,
      }));
    },
  };
}

// Compatibility wrappers for the first CP-105 slice.
export function getControlProject(db: PluginDatabase, id: string) {
  return createControlProjectRepository(db).get(id);
}
export function getControlProjectByBbProject(
  db: PluginDatabase,
  bbProjectId: string,
) {
  return createControlProjectRepository(db).getByBbProject(bbProjectId);
}
export function createControlProject(
  db: PluginDatabase,
  input: CreateControlProject,
) {
  return createControlProjectRepository(db).create(input);
}
export function updateControlProjectStatus(
  db: PluginDatabase,
  input: Parameters<ControlProjectRepository["updateStatus"]>[0],
) {
  return createControlProjectRepository(db).updateStatus(input);
}
export function archiveControlProject(
  db: PluginDatabase,
  input: Parameters<ControlProjectRepository["archive"]>[0],
) {
  return createControlProjectRepository(db).archive(input);
}
export function listControlProjects(
  db: PluginDatabase,
  input: Parameters<ControlProjectRepository["list"]>[0],
) {
  return createControlProjectRepository(db).list(input);
}
