import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { operate } from "./deployment.mjs";

const root = await mkdtemp(join(tmpdir(), "bb-fork-rollback-"));
const dataDir = join(root, "data");
const stateDir = join(root, "state");
const repo = resolve(import.meta.dirname, "..");
const config = {
  schemaVersion: 1,
  dataDir,
  stateDir,
  healthUrl: "http://127.0.0.1:39896/health",
  healthTimeoutMs: 45_000,
  probationMs: 500,
};
const runtime = {
  id: "verified-0.45",
  command: process.execPath,
  cwd: repo,
  args: [join(repo, "packages/bb-app/dist/bb-app.js"), "start"],
  env: {
    HOME: join(root, "home"),
    NODE_ENV: "production",
    BB_SERVER_BIND_HOST: "127.0.0.1",
    BB_SERVER_PORT: "39896",
    BB_HOST_DAEMON_PORT: "39897",
    BB_SERVER_URL: "http://127.0.0.1:39896",
  },
};

function sqlite(statement) {
  const result = spawnSync("sqlite3", [join(dataDir, "bb.db"), statement], {
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

let passed = false;
try {
  await mkdir(runtime.env.HOME, { recursive: true });
  await operate(config, "bootstrap", runtime);
  assert.equal((await fetch(config.healthUrl)).status, 200);
  assert.equal(sqlite("PRAGMA user_version;"), "0");
  const badProgram = join(root, "broken.mjs");
  await writeFile(
    badProgram,
    `import { spawnSync } from "node:child_process"; spawnSync("sqlite3", [process.env.BB_DATA_DIR + "/bb.db", "PRAGMA user_version=42;"]); process.exit(42);\n`,
  );
  const broken = { ...runtime, id: "broken-update", args: [badProgram] };
  await assert.rejects(
    operate(config, "activate", broken),
    /exited before becoming ready/u,
  );
  const state = await operate(config, "status");
  assert.equal(state.phase, "running");
  assert.equal(state.current.id, runtime.id);
  assert.equal(state.transaction, null);
  assert.deepEqual(state.quarantined, [broken.id]);
  assert.equal(sqlite("PRAGMA user_version;"), "0");
  assert.equal((await fetch(config.healthUrl)).status, 200);
  await assert.rejects(operate(config, "activate", broken), /quarantined/u);
  await operate(config, "activate", { ...runtime, id: "healthy-update" });
  assert.equal((await operate(config, "status")).current.id, "healthy-update");
  await assert.rejects(readFile(join(dataDir, ".fork-maintenance")), {
    code: "ENOENT",
  });
  sqlite("PRAGMA user_version=7;");
  const healthy = await operate(config, "status");
  process.kill(-healthy.pid, "SIGTERM");
  await new Promise((accept) => setTimeout(accept, 1500));
  await operate(config, "check");
  assert.equal(sqlite("PRAGMA user_version;"), "7");
  assert.equal((await fetch(config.healthUrl)).status, 200);
  passed = true;
  console.log(
    JSON.stringify({
      ok: true,
      rollbackRestoredDatabase: true,
      failedCandidateQuarantined: true,
      healthyCandidateActivated: true,
      postActivationRecoveryPreservedWrites: true,
      isolatedDataDir: dataDir,
    }),
  );
} finally {
  await operate(config, "stop").catch((error) => console.error(error.message));
  if (passed) await rm(root, { recursive: true, force: true });
  else console.error(`Failed smoke evidence retained at ${root}`);
}
