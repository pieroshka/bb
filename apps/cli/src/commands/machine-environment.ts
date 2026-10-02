import type { Command } from "commander";
import type { MachineEnvironmentList } from "@bb/server-contract";
import { action } from "../action.js";
import { createCliBbSdk } from "../client.js";
import { outputJson } from "./helpers.js";
import { resolveMachineHostId } from "./machine.js";

type ScopeOptions = { project?: string; machine?: string; json?: boolean };

async function machineScope(
  options: ScopeOptions,
  serverUrl: string,
): Promise<string | null> {
  if (options.project && options.machine)
    throw new Error("Choose either --machine or --project.");
  return options.machine
    ? resolveMachineHostId({ serverUrl, target: options.machine })
    : null;
}

function printEnvironment(
  result: MachineEnvironmentList,
  options: { json?: boolean },
): void {
  if (outputJson(options, result)) return;
  console.log(
    `Built-in GitHub: ${result.builtInGit.status} — ${result.builtInGit.statusMessage}`,
  );
  for (const row of result.variables)
    console.log(
      `${row.name}=${row.secret ? "[secret]" : row.value}${row.note ? ` (${row.note})` : ""}`,
    );
}

async function readValue(): Promise<string> {
  if (process.stdin.isTTY)
    throw new Error(
      "Pipe the value to stdin; environment values are never accepted in command arguments.",
    );
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.byteLength;
    if (bytes > 65536)
      throw new Error("Environment value exceeds 65536 bytes.");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks)
    .toString("utf8")
    .replace(/\r?\n$/u, "");
}

export function registerMachineEnvironmentCommands(
  machine: Command,
  getUrl: () => string,
): void {
  const env = machine
    .command("env")
    .description(
      "Configure global, per-machine, or project environment variables",
    );
  env
    .command("list")
    .option(
      "--machine <id-or-name>",
      "Show this machine's overrides and inherited global variables",
    )
    .option(
      "--project <id>",
      "Show this project's overrides and inherited global variables",
    )
    .option("--json", "Print machine-readable JSON output")
    .action(
      action(async (options: ScopeOptions) => {
        const sdk = createCliBbSdk(getUrl());
        const hostId = await machineScope(options, getUrl());
        const result =
          hostId !== null
            ? await sdk.hosts.experimental_machineEnvironment({ hostId })
            : options.project
              ? await sdk.projects.machineEnvironment({
                  projectId: options.project,
                })
              : {
                  ...(await sdk.system.machineEnvironment()),
                  inheritedVariables: [],
                };
        printEnvironment(result, options);
        if (!options.json && (options.project || hostId !== null)) {
          for (const row of result.inheritedVariables) {
            const overridden = result.variables.some(
              (variable) => variable.name === row.name,
            );
            console.log(
              `${row.name}=[secret] (Global${overridden ? `; overridden by ${hostId === null ? "project" : "machine"}` : "; inherited"})`,
            );
          }
        }
      }),
    );
  env
    .command("set <NAME>")
    .description("Read a value from stdin; remove one trailing newline")
    .option("--machine <id-or-name>", "Set an override for this machine")
    .option("--project <id>", "Set an override for this project")
    .option("--note <text>", "Describe this variable")
    .option("--json", "Print machine-readable JSON output")
    .action(
      action(
        async (name: string, options: ScopeOptions & { note?: string }) => {
          const sdk = createCliBbSdk(getUrl());
          const hostId = await machineScope(options, getUrl());
          const input = {
            name,
            value: await readValue(),
            note: options.note ?? null,
          };
          printEnvironment(
            hostId !== null
              ? await sdk.hosts.experimental_setMachineEnvironmentVariable({
                  ...input,
                  hostId,
                })
              : options.project
                ? await sdk.projects.setMachineEnvironmentVariable({
                    ...input,
                    projectId: options.project,
                  })
                : await sdk.system.setMachineEnvironmentVariable(input),
            options,
          );
        },
      ),
    );
  env
    .command("unset <NAME>")
    .option(
      "--machine <id-or-name>",
      "Remove this machine's override and restore inheritance",
    )
    .option(
      "--project <id>",
      "Remove this project's override and restore inheritance",
    )
    .option("--json", "Print machine-readable JSON output")
    .action(
      action(async (name: string, options: ScopeOptions) => {
        const sdk = createCliBbSdk(getUrl());
        const hostId = await machineScope(options, getUrl());
        printEnvironment(
          hostId !== null
            ? await sdk.hosts.experimental_deleteMachineEnvironmentVariable({
                hostId,
                name,
              })
            : options.project
              ? await sdk.projects.deleteMachineEnvironmentVariable({
                  projectId: options.project,
                  name,
                })
              : await sdk.system.deleteMachineEnvironmentVariable({ name }),
          options,
        );
      }),
    );
}
