import type { BbPluginApi } from "@bb/plugin-sdk";

type PluginDatabase = ReturnType<BbPluginApi["storage"]["database"]>;

/** Keeps aggregate writes and their outbox rows in one local transaction. */
export function withUnitOfWork<T>(db: PluginDatabase, work: () => T): T {
  return db.transaction(work)();
}

/** External SDK/RPC calls must happen after this function returns. */
export function assertExternalCallsOutsideTransaction(): void {
  // Deliberately empty marker for application-service code and architecture tests.
}
