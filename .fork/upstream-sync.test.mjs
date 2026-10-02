import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { prepare, promote } from "./upstream-sync.mjs";

function git(root, ...args) {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}
function write(root, path, value) {
  const absolute = join(root, path);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, value);
}
function commit(root, message) {
  git(root, "add", ".");
  git(root, "commit", "-m", message);
  return git(root, "rev-parse", "HEAD");
}
function identity(root) {
  git(root, "config", "user.name", "Fixture");
  git(root, "config", "user.email", "fixture@example.invalid");
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "bb-fork-sync-"));
  const upstream = join(root, "upstream");
  const checkout = join(root, "checkout");
  const origin = join(root, "origin.git");
  const artifacts = join(root, "artifacts");
  git(root, "init", "-b", "main", upstream);
  identity(upstream);
  write(upstream, "runtime.txt", "upstream base\n");
  write(
    upstream,
    ".github/workflows/upstream.yml",
    "original upstream workflow\n",
  );
  commit(upstream, "Base");
  git(root, "clone", upstream, checkout);
  identity(checkout);
  git(root, "init", "--bare", "--initial-branch=main", origin);
  git(checkout, "remote", "set-url", "origin", origin);
  write(
    checkout,
    ".fork/config.json",
    JSON.stringify({
      schemaVersion: 1,
      upstream,
      branch: "main",
      repository: "fixture",
      requiredFiles: ["feature.txt"],
    }),
  );
  write(checkout, "feature.txt", "Our feature\n");
  write(checkout, ".github/workflows/fork.yml", "Our tested workflow\n");
  write(
    checkout,
    ".github/workflows/upstream.yml",
    "Pinned downstream workflow\n",
  );
  commit(checkout, "Our feature");
  git(checkout, "push", "-u", "origin", "main");
  return {
    root,
    upstream,
    checkout,
    origin,
    artifacts,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

test("imports upstream code while retaining our patch and workflows, then promotes a fast-forward merge", () => {
  const f = fixture();
  try {
    write(f.upstream, "new-upstream.txt", "New upstream behavior\n");
    write(
      f.upstream,
      ".github/workflows/upstream.yml",
      "New upstream workflow\n",
    );
    write(
      f.upstream,
      ".github/workflows/new-upstream.yml",
      "Unexpected new schedule\n",
    );
    const target = commit(f.upstream, "Update upstream");
    const base = git(f.checkout, "rev-parse", "HEAD");
    const state = prepare(f.checkout, f.artifacts);
    assert.equal(state.upstream, target);
    assert.equal(git(f.origin, "rev-parse", "main"), base);
    assert.equal(
      readFileSync(join(f.checkout, "new-upstream.txt"), "utf8"),
      "New upstream behavior\n",
    );
    assert.equal(
      readFileSync(join(f.checkout, "feature.txt"), "utf8"),
      "Our feature\n",
    );
    git(
      f.checkout,
      "diff",
      "--exit-code",
      base,
      state.candidate,
      "--",
      ".fork",
      ".github/workflows",
    );
    promote(f.checkout, f.artifacts);
    assert.equal(git(f.origin, "rev-parse", "main"), state.candidate);
    assert.equal(prepare(f.checkout, f.artifacts).changed, false);
  } finally {
    f.cleanup();
  }
});

test("stops on a new source conflict and leaves remote main untouched", () => {
  const f = fixture();
  try {
    write(f.checkout, "runtime.txt", "Our integrated behavior\n");
    commit(f.checkout, "Integrate feature");
    git(f.checkout, "push", "origin", "main");
    const base = git(f.origin, "rev-parse", "main");
    write(f.upstream, "runtime.txt", "Different upstream behavior\n");
    commit(f.upstream, "Conflicting update");
    assert.throws(
      () => prepare(f.checkout, f.artifacts),
      /reviewed conflict resolution/u,
    );
    assert.equal(git(f.origin, "rev-parse", "main"), base);
    assert.equal(git(f.checkout, "status", "--porcelain"), "");
  } finally {
    f.cleanup();
  }
});

test("refuses promotion after fork main moves while the candidate is being tested", () => {
  const f = fixture();
  try {
    write(f.upstream, "new.txt", "Upstream\n");
    commit(f.upstream, "Update");
    prepare(f.checkout, f.artifacts);
    const other = join(f.root, "other");
    git(f.root, "clone", f.origin, other);
    identity(other);
    write(other, "owner-change.txt", "Owner's concurrent change\n");
    const current = commit(other, "Owner change");
    git(other, "push", "origin", "main");
    assert.throws(
      () => promote(f.checkout, f.artifacts),
      /main moved during validation/u,
    );
    assert.equal(git(f.origin, "rev-parse", "main"), current);
  } finally {
    f.cleanup();
  }
});

test("rejects a bundle that differs from the candidate declared in its metadata", () => {
  const f = fixture();
  try {
    write(f.upstream, "new.txt", "Upstream\n");
    commit(f.upstream, "Update");
    const state = prepare(f.checkout, f.artifacts);
    write(f.checkout, "feature.txt", "Unvalidated replacement\n");
    commit(f.checkout, "Alter candidate");
    git(
      f.checkout,
      "bundle",
      "create",
      join(f.artifacts, "candidate.bundle"),
      `refs/heads/${state.branch}`,
      `^${state.base}`,
    );
    assert.throws(() => promote(f.checkout, f.artifacts), /does not match/u);
    assert.equal(git(f.origin, "rev-parse", "main"), state.base);
  } finally {
    f.cleanup();
  }
});
