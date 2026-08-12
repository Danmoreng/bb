import { describe, expect, it } from "vitest";
import {
  decisionRefIdSchema,
  aggregateVersionSchema,
  domainError,
  err,
  ok,
  projectControlIdSchema,
  VersionConflictError,
} from "../src/index.js";

describe("control-plane domain foundation", () => {
  it("validates opaque IDs without host-specific assumptions", () => {
    expect(projectControlIdSchema.parse("pc_123")).toBe("pc_123");
    expect(() => decisionRefIdSchema.parse(" ")).toThrow();
  });

  it("uses explicit Result values for expected domain outcomes", () => {
    expect(ok(42)).toEqual({ ok: true, value: 42 });
    expect(err(domainError("conflict", "stale version"))).toEqual({
      ok: false,
      error: { code: "conflict", message: "stale version", retryable: false },
    });
  });

  it("validates aggregate versions and exposes retryable conflicts", () => {
    expect(aggregateVersionSchema.parse(1)).toBe(1);
    expect(() => aggregateVersionSchema.parse(0)).toThrow();
    const error = new VersionConflictError({
      expectedVersion: 2,
      actualVersion: 3,
    });
    expect(error).toMatchObject({
      code: "version_conflict",
      retryable: true,
      expectedVersion: 2,
      actualVersion: 3,
    });
  });
});
