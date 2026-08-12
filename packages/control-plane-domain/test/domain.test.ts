import { describe, expect, it } from "vitest";
import {
  decisionRefIdSchema,
  domainError,
  err,
  ok,
  projectControlIdSchema,
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
});
