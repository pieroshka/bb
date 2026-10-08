#!/usr/bin/env bash
set -euo pipefail

test_args=(--maxWorkers=2 --testTimeout=60000 --hookTimeout=60000)

node --test .fork/upstream-sync.test.mjs
pnpm exec turbo run build typecheck --filter=@bb/server --filter=@bb/cli --filter=@bb/sdk --filter=@bb/app --filter=@bb/host-daemon --filter=bb-plugin-provider-codex --filter=bb-plugin-provider-claude-code --filter=bb-plugin-provider-pi --filter=bb-plugin-provider-acp --concurrency=2 --output-logs=errors-only
pnpm exec turbo run test --filter=@bb/server --concurrency=2 --output-logs=errors-only -- fork-maintenance.test.ts periodic-sweeps.test.ts bb-app-artifact.test.ts app-version.test.ts skeleton.test.ts host-machine-environment.test.ts machine-environment.test.ts host-environment-sync.test.ts thread-runtime-config.test.ts public-terminals.test.ts project-environment-hooks.test.ts "${test_args[@]}"
pnpm exec turbo run test --filter=@bb/cli --concurrency=2 --output-logs=errors-only -- host-machine-environment.test.ts machine-environment.test.ts "${test_args[@]}"
pnpm exec turbo run test --filter=@bb/sdk --concurrency=2 --output-logs=errors-only -- public-types.test.ts "${test_args[@]}"
pnpm exec turbo run test --filter=@bb/db --concurrency=2 --output-logs=errors-only -- "${test_args[@]}"
pnpm exec turbo run test --filter=bb-plugin-provider-claude-code --concurrency=2 --output-logs=errors-only -- provider-maintenance.credentials.test.ts src/bridge/__tests__/bridge.test.ts "${test_args[@]}"
pnpm exec turbo run test --filter=@bb/agent-runtime --concurrency=2 --output-logs=errors-only -- upstream-http-capture.test.ts "${test_args[@]}"
pnpm exec turbo run test --filter=@bb/server --concurrency=2 --output-logs=errors-only -- plugin-thread-events.test.ts plugin-authoring-docs.test.ts "${test_args[@]}"
