# Task execution ownership

Tasks owns one durable reservation per task across native delegation, workflow
workers, and external execution adapters. An SQLite partial unique index enforces
one unreleased assignment. Assignment IDs are idempotent within their authenticated
owner plugin. Generations increase and historical executions remain immutable after
release. Removing a task with a live reservation is refused; terminal history survives
ordinary task deletion.

The generic wire contract is `contract.ts`. SDK callers use
`bb.sdk.plugins.callRpc({ pluginId: "tasks", method, input, outputSchema })`.

- `executionSnapshot` returns a monotonic task revision, requirements fingerprint,
  title, description, priority, due date, labels, hierarchy, non-system comments,
  and attachment manifests with SHA-256 hashes. Tasks has no dependency model;
  `parentTaskId` means hierarchy, never a prerequisite.
- `executionReserve` atomically captures that snapshot before any worker or remote
  request. Only authenticated plugin callers may reserve. The server derives
  `ownerPluginId` from RPC context; thread metadata cannot authorize a write.
- `executionConfirm` requires the immutable execution ID, generation, assignment ID,
  owner plugin, and current projection revision. It stores backend-neutral stage,
  wait, remote revision, links, evidence, capabilities, and observation time.
- `executionMarkUncertain` retains the reservation and last confirmed projection.
  Missing plugins, disconnected services, timeouts, and lost responses never select
  a local fallback or authorize a replacement assignment.
- `executionAttachment` is owner-bound and returns base64 bytes with their frozen
  hash. Changed requirements, removed attachments, hash mismatch, or ended
  assignments hold transfer. No arbitrary filesystem path is exposed.
- `executionGet` returns the active assignment and complete historical executions.
- `executionPreflight` and `executionPrepare` forward to the configured generic
  execution-backends plugin. Preparing does not start a worker. `executionControl`
  dispatches supported start, pause, resume, stop, and refresh actions to the stored
  owner plugin. Missing or unconfigured backends return a useful error while task
  editing remains available.

Every task requirements/status mutation advances a monotonic revision, including
attachment, label, and non-system comment changes. Automatic status writes compare
that revision within the confirmation transaction. A manual edit produces a visible
hold: remote evidence still updates, but canonical task status is not overwritten.
A same-value/status round trip cannot bypass the revision check.

Terminal release requires explicit adapter-verified completion bound to the same
assignment, requirements fingerprint, and remote revision. Only a verified `done`
outcome may synchronize Done; cancellation requires its own verified outcome.
Stop, idle, failure to contact a backend, or an uncertain start never means canceled
or terminal. A terminal assignment with changed local requirements can release
ownership without changing the owner's current task status.

Native delegation reserves before spawning and retains unknown outcomes.
Authenticated plugin callers may persist and supply `delegateTask.assignmentId`
before dispatch. Exact retries bind the caller, preset, prompt, and frozen
requirements and return only the original proven attached thread. Missing thread
proof holds the assignment instead of spawning again. Changed caller or inputs
cannot reuse that identity. Interactive delegation still allocates a fresh identity. Existing
unsettled historical worker attachments block a new assignment. A native thread's
idle or error state does not release ownership; confirmed thread deletion closes
that native assignment without asserting task completion. Factory callers must
reserve before either a single-worker or workflow start and supply
`taskThreadsAttach.execution` with the full identity. Attach validates the
requesting plugin, assignment, and real local thread. External executions never
create placeholder `task_threads` entries. Detaching a visible thread does not
release execution ownership.

The detail view, side-panel detail, directive card, list and board use the Tasks
projection and existing `tasks:changed` notifications. The UI always labels the
last confirmed time and reports stale or uncertain observations. Controls are
limited to backend-advertised capabilities; Refresh remains available for recovery.

CLI examples:

```sh
bb tasks execution ABC-12 --json
bb tasks execution ABC-12 --action preflight
bb tasks execution ABC-12 --action prepare
bb tasks execution ABC-12 --action start
bb tasks execution ABC-12 --action refresh
bb tasks execution ABC-12 --action stop
```

Focused verification:

```sh
pnpm exec turbo run typecheck --filter=bb-plugin-tasks
pnpm exec turbo run test --filter=bb-plugin-tasks -- execution/execution.test.ts delegate/delegate.test.ts
```

Explicit manual attachment can add several real threads to the same native
Tasks-owned local execution. Other execution owners still require their exact
identity and authenticated caller. A deletion event retains the indexed mapping
lookup and adds two fixed, thread-indexed execution settlement statements; this
also closes a native reservation after its visible thread was detached. It does
not scan the task population.
