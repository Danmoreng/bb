import { z } from "zod";

export const jsonValueSchema = z.json();
export type JsonValue = z.infer<typeof jsonValueSchema>;

export const domainEventSchema = z
  .object({
    id: z.string().min(1),
    type: z.string().min(1),
    version: z.number().int().min(1),
    aggregateType: z.string().min(1),
    aggregateId: z.string().min(1),
    actor: z.string().min(1),
    correlationId: z.string().min(1),
    payload: jsonValueSchema,
    occurredAt: z.number().int().nonnegative(),
  })
  .strict();
export type DomainEvent = z.infer<typeof domainEventSchema>;

export interface DomainEventFactory {
  create(input: Omit<DomainEvent, "id">): DomainEvent;
}
