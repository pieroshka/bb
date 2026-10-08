import { createInterface } from "node:readline";

const lines = createInterface({ input: process.stdin });
const send = (id, result) =>
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
for await (const line of lines) {
  const message = JSON.parse(line);
  if (message.id === undefined) continue;
  switch (message.method) {
    case "initialize":
      send(message.id, {
        protocolVersion: 1,
        agentCapabilities: { loadSession: false },
        authMethods: [],
      });
      break;
    case "session/new":
      send(message.id, { sessionId: "http-acp-session" });
      break;
    case "session/prompt": {
      const response = await fetch(process.env.CAPTURE_API_URL, {
        method: "POST",
        body: "hello",
      });
      await response.arrayBuffer();
      send(message.id, { stopReason: "end_turn" });
      break;
    }
    default:
      send(message.id, {});
  }
}
