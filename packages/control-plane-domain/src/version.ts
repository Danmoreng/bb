import { z } from "zod";

export const aggregateVersionSchema = z.number().int().min(1);
export type AggregateVersion = z.infer<typeof aggregateVersionSchema>;

export class VersionConflictError extends Error {
  readonly code = "version_conflict";
  readonly retryable = true;
  readonly expectedVersion: number;
  readonly actualVersion: number | null;

  constructor(input: {
    expectedVersion: number;
    actualVersion: number | null;
  }) {
    super(
      input.actualVersion === null
        ? "The aggregate no longer exists. Reload before retrying."
        : `Expected aggregate version ${input.expectedVersion}, but found ${input.actualVersion}. Reload before retrying.`,
    );
    this.name = "VersionConflictError";
    this.expectedVersion = input.expectedVersion;
    this.actualVersion = input.actualVersion;
  }
}
