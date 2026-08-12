import { randomUUID } from "node:crypto";
import type { BbPluginApi } from "@bb/plugin-sdk";
import {
  domainEventSchema,
  type DomainEvent,
} from "@bb-private/control-plane-domain";
import { z } from "zod";
import {
  assertSynchronousCallback,
  assertSynchronousResult,
  withUnitOfWork,
} from "./unit-of-work.js";

type PluginDatabase = ReturnType<BbPluginApi["storage"]["database"]>;

const MAX_PAYLOAD_BYTES = 256 * 1024;
const MAX_ERROR_BYTES = 16 * 1024;
const messageVersionSchema = z.literal(1);
const realtimeInvalidatePayloadSchema = z
  .object({ version: messageVersionSchema, projectId: z.string().min(1) })
  .strict();
const taskCommentPayloadSchema = z
  .object({
    version: messageVersionSchema,
    taskId: z.string().min(1),
    body: z.string().min(1),
  })
  .strict();
const threadSendPayloadSchema = z
  .object({
    version: messageVersionSchema,
    threadId: z.string().min(1),
    body: z.string().min(1),
  })
  .strict();

const typedMessageSchema = z.discriminatedUnion("messageType", [
  z.object({
    messageType: z.literal("realtime.invalidate"),
    messageVersion: messageVersionSchema,
    payload: realtimeInvalidatePayloadSchema,
  }),
  z.object({
    messageType: z.literal("tasks.comment"),
    messageVersion: messageVersionSchema,
    payload: taskCommentPayloadSchema,
  }),
  z.object({
    messageType: z.literal("thread.send"),
    messageVersion: messageVersionSchema,
    payload: threadSendPayloadSchema,
  }),
]);

const outboxRowSchema = z
  .object({
    id: z.string(),
    message_type: z.string().min(1),
    aggregate_type: z.string(),
    aggregate_id: z.string(),
    correlation_id: z.string(),
    payload_json: z.string(),
    idempotency_key: z.string(),
    status: z.enum([
      "pending",
      "processing",
      "delivered",
      "failed",
      "dead-letter",
      "outcome-unknown",
    ]),
    delivery_kind: z.enum([
      "retryable",
      "reconcile-before-retry",
      "non-retryable",
    ]),
    reconciliation_key: z.string().nullable(),
    attempt_count: z.number().int().nonnegative(),
    next_attempt_at: z.number().int().nonnegative(),
    lease_until: z.number().int().nullable(),
    lease_token: z.string().nullable(),
    last_error: z.string().nullable(),
    version: z.number().int().min(1),
    created_at: z.number().int().nonnegative(),
    updated_at: z.number().int().nonnegative(),
  })
  .strict();

export type OutboxRow = z.infer<typeof outboxRowSchema>;
export type OutboxMessageType = z.infer<
  typeof typedMessageSchema
>["messageType"];
export type OutboxDeliveryKind = OutboxRow["delivery_kind"];

type OutboxMessageBase = {
  id: string;
  aggregateType: string;
  aggregateId: string;
  correlationId: string;
  idempotencyKey: string;
  now: number;
};

/**
 * Delivery policy is a property of the message type, never caller input.
 * Payload versions are filled at this boundary so callers can use the typed
 * version-one payload without repeating protocol bookkeeping.
 */
export type OutboxMessage =
  | (OutboxMessageBase & {
      messageType: "realtime.invalidate";
      payload: { projectId: string };
    })
  | (OutboxMessageBase & {
      messageType: "tasks.comment";
      payload: { taskId: string; body: string };
    })
  | (OutboxMessageBase & {
      messageType: "thread.send";
      payload: { threadId: string; body: string };
    });

export interface OutboxClaim {
  id: string;
  version: number;
  leaseToken: string;
}

export class StaleOutboxClaimError extends Error {
  readonly code = "stale_outbox_claim";
  readonly retryable = false;

  constructor(claim: OutboxClaim) {
    super(`Outbox claim for ${claim.id} is stale or no longer owned`);
    this.name = "StaleOutboxClaimError";
  }
}

export class OutboxStateError extends Error {
  readonly code = "invalid_outbox_state";
  readonly retryable = false;

  constructor(message: string) {
    super(message);
    this.name = "OutboxStateError";
  }
}

