import { randomBytes, randomUUID } from "node:crypto";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import https from "node:https";
import type { Socket } from "node:net";
import {
  sanitizeProviderHttpHeaders,
  type ProviderHttpMetadata,
} from "@bb/domain";

interface GatewayContext {
  clientRequestId: string | null;
  turnId: string | null;
}

const hopHeaders = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

function forwardedHeaders(
  message: IncomingMessage,
  upgrade: boolean,
): string[] {
  const excluded = new Set(hopHeaders);
  for (const token of message.headers.connection?.split(",") ?? [])
    excluded.add(token.trim().toLowerCase());
  if (upgrade) {
    excluded.delete("upgrade");
    excluded.delete("connection");
  }
  excluded.add("host");
  const result: string[] = [];
  for (let index = 0; index + 1 < message.rawHeaders.length; index += 2) {
    if (!excluded.has(message.rawHeaders[index]!.toLowerCase()))
      result.push(message.rawHeaders[index]!, message.rawHeaders[index + 1]!);
  }
  return result;
}

export class UpstreamHttpGateway {
  private readonly token = randomBytes(32).toString("base64url");
  private readonly server = http.createServer(
    { maxHeaderSize: 1024 * 1024 },
    (req, res) => this.forward(req, res),
  );
  private readonly sockets = new Set<Socket>();
  private context: GatewayContext = { clientRequestId: null, turnId: null };
  private requestNumber = 0;
  private listening: Promise<void> | null = null;
  private origin: string | null = null;

  constructor(private readonly emit: (metadata: ProviderHttpMetadata) => void) {
    this.server.on("connection", (socket) => {
      this.sockets.add(socket);
      socket.on("close", () => this.sockets.delete(socket));
    });
    this.server.on("upgrade", (req, socket, head) => {
      const target = this.target(req.url);
      if (target === null) {
        socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
        return;
      }
      const correlation = this.correlation(req, target);
      const headers = forwardedHeaders(req, true);
      headers.push("Host", target.host);
      const upstream = this.request(target, { method: req.method, headers });
      let ended = false;
      const finish = (outcome: "completed" | "aborted" | "transport-error") => {
        if (ended) return;
        ended = true;
        this.emit({
          kind: "finished",
          ...correlation,
          outcome,
          trailers: sanitizeProviderHttpHeaders([]),
        });
      };
      upstream.on("upgrade", (response, remote, upstreamHead) => {
        this.response(response, correlation);
        socket.write(
          `HTTP/1.1 ${response.statusCode} ${response.statusMessage}\r\n`,
        );
        for (let i = 0; i + 1 < response.rawHeaders.length; i += 2)
          socket.write(
            `${response.rawHeaders[i]}: ${response.rawHeaders[i + 1]}\r\n`,
          );
        socket.write("\r\n");
        if (upstreamHead.length) socket.write(upstreamHead);
        if (head.length) remote.write(head);
        socket.pipe(remote).pipe(socket);
        remote.on("error", () => {
          finish("transport-error");
          socket.destroy();
        });
        remote.on("end", () => finish("completed"));
        socket.on("close", () => {
          finish("aborted");
          remote.destroy();
        });
      });
      upstream.on("response", (response) => {
        this.response(response, correlation);
        socket.write(
          `HTTP/1.1 ${response.statusCode} ${response.statusMessage}\r\n`,
        );
        const responseHeaders = forwardedHeaders(response, false);
        for (let i = 0; i + 1 < responseHeaders.length; i += 2)
          socket.write(`${responseHeaders[i]}: ${responseHeaders[i + 1]}\r\n`);
        socket.write("Connection: close\r\n\r\n");
        response.pipe(socket);
        response.on("end", () => finish("completed"));
        response.on("error", () => {
          finish("transport-error");
          socket.destroy();
        });
      });
      upstream.on("error", () => {
        finish("transport-error");
        socket.destroy();
      });
      socket.on("error", () => {
        finish("aborted");
        upstream.destroy();
      });
      socket.on("close", () => upstream.destroy());
      upstream.end();
    });
  }

