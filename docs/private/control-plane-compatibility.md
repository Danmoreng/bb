# Control Plane Compatibility Manifest

**Status:** Normative for CP-001
**Scope:** Private Control Plane development and upstream synchronization
**Owner:** Project maintainers
**Last reviewed:** 2026-08-12

This manifest is the decision gate for private work. The Control Plane is
implemented first as an independent plugin plus a host-independent domain
package. The public bb API and the current repository baseline remain the
implementation authorities.

## Governing decisions

- Control Plane product policy, domain state, and persistence do not belong in
  bb Core.
- Tasks remains the source of truth for task data. The Control Plane uses public
  Tasks RPC/SDK surfaces and never opens the Tasks database or `bb.db`.
- All external responses are validated at their boundaries. Requiredness,
  defaults, and meanings are explicit; no accepted-but-ignored fields are
  permitted.
- Every optional host, SDK, Core, or daemon feature has a working plugin
  fallback before adoption.
- No daemon wire contract is changed by CP-001.

## Compatibility categories

A work item records two categories when applicable:

1. **Contract category** — the public capability or boundary being evaluated.
2. **Implementation category** — where the private implementation actually
   lives. This is the category used for patch-budget accounting.

| Category | Meaning and entry criteria | Required validation | Mandatory fallback and sync rule |
| --- | --- | --- | --- |
| `plugin-only` | Implementable in `plugins/control-plane`, `packages/control-plane-domain`, or private support files using existing public APIs. | Domain tests, real SQLite tests where relevant, plugin host tests, and Turbo typecheck/test/build. | Capability detection and clear degraded mode. No Core patch rebase. |
| `adapter` | A host or Tasks operation is needed, but it is isolated behind a domain port and public RPC/SDK boundary. | Contract tests, boundary schema validation, error/timeout mapping, and real-host integration smoke. | Read-only or disabled behavior when unavailable/incompatible; re-check contracts after upstream sync. |
| `experimental-sdk` | **Contract category only:** a small, general, additive public API initially named with an `experimental_` prefix, justified by a spike proving the plugin fallback insufficient. | SDK contract tests, API audit entry, plugin fallback, capability detection, applicable CLI/SDK/agent surfaces, and Turbo checks. | Plugin fallback is mandatory. Never assume the member exists; isolate and prepare an upstream PR. |
| `core-patch` | **Implementation category:** an existing bb Core/SDK/App/Server file is privately changed to provide an experimental or other general hook. Requires approved spike, architecture review, isolation, and budget availability. | Experimental-SDK checks plus focused Core tests, affected-package checks, fallback test, upstream review, and independent review. | Plugin fallback is mandatory and the patch cannot be an MVP prerequisite. |
| `daemon-protocol` | A server/host-daemon command, result, event, WebSocket message, session payload, or runtime contract must change. | Provider matrix, server/daemon integration, restart/reconnect, previous-daemon compatibility tests, and protocol-version review. | A plugin/server fallback is mandatory. If the wire can change, `HOST_DAEMON_PROTOCOL_VERSION` must be incremented. |

`experimental-sdk` is therefore a public **contract** classification. If
implementing that contract requires private changes to existing bb Core/SDK/App
or Server files, the implementation is also `core-patch` and counts against
the Core-file and series budgets. A plugin implementation using an existing
experimental API remains `plugin-only` or `adapter`; it does not itself create
a Core patch.

## Decision procedure

1. Describe whether the requirement changes product policy, host runtime,
   public contract, or only Control Plane state.
2. Attempt `plugin-only` first. Add a domain port and `adapter` only for an
   external host operation.
3. Run a capability spike and record method, schema, lifecycle, reload,
   restart, and failure behavior.
4. If a public gap remains, record the smallest general contract as
   `experimental-sdk` and separately classify its implementation. Existing bb
   files changed for that implementation are `core-patch`.
5. Classify any server/daemon wire impact as `daemon-protocol`.
6. Before touching a Core, SDK, App, Server, or daemon file, open a register
   record using `docs/private/upstream-patches.md` and obtain the required
   architecture approval.
7. Run category-specific validation, record fallback and removal path, and
   require human merge approval.