function row(value: unknown): OutboxRow {
  const parsed = outboxRowSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error(`Invalid outbox row: ${parsed.error.message}`);
  }
  return parsed.data;
}

function integer(value: number, name: string, minimum = 0): void {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new RangeError(`${name} must be an integer >= ${minimum}`);
  }
}

function text(value: string, name: string, maxBytes: number): void {
  if (value.length === 0 || Buffer.byteLength(value, "utf8") > maxBytes) {
    throw new RangeError(
      `${name} must be non-empty and at most ${maxBytes} bytes`,
    );
  }
}

function validateClaim(claim: OutboxClaim): void {
  text(claim.id, "claim.id", 512);
  integer(claim.version, "claim.version", 1);
  text(claim.leaseToken, "claim.leaseToken", 1024);
}

function defaultDeliveryKind(
  messageType: OutboxMessageType,
): OutboxDeliveryKind {
  return messageType === "tasks.comment" || messageType === "thread.send"
    ? "reconcile-before-retry"
    : "retryable";
}

function normalizeMessage(message: OutboxMessage) {
  integer(message.now, "message.now");
  text(message.id, "message.id", 512);
  text(message.idempotencyKey, "message.idempotencyKey", 1024);
  text(message.aggregateType, "message.aggregateType", 512);
  text(message.aggregateId, "message.aggregateId", 512);
  text(message.correlationId, "message.correlationId", 512);

  const payload = z.record(z.string(), z.json()).safeParse(message.payload);
  if (!payload.success) {
    throw new TypeError("Outbox payload must be a JSON object");
  }
  const payloadObject = payload.data;
  if ("version" in payloadObject && payloadObject.version !== 1) {
    throw new TypeError("Unsupported outbox message version");
  }
  const typed = typedMessageSchema.parse({
    messageType: message.messageType,
    messageVersion: 1,
    payload: { ...payloadObject, version: 1 },
  });
  const payloadJson = JSON.stringify(typed.payload);
  if (Buffer.byteLength(payloadJson, "utf8") > MAX_PAYLOAD_BYTES) {
    throw new RangeError(`Outbox payload exceeds ${MAX_PAYLOAD_BYTES} bytes`);
  }

  const deliveryKind = defaultDeliveryKind(message.messageType);
  const reconciliationKey =
    deliveryKind === "reconcile-before-retry" ? message.idempotencyKey : null;
  if (reconciliationKey !== null) {
    text(reconciliationKey, "reconciliationKey", 1024);
  }

  return {
    ...message,
    deliveryKind,
    reconciliationKey,
    payloadJson,
    typed,
  };
}

function parsePersistedPayload(value: OutboxRow): boolean {
  if (Buffer.byteLength(value.payload_json, "utf8") > MAX_PAYLOAD_BYTES) {
    return false;
  }
  let payload: unknown;
  try {
    payload = JSON.parse(value.payload_json);
  } catch {
    return false;
  }
  return typedMessageSchema.safeParse({
    messageType: value.message_type,
    messageVersion: 1,
    payload,
  }).success;
}

