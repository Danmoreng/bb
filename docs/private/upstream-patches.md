# Upstream Patch Register

**Status:** Normative register for private bb compatibility work
**Owner:** Project maintainers
**Last reviewed:** 2026-08-12

This register tracks private changes outside the plugin/domain boundary that
may affect upstream synchronization. It is separate from
`private/upstream-touchpoints.json`: that file is the audited fork touchpoint
snapshot, while this register covers patch series, their contract category,
and their implementation category.

## Active register

There are currently **no active Control Plane SDK, Core, or daemon-protocol
patches**. CP-002 is a `plugin-only` capability spike. CP-900 has contract
category `experimental-sdk` and implementation category `core-patch` candidate;
it is deferred to M9 and is not an active series.

The existing voice-toggle change is unrelated to the Control Plane but is an
active global private patch series and therefore counts against the shared
budget. It predates this register and is grandfathered as the baseline summary
below. It must receive a complete patch record before it is modified, rebased,
or included in the next upstream sync; until then no additional files may be
added to that series:

| ID | Scope | Contract category | Implementation category | Status | Production files | Layers | Protocol impact |
| --- | --- | --- | --- | --- | ---: | ---: | --- |
| VOICE-TOGGLE | Voice shortcut/promptbox | Not applicable (existing product behavior) | Private product patch series | active | 4 | 3 (app, server, shared domain) | No daemon wire change identified; protocol version not applicable. |

| Control Plane active series | Production files | Budget |
| ---: | ---: | ---: |
| 0 | 0 | 5 series / 12 production files |

Global snapshot: **1/5 private series**, **4/12 production files**, and
**3/3 layers** for VOICE-TOGGLE. Its 2 tests, 2 generated files, and 1 docs
file are tracked touchpoints but do not count as production files or extra
runtime layers. See `control-plane-compatibility.md` for the counting rules.

## Classification rules

- `plugin-only` means the implementation stays in the Control Plane plugin,
  domain package, or private support files and uses existing public APIs.
- `adapter` means host/Tasks operations are isolated behind a domain port and a
  validated public RPC/SDK boundary.
- `experimental-sdk` is the **public contract category** for a proposed,
  general additive API with an `experimental_` name and an audit entry.
- If implementing an `experimental-sdk` contract changes an existing bb
  Core/SDK/App/Server file, its **implementation category is also `core-patch`**
  and it counts against the global series, file, and layer budgets.
- `daemon-protocol` applies to any changed server/daemon command, result, event,
  WebSocket message, session payload, field type, requiredness, default, or
  meaning.
- CP-002 is `plugin-only` (with optional host usage through an `adapter`), with
  no public contract change.
- CP-900 is deterministically `experimental-sdk` contract plus `core-patch`
  candidate implementation, deferred to M9 and not approved.

## Mandatory protocol-version rule

If a change can alter anything sent over the server/daemon wire, including a
field's addition, removal, rename, type, requiredness, default, or meaning, or
a command, result, event, WebSocket message, or session payload, increment
`HOST_DAEMON_PROTOCOL_VERSION`. Backward-compatibility tests are required in
addition and never waive the bump. No bump is permitted only when the wire is
proven unchanged or the change is not applicable. Every record below must state
the inspected wire surface, old version, new version, evidence, and reviewer.

## Patch Definition of Done

A patch cannot be complete until the record demonstrates:

- mandatory plugin fallback works when the patch/capability is absent;
- capability detection handles old, new, disabled, and incompatible hosts;
- all external data is boundary-validated, with explicit defaults and
  requiredness and no accepted-but-ignored fields;
- an `experimental_` API has an audit entry and focused contract tests;
- the patch is isolated, removable, and does not duplicate bb domain state;
- user-facing behavior records CLI, SDK, agent, and documentation surfaces, or
  explicitly marks each as `Not applicable`;
- protocol impact is checked and the version is bumped whenever wire can change;
- targeted Turbo checks, affected-package tests, full build, and dogfood smoke
  have passed;
- upstream issue/PR suitability, branch/commit series, next rebase, and
  removal evidence are recorded;
