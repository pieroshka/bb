import { lstatSync } from "node:fs";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";

export function isForkMaintenanceHeld(dataDir: string): boolean {
  try {
    const entry = lstatSync(join(dataDir, ".fork-maintenance"));
    if (!entry.isFile()) throw new Error("Invalid fork maintenance marker");
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return false;
    throw error;
  }
}

export async function waitForForkMaintenance(
  dataDir: string,
  signal: AbortSignal,
): Promise<void> {
  while (isForkMaintenanceHeld(dataDir)) {
    await setTimeout(250, undefined, { signal });
  }
  signal.throwIfAborted();
}
