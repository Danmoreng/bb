import type { BbPluginApi } from "@bb/plugin-sdk";

type PluginDatabase = ReturnType<BbPluginApi["storage"]["database"]>;
type Synchronous<T> = T extends PromiseLike<unknown> ? never : T;
type UnitOfWorkCallback<T> = () => T & Synchronous<T>;

let activeUnitOfWorkCount = 0;

function isDeclaredAsyncFunction(work: () => unknown): boolean {
  return work.constructor.name === "AsyncFunction";
}

export function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    ((typeof value === "object" && value !== null) ||
      typeof value === "function") &&
    "then" in value &&
    typeof value.then === "function"
  );
}

function observeRejectedThenable(value: PromiseLike<unknown>): void {
  // The transaction is rolled back synchronously below. Observing the rejected
  // value prevents a dishonest runtime callback from also causing an unhandled
  // rejection after the caller has received the synchronous contract error.
  void Promise.resolve(value).catch(() => undefined);
}

/**
 * Keeps aggregate writes and their outbox rows in one local transaction.
 *
 * The callback is deliberately synchronous. A promise would outlive the
 * SQLite transaction and could make callers believe an external side effect
 * was covered by the transaction after it had already committed.
 */
export function withUnitOfWork<T>(
  db: PluginDatabase,
  work: UnitOfWorkCallback<T>,
): T {
  if (isDeclaredAsyncFunction(work)) {
    throw new TypeError(
      "withUnitOfWork callbacks must be synchronous; async callbacks are not invoked",
    );
  }

  return db.transaction(() => {
    activeUnitOfWorkCount += 1;
    try {
      const value = work();
      if (isThenable(value)) {
        observeRejectedThenable(value);
        throw new TypeError(
          "withUnitOfWork callbacks must be synchronous; the transaction was rolled back",
        );
      }
      return value;
    } finally {
      activeUnitOfWorkCount -= 1;
    }
  })();
}

/** External SDK/RPC calls must happen after the unit of work returns. */
export function assertExternalCallsOutsideTransaction(): void {
  if (activeUnitOfWorkCount > 0) {
    throw new Error(
      "External SDK/RPC calls are forbidden inside a unit of work",
    );
  }
}

/** Internal test/application adapter guard without exposing transaction state. */
export function isInsideUnitOfWork(): boolean {
  return activeUnitOfWorkCount > 0;
}

/** Reject a callback before any transaction or callback body can start. */
export function assertSynchronousCallback(work: () => unknown): void {
  if (isDeclaredAsyncFunction(work)) {
    throw new TypeError(
      "withUnitOfWork callbacks must be synchronous; async callbacks are not invoked",
    );
  }
}

/** Reject a promise returned by a non-async callback while the transaction is open. */
export function assertSynchronousResult(value: unknown): void {
  if (isThenable(value)) {
    observeRejectedThenable(value);
    throw new TypeError(
      "withUnitOfWork callbacks must be synchronous; the transaction was rolled back",
    );
  }
}
