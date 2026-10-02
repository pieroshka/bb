# Per-machine environment extension

This fork keeps machine overrides outside the upstream Drizzle schema and
migration history. New modules contain the storage, routes, contract, and SDK
implementation. Existing modules have small registration points. No upstream
schema, migration, snapshot, lockfile, daemon contract, or existing test is changed.

`bb machine env list|set|unset --machine <id-or-name>` selects an enrolled
machine, including offline machines. `--project` still selects project scope;
the flags are mutually exclusive. No selector means global defaults. Values
are read from stdin and list results mask saved values.

The installed Machine Environment plugin can use this fork without changes:
`hosts.experimental_machineEnvironment`, `experimental_replaceMachineEnvironment`,
`experimental_setMachineEnvironmentVariable`, and
`experimental_deleteMachineEnvironmentVariable` retain their original signatures.
GET/POST/PUT/DELETE `/api/v1/hosts/:id/machine-environment` implement the same API.
Writes reject machine credentials and unknown or destroyed hosts.

Precedence remains global → machine → project → agent provider contributions.
The shared host resolver covers next agent turns, new terminals, hooks, clones,
and commands; existing terminals keep their launch values. The daemon receives
the existing `machine-environment.replace` payload. No protocol change is needed.

Machine values use AES-256-GCM with machine ID and variable name authenticated.
`plugins/machine-env/native/hosts.json` and `key` under the BB data directory
have mode 0600. The existing server archive includes both paths. Atomic file
updates use BB's cross-process file lock. Missing keys or invalid stores block
writes rather than silently replacing saved data. Removed/destroyed machines
stop receiving values immediately; their encrypted records are pruned on the
next successful write. Removing the machine-env plugin deletes its state.

This replaces the earlier `bb-plugins/core-patches/per-machine-environment.patch`.
Do not apply both implementations. The earlier patch was never deployed to the
main app; databases that ran that prototype require a separate conversion before
using this fork. This setup does not update or start the installed app.

## Stabilization criteria

The four SDK methods remain experimental. Stabilization requires upstream
agreement on scope precedence, secret retention and backup behavior, write
authorization, machine removal, and runtime coverage. The extension must pass
isolation, masking, ciphertext identity, concurrent-write, corruption, CLI,
daemon synchronization, terminal, agent-turn, and lifecycle-hook checks.