- independent review is complete for L/XL, security, data, or Core work;
- a human owner approves the merge.

## Required patch record template

Copy this section for every proposed, active, upstreamed, or removed patch. Do
not leave a field implicitly unknown: use `Not applicable`, `Not yet measured`,
or a dated follow-up with an owner.

### `<PATCH-ID>` — `<short hook name>`

| Field | Required record |
| --- | --- |
| Task / ID and ADR | `<CP-xxx>`, patch identifier, and ADR/evidence links |
| Status | `proposed` / `spike` / `approved` / `active` / `blocked` / `upstreamed` / `removed` |
| Owner | Named person or team |
| Motivation | User or operational problem, with measurable impact where possible |
| Public gap | Exact plugin/SDK/host limitation and capability-spike evidence |
| Contract category | `plugin-only`, `adapter`, `experimental-sdk`, or `daemon-protocol` |
| Implementation category | `plugin-only`, `adapter`, `core-patch`, or `daemon-protocol`; explain any distinction |
| Branch / commit series | Isolated branch name, commit IDs, and patch-series order |
| Scope and layer count | Exact files/layers; confirm no complete component fork; maximum three layers per hook |
| Production-file budget | Number of counted production files and global budget at implementation time |
| API impact | Added/changed public members, schemas, generated contracts, defaults, requiredness, meanings, and compatibility behavior |
| Experimental name/audit | Exact `experimental_` symbol, or `Not applicable`; audit entry in `docs/api_to_audit.md` |
| Boundary validation | Input/output schemas, actor/scope checks, requiredness, defaults, and proof no field is accepted-but-ignored |
| Protocol-version decision | Wire surface inspected; old/new `HOST_DAEMON_PROTOCOL_VERSION`; mandatory bump if wire can change; evidence and reviewer |
| Capability probe | Method/schema detection, unavailable/incompatible behavior, timeout, and error mapping |
| Plugin fallback | Exact mandatory behavior when patch or capability is absent |
| User-facing surfaces | CLI, SDK, agent tools/skills, and docs; record implementation or `Not applicable` for each |
| Tests | Contract, host, integration, restart/reconnect, provider matrix, and fallback tests required/passed |
| Validation commands | Exact Turbo, lint, typecheck, test, build, and dogfood commands/results |
| Files / layer owners | Exact file list and owner for every changed layer |
| Upstream issue/PR | Link, issue number, or `Not yet filed` with owner/date |
| Last rebase / next rebase | Base SHA, date, result, and next planned rebase point |
| Upstream merge/release | Upstream PR/merge commit or `Not yet upstreamed`; release/version evidence |
| Conflict risk | `low` / `medium` / `high`, reason, and upstream hotspots |
| Removal path | Trigger, owner, and steps for deleting the patch |
| Removal evidence | Removal commit, post-removal validation, and date; `Not applicable` while active |
| Review | Architecture reviewer, independent reviewer if required, and dates |
| Merge decision | Human approver, date, and rationale |

## Review and sync workflow

1. Open a record before modifying SDK, Core, or daemon files.
2. Run the capability spike and document the mandatory plugin fallback.
3. Obtain architecture approval and a global patch-budget check.
4. Implement in an isolated branch/commit series, not mixed into plugin work.
5. Run the read-only upstream delta report, SDK/Tasks contract diff, targeted
   Turbo checks, full build, and dogfood smoke.
6. Have an independent reviewer inspect upgrade, security, and runtime risks
   where required.
7. Merge only after explicit human approval. Record the base SHA and next
   rebase point; automation must not merge or rebase.
8. Revisit every patch after upstream sync and Control Plane dogfood.
9. Remove a patch when upstream or a simpler plugin fallback makes it
   unnecessary, then record removal commit and post-removal validation.

## Initial traceability notes

- **CP-002:** contract and implementation category `plugin-only`, approved for
  capability spike only; optional host calls use an adapter and no public
  contract is added.
- **CP-900:** contract category `experimental-sdk`, implementation category
  `core-patch` candidate, deferred to M9. It has no active record, remains
  outside the MVP critical path, and retains lifecycle events plus budgeted
  polling as its mandatory fallback.
