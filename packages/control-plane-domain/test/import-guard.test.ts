import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.ts$/u.test(entry.name) ? [path] : [];
  });
}

describe("domain import boundary", () => {
  it("does not import bb, React, SQLite, Hono, or host modules", () => {
    const root = join(import.meta.dirname, "..", "src");
    const forbidden = /(?:@bb\/|react|sqlite|better-sqlite|hono|node:)/u;
    for (const file of sourceFiles(root)) {
      expect(readFileSync(file, "utf8")).not.toMatch(forbidden);
    }
  });
});
