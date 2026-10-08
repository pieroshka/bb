import { useEffect, useState } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import { Button } from "@/components/ui/button";
import type { Task } from "../shared/contract";
import { errorMessage } from "../shared/errors";
import type {
  Execution,
  ExecutionAction,
  ExecutionRpcContract,
} from "./contract";

function executionLabel(
  execution: Pick<
    Execution,
    "lastConfirmed" | "backendId" | "uncertainReason" | "driftReason"
  >,
) {
  const projection = execution.lastConfirmed;
  return `${projection?.backendLabel ?? execution.backendId} · ${execution.uncertainReason ? "Sync uncertain" : execution.driftReason ? "Changes held" : (projection?.stage ?? projection?.phase ?? "Reserved")}`;
}

export function ExecutionIndicator({ task }: { task: Task }) {
  if (!task.execution) return null;
  return (
    <span
      className="max-w-48 truncate rounded-md border border-border px-1.5 py-px text-xs text-muted-foreground"
      title={executionLabel(task.execution)}
    >
      {executionLabel(task.execution)}
    </span>
  );
}

const ACTION_LABELS: Record<ExecutionAction, string> = {
  start: "Start",
  pause: "Pause",
  resume: "Resume",
  stop: "Stop",
  refresh: "Refresh",
};

export function ExecutionSection({ task }: { task: Task }) {
  const rpc = useRpc<ExecutionRpcContract>();
  const [pending, setPending] = useState<ExecutionAction | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [history, setHistory] = useState<Execution[] | null>(null);
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);
  const execution = task.execution;
  if (!execution) return <PrepareExecution taskId={task.id} />;
  const projection = execution.lastConfirmed;
  const actions = new Set<ExecutionAction>([
    "refresh",
    ...(execution.releasedAt ? [] : (projection?.capabilities ?? [])),
  ]);
  async function control(action: ExecutionAction) {
    if (!execution) return;
    setPending(action);
    setMessage(null);
    try {
      const result = await rpc.call("executionControl", {
        executionId: execution.executionId,
        generation: execution.generation,
        assignmentId: execution.assignmentId,
        action,
      });
      setMessage(
        result.message ??
          (result.ok
            ? "Execution action accepted"
            : "Execution action unavailable"),
      );
    } catch (error) {
      setMessage(errorMessage(error));
    } finally {
      setPending(null);
    }
  }
  return (
    <section
      aria-label="Execution"
      className="mt-6 rounded-lg border border-border p-4"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold">Execution</h2>
        <span className="text-xs text-muted-foreground">
          Assignment {execution.generation}
          {execution.releasedAt ? " · Closed" : " · Reserved"}
        </span>
      </div>
      <p className="mt-2 text-sm font-medium">{executionLabel(execution)}</p>
      {projection?.waitReason ? (
        <p className="mt-1 text-sm text-muted-foreground">
          {projection.waitReason}
        </p>
      ) : null}
      {execution.uncertainReason ? (
        <p role="status" className="mt-2 text-sm text-muted-foreground">
          {execution.uncertainReason}
        </p>
      ) : null}
      {execution.driftReason ? (
        <p role="status" className="mt-2 text-sm text-muted-foreground">
          {execution.driftReason}
        </p>
      ) : null}
      <p className="mt-2 text-xs text-muted-foreground">
        {projection ? (
          <>
            Last confirmed{" "}
            <time dateTime={projection.confirmedAt}>
              {new Date(projection.confirmedAt).toLocaleString()}
            </time>
            {now - Date.parse(projection.confirmedAt) > 120_000
              ? " · May be stale"
              : ""}
          </>
        ) : (
          "No remote state confirmed yet. The assignment remains reserved."
        )}
      </p>
      {projection?.remoteUrl ? (
        <a
          className="mt-2 inline-block text-sm underline"
          href={projection.remoteUrl}
          target="_blank"
          rel="noreferrer"
        >
          Open execution
        </a>
      ) : null}
      {(projection?.pullRequests.length ?? 0) > 0 ? (
        <ul className="mt-2 space-y-1 text-sm">
          {projection?.pullRequests.map((pr) => (
            <li key={pr.url}>
              <a
                className="underline"
                href={pr.url}
                target="_blank"
                rel="noreferrer"
              >
                {pr.title || "Pull request"}
              </a>{" "}
              <span className="text-muted-foreground">{pr.state}</span>
            </li>
          ))}
        </ul>
      ) : null}
      {(projection?.evidence.length ?? 0) > 0 ? (
        <ul className="mt-2 space-y-1 text-sm">
          {projection?.evidence.map((evidence) => (
            <li key={evidence.url}>
              <a
                className="underline"
                href={evidence.url}
                target="_blank"
                rel="noreferrer"
              >
                {evidence.label || "Evidence"}
              </a>
            </li>
          ))}
        </ul>
      ) : null}
      <div className="mt-3 flex flex-wrap gap-2">
        {[...actions].map((action) => (
          <Button
            key={action}
            size="sm"
            variant="outline"
            disabled={pending !== null}
            onClick={() => void control(action)}
          >
            {pending === action ? "Working…" : ACTION_LABELS[action]}
          </Button>
        ))}
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            void rpc.call("executionGet", { taskId: task.id }).then(
              (result) => setHistory(result.history),
              (error: unknown) => setMessage(errorMessage(error)),
            );
          }}
        >
          History
        </Button>
      </div>
      {message ? (
        <p role="status" className="mt-2 text-sm text-muted-foreground">
          {message}
        </p>
      ) : null}
      {execution.releasedAt ? (
        <PrepareExecution taskId={task.id} heading="New execution" />
      ) : null}
      {history ? (
        <ol
          aria-label="Execution history"
          className="mt-3 space-y-2 text-xs text-muted-foreground"
        >
          {history.map((entry) => (
            <li key={entry.executionId}>
              Assignment {entry.generation} · {executionLabel(entry)} ·{" "}
              {entry.releasedAt ? "Closed" : "Reserved"}
            </li>
          ))}
        </ol>
      ) : null}
    </section>
  );
}

