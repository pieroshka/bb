import { randomUUID } from "node:crypto";
import { z } from "zod";
import { sanitizeProviderHttpHeaders, type ThreadEvent } from "@bb/domain";
import { experimental_upstreamHttpUrl } from "@bb/provider-bridge-protocol/bridge-kit";
import { UpstreamHttpGateway } from "./upstream-http-gateway.js";

const sessionCommand = z
  .object({
    threadId: z.string(),
    clientRequestId: z.string().optional(),
    options: z
      .object({ envVars: z.record(z.string(), z.string()).optional() })
      .passthrough(),
  })
  .passthrough();

interface CaptureSession {
  gateway: UpstreamHttpGateway | null;
  providerId: string;
  clientRequestId: string | null;
  turnId: string | null;
  nativeRequestNumber: number;
  responses: number;
}

export class UpstreamHttpCapture {
  private readonly sessions = new Map<string, CaptureSession>();
  constructor(private readonly emit: (event: ThreadEvent) => void) {}

  async prepare<TMessage extends { method: string; params?: unknown }>(
    providerId: string,
    message: TMessage,
  ): Promise<TMessage> {
    if (
      ![
        "thread/start",
        "thread/resume",
        "thread/fork",
        "turn/start",
        "turn/steer",
      ].includes(message.method)
    )
      return message;
    const parsed = sessionCommand.safeParse(message.params);
    if (!parsed.success) return message;
    const params = parsed.data;
    const env = { ...params.options.envVars };
    const enabled = env.BB_UPSTREAM_CAPTURE === "1";
    let session = this.sessions.get(params.threadId);
    if (!session) {
      session = {
        gateway: null,
        providerId,
        clientRequestId: null,
        turnId: null,
        nativeRequestNumber: 0,
        responses: 0,
      };
      this.sessions.set(params.threadId, session);
    }
    if (params.clientRequestId !== undefined) {
      session.clientRequestId = params.clientRequestId;
      session.responses = 0;
      if (message.method === "turn/start") session.turnId = null;
    }
    if (!enabled) return message;
    if (!session.gateway) {
      const targetSession = session;
      session.gateway = new UpstreamHttpGateway((metadata) => {
        if (metadata.kind === "response") targetSession.responses++;
        this.emit({
          type: "provider/http",
          threadId: params.threadId,
          providerId,
          scope: { kind: "thread" },
          metadata,
        });
      });
    }
    const gateway = await session.gateway.start();
    session.gateway.setContext({
      clientRequestId: session.clientRequestId,
      turnId: session.turnId,
    });
    env.BB_UPSTREAM_GATEWAY = gateway;
    const endpoints = env.BB_UPSTREAM_ENDPOINTS
      ? z
          .record(
            z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
            z.string().url(),
          )
          .parse(JSON.parse(env.BB_UPSTREAM_ENDPOINTS))
      : {};
    for (const [name, endpoint] of Object.entries(endpoints))
      env[name] = experimental_upstreamHttpUrl(gateway, endpoint);
    return {
      ...message,
      params: { ...params, options: { ...params.options, envVars: env } },
    };
  }

  observe(event: ThreadEvent): void {
    const session = this.sessions.get(event.threadId);
    if (!session) return;
    if (event.type === "turn/started" && event.scope.kind === "turn") {
      session.turnId = event.scope.turnId;
      session.gateway?.setContext({
        clientRequestId: session.clientRequestId,
        turnId: session.turnId,
      });
    }
    if (event.type === "turn/completed" && session.responses === 0) {
      this.emit({
        type: "provider/http",
        threadId: event.threadId,
        providerId: session.providerId,
        scope: { kind: "thread" },
        metadata: {
          kind: "capture",
          state: "unavailable",
          reason:
            "No upstream HTTP response was observed for this dispatch. The harness may have bypassed capture, failed before receiving headers, or used a non-HTTP transport.",
          clientRequestId: session.clientRequestId,
        },
      });
    }
  }

  native(
    threadId: string,
    providerId: string,
    status: number,
    headers: string[],
    truncated: boolean,
  ): void {
    const session = this.sessions.get(threadId);
    if (!session) return;
    session.responses++;
    const sanitized = sanitizeProviderHttpHeaders(headers);
    sanitized.truncated ||= truncated;
    this.emit({
      type: "provider/http",
      threadId,
      providerId,
      scope: { kind: "thread" },
      metadata: {
        kind: "response",
        source: "native",
        status,
        headers: sanitized,
        requestId: randomUUID(),
        requestNumber: ++session.nativeRequestNumber,
        clientRequestId: session.clientRequestId,
        turnId: session.turnId,
        method: null,
        origin: null,
        receivedAt: Date.now(),
      },
    });
  }

  async release(threadId: string): Promise<void> {
    const session = this.sessions.get(threadId);
    this.sessions.delete(threadId);
    await session?.gateway?.close();
  }

  async close(): Promise<void> {
    await Promise.all(
      [...this.sessions.keys()].map((threadId) => this.release(threadId)),
    );
  }
}
