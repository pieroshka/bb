import { spawn, spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { setTimeout } from "node:timers/promises";
import { randomUUID } from "node:crypto";
import { operate, readDeploymentConfig } from "./deployment.mjs";

const [command, path] = process.argv.slice(2);
if (!["install", "run", "status"].includes(command) || !path)
  throw new Error(
    "Usage: node .fork/service.mjs install|run|status <service.json>",
  );
const configPath = resolve(path);
const config = JSON.parse(await readFile(configPath, "utf8"));
if (
  config.schemaVersion !== 1 ||
  typeof config.updatesEnabled !== "boolean" ||
  ![
    config.deploymentConfig,
    config.runtime,
    config.legacy,
    config.operatorConfig,
  ].every((value) => typeof value === "string" && isAbsolute(value)) ||
  !/^[a-zA-Z0-9.-]+$/.test(config.label) ||
  !Number.isInteger(config.intervalMs) ||
  config.intervalMs < 1000 ||
  !Array.isArray(config.desktopArgs) ||
  config.desktopArgs.some((value) => typeof value !== "string") ||
  !(
    config.desktopCommand === null ||
    (typeof config.desktopCommand === "string" &&
      isAbsolute(config.desktopCommand))
  )
)
  throw new Error("Invalid service configuration");
const deployment = await readDeploymentConfig(config.deploymentConfig);
const statusPath = join(deployment.stateDir, "service-status.json");
await mkdir(deployment.stateDir, { recursive: true, mode: 0o700 });

async function report(value) {
  const result = { at: new Date().toISOString(), ...value };
  const temp = `${statusPath}.${randomUUID()}.tmp`;
  await writeFile(temp, JSON.stringify(result, null, 2) + "\n", {
    mode: 0o600,
  });
  await rename(temp, statusPath);
  console.log(JSON.stringify(result));
}

function launchDesktop() {
  if (config.desktopCommand === null) return;
  const child = spawn(config.desktopCommand, config.desktopArgs, {
    detached: true,
    stdio: "ignore",
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      USER: process.env.USER,
      TMPDIR: process.env.TMPDIR,
      BB_DATA_DIR: deployment.dataDir,
      BB_SERVER_PORT: new URL(deployment.healthUrl).port,
      BB_DESKTOP_ATTACH_WITHOUT_PROMPT: "1",
    },
  });
  child.on("error", (error) =>
    console.error(`Desktop attach failed: ${error.message}`),
  );
  child.unref();
}

async function receipt(state) {
  const origin = new URL(deployment.healthUrl).origin;
  const version = await fetch(`${origin}/api/v1/system/version`, {
    signal: AbortSignal.timeout(5000),
  }).then((r) => r.json());
  const hostsResponse = await fetch(`${origin}/api/v1/hosts`, {
    signal: AbortSignal.timeout(5000),
  }).then((r) => r.json());
  const hosts = Array.isArray(hostsResponse)
    ? hostsResponse
    : hostsResponse.hosts;
  if (typeof version.currentVersion !== "string" || !Array.isArray(hosts))
    throw new Error("Post-adoption API verification failed");
  return {
    phase: "running",
    commit: state.current.id,
    version: version.currentVersion,
    hosts: hosts.map((host) => ({
      id: host.id,
      name: host.name,
      status: host.status,
    })),
    previousRuntime: state.previous?.id ?? null,
  };
}

if (command === "status") {
  console.log(await readFile(statusPath, "utf8"));
} else if (command === "install") {
  if (process.platform !== "darwin")
    throw new Error("Service installation currently supports macOS launchd");
  const xml = (value) =>
    String(value)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;");
  const plist = join(
    process.env.HOME,
    "Library",
    "LaunchAgents",
    `${config.label}.plist`,
  );
  const logs = join(deployment.stateDir, "logs");
  await mkdir(logs, { recursive: true, mode: 0o700 });
  const args = [
    process.execPath,
    resolve(import.meta.filename),
    "run",
    configPath,
  ];
  await writeFile(
    plist,
    `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>
<key>Label</key><string>${xml(config.label)}</string>
<key>ProgramArguments</key><array>${args.map((arg) => `<string>${xml(arg)}</string>`).join("")}</array>
<key>EnvironmentVariables</key><dict><key>PATH</key><string>${xml(process.env.PATH)}</string><key>HOME</key><string>${xml(process.env.HOME)}</string></dict>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>30</integer>
<key>ProcessType</key><string>Background</string><key>AbandonProcessGroup</key><true/>
<key>StandardOutPath</key><string>${xml(join(logs, "service.log"))}</string>
<key>StandardErrorPath</key><string>${xml(join(logs, "service-error.log"))}</string>
</dict></plist>\n`,
    { flag: "wx", mode: 0o600 },
  );
  const result = spawnSync(
    "launchctl",
    ["bootstrap", `gui/${process.getuid()}`, plist],
    { encoding: "utf8" },
  );
  if (result.status !== 0) throw new Error(result.stderr);
  console.log(JSON.stringify({ installed: true, plist, statusPath }));
} else {
  setInterval(() => {}, 60_000);
  let lastUpdateCheck = 0;
  for (;;) {
    try {
      let state = await operate(deployment, "status");
      if (state.transaction !== null)
        state = await operate(deployment, "recover");
      if (state.current === null) {
        const runtime = JSON.parse(await readFile(config.runtime, "utf8"));
        const legacy = JSON.parse(await readFile(config.legacy, "utf8"));
        state = await operate(deployment, "adopt", runtime, legacy);
        if (state.deferred) {
          await report({ phase: "waiting-for-idle", reason: state.deferred });
          await setTimeout(config.intervalMs);
          continue;
        }
        launchDesktop();
      }
      if (state.current.unguarded) {
        await report({
          phase: "rolled-back",
          reason: state.lastError,
          version: state.current.id,
        });
      } else {
        state = await operate(deployment, "check");
        await report(await receipt(state));
        if (config.updatesEnabled && Date.now() - lastUpdateCheck >= 60_000) {
          lastUpdateCheck = Date.now();
          const child = spawn(
            process.execPath,
            [
              join(import.meta.dirname, "operator.mjs"),
              config.operatorConfig,
              "--once",
            ],
            { stdio: "inherit" },
          );
          const code = await new Promise((accept, reject) => {
            child.once("exit", accept);
            child.once("error", reject);
          });
          if (code !== 0)
            console.error(
              "Update check failed; current runtime remains selected",
            );
        }
      }
    } catch (error) {
      await report({ phase: "error", reason: error.message });
    }
    await setTimeout(config.intervalMs);
  }
}
