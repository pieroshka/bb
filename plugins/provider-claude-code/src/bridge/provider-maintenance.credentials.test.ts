import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

const state = vi.hoisted(() => ({
  keychain: "",
  file: "",
  settings: "{}",
}));

vi.mock("node:child_process", () => ({
  execFile: (
    _file: string,
    _args: readonly string[],
    _options: object,
    callback: (
      error: Error | null,
      result: { stdout: string; stderr: string },
    ) => void,
  ) => callback(null, { stdout: state.keychain, stderr: "" }),
}));

vi.mock("node:fs/promises", () => ({
  default: {
    readFile: (file: string) =>
      Promise.resolve(
        file.endsWith(".credentials.json")
          ? state.file
          : file.endsWith("settings.json")
            ? state.settings
            : JSON.stringify({ oauthAccount: { emailAddress: null } }),
      ),
  },
}));

vi.mock("@get-bb/plugin-sdk/provider-bridge", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@get-bb/plugin-sdk/provider-bridge")
  >()),
  experimental_resolveExecutablePath: () => Promise.resolve("/test/claude"),
}));

import {
  getClaudeProviderHealth,
  getClaudeProviderUsage,
} from "./provider-maintenance.js";

const originalPlatform = process.platform;

beforeAll(() => {
  Object.defineProperty(process, "platform", {
    configurable: true,
    value: "darwin",
  });
});

afterAll(() => {
  Object.defineProperty(process, "platform", {
    configurable: true,
    value: originalPlatform,
  });
  vi.unstubAllGlobals();
});

beforeEach(() => {
  const credentials = JSON.stringify({
    claudeAiOauth: {
      accessToken: "test-access-token",
      expiresAt: null,
      subscriptionType: "pro",
      rateLimitTier: "default_claude_max_5x",
    },
  });
  state.file = credentials;
  state.keychain = Buffer.from(credentials, "utf8").toString("hex");
  state.settings = "{}";
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ limits: [] }),
    }),
  );
});

describe("Claude Code credential loading", () => {
  it("loads a hex-encoded Keychain credential", async () => {
    const result = await getClaudeProviderUsage();

    expect(result).toEqual({
      supported: true,
      usage: expect.objectContaining({ status: "ok" }),
    });
  });

  it("uses the credential file when the Keychain value is invalid", async () => {
    state.keychain = "invalid-keychain-value";

    const result = await getClaudeProviderUsage();

    expect(result).toEqual({
      supported: true,
      usage: expect.objectContaining({ status: "ok" }),
    });
  });

  it("distinguishes usage-check throttling from an exhausted Claude limit", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 429 }),
    );

    const result = await getClaudeProviderUsage();

    expect(result).toEqual({
      supported: true,
      usage: expect.objectContaining({
        status: "error",
        message:
          "Anthropic temporarily throttled this usage check. This does not mean your Claude limit is exhausted. Try again later.",
      }),
    });
  });

  it("recognizes a settings.json backend without Claude OAuth credentials", async () => {
    state.keychain = "";
    state.file = "";
    state.settings = JSON.stringify({
      env: {
        ANTHROPIC_BASE_URL: "https://gateway.example",
        ANTHROPIC_AUTH_TOKEN: "gateway-token",
      },
    });

    expect(await getClaudeProviderUsage()).toEqual({
      supported: true,
      usage: {
        status: "error",
        accountEmail: null,
        planLabel: null,
        message:
          "Claude Code uses a custom backend. BB needs a usage source for that backend to show its limits.",
      },
    });
    expect(await getClaudeProviderHealth()).toEqual({
      supported: true,
      health: expect.objectContaining({
        status: "ready",
        accountEmail: null,
        loginCommand: null,
      }),
    });
    state.file = JSON.stringify({
      claudeAiOauth: { accessToken: "unrelated-anthropic-token" },
    });
    expect(await getClaudeProviderUsage()).toEqual({
      supported: true,
      usage: expect.objectContaining({ status: "error" }),
    });
    state.settings = JSON.stringify({
      env: { ANTHROPIC_BASE_URL: "https://gateway.example" },
    });
    expect(await getClaudeProviderUsage()).toEqual({
      supported: true,
      usage: expect.objectContaining({ status: "error" }),
    });
    expect(await getClaudeProviderHealth()).toEqual({
      supported: true,
      health: expect.objectContaining({
        status: "unknown",
        loginCommand: null,
      }),
    });
    expect(fetch).not.toHaveBeenCalled();
  });
});