  async start(): Promise<string> {
    this.listening ??= new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(0, "127.0.0.1", () => {
        this.server.off("error", reject);
        const address = this.server.address();
        if (address === null || typeof address === "string") {
          reject(new Error("HTTP capture did not bind a TCP port"));
          return;
        }
        this.origin = `http://127.0.0.1:${address.port}`;
        resolve();
      });
    });
    await this.listening;
    return `${this.origin}/${this.token}`;
  }

  setContext(context: GatewayContext): void {
    this.context = context;
  }

  private target(rawUrl: string | undefined): URL | null {
    const prefix = `/${this.token}/`;
    if (!rawUrl?.startsWith(prefix)) return null;
    const rest = rawUrl.slice(prefix.length);
    const slash = rest.indexOf("/");
    if (slash < 1) return null;
    try {
      const origin = new URL(
        Buffer.from(rest.slice(0, slash), "base64url").toString("utf8"),
      );
      if (
        !["http:", "https:"].includes(origin.protocol) ||
        origin.username ||
        origin.password ||
        origin.origin === this.origin
      )
        return null;
      const target = new URL(origin.origin + rest.slice(slash));
      return target.origin === origin.origin ? target : null;
    } catch {
      return null;
    }
  }

  private correlation(req: IncomingMessage, target: URL) {
    return {
      ...this.context,
      requestId: randomUUID(),
      requestNumber: ++this.requestNumber,
      method: (req.method ?? "GET").slice(0, 32),
      origin: target.origin,
      source: "gateway" as const,
    };
  }

  private request(
    target: URL,
    options: http.RequestOptions,
  ): http.ClientRequest {
    return (target.protocol === "https:" ? https : http).request(target, {
      ...options,
      maxHeaderSize: 1024 * 1024,
    });
  }

  private response(
    response: IncomingMessage,
    correlation: ReturnType<UpstreamHttpGateway["correlation"]>,
  ): void {
    this.emit({
      kind: "response",
      ...correlation,
      status: response.statusCode ?? 502,
      headers: sanitizeProviderHttpHeaders(response.rawHeaders),
      receivedAt: Date.now(),
    });
  }

  private forward(req: IncomingMessage, res: ServerResponse): void {
    const target = this.target(req.url);
    if (target === null) {
      res.writeHead(403).end();
      return;
    }
    const correlation = this.correlation(req, target);
    const headers = forwardedHeaders(req, false);
    headers.push("Host", target.host);
    const upstream = this.request(target, { method: req.method, headers });
    let finished = false;
    const finish = (
      outcome: "completed" | "aborted" | "transport-error",
      trailers: readonly string[] = [],
    ) => {
      if (finished) return;
      finished = true;
      this.emit({
        kind: "finished",
        ...correlation,
        outcome,
        trailers: sanitizeProviderHttpHeaders(trailers),
      });
    };
    upstream.on("response", (response) => {
      this.response(response, correlation);
      const responseHeaders = forwardedHeaders(response, false);
      if (
        response.statusCode &&
        response.statusCode >= 300 &&
        response.statusCode < 400
      ) {
        for (let index = 0; index + 1 < responseHeaders.length; index += 2) {
          if (responseHeaders[index]!.toLowerCase() !== "location") continue;
          const redirect = URL.parse(responseHeaders[index + 1]!, target);
          if (redirect?.origin === target.origin) {
            responseHeaders[index + 1] =
              `${this.origin}/${this.token}/${Buffer.from(redirect.origin).toString("base64url")}${redirect.pathname}${redirect.search}${redirect.hash}`;
          } else if (redirect) {
            this.emit({
              kind: "capture",
              state: "unavailable",
              clientRequestId: correlation.clientRequestId,
              reason:
                "A cross-origin redirect leaves the capture gateway so the HTTP client can strip upstream credentials. The redirect response was captured; subsequent responses may be unavailable.",
            });
          }
        }
      }
      res.writeHead(response.statusCode ?? 502, responseHeaders);
      res.flushHeaders();
      response.pipe(res, { end: false });
      response.on("end", () => {
        res.addTrailers(response.trailers);
        res.end();
        finish("completed", response.rawTrailers);
      });
      response.on("error", () => {
        finish("transport-error");
        res.destroy();
      });
      res.on("close", () => response.destroy());
    });
    upstream.on("error", () => {
      finish("transport-error");
      if (!res.headersSent) res.writeHead(502).end();
      else res.destroy();
    });
    req.on("aborted", () => {
      finish("aborted");
      upstream.destroy();
    });
    req.on("error", () => {
      finish("aborted");
      upstream.destroy();
    });
    res.on("close", () => {
      if (!res.writableFinished) finish("aborted");
      upstream.destroy();
    });
    req.pipe(upstream);
  }

  async close(): Promise<void> {
    for (const socket of this.sockets) socket.destroy();
    if (!this.server.listening) return;
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
}
