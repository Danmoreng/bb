# Control Plane capability spike (CP-002)

This is a disposable, plugin-only capability spike. It proves that the current
bb plugin surface can provide the first Control Plane foundations without a bb
Core or host-daemon patch.

## Demonstrated surfaces

- private plugin SQLite database with append-only migrations;
- strict RPC input/output schemas and persisted observations;
- ephemeral realtime notification with frontend refetch;
- reconnect reconciliation through `useRealtimeConnectionState`;
- abort-sensitive background service;
- project-scoped native agent tool;
- project-scoped dynamic instructions and `bb.agents.configure`;
- thread lifecycle listeners;
- plugin disposal hook;
- sanctioned `navPanel` app surface with loading, error, empty and ready states.

The spike is not production Control Plane code. Its database and API are
intentionally small and disposable; only verified capability findings should
be carried into the production plugin.

## Development

```sh
pnpm exec turbo run typecheck --filter=bb-plugin-control-plane-spike
pnpm exec turbo run test --filter=bb-plugin-control-plane-spike
pnpm exec turbo run build --filter=bb-plugin-control-plane-spike
```

For a running private bb development instance:

```sh
bb plugin install ./plugins/control-plane-spike
bb plugin reload control-plane-spike
```

Select a project in Settings under **Capability spike project**. The tool is
only included in new/resumed agent configurations for that project. Disable or
reload the plugin and verify that the persisted observation count remains after
re-enable and that no heartbeat service remains. The nav panel should show a
clear degraded/error state if the backend is unavailable.

## Fit / gap findings

The following table records what this disposable spike actually verifies. Unit
and fake-host tests prove the plugin boundary and lifecycle wiring; they do not
replace a running bb integration test.

| Surface                      | Current fit                                                                                    | Concrete fallback / limitation                                                                                               | Carry forward |
| ---------------------------- | ---------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ------------- |
| Storage and migrations       | Own SQLite database, append-only migrations, and reload persistence work in fake-host tests.   | Keep canonical Control-Plane state in the plugin database; never read `bb.db` or another plugin database.                    | Yes           |
| RPC                          | Strict input/output schemas and project-scope checks are verified.                             | Return a degraded/unauthorized snapshot instead of reading another project; application services must remain the next layer. | Yes           |
| Realtime                     | Signals carry project/revision only and trigger a canonical refetch. Reconnect also refetches. | Signals are ephemeral; stale responses are ignored and a later refetch remains authoritative.                                | Yes           |
| Background service           | Abort-sensitive service registration and host-dispose cancellation are tested.                 | Use host-managed restart/backoff in production; no untracked timers or workers.                                              | Yes           |
| Agent tools                  | Tool selection is project-scoped and the actor project comes only from tool context.           | Configuration applies at session start/resume, not midway through an active provider turn.                                   | Yes           |
| Instructions                 | Dynamic instructions are project-scoped through the public provider.                           | Keep product policy server/application-owned in the production plugin; do not use instructions as authorization.             | Yes           |
| Thread lifecycle             | Public coarse lifecycle listeners can persist events for the configured project.               | No provider turn/tool stream; use reconciliation or budgeted polling until a later capability spike proves a better hook.    | Yes           |
| Nav panel                    | Sanctioned panel renders loading, empty, error, degraded, and ready states.                    | No contribution to another plugin's UI; use an independent cockpit.                                                          | Yes           |
| Reload / disable / reconnect | Persistence, host disposal cleanup, and frontend reconnect refetch are covered by tests.       | A real running-bb disable/enable and backend restart walkthrough is still manual and not claimed by these tests.             | Yes           |

Not yet demonstrated by CP-002: Tasks interop, Steward threads, domain
aggregates, or provider execution. Those belong to CP-003/CP-004 and later
milestones. No Core or daemon protocol change is needed, so no protocol bump is
made.

## Recorded host smoke

On 2026-08-12 the source dev host accepted the path install, reported the
plugin and frontend bundle as compatible/running, exposed the heartbeat service
and agent tool, and completed reload → disable → enable. A persisted observation
survived a real plugin reload through the HTTP RPC boundary. Automated tests
cover two-project denial, stale frontend responses, reconnect refetch, and
host-driven service abort. Browser-only visual inspection and a full server
restart remain manual follow-ups; neither blocks the plugin capability decision.
