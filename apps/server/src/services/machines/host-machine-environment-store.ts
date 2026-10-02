import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { mutateManagedJsonFile } from "@bb/config/managed-json-file";
import { getNonDestroyedHost, type DbConnection } from "@bb/db";
import { readOrCreateSecretFile } from "@bb/secret-storage";
import {
  machineEnvironmentNameSchema,
  type MachineEnvironmentReplace,
  type MachineEnvironmentSet,
} from "@bb/server-contract";
import type { HostDaemonContributedEnvEntry } from "@bb/host-daemon-contract";
import { ApiError } from "../../errors.js";

const variableSchema = z
  .object({ ciphertext: z.string(), note: z.string().nullable() })
  .strict();
const storeSchema = z
  .object({
    version: z.literal(1),
    hosts: z.record(
      z.string(),
      z.record(machineEnvironmentNameSchema, variableSchema),
    ),
  })
  .strict();
type Store = z.infer<typeof storeSchema>;
type Variable = z.infer<typeof variableSchema>;
type Variables = Record<string, Variable>;

export function hostEnvironmentStorePath(dataDir: string): string {
  return join(dataDir, "plugins", "machine-env", "native", "hosts.json");
}

function keyDirectory(dataDir: string): string {
  return join(dataDir, "plugins", "machine-env", "native");
}

async function readStore(dataDir: string): Promise<Store> {
  let content: string;
  try {
    content = await readFile(hostEnvironmentStorePath(dataDir), "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return { version: 1, hosts: {} };
    throw error;
  }
  try {
    return storeSchema.parse(JSON.parse(content));
  } catch {
    throw new Error(
      "Machine environment store is invalid; restore it from backup before writing.",
    );
  }
}

async function readKey(dataDir: string, allowCreate: boolean): Promise<Buffer> {
  try {
    const directory = keyDirectory(dataDir);
    const value = allowCreate
      ? await readOrCreateSecretFile({
          dataDir: directory,
          fileName: "key",
          bytes: 32,
          encoding: "hex",
        })
      : (await readFile(join(directory, "key"), "utf8")).trim();
    if (!/^[a-f0-9]{64}$/u.test(value)) throw new Error("Invalid key");
    return Buffer.from(value, "hex");
  } catch {
    throw new Error(
      "Machine environment encryption key is unavailable; restore it from backup.",
    );
  }
}

function aad(hostId: string, name: string): Buffer {
  return Buffer.from(JSON.stringify(["bb-machine-env", 1, hostId, name]));
}

function encrypt(
  key: Buffer,
  hostId: string,
  input: MachineEnvironmentSet,
): Variable {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(aad(hostId, input.name));
  const encrypted = Buffer.concat([
    cipher.update(input.value, "utf8"),
    cipher.final(),
  ]);
  return {
    ciphertext: Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString(
      "base64",
    ),
    note: input.note,
  };
}

function decrypt(
  key: Buffer,
  hostId: string,
  name: string,
  variable: Variable,
): string {
  try {
    const bytes = Buffer.from(variable.ciphertext, "base64");
    const cipher = createDecipheriv("aes-256-gcm", key, bytes.subarray(0, 12));
    cipher.setAAD(aad(hostId, name));
    cipher.setAuthTag(bytes.subarray(12, 28));
    return Buffer.concat([
      cipher.update(bytes.subarray(28)),
      cipher.final(),
    ]).toString("utf8");
  } catch {
    throw new Error(
      `Machine environment variable ${name} cannot be decrypted; restore its encryption key or set it again.`,
    );
  }
}

async function updateVariables(
  db: DbConnection,
  dataDir: string,
  hostId: string,
  needsKey: boolean,
  mutate: (variables: Variables, key: Buffer | null) => Variables,
): Promise<void> {
  let key: Buffer | null = null;
  await mutateManagedJsonFile({
    path: hostEnvironmentStorePath(dataDir),
    read: async () => {
      const current = await readStore(dataDir);
      if (needsKey)
        key = await readKey(
          dataDir,
          Object.values(current.hosts).every(
            (variables) => Object.keys(variables).length === 0,
          ),
        );
      return current;
    },
    mutate: (current) => {
      if (!getNonDestroyedHost(db, hostId))
        throw new ApiError(404, "host_not_found", "Host not found");
      for (const id of Object.keys(current.hosts))
        if (!getNonDestroyedHost(db, id)) delete current.hosts[id];
      const variables = mutate(current.hosts[hostId] ?? {}, key);
      if (Object.keys(variables).length === 0) delete current.hosts[hostId];
      else current.hosts[hostId] = variables;
      return current;
    },
  });
}

export async function readHostEnvironmentVariables(
  dataDir: string,
  hostId: string,
) {
  const store = await readStore(dataDir);
  return Object.entries(store.hosts[hostId] ?? {})
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, variable]) => ({
      name,
      value: null,
      secret: true as const,
      note: variable.note,
    }));
}

export async function resolveHostMachineEnvironment(
  dataDir: string,
  hostId: string,
): Promise<HostDaemonContributedEnvEntry[]> {
  const variables = (await readStore(dataDir)).hosts[hostId] ?? {};
  if (Object.keys(variables).length === 0) return [];
  const key = await readKey(dataDir, false);
  return Object.entries(variables).map(([name, variable]) => ({
    name,
    value: decrypt(key, hostId, name, variable),
    reason: variable.note ?? "Per-machine environment setting",
    source: { core: "machine-environment" },
  }));
}

export function setHostEnvironmentVariable(
  db: DbConnection,
  dataDir: string,
  hostId: string,
  input: MachineEnvironmentSet,
): Promise<void> {
  return updateVariables(db, dataDir, hostId, true, (variables, key) => {
    if (key === null) throw new Error("Missing machine environment key");
    return { ...variables, [input.name]: encrypt(key, hostId, input) };
  });
}

export function deleteHostEnvironmentVariable(
  db: DbConnection,
  dataDir: string,
  hostId: string,
  name: string,
): Promise<void> {
  return updateVariables(db, dataDir, hostId, false, (variables) => {
    delete variables[name];
    return variables;
  });
}

export function replaceHostEnvironmentVariables(
  db: DbConnection,
  dataDir: string,
  hostId: string,
  input: MachineEnvironmentReplace,
): Promise<void> {
  return updateVariables(
    db,
    dataDir,
    hostId,
    input.variables.some((variable) => variable.value !== null),
    (variables, key) => {
      const next: Variables = {};
      for (const variable of input.variables) {
        if (variable.value !== null) {
          if (key === null) throw new Error("Missing machine environment key");
          next[variable.name] = encrypt(key, hostId, {
            ...variable,
            value: variable.value,
          });
        } else {
          const existing = variables[variable.name];
          if (!existing)
            throw new ApiError(
              409,
              "invalid_request",
              `No saved value for ${variable.name}; reload settings and retry`,
            );
          next[variable.name] = { ...existing, note: variable.note };
        }
      }
      return next;
    },
  );
}
