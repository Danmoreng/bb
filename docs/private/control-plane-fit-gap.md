# Control Plane Architecture Gate (CP-006)

**Status:** Accepted for MVP implementation
**Date:** 2026-08-12
**Scope:** Current private `personal` fork and CP-002–CP-005 spike evidence

## Decision

The Control Plane proceeds as a plugin plus a host-independent domain package.
The MVP does not require a bb Core, SDK, App, Server, or host-daemon patch. The
existing public plugin surfaces are sufficient for the first implementation:
plugin SQLite/migrations, RPC, realtime, background services, agent tools and
instructions, coarse thread lifecycle events, `bb.sdk.threads`, Tasks RPC, a
nav panel, and host-owned `ThreadChat`.

Tasks remains the organizational source of truth. The Control Plane stores only
coordination, governance, mappings, receipts, and projections; it never opens
the Tasks database or `bb.db`. External calls remain outside database
transactions and will use the production outbox from CP-104 onward.

## Fit/gap matrix

| Requirement | Current evidence | MVP path | Core patch? |
| --- | --- | --- | --- |
| Own durable Control-Plane state | CP-002 SQLite migration and reload smoke | Production plugin DB and domain repositories | No |
| Tasks project/task CRUD | CP-003 installed RPC routes, local schemas and scope guard | TasksAdapter behind application services | No |
| Steward thread | CP-005 project mapping, repair flow, real reload lookup, host `ThreadChat` | Steward aggregate + thread port | No |
| Spawn/steer/queue/checkpoint | CP-004 SDK mapping and receipts; CP-004 installed routes | Thread adapter plus persistent checkpoint protocol | No |
| Coarse thread lifecycle | CP-002 listeners | Lifecycle reconciliation and bounded polling | No |
| Fine-grained provider/tool events | Not public | Lifecycle events plus reconciliation | Defer CP-900 |
| Built-in role tool allow/deny | Not public | Role instructions, plugin authorization and warning | Defer CP-903 |
| Inbox navigation badge | Not stable | Panel header count and refresh | Defer CP-901 |
| Tasks UI contribution | Not public | Independent Control-Plane cockpit | Defer CP-904 |
| Runtime semantic safe point | Provider-specific and unproven | `cp_checkpoint` protocol and queued input | Defer CP-905 |
| Stable Tasks capability contract | No versioned Tasks service contract | `plugins.list` + `ping` + read-only schema probe | Defer CP-906 |

## MVP cut

The implementation may proceed through M1–M4 with these explicit constraints:

- no direct SQL from UI or tool handlers;
- no direct Tasks or bb database access;
- all external responses validated at adapter boundaries;
- all mutable canonical aggregates use optimistic concurrency;
- all external side effects use the transactional outbox;
- realtime is an invalidation signal, never the source of truth;
- missing/incompatible Tasks and optional host features expose degraded mode;
- agent/project scope comes from server-owned context and configuration, not
  caller-supplied agent fields;
- no automatic merge, scheduler, review cache, or Core hook is MVP-critical.

## Spike outcomes

- **CP-002:** Plugin capability surface is fit. Real path install, reload,
  disable/enable, persisted observation, project authorization, and Steward
  thread lookup were exercised against the source dev server. Browser visual
  QA remains a follow-up.
- **CP-003:** Tasks RPC boundary is fit for the MVP operations. The installed
  plugin exposes capability, project listing, task mutation, comment,
  delegation, and attach routes. Scope denial prevents downstream mutation.
  Real provider/Tasks data walkthrough remains a dogfood step.
- **CP-004:** Public thread SDK is fit for root/child spawn, send modes,
  checkpoint queue, queue listing, events, timeline, output, interactions,
  wait, and stop. Receipts deliberately report server acceptance rather than
  provider completion; uncertain transport requires reconciliation.
- **CP-005:** A persistent project Steward can be initialized, repaired, and
  rendered with bb's own `ThreadChat`; no second chat implementation is needed.

## Deferred patch gate

No CP-900–CP-908 patch is approved by this gate. Any future Core/SDK change
must first update the patch register, use an `experimental_` API name, retain
a working plugin fallback, and pass the protocol-version review. A change that
can alter server/daemon wire data must increment
`HOST_DAEMON_PROTOCOL_VERSION`; compatibility tests do not waive that rule.

## Required independent review

This gate was checked against the current public SDK contracts and the CP-002–
CP-005 automated/host smoke evidence. Before a production M1 package is
merged, an independent reviewer must inspect domain boundaries, migrations,
outbox semantics, authorization, and update compatibility. The gate itself
introduces no product or wire change.

## Traceability

- CP-002/003/004/005: `plugins/control-plane-spike/`
- Compatibility policy: `docs/private/control-plane-compatibility.md`
- Patch register: `docs/private/upstream-patches.md`
- Fork baseline: `docs/private/fork-baseline.md`
- MVP scope: `bb-control-plane-development-plan/backlog/MVP-CUT.md`
