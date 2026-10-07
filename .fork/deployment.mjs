import { spawn, spawnSync } from "node:child_process";
import {
  cp,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { existsSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const preserved = new Set([
  "logs",
  "thread-storage",
  "runtime",
  "plugin-host-artifacts",
  "skills-generated",
  "install-cache",
  "desktop",
  "private-backups",
  "daemon.lock",
  "daemon.lock.lock",
  "bb-app-runtime.json",
  ".fork-maintenance",
]);

async function json(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function save(path, value) {
  await mkdir(resolve(path, ".."), { recursive: true, mode: 0o700 });
  const temp = `${path}.${randomUUID()}.tmp`;
  const file = await open(temp, "wx", 0o600);
  try {
    await file.writeFile(`${JSON.stringify(value, null, 2)}\n`);
    await file.sync();
  } finally {
    await file.close();
  }
  await rename(temp, path);
}

function validateRuntime(value) {
  if (
    !value ||
    typeof value !== "object" ||
    typeof value.id !== "string" ||
    !/^[a-zA-Z0-9._-]{1,100}$/u.test(value.id) ||
    typeof value.command !== "string" ||
    !isAbsolute(value.command) ||
    typeof value.cwd !== "string" ||
    !isAbsolute(value.cwd) ||
    !Array.isArray(value.args) ||
    value.args.some((arg) => typeof arg !== "string") ||
    (value.unguarded !== undefined && value.unguarded !== true) ||
    !value.env ||
    typeof value.env !== "object" ||
    Object.values(value.env).some((entry) => typeof entry !== "string")
  )
    throw new Error("Invalid runtime manifest");
  return value;
}

export async function readDeploymentConfig(path) {
  const value = await json(path);
  if (
    value.schemaVersion !== 1 ||
    typeof value.dataDir !== "string" ||
    !isAbsolute(value.dataDir) ||
    typeof value.stateDir !== "string" ||
    !isAbsolute(value.stateDir) ||
    value.dataDir === value.stateDir ||
    value.stateDir.startsWith(`${value.dataDir}/`) ||
    typeof value.healthUrl !== "string" ||
    !Number.isInteger(value.healthTimeoutMs) ||
    value.healthTimeoutMs < 1000 ||
    !Number.isInteger(value.probationMs) ||
    value.probationMs < 0
  )
    throw new Error("Invalid deployment configuration");
  const url = new URL(value.healthUrl);
  if (
    url.protocol !== "http:" ||
    url.hostname !== "127.0.0.1" ||
    url.pathname !== "/health"
  )
    throw new Error(
      "Deployment health checks must use the instance's loopback /health endpoint",
    );
  return value;
}

async function readState(config) {
  const path = join(config.stateDir, "state.json");
  const value = existsSync(path)
    ? await json(path)
    : {
        schemaVersion: 1,
        phase: "stopped",
        current: null,
        previous: null,
        pid: null,
        transaction: null,
        quarantined: [],
        lastError: null,
      };
  if (
    value.schemaVersion !== 1 ||
    !["stopped", "running", "switching", "probation", "blocked"].includes(
      value.phase,
    ) ||
    (value.pid !== null && (!Number.isInteger(value.pid) || value.pid < 1)) ||
    !Array.isArray(value.quarantined) ||
    value.quarantined.some((id) => typeof id !== "string")
  )
    throw new Error("Invalid deployment journal; refusing to operate");
  if (value.current !== null) validateRuntime(value.current);
  if (value.transaction !== null) {
    validateRuntime(value.transaction.previous);
    validateRuntime(value.transaction.candidate);
    if (
      value.transaction.backup !== null &&
      !value.transaction.backup.startsWith(
        `${join(config.stateDir, "backups")}/`,
      )
    )
      throw new Error("Backup is outside the deployment state directory");
  }
  return value;
}

function alive(pid) {
  if (pid === null) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === "ESRCH") return false;
    throw error;
  }
}

function verifyProcess(state) {
  if (state.pid === null || !alive(state.pid)) return;
  const result = spawnSync("ps", ["-p", String(state.pid), "-o", "command="], {
    encoding: "utf8",
  });
  const entry = state.current.args.find((arg) => isAbsolute(arg));
  if (
    result.status !== 0 ||
    entry === undefined ||
    !result.stdout.includes(entry)
  )
    throw new Error(
      "Recorded runtime PID no longer matches its executable; refusing to signal it",
    );
}

async function stopRuntime(state) {
  if (state.pid === null || !alive(state.pid)) return;
  verifyProcess(state);
  const group = spawnSync("ps", ["-p", String(state.pid), "-o", "pgid="], {
    encoding: "utf8",
  });
  process.kill(
    Number(group.stdout.trim()) === state.pid ? -state.pid : state.pid,
    "SIGTERM",
  );
  const deadline = Date.now() + 30_000;
  while (alive(state.pid) && Date.now() < deadline) await setTimeout(100);
  if (alive(state.pid))
    throw new Error(
      "Runtime did not stop gracefully; refusing to back up live databases",
    );
}

async function launch(config, runtime) {
  await mkdir(join(config.stateDir, "logs"), { recursive: true, mode: 0o700 });
  const { open } = await import("node:fs/promises");
  const log = await open(
    join(config.stateDir, "logs", `${runtime.id}.log`),
    "a",
    0o600,
  );
  try {
    const env = { ...process.env, ...runtime.env, BB_DATA_DIR: config.dataDir };
    for (const key of [
      "BB_THREAD_ID",
      "BB_ENVIRONMENT_ID",
      "BB_PROJECT_ID",
      "BB_THREAD_STORAGE",
      "BB_CLI",
      "BB_CLI_REEXEC",
      "BB_SERVER_URL",
      "ELECTRON_RUN_AS_NODE",
    ]) {
      if (!(key in runtime.env)) delete env[key];
    }
    const child = spawn(runtime.command, runtime.args, {
      cwd: runtime.cwd,
      env,
      detached: true,
      stdio: ["ignore", log.fd, log.fd],
    });
    await new Promise((accept, reject) => {
      child.once("spawn", accept);
      child.once("error", reject);
    });
    child.unref();
    return child.pid;
  } finally {
    await log.close();
  }
}

async function health(config, requireMaintenance) {
  const response = await fetch(config.healthUrl, {
    signal: AbortSignal.timeout(3000),
  });
  const body = await response.json();
  if (
    !response.ok ||
    body.ok !== true ||
    (requireMaintenance && body.forkMaintenance !== true)
  )
    throw new Error("Runtime failed its guarded readiness check");
  return body;
}

async function waitHealthy(config, state, guarded) {
  const deadline = Date.now() + config.healthTimeoutMs;
  let lastError = new Error("Runtime did not become healthy");
  while (Date.now() < deadline) {
    if (!alive(state.pid))
      throw new Error("Candidate runtime exited before becoming ready");
    try {
      await health(config, guarded);
      return;
    } catch (error) {
      lastError = error;
    }
    await setTimeout(250);
  }
  throw lastError;
}

function databaseFacts(config) {
  const result = spawnSync(
    "sqlite3",
    [
      "-readonly",
      join(config.dataDir, "bb.db"),
      "SELECT COUNT(*) FROM threads WHERE status IN ('starting', 'active', 'stopping'); SELECT COUNT(*) FROM __drizzle_migrations; SELECT COUNT(*) FROM terminal_sessions WHERE status='running';",
    ],
    { encoding: "utf8" },
  );
  if (result.status !== 0)
    throw new Error(
      "Could not inspect database admission state; deployment deferred",
    );
  const facts = result.stdout.trim().split("\n").map(Number);
  if (
    facts.length !== 3 ||
    facts.some((value) => !Number.isSafeInteger(value) || value < 0)
  )
    throw new Error("Invalid database admission state");
  return {
    activeThreads: facts[0],
    migrations: facts[1],
    runningTerminals: facts[2],
  };
}

async function acquire(config) {
  await mkdir(config.stateDir, { recursive: true, mode: 0o700 });
  const lock = join(config.stateDir, "operator.lock");
  try {
    await mkdir(lock);
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    const owner = await json(join(lock, "owner.json"));
    if (!Number.isInteger(owner.pid) || owner.pid < 1 || alive(owner.pid))
      throw new Error("Another deployment operator owns the lock");
    const stale = `${lock}.stale.${randomUUID()}`;
    await rename(lock, stale);
    await mkdir(lock);
    await rm(stale, { recursive: true });
  }
  await save(join(lock, "owner.json"), {
    pid: process.pid,
    startedAt: Date.now(),
  });
  return () => rm(lock, { recursive: true });
}

async function snapshot(config, transactionId) {
  const path = join(config.stateDir, "backups", transactionId);
  const temp = `${path}.incomplete`;
  await mkdir(join(temp, "data"), { recursive: true, mode: 0o700 });
  const entries = (await readdir(config.dataDir)).filter(
    (name) => !preserved.has(name),
  );
  for (const entry of entries)
    await cp(join(config.dataDir, entry), join(temp, "data", entry), {
      recursive: true,
      preserveTimestamps: true,
      dereference: false,
    });
  const integrity = spawnSync(
    "sqlite3",
    ["-readonly", join(temp, "data", "bb.db"), "PRAGMA integrity_check;"],
    { encoding: "utf8" },
  );
  if (integrity.status !== 0 || integrity.stdout.trim() !== "ok")
    throw new Error("Backup database failed integrity verification");
  await save(join(temp, "manifest.json"), {
    schemaVersion: 1,
    entries,
    migrations: databaseFacts(config).migrations,
    createdAt: Date.now(),
  });
  await rename(temp, path);
  return path;
}

async function restore(config, path) {
  const manifest = await json(join(path, "manifest.json"));
  if (
    manifest.schemaVersion !== 1 ||
    !Array.isArray(manifest.entries) ||
    manifest.entries.some(
      (name) =>
        typeof name !== "string" ||
        name.includes("/") ||
        name === ".." ||
        preserved.has(name),
    )
  )
    throw new Error("Invalid backup manifest; restore aborted");
  const integrity = spawnSync(
    "sqlite3",
    ["-readonly", join(path, "data", "bb.db"), "PRAGMA integrity_check;"],
    { encoding: "utf8" },
  );
  if (integrity.status !== 0 || integrity.stdout.trim() !== "ok")
    throw new Error(
      "Rollback backup failed integrity verification; current data left untouched",
    );
  for (const entry of await readdir(config.dataDir))
    if (!preserved.has(entry))
      await rm(join(config.dataDir, entry), { recursive: true, force: true });
  for (const entry of manifest.entries)
    await cp(join(path, "data", entry), join(config.dataDir, entry), {
      recursive: true,
      preserveTimestamps: true,
      dereference: false,
    });
}

export async function operate(config, command, runtime = null, legacy = null) {
  const release = await acquire(config);
  const statePath = join(config.stateDir, "state.json");
  let state = await readState(config);
  const marker = join(config.dataDir, ".fork-maintenance");
  try {
    if (command === "status") return state;
    if (command === "adopt") {
      if (state.current !== null && !state.current.unguarded)
        throw new Error("This instance has already been adopted");
      const candidate = validateRuntime(runtime);
      if (candidate.unguarded)
        throw new Error("Adoption requires a guarded candidate");
      if (state.quarantined.includes(candidate.id))
        throw new Error("Candidate is quarantined after a failed deployment");
      const previous = validateRuntime(legacy?.runtime);
      if (!previous.unguarded)
        throw new Error("Legacy runtime must be explicitly unguarded");
      const record = await json(join(config.dataDir, "bb-app-runtime.json"));
      if (
        !Number.isInteger(record.pid) ||
        record.pid < 1 ||
        record.pid !== legacy.expectedRecord.pid ||
        record.entryPath !== legacy.expectedRecord.entryPath ||
        record.startedAt !== legacy.expectedRecord.startedAt ||
        !previous.args.includes(record.entryPath)
      )
        throw new Error("Legacy runtime changed; adoption refused");
      if (
        legacy.desktop !== null &&
        (!Number.isInteger(legacy.desktop.pid) ||
          legacy.desktop.pid < 1 ||
          !isAbsolute(legacy.desktop.command))
      )
        throw new Error("Invalid legacy desktop owner");
      const old = { ...state, current: previous, pid: record.pid };
      verifyProcess(old);
      if (!alive(old.pid)) throw new Error("Legacy runtime is not running");
      await health(config, false);
      if (
        databaseFacts(config).activeThreads ||
        databaseFacts(config).runningTerminals
      )
        return { ...state, deferred: "active-threads-or-terminals" };
      if (legacy.desktop !== null) {
        const owner = spawnSync(
          "ps",
          ["-p", String(legacy.desktop.pid), "-o", "command="],
          { encoding: "utf8" },
        );
        const parent = spawnSync(
          "ps",
          ["-p", String(record.pid), "-o", "ppid="],
          { encoding: "utf8" },
        );
        if (
          owner.status !== 0 ||
          owner.stdout.trim() !== legacy.desktop.command ||
          Number(parent.stdout.trim()) !== legacy.desktop.pid
        )
          throw new Error("Legacy desktop ownership changed; adoption refused");
      }
      state = {
        ...old,
        phase: "switching",
        transaction: {
          id: randomUUID(),
          previous,
          candidate,
          backup: null,
        },
      };
      await save(statePath, state);
      if (legacy.desktop !== null) {
        process.kill(legacy.desktop.pid, "SIGTERM");
        const deadline = Date.now() + 30_000;
        while (alive(legacy.desktop.pid) && Date.now() < deadline)
          await setTimeout(100);
        if (alive(legacy.desktop.pid))
          throw new Error("Legacy desktop did not stop gracefully");
      }
      await stopRuntime(state);
      state.pid = null;
      await save(statePath, state);
      if (
        databaseFacts(config).activeThreads ||
        databaseFacts(config).runningTerminals
      )
        throw new Error(
          "Work arrived during legacy shutdown; restoring the legacy runtime",
        );
      await writeFile(marker, "Initial fork adoption\n", {
        flag: "wx",
        mode: 0o600,
      });
      state.transaction.backup = await snapshot(config, state.transaction.id);
      await save(statePath, state);
      state.current = candidate;
      state.pid = await launch(config, candidate);
      state.phase = "probation";
      await save(statePath, state);
      await waitHealthy(config, state, true);
      await setTimeout(config.probationMs);
      await health(config, true);
      state.previous = previous;
      state.transaction = null;
      state.phase = "running";
      state.lastError = null;
      await save(statePath, state);
      await rm(marker);
      return state;
    }
    if (command === "bootstrap") {
      if (
        state.current !== null ||
        existsSync(join(config.dataDir, "bb-app-runtime.json"))
      )
        throw new Error(
          "Bootstrap will not take over an existing instance; explicit adoption is required",
        );
      const next = validateRuntime(runtime);
      await mkdir(config.dataDir, { recursive: true, mode: 0o700 });
      await writeFile(marker, "Bootstrap probation\n", {
        flag: "wx",
        mode: 0o600,
      });
      state = {
        ...state,
        current: next,
        pid: await launch(config, next),
        phase: "probation",
      };
      await save(statePath, state);
      await waitHealthy(config, state, true);
      await setTimeout(config.probationMs);
      await health(config, true);
      state.phase = "running";
      await save(statePath, state);
      await rm(marker);
      return state;
    }
    if (command === "check") {
      if (state.current?.unguarded)
        throw new Error(
          "Legacy rollback is running; a new explicit adoption is required",
        );
      if (state.transaction !== null)
        throw new Error(
          "An interrupted deployment requires recover before health monitoring",
        );
      if (state.current === null) throw new Error("No managed runtime exists");
      try {
        const status = await health(config, false);
        if (state.phase !== "running")
          throw new Error("Runtime still requires guarded recovery");
        if (status.forkMaintenance === true) await rm(marker, { force: true });
        return state;
      } catch {
        if (alive(state.pid)) {
          if (
            databaseFacts(config).activeThreads ||
            databaseFacts(config).runningTerminals
          )
            return { ...state, deferred: "active-threads-or-terminals" };
        } else {
          const daemonPort = state.current.env.BB_HOST_DAEMON_PORT ?? "38887";
          const daemonAlive = await fetch(
            `http://127.0.0.1:${daemonPort}/health`,
            {
              signal: AbortSignal.timeout(3000),
            },
          ).then(
            (response) => response.ok,
            () => false,
          );
          if (daemonAlive)
            return { ...state, deferred: "orphaned-local-daemon" };
        }
        await writeFile(marker, "Same-version recovery\n", { mode: 0o600 });
        await stopRuntime(state);
        state.pid = await launch(config, state.current);
        state.phase = "probation";
        await save(statePath, state);
        await waitHealthy(config, state, true);
        await setTimeout(config.probationMs);
        await health(config, true);
        state.phase = "running";
        await save(statePath, state);
        await rm(marker);
        return state;
      }
    }
    if (command === "stop") {
      await stopRuntime(state);
      state.pid = null;
      state.phase = "stopped";
      await save(statePath, state);
      return state;
    }
    if (command === "recover") {
      if (state.transaction === null)
        throw new Error(
          "No uncommitted deployment to recover; data rollback after activation is forbidden",
        );
      await stopRuntime(state);
      if (state.transaction.backup !== null)
        await restore(config, state.transaction.backup);
      state.current = state.transaction.previous;
      if (state.current.unguarded) await rm(marker, { force: true });
      state.pid = await launch(config, state.current);
      await save(statePath, state);
      await waitHealthy(config, state, !state.current.unguarded);
      await rm(marker, { force: true });
      state.phase = "running";
      state.transaction = null;
      await save(statePath, state);
      return state;
    }
    if (command !== "activate") throw new Error("Unknown deployment operation");
    const candidate = validateRuntime(runtime);
    if (
      state.current === null ||
      state.phase !== "running" ||
      state.transaction !== null
    )
      throw new Error("Instance is not in a deployable state");
    if (state.quarantined.includes(candidate.id))
      throw new Error("Candidate is quarantined after a failed deployment");
    if (candidate.id === state.current.id) return state;
    await health(config, false);
    if (
      databaseFacts(config).activeThreads !== 0 ||
      databaseFacts(config).runningTerminals !== 0
    )
      return { ...state, deferred: "active-threads-or-terminals" };
    await writeFile(marker, "Update probation\n", { flag: "wx", mode: 0o600 });
    if ((await health(config, true)).forkMaintenance !== true)
      throw new Error(
        "Current runtime cannot close admission; adoption requires a guarded runtime",
      );
    await setTimeout(1000);
    if (
      databaseFacts(config).activeThreads !== 0 ||
      databaseFacts(config).runningTerminals !== 0
    ) {
      await rm(marker);
      return { ...state, deferred: "active-threads-or-terminals" };
    }
    state.transaction = {
      id: randomUUID(),
      previous: state.current,
      candidate,
      backup: null,
    };
    state.phase = "switching";
    await save(statePath, state);
    await stopRuntime(state);
    state.pid = null;
    state.transaction.backup = await snapshot(config, state.transaction.id);
    await save(statePath, state);
    state.current = candidate;
    state.pid = await launch(config, candidate);
    state.phase = "probation";
    await save(statePath, state);
    await waitHealthy(config, state, true);
    await setTimeout(config.probationMs);
    await health(config, true);
    state.previous = state.transaction.previous;
    state.transaction = null;
    state.phase = "running";
    state.lastError = null;
    await save(statePath, state);
    await rm(marker);
    return state;
  } catch (error) {
    const failure = error instanceof Error ? error.message : String(error);
    if (state.transaction !== null) {
      const failed = state.transaction.candidate.id;
      try {
        await stopRuntime(state);
        if (state.transaction.backup !== null)
          await restore(config, state.transaction.backup);
        state.current = state.transaction.previous;
        if (state.current.unguarded) await rm(marker, { force: true });
        state.pid = await launch(config, state.current);
        await save(statePath, state);
        await waitHealthy(config, state, !state.current.unguarded);
        state.quarantined = [...new Set([...state.quarantined, failed])];
        state.transaction = null;
        state.phase = "running";
        state.lastError = failure;
        await save(statePath, state);
        await rm(marker, { force: true });
      } catch (rollbackError) {
        state.phase = "blocked";
        state.lastError = `${failure}; rollback blocked: ${rollbackError.message}`;
        await save(statePath, state);
        throw new Error(state.lastError);
      }
    } else if (state.phase !== "probation") {
      await rm(marker, { force: true });
    }
    throw new Error(failure);
  } finally {
    await release();
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const [command, configPath, runtimePath, legacyPath] = process.argv.slice(2);
  if (!command || !configPath)
    throw new Error(
      "Usage: node .fork/deployment.mjs status|bootstrap|adopt|activate|stop|recover|check <config.json> [runtime.json] [legacy.json]",
    );
  const result = await operate(
    await readDeploymentConfig(resolve(configPath)),
    command,
    runtimePath ? await json(resolve(runtimePath)) : null,
    legacyPath ? await json(resolve(legacyPath)) : null,
  );
  console.log(JSON.stringify(result));
}
