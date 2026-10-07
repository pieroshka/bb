import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { withTestHarness } from "../helpers/test-app.js";

describe("fork update admission", () => {
  it("closes reads, mutations and websocket admission during probation while keeping readiness available", async () => {
    await withTestHarness(async (harness) => {
      const marker = join(harness.config.dataDir, ".fork-maintenance");
      expect((await harness.app.request("/api/v1/threads")).status).toBe(200);
      writeFileSync(marker, "Candidate probation\n", { mode: 0o600 });
      for (const [path, method] of [
        ["/api/v1/threads", "GET"],
        ["/api/v1/projects", "POST"],
        ["/ws", "GET"],
        ["/", "GET"],
      ]) {
        const response = await harness.app.request(path, { method });
        expect(response.status).toBe(503);
        expect(response.headers.get("retry-after")).toBe("5");
      }
      const readiness = await harness.app.request("/health");
      expect(readiness.status).toBe(200);
      expect(await readiness.json()).toMatchObject({
        ok: true,
        forkMaintenance: true,
      });
      rmSync(marker);
      expect((await harness.app.request("/api/v1/threads")).status).toBe(200);
      expect(
        await (await harness.app.request("/health")).json(),
      ).not.toHaveProperty("forkMaintenance");
    });
  });
});
