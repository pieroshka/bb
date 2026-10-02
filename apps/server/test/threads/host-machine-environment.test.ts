import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { setAppSettings, updateHost } from "@bb/db";
import { defaultAppSettings } from "@bb/domain";
import {
  hostDaemonServerWsMessageSchema,
  type HostDaemonServerWsMessage,
} from "@bb/host-daemon-contract";
import { expect, it } from "vitest";
import { withTestHarness, type TestAppHarness } from "../helpers/test-app.js";
import {
  seedHostSession,
  seedPrimaryHost,
  seedProjectWithSource,
  seedEnvironment,
  seedThread,
} from "../helpers/seed.js";
import { registerHostRpcResponder } from "../helpers/host-rpc.js";
import { resolveThreadRuntimeCommandConfig } from "../../src/services/threads/thread-runtime-config.js";
import { runEnvironmentHook } from "../../src/services/environments/environment-hooks.js";
import { setMachineEnvironmentVariable } from "../../src/services/machines/environment-storage.js";
import { setHostEnvironmentVariable } from "../../src/services/machines/host-machine-environment-store.js";

async function fixture(harness: TestAppHarness) {
  setAppSettings(harness.db, {
    ...defaultAppSettings,
    machineGitCredentialsEnabled: false,
  });
  const { host, session } = seedHostSession(harness.deps);
  seedPrimaryHost(harness.deps, host.id);
  updateHost(harness.db, harness.hub, host.id, { machineProviderId: "manual" });
  const path = join(harness.config.dataDir, "workspace");
  await mkdir(path);
  const { project } = seedProjectWithSource(harness.deps, {
    hostId: host.id,
    path,
  });
  const environment = seedEnvironment(harness.deps, {
    hostId: host.id,
    projectId: project.id,
    path,
  });
  const thread = seedThread(harness.deps, {
    projectId: project.id,
    environmentId: environment.id,
  });
  await setHostEnvironmentVariable(
    harness.db,
    harness.config.dataDir,
    host.id,
    { name: "MACHINE_ONLY", value: "machine-value", note: null },
  );
  await setHostEnvironmentVariable(
    harness.db,
    harness.config.dataDir,
    host.id,
    { name: "REGION", value: "machine-region", note: null },
  );
  await setMachineEnvironmentVariable(
    harness.db,
    harness.config.dataDir,
    { name: "REGION", value: "project-region", note: null },
    project.id,
  );
  return { host, session, project, environment, thread, path };
}

function expectedEnvironment() {
  return expect.arrayContaining([
    expect.objectContaining({ name: "MACHINE_ONLY", value: "machine-value" }),
    expect.objectContaining({ name: "REGION", value: "project-region" }),
  ]);
}

it("includes machine variables and project precedence in the actual agent command configuration", async () => {
  await withTestHarness(async (harness) => {
    const { thread, environment } = await fixture(harness);
    const config = await resolveThreadRuntimeCommandConfig(harness.deps, {
      thread,
      model: "test-model",
      environment,
    });
    expect(config.contributedEnv).toEqual(expectedEnvironment());
  });
});

it("includes machine variables in lifecycle hook commands and recovery dispatch", async () => {
  await withTestHarness(async (harness) => {
    const { host, session, project, path } = await fixture(harness);
    const captured: unknown[] = [];
    const responder = registerHostRpcResponder(harness, {
      hostId: host.id,
      sessionId: session.id,
      handle: async (request) => {
        if (request.command.type !== "environment.hook.run")
          throw new Error("Unexpected command");
        captured.push(request.command);
        return { ok: true, result: {} };
      },
    });
    try {
      for (const resumeOnly of [false, true])
        await runEnvironmentHook(harness.deps, {
          id: `machine-hook-${resumeOnly}`,
          projectId: project.id,
          hostId: host.id,
          path,
          kind: "teardown",
          resumeOnly,
          report: { step: () => {}, log: () => {} },
          signal: new AbortController().signal,
        });
      expect(captured).toHaveLength(2);
      for (const command of captured)
        expect(command).toMatchObject({
          contributedEnv: expectedEnvironment(),
        });
    } finally {
      responder.unregister();
    }
  });
});

it("sends machine variables and project precedence in a new terminal launch", async () => {
  await withTestHarness(async (harness) => {
    const { host, session, thread, path } = await fixture(harness);
    const captured: HostDaemonServerWsMessage[] = [];
    harness.hub.registerDaemon(session.id, host.id, {
      close: () => {},
      send: (data) => {
        const message = hostDaemonServerWsMessageSchema.parse(JSON.parse(data));
        if (message.type !== "terminal.open") return;
        captured.push(message);
        queueMicrotask(() =>
          harness.deps.terminalSessions.handleDaemonTerminalMessage({
            hostId: host.id,
            sessionId: session.id,
            message: {
              type: "terminal.opened",
              requestId: message.requestId,
              terminalId: message.terminalId,
              shell: "/bin/zsh",
              title: "zsh",
              initialCwd: path,
              cols: 100,
              rows: 30,
            },
          }),
        );
      },
    });
    try {
      const response = await harness.app.request("/api/v1/terminals", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          cols: 100,
          rows: 30,
          target: { kind: "thread", threadId: thread.id },
        }),
      });
      expect(response.status).toBe(201);
      expect(captured).toContainEqual(
        expect.objectContaining({
          type: "terminal.open",
          contributedEnv: expectedEnvironment(),
        }),
      );
    } finally {
      harness.hub.unregisterDaemon(session.id);
    }
  });
});
