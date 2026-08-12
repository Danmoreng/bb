# Control Plane

Installable private plugin for the human Control Plane. CP-100/101 provides
its host-independent domain package and plugin boundary. CP-102 adds the first
versioned persistence layer.

```sh
pnpm exec turbo run typecheck test build --filter=bb-plugin-control-plane
bb plugin install ./plugins/control-plane
bb plugin reload control-plane
```

## Persistence

The plugin owns a separate SQLite database through `bb.storage.database()` and
never opens `bb.db` or the Tasks database. The database is initialized with WAL,
busy timeout, and connection-local foreign-key enforcement before the host's
append-only migration ledger runs.

Migration entries are positional and immutable after release. Entries 0–4
are cryptographically pinned; migration 5 is a forward-only correction and
must not edit or reorder those entries:

| Version | Contents                                                                 |
| ------: | ------------------------------------------------------------------------ |
|       0 | Projects, profiles, managed agents, work sessions, task dependencies     |
|       1 | Decisions, requests/clusters, assumptions, human inputs                  |
|       2 | Messages, investigations, findings, claims, reviews                      |
|       3 | Transactional outbox and processed-event registry                        |
|       4 | Compact persistent domain events for CP-104 projections                  |
|       5 | Integrity ledger, populated-data normalization, and normalized relations |
|         | CP-103 receipts, outbox delivery correction, constraints and indexes     |

Scope relation tables are the query truth for stable project/external
references; JSON scope fields remain flexible payloads. During upgrade,
non-empty legacy scope JSON is preserved verbatim as a `legacy-json` relation
row; typed relation rows remain authoritative and the application must expand
legacy rows before removing that compatibility path. Legacy scope fallback rows
are synchronized on later JSON updates, including clears, while typed rows are
left untouched. The normalized `agent_message_targets` table is authoritative
for logical agent/role/task/run recipients. `agent_message_recipients` is
retained only as a deprecated legacy compatibility table, backfilled into agent
targets, and mirrored for post-migration writes. Historical duplicate cluster
memberships and multiple investigation results are retained; cardinality cleanup
is deferred to an explicit application decision rather than silently deleting
facts. Physical project deletion is forbidden; projects are logically archived
(an export/purge service is deferred). Work sessions may be planned without an
agent (`agent_id IS NULL`); dispatch assigns a same-project managed agent, while
cross-project and orphan references fail closed.

The schema uses normalized project-scoped relations, composite foreign keys,
status/version/timestamp checks, JSON validity checks, and targeted indexes.
Legacy task/thread outbox rows that were `failed` or `processing` are migrated
to `outcome-unknown` and require explicit reconciliation before another send;
legacy realtime invalidations return to `pending` because they are safe to
coalesce; unknown message types and their pending/failed/processing deliveries
are dead-lettered rather than retried. Known version-one payload objects receive
their missing payload version during upgrade; malformed payloads remain
quarantined at claim time. Reconciliation evidence is append-only and retained
after an unknown delivery becomes delivered or pending. This provides logical
at-most-once handling only when the downstream side effect honors the stable
idempotency/reconciliation key; it cannot guarantee downstream behavior.
Tasks, threads, timelines, diffs, and full agent payloads remain external
references or compact summaries; they are not copied into this database.

Control projects are logically archived. Physical deletion is restricted by
foreign keys and requires a future export/dry-run purge flow.

## Deferred persistence

- Domain event production and transactional unit-of-work semantics are
  implemented by CP-104; this table stores only compact event envelopes.
- Inbox/cockpit read models are derived later from canonical tables and are not
  persisted speculatively in CP-102.
- Gates remain a later application/read-model concern until their policy and
  lifecycle contract is stable.

Migration tests use real SQLite through the plugin host and cover fresh and
populated prefix upgrades, idempotent reload, WAL/foreign-key state, rollback,
hash-ledger preflight, schema inventory, cross-project constraints, immutable
decisions/receipts, and claim conflict semantics.

## Repository foundation

CP-105 currently provides project-scoped, optimistic-concurrency repositories
for control projects, work sessions, and decision requests. Lists use bounded,
filter-bound keyset cursors and explicit summary projections; JSON-backed
decision fields are validated at write and read boundaries. This is a partial
foundation: repositories and read models for the remaining aggregates are
intentionally deferred to the next development session.