function recordReconciliationEvidence(
  db: PluginDatabase,
  input: {
    outboxId: string;
    reconciliationKey: string;
    outcome: "remote-applied" | "remote-not-applied" | "operator-requeue";
    evidence: string;
    createdAt: number;
  },
): void {
  db.prepare(
    `INSERT INTO outbox_reconciliation_evidence
     (id, outbox_id, reconciliation_key, outcome, evidence, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    randomUUID(),
    input.outboxId,
    input.reconciliationKey,
    input.outcome,
    input.evidence,
    input.createdAt,
  );
}

function quarantineMalformed(
  db: PluginDatabase,
  value: OutboxRow,
  now: number,
): void {
  db.prepare(
    `UPDATE outbox SET status = 'dead-letter', lease_until = NULL,
     lease_token = NULL, last_error = ?, version = version + 1,
     updated_at = ? WHERE id = ? AND version = ?`,
  ).run(
    `Malformed persisted ${value.message_type} payload; delivery refused`,
    now,
    value.id,
    value.version,
  );
}

/**
 * Append one event and one or more typed delivery messages in the same local
 * transaction. The aggregate callback is synchronous; external delivery is
 * always performed after this function returns.
 */
export function appendEventAndOutbox(
  db: PluginDatabase,
  event: DomainEvent,
  messages: OutboxMessage | readonly OutboxMessage[],
  writeAggregate?: () => void | undefined,
): void {
  const parsedEvent = domainEventSchema.parse(event);
  integer(parsedEvent.occurredAt, "event.occurredAt");
  if (writeAggregate) assertSynchronousCallback(writeAggregate);
  const normalizedMessages = (
    Array.isArray(messages) ? messages : [messages]
  ).map(normalizeMessage);
  if (normalizedMessages.length === 0) {
    throw new TypeError("At least one outbox message is required");
  }
  for (const message of normalizedMessages) {
    if (
      message.aggregateType !== parsedEvent.aggregateType ||
      message.aggregateId !== parsedEvent.aggregateId ||
      message.correlationId !== parsedEvent.correlationId
    ) {
      throw new TypeError(
        "Event and outbox message aggregate/correlation causality must match",
      );
    }
  }

  withUnitOfWork(db, () => {
    const aggregateResult = writeAggregate?.();
    assertSynchronousResult(aggregateResult);
    db.prepare(
      `INSERT INTO domain_events
       (id, event_type, event_version, aggregate_type, aggregate_id, actor, correlation_id, payload_json, occurred_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      parsedEvent.id,
      parsedEvent.type,
      parsedEvent.version,
      parsedEvent.aggregateType,
      parsedEvent.aggregateId,
      parsedEvent.actor,
      parsedEvent.correlationId,
      JSON.stringify(parsedEvent.payload),
      parsedEvent.occurredAt,
    );
    const insert = db.prepare(
      `INSERT INTO outbox
       (id, message_type, aggregate_type, aggregate_id, correlation_id, payload_json, idempotency_key, status, delivery_kind, reconciliation_key, attempt_count, next_attempt_at, version, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, 0, ?, 1, ?, ?)`,
    );
    for (const message of normalizedMessages) {
      insert.run(
        message.id,
        message.typed.messageType,
        message.aggregateType,
        message.aggregateId,
        message.correlationId,
        message.payloadJson,
        message.idempotencyKey,
        message.deliveryKind,
        message.reconciliationKey,
        message.now,
        message.now,
        message.now,
      );
    }
  });
}

export function claimDueOutbox(
  db: PluginDatabase,
  input: {
    now: number;
    leaseUntil: number;
    limit?: number;
    leaseTokenFactory?: () => string;
  },
): OutboxRow[] {
  integer(input.now, "now");
  integer(input.leaseUntil, "leaseUntil");
  if (input.leaseUntil <= input.now) {
    throw new RangeError("leaseUntil must be greater than now");
  }
  const limit = Math.max(1, Math.min(input.limit ?? 25, 100));
  const makeToken = input.leaseTokenFactory ?? randomUUID;
  return withUnitOfWork(db, () => {
    const expired = db
      .prepare(
        "SELECT * FROM outbox WHERE status = 'processing' AND lease_until IS NOT NULL AND lease_until <= ? ORDER BY id",
      )
      .all(input.now)
      .map(row);
    for (const value of expired) {
      if (value.delivery_kind === "retryable") {
        db.prepare(
          `UPDATE outbox SET status = 'pending', lease_until = NULL, lease_token = NULL,
           version = version + 1, updated_at = ? WHERE id = ? AND status = 'processing' AND version = ?`,
        ).run(input.now, value.id, value.version);
      } else {
        const status =
          value.delivery_kind === "reconcile-before-retry" &&
          value.reconciliation_key
            ? "outcome-unknown"
            : "dead-letter";
        const error =
          value.delivery_kind === "reconcile-before-retry" &&
          value.reconciliation_key
            ? "Lease expired before transport outcome was known; reconciliation required"
            : "Lease expired for a non-retryable or unreconcilable delivery";
        db.prepare(
          `UPDATE outbox SET status = ?, lease_until = NULL, lease_token = NULL,
           last_error = ?, version = version + 1, updated_at = ?
           WHERE id = ? AND status = 'processing' AND version = ?`,
        ).run(status, error, input.now, value.id, value.version);
      }
    }

    const candidates = db
      .prepare(
        `SELECT * FROM outbox
       WHERE status IN ('pending','failed') AND next_attempt_at <= ?
       ORDER BY next_attempt_at, created_at, id LIMIT ?`,
      )
      .all(input.now, limit)
      .map(row);
    const claimed: OutboxRow[] = [];
    for (const candidate of candidates) {
      if (!parsePersistedPayload(candidate)) {
        quarantineMalformed(db, candidate, input.now);
        continue;
      }
      const leaseToken = makeToken();
      text(leaseToken, "leaseToken", 1024);
      if (
        claimed.some((value) => value.lease_token === leaseToken) ||
        db
          .prepare("SELECT 1 FROM outbox WHERE lease_token = ? LIMIT 1")
          .get(leaseToken) !== undefined
      ) {
        throw new OutboxStateError(
          "Lease tokens must be unique per claim batch",
        );
      }
      const result = db
        .prepare(
          `UPDATE outbox
         SET status = 'processing', lease_until = ?, lease_token = ?,
             attempt_count = attempt_count + 1, version = version + 1, updated_at = ?
         WHERE id = ? AND version = ? AND status IN ('pending','failed') AND next_attempt_at <= ?`,
        )
        .run(
          input.leaseUntil,
          leaseToken,
          input.now,
          candidate.id,
          candidate.version,
          input.now,
        );
      if (result.changes === 0) continue;
      claimed.push(
        row(db.prepare("SELECT * FROM outbox WHERE id = ?").get(candidate.id)),
      );
    }
    return claimed;
  });
}

