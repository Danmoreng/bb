#!/usr/bin/env node

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const root = resolve(new URL("../..", import.meta.url).pathname);
const violations = [];

function filesUnder(directory) {
  if (!existsSync(directory)) return [];
  const result = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.name === "node_modules" || entry.name === "dist" || entry.name === ".turbo") continue;
    if (entry.isDirectory()) result.push(...filesUnder(path));
    else if (/\.(?:ts|tsx|js|mjs|cjs)$/u.test(entry.name)) result.push(path);
  }
  return result;
}

function check(directory, patterns, label) {
  for (const file of filesUnder(directory)) {
    const source = readFileSync(file, "utf8");
    for (const pattern of patterns) {
      if (pattern.test(source)) {
        violations.push(`${label}: ${relative(root, file)} matches ${pattern}`);
      }
    }
  }
}

check(join(root, "packages/control-plane-domain"), [
  /@bb\//u,
  /from\s+["'](?:react|hono|better-sqlite3|@libsql\/client)/u,
  /(?:sqlite|node:sqlite)/u,
], "domain import boundary");
check(join(root, "plugins/control-plane"), [
  /bb\.db/u,
  /plugins[\\/]tasks/u,
  /node:fs/u,
], "production plugin boundary");

if (violations.length > 0) {
  console.error("Control Plane architecture guard failed:");
  for (const violation of violations) console.error(`- ${violation}`);
  process.exitCode = 1;
} else {
  console.log("Control Plane architecture guard passed.");
}
