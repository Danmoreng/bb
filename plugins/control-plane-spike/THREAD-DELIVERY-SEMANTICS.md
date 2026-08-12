# CP-004 Thread Delivery Semantics Spike

This disposable spike validates the public `bb.sdk.threads` shape through a
structural gateway. It does not copy private server code or claim provider
execution. `createThreadSdkGateway()` is the only mapping from the public SDK
surface to the adapter; every response is validated before leaving the
adapter.

## Boundary and environment

Root and child spawns require an explicit host-neutral environment:
`{ type: "project-default" }` or `{ type: "reuse", environmentId }`. The
factory passes that value to `threads.spawn` together with `origin: "plugin"`
and the plugin id. The adapter verifies the returned project and parent
relationship where the host supplies those fields.

Events use the actual SDK query names (`afterSeq`, `limit`) and convert the
adapter's numeric limit to the string query expected by bb. Pending
interactions are normalized from the real union shape (`id`, `status`,
`payload.kind`, and optional `origin.kind`), not from an invented top-level
`kind`. Timeline, output, and queued-message parsing follows the public server
responses, including queue metadata.

## Delivery mapping

| Control Plane intent   | bb operation                        | Receipt application | Meaning                                                                                                                   |
| ---------------------- | ----------------------------------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `sendNow`              | `send({ mode: "steer-if-active" })` | `unknown`           | The server accepted the request, but idle/turn races can start a new turn. No steering or provider completion is claimed. |
| `sendNextTurn`         | `send({ mode: "queue-if-active" })` | `unknown`           | Active threads queue; idle threads may start immediately.                                                                 |
| `queueCheckpointInput` | `queuedMessages.create`             | `queued`            | A persistent queue record was returned. It is not yet delivered.                                                          |
| queue send             | `queuedMessages.send({ mode })`     | `unknown`           | The queue action was accepted; application to a turn is not observable from `{ ok: true, queuedMessage }`.                |
| `stop`                 | `stop`                              | `stop-requested`    | The server accepted a stop request; provider termination is not confirmed.                                                |

Receipt IDs are generated before mutations. If transport fails after the server
may have accepted a mutation, the adapter raises `DeliveryUnknownError` with
the `acceptance: "unknown"` receipt. Callers must reconcile before retrying.
The current bb API has no idempotency key, so local receipt IDs do not prevent
duplicate caller attempts and the adapter never retries mutations.

## Error and race semantics

- `unknown_method` and invalid output are `incompatible`.
- A 404 `thread_not_found`/`not_found` is a domain error; another 404 is host
  unavailable, not automatically an SDK incompatibility.
- `awaiting_user_interaction`, stale queue timestamps, and queue claim races
  are domain errors with their exact codes.
- A transport/503 failure after a possible mutation acceptance is unknown, not a
  safe transient retry.
- `wait` forwards `AbortSignal` to the SDK polling loop.
- `steer-if-active` may fall back to a new turn if the active turn ends during
  dispatch. `queue-if-active` is not a persistent queue while idle.
- Stop during startup and late host events require later reconciliation.
- The installed spike persists spawned thread IDs and receipts in its plugin DB;
  a production implementation must restore those refs on reload and reconcile
  with `get`, `events`, or `list` before sending. It must never spawn a
  replacement from an in-memory receipt.
- bb has no explicit public `resume()` method. After a daemon restart, the next
  send may lazily resume the persisted provider session; provider behavior must
  be recorded during manual QA.

## Verification and manual acceptance

Automated tests cover the gateway mapping, real request names, environment and
attribution inputs, response validation, queue CRUD, pending-interaction union,
AbortSignal forwarding, error classification, unknown-delivery receipts, and
no-retry behavior using a typed fake of the public SDK surface.

The installed plugin now exposes project-scoped root/child spawn, get, send,
checkpoint queue, queue-list, and stop RPCs over the real SDK gateway. Fake-host
contract tests cover those routes; real-host acceptance remains pending and
must be run against a bb development instance with a configured provider:

1. Spawn one root and two children; verify native parent/child and plugin attribution.
2. Exercise active → idle with `sendNow` and `sendNextTurn`, then reconcile with `get`/`events`.
3. Create and send a checkpoint queue entry; inspect queue CRUD in native bb.
4. Stop during startup and verify a later event does not resurrect the thread.
5. Reload/disable/enable the plugin and reconcile stored IDs without duplicates.
6. Restart the host daemon and send once; record provider-specific resume behavior.

No core patch, daemon protocol change, Tasks database access, or private SDK
hook is required by this spike.
