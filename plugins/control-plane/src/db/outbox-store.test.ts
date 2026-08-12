import { afterEach, describe, expect, it } from "vitest";
import { createFakePluginHost } from "@bb/plugin-sdk/testing";
import {
  appendEventAndOutbox,
  claimDueOutbox,
  listDeadLetterOutbox,
  listOutcomeUnknownOutbox,
  markOutboxDelivered,
  markOutboxFailed,
  reconcileUnknownOutbox,
  requeueDeadLetter,
  type OutboxClaim,
} from "./outbox-store.js";
import { initializeControlPlaneDatabase } from "./migrations.js";
import {
  assertExternalCallsOutsideTransaction,
  isInsideUnitOfWork,
  withUnitOfWork,
} from "./unit-of-work.js";

const hosts: Array<ReturnType<typeof createFakePluginHost>> = [];
afterEach(async () => {
  await Promise.all(hosts.splice(0).map((host) => host.harness.dispose()));
});

function database() {
  const host = createFakePluginHost({ pluginId: "control-plane" });
  hosts.push(host);
  const db = host.bb.storage.database();
  initializeControlPlaneDatabase(db, host.bb.storage.migrate);
  return db;
}

const event = {
  id: "evt_1",
  type: "project.initialized",
  version: 1,
  aggregateType: "control_project",
  aggregateId: "cpr_1",
  actor: "system",
  correlationId: "cor_1",
  payload: { projectId: "proj_1" },
  occurredAt: 1,
} as const;

const realtimeMessage = {
  id: "obx_1",
  messageType: "realtime.invalidate" as const,
  aggregateType: "control_project",
  aggregateId: "cpr_1",
  correlationId: "cor_1",
  payload: { projectId: "proj_1" },
  idempotencyKey: "invalidate:cpr_1:1",
  now: 1,
};

function claimOf(row: {
  id: string;
  version: number;
  lease_token: string | null;
}): OutboxClaim {
  if (!row.lease_token) throw new Error("test row has no lease token");
  return { id: row.id, version: row.version, leaseToken: row.lease_token };
}

