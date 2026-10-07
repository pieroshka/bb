import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";

const packagePath = "packages/bb-app/package.json";
const metadataPattern = /^[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*$/u;
const versionPattern =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/u;

export function validateBuildMetadata(value) {
  if (
    value !== null &&
    (typeof value !== "string" || !metadataPattern.test(value))
  )
    throw new Error("Invalid fork build metadata");
  return value;
}

function manifest(text) {
  const value = JSON.parse(text);
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    value.name !== "bb-app" ||
    typeof value.version !== "string"
  )
    throw new Error("Invalid bb-app version manifest");
  const match = versionPattern.exec(value.version);
  if (
    match === null ||
    match[4]
      ?.split(".")
      .some(
        (part) =>
          /^\d+$/u.test(part) && part.length > 1 && part.startsWith("0"),
      )
  )
    throw new Error("Invalid bb-app semantic version");
  return value;
}

function git(root, ...args) {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

export function applyForkBranding(root, buildMetadata) {
  if (validateBuildMetadata(buildMetadata) === null) return;
  const path = resolve(root, packagePath);
  const value = manifest(readFileSync(path, "utf8"));
  value.version = `${value.version.split("+")[0]}+${buildMetadata}`;
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

export function resolveBrandingVersionConflict(root, buildMetadata) {
  if (validateBuildMetadata(buildMetadata) === null) return;
  const conflicts = git(root, "diff", "--name-only", "--diff-filter=U").split(
    "\n",
  );
  if (!conflicts.includes(packagePath)) return;
  const base = manifest(git(root, "show", `:1:${packagePath}`));
  const ours = manifest(git(root, "show", `:2:${packagePath}`));
  const theirs = manifest(git(root, "show", `:3:${packagePath}`));
  const { version: baseVersion, ...baseFields } = base;
  const { version: oursVersion, ...oursFields } = ours;
  if (
    oursVersion !== `${baseVersion.split("+")[0]}+${buildMetadata}` ||
    !isDeepStrictEqual(baseFields, oursFields)
  )
    throw new Error(
      "bb-app package conflict includes fork changes beyond build metadata; review required",
    );
  theirs.version = `${theirs.version.split("+")[0]}+${buildMetadata}`;
  writeFileSync(
    resolve(root, packagePath),
    `${JSON.stringify(theirs, null, 2)}\n`,
  );
  git(root, "add", "--", packagePath);
}
