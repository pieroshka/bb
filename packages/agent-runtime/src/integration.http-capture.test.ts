import { fileURLToPath } from "node:url";
import http from "node:http";
import { once } from "node:events";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import type { ThreadEvent } from "@bb/domain";
import { createAgentRuntime } from "./runtime.js";
import { resolveIntegrationBridgeLaunch } from "./test/integration-provider-bridges.js";

it.each([
  { providerId: "codex", auth: "api" },
  { providerId: "codex", auth: "chatgpt" },
  { providerId: "codex", auth: "builtin-api" },
  { providerId: "claude-code", auth: "settings" },
  { providerId: "claude-code", auth: "local-settings" },
  { providerId: "pi", auth: "api" },
  { providerId: "acp-capture", auth: "endpoint" },
])(
  "captures actual HTTP headers through $providerId ($auth)",
  async ({ providerId, auth }) => {
    const root = await mkdtemp(join(tmpdir(), "bb-http-harness-"));
    const events: ThreadEvent[] = [];
    const stderr: string[] = [];
    const server = http.createServer((_req, res) => {
      res.writeHead(401, {
        "content-type": "application/json",
        "x-bb-capture-proof": providerId,
        "set-cookie": "secret=must-not-reach-plugin",
      });
      res.end(
        JSON.stringify({
          type: "error",
          error: {
            type: "authentication_error",
            message: "Intentional local test response",
          },
        }),
      );
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("Missing fixture address");
    const endpoint = `http://127.0.0.1:${address.port}`;
    const codexHome = join(root, "codex");
    const claudeHome = join(root, "claude");
    const piHome = join(root, "pi");
    await Promise.all([codexHome, claudeHome, piHome].map((dir) => mkdir(dir)));
    await writeFile(
      join(codexHome, "config.toml"),
      `model = "gpt-5.1-codex"\nmodel_provider = "capture"\n[model_providers.capture]\nname = "Capture fixture"\nbase_url = "${endpoint}/v1"\nwire_api = "responses"\nenv_key = "OPENAI_API_KEY"\nrequest_max_retries = 0\nstream_max_retries = 0\nsupports_websockets = false\n`,
    );
    if (auth === "builtin-api")
      await writeFile(
        join(codexHome, "config.toml"),
        `model = "gpt-5.1-codex"\n`,
      );
    if (auth === "chatgpt") {
      const jwt = (payload: object) =>
        Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url") +
        "." +
        Buffer.from(JSON.stringify(payload)).toString("base64url") +
        ".fixture";
      const token = jwt({
        exp: 4102444800,
        "https://api.openai.com/auth": {
          chatgpt_account_id: "fixture-account",
          chatgpt_plan_type: "pro",
          chatgpt_user_id: "fixture-user",
        },
        email: "fixture@example.com",
      });
      await writeFile(
        join(codexHome, "auth.json"),
        JSON.stringify({
          auth_mode: "chatgpt",
          tokens: {
            id_token: token,
            access_token: token,
            refresh_token: "fixture-refresh",
            account_id: "fixture-account",
          },
          last_refresh: new Date().toISOString(),
        }),
      );
      await writeFile(
        join(codexHome, "config.toml"),
        `model = "gpt-5.1-codex"\nchatgpt_base_url = "${endpoint}"\n`,
      );
    }
    if (auth === "settings")
      await writeFile(
        join(claudeHome, "settings.json"),
        JSON.stringify({
          env: {
            ANTHROPIC_BASE_URL: endpoint,
            ANTHROPIC_API_KEY: "fixture-key",
          },
        }),
      );
    if (auth === "local-settings") {
      await mkdir(join(root, ".claude"));
      await writeFile(
        join(claudeHome, "settings.json"),
        JSON.stringify({ env: { ANTHROPIC_BASE_URL: "http://127.0.0.1:1" } }),
      );
      await writeFile(
        join(root, ".claude/settings.json"),
        JSON.stringify({ env: { ANTHROPIC_BASE_URL: "http://127.0.0.1:2" } }),
      );
      await writeFile(
        join(root, ".claude/settings.local.json"),
        JSON.stringify({ env: { ANTHROPIC_BASE_URL: endpoint } }),
      );
    }
    await writeFile(
      join(root, ".claude.json"),
      JSON.stringify({ hasCompletedOnboarding: true }),
    );
    await writeFile(
      join(piHome, "models.json"),
      JSON.stringify({
        providers: {
          capture: {
            baseUrl: endpoint,
            api: "anthropic-messages",
            apiKey: "fixture-key",
            models: [
              {
                id: "capture-model",
                name: "Capture",
                reasoning: false,
                input: ["text"],
                contextWindow: 200000,
                maxTokens: 4096,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              },
            ],
          },
        },
      }),
    );
    const env = {
      HOME: root,
      CODEX_HOME: codexHome,
      CLAUDE_CONFIG_DIR: claudeHome,
      PI_CODING_AGENT_DIR: piHome,
      ANTHROPIC_BASE_URL: auth === "settings" ? "" : endpoint,
      ANTHROPIC_API_KEY: "fixture-key",
      ANTHROPIC_AUTH_TOKEN: "",
      OPENAI_BASE_URL: endpoint + "/v1",
      OPENAI_API_KEY: auth === "chatgpt" ? "" : "fixture-key",
      CODEX_API_KEY: auth === "chatgpt" ? "" : "fixture-key",
      CODEX_OPENAI_BASE_URL: "",
      CODEX_POOL_AUTH_TOKEN: "",
      BB_UPSTREAM_CAPTURE: "1",
      BB_UPSTREAM_ENDPOINTS: JSON.stringify({ CAPTURE_API_URL: endpoint }),
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      PATH: process.env.PATH ?? "",
      BB_PI_BRIDGE_COMMAND: process.execPath,
      BB_PI_BRIDGE_ARGS: JSON.stringify([
        fileURLToPath(
          new URL(
            "../../../plugins/provider-pi/node_modules/@earendil-works/pi-coding-agent/dist/cli.js",
            import.meta.url,
          ),
        ),
      ]),
    };
    const runtime = createAgentRuntime({
      workspacePath: root,
      env,
      shellEnv: env,
      onEvent: (event) => events.push(event),
      onStderr: (line) => stderr.push(line),
      onToolCall: async () => ({ contentItems: [], success: false }),
    });
    const options: Parameters<typeof runtime.startThread>[0]["options"] = {
      serviceTier: "default",
      reasoningLevel: "medium" as const,
      model:
        providerId === "codex"
          ? "gpt-5.1-codex"
          : providerId === "pi"
            ? "capture/capture-model"
            : providerId === "acp-capture"
              ? "default"
              : "claude-sonnet-4-6",
      providerOptions:
        providerId === "acp-capture"
          ? {
              acpLaunchSpec: {
                displayName: "HTTP ACP fixture",
                command: process.execPath,
                args: [
                  fileURLToPath(
                    new URL(
                      "./test/bridges/http-acp-agent.mjs",
                      import.meta.url,
                    ),
                  ),
                ],
                env: {},
              },
            }
          : {},
      permissionMode: "full" as const,
      permissionScope: "full" as const,
      approvalReviewer: null,
      permissionEscalation: null,
    };
    try {
      await runtime.startThread({
        bridgeLaunch: resolveIntegrationBridgeLaunch(providerId),
        environmentId: "env-http",
        threadId: "thr-http",
        projectId: "proj-http",
        providerId,
        options,
      });
      await runtime.runTurn({
        threadId: "thr-http",
        clientRequestId: "creq_222222222x",
        input: [{ type: "text", text: "Say hello", mentions: [] }],
        options,
      });
      await expect
        .poll(
          () =>
            events.filter(
              (event) =>
                event.type === "provider/http" &&
                event.metadata.kind === "response",
            ),
          {
            timeout: 45000,
            message: "Expected response metadata from the real provider bridge",
          },
        )
        .toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              threadId: "thr-http",
              providerId,
              metadata: expect.objectContaining({
                status: 401,
                clientRequestId: "creq_222222222x",
                headers: expect.objectContaining({
                  entries: expect.arrayContaining([
                    { name: "x-bb-capture-proof", value: providerId },
                  ]),
                  redacted: ["set-cookie"],
                }),
              }),
            }),
          ]),
        );
      expect(
        JSON.stringify(
          events.filter((event) => event.type === "provider/http"),
        ),
      ).not.toContain("must-not-reach-plugin");
    } catch (error) {
      throw new Error(
        `${String(error)}\n${stderr.slice(-10).join("\n")}\n${JSON.stringify(events.filter((event) => event.type === "provider/error" || event.type === "system/error" || event.type === "provider/http"))}`,
        { cause: error },
      );
    } finally {
      await runtime.shutdown();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    }
  },
  90000,
);
