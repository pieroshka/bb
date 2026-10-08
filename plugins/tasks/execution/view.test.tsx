// @vitest-environment jsdom
import { cleanup, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  installTestPluginRuntime,
  renderSlot,
} from "@get-bb/plugin-sdk/testing/app";
import { makeTask } from "../test-fixtures";
import type { Task } from "../shared/contract";
installTestPluginRuntime();
const { ExecutionSection } = await import("./view");
afterEach(cleanup);

function execution(): NonNullable<Task["execution"]> {
  return {
    executionId: "execution-1",
    generation: 1,
    assignmentId: "assignment-1",
    taskId: "task-1",
    ownerPluginId: "adapter",
    backendId: "external",
    connectionId: "connection-1",
    projectionRevision: 1,
    lastConfirmed: {
      backendLabel: "Remote service",
      remoteRevision: "r1",
      phase: "waiting",
      stage: "Review",
      waitReason: "Waiting for owner review",
      remoteUrl: "https://example.test/run",
      pullRequests: [
        {
          url: "https://example.test/pr/1",
          title: "Proposed change",
          state: "open",
        },
      ],
      evidence: [{ url: "https://example.test/proof", label: "Browser proof" }],
      capabilities: ["refresh", "stop"],
      confirmedAt: "2026-01-01T00:00:00.000Z",
      completion: null,
    },
    uncertainReason: null,
    driftReason: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    releasedAt: null,
  };
}
describe("native execution projection", () => {
  it("shows stale confirmed evidence and sends immutable identity for a supported control", async () => {
    const calls: unknown[] = [];
    const task = { ...makeTask(), execution: execution() };
    const slot = renderSlot(
      { component: ExecutionSection },
      { task },
      {
        rpc: {
          executionControl: (input) => {
            calls.push(input);
            return {
              ok: false,
              message: "Backend disconnected; reservation retained",
            };
          },
        },
      },
    );
    expect(slot.getByText("Waiting for owner review")).toBeTruthy();
    expect(slot.getByText(/May be stale/)).toBeTruthy();
    expect(
      slot.getByRole("link", { name: "Browser proof" }).getAttribute("href"),
    ).toBe("https://example.test/proof");
    expect(slot.queryByRole("button", { name: "Start" })).toBeNull();
    fireEvent.click(slot.getByRole("button", { name: "Stop" }));
    await waitFor(() =>
      expect(slot.getByText(/Backend disconnected/)).toBeTruthy(),
    );
    expect(calls).toEqual([
      {
        executionId: "execution-1",
        generation: 1,
        assignmentId: "assignment-1",
        action: "stop",
      },
    ]);
  });
  it("keeps unavailable backend errors within the execution section", async () => {
    const slot = renderSlot(
      { component: ExecutionSection },
      { task: makeTask() },
      {
        rpc: {
          executionPreflight: () => ({
            available: false,
            message: "No backend configured",
            backendLabel: null,
          }),
        },
      },
    );
    await waitFor(() =>
      expect(slot.getByText("No backend configured")).toBeTruthy(),
    );
    expect(
      slot.queryByRole("button", { name: "Prepare execution" }),
    ).toBeNull();
  });
  it("prepares without sending start and only after explicit owner interaction", async () => {
    const calls: unknown[] = [];
    const task = makeTask();
    const slot = renderSlot(
      { component: ExecutionSection },
      { task },
      {
        rpc: {
          executionPreflight: () => ({
            available: true,
            message: "Ready",
            backendLabel: "Mapped service",
          }),
          executionPrepare: (input) => {
            calls.push(input);
            return { ok: true, message: "Prepared; Start remains explicit" };
          },
        },
      },
    );
    const button = await slot.findByRole("button", {
      name: "Prepare execution",
    });
    expect(calls).toEqual([]);
    fireEvent.click(button);
    await waitFor(() =>
      expect(slot.getByText(/Prepared; Start remains explicit/)).toBeTruthy(),
    );
    expect(calls).toEqual([{ taskId: task.id }]);
  });
});
