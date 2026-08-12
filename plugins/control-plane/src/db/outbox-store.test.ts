import { afterEach, describe, expect, it } from "vitest";
import { createFakePluginHost } from "@bb/plugin-sdk/testing";
import {
  appendEventAndOutbox,
  claimDueOutbox,
  markOutboxDelivered,
  markOutboxFailed,
  requeueDeadLetter,
} from "./outbox-store.js";
import { initializeControlPlaneDatabase } from "./migrations.js";

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

describe("transactional outbox", () => {
  it("commits a compact event and outbox command atomically and claims it once", () => {
    const db = database();
    appendEventAndOutbox(db, event, {
      id: "obx_1",
      messageType: "realtime.invalidate",
      aggregateType: "control_project",
      aggregateId: "cpr_1",
      correlationId: "cor_1",
      payload: { projectId: "proj_1" },
      idempotencyKey: "invalidate:cpr_1:1",
      now: 1,
    });
    expect(
      db.prepare("SELECT count(*) AS count FROM domain_events").get(),
    ).toEqual({ count: 1 });
    const claimed = claimDueOutbox(db, { now: 1, leaseUntil: 10 });
    expect(claimed).toHaveLength(1);
    expect(claimed[0]).toMatchObject({
      id: "obx_1",
      status: "processing",
      attempt_count: 1,
    });
    expect(claimDueOutbox(db, { now: 1, leaseUntil: 10 })).toHaveLength(0);
    markOutboxDelivered(db, "obx_1", 2);
    expect(
      db.prepare("SELECT status FROM outbox WHERE id = 'obx_1'").get(),
    ).toEqual({ status: "delivered" });
  });

  it("moves exhausted deliveries to dead letter and permits explicit requeue", () => {
    const db = database();
    appendEventAndOutbox(db, event, {
      id: "obx_2",
      messageType: "tasks.comment",
      aggregateType: "task",
      aggregateId: "task_1",
      correlationId: "cor_2",
      payload: { body: "hello" },
      idempotencyKey: "comment:task_1:1",
      now: 1,
    });
    claimDueOutbox(db, { now: 1, leaseUntil: 2 });
    markOutboxFailed(db, {
      id: "obx_2",
      now: 3,
      nextAttemptAt: 4,
      error: "offline",
      maxAttempts: 1,
    });
    expect(
      db.prepare("SELECT status FROM outbox WHERE id = 'obx_2'").get(),
    ).toEqual({ status: "dead-letter" });
    requeueDeadLetter(db, "obx_2", 5);
    expect(
      db
        .prepare(
          "SELECT status, next_attempt_at FROM outbox WHERE id = 'obx_2'",
        )
        .get(),
    ).toEqual({ status: "pending", next_attempt_at: 5 });
  });

  it("rejects duplicate idempotency keys without duplicating the event", () => {
    const db = database();
    const message = {
      id: "obx_3",
      messageType: "realtime.invalidate",
      aggregateType: "control_project",
      aggregateId: "cpr_1",
      correlationId: "cor_3",
      payload: { projectId: "proj_1" },
      idempotencyKey: "same-key",
      now: 1,
    } as const;
    appendEventAndOutbox(db, event, message);
    expect(() =>
      appendEventAndOutbox(
        db,
        { ...event, id: "evt_2" },
        { ...message, id: "obx_4" },
      ),
    ).toThrow();
    expect(
      db.prepare("SELECT count(*) AS count FROM domain_events").get(),
    ).toEqual({ count: 1 });
    expect(db.prepare("SELECT count(*) AS count FROM outbox").get()).toEqual({
      count: 1,
    });
  });
});
