import { createHash } from "node:crypto";
import { z } from "zod";
import http from "node:http";
import { gzipSync } from "node:zlib";
import { once } from "node:events";
import { expect, it, onTestFinished } from "vitest";
import {
  providerHttpMetadataSchema,
  type ProviderHttpMetadata,
  type ThreadEvent,
} from "@bb/domain";
import {
  experimental_providerHttpResponse,
  experimental_upstreamHttpUrl,
} from "@bb/provider-bridge-protocol/bridge-kit";
import { UpstreamHttpGateway } from "./upstream-http-gateway.js";
import { UpstreamHttpCapture } from "./upstream-http-capture.js";

async function fixture(handler: http.RequestListener) {
  const events: ProviderHttpMetadata[] = [];
  const server = http.createServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Missing upstream address");
  const origin = `http://127.0.0.1:${address.port}`;
  const gateway = new UpstreamHttpGateway((event) =>
    events.push(providerHttpMetadataSchema.parse(event)),
  );
  gateway.setContext({ clientRequestId: "creq_222222222x", turnId: "turn-1" });
  const base = await gateway.start();
  onTestFinished(async () => {
    await gateway.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return {
    server,
    origin,
    base,
    gateway,
    events,
    url: experimental_upstreamHttpUrl(base, origin),
  };
}

function request(
  url: string,
  init: http.RequestOptions = {},
): Promise<{
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
}> {
  return new Promise((resolve, reject) => {
    const req = http.request(url, init, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (data: Buffer) => chunks.push(data));
      res.on("error", reject);
      res.on("end", () =>
        resolve({
          status: res.statusCode!,
          headers: res.headers,
          body: Buffer.concat(chunks),
        }),
      );
    });
    req.on("error", reject);
    req.end();
  });
}

it("captures arbitrary repeated headers on retries, redacts credentials, and preserves compressed response bytes and auth", async () => {
  const payload = gzipSync("data: response\n\n");
  let attempts = 0;
  const fixtureState = await fixture((req, res) => {
    expect(req.headers.authorization).toBe("Bearer upstream-secret");
    expect(req.headers["proxy-authorization"]).toBeUndefined();
    attempts++;
    res.writeHead(attempts === 1 ? 429 : 200, [
      "content-type",
      "text/event-stream",
      "content-encoding",
      "gzip",
      "x-any-upstream-header",
      "first",
      "x-any-upstream-header",
      "second",
      "retry-after",
      "2",
      "set-cookie",
      "session=private",
      "x-api-key",
      "private-key",
      "x-ratelimit-remaining-tokens",
      "1234",
      "x-ratelimit-token-remaining",
      "42",
      "x-auth-token",
      "private-token",
      "trailer",
      "x-final-quota",
      "x-large-header",
      "a".repeat(9000),
    ]);
    res.write(payload);
    res.addTrailers({ "x-final-quota": "99" });
    res.end();
  });
  const { url, events } = fixtureState;
  for (const status of [429, 200]) {
    const result = await request(url + "v1/messages?api_key=hidden", {
      headers: {
        authorization: "Bearer upstream-secret",
        "proxy-authorization": "not-for-upstream",
      },
    });
    expect(result.status).toBe(status);
    expect(result.body).toEqual(payload);
    expect(result.headers["set-cookie"]).toEqual(["session=private"]);
  }
  const responses = events.filter((event) => event.kind === "response");
  expect(responses.map((event) => event.status)).toEqual([429, 200]);
  expect(new Set(responses.map((event) => event.requestId)).size).toBe(2);
  expect(responses.map((event) => event.requestNumber)).toEqual([1, 2]);
  expect(responses[0]).toMatchObject({
    clientRequestId: "creq_222222222x",
    turnId: "turn-1",
    headers: {
      truncated: true,
      redacted: ["set-cookie", "x-api-key", "x-auth-token"],
    },
  });
  expect(
    responses[0]!.headers.entries.filter(
      (entry) => entry.name === "x-any-upstream-header",
    ),
  ).toEqual([
    { name: "x-any-upstream-header", value: "first" },
    { name: "x-any-upstream-header", value: "second" },
  ]);
  expect(responses[0]!.headers.entries).toContainEqual({
    name: "x-ratelimit-remaining-tokens",
    value: "1234",
  });
  expect(events).toContainEqual(
    expect.objectContaining({
      kind: "finished",
      trailers: {
        entries: [{ name: "x-final-quota", value: "99" }],
        redacted: [],
        truncated: false,
      },
    }),
  );
  expect(responses[0]!.headers.entries).toContainEqual({
    name: "x-ratelimit-token-remaining",
    value: "42",
  });
  expect(JSON.stringify(events)).not.toMatch(/private|upstream-secret|hidden/);
  expect(
    events
      .filter((event) => event.kind === "finished")
      .map((event) => event.outcome),
  ).toEqual(["completed", "completed"]);
});

