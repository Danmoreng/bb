#!/usr/bin/env node

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const DEGRADED_EXIT_CODE = 2;
const ERROR_EXIT_CODE = 3;
const MANIFEST_PATH = "private/upstream-touchpoints.json";
const CATEGORIES = ["core", "plugin", "ui", "build", "generated", "docs", "lockfile", "metadata"];

function usage() {
  return `Usage: node scripts/private/report-upstream-delta.mjs [options]

Options:
  --output <path>       Write the JSON report to this path (default: $RUNNER_TEMP or
                        the system temporary directory, bb-upstream-delta.json)
  --upstream-ref <ref>  Use this local Git ref instead of the configured upstream HEAD
  --manifest <path>     Read the audited touchpoint manifest from this path
  --check-manifest      Fail when the audited manifest does not match the current delta
  --require-upstream    Fail when a usable local upstream tracking ref is absent
  --help                Show this help
`;
}

function parseArgs(argv) {
  let outputPath;
  let upstreamRef;
  let manifestPath = MANIFEST_PATH;
  let requireUpstream = false;
  let checkManifest = false;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") {
      process.stdout.write(usage());
      process.exit(0);
    }
    if (argument === "--require-upstream") {
      requireUpstream = true;
      continue;
    }
    if (argument === "--check-manifest") {
      checkManifest = true;
      continue;
    }
    if (argument === "--output" || argument === "--upstream-ref" || argument === "--manifest") {
      const value = argv[index + 1];
      index += 1;
      if (!value) throw new Error(`${argument} requires a value`);
      if (argument === "--output") outputPath = value;
      if (argument === "--upstream-ref") upstreamRef = value;
      if (argument === "--manifest") manifestPath = value;
      continue;
    }
    if (argument.startsWith("--output=")) {
      outputPath = argument.slice("--output=".length);
      if (!outputPath) throw new Error("--output requires a path");
      continue;
    }
    if (argument.startsWith("--upstream-ref=")) {
      upstreamRef = argument.slice("--upstream-ref=".length);
      if (!upstreamRef) throw new Error("--upstream-ref requires a value");
      continue;
    }
    if (argument.startsWith("--manifest=")) {
      manifestPath = argument.slice("--manifest=".length);
      if (!manifestPath) throw new Error("--manifest requires a path");
      continue;
    }
    throw new Error(`Unknown argument: ${argument}`);
  }

  return {
    outputPath: outputPath ?? resolve(process.env.RUNNER_TEMP ?? tmpdir(), "bb-upstream-delta.json"),
    upstreamRef,
    manifestPath,
    requireUpstream,
    checkManifest,
  };
}

