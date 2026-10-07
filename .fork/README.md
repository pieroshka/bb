# BB fork with verified upstream tracking

Repository: https://github.com/pieroshka/bb

This repository follows `get-bb/bb` stable desktop release tags, retaining our per-machine
environment extension. The `Fork upstream sync` GitHub Actions workflow checks
every six hours at minute 17 UTC and can also be dispatched manually. This
repository setup does not install, restart, patch, or update a running BB app.

## How updates are promoted

1. Fetch the newest stable upstream release tag in an isolated GitHub checkout.
2. Merge it with the current fork main, preserving both histories.
3. Preserve `.fork/` and `.github/workflows/` from the fork. Upstream release
   and deployment workflows are not imported or executed by this automation.
4. Reject any remaining source conflict; no blanket ours/theirs resolutions.
5. Build and typecheck app, server, daemon, CLI, and SDK. Test the extension,
   global/project environment regressions, daemon sync, agent configuration,
   terminals, hooks, SDK types, and upstream database migrations.
6. A separate job with write permission promotes the exact verified merge
   using an ordinary fast-forward push, only if main has not moved during tests.

The prepare and verify jobs have read-only repository permissions and no
persisted Git credentials. Only the final promotion job can write. A versioned
Git bundle ties validation to the commit promoted. Existing GitHub tokens are
sufficient; no personal access token is copied into Actions secrets. Workflow
changes stay fork-owned, avoiding workflow-write privileges during normal sync.

Conflicts, failed tests, modified artifacts, and concurrent owner commits stop
promotion. GitHub marks the run failed and preserves the previous main. Inspect
the failed Actions run, resolve the conflict in a local branch, run verification,
then merge the fix. `git config rerere.enabled true` in the fork checkout lets
Git remember exact conflict resolutions. The sync job never rewrites main.

GitHub can disable schedules after 60 days without repository activity; check
the workflow status if upstream has been quiet that long. Schedules can also
be delayed by GitHub. Successful sync commits normally keep the repository active.

## Patch layout

Implementation and feature tests live in new, feature-owned files. Core changes
are small imports, registration calls, an SDK interface extension/object spread,
and a shared environment resolver call. CLI flags and discoverable documentation
are the other integration points. Formatting is restricted to our new files. See [guarded deployment](DEPLOYMENT.md) for container isolation, probation and rollback boundaries.

The per-machine environment extension does not modify upstream Drizzle schema,
numbered migrations, snapshots, lockfiles or daemon wire types. The separate
Claude custom-backend fix and guarded deployment hooks are maintained patches. Machine secrets live
in a separate encrypted store included in BB's existing server archives. See
[the extension contract](../docs/host-machine-environment.md).

This replaces the earlier migration-based prototype patch in bb-plugins.
Use this fork as the maintained implementation; do not stack that patch on top.
Upstream-native support for the same API should be reviewed before removing the
extension or converting its stored values.

## Local verification

Use Node from `.nvmrc` and the pnpm version in `package.json`:

```bash
pnpm install --frozen-lockfile
bash .fork/verify.sh
```

The synchronization tests use temporary local Git repositories to exercise
successful upstream promotion, workflow preservation, source conflicts,
concurrent pushes, and altered candidate artifacts. They never contact GitHub
or any BB instance.

For a future deployment, BB's source updater expects local `main` tracking
`origin/main`. Keep origin pointed at this fork and upstream pointed at
`https://github.com/get-bb/bb.git`. Deployment is a separate step; the external operator must be explicitly
adopted after container and initial-handoff verification.