it("delivers headers and streaming bytes before completion, propagates cancellation, and freezes request correlation", async () => {
  let disconnected = false;
  const { url, events, gateway } = await fixture((req, res) => {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "x-upstream": "streaming",
    });
    res.write("data: first\n\n");
    req.on("close", () => {
      disconnected = true;
    });
  });
  await new Promise<void>((resolve, reject) => {
    const req = http.get(url + "stream", (res) => {
      res.once("data", (bytes: Buffer) => {
        expect(bytes.toString()).toBe("data: first\n\n");
        expect(events.some((event) => event.kind === "response")).toBe(true);
        gateway.setContext({
          clientRequestId: "next-request",
          turnId: "next-turn",
        });
        res.destroy();
        resolve();
      });
    });
    req.on("error", reject);
  });
  await expect.poll(() => disconnected).toBe(true);
  await expect
    .poll(() =>
      events.some(
        (event) => event.kind === "finished" && event.outcome === "aborted",
      ),
    )
    .toBe(true);
  expect(events.filter((event) => event.kind === "finished")).toEqual([
    expect.objectContaining({
      clientRequestId: "creq_222222222x",
      turnId: "turn-1",
    }),
  ]);
});

it("retains real response headers when the upstream stream fails and refuses unauthenticated requests", async () => {
  let calls = 0;
  const { url, base, events } = await fixture((_req, res) => {
    calls++;
    res.writeHead(503, {
      "content-length": "1000",
      "x-upstream-fault": "mid-stream",
    });
    res.write("partial");
    setTimeout(() => res.destroy(), 20);
  });
  const denied = await request(new URL("/wrong/endpoint", base).href);
  expect(denied.status).toBe(403);
  expect(calls).toBe(0);
  await expect(request(url + "fault")).rejects.toThrow();
  expect(events).toContainEqual(
    expect.objectContaining({
      kind: "response",
      status: 503,
      headers: expect.objectContaining({
        entries: expect.arrayContaining([
          { name: "x-upstream-fault", value: "mid-stream" },
        ]),
      }),
    }),
  );
  expect(events).toContainEqual(
    expect.objectContaining({ kind: "finished", outcome: "transport-error" }),
  );
});

it("isolates custom harness routes by thread and reports absence instead of inventing headers", async () => {
  const upstream = await fixture((_req, res) =>
    res.writeHead(200, { "x-custom": "actual" }).end(),
  );
  const events: ThreadEvent[] = [];
  const capture = new UpstreamHttpCapture((event) => events.push(event));
  onTestFinished(() => capture.close());
  for (const threadId of ["a", "b"]) {
    const message = await capture.prepare("custom", {
      method: "turn/start",
      params: {
        threadId,
        clientRequestId: threadId,
        options: {
          envVars: {
            BB_UPSTREAM_CAPTURE: "1",
            BB_UPSTREAM_ENDPOINTS: JSON.stringify({
              CUSTOM_API_URL: upstream.origin,
            }),
          },
        },
      },
    });
    const options = z
      .object({
        options: z.object({ envVars: z.record(z.string(), z.string()) }),
      })
      .parse(message.params);
    await request(options.options.envVars.CUSTOM_API_URL!);
  }
  expect(
    events
      .filter((event) => event.type === "provider/http")
      .map((event) => event.threadId),
  ).toEqual(["a", "a", "b", "b"]);
  await capture.prepare("opaque", {
    method: "turn/start",
    params: { threadId: "c", clientRequestId: "c", options: { envVars: {} } },
  });
  capture.observe({
    type: "turn/completed",
    threadId: "c",
    providerThreadId: "provider-c",
    scope: { kind: "turn", turnId: "turn-c" },
    status: "completed",
  });
  expect(events.at(-1)).toMatchObject({
    type: "provider/http",
    metadata: { kind: "capture", state: "unavailable" },
  });
});

