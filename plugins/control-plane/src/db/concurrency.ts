import type { BbPluginApi } from "@bb/plugin-sdk";
import {
  aggregateVersionSchema,
  VersionConflictError,
} from "@bb-private/control-plane-domain";

type PluginDatabase = ReturnType<BbPluginApi["storage"]["database"]>;

const identifier = /^[A-Za-z_][A-Za-z0-9_]*$/u;

function assertIdentifier(value: string, label: string): void {
  if (!identifier.test(value)) throw new Error(`Invalid SQL ${label}`);
}

export interface CompareAndSwapInput {
  table: string;
  idColumn?: string;
  id: string;
  expectedVersion: number;
  updates: Readonly<Record<string, string | number | null>>;
  now: number;
}

/**
 * Updates one canonical aggregate only when its version still matches. Table
 * and column names are internal allowlisted values, never user input.
 */
export function compareAndSwap(
  db: PluginDatabase,
  input: CompareAndSwapInput,
): number {
  const expectedVersion = aggregateVersionSchema.parse(input.expectedVersion);
  const idColumn = input.idColumn ?? "id";
  assertIdentifier(input.table, "table");
  assertIdentifier(idColumn, "id column");
  const updateEntries = Object.entries(input.updates);
  for (const [column] of updateEntries) assertIdentifier(column, "column");
  if (
    updateEntries.some(
      ([column]) => column === "version" || column === "updated_at",
    )
  ) {
    throw new Error("version and updated_at are managed by compareAndSwap");
  }
  const assignments = updateEntries.map(([column]) => `${column} = ?`);
  assignments.push("version = version + 1", "updated_at = ?");
  const values = updateEntries.map(([, value]) => value);
  values.push(input.now, input.id, expectedVersion);
  const result = db
    .prepare(
      `UPDATE ${input.table} SET ${assignments.join(", ")} WHERE ${idColumn} = ? AND version = ?`,
    )
    .run(...values);
  if (result.changes === 1) return expectedVersion + 1;
  const row = db
    .prepare(`SELECT version FROM ${input.table} WHERE ${idColumn} = ?`)
    .get(input.id);
  let actualVersion: number | null = null;
  if (typeof row === "object" && row !== null && "version" in row) {
    const value = row.version;
    if (typeof value === "number") actualVersion = value;
  }
  throw new VersionConflictError({ expectedVersion, actualVersion });
}
