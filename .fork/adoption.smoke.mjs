import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout } from "node:timers/promises";
import { operate } from "./deployment.mjs";

const root = await mkdtemp(join(tmpdir(), "bb-fork-adoption-"));
const repo = resolve(import.meta.dirname, "..");
const desktop = process.env.BB_FORK_LEGACY_DESKTOP ?? null;
const legacyCommand = process.env.BB_FORK_LEGACY_COMMAND;
const legacyEntry = process.env.BB_FORK_LEGACY_ENTRY;
assert.ok(
  legacyCommand && legacyEntry,
  "Set BB_FORK_LEGACY_COMMAND and BB_FORK_LEGACY_ENTRY to a real 0.44 installation",
);
const config = {
  schemaVersion: 1,
  dataDir: join(root, "data"),
  stateDir: join(root, "state"),
  healthUrl: "http://127.0.0.1:39916/health",
  healthTimeoutMs: 60_000,
  probationMs: 1000,
};
const env = {
  HOME: join(root, "home"),
  PATH: process.env.PATH,
  NODE_ENV: "production",
  BB_DATA_DIR: config.dataDir,
  BB_SERVER_BIND_HOST: "127.0.0.1",
  BB_SERVER_PORT: "39916",
  BB_HOST_DAEMON_PORT: "39917",
  BB_SERVER_URL: "http://127.0.0.1:39916",
};
await mkdir(env.HOME, { recursive: true });
const previous = {
  id: "legacy-0.44.0",
  unguarded: true,
  command: legacyCommand,
  args: [legacyEntry, "start"],
  cwd: root,
  env: {
    ...env,
    ...(process.platform === "darwin" ? { ELECTRON_RUN_AS_NODE: "1" } : {}),
  },
};
const candidate = {
  id: "fork-adoption",
  command: process.execPath,
  args: [join(repo, "packages/bb-app/dist/bb-app.js"), "start"],
  cwd: repo,
  env,
};
const child = spawn(
  desktop ?? legacyCommand,
  desktop ? [`--user-data-dir=${join(root, "desktop")}`] : previous.args,
  {
    env: desktop
      ? {
          ...env,
          BB_DESKTOP_USER_DATA_DIR: join(root, "desktop"),
          BB_DESKTOP_ATTACH_WITHOUT_PROMPT: "1",
        }
      : previous.env,
    detached: true,
    stdio: ["ignore", "ignore", "pipe"],
  },
);
let output = "";
child.stderr.on("data", (chunk) => {
  output = `${output}${chunk}`.slice(-8000);
});
const origin = new URL(config.healthUrl).origin;
async function api(path) {
  const response = await fetch(`${origin}${path}`, {
    signal: AbortSignal.timeout(3000),
  });
  assert.equal(response.status, 200);
  return response.json();
}
async function ready(version) {
  let last;
  for (let i = 0; i < 240; i++) {
    try {
      const info = await api("/api/v1/system/version");
      assert.equal(info.currentVersion, version);
      const response = await api("/api/v1/hosts");
      const hosts = Array.isArray(response) ? response : response.hosts;
      const host = hosts.find((host) => host.status === "connected");
      assert.ok(host, "local daemon must connect");
      return host;
    } catch (error) {
      last = error;
    }
    await setTimeout(250);
  }
  throw new Error(`${last?.message}\n${output}\nEvidence: ${root}`);
}
function sqlite(sql) {
  const result = spawnSync("sqlite3", [join(config.dataDir, "bb.db"), sql], {
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}
function cli(args) {
  const result = spawnSync(
    process.execPath,
    [join(repo, "packages/bb-app/dist/bb.js"), ...args],
    { env, encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}
let passed = false;
try {
  const before = await ready("0.44.0");
  let legacy = {
    runtime: previous,
    expectedRecord: JSON.parse(
      await readFile(join(config.dataDir, "bb-app-runtime.json"), "utf8"),
    ),
    desktop: desktop
      ? {
          pid: child.pid,
          command: `${desktop} --user-data-dir=${join(root, "desktop")}`,
        }
      : null,
  };
  const terminal = cli([
    "terminal",
    "create",
    "--machine",
    before.id,
    "--title",
    "adoption idle guard",
    "--json",
  ]);
  const terminalId = terminal.id ?? terminal.session?.id;
  assert.ok(terminalId, JSON.stringify(terminal));
  const deferred = await operate(config, "adopt", candidate, legacy);
  assert.equal(deferred.deferred, "active-threads-or-terminals");
  assert.equal((await api("/api/v1/system/version")).currentVersion, "0.44.0");
  cli(["terminal", "close", terminalId, "--json"]);
  const bad = join(root, "broken.mjs");
  await writeFile(
    bad,
    'import {spawnSync} from "node:child_process"; spawnSync("sqlite3", [process.env.BB_DATA_DIR + "/bb.db", "PRAGMA user_version=42;"]); process.exit(42);\n',
  );
  await assert.rejects(
    operate(
      config,
      "adopt",
      { ...candidate, id: "broken-adoption", args: [bad] },
      legacy,
    ),
    /exited before becoming ready/,
  );
  assert.equal(sqlite("PRAGMA user_version;"), "0");
  const restored = await ready("0.44.0");
  assert.equal(restored.id, before.id);
  assert.deepEqual((await operate(config, "status")).quarantined, [
    "broken-adoption",
  ]);
  legacy = {
    ...legacy,
    desktop: null,
    expectedRecord: JSON.parse(
      await readFile(join(config.dataDir, "bb-app-runtime.json"), "utf8"),
    ),
  };
  await operate(config, "adopt", candidate, legacy);
  const after = await ready("0.45.0+emi");
  assert.equal(after.id, before.id);
  assert.equal(sqlite("PRAGMA integrity_check;"), "ok");
  await operate(config, "stop");
  sqlite(
    `UPDATE terminal_sessions SET status='running' WHERE id='${terminalId}';`,
  );
  await operate(config, "check");
  await ready("0.45.0+emi");
  passed = true;
  await writeFile(
    join(root, "receipt.json"),
    JSON.stringify(
      {
        passed,
        idleGuard: true,
        failedAdoptionRolledBack: true,
        hostIdPreserved: true,
        adoptedVersion: "0.45.0+emi",
        coldRecoveryWithStaleTerminalRecord: true,
        desktopOwner: desktop !== null,
      },
      null,
      2,
    ),
  );
  console.log(JSON.stringify({ passed, evidence: root }));
} finally {
  await operate(config, "stop").catch((error) => console.error(error.message));
  if (child.exitCode === null && child.signalCode === null)
    child.kill("SIGTERM");
  console.error(`Adoption evidence: ${root}; passed=${passed}`);
}
