Delegation presets are user-defined; Tasks ships with none. Before dispatching
work, use `bb tasks preset list` and create a preset if the required one does
not already exist. Dispatch requires an existing preset.

Create or update the same execution selection exposed in the Tasks UI with
`--provider`, `--model`, `--reasoning`, and optional
`--service-tier <tier>`. A tier is an id the provider lists for the model
(`default`, `fast`, or another such as Codex `ultrafast`; see
`bb provider models <provider> --json`):

```sh
bb tasks preset create --name "Codex high" --provider codex \
  --model gpt-5.6-sol --reasoning high --service-tier fast \
  --permission auto
```

`preset update` accepts the same flags; `--clear-service-tier` clears a tier.
Do not combine it with `--service-tier`; `none` is a literal tier id.

## Execution reservations and external backends

Use `bb tasks execution ABC-12 --json` to inspect the active assignment, its
backend, frozen requirements, current stage, waits, last confirmed observation,
PRs/evidence, and retained history. `--action preflight` checks the mapped generic
backend. `--action prepare` freezes and reserves the task without starting a worker;
`--action start` starts that prepared assignment explicitly. Supported actions also
include `pause`, `resume`, `stop`, and `refresh`.

Delegation and Factory workers share the same reservation as external adapters.
A timeout, lost response, stopped execution, or disconnected plugin retains
ownership. Never replace it with `delegate` or start another worker. Refresh the
existing assignment and follow its backend's recovery state. Stop does not cancel
the task. Manual edits remain possible, but pause automatic status synchronization
for the frozen assignment; inspect the visible drift hold before continuing.
Only verified completion releases the assignment and allows a fresh generation.
Task hierarchy is not a dependency graph. Requirements and required attachments
must remain explicit; unavailable required bytes block preparation.

SDK integrations use the generic Tasks RPC contract documented in
[execution ownership](../../../execution/README.md). Reserve with authenticated
plugin identity before any dispatch, and pass `execution` identity when attaching
a Factory worker. Thread metadata is not execution authority.