describe("transactional outbox", () => {
  it("commits and claims a typed command once", () => {
    const db = database();
    appendEventAndOutbox(db, event, realtimeMessage);
    expect(
      db.prepare("SELECT count(*) AS count FROM domain_events").get(),
    ).toEqual({ count: 1 });
    const claimed = claimDueOutbox(db, {
      now: 1,
      leaseUntil: 10,
      leaseTokenFactory: () => "lease-1",
    });
    expect(claimed[0]).toMatchObject({
      id: "obx_1",
      status: "processing",
      attempt_count: 1,
      lease_token: "lease-1",
      delivery_kind: "retryable",
    });
    expect(claimDueOutbox(db, { now: 1, leaseUntil: 10 })).toHaveLength(0);
    markOutboxDelivered(db, { claim: claimOf(claimed[0]), now: 2 });
    expect(
      db.prepare("SELECT status FROM outbox WHERE id = 'obx_1'").get(),
    ).toEqual({ status: "delivered" });
  });

  it("infers reconciliation and stable key for side-effecting messages", () => {
    const db = database();
    appendEventAndOutbox(db, event, {
      id: "obx_task",
      messageType: "tasks.comment",
      aggregateType: event.aggregateType,
      aggregateId: event.aggregateId,
      correlationId: event.correlationId,
      payload: { taskId: "task_1", body: "hello" },
      idempotencyKey: "comment:task_1:1",
      now: 1,
    });
    expect(
      db
        .prepare(
          "SELECT delivery_kind, reconciliation_key FROM outbox WHERE id = 'obx_task'",
        )
        .get(),
    ).toEqual({
      delivery_kind: "reconcile-before-retry",
      reconciliation_key: "comment:task_1:1",
    });
    appendEventAndOutbox(
      db,
      { ...event, id: "evt_1b" },
      {
        id: "obx_inferred_key",
        messageType: "tasks.comment",
        aggregateType: event.aggregateType,
        aggregateId: event.aggregateId,
        correlationId: event.correlationId,
        payload: { taskId: "task_1", body: "hello" },
        idempotencyKey: "comment:task_1:2",
        now: 1,
      },
    );
    expect(
      db
        .prepare(
          "SELECT reconciliation_key FROM outbox WHERE id = 'obx_inferred_key'",
        )
        .get(),
    ).toEqual({ reconciliation_key: "comment:task_1:2" });
  });

  it("rolls back aggregate, event, and outbox on duplicate insertion", () => {
    const db = database();
    appendEventAndOutbox(db, event, realtimeMessage, () => {
      db.prepare(
        "INSERT INTO processed_events (source, external_key, handler_version, processed_at) VALUES ('test', 'aggregate-1', '1', 1)",
      ).run();
    });
    expect(() =>
      appendEventAndOutbox(
        db,
        { ...event, id: "evt_2" },
        { ...realtimeMessage, id: "obx_2" },
        () => {
          db.prepare(
            "INSERT INTO processed_events (source, external_key, handler_version, processed_at) VALUES ('test', 'aggregate-rollback', '1', 2)",
          ).run();
        },
      ),
    ).toThrow();
    expect(
      db
        .prepare(
          "SELECT count(*) AS count FROM processed_events WHERE external_key = 'aggregate-rollback'",
        )
        .get(),
    ).toEqual({ count: 0 });
    expect(
      db.prepare("SELECT count(*) AS count FROM domain_events").get(),
    ).toEqual({ count: 1 });
    expect(db.prepare("SELECT count(*) AS count FROM outbox").get()).toEqual({
      count: 1,
    });
  });

  it("rolls back append writes and observes a rejected promise from a normal callback", async () => {
    const db = database();
    const deferred = Promise.reject(new Error("late rejection"));
    expect(() =>
      appendEventAndOutbox(
        db,
        event,
        { ...realtimeMessage, id: "obx_deferred" },
        // @ts-expect-error Deliberately exercise the runtime boundary.
        () => {
          db.prepare(
            "INSERT INTO processed_events (source, external_key, handler_version, processed_at) VALUES ('test', 'deferred', '1', 1)",
          ).run();
          return deferred;
        },
      ),
    ).toThrow(/synchronous/i);
    expect(
      db.prepare("SELECT count(*) AS count FROM processed_events").get(),
    ).toEqual({ count: 0 });
    expect(
      db.prepare("SELECT count(*) AS count FROM domain_events").get(),
    ).toEqual({
      count: 0,
    });
    expect(db.prepare("SELECT count(*) AS count FROM outbox").get()).toEqual({
      count: 0,
    });
    await Promise.resolve();
  });

  it("rejects a declared async callback before invoking it and resets nested guards", () => {
    const db = database();
    let sideEffect = 0;
    const asyncWork = async (): Promise<void> => {
      sideEffect += 1;
      await Promise.resolve();
    };
    // @ts-expect-error Async callbacks are intentionally excluded at compile time.
    expect(() => withUnitOfWork(db, asyncWork)).toThrow(/not invoked/);
    expect(sideEffect).toBe(0);
    expect(isInsideUnitOfWork()).toBe(false);

    expect(() =>
      withUnitOfWork(db, () => {
        expect(isInsideUnitOfWork()).toBe(true);
        expect(() =>
          withUnitOfWork(db, () => {
            expect(isInsideUnitOfWork()).toBe(true);
            throw new Error("nested failure");
          }),
        ).toThrow("nested failure");
        expect(isInsideUnitOfWork()).toBe(true);
        assertExternalCallsOutsideTransaction();
      }),
    ).toThrow(/External SDK/);
    expect(isInsideUnitOfWork()).toBe(false);
  });

  it("rolls back a synchronously returned thenable", () => {
    const db = database();
    expect(() =>
      withUnitOfWork(db, () => {
        db.prepare(
          "INSERT INTO processed_events (source, external_key, handler_version, processed_at) VALUES ('test', 'thenable', '1', 1)",
        ).run();
        return { then: () => undefined };
      }),
    ).toThrow(/synchronous/);
    expect(
      db.prepare("SELECT count(*) AS count FROM processed_events").get(),
    ).toEqual({ count: 0 });
    expect(isInsideUnitOfWork()).toBe(false);
  });

  it("fences claims at exact lease expiry", () => {
    const db = database();
    appendEventAndOutbox(db, event, realtimeMessage);
    const first = claimDueOutbox(db, {
      now: 1,
      leaseUntil: 2,
      leaseTokenFactory: () => "lease-first",
    });
    expect(() =>
      markOutboxDelivered(db, { claim: claimOf(first[0]), now: 2 }),
    ).toThrow(/stale/i);
    const reclaimed = claimDueOutbox(db, {
      now: 2,
      leaseUntil: 4,
      leaseTokenFactory: () => "lease-second",
    });
    markOutboxDelivered(db, { claim: claimOf(reclaimed[0]), now: 3 });
  });

  it("quarantines uncertain expired side effects and requires explicit reconciliation", () => {
    const db = database();
    appendEventAndOutbox(db, event, {
      id: "obx_unknown",
      messageType: "thread.send",
      aggregateType: event.aggregateType,
      aggregateId: event.aggregateId,
      correlationId: event.correlationId,
      payload: { threadId: "thread_1", body: "hello" },
      idempotencyKey: "thread:thread_1:1",
      now: 1,
    });
    const claimed = claimDueOutbox(db, {
      now: 1,
      leaseUntil: 2,
      leaseTokenFactory: () => "lease-unknown",
    });
    expect(claimDueOutbox(db, { now: 2, leaseUntil: 3 })).toEqual([]);
    expect(listOutcomeUnknownOutbox(db)).toHaveLength(1);
    expect(() =>
      reconcileUnknownOutbox(db, {
        id: claimed[0].id,
        now: 3,
        outcome: "remote-applied",
        evidence: "remote id lookup confirmed acceptance",
      }),
    ).not.toThrow();
    expect(claimDueOutbox(db, { now: 4, leaseUntil: 5 })).toEqual([]);
    expect(
      db
        .prepare(
          "SELECT outcome, reconciliation_key, evidence FROM outbox_reconciliation_evidence",
        )
        .all(),
    ).toEqual([
      {
        outcome: "remote-applied",
        reconciliation_key: "thread:thread_1:1",
        evidence: "remote id lookup confirmed acceptance",
      },
    ]);
    expect(() =>
      db
        .prepare(
          "UPDATE outbox_reconciliation_evidence SET evidence = 'changed'",
        )
        .run(),
    ).toThrow(/append-only/i);
    expect(() =>
      db.prepare("DELETE FROM outbox_reconciliation_evidence").run(),
    ).toThrow(/forbidden/i);
  });

  it("survives a host reload without sending an uncertain side effect twice", async () => {
    const firstHost = createFakePluginHost({ pluginId: "control-plane" });
    hosts.push(firstHost);
    const firstDb = firstHost.bb.storage.database();
    initializeControlPlaneDatabase(firstDb, firstHost.bb.storage.migrate);
    appendEventAndOutbox(firstDb, event, {
      id: "obx_reload",
      messageType: "tasks.comment",
      aggregateType: event.aggregateType,
      aggregateId: event.aggregateId,
      correlationId: event.correlationId,
      payload: { taskId: "task_reload", body: "accepted remotely" },
      idempotencyKey: "comment:task_reload:1",
      now: 1,
    });
    claimDueOutbox(firstDb, {
      now: 1,
      leaseUntil: 2,
      leaseTokenFactory: () => "lease-reload",
    });

    const replacement = await firstHost.harness.lifecycle.reload((bb) => {
      const db = bb.storage.database();
      initializeControlPlaneDatabase(db, bb.storage.migrate);
      expect(claimDueOutbox(db, { now: 2, leaseUntil: 3 })).toEqual([]);
      expect(listOutcomeUnknownOutbox(db)).toHaveLength(1);
    });
    hosts.push(replacement);
    const replacementDb = replacement.bb.storage.database();
    expect(
      reconcileUnknownOutbox(replacementDb, {
        id: "obx_reload",
        now: 3,
        outcome: "remote-applied",
        evidence: "remote accepted the idempotency key",
      }).status,
    ).toBe("delivered");
    expect(claimDueOutbox(replacementDb, { now: 4, leaseUntil: 5 })).toEqual(
      [],
    );
  });

  it("derives retry policy and requires an explicit transport outcome", () => {
    const db = database();
    appendEventAndOutbox(db, event, {
      ...realtimeMessage,
      id: "obx_failed",
      idempotencyKey: "failed",
    });
    const claimed = claimDueOutbox(db, {
      now: 1,
      leaseUntil: 10,
      leaseTokenFactory: () => "lease-failed",
    });
    expect(
      markOutboxFailed(db, {
        claim: claimOf(claimed[0]),
        now: 2,
        nextAttemptAt: 3,
        error: "timeout",
        transportOutcome: "definite-failure",
      }).status,
    ).toBe("failed");
  });

  it("dead-letters malformed payloads and supports bounded outcome/dead-letter listings", () => {
    const db = database();
    db.prepare(
      "INSERT INTO outbox (id, message_type, aggregate_type, aggregate_id, correlation_id, payload_json, idempotency_key, status, delivery_kind, reconciliation_key, attempt_count, next_attempt_at, version, created_at, updated_at) VALUES ('poison', 'tasks.comment', 'control_project', 'cpr_1', 'cor_1', ?, 'poison-key', 'pending', 'reconcile-before-retry', 'poison-key', 0, 1, 1, 1, 1)",
    ).run(JSON.stringify({ version: 1, taskId: "missing-body" }));
    expect(claimDueOutbox(db, { now: 1, leaseUntil: 2 })).toEqual([]);
    expect(listDeadLetterOutbox(db, 1)).toHaveLength(1);
  });

  it("retries an unknown outcome for an idempotent realtime invalidation", () => {
    const db = database();
    appendEventAndOutbox(db, event, {
      ...realtimeMessage,
      id: "obx_realtime_unknown",
      idempotencyKey: "realtime-unknown",
    });
    const claimed = claimDueOutbox(db, {
      now: 1,
      leaseUntil: 3,
      leaseTokenFactory: () => "lease-realtime-unknown",
    });
    expect(
      markOutboxFailed(db, {
        claim: claimOf(claimed[0]),
        now: 2,
        nextAttemptAt: 3,
        error: "connection closed without a response",
        transportOutcome: "unknown",
      }).status,
    ).toBe("failed");
  });

  it("records operator evidence when requeueing retryable and reconciled dead letters", () => {
    const db = database();
    appendEventAndOutbox(db, event, {
      ...realtimeMessage,
      id: "obx_dead",
      idempotencyKey: "dead",
    });
    const claimed = claimDueOutbox(db, {
      now: 1,
      leaseUntil: 2,
      leaseTokenFactory: () => "lease-dead",
    });
    expect(
      markOutboxFailed(db, {
        claim: claimOf(claimed[0]),
        now: 1,
        nextAttemptAt: 2,
        error: "invalid target",
        maxAttempts: 1,
        transportOutcome: "definite-failure",
      }).status,
    ).toBe("dead-letter");
    expect(
      requeueDeadLetter(db, "obx_dead", 2, "operator confirmed safe retry")
        .status,
    ).toBe("pending");
    appendEventAndOutbox(
      db,
      { ...event, id: "evt_side_effect" },
      {
        id: "obx_side_effect_dead",
        messageType: "tasks.comment",
        aggregateType: event.aggregateType,
        aggregateId: event.aggregateId,
        correlationId: event.correlationId,
        payload: { taskId: "task_1", body: "hello" },
        idempotencyKey: "comment:task_1:dead",
        now: 2,
      },
    );
    let leaseSequence = 0;
    const sideEffectClaim = claimDueOutbox(db, {
      now: 2,
      leaseUntil: 4,
      leaseTokenFactory: () => `lease-side-effect-dead-${leaseSequence++}`,
    }).find((row) => row.id === "obx_side_effect_dead");
    if (!sideEffectClaim)
      throw new Error("side-effect message was not claimed");
    expect(
      markOutboxFailed(db, {
        claim: claimOf(sideEffectClaim),
        now: 3,
        nextAttemptAt: 4,
        error: "remote definitively rejected the request",
        maxAttempts: 1,
        transportOutcome: "definite-failure",
      }).status,
    ).toBe("dead-letter");
    expect(
      requeueDeadLetter(
        db,
        "obx_side_effect_dead",
        4,
        "operator corrected the target and approved redelivery",
      ).status,
    ).toBe("pending");
    expect(
      db
        .prepare(
          "SELECT outcome, reconciliation_key, evidence FROM outbox_reconciliation_evidence ORDER BY created_at, id",
        )
        .all(),
    ).toEqual([
      {
        outcome: "operator-requeue",
        reconciliation_key: "dead",
        evidence: "operator confirmed safe retry",
      },
      {
        outcome: "operator-requeue",
        reconciliation_key: "comment:task_1:dead",
        evidence: "operator corrected the target and approved redelivery",
      },
    ]);
  });
});
