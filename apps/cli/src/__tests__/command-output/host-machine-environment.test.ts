import { describe, expect, it, vi } from "vitest";
import { registerMachineCommands } from "../../commands/machine.js";
import {
  runCommand,
  setupCommandOutputTestEnvironment,
} from "../helpers/command-output-harness.js";

describe("per-machine environment CLI", () => {
  setupCommandOutputTestEnvironment();
  it("targets offline machines by name and rejects mixed scopes before reading secrets", async () => {
    const requests: Request[] = [];
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      const request = new Request(input, init);
      requests.push(request);
      return Response.json(
        request.url.endsWith("/hosts?includeCreating=true")
          ? [{ id: "host-a", name: "Laptop", status: "disconnected" }]
          : {
              hostId: "host-a",
              builtInGit: { status: "disabled", statusMessage: "Disabled" },
              variables: [],
              inheritedVariables: [],
            },
      );
    });
    const register = (program: import("commander").Command) =>
      registerMachineCommands(program, () => "http://server");
    await runCommand(
      ["machine", "env", "list", "--machine", "Laptop", "--json"],
      register,
    );
    expect(requests.at(-1)?.url).toBe(
      "http://server/api/v1/hosts/host-a/machine-environment",
    );
    await runCommand(
      ["machine", "env", "unset", "REGION", "--machine", "Laptop", "--json"],
      register,
    );
    expect(requests.at(-1)?.method).toBe("DELETE");
    expect(await requests.at(-1)?.json()).toEqual({ name: "REGION" });
    const before = requests.length;
    await expect(
      runCommand(
        [
          "machine",
          "env",
          "set",
          "REGION",
          "--machine",
          "Laptop",
          "--project",
          "proj-a",
        ],
        register,
      ),
    ).rejects.toThrow("process.exit:1");
    expect(requests).toHaveLength(before);
  });
});
