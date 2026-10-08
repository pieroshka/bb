import { registerTasksCli } from "../cli";
import { afterEach, describe, expect, it } from "vitest";
import {
  createFakePluginHost,
  makeThreadResponse,
} from "@get-bb/plugin-sdk/testing";
import { createStore, registerTasksApi } from "../api";
import { registerAttachments, saveAttachmentFromBytes } from "../attachments";
import { registerLifecycle } from "../lifecycle";
import { registerDelegation } from "../delegate";
import { registerExecutions } from ".";
import {
  executionRpcContract,
  type Execution,
  type ExecutionProjection,
} from "./contract";

const hosts: ReturnType<typeof createFakePluginHost>[] = [];
afterEach(async () => {
  for (const host of hosts.splice(0)) await host.harness.dispose();
});
const caller = (pluginId = "adapter") => ({
  experimental_caller: { kind: "plugin" as const, pluginId },
});
function setup() {
  const host = createFakePluginHost({ pluginId: "tasks" });
  hosts.push(host);
  const store = createStore(host.bb);
  registerAttachments(host.bb, store.tasks);
  registerExecutions(host.bb, store);
  registerTasksApi(host.bb, store);
  registerDelegation(host.bb, store);
  const project = store.tasks.createProject({
    name: "Execution",
    prefix: "EXEC",
    color: "blue",
    linkedBbProjectId: "proj_test",
  });
  const task = store.tasks.createTask({
    projectId: project.id,
    title: "Implement bounded work",
  });
  return { ...host, store, task };
}
async function reserve(
  test: ReturnType<typeof setup>,
  assignmentId = "assignment-1",
  pluginId = "adapter",
) {
  const snapshot = await test.store.executions.snapshot(test.task.id);
  return executionRpcContract.executionReserve.output.parse(
    await test.harness.callRpc(
      "executionReserve",
      {
        taskId: test.task.id,
        expectedTaskRevision: snapshot.taskRevision,
        requirementsFingerprint: snapshot.requirementsFingerprint,
        backendId: "external",
        connectionId: "connection-1",
        assignmentId,
      },
      caller(pluginId),
    ),
  ).execution;
}
function identity(execution: Execution) {
  return {
    executionId: execution.executionId,
    generation: execution.generation,
    assignmentId: execution.assignmentId,
  };
}
function projection(
  overrides: Partial<ExecutionProjection> = {},
): ExecutionProjection {
  return {
    backendLabel: "Remote service",
    remoteRevision: "r1",
    phase: "running",
    stage: "Implementation",
    waitReason: null,
    remoteUrl: "https://example.test/assignment",
    pullRequests: [],
    evidence: [],
    capabilities: ["refresh", "stop"],
    confirmedAt: new Date().toISOString(),
    completion: null,
    ...overrides,
  };
}
function terminal(execution: Execution): ExecutionProjection {
  return projection({
    phase: "terminal",
    completion: {
      assignmentId: execution.assignmentId,
      requirementsFingerprint: execution.snapshot.requirementsFingerprint,
      remoteRevision: "r1",
      verified: true,
      outcome: "done",
    },
  });
}

