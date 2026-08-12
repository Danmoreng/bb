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

Migration entries are positional and immutable after release:

| Version | Contents                                                             |
| ------: | -------------------------------------------------------------------- |
|       0 | Projects, profiles, managed agents, work sessions, task dependencies |
|       1 | Decisions, requests/clusters, assumptions, human inputs              |
|       2 | Messages, investigations, findings, claims, reviews                  |
|       3 | Transactional outbox and processed-event registry                    |
|       4 | Compact persistent domain events for CP-104 projections              |

The schema uses normalized project-scoped relations, composite foreign keys,
status/version/timestamp checks, JSON validity checks, and targeted indexes.
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
prefix upgrades, idempotent reload, WAL/foreign-key state, rollback, schema
inventory, cross-project constraints, immutable decisions, and claim conflict
semantics.
