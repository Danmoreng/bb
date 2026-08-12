import type { BbPluginApi } from "@bb/plugin-sdk";
import {
  domainEventSchema,
  type DomainEvent,
  type JsonValue,
} from "@bb-private/control-plane-domain";
import { z } from "zod";

type PluginDatabase = ReturnType<BbPluginApi["storage"]["database"]>;

const outboxRowSchema = z
  .object({
    id: z.string(),
    message_type: z.string(),
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
    ]),
    attempt_count: z.number().int().nonnegative(),
    next_attempt_at: z.number().int().nonnegative(),
    lease_until: z.number().int().nullable(),
    last_error: z.string().nullable(),
    version: z.number().int().min(1),
    created_at: z.number().int().nonnegative(),
    updated_at: z.number().int().nonnegative(),
  })
  .strict();

export type OutboxRow = z.infer<typeof outboxRowSchema>;

export interface OutboxMessage {
  id: string;
  messageType: string;
  aggregateType: string;
  aggregateId: string;
  correlationId: string;
  payload: JsonValue;
  idempotencyKey: string;
  now: number;
}

function row(value: unknown): OutboxRow {
  const parsed = outboxRowSchema.safeParse(value);
  if (!parsed.success)
    throw new Error(`Invalid outbox row: ${parsed.error.message}`);
  return parsed.data;
}

export function appendEventAndOutbox(
  db: PluginDatabase,
  event: DomainEvent,
  message: OutboxMessage,
): void {
  const parsedEvent = domainEventSchema.parse(event);
  const payloadJson = JSON.stringify(message.payload);
  db.transaction(() => {
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
    db.prepare(
      `INSERT INTO outbox
       (id, message_type, aggregate_type, aggregate_id, correlation_id, payload_json, idempotency_key, status, attempt_count, next_attempt_at, version, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, 1, ?, ?)`,
    ).run(
      message.id,
      message.messageType,
      message.aggregateType,
      message.aggregateId,
      message.correlationId,
      payloadJson,
      message.idempotencyKey,
      message.now,
      message.now,
      message.now,
    );
  })();
}

export function claimDueOutbox(
  db: PluginDatabase,
  input: { now: number; leaseUntil: number; limit?: number },
): OutboxRow[] {
  const limit = Math.max(1, Math.min(input.limit ?? 25, 100));
  return db.transaction(() => {
    const values = db
      .prepare(
        `SELECT * FROM outbox
         WHERE (status IN ('pending','failed') AND next_attempt_at <= ?)
            OR (status = 'processing' AND lease_until IS NOT NULL AND lease_until <= ?)
         ORDER BY next_attempt_at, created_at, id LIMIT ?`,
      )
      .all(input.now, input.now, limit)
      .map(row);
    for (const value of values) {
      db.prepare(
        "UPDATE outbox SET status = 'processing', lease_until = ?, attempt_count = attempt_count + 1, version = version + 1, updated_at = ? WHERE id = ? AND version = ?",
      ).run(input.leaseUntil, input.now, value.id, value.version);
    }
    return values.map((value) => ({
      ...value,
      status: "processing" as const,
      lease_until: input.leaseUntil,
      attempt_count: value.attempt_count + 1,
      version: value.version + 1,
      updated_at: input.now,
    }));
  })();
}

export function markOutboxDelivered(
  db: PluginDatabase,
  id: string,
  now: number,
): void {
  db.prepare(
    "UPDATE outbox SET status = 'delivered', lease_until = NULL, last_error = NULL, version = version + 1, updated_at = ? WHERE id = ? AND status = 'processing'",
  ).run(now, id);
}

export function markOutboxFailed(
  db: PluginDatabase,
  input: {
    id: string;
    now: number;
    nextAttemptAt: number;
    error: string;
    maxAttempts?: number;
  },
): void {
  const maxAttempts = input.maxAttempts ?? 5;
  const current = db.prepare("SELECT * FROM outbox WHERE id = ?").get(input.id);
  const parsed = row(current);
  const status = parsed.attempt_count >= maxAttempts ? "dead-letter" : "failed";
  db.prepare(
    "UPDATE outbox SET status = ?, lease_until = NULL, last_error = ?, next_attempt_at = ?, version = version + 1, updated_at = ? WHERE id = ? AND status = 'processing'",
  ).run(status, input.error, input.nextAttemptAt, input.now, input.id);
}

export function requeueDeadLetter(
  db: PluginDatabase,
  id: string,
  now: number,
): void {
  db.prepare(
    "UPDATE outbox SET status = 'pending', next_attempt_at = ?, lease_until = NULL, last_error = NULL, version = version + 1, updated_at = ? WHERE id = ? AND status = 'dead-letter'",
  ).run(now, now, id);
}