describe("task execution ownership", () => {
  it("requires plugin caller authority and rejects owner impersonation without mutation", async () => {
    const test = setup();
    const snapshot = await test.store.executions.snapshot(test.task.id);
    const input = {
      taskId: test.task.id,
      expectedTaskRevision: snapshot.taskRevision,
      requirementsFingerprint: snapshot.requirementsFingerprint,
      backendId: "external",
      connectionId: "one",
      assignmentId: "one",
    };
    await expect(
      test.harness.callRpc("executionReserve", input),
    ).rejects.toThrow("authenticated plugin");
    const execution = await reserve(test);
    await expect(
      test.harness.callRpc(
        "executionConfirm",
        {
          ...identity(execution),
          expectedProjectionRevision: 0,
          projection: projection(),
        },
        caller("intruder"),
      ),
    ).rejects.toThrow("owner");
    expect(test.store.executions.get(execution).projectionRevision).toBe(0);
    await expect(
      test.harness.callRpc("executionMarkUncertain", {
        ...identity(execution),
        message: "fake",
      }),
    ).rejects.toThrow("authenticated plugin");
  });
  it("serializes competing adapters and returns the identical assignment on retry", async () => {
    const test = setup();
    const attempts = await Promise.allSettled([
      reserve(test, "a"),
      reserve(test, "b", "another"),
    ]);
    expect(
      attempts.filter((attempt) => attempt.status === "fulfilled"),
    ).toHaveLength(1);
    const held = test.store.executions.active(test.task.id)!;
    expect(await reserve(test, held.assignmentId, held.ownerPluginId)).toEqual(
      held,
    );
    expect(test.store.executions.history(test.task.id)).toHaveLength(1);
  });
  it("rejects stale snapshots including status ABA and preserves the task", async () => {
    const test = setup();
    const snapshot = await test.store.executions.snapshot(test.task.id);
    test.store.tasks.updateTask(test.task.id, { status: "done" });
    test.store.tasks.updateTask(test.task.id, { status: snapshot.status });
    await expect(
      test.harness.callRpc(
        "executionReserve",
        {
          taskId: test.task.id,
          expectedTaskRevision: snapshot.taskRevision,
          requirementsFingerprint: snapshot.requirementsFingerprint,
          backendId: "external",
          connectionId: "one",
          assignmentId: "one",
        },
        caller(),
      ),
    ).rejects.toThrow("snapshot changed");
    expect(test.store.executions.active(test.task.id)).toBeNull();
  });
  it("holds manual edits while retaining verified remote evidence and closing true terminal execution", async () => {
    const test = setup();
    const execution = await reserve(test);
    test.store.tasks.updateTask(test.task.id, {
      title: "Owner changed requirements",
      status: "todo",
    });
    const result = executionRpcContract.executionConfirm.output.parse(
      await test.harness.callRpc(
        "executionConfirm",
        {
          ...identity(execution),
          expectedProjectionRevision: 0,
          projection: terminal(execution),
          requestedTaskStatus: "done",
        },
        caller(),
      ),
    );
    expect(result.statusApplied).toBe(false);
    expect(result.execution.driftReason).toContain("changed");
    expect(result.execution.lastConfirmed?.phase).toBe("terminal");
    expect(result.execution.releasedAt).not.toBeNull();
    expect(test.store.tasks.getTask(test.task.id)?.status).toBe("todo");
  });
  it("never maps Stop to canceled or releases unknown starts", async () => {
    const test = setup();
    const execution = await reserve(test);
    await test.harness.callRpc(
      "executionConfirm",
      {
        ...identity(execution),
        expectedProjectionRevision: 0,
        projection: projection({ phase: "stopped" }),
      },
      caller(),
    );
    await test.harness.callRpc(
      "executionMarkUncertain",
      { ...identity(execution), message: "Connection lost" },
      caller(),
    );
    const current = test.store.executions.get(execution);
    expect(current.lastConfirmed?.phase).toBe("stopped");
    expect(current.releasedAt).toBeNull();
    await expect(reserve(test, "next")).rejects.toThrow("reserved");
    expect(test.store.tasks.getTask(test.task.id)?.status).not.toBe("canceled");
    await expect(
      test.harness.callRpc(
        "executionConfirm",
        {
          ...identity(execution),
          expectedProjectionRevision: 1,
          projection: projection({ phase: "stopped" }),
          requestedTaskStatus: "canceled",
        },
        caller(),
      ),
    ).rejects.toThrow("Stop is not cancellation");
  });
  it("rejects partial invalid completion atomically and guards stale projection writes", async () => {
    const test = setup();
    const execution = await reserve(test);
    const invalid = terminal(execution);
    invalid.completion!.requirementsFingerprint = "wrong";
    await expect(
      test.harness.callRpc(
        "executionConfirm",
        {
          ...identity(execution),
          expectedProjectionRevision: 0,
          projection: invalid,
          requestedTaskStatus: "done",
        },
        caller(),
      ),
    ).rejects.toThrow("frozen assignment");
    expect(test.store.executions.get(execution).lastConfirmed).toBeNull();
    await test.harness.callRpc(
      "executionConfirm",
      {
        ...identity(execution),
        expectedProjectionRevision: 0,
        projection: projection(),
        requestedTaskStatus: "in_progress",
      },
      caller(),
    );
    await expect(
      test.harness.callRpc(
        "executionConfirm",
        {
          ...identity(execution),
          expectedProjectionRevision: 0,
          projection: projection({ phase: "waiting" }),
        },
        caller(),
      ),
    ).rejects.toThrow("projection changed");
    expect(test.store.tasks.getTask(test.task.id)?.status).toBe("in_progress");
  });
  it("retains terminal history and grants a strictly newer generation only after release", async () => {
    const test = setup();
    const first = await reserve(test);
    await test.harness.callRpc(
      "executionConfirm",
      {
        ...identity(first),
        expectedProjectionRevision: 0,
        projection: terminal(first),
        requestedTaskStatus: "done",
      },
      caller(),
    );
    const next = await reserve(test, "next");
    expect(next.generation).toBe(first.generation + 1);
    expect(test.store.executions.history(test.task.id)).toHaveLength(2);
    await expect(
      test.harness.callRpc(
        "executionMarkUncertain",
        { ...identity(first), message: "late" },
        caller(),
      ),
    ).rejects.toThrow("terminal");
  });
  it("blocks local delegation and attachment before side effects when externally reserved", async () => {
    const test = setup();
    await reserve(test);
    await expect(
      test.harness.callRpc("delegate", {
        taskId: test.task.id,
        presetId: test.task.id,
      }),
    ).rejects.toThrow("reserved");
    expect(test.harness.sdk.callsTo("threads.spawn")).toHaveLength(0);
    test.harness.sdk.stub("threads.get", async () =>
      makeThreadResponse({ id: "thr_worker" }),
    );
    await expect(
      test.harness.callRpc("taskThreadsAttach", {
        taskId: test.task.id,
        threadId: "thr_worker",
      }),
    ).rejects.toThrow("reserved");
    expect(test.store.tasks.listTaskThreads(test.task.id)).toHaveLength(0);
  });
  it("preserves the reservation when the backend is absent and keeps ordinary task editing usable", async () => {
    const test = setup();
    const execution = await reserve(test);
    const result = executionRpcContract.executionControl.output.parse(
      await test.harness.callRpc("executionControl", {
        ...identity(execution),
        action: "refresh",
      }),
    );
    expect(result.ok).toBe(false);
    expect(result.message).toContain("remains reserved");
    expect(test.store.executions.active(test.task.id)).not.toBeNull();
    test.store.tasks.updateTask(test.task.id, { title: "Still editable" });
    expect(test.store.tasks.getTask(test.task.id)?.title).toBe(
      "Still editable",
    );
  });
  it("guards task deletion and reconstructs reservation ownership from durable storage", async () => {
    const test = setup();
    const execution = await reserve(test);
    expect(() => test.store.tasks.deleteTask(test.task.id)).toThrow("reserved");
    const recovered = createStore(test.bb);
    expect(recovered.executions.get(execution).assignmentId).toBe(
      execution.assignmentId,
    );
  });
  it("binds attachment bytes to the owner and frozen hash, then holds later mutations", async () => {
    const test = setup();
    const file = await saveAttachmentFromBytes(
      test.store.tasks,
      Buffer.from("frozen content"),
      { taskId: test.task.id, fileName: "spec.txt", mime: "text/plain" },
    );
    const execution = await reserve(test);
    const input = { ...identity(execution), attachmentId: file.id };
    await expect(
      test.harness.callRpc("executionAttachment", input, caller("foreign")),
    ).rejects.toThrow("owner");
    const bytes = executionRpcContract.executionAttachment.output.parse(
      await test.harness.callRpc("executionAttachment", input, caller()),
    );
    expect(Buffer.from(bytes.contentBase64, "base64").toString()).toBe(
      "frozen content",
    );
    expect(bytes.sha256).toBe(
      execution.snapshot.requirements.attachments[0]?.sha256,
    );
    await saveAttachmentFromBytes(test.store.tasks, Buffer.from("later"), {
      taskId: test.task.id,
      fileName: "new.txt",
      mime: "text/plain",
    });
    await expect(
      test.harness.callRpc("executionAttachment", input, caller()),
    ).rejects.toThrow("task changed");
  });
  it("retains uncertain native spawn ownership and refuses a second spawn", async () => {
    const test = setup();
    const preset = test.store.tasks.createPreset({
      name: "Worker",
      providerId: "codex",
      modelId: "model",
      reasoningLevel: "high",
      permissionMode: "full",
      environmentKind: "project-default",
      baseBranch: null,
      machineId: null,
      instructions: "",
      builtin: false,
    });
    test.harness.sdk.stub("threads.spawn", async () => {
      throw new Error("Lost response after dispatch");
    });
    await expect(
      test.harness.callRpc("delegate", {
        taskId: test.task.id,
        presetId: preset.id,
      }),
    ).rejects.toThrow("Lost response");
    expect(
      test.store.executions.active(test.task.id)?.uncertainReason,
    ).toContain("Lost response");
    await expect(
      test.harness.callRpc("delegate", {
        taskId: test.task.id,
        presetId: preset.id,
      }),
    ).rejects.toThrow("reserved");
    expect(test.harness.sdk.callsTo("threads.spawn")).toHaveLength(1);
  });
  it("does not overwrite owner status changes made while native spawn is pending", async () => {
    const test = setup();
    const preset = test.store.tasks.createPreset({
      name: "Worker",
      providerId: "codex",
      modelId: "model",
      reasoningLevel: "high",
      permissionMode: "full",
      environmentKind: "project-default",
      baseBranch: null,
      machineId: null,
      instructions: "",
      builtin: false,
    });
    test.harness.sdk.stub("threads.spawn", async () => {
      test.store.tasks.updateTask(test.task.id, { status: "canceled" });
      return { id: "thr_race" };
    });
    test.harness.sdk.stub("threads.get", async () =>
      makeThreadResponse({ id: "thr_race", status: "active" }),
    );
    await test.harness.callRpc("delegate", {
      taskId: test.task.id,
      presetId: preset.id,
    });
    expect(test.store.tasks.getTask(test.task.id)?.status).toBe("canceled");
    expect(test.store.executions.active(test.task.id)?.driftReason).toContain(
      "changed",
    );
    expect(test.store.tasks.listTaskThreads(test.task.id)).toHaveLength(1);
  });

  it("replays exact terminal confirmation after response loss without rewriting history", async () => {
    const test = setup();
    const execution = await reserve(test);
    const input = {
      ...identity(execution),
      expectedProjectionRevision: 0,
      projection: terminal(execution),
      requestedTaskStatus: "done",
    };
    const first = await test.harness.callRpc(
      "executionConfirm",
      input,
      caller(),
    );
    const replay = await test.harness.callRpc(
      "executionConfirm",
      input,
      caller(),
    );
    expect(replay).toEqual(first);
    expect(test.store.tasks.listComments(test.task.id)).toHaveLength(1);
    const changed = {
      ...input,
      projection: { ...input.projection, stage: "Different" },
    };
    await expect(
      test.harness.callRpc("executionConfirm", changed, caller()),
    ).rejects.toThrow("terminal");
    expect(test.store.executions.history(test.task.id)).toHaveLength(1);
  });

  it("reconciles a proven deleted local thread after restart but retains unknown reads", async () => {
    const test = setup();
    const snapshot = await test.store.executions.snapshot(test.task.id);
    const execution = test.store.executions.reserve({
      snapshot,
      ownerPluginId: "tasks",
      backendId: "local-tasks",
      connectionId: "local",
      assignmentId: "native",
    });
    test.store.executions.attach(execution, "tasks", "thr_missing_event");
    test.harness.sdk.stub("threads.get", async () => {
      throw Object.assign(new Error("not found"), { code: "thread_not_found" });
    });
    await registerLifecycle(test.bb, test.store);
    expect(test.store.executions.active(test.task.id)).not.toBeNull();
    test.harness.sdk.stub("threads.get", async () =>
      makeThreadResponse({
        id: "thr_missing_event",
        deletedAt: new Date().toISOString(),
      }),
    );
    await registerLifecycle(test.bb, createStore(test.bb));
    expect(test.store.executions.active(test.task.id)).toBeNull();
    expect(test.store.tasks.getTask(test.task.id)?.status).toBe("backlog");
  });
  it("exposes history and forwards supported CLI controls to the reserved owner", async () => {
    const test = setup();
    registerTasksCli(test.bb, test.store, { name: "Tasks", version: "test" });
    const execution = await reserve(test);
    await test.harness.callRpc(
      "executionConfirm",
      {
        ...identity(execution),
        expectedProjectionRevision: 0,
        projection: projection(),
      },
      caller(),
    );
    const inspected = await test.harness.runCli([
      "execution",
      test.task.key,
      "--json",
    ]);
    expect(inspected.exitCode).toBe(0);
    expect(JSON.parse(inspected.stdout).active.assignmentId).toBe(
      execution.assignmentId,
    );
    test.harness.sdk.stub("plugins.callRpc", async () => ({
      ok: true,
      message: "Stop requested",
    }));
    const stopped = await test.harness.runCli([
      "execution",
      test.task.key,
      "--action",
      "stop",
      "--json",
    ]);
    expect(stopped.exitCode).toBe(0);
    expect(test.harness.sdk.callsTo("plugins.callRpc")[0]?.[0]).toMatchObject({
      pluginId: "adapter",
      method: "executionControl",
      input: { ...identity(execution), action: "stop" },
    });
    expect(test.store.executions.active(test.task.id)).not.toBeNull();
  });
  it("retains terminal proof when a control response is lost after confirmation", async () => {
    const test = setup();
    const execution = await reserve(test);
    test.harness.sdk.stub("plugins.callRpc", async () => {
      test.store.executions.confirm(execution, "adapter", 0, terminal(execution), "done");
      throw new Error("Response lost after completion");
    });
    const result = executionRpcContract.executionControl.output.parse(await test.harness.callRpc("executionControl", { ...identity(execution), action: "refresh" }));
    expect(result.message).toContain("terminal outcome is already confirmed");
    expect(test.store.executions.get(execution).uncertainReason).toBeNull();
    expect(test.store.tasks.getTask(test.task.id)?.status).toBe("done");
  });

});