## Daemon protocol rule (non-negotiable)

If a change **can alter anything sent over the server/daemon wire** — including
adding, removing, renaming, or changing the type, requiredness, default, or
meaning of a field, command, result, event, WebSocket message, or session
payload — increment `HOST_DAEMON_PROTOCOL_VERSION`. Backward-compatibility tests
are additionally required; they never waive the version bump when the wire can
change. A no-bump decision is valid only when the wire surface is demonstrably
unchanged or the change is not applicable. Record the inspected surface, old
version, new version, evidence, and reviewer in every patch record.

## Patch budget and review triggers

These are global warning thresholds for all permanently active private bb
changes, not only Control Plane changes:

- maximum **5 active independent private Core/SDK/App/Server patch series**;
- maximum **12 active private production files** outside
  `plugins/control-plane` and `packages/control-plane-domain`;
- maximum **3 repository layers for one hook**;
- no fork of a complete bb app, Thread, Tasks, or provider component;
- no direct provider-adapter patch without a demonstrated runtime gap.

A counted production file is a non-generated runtime or shared-contract file in
bb Core/SDK/App/Server (or another host product layer) that is part of an
active private patch. Tests, documentation, `scripts/private` and private
metadata, generated declarations/artifacts, and all files inside the two
Control Plane locations are excluded from the 12-file count. A patch series is
active from its first private implementation commit until it is upstreamed and
removed, or explicitly retired with removal evidence. Existing private changes
unrelated to the Control Plane still count globally.

Crossing a threshold requires an explicit architecture decision explaining why
an adapter or fallback is insufficient, expected lifetime, and removal/upstream
plan. The threshold does not authorize a sixth series, thirteenth production
file, or fourth layer.

### Current budget snapshot

| Budget | Current | Warn at | Accounting |
| --- | ---: | ---: | --- |
| Global private patch series | 1 | 5 | Existing voice-toggle series; active until upstreamed/removed. |
| Active Control Plane patch series | 0 | 5 | No CP Core/SDK/daemon patch is approved. |
| Private production files | 4 | 12 | Voice-toggle: `PromptBoxInternal`, `app-command-metadata`, server `app-keybindings`, shared domain `app-keybindings`. |
| Voice-toggle layers | 3 | 3 | App, server, shared domain. Its 2 tests, 2 generated files, and 1 docs file are tracked separately and do not add runtime layers. |

## Traceability review: initial classifications

| Work item | Contract category | Implementation category | Decision |
| --- | --- | --- | --- |
| CP-002 Plugin-Capability-Spike | `plugin-only` | `plugin-only` (optional host use through `adapter`) | Approved for spike only; no public contract or Core change. |
| CP-900 Fine-grained thread events | `experimental-sdk` | `core-patch` candidate | Deferred to M9; not approved, not MVP-critical, and requires a concrete polling/reconciliation gap, audit entry, capability detection, mandatory plugin fallback, focused tests, and independent architecture review. |

CP-900 must never be recorded as an ambiguous `experimental-sdk` /
`core-patch` implementation. Its public contract and potential private
implementation are separate fields as shown above.

## Upstream synchronization checklist

1. Fetch upstream explicitly into a local tracking ref.
2. Run the read-only delta report and review overlap candidates and budgets.
3. Compare plugin SDK, server contracts, Tasks RPC schemas, and generated
   declarations.
4. Apply or rebase each isolated private patch series independently.
5. Run targeted Turbo checks, the full build, and the required dogfood smoke.
6. Update the audited touchpoint and patch records when ownership, risk, or
   removal status changes.
7. Obtain human approval. No automation merges, rebases, force-pushes, or
   changes branches.

## Non-negotiable safeguards

- No direct access to `bb.db` or the Tasks database.
- No external SDK/RPC call inside a database transaction; use an outbox.
- No unchecked casts at host boundaries.
- No secrets, prompts, tokens, or full timelines in diagnostics or reports.
- No public plugin API without an `experimental_` prefix and an entry in
  `docs/api_to_audit.md`.
- No daemon wire change without the mandatory protocol-version increment above.