function runGit(root, args, { allowFailure = false } = {}) {
  const result = spawnSync("git", args, {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
  });

  if (result.error) throw result.error;
  if (result.status !== 0 && !allowFailure) {
    throw new Error(result.stderr.trim() || `git ${args.join(" ")} failed`);
  }
  return {
    status: result.status ?? ERROR_EXIT_CODE,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function optionalGitValue(root, args) {
  const result = runGit(root, args, { allowFailure: true });
  return result.status === 0 && result.stdout.trim() ? result.stdout.trim() : null;
}

function resolveRepositoryRoot() {
  const result = spawnSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" });
  if (result.error || result.status !== 0 || !result.stdout.trim()) {
    throw new Error("Not inside a Git repository");
  }
  return result.stdout.trim();
}

function resolveUpstreamRef(root, requestedRef) {
  if (requestedRef) {
    return optionalGitValue(root, ["rev-parse", "--verify", `${requestedRef}^{commit}`])
      ? requestedRef
      : null;
  }

  const symbolicHead = optionalGitValue(root, [
    "symbolic-ref", "--quiet", "--short", "refs/remotes/upstream/HEAD",
  ]);
  const candidates = [];
  if (symbolicHead?.startsWith("upstream/")) candidates.push(symbolicHead);
  candidates.push("upstream/main", "upstream/master");

  for (const candidate of [...new Set(candidates)]) {
    if (optionalGitValue(root, ["rev-parse", "--verify", `${candidate}^{commit}`])) return candidate;
  }
  return null;
}

function parseNameStatusZ(output) {
  const parts = output ? output.split("\0").filter(Boolean) : [];
  const changes = [];
  for (let index = 0; index < parts.length; index += 1) {
    const status = parts[index];
    const firstPath = parts[index + 1];
    if (!firstPath) throw new Error("Malformed NUL-delimited name-status record");
    index += 1;
    if (status.startsWith("R") || status.startsWith("C")) {
      const secondPath = parts[index + 1];
      if (secondPath === undefined) throw new Error("Malformed NUL-delimited rename record");
      changes.push({ status, path: secondPath, previousPath: firstPath });
      index += 1;
    } else {
      changes.push({ status, path: firstPath });
    }
  }
  return changes;
}

function parsePorcelainStatusZ(output) {
  const parts = output ? output.split("\0").filter(Boolean) : [];
  const modified = [];
  const untracked = [];
  for (let index = 0; index < parts.length; index += 1) {
    const record = parts[index];
    const status = record.slice(0, 2);
    const path = record.slice(3);
    if (status === "??") {
      untracked.push(path);
    } else if (path) {
      if (status.includes("R") || status.includes("C")) {
        const previousPath = parts[index + 1];
        if (previousPath === undefined) throw new Error("Malformed NUL-delimited status rename record");
        modified.push({ status, path, previousPath });
        index += 1;
      } else {
        modified.push({ status, path });
      }
    }
  }
  return { modified, untracked };
}

function categoryForPath(filePath) {
  if (/^(pnpm-lock\.yaml|package-lock\.json|yarn\.lock|bun\.lockb?|Cargo\.lock|Gemfile\.lock)$/.test(filePath)) {
    return "lockfile";
  }
  if (
    filePath.includes("/generated/") ||
    filePath.startsWith("packages/plugin-sdk/bundled-types/") ||
    filePath.endsWith(".generated.ts") ||
    filePath.endsWith(".generated.js")
  ) return "generated";
  if (filePath.startsWith("private/")) return "metadata";
  if (
    filePath.startsWith("docs/") ||
    filePath.startsWith("bb-control-plane-development-plan/") ||
    /(^|\/)(README|CHANGELOG)(\.|$)/i.test(filePath) ||
    filePath.endsWith(".md")
  ) return "docs";
  if (filePath.startsWith("plugins/")) return "plugin";
  if (
    filePath.startsWith(".github/") ||
    filePath.startsWith("scripts/") ||
    filePath === "turbo.json" ||
    filePath === "pnpm-workspace.yaml" ||
    filePath === "package.json" ||
    filePath === "tsconfig.json" ||
    filePath.endsWith(".config.js") ||
    filePath.endsWith(".config.mjs") ||
    filePath.endsWith(".config.ts") ||
    filePath.endsWith("/tsconfig.json")
  ) return "build";
  if (filePath.startsWith("apps/app/")) return "ui";
  return "core";
}

function addCategories(changes) {
  return changes.map((change) => ({ ...change, category: categoryForPath(change.path) }));
}

function loadManifest(root, manifestPath) {
  const absolutePath = resolve(root, manifestPath);
  try {
    const manifest = JSON.parse(readFileSync(absolutePath, "utf8"));
    if (!Array.isArray(manifest.touchpoints)) throw new Error("touchpoints must be an array");
    return { path: manifestPath, data: manifest };
  } catch (error) {
    if (error?.code === "ENOENT") return { path: manifestPath, data: null };
    throw new Error(`Unable to read manifest ${manifestPath}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function manifestAnalysis(manifest, privateChanges) {
  const currentPaths = new Set(privateChanges.map((change) => change.path));
  const manifestEntries = manifest?.data?.touchpoints ?? [];
  const manifestPaths = new Set(manifestEntries.map((entry) => entry.path).filter(Boolean));
  const manifestByPath = new Map(manifestEntries.filter((entry) => entry.path).map((entry) => [entry.path, entry]));
  const newPrivateTouchpoints = [...currentPaths].filter((path) => !manifestPaths.has(path)).sort();
  const noLongerPrivateTouchpoints = [...manifestPaths].filter((path) => !currentPaths.has(path)).sort();
  const manifestMissingAnnotations = manifestEntries
    .filter((entry) => !entry.path || !entry.category || !CATEGORIES.includes(entry.category)
      || !entry.purpose || !entry.owner || !entry.conflictRisk)
    .map((entry) => entry.path ?? "<missing path>")
    .sort();
  const manifestCategoryMismatches = privateChanges
    .filter((change) => manifestByPath.get(change.path)?.category !== change.category
      && manifestByPath.has(change.path))
    .map((change) => change.path)
    .sort();
  return {
    manifestPath: manifest?.path ?? null,
    manifestAvailable: Boolean(manifest?.data),
    newPrivateTouchpoints,
    noLongerPrivateTouchpoints,
    manifestMissingAnnotations,
    manifestCategoryMismatches,
  };
}

function buildReport(root, options) {
  const head = optionalGitValue(root, ["rev-parse", "HEAD"]);
  if (!head) throw new Error("Unable to resolve HEAD");
  const branch = optionalGitValue(root, ["symbolic-ref", "--quiet", "--short", "HEAD"]) ?? "(detached)";
  const configuredRemotes = optionalGitValue(root, ["remote"])?.split("\n").filter(Boolean) ?? [];
  const upstreamRemoteConfigured = configuredRemotes.includes("upstream");
  const upstreamRef = resolveUpstreamRef(root, options.upstreamRef);
  const originMain = optionalGitValue(root, ["rev-parse", "--verify", "refs/remotes/origin/main^{commit}"]);
  const upstreamSha = upstreamRef ? optionalGitValue(root, ["rev-parse", "--verify", `${upstreamRef}^{commit}`]) : null;
  const mergeBase = upstreamRef ? optionalGitValue(root, ["merge-base", "HEAD", upstreamRef]) : null;
  const status = upstreamRef && upstreamSha && mergeBase ? "ok" : "degraded";
  const degradedReason = status === "ok"
    ? null
    : options.upstreamRef && !upstreamRef
      ? "requested-upstream-ref-is-unavailable"
      : upstreamRemoteConfigured
        ? upstreamRef ? "upstream-ref-has-no-common-history" : "upstream-remote-has-no-local-tracking-ref"
        : "upstream-remote-is-not-configured";

  const privateChanges = mergeBase
    ? addCategories(parseNameStatusZ(runGit(root, ["diff", "--name-status", "-z", mergeBase, "HEAD"]).stdout))
    : [];
  const upstreamChanges = mergeBase && upstreamRef
    ? addCategories(parseNameStatusZ(runGit(root, ["diff", "--name-status", "-z", mergeBase, upstreamRef]).stdout))
    : [];
  const workingTree = parsePorcelainStatusZ(runGit(root, ["status", "--porcelain=v1", "-z", "--untracked-files=normal"]).stdout);
  const privatePaths = new Set(privateChanges.flatMap((change) => [change.path, change.previousPath].filter(Boolean)));
  const upstreamPaths = new Set(upstreamChanges.flatMap((change) => [change.path, change.previousPath].filter(Boolean)));
  const conflictCandidates = [...privatePaths].filter((path) => upstreamPaths.has(path)).sort();
  const manifest = loadManifest(root, options.manifestPath);

  return {
    schemaVersion: 1,
    categories: CATEGORIES,
    status,
    degradedReason,
    repository: {
      branch,
      head,
      configuredRemotes,
      upstreamRemoteConfigured,
      originMain,
      upstreamRef,
      upstreamSha,
      mergeBase,
    },
    changes: { privateSinceMergeBase: privateChanges, upstreamSinceMergeBase: upstreamChanges },
    conflictCandidates,
    manifest: manifestAnalysis(manifest, privateChanges),
    workingTree,
    notes: [
      "Committed deltas are compared using local Git refs only; the script never fetches or changes Git state.",
      "The checked-in manifest is an audited snapshot. Normal reports expose drift; --check-manifest makes drift fail.",
      "Untracked files are reported separately and are never classified as upstream touchpoints.",
    ],
  };
}

function writeReport(outputPath, report) {
  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  if (outputPath === "-") {
    process.stdout.write(serialized);
    return;
  }
  const absolutePath = resolve(outputPath);
  mkdirSync(dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, serialized, "utf8");
  process.stdout.write(`Wrote upstream delta report to ${absolutePath}\n`);
}

try {
  const options = parseArgs(process.argv.slice(2));
  const root = resolveRepositoryRoot();
  const report = buildReport(root, options);
  writeReport(options.outputPath, report);
  const manifestDrift = report.manifest.newPrivateTouchpoints.length > 0
    || report.manifest.noLongerPrivateTouchpoints.length > 0
    || report.manifest.manifestMissingAnnotations.length > 0
    || report.manifest.manifestCategoryMismatches.length > 0
    || !report.manifest.manifestAvailable;

  if (options.checkManifest && manifestDrift) {
    process.stderr.write("Audited upstream touchpoint manifest is out of date or incomplete.\n");
    process.exitCode = ERROR_EXIT_CODE;
  } else if (report.status === "degraded") {
    if (options.requireUpstream) {
      process.stderr.write("A usable local upstream tracking ref is required but was not found.\n");
      process.exitCode = ERROR_EXIT_CODE;
    } else {
      process.stderr.write("Upstream tracking ref is unavailable locally; report is degraded.\n");
      process.exitCode = DEGRADED_EXIT_CODE;
    }
  }
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = ERROR_EXIT_CODE;
}
