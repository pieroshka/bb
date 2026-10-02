import { readFile, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { hosts, projects, setAppSettings, upsertHost } from "@bb/db";
import { defaultAppSettings } from "@bb/domain";
import { listServerOwnedEntries } from "@bb/server-archive";
import { eq } from "drizzle-orm";
import { createBbSdk } from "@bb/sdk/core";
import { createHttpTransport } from "@bb/sdk/node";
import { expect, it, vi } from "vitest";
import { withTestHarness, type TestAppHarness } from "../helpers/test-app.js";
import { resolveHostEnvironment } from "../../src/services/hosts/host-environment.js";
import { HostEnvironmentSync } from "../../src/services/hosts/host-environment-sync.js";
import { hostEnvironmentStorePath } from "../../src/services/machines/host-machine-environment-store.js";

function setup(harness: TestAppHarness) {
  setAppSettings(harness.db, {
    ...defaultAppSettings,
    machineGitCredentialsEnabled: false,
  });
  for (const id of ["machine-a", "machine-b"])
    upsertHost(harness.db, harness.hub, { id, name: id });
  const sdk = createBbSdk({
    transport: createHttpTransport({
      baseUrl: "http://localhost",
      runtime: "node",
      fetch: async (input, init) => harness.app.fetch(new Request(input, init)),
    }),
  });
  const value = async (
    hostId: string,
    projectId: string | null = null,
    name = "REGION",
  ) =>
    (await resolveHostEnvironment(harness.deps, { hostId, projectId })).find(
      (entry) => entry.name === name,
    )?.value;
  return { sdk, value };
}

it("keeps encrypted machine overrides isolated and below project values without changing upstream schema", async () => {
  await withTestHarness(async (harness) => {
    const { sdk, value } = setup(harness);
    const schemaBefore = harness.db.$client
      .prepare(
        "SELECT name, sql FROM sqlite_master WHERE type = 'table' ORDER BY name",
      )
      .all();
    harness.db
      .insert(projects)
      .values({ id: "project", name: "Project", createdAt: 1, updatedAt: 1 })
      .run();
    await sdk.system.setMachineEnvironmentVariable({
      name: "REGION",
      value: "global-region",
      note: null,
    });
    for (const hostId of ["machine-a", "machine-b"]) {
      await sdk.hosts.experimental_setMachineEnvironmentVariable({
        hostId,
        name: "REGION",
        value: `${hostId}-private`,
        note: "Machine",
      });
    }
    expect(await value("machine-a")).toBe("machine-a-private");
    expect(await value("machine-b")).toBe("machine-b-private");
    const metadata = await sdk.hosts.experimental_machineEnvironment({
      hostId: "machine-a",
    });
    expect(metadata).toMatchObject({
      hostId: "machine-a",
      variables: [{ name: "REGION", value: null, secret: true }],
      inheritedVariables: [{ name: "REGION", value: null }],
    });
    expect(JSON.stringify(metadata)).not.toContain("private");
    const storePath = hostEnvironmentStorePath(harness.config.dataDir);
    expect(await readFile(storePath, "utf8")).not.toContain("private");
    expect((await stat(storePath)).mode & 0o777).toBe(0o600);
    expect((await stat(join(dirname(storePath), "key"))).mode & 0o777).toBe(
      0o600,
    );
    const archived = (
      await listServerOwnedEntries(harness.config.dataDir)
    ).entries.flatMap((entry) => entry.files.map((file) => file.path));
    expect(archived).toContain("plugins/machine-env/native/hosts.json");
    expect(archived).toContain("plugins/machine-env/native/key");
    expect(
      harness.db.$client
        .prepare(
          "SELECT name, sql FROM sqlite_master WHERE type = 'table' ORDER BY name",
        )
        .all(),
    ).toEqual(schemaBefore);
    await sdk.projects.setMachineEnvironmentVariable({
      projectId: "project",
      name: "REGION",
      value: "project-region",
      note: null,
    });
    expect(await value("machine-a", "project")).toBe("project-region");
    expect(await value("machine-b", "project")).toBe("project-region");
    await sdk.projects.deleteMachineEnvironmentVariable({
      projectId: "project",
      name: "REGION",
    });
    await sdk.hosts.experimental_replaceMachineEnvironment({
      hostId: "machine-a",
      variables: [{ name: "REGION", value: null, note: "Retained" }],
    });
    expect(await value("machine-a")).toBe("machine-a-private");
    await sdk.hosts.experimental_setMachineEnvironmentVariable({
      hostId: "machine-a",
      name: "REGION",
      value: "",
      note: null,
    });
    expect(await value("machine-a")).toBe("");
    await sdk.hosts.experimental_deleteMachineEnvironmentVariable({
      hostId: "machine-a",
      name: "REGION",
    });
    expect(await value("machine-a")).toBe("global-region");
    expect(await value("machine-b")).toBe("machine-b-private");
    await expect(
      sdk.hosts.experimental_replaceMachineEnvironment({
        hostId: "machine-b",
        variables: [{ name: "MISSING", value: null, note: null }],
      }),
    ).rejects.toThrow();
    expect(await value("machine-b")).toBe("machine-b-private");
  });
});

it("rejects machine credentials and invalid input and prunes destroyed machines on the next write", async () => {
  await withTestHarness(async (harness) => {
    const { sdk, value } = setup(harness);
    await sdk.hosts.experimental_setMachineEnvironmentVariable({
      hostId: "machine-a",
      name: "REGION",
      value: "private",
      note: null,
    });
    for (const method of ["POST", "PUT", "DELETE"]) {
      const response = await harness.app.request(
        "/api/v1/hosts/machine-a/machine-environment",
        {
          method,
          headers: {
            "Content-Type": "application/json",
            "x-bb-gate-auth": "machine",
          },
          body: JSON.stringify(
            method === "PUT"
              ? { variables: [] }
              : method === "POST"
                ? { name: "REGION", value: "forbidden" }
                : { name: "REGION" },
          ),
        },
      );
      expect(response.status).toBe(403);
    }
    for (const input of [
      { name: "BAD=NAME", value: "value" },
      { name: "REGION", value: "bad\0value" },
    ]) {
      await expect(
        sdk.hosts.experimental_setMachineEnvironmentVariable({
          hostId: "machine-a",
          ...input,
          note: null,
        }),
      ).rejects.toThrow();
    }
    await expect(
      sdk.hosts.experimental_setMachineEnvironmentVariable({
        hostId: "missing",
        name: "REGION",
        value: "secret",
        note: null,
      }),
    ).rejects.toThrow();
    expect(await value("machine-a")).toBe("private");
    harness.db.delete(hosts).where(eq(hosts.id, "machine-a")).run();
    expect(await value("machine-a")).toBeUndefined();
    await expect(
      sdk.hosts.experimental_machineEnvironment({ hostId: "machine-a" }),
    ).rejects.toThrow();
    await sdk.hosts.experimental_setMachineEnvironmentVariable({
      hostId: "machine-b",
      name: "REGION",
      value: "other",
      note: null,
    });
    expect(
      await readFile(hostEnvironmentStorePath(harness.config.dataDir), "utf8"),
    ).not.toContain("machine-a");
  });
});

it("preserves concurrent writes and fails closed on missing keys, invalid stores, and ciphertext scope swapping", async () => {
  await withTestHarness(async (harness) => {
    const { sdk, value } = setup(harness);
    await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        sdk.hosts.experimental_setMachineEnvironmentVariable({
          hostId: "machine-a",
          name: `VALUE_${index}`,
          value: `private-${index}`,
          note: null,
        }),
      ),
    );
    expect(
      (await sdk.hosts.experimental_machineEnvironment({ hostId: "machine-a" }))
        .variables,
    ).toHaveLength(8);
    const path = hostEnvironmentStorePath(harness.config.dataDir);
    const original = await readFile(path, "utf8");
    const store = JSON.parse(original);
    store.hosts["machine-b"] = store.hosts["machine-a"];
    await writeFile(path, JSON.stringify(store));
    await expect(value("machine-b", null, "VALUE_0")).rejects.toThrow(
      "cannot be decrypted",
    );
    await writeFile(path, "invalid json");
    await expect(
      sdk.hosts.experimental_setMachineEnvironmentVariable({
        hostId: "machine-a",
        name: "VALUE",
        value: "new",
        note: null,
      }),
    ).rejects.toThrow();
    expect(await readFile(path, "utf8")).toBe("invalid json");
    await writeFile(path, original);
    await unlink(join(dirname(path), "key"));
    await expect(value("machine-a", null, "VALUE_0")).rejects.toThrow(
      "encryption key is unavailable",
    );
    await expect(
      sdk.hosts.experimental_setMachineEnvironmentVariable({
        hostId: "machine-b",
        name: "REGION",
        value: "new",
        note: null,
      }),
    ).rejects.toThrow();
    expect(await readFile(path, "utf8")).toBe(original);
  });
});

