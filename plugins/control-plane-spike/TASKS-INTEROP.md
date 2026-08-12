# CP-003 Tasks RPC interop spike

This spike verifies the Control Plane boundary to Tasks without opening the
Tasks database or importing implementation modules from `plugins/tasks`.

## Current fit

`TasksAdapter` uses an injected RPC gateway. `createTasksRpcGateway` adapts the
structural subset of `bb.sdk.plugins` used by the real host:

- `plugins.list()` discovers installation, enabled state, runtime status, and version.
- `plugins.callRpc({ pluginId, method, input, outputSchema })` invokes the public RPC boundary.
- Every response is validated immediately with a local Zod schema.

The adapter covers:

| Control Plane operation | Tasks RPC           | Boundary behavior                                                                                                                                                              |
| ----------------------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| List projects           | `listProjects`      | Omitted `folderId` sends `{}` (all projects); explicit `null` sends `{ folderId: null }`; the application scope guard filters to projects linked to the configured bb project. |
| Get task                | `getTask`           | Used by the application scope guard before task mutations and links.                                                                                                           |
| Create task             | `createTask`        | Explicit status, priority, description, due date, parent, and labels defaults; the Tasks project is authorized before mutation.                                                |
| Update task             | `updateTask`        | Explicit `authorName: "You"`; at least one task field is required; task scope is checked first.                                                                                |
| Add comment             | `createComment`     | Explicit `allowEmptyBody: false` default and body validation; task scope is checked first.                                                                                     |
| Start delegated worker  | `delegate`          | Mandatory application scope guard runs before RPC.                                                                                                                             |
| Attach existing worker  | `taskThreadsAttach` | Mandatory task/thread scope-link guard runs before RPC.                                                                                                                        |

Mutation calls are never retried: the current Tasks RPC contract has no
idempotency-key field.

## Capability and error model

Capabilities deliberately distinguish what was tested from what is expected:

- `expectedMethods` is the MVP method set; it is not proof that every method exists.
- `verifiedMethods` contains only `ping` and the read-only `listProjects` probe.
- `available`: Tasks is enabled/running, has a supported `0.1.x` version, and both read-only probes validate.
- `unavailable`: missing, disabled, `error`, `degraded`, stopped, or temporarily unreachable.
- `incompatible`: unsupported version, unknown method, or malformed response schema.
- `domain-error`: Tasks accepted the request but rejected its domain operation, such as `project_not_linked`.
- `transient`: an individual request failed after an otherwise healthy capability probe.

A 404 without `unknown_method` is treated as a missing/unavailable plugin. A
404 carrying `unknown_method` is incompatible. HTTP-style `status`, `code`,
`message`, and nested `body` values are narrowed before classification.
Delegation errors currently cross the Tasks RPC boundary as generic
`handler_error`; the adapter cannot recover the internal Tasks
`project_not_linked` code in that case.

## Scope guard

Tasks RPC does not provide enough information to prove that an arbitrary task
and thread belong to the same linked bb project. The adapter therefore requires
an application-owned `TasksScopeGuard` before every project listing, task
creation, task lookup/mutation, comment, delegation, and thread attachment.
The installed spike supplies this guard from the real `bb.sdk.plugins` and
`bb.sdk.threads` surfaces: it resolves the Tasks project, requires its
`linkedBbProjectId` to equal the configured project, and checks the attached
thread's project. A denied guard prevents the downstream RPC from being sent.

## Test matrix

`tasks-adapter.test.ts` covers:

- structural SDK gateway factory calling real-shaped `plugins.list` and `plugins.callRpc`;
- compatible running Tasks probe with exact `ping` and read-only project-list inputs;
- expected versus verified method capabilities;
- missing, disabled, error, and degraded plugin states;
- unsupported versions and malformed read-only responses;
- omitted versus explicit-null project filters and additive response fields;
- exact task/update/comment/delegation/attach inputs and defaults;
- real calendar-date and non-empty task-update refinements;
- mutation domain errors and no-retry behavior;
- unknown-method, unavailable 404/503, and transient failures;
- scope authorization before delegation/attachment;
- static absence of runtime imports from `plugins/tasks`.

## Manual integration still pending

The SDK wiring is contract-tested structurally, but a real host acceptance run
is still required:

```sh
bb plugin dev ./plugins/control-plane-spike
# With Tasks enabled: list projects → create/update task → comment → delegate → attach.
# Repeat with Tasks disabled/degraded and with a mismatched task/thread scope.
```

No mutation should be retried after an uncertain transport result. Repeat after
a Tasks upgrade with additive response fields to verify local compatibility.

This is disposable spike code. The production TasksAdapter in M1 should retain
these boundary contracts while moving schemas, scope authorization, error
mapping, and retry policy behind the production plugin's infrastructure layer.