export function markOutboxDelivered(
  db: PluginDatabase,
  input: { claim: OutboxClaim; now: number },
): OutboxRow {
  integer(input.now, "now");
  validateClaim(input.claim);
  return withUnitOfWork(db, () => {
    const result = db
      .prepare(
        `UPDATE outbox SET status = 'delivered', lease_until = NULL,
       lease_token = NULL, last_error = NULL, version = version + 1,
       updated_at = ? WHERE id = ? AND status = 'processing' AND version = ?
       AND lease_token = ? AND lease_until > ?`,
      )
      .run(
        input.now,
        input.claim.id,
        input.claim.version,
        input.claim.leaseToken,
        input.now,
      );
    if (result.changes !== 1) throw new StaleOutboxClaimError(input.claim);
    return row(
      db.prepare("SELECT * FROM outbox WHERE id = ?").get(input.claim.id),
    );
  });
}

export function markOutboxFailed(
  db: PluginDatabase,
  input: {
    claim: OutboxClaim;
    now: number;
    nextAttemptAt: number;
    error: string;
    maxAttempts?: number;
    transportOutcome: "definite-failure" | "unknown";
  },
): OutboxRow {
  integer(input.now, "now");
  integer(input.nextAttemptAt, "nextAttemptAt", input.now);
  validateClaim(input.claim);
  const maxAttempts = input.maxAttempts ?? 5;
  integer(maxAttempts, "maxAttempts", 1);
  text(input.error, "error", MAX_ERROR_BYTES);
  if (
    input.transportOutcome !== "definite-failure" &&
    input.transportOutcome !== "unknown"
  ) {
    throw new TypeError("transportOutcome must be definite-failure or unknown");
  }
  return withUnitOfWork(db, () => {
    const currentValue = db
      .prepare("SELECT * FROM outbox WHERE id = ?")
      .get(input.claim.id);
    if (currentValue === undefined)
      throw new StaleOutboxClaimError(input.claim);
    const current = row(currentValue);
    const requiresReconciliation =
      input.transportOutcome === "unknown" &&
      current.delivery_kind === "reconcile-before-retry" &&
      current.reconciliation_key !== null;
    const status = requiresReconciliation
      ? "outcome-unknown"
      : current.delivery_kind === "non-retryable" ||
          current.attempt_count >= maxAttempts
        ? "dead-letter"
        : "failed";
    const result = db
      .prepare(
        `UPDATE outbox SET status = ?, lease_until = NULL, lease_token = NULL,
       last_error = ?, next_attempt_at = ?, version = version + 1,
       updated_at = ? WHERE id = ? AND status = 'processing' AND version = ?
       AND lease_token = ? AND lease_until > ?`,
      )
      .run(
        status,
        input.error,
        input.nextAttemptAt,
        input.now,
        input.claim.id,
        input.claim.version,
        input.claim.leaseToken,
        input.now,
      );
    if (result.changes !== 1) throw new StaleOutboxClaimError(input.claim);
    return row(
      db.prepare("SELECT * FROM outbox WHERE id = ?").get(input.claim.id),
    );
  });
}

