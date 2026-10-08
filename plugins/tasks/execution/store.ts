import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { createHash, randomUUID } from "node:crypto";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { TasksStore } from "../db";
import { readAttachmentContent } from "../attachments";
import {
  executionSchema,
  executionProjectionSchema,
  type Execution,
  type ExecutionIdentity,
  type ExecutionProjection,
  type ExecutionSnapshot,
} from "./contract";

type Database = ReturnType<BbPluginApi["storage"]["database"]>;
type Row = { data: string };
export function sha256(content: string | Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

export function createExecutionStore(db: Database, tasks: TasksStore) {
  function revision(taskId: string): number {
    const row = db
      .prepare<
        [string],
        { execution_revision: number }
      >("SELECT execution_revision FROM tasks WHERE id = ?")
      .get(taskId);
    if (!row) throw new Error(`Task not found: ${taskId}`);
    return row.execution_revision;
  }
  function decode(row: Row | undefined): Execution | null {
    return row ? executionSchema.parse(JSON.parse(row.data)) : null;
  }
  function active(taskId: string): Execution | null {
    return decode(
      db
        .prepare<
          [string],
          Row
        >("SELECT data FROM task_executions WHERE task_id = ? AND released_at IS NULL")
        .get(taskId),
    );
  }
  function latest(taskId: string): Execution | null {
    return decode(
      db
        .prepare<
          [string],
          Row
        >("SELECT data FROM task_executions WHERE task_id = ? ORDER BY generation DESC LIMIT 1")
        .get(taskId),
    );
  }
  function history(taskId: string): Execution[] {
    return db
      .prepare<[string], Row>(
        "SELECT data FROM task_executions WHERE task_id = ? ORDER BY generation DESC",
      )
      .all(taskId)
      .map((row) => executionSchema.parse(JSON.parse(row.data)));
  }
  function get(identity: ExecutionIdentity, ownerPluginId?: string): Execution {
    const execution = decode(
      db
        .prepare<[string], Row>("SELECT data FROM task_executions WHERE id = ?")
        .get(identity.executionId),
    );
    if (
      !execution ||
      execution.generation !== identity.generation ||
      execution.assignmentId !== identity.assignmentId ||
      (ownerPluginId !== undefined && execution.ownerPluginId !== ownerPluginId)
    ) {
      throw new Error("Execution identity or owner does not match");
    }
    return execution;
  }
  function save(execution: Execution): Execution {
    db.prepare<[string | null, string, string]>(
      "UPDATE task_executions SET released_at = ?, data = ? WHERE id = ?",
    ).run(
      execution.releasedAt,
      JSON.stringify(executionSchema.parse(execution)),
      execution.executionId,
    );
    return execution;
  }
  async function snapshot(taskId: string): Promise<ExecutionSnapshot> {
    const before = revision(taskId);
    const task = tasks.getTask(taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);
    const comments = tasks
      .listComments(taskId)
      .filter((comment) => comment.kind !== "system")
      .map(({ id, body, createdAt }) => ({ id, body, createdAt }));
    const files = [
      ...tasks.listAttachmentsForTask(taskId),
      ...tasks.listAttachmentsForTaskComments(taskId),
    ].sort((a, b) => a.id.localeCompare(b.id));
    const attachments = [];
    for (const file of files) {
      const { content } = await readAttachmentContent(tasks, file.id);
      if (content.byteLength !== file.sizeBytes)
        throw new Error("Attachment content changed; execution snapshot held");
      attachments.push({
        id: file.id,
        fileName: file.fileName,
        mime: file.mime,
        sizeBytes: file.sizeBytes,
        sha256: sha256(content),
      });
    }
    if (revision(taskId) !== before)
      throw new Error(
        "Task changed while preparing execution; refresh its snapshot",
      );
    const requirements = {
      title: task.title,
      description: task.description,
      projectId: task.projectId,
      parentTaskId: task.parentTaskId,
      priority: task.priority,
      dueDate: task.dueDate,
      labelIds: tasks
        .listTaskLabels(taskId)
        .map((label) => label.labelId)
        .sort(),
      attachments,
      comments,
    };
    return {
      taskId,
      taskRevision: before,
      requirementsFingerprint: sha256(JSON.stringify(requirements)),
      requirements,
      status: task.status,
    };
  }
  function reserve(input: {
    snapshot: ExecutionSnapshot;
    ownerPluginId: string;
    backendId: string;
    connectionId: string;
    assignmentId: string;
    existingThreadId?: string;
  }): Execution {
    return db.transaction(() => {
      const previous = decode(
        db
          .prepare<
            [string, string],
            Row
          >("SELECT data FROM task_executions WHERE owner_plugin_id = ? AND assignment_id = ?")
          .get(input.ownerPluginId, input.assignmentId),
      );
      if (previous) {
        if (
          previous.taskId !== input.snapshot.taskId ||
          previous.backendId !== input.backendId ||
          previous.connectionId !== input.connectionId ||
          previous.snapshot.requirementsFingerprint !==
            input.snapshot.requirementsFingerprint ||
          previous.snapshot.taskRevision !== input.snapshot.taskRevision
        )
          throw new Error(
            "Assignment identity was already used with different requirements",
          );
        return previous;
      }
      const held = active(input.snapshot.taskId);
      if (held)
        throw new Error(
          `Task execution is reserved by ${held.backendId} (${held.assignmentId}); reconcile its existing assignment before delegating`,
        );
      if (revision(input.snapshot.taskId) !== input.snapshot.taskRevision)
        throw new Error(
          "Task changed before execution reservation; refresh its snapshot",
        );
      const legacy = tasks
        .listTaskThreads(input.snapshot.taskId)
        .filter(
          (thread) =>
            thread.liveStatus !== "completed" &&
            thread.threadId !== input.existingThreadId,
        );
      if (legacy.length)
        throw new Error(
          "Task has existing worker threads without confirmed terminal execution; reconcile them before delegating",
        );
      const generation =
        db
          .prepare<
            [string],
            { generation: number }
          >("SELECT COALESCE(MAX(generation), 0) + 1 AS generation FROM task_executions WHERE task_id = ?")
          .get(input.snapshot.taskId)?.generation ?? 1;
      const execution: Execution = {
        executionId: randomUUID(),
        generation,
        assignmentId: input.assignmentId,
        taskId: input.snapshot.taskId,
        ownerPluginId: input.ownerPluginId,
        backendId: input.backendId,
        connectionId: input.connectionId,
        snapshot: input.snapshot,
        acceptedTaskRevision: input.snapshot.taskRevision,
        projectionRevision: 0,
        lastConfirmed: null,
        uncertainReason: null,
        driftReason: null,
        createdAt: new Date().toISOString(),
        releasedAt: null,
        localThreadIds: [],
      };
      db.prepare<[string, string, number, string, string, string]>(
        "INSERT INTO task_executions (id, task_id, generation, owner_plugin_id, assignment_id, data) VALUES (?, ?, ?, ?, ?, ?)",
      ).run(
        execution.executionId,
        execution.taskId,
        generation,
        execution.ownerPluginId,
        execution.assignmentId,
        JSON.stringify(execution),
      );
      return execution;
    })();
  }
  function checkDrift(execution: Execution): Execution {
    if (
      execution.releasedAt !== null ||
      execution.driftReason ||
      revision(execution.taskId) === execution.acceptedTaskRevision
    )
      return execution;
    return {
      ...execution,
      driftReason:
        "Task requirements or status changed after assignment. Automatic status synchronization is held.",
    };
  }
  function confirm(
    identity: ExecutionIdentity,
    owner: string,
    expectedProjectionRevision: number,
    projection: ExecutionProjection,
    requestedTaskStatus?: ExecutionSnapshot["status"],
  ): { execution: Execution; statusApplied: boolean } {
    return db.transaction(() => {
      let execution = get(identity, owner);
      const previous = db
        .prepare<
          [string],
          { last_confirmation: string | null }
        >("SELECT last_confirmation FROM task_executions WHERE id = ?")
        .get(execution.executionId)?.last_confirmation;
      if (previous) {
        const saved = z
          .object({
            expectedProjectionRevision: z.number(),
            projection: executionProjectionSchema,
            requestedTaskStatus: z.string().nullable(),
            statusApplied: z.boolean(),
          })
          .parse(JSON.parse(previous));
        if (
          saved.expectedProjectionRevision === expectedProjectionRevision &&
          isDeepStrictEqual(saved.projection, projection) &&
          saved.requestedTaskStatus === (requestedTaskStatus ?? null)
        )
          return { execution, statusApplied: saved.statusApplied };
      }
      if (execution.releasedAt !== null)
        throw new Error(
          "Execution is already terminal; its history is immutable",
        );
      if (execution.projectionRevision !== expectedProjectionRevision)
        throw new Error(
          "Execution projection changed; reload before synchronizing",
        );
      const completion = projection.completion;
      if ((projection.phase === "terminal") !== (completion !== null))
        throw new Error(
          "Terminal execution requires verified completion facts",
        );
      if (
        completion &&
        (completion.assignmentId !== execution.assignmentId ||
          completion.requirementsFingerprint !==
            execution.snapshot.requirementsFingerprint ||
          completion.remoteRevision !== projection.remoteRevision)
      )
        throw new Error(
          "Completion facts do not match the frozen assignment and remote revision",
        );
      if (requestedTaskStatus === "done" && completion?.outcome !== "done")
        throw new Error("Done requires verified completion of this assignment");
      if (
        requestedTaskStatus === "canceled" &&
        completion?.outcome !== "canceled"
      )
        throw new Error(
          "Canceled requires verified cancellation; Stop is not cancellation",
        );
      execution = checkDrift(execution);
      let statusApplied = false;
      if (requestedTaskStatus && !execution.driftReason) {
        const task = tasks.getTask(execution.taskId);
        if (task && task.status !== requestedTaskStatus)
          tasks.updateTask(task.id, { status: requestedTaskStatus });
        execution.acceptedTaskRevision = revision(execution.taskId);
        statusApplied = true;
      }
      const milestone = (value: ExecutionProjection | null) =>
        value === null
          ? null
          : {
              phase: value.phase,
              stage: value.stage,
              waitReason: value.waitReason,
              pullRequests: value.pullRequests,
              evidence: value.evidence,
            };
      if (
        owner !== "tasks" &&
        !isDeepStrictEqual(
          milestone(execution.lastConfirmed),
          milestone(projection),
        )
      ) {
        const links = [
          ...projection.pullRequests.map(
            (pr) => `[${pr.title || "Pull request"}](${pr.url}) · ${pr.state}`,
          ),
          ...projection.evidence.map(
            (item) => `[${item.label || "Evidence"}](${item.url})`,
          ),
        ];
        tasks.createComment({
          taskId: execution.taskId,
          kind: "system",
          authorName: projection.backendLabel,
          body: [
            `Execution assignment ${execution.generation}: ${projection.stage ?? projection.phase}`,
            projection.waitReason,
            ...links,
          ]
            .filter(Boolean)
            .join("\n\n"),
        });
      }
      execution.lastConfirmed = projection;
      execution.projectionRevision += 1;
      execution.uncertainReason = null;
      if (completion) execution.releasedAt = new Date().toISOString();
      save(execution);
      db.prepare<[string, string]>(
        "UPDATE task_executions SET last_confirmation = ? WHERE id = ?",
      ).run(
        JSON.stringify({
          expectedProjectionRevision,
          projection,
          requestedTaskStatus: requestedTaskStatus ?? null,
          statusApplied,
        }),
        execution.executionId,
      );
      return { execution, statusApplied };
    })();
  }
  function uncertain(
    identity: ExecutionIdentity,
    owner: string,
    message: string,
  ): Execution {
    return db.transaction(() => {
      const execution = get(identity, owner);
      if (execution.releasedAt !== null)
        throw new Error("Execution is already terminal");
      return save({ ...checkDrift(execution), uncertainReason: message });
    })();
  }
  function attach(
    identity: ExecutionIdentity,
    owner: string,
    threadId: string,
  ): Execution {
    const execution = get(identity, owner);
    if (execution.releasedAt !== null)
      throw new Error("Cannot attach to a terminal execution");
    if (!execution.backendId.startsWith("local-"))
      throw new Error(
        "External executions cannot fabricate local worker threads",
      );
    if (!execution.localThreadIds.includes(threadId))
      execution.localThreadIds.push(threadId);
    db.prepare<[string, string]>(
      "INSERT OR IGNORE INTO task_execution_threads(execution_id, thread_id) VALUES (?, ?)",
    ).run(execution.executionId, threadId);
    return save(execution);
  }
  function closeLocalThread(threadId: string): Execution[] {
    return db.transaction(() => {
      db.prepare<[string, string]>(
        "UPDATE task_execution_threads SET closed_at = ? WHERE thread_id = ?",
      ).run(new Date().toISOString(), threadId);
      const rows = db
        .prepare<
          [string],
          Row
        >(`SELECT e.data FROM task_executions e JOIN task_execution_threads t ON t.execution_id = e.id WHERE t.thread_id = ? AND e.owner_plugin_id = 'tasks' AND e.released_at IS NULL AND NOT EXISTS (SELECT 1 FROM task_execution_threads open WHERE open.execution_id = e.id AND open.closed_at IS NULL)`)
        .all(threadId);
      return rows.map((row) => {
        const execution = executionSchema.parse(JSON.parse(row.data));
        const remoteRevision = `closed:${execution.localThreadIds.join(",")}`;
        return confirm(execution, "tasks", execution.projectionRevision, {
          backendLabel: "Local worker",
          remoteRevision,
          phase: "terminal",
          stage: "Closed",
          waitReason: null,
          remoteUrl: null,
          pullRequests: [],
          evidence: [],
          capabilities: ["refresh"],
          confirmedAt: new Date().toISOString(),
          completion: {
            assignmentId: execution.assignmentId,
            requirementsFingerprint: execution.snapshot.requirementsFingerprint,
            remoteRevision,
            verified: true,
            outcome: "failed",
          },
        }).execution;
      });
    })();
  }
  function localThreadsToReconcile(): string[] {
    return db
      .prepare<[], { thread_id: string }>(
        "SELECT DISTINCT t.thread_id FROM task_execution_threads t JOIN task_executions e ON e.id = t.execution_id WHERE t.closed_at IS NULL AND e.released_at IS NULL AND e.owner_plugin_id = 'tasks'",
      )
      .all()
      .map((row) => row.thread_id);
  }
  return {
    revision,
    snapshot,
    reserve,
    active,
    latest,
    history,
    get,
    confirm,
    uncertain,
    attach,
    checkDrift,
    closeLocalThread,
    localThreadsToReconcile,
  };
}
export type ExecutionStore = ReturnType<typeof createExecutionStore>;
