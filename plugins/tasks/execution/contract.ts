import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

const text = z.string().min(1);
const revision = z.number().int().nonnegative();
const url = z
  .string()
  .url()
  .refine((value) => /^https?:\/\//.test(value));
export const executionIdentitySchema = z
  .object({
    executionId: text,
    generation: z.number().int().positive(),
    assignmentId: text,
  })
  .strict();
export const executionActionSchema = z.enum([
  "start",
  "pause",
  "resume",
  "stop",
  "refresh",
]);
export const requirementsSchema = z
  .object({
    title: z.string(),
    description: z.string(),
    projectId: text,
    parentTaskId: z.string().nullable(),
    priority: z.string(),
    dueDate: z.string().nullable(),
    labelIds: z.array(z.string()),
    attachments: z.array(
      z
        .object({
          id: text,
          fileName: z.string(),
          mime: z.string(),
          sizeBytes: revision,
          sha256: text,
        })
        .strict(),
    ),
    comments: z.array(
      z.object({ id: text, body: z.string(), createdAt: z.string() }).strict(),
    ),
  })
  .strict();
export const executionSnapshotSchema = z
  .object({
    taskId: text,
    taskRevision: revision,
    requirementsFingerprint: text,
    requirements: requirementsSchema,
    status: z.enum([
      "backlog",
      "todo",
      "in_progress",
      "in_review",
      "done",
      "canceled",
    ]),
  })
  .strict();
export const executionProjectionSchema = z
  .object({
    backendLabel: text,
    remoteRevision: text,
    phase: z.enum(["pending", "running", "waiting", "stopped", "terminal"]),
    stage: z.string().nullable(),
    waitReason: z.string().nullable(),
    remoteUrl: url.nullable(),
    pullRequests: z.array(
      z.object({ url, title: z.string(), state: z.string() }).strict(),
    ),
    evidence: z.array(z.object({ label: z.string(), url }).strict()),
    capabilities: z.array(executionActionSchema),
    confirmedAt: z.string().datetime(),
    completion: z
      .object({
        assignmentId: text,
        requirementsFingerprint: text,
        remoteRevision: text,
        verified: z.literal(true),
        outcome: z.enum(["done", "failed", "canceled", "not_started"]),
      })
      .strict()
      .nullable(),
  })
  .strict();
export const executionSchema = executionIdentitySchema
  .extend({
    taskId: text,
    ownerPluginId: text,
    backendId: text,
    connectionId: text,
    snapshot: executionSnapshotSchema,
    acceptedTaskRevision: revision,
    projectionRevision: revision,
    lastConfirmed: executionProjectionSchema.nullable(),
    uncertainReason: z.string().nullable(),
    driftReason: z.string().nullable(),
    createdAt: z.string(),
    releasedAt: z.string().nullable(),
    localThreadIds: z.array(z.string()),
  })
  .strict();
export const executionSummarySchema = executionSchema
  .omit({ snapshot: true, acceptedTaskRevision: true, localThreadIds: true })
  .strict();
const identity = executionIdentitySchema.shape;
export const executionRpcContract = defineRpcContract({
  executionPreflight: {
    input: z.object({ taskId: text }).strict(),
    output: z
      .object({
        available: z.boolean(),
        message: z.string(),
        backendLabel: z.string().nullable(),
      })
      .strict(),
  },
  executionPrepare: {
    input: z.object({ taskId: text }).strict(),
    output: z
      .object({ ok: z.boolean(), message: z.string().nullable() })
      .strict(),
  },
  executionSnapshot: {
    input: z.object({ taskId: text }).strict(),
    output: executionSnapshotSchema,
  },
  executionReserve: {
    input: z
      .object({
        taskId: text,
        expectedTaskRevision: revision,
        requirementsFingerprint: text,
        backendId: text,
        connectionId: text,
        assignmentId: text,
      })
      .strict(),
    output: z.object({ execution: executionSchema }).strict(),
  },
  executionGet: {
    input: z.object({ taskId: text }).strict(),
    output: z
      .object({
        active: executionSchema.nullable(),
        history: z.array(executionSchema),
      })
      .strict(),
  },
  executionConfirm: {
    input: z
      .object({
        ...identity,
        expectedProjectionRevision: revision,
        projection: executionProjectionSchema,
        requestedTaskStatus: executionSnapshotSchema.shape.status.optional(),
      })
      .strict(),
    output: z
      .object({ execution: executionSchema, statusApplied: z.boolean() })
      .strict(),
  },
  executionMarkUncertain: {
    input: z.object({ ...identity, message: text }).strict(),
    output: z.object({ execution: executionSchema }).strict(),
  },
  executionAttachment: {
    input: z.object({ ...identity, attachmentId: text }).strict(),
    output: z
      .object({
        fileName: z.string(),
        mime: z.string(),
        sizeBytes: revision,
        sha256: text,
        contentBase64: z.string(),
      })
      .strict(),
  },
  executionControl: {
    input: z.object({ ...identity, action: executionActionSchema }).strict(),
    output: z
      .object({ ok: z.boolean(), message: z.string().nullable() })
      .strict(),
  },
});
export type ExecutionRpcContract = typeof executionRpcContract;
export type Execution = z.infer<typeof executionSchema>;
export type ExecutionSnapshot = z.infer<typeof executionSnapshotSchema>;
export type ExecutionProjection = z.infer<typeof executionProjectionSchema>;
export type ExecutionIdentity = z.infer<typeof executionIdentitySchema>;
export type ExecutionAction = z.infer<typeof executionActionSchema>;