it("synchronizes machine-specific snapshots on writes and reconnect without changing the daemon payload", async () => {
  await withTestHarness(async (harness) => {
    const { sdk } = setup(harness);
    const sync = new HostEnvironmentSync(harness.deps);
    const sent: string[] = [];
    harness.hub.registerDaemon("machine-env-test", "machine-a", {
      send: (data) => sent.push(data),
      close: () => {},
    });
    try {
      await sdk.hosts.experimental_setMachineEnvironmentVariable({
        hostId: "machine-a",
        name: "REGION",
        value: "machine-private",
        note: null,
      });
      await vi.waitFor(() =>
        expect(
          sent.some((message) =>
            JSON.parse(message).environment?.entries?.some(
              (entry: { value: string }) => entry.value === "machine-private",
            ),
          ),
        ).toBe(true),
      );
      expect((await sync.snapshot("machine-b")).entries).toEqual([]);
      harness.hub.unregisterDaemon("machine-env-test");
      sent.length = 0;
      harness.hub.registerDaemon("machine-env-test", "machine-a", {
        send: (data) => sent.push(data),
        close: () => {},
      });
      await vi.waitFor(() =>
        expect(
          sent.some(
            (message) =>
              JSON.parse(message).type === "machine-environment.replace",
          ),
        ).toBe(true),
      );
      expect((await sync.snapshot("machine-a")).entries).toContainEqual(
        expect.objectContaining({
          name: "REGION",
          value: "machine-private",
          source: { core: "machine-environment" },
        }),
      );
    } finally {
      harness.hub.unregisterDaemon("machine-env-test");
    }
  });
});