it("preserves WebSocket upgrade headers and bidirectional connection lifetime", async () => {
  const { server, url, events } = await fixture((_req, res) =>
    res.writeHead(400).end(),
  );
  server.on("upgrade", (req, socket) => {
    const accept = createHash("sha1")
      .update(
        req.headers["sec-websocket-key"] +
          "258EAFA5-E914-47DA-95CA-C5AB0DC85B11",
      )
      .digest("base64");
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\nX-Upstream-WebSocket: yes\r\n\r\n`,
    );
    socket.write(Buffer.from([0x81, 5, ...Buffer.from("hello")]));
    socket.on("data", () => socket.end(Buffer.from([0x88, 0])));
    socket.on("error", () => socket.destroy());
  });
  const client = new WebSocket(url.replace("http:", "ws:") + "responses");
  onTestFinished(() => client.close());
  const [message] = await once(client, "message");
  expect(message.data).toBe("hello");
  expect(events).toContainEqual(
    expect.objectContaining({
      kind: "response",
      status: 101,
      headers: expect.objectContaining({
        entries: expect.arrayContaining([
          { name: "x-upstream-websocket", value: "yes" },
        ]),
      }),
    }),
  );
  client.close();
  await once(client, "close");
  await expect
    .poll(() => events.some((event) => event.kind === "finished"))
    .toBe(true);
});

it("sanitizes native bridge notifications before recording and preserves truncation through delivery", async () => {
  const events: ThreadEvent[] = [];
  const capture = new UpstreamHttpCapture((event) => events.push(event));
  onTestFinished(() => capture.close());
  await capture.prepare("native", {
    method: "turn/start",
    params: {
      threadId: "native-thread",
      clientRequestId: "dispatch",
      options: { envVars: {} },
    },
  });
  const notification = experimental_providerHttpResponse({
    threadId: "native-thread",
    status: 200,
    headers: [
      "x-access-token",
      "private-native-token",
      "anthropic-ratelimit-tokens-remaining",
      "500",
      "x-too-large",
      "a".repeat(9000),
    ],
  });
  expect(JSON.stringify(notification)).not.toContain("private-native-token");
  const { threadId, status, headers, truncated } = notification.params;
  capture.native(threadId, "native", status, headers, truncated);
  expect(events).toMatchObject([
    {
      type: "provider/http",
      threadId: "native-thread",
      metadata: {
        source: "native",
        clientRequestId: "dispatch",
        headers: {
          entries: [
            { name: "anthropic-ratelimit-tokens-remaining", value: "500" },
          ],
          redacted: ["x-access-token"],
          truncated: true,
        },
      },
    },
  ]);
});

it("captures same-origin redirect hops and preserves credential stripping when a redirect leaves capture", async () => {
  let receivedAuthorization: string | undefined;
  const destination = await fixture((req, res) => {
    receivedAuthorization = req.headers.authorization;
    res.end("outside");
  });
  const source = await fixture((req, res) => {
    if (req.url === "/start")
      res.writeHead(302, { location: "/finish", "x-hop": "first" }).end();
    else if (req.url === "/outside")
      res.writeHead(302, { location: destination.origin }).end();
    else res.writeHead(200, { "x-hop": "last" }).end("inside");
  });
  expect(await (await fetch(source.url + "start")).text()).toBe("inside");
  expect(
    source.events
      .filter((event) => event.kind === "response")
      .map((event) => event.status),
  ).toEqual([302, 200]);
  expect(
    await (
      await fetch(source.url + "outside", {
        headers: { authorization: "Bearer private" },
      })
    ).text(),
  ).toBe("outside");
  expect(receivedAuthorization).toBeUndefined();
  expect(source.events).toContainEqual(
    expect.objectContaining({ kind: "capture", state: "unavailable" }),
  );
});
