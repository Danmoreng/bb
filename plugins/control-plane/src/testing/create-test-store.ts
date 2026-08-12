import { createConnection } from "@bb/db";
import { z } from "zod";
import { initializeControlPlaneDatabase } from "../db/migrations.js";

type PluginDatabase = ReturnType<typeof createConnection>["$client"];
const migrationRowSchema = z.object({ id: z.number().int() }).strict();

function migratePluginDatabase(
  database: PluginDatabase,
  statements: string[],
): void {
  database.exec(
    "CREATE TABLE IF NOT EXISTS _bb_migrations (id INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)",
  );
  const applied = new Set(
    database
      .prepare("SELECT id FROM _bb_migrations")
      .all()
      .map((row) => migrationRowSchema.parse(row).id),
  );
  const record = database.prepare(
    "INSERT INTO _bb_migrations (id, applied_at) VALUES (?, ?)",
  );
  database.transaction(() => {
    statements.forEach((statement, index) => {
      if (applied.has(index)) return;
      database.exec(statement);
      record.run(index, Date.now());
    });
  })();
}

/** A real, isolated SQLite fixture for repository tests. */
export function createControlPlaneTestStore() {
  const connection = createConnection(":memory:");
  const db = connection.$client;
  initializeControlPlaneDatabase(db, migratePluginDatabase);
  return {
    db,
    async close(): Promise<void> {
      if (db.open) db.close();
    },
  };
}