export type UnknownOutboxOutcome = "remote-applied" | "remote-not-applied";

export function reconcileUnknownOutbox(
  db: PluginDatabase,
  input: {
    id: string;
    now: number;
    outcome: UnknownOutboxOutcome;
    evidence: string;
    nextAttemptAt?: number;
  },
): OutboxRow {
  integer(input.now, "now");
  text(input.evidence, "evidence", MAX_ERROR_BYTES);
  return withUnitOfWork(db, () => {
    const current = row(
      db.prepare("SELECT * FROM outbox WHERE id = ?").get(input.id),
    );
    if (current.status !== "outcome-unknown") {
      throw new OutboxStateError(
        "Only outcome-unknown messages can be reconciled",
      );
    }
    if (!current.reconciliation_key) {
      throw new OutboxStateError(
        "Reconciliation requires a stored reconciliation key",
      );
    }
    const nextAttemptAt = input.nextAttemptAt ?? input.now;
    integer(nextAttemptAt, "nextAttemptAt", input.now);
    const status = input.outcome === "remote-applied" ? "delivered" : "pending";
    recordReconciliationEvidence(db, {
      outboxId: current.id,
      reconciliationKey: current.reconciliation_key,
      outcome: input.outcome,
      evidence: input.evidence,
      createdAt: input.now,
    });
    const result = db
      .prepare(
        `UPDATE outbox SET status = ?, last_error = ?, next_attempt_at = ?,
       lease_until = NULL, lease_token = NULL, version = version + 1, updated_at = ?
       WHERE id = ? AND status = 'outcome-unknown' AND version = ?`,
      )
      .run(
        status,
        input.evidence,
        nextAttemptAt,
        input.now,
        input.id,
        current.version,
      );
    if (result.changes !== 1)
      throw new OutboxStateError(
        "Outbox outcome changed before reconciliation",
      );
    return row(db.prepare("SELECT * FROM outbox WHERE id = ?").get(input.id));
  });
}

export function listOutcomeUnknownOutbox(
  db: PluginDatabase,
  limit = 100,
): OutboxRow[] {
  const bounded = Math.max(1, Math.min(limit, 200));
  return db
    .prepare(
      "SELECT * FROM outbox WHERE status = 'outcome-unknown' ORDER BY updated_at DESC, id DESC LIMIT ?",
    )
    .all(bounded)
    .map(row);
}

export function listDeadLetterOutbox(
  db: PluginDatabase,
  limit = 100,
): OutboxRow[] {
  const bounded = Math.max(1, Math.min(limit, 200));
  return db
    .prepare(
      "SELECT * FROM outbox WHERE status = 'dead-letter' ORDER BY updated_at DESC, id DESC LIMIT ?",
    )
    .all(bounded)
    .map(row);
}

export function requeueDeadLetter(
  db: PluginDatabase,
  id: string,
  now: number,
  evidence: string,
): OutboxRow {
  integer(now, "now");
  text(evidence, "evidence", MAX_ERROR_BYTES);
  return withUnitOfWork(db, () => {
    const current = row(
      db.prepare("SELECT * FROM outbox WHERE id = ?").get(id),
    );
    if (current.status !== "dead-letter") {
      throw new OutboxStateError(
        "Only dead-letter outbox rows can be requeued",
      );
    }
    if (current.delivery_kind === "non-retryable") {
      throw new OutboxStateError(
        "Non-retryable dead letters cannot be requeued",
      );
    }
    recordReconciliationEvidence(db, {
      outboxId: current.id,
      reconciliationKey: current.reconciliation_key ?? current.idempotency_key,
      outcome: "operator-requeue",
      evidence,
      createdAt: now,
    });
    const result = db
      .prepare(
        `UPDATE outbox SET status = 'pending', next_attempt_at = ?,
       lease_until = NULL, lease_token = NULL, last_error = ?,
       version = version + 1, updated_at = ?
       WHERE id = ? AND status = 'dead-letter' AND version = ?`,
      )
      .run(now, evidence, now, id, current.version);
    if (result.changes !== 1)
      throw new OutboxStateError("Outbox state changed before requeue");
    return row(db.prepare("SELECT * FROM outbox WHERE id = ?").get(id));
  });
}
