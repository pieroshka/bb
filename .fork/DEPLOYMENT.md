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
The probe uses the full server-plus-daemon launcher. It injects a failed candidate that modifies SQLite then exits, verifies rollback
restores SQLite, verifies quarantine prevents repeated deployment, activates a
healthy candidate, then verifies same-version crash recovery preserves writes
accepted after activation. The CI container runs this with networking disabled.

## Safety boundary

During probation the private `.fork-maintenance` marker in the selected BB data
directory blocks public HTTP and WebSocket admission, queue dispatch and plugin
background-service execution and core recovery/maintenance sweeps. The launcher
defers its local daemon until admission opens. Only `/health` stays available. It is not a user
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
- `node .fork/deployment.mjs adopt CONFIG RUNTIME LEGACY`: explicitly adopt an idle legacy installation with startup rollback.
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

Production adoption is explicit. Bootstrap refuses an existing
`bb-app-runtime.json`. The `adopt` command requires a legacy manifest containing
`runtime` (with `unguarded: true`), `expectedRecord` (the exact current runtime
record), and `desktop` (`null` for a standalone launcher, or its verified parent
`pid` and full `command`). It refuses active threads and running terminals, stops
the verified desktop/launcher gracefully, checks idle state again offline, and
snapshots before starting the guarded fork. A failed candidate restores the data
and starts the actual previous launcher, with its original machine identity.
Legacy rollback disables unattended updates until a new explicit adoption.
The legacy server cannot close admission atomically; do the initial transition
in an idle window without submitting new work. Later fork updates have an
admission gate. Development checkouts with uncommitted work are never reset.

## macOS service

`node .fork/service.mjs install SERVICE` installs a per-user launchd agent. It
starts at login, survives desktop closure, and supervises the fork launcher,
which owns both server and local daemon. Installation immediately starts the
idle watcher; it never closes terminals or stops active threads to force adoption.
`node .fork/service.mjs status SERVICE` reads its last result. The service writes
`service-status.json`, `state.json`, backups, and logs under `stateDir`.

The service JSON has `schemaVersion: 1`, absolute `deploymentConfig`, `runtime`,
`legacy`, and `operatorConfig` paths, a launchd-safe `label`, `intervalMs` of at
least 1000, an explicit `updatesEnabled` boolean, `desktopCommand` (an absolute
executable or `null`), and string `desktopArgs`. Runtime and legacy paths are
used only for initial adoption. When configured, the desktop reopens with
`BB_DESKTOP_ATTACH_WITHOUT_PROMPT=1` after successful adoption and attaches to
the service-owned runtime. Opening the official desktop normally may ask to
connect to the existing server; choose Connect. Its own version remains separate.

Keep the service tools and runtime in committed, dedicated release directories.
Use Node 22 from `.nvmrc`. Automatic checks use the configured repository's
`origin/fork-verified`; preparation failures leave the current runtime selected.
Stopping the launchd agent leaves the independently supervised runtime running.
To stop both, unload the launchd agent and run `deployment.mjs stop CONFIG`.

Cold recovery may start with stale active database records only when both the
recorded launcher and local daemon are absent. A surviving daemon blocks that
recovery. Once activation is committed, recovery reopens admission and restarts
the same runtime without restoring a pre-update data snapshot.

`adoption.smoke.mjs` exercises a real 0.44 installation, terminal-idle refusal,
failed-candidate rollback, successful fork adoption, host identity, and cold
recovery with a stale terminal record. On macOS pass `BB_FORK_LEGACY_COMMAND`,
`BB_FORK_LEGACY_ENTRY`, and `BB_FORK_LEGACY_DESKTOP` to test desktop ownership.
The `Adoption.Dockerfile` supplies the real npm release for the network-disabled
Linux test. No provider credentials are required or copied by these fresh tests.

## Remaining rollout gates

- Before each production adoption, test the production-data clone in a network-isolated container.
- Confirm all active work is idle before the service can adopt the production installation.
- Provide actual HTTP response metadata capture for every supported harness, using
  native metadata or an authenticated opt-in gateway where headers are hidden.
  Do not fabricate absent headers or claim compilation proves inference behavior.

## Fork version identity

The runtime package uses `0.45.0+emi` (and the corresponding upstream version
on subsequent releases). `+emi` is SemVer build metadata, not a prerelease.
CLI output, server version information and the enrolled-host tarball preserve it.
Release precedence ignores metadata, so fork deployment selection and quarantine
use the exact verified Git commit rather than comparing version strings.

`.fork/config.json` owns `buildMetadata`. Synchronization reapplies it after each
upstream merge. A package conflict is resolved automatically only when the fork's
sole manifest change is the version metadata; unrelated manifest conflicts stop
promotion. The official desktop client remains independently versioned. A branded
runtime must not be installed from upstream npm by its metadata version: use the
fork's source build or server-provided, digest-verified host artifact.
