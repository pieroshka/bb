# Guarded unattended fork deployment

The fork follows stable `desktop-vMAJOR.MINOR.PATCH` releases, not unreleased
upstream main. `.fork/upstream-sync.mjs` preserves our patches and workflows,
rejects source conflicts, and verifies exact merge artifacts. Successful promotion
atomically advances both `main` and `fork-verified`. Local deployment follows
`fork-verified` only. Ordinary main pushes become deployable only after Fork checks
passes, including the container rollback drill.

## Isolated test instance

Run `docker compose -f .fork/container/compose.yml up --build -d`.
The app listens on host loopback port 39887, with a dedicated Docker volume.
No production directory, credentials, SSH agent, Docker socket or host checkout is
mounted into the runtime. Container logs are bounded. The container has no model
credentials and therefore is not proof of authenticated inference through every
harness. Core and all four native provider adapters are built and typechecked by
`.fork/verify.sh`; their transport integration requires separate behavioral tests.

`node .fork/deployment.smoke.mjs` runs an actual BB server in a disposable directory.
It injects a failed candidate that modifies SQLite then exits, verifies rollback
restores SQLite, verifies quarantine prevents repeated deployment, activates a
healthy candidate, then verifies same-version crash recovery preserves writes
accepted after activation. The CI container runs this with networking disabled.

## Safety boundary

During probation the private `.fork-maintenance` marker in the selected BB data
directory blocks public HTTP and WebSocket admission, queue dispatch and plugin
background-service execution. Only `/health` stays available. It is not a user
configuration switch; the external operator owns it.

Updates defer while any thread is starting, active or stopping, or any terminal is
running. This is intentional: daemon upgrades currently kill terminal sessions.
There is no forced drain, no `--yes` interruption and no blanket conflict resolution.

The external deployment controller uses a per-instance lock, an atomic/fsynced
journal, immutable runtime manifests, graceful process shutdown, offline snapshots,
SQLite integrity checks, guarded readiness and probation. It retains the previous
runtime and full mutable-data snapshot. Failed candidates are quarantined.
Interrupted pre-activation transactions can recover to their prior runtime.

Once activation opens admission, automatic recovery restarts the SAME version
without restoring old data. Restoring a pre-update database after accepting new
work would erase that work, so post-activation data rollback is refused. A
persistent new-version defect requires a compatible forward fix or a separately
validated rollback; do not silently discard post-update work.

## Controller commands

These are source-maintenance tools, not new installed `bb` commands. Require Node
from `.nvmrc`, the repository's pnpm version, git, sqlite3, and ps on macOS/Linux.

- `node .fork/deployment.mjs status CONFIG`: inspect the journal.
- `node .fork/deployment.mjs bootstrap CONFIG RUNTIME`: start a guarded fresh instance.
- `node .fork/deployment.mjs activate CONFIG RUNTIME`: deploy after idle checks.
- `node .fork/deployment.mjs check CONFIG`: readiness and same-version recovery.
- `node .fork/deployment.mjs recover CONFIG`: recover an interrupted transaction.
- `node .fork/deployment.mjs stop CONFIG`: gracefully stop the managed runtime.
- `node .fork/operator.mjs OPERATOR [--once]`: prepare and deploy verified revisions.

A deployment config has schemaVersion 1, absolute dataDir/stateDir, loopback
healthUrl ending in `/health`, healthTimeoutMs and probationMs. State must be outside
the BB data directory. A runtime manifest has id, absolute command/cwd, string args
and explicit string env. An operator config has schemaVersion 1, absolute repo,
deploymentConfig, node and pnpm, plus intervalMs of at least 60000.

Production adoption is deliberately NOT implicit. Bootstrap refuses an existing
`bb-app-runtime.json`; an unpatched legacy runtime cannot close admission and must
not be replaced by pretending it is a guarded runtime. First transition from the
installed desktop needs a separately validated, idle handoff and separate daemon
service. Development checkouts with uncommitted work are never switched or reset.

## Remaining rollout gates

- Prove the initial desktop-to-fork handoff and rollback without terminating terminals.
- Install the external OS service only after that handoff is validated.
- Test a production-data clone in a network-isolated container before migration.
- Provide actual HTTP response metadata capture for every supported harness, using
  native metadata or an authenticated opt-in gateway where headers are hidden.
  Do not fabricate absent headers or claim compilation proves inference behavior.
