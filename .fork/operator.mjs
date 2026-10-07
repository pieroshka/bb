import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { setTimeout } from "node:timers/promises";
import { operate, readDeploymentConfig } from "./deployment.mjs";

const configPath = resolve(process.argv[2] ?? "");
if (!process.argv[2])
  throw new Error("Usage: node .fork/operator.mjs <operator.json> [--once]");
const config = JSON.parse(await readFile(configPath, "utf8"));
if (
  config.schemaVersion !== 1 ||
  typeof config.repo !== "string" ||
  !config.repo.startsWith("/") ||
  typeof config.deploymentConfig !== "string" ||
  typeof config.pnpm !== "string" ||
  !config.pnpm.startsWith("/") ||
  typeof config.node !== "string" ||
  !config.node.startsWith("/") ||
  !Number.isInteger(config.intervalMs) ||
  config.intervalMs < 60_000
)
  throw new Error("Invalid operator configuration");
const deployment = await readDeploymentConfig(config.deploymentConfig);
const env = {
  ...process.env,
  PATH: `${resolve(config.node, "..")}:${process.env.PATH}`,
  GIT_TERMINAL_PROMPT: "0",
  GIT_SSH_COMMAND: "ssh -o BatchMode=yes",
};

async function run(command, args, cwd) {
  const child = spawn(command, args, {
    cwd,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => {
    output = `${output}${chunk}`.slice(-128_000);
  });
  child.stderr.on("data", (chunk) => {
    output = `${output}${chunk}`.slice(-128_000);
  });
  const code = await new Promise((accept, reject) => {
    child.once("error", reject);
    child.once("exit", accept);
  });
  if (code !== 0)
    throw new Error(
      `${command} ${args[0]} failed (${code}): ${output.slice(-3000)}`,
    );
  return output.trim();
}

async function tick() {
  let current = await operate(deployment, "status");
  if (current.transaction !== null) return operate(deployment, "recover");
  if (current.current !== null) current = await operate(deployment, "check");
  if (current.phase !== "running")
    throw new Error(
      "Production adoption has not completed; automatic deployment remains disabled",
    );
  await run(
    "git",
    [
      "fetch",
      "--no-tags",
      "origin",
      "refs/heads/fork-verified:refs/remotes/origin/fork-verified",
    ],
    config.repo,
  );
  const commit = await run(
    "git",
    ["rev-parse", "refs/remotes/origin/fork-verified"],
    config.repo,
  );
  if (!/^[a-f0-9]{40}$/u.test(commit))
    throw new Error("Invalid verified commit");
  if (current.current.id === commit || current.quarantined.includes(commit))
    return current;
  const candidateDir = join(deployment.stateDir, "releases", commit);
  const receipt = join(candidateDir, ".fork-prepared.json");
  if (!existsSync(receipt)) {
    await mkdir(resolve(candidateDir, ".."), { recursive: true, mode: 0o700 });
    if (!existsSync(candidateDir))
      await run(
        "git",
        ["worktree", "add", "--detach", candidateDir, commit],
        config.repo,
      );
    if ((await run("git", ["rev-parse", "HEAD"], candidateDir)) !== commit)
      throw new Error("Release checkout does not match the verified commit");
    await run(config.pnpm, ["install", "--frozen-lockfile"], candidateDir);
    await run("bash", [".fork/verify.sh"], candidateDir);
    await run(
      config.pnpm,
      [
        "exec",
        "turbo",
        "run",
        "build",
        "--filter=bb-app",
        "--concurrency=2",
        "--output-logs=errors-only",
      ],
      candidateDir,
    );
    await run(config.node, [".fork/deployment.smoke.mjs"], candidateDir);
    await writeFile(
      receipt,
      JSON.stringify({ commit, preparedAt: Date.now() }),
      { mode: 0o600 },
    );
  }
  const prepared = JSON.parse(await readFile(receipt, "utf8"));
  if (
    prepared.commit !== commit ||
    (await run("git", ["rev-parse", "HEAD"], candidateDir)) !== commit ||
    (await run(
      "git",
      ["status", "--porcelain", "--untracked-files=no"],
      candidateDir,
    )) !== ""
  )
    throw new Error("Prepared release was modified; deployment refused");
  return operate(deployment, "activate", {
    id: commit,
    command: config.node,
    args: [join(candidateDir, "packages/bb-app/dist/bb-app.js"), "start"],
    cwd: candidateDir,
    env: {
      ...current.current.env,
      NODE_ENV: "production",
      BB_SERVER_PORT: String(new URL(deployment.healthUrl).port),
    },
  });
}

for (;;) {
  try {
    const result = await tick();
    console.log(
      JSON.stringify({
        at: Date.now(),
        phase: result.phase,
        commit: result.current?.id ?? null,
        deferred: result.deferred ?? null,
      }),
    );
  } catch (error) {
    console.error(JSON.stringify({ at: Date.now(), error: error.message }));
    if (process.argv.includes("--once")) process.exitCode = 1;
  }
  if (process.argv.includes("--once")) break;
  await setTimeout(config.intervalMs);
}
