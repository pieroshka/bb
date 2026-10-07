#!/usr/bin/env bash
set -euo pipefail

node --test .fork/upstream-sync.test.mjs
pnpm exec turbo run build typecheck --filter=@bb/server --filter=@bb/cli --filter=@bb/sdk --filter=@bb/app --filter=@bb/host-daemon --filter=bb-plugin-provider-codex --filter=bb-plugin-provider-claude-code --filter=bb-plugin-provider-pi --filter=bb-plugin-provider-acp --output-logs=errors-only
pnpm exec turbo run test --filter=@bb/server --output-logs=errors-only -- fork-maintenance.test.ts periodic-sweeps.test.ts bb-app-artifact.test.ts app-version.test.ts skeleton.test.ts host-machine-environment.test.ts machine-environment.test.ts host-environment-sync.test.ts thread-runtime-config.test.ts public-terminals.test.ts project-environment-hooks.test.ts --testTimeout=15000
pnpm exec turbo run test --filter=@bb/cli --output-logs=errors-only -- host-machine-environment.test.ts machine-environment.test.ts
pnpm exec turbo run test --filter=@bb/sdk --output-logs=errors-only -- public-types.test.ts
pnpm exec turbo run test --filter=@bb/db --output-logs=errors-only
pnpm exec turbo run test --filter=bb-plugin-provider-claude-code --output-logs=errors-only -- provider-maintenance.credentials.test.ts