function PrepareExecution({
  taskId,
  heading = "Execution",
}: {
  taskId: string;
  heading?: string;
}) {
  const rpc = useRpc<ExecutionRpcContract>();
  const [state, setState] = useState<{
    available: boolean;
    message: string;
    backendLabel: string | null;
  } | null>(null);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  useEffect(() => {
    let current = true;
    void rpc.call("executionPreflight", { taskId }).then(
      (result) => {
        if (current) setState(result);
      },
      () => {
        if (current)
          setState({
            available: false,
            message:
              "Execution backend is unavailable. You can continue editing this task.",
            backendLabel: null,
          });
      },
    );
    return () => {
      current = false;
    };
  }, [rpc, taskId]);
  return (
    <section
      aria-label="Execution"
      className="mt-6 rounded-lg border border-border p-4"
    >
      <h2 className="text-sm font-semibold">{heading}</h2>
      <p className="mt-2 text-sm text-muted-foreground">
        {state?.backendLabel ? `${state.backendLabel} · ` : ""}
        {message ?? state?.message ?? "Checking execution backend…"}
      </p>
      {state?.available ? (
        <Button
          className="mt-3"
          size="sm"
          variant="outline"
          disabled={pending}
          onClick={() => {
            setPending(true);
            void rpc
              .call("executionPrepare", { taskId })
              .then(
                (result) =>
                  setMessage(
                    result.message ??
                      "Assignment prepared. Start it when ready.",
                  ),
                (error: unknown) => setMessage(errorMessage(error)),
              )
              .finally(() => setPending(false));
          }}
        >
          {pending ? "Preparing…" : "Prepare execution"}
        </Button>
      ) : null}
    </section>
  );
}
