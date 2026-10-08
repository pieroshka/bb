import { z } from "zod";
import type {
  BbPluginApi,
  ExperimentalPluginRpcHandlersWithContext,
  ExperimentalPluginRpcHandlerContext,
} from "@get-bb/plugin-sdk";
import {
  publishTasksChanged,
  publishCommentsChanged,
  type TasksApiStore,
} from "../api";
import { readAttachmentContent } from "../attachments";
import { errorMessage } from "../shared/errors";
import { executionRpcContract, type Execution } from "./contract";
import { sha256 } from "./store";

function owner(context: ExperimentalPluginRpcHandlerContext): string {
  if (context.experimental_caller.kind !== "plugin")
    throw new Error(
      "Execution ownership requires an authenticated plugin caller",
    );
  return context.experimental_caller.pluginId;
}
export function executionHandlers(
  bb: BbPluginApi,
  store: TasksApiStore,
): ExperimentalPluginRpcHandlersWithContext<typeof executionRpcContract> {
  function changed(execution: Execution) {
    const task = store.tasks.getTask(execution.taskId);
    if (task) publishTasksChanged(bb, task.id, task.projectId);
  }
  return {
    async executionPreflight({ taskId }) {
      try {
        const result = await bb.sdk.plugins.callRpc({
          pluginId: "execution-backends",
          method: "preflight",
          input: { taskId, kind: "repository_delivery" },
          outputSchema: z.object({
            health: z.object({ code: z.string(), message: z.string() }),
            connection: z.object({ label: z.string() }).nullable(),
          }),
        });
        return {
          available: result.health.code === "ready",
          message: result.health.message,
          backendLabel: result.connection?.label ?? null,
        };
      } catch (error) {
        return {
          available: false,
          message: `Execution backend unavailable: ${errorMessage(error)}`,
          backendLabel: null,
        };
      }
    },
    async executionPrepare({ taskId }) {
      try {
        const snapshot = await store.executions.snapshot(taskId);
        const result = await bb.sdk.plugins.callRpc({
          pluginId: "execution-backends",
          method: "submit",
          input: {
            taskId,
            kind: "repository_delivery",
            expectedTaskRevision: snapshot.taskRevision,
            requirementsFingerprint: snapshot.requirementsFingerprint,
          },
          outputSchema: z.object({
            health: z.object({ code: z.string(), message: z.string() }),
            execution: z.object({ executionId: z.string() }).nullable(),
          }),
        });
        return {
          ok: result.execution !== null && result.health.code === "ready",
          message: result.health.message,
        };
      } catch (error) {
        return {
          ok: false,
          message: `Execution preparation unavailable: ${errorMessage(error)}. Any existing reservation is retained.`,
        };
      }
    },
    executionSnapshot: ({ taskId }) => store.executions.snapshot(taskId),
    async executionReserve(input, context) {
      const ownerPluginId = owner(context);
      const snapshot = await store.executions.snapshot(input.taskId);
      if (
        snapshot.taskRevision !== input.expectedTaskRevision ||
        snapshot.requirementsFingerprint !== input.requirementsFingerprint
      )
        throw new Error("Task snapshot changed; execution was not reserved");
      const execution = store.executions.reserve({
        ...input,
        snapshot,
        ownerPluginId,
      });
      changed(execution);
      return { execution };
    },
    executionGet({ taskId }) {
      const history = store.executions
        .history(taskId)
        .map(store.executions.checkDrift);
      return {
        active:
          history.find((execution) => execution.releasedAt === null) ?? null,
        history,
      };
    },
    executionConfirm(input, context) {
      const result = store.executions.confirm(
        input,
        owner(context),
        input.expectedProjectionRevision,
        input.projection,
        input.requestedTaskStatus,
      );
      changed(result.execution);
      publishCommentsChanged(bb, result.execution.taskId);
      return result;
    },
    executionMarkUncertain(input, context) {
      const execution = store.executions.uncertain(
        input,
        owner(context),
        input.message,
      );
      changed(execution);
      return { execution };
    },
    async executionAttachment(input, context) {
      const execution = store.executions.get(input, owner(context));
      if (
        execution.releasedAt ||
        store.executions.checkDrift(execution).driftReason
      )
        throw new Error(
          "Execution attachment transfer held: task changed or assignment ended",
        );
      const frozen = execution.snapshot.requirements.attachments.find(
        (file) => file.id === input.attachmentId,
      );
      if (!frozen)
        throw new Error("Attachment is not part of this frozen assignment");
      const { attachment, content } = await readAttachmentContent(
        store.tasks,
        input.attachmentId,
      );
      const current = store.executions.get(input, owner(context));
      if (
        current.releasedAt ||
        store.executions.checkDrift(current).driftReason ||
        attachment.sizeBytes !== frozen.sizeBytes ||
        sha256(content) !== frozen.sha256
      )
        throw new Error(
          "Attachment changed during transfer; assignment remains reserved",
        );
      return {
        fileName: frozen.fileName,
        mime: frozen.mime,
        sizeBytes: frozen.sizeBytes,
        sha256: frozen.sha256,
        contentBase64: content.toString("base64"),
      };
    },
    async executionControl(input) {
      const execution = store.executions.get(input);
      if (input.action !== "refresh" && execution.releasedAt)
        return {
          ok: false,
          message:
            "This execution is terminal. Create a fresh assignment for new work.",
        };
      if (
        input.action !== "refresh" &&
        !execution.lastConfirmed?.capabilities.includes(input.action)
      )
        return {
          ok: false,
          message:
            "This backend has not advertised that action. Refresh its execution state.",
        };
      if (
        (input.action === "start" || input.action === "resume") &&
        store.executions.checkDrift(execution).driftReason
      )
        return {
          ok: false,
          message:
            "Task changed after assignment. Reconcile the frozen assignment before controlling execution.",
        };
      try {
        if (execution.ownerPluginId === "tasks") {
          if (input.action !== "refresh" && input.action !== "stop")
            return {
              ok: false,
              message:
                "Use the linked local thread to continue this assignment.",
            };
          for (const threadId of execution.localThreadIds) {
            if (input.action === "stop")
              await bb.sdk.threads.stop({ threadId });
            else {
              const thread = await bb.sdk.threads.get({ threadId });
              if (thread.deletedAt !== null)
                for (const closed of store.executions.closeLocalThread(
                  threadId,
                ))
                  changed(closed);
            }
          }
          if (!execution.localThreadIds.length)
            return {
              ok: false,
              message:
                "The local start has no confirmed thread identity. Its reservation is retained.",
            };
          return {
            ok: true,
            message:
              input.action === "stop"
                ? "Stop requested. The assignment remains reserved."
                : "Local thread identities confirmed.",
          };
        }
        const result = await bb.sdk.plugins.callRpc({
          pluginId: execution.ownerPluginId,
          method: "executionControl",
          input,
          outputSchema: executionRpcContract.executionControl.output,
        });
        return executionRpcContract.executionControl.output.parse(result);
      } catch (error) {
        const current = store.executions.get(input);
        const message = `Execution backend unavailable: ${errorMessage(error)}. ${current.releasedAt ? "The terminal outcome is already confirmed." : "The assignment remains reserved."}`;
        if (!current.releasedAt) {
          changed(
            store.executions.uncertain(input, current.ownerPluginId, message),
          );
        }
        return { ok: false, message };
      }
    },
  };
}
export function registerExecutions(bb: BbPluginApi, store: TasksApiStore) {
  bb.rpc.register(executionRpcContract, executionHandlers(bb, store));
}
