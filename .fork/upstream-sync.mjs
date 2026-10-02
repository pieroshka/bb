import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const protectedPaths = [".fork", ".github/workflows"];
const shaPattern = /^[a-f0-9]{40}$/u;

function git(root, ...args) {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    timeout: 120_000,
    maxBuffer: 4 * 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function config(root) {
  const value = JSON.parse(
    readFileSync(resolve(root, ".fork/config.json"), "utf8"),
  );
  if (
    value.schemaVersion !== 1 ||
    typeof value.upstream !== "string" ||
    !/^[A-Za-z0-9._/-]+$/u.test(value.branch) ||
    typeof value.repository !== "string" ||
    !Array.isArray(value.requiredFiles) ||
    value.requiredFiles.some(
      (path) =>
        typeof path !== "string" || path.startsWith("/") || path.includes(".."),
    )
  ) {
    throw new Error("Invalid fork sync configuration");
  }
  return value;
}

function verifyCandidate(root, state) {
  for (const name of ["base", "upstream", "candidate"])
    if (!shaPattern.test(state[name]))
      throw new Error(`Invalid ${name} commit`);
  if (!/^fork-sync\/[a-f0-9-]+$/u.test(state.branch))
    throw new Error("Invalid candidate branch");
  const parents = git(
    root,
    "show",
    "--no-patch",
    "--format=%P",
    state.candidate,
  ).split(" ");
  if (
    parents.length !== 2 ||
    parents[0] !== state.base ||
    parents[1] !== state.upstream
  )
    throw new Error(
      "Candidate does not preserve the fork and upstream parents",
    );
  git(
    root,
    "diff",
    "--exit-code",
    state.base,
    state.candidate,
    "--",
    ...protectedPaths,
  );
  for (const path of config(root).requiredFiles)
    git(root, "cat-file", "-e", `${state.candidate}:${path}`);
}

export function prepare(root, artifactDirectory) {
  if (git(root, "status", "--porcelain") !== "")
    throw new Error("Prepare requires a clean, isolated checkout");
  const settings = config(root);
  const base = git(root, "rev-parse", "HEAD");
  git(
    root,
    "fetch",
    "--no-tags",
    settings.upstream,
    `refs/heads/${settings.branch}`,
  );
  const upstream = git(root, "rev-parse", "FETCH_HEAD");
  try {
    git(root, "merge-base", "--is-ancestor", upstream, base);
    return { changed: false, base, upstream };
  } catch (error) {
    if (error.status !== 1) throw error;
  }
  const branch = `fork-sync/${upstream.slice(0, 12)}-${base.slice(0, 12)}`;
  git(root, "switch", "--create", branch);
  try {
    try {
      git(root, "merge", "--no-ff", "--no-commit", upstream);
    } catch (error) {
      if (error.status !== 1) throw error;
    }
    git(
      root,
      "restore",
      `--source=${base}`,
      "--staged",
      "--worktree",
      "--",
      ...protectedPaths,
    );
    const conflicts = git(root, "diff", "--name-only", "--diff-filter=U");
    if (conflicts !== "")
      throw new Error(
        `Upstream needs a reviewed conflict resolution:\n${conflicts}`,
      );
    git(root, "diff", "--cached", "--check");
    git(
      root,
      "commit",
      "-m",
      `Merge get-bb/bb ${upstream.slice(0, 12)} into patched BB`,
    );
    const state = {
      changed: true,
      base,
      upstream,
      branch,
      candidate: git(root, "rev-parse", "HEAD"),
    };
    verifyCandidate(root, state);
    mkdirSync(artifactDirectory, { recursive: true });
    git(
      root,
      "bundle",
      "create",
      resolve(artifactDirectory, "candidate.bundle"),
      `refs/heads/${branch}`,
      `^${base}`,
    );
    writeFileSync(
      resolve(artifactDirectory, "state.json"),
      `${JSON.stringify(state, null, 2)}\n`,
    );
    return state;
  } catch (error) {
    try {
      git(root, "merge", "--abort");
    } catch {}
    throw error;
  }
}

export function promote(root, artifactDirectory) {
  const settings = config(root);
  const state = JSON.parse(
    readFileSync(resolve(artifactDirectory, "state.json"), "utf8"),
  );
  if (state.changed !== true || !/^fork-sync\/[a-f0-9-]+$/u.test(state.branch))
    throw new Error("Invalid candidate metadata");
  const bundle = resolve(artifactDirectory, "candidate.bundle");
  git(root, "bundle", "verify", bundle);
  git(
    root,
    "fetch",
    "--no-tags",
    bundle,
    `refs/heads/${state.branch}:refs/fork-sync/candidate`,
  );
  if (git(root, "rev-parse", "refs/fork-sync/candidate") !== state.candidate)
    throw new Error("Bundle does not match the validated candidate");
  verifyCandidate(root, state);
  git(root, "fetch", "--no-tags", "origin", settings.branch);
  if (git(root, "rev-parse", `origin/${settings.branch}`) !== state.base)
    throw new Error(
      "Fork main moved during validation; retry against the new main",
    );
  git(
    root,
    "push",
    "origin",
    `${state.candidate}:refs/heads/${settings.branch}`,
  );
  return state;
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const [command, directory] = process.argv.slice(2);
  if (!["prepare", "promote"].includes(command) || !directory)
    throw new Error(
      "Usage: node .fork/upstream-sync.mjs prepare|promote <artifact-directory>",
    );
  const result = (command === "prepare" ? prepare : promote)(
    process.cwd(),
    resolve(directory),
  );
  console.log(JSON.stringify(result));
  if (process.env.GITHUB_OUTPUT) {
    const { appendFileSync } = await import("node:fs");
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      `changed=${result.changed}\nbase=${result.base}\n`,
    );
  }
}
