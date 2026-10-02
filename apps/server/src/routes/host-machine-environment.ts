import type { Hono } from "hono";
import { getNonDestroyedHost } from "@bb/db";
import {
  publicApiRoutes,
  typedRoutes,
  type PublicApiSchema,
} from "@bb/server-contract";
import { ApiError } from "../errors.js";
import {
  getGateAuthKind,
  type GateAuthHeaderReader,
} from "../request-context.js";
import type { AppDeps } from "../types.js";
import { machineEnvironmentView } from "../services/machines/environment-settings.js";
import {
  readHostEnvironmentVariables,
  setHostEnvironmentVariable,
  deleteHostEnvironmentVariable,
  replaceHostEnvironmentVariables,
} from "../services/machines/host-machine-environment-store.js";

export function registerHostMachineEnvironmentRoutes(
  app: Hono,
  deps: AppDeps,
): void {
  const { get, post, put, del } = typedRoutes<PublicApiSchema>(app, {
    onValidationError: (message) =>
      new ApiError(400, "invalid_request", message),
  });
  const routes = publicApiRoutes.hosts;
  const requireHost = (hostId: string) => {
    if (!getNonDestroyedHost(deps.db, hostId))
      throw new ApiError(404, "host_not_found", "Host not found");
  };
  const requireWrite = (context: GateAuthHeaderReader) => {
    if (getGateAuthKind(context) === "machine")
      throw new ApiError(
        403,
        "machine_host_management_forbidden",
        "Machine credentials cannot manage hosts",
      );
  };
  const changed = () => {
    deps.lifecycleDedupers.providerModelCatalogs.markAllStale();
    deps.hub.notifySystem(["config-changed"]);
  };
  const view = async (hostId: string) => {
    requireHost(hostId);
    const global = await machineEnvironmentView(deps.db);
    const variables = await readHostEnvironmentVariables(
      deps.config.dataDir,
      hostId,
    );
    return {
      hostId,
      variables,
      inheritedVariables: global.variables,
      builtInGit: variables.some((variable) => variable.name === "GH_TOKEN")
        ? {
            status: "overridden" as const,
            statusMessage: "Overridden for this machine.",
          }
        : global.builtInGit,
    };
  };
  get(routes.machineEnvironment, async (context) =>
    context.json(await view(context.req.param("id"))),
  );
  post(routes.setMachineEnvironmentVariable, async (context, input) => {
    requireWrite(context);
    const hostId = context.req.param("id");
    requireHost(hostId);
    await setHostEnvironmentVariable(
      deps.db,
      deps.config.dataDir,
      hostId,
      input,
    );
    changed();
    return context.json(await view(hostId));
  });
  put(routes.replaceMachineEnvironment, async (context, input) => {
    requireWrite(context);
    const hostId = context.req.param("id");
    requireHost(hostId);
    await replaceHostEnvironmentVariables(
      deps.db,
      deps.config.dataDir,
      hostId,
      input,
    );
    changed();
    return context.json(await view(hostId));
  });
  del(routes.deleteMachineEnvironmentVariable, async (context, input) => {
    requireWrite(context);
    const hostId = context.req.param("id");
    requireHost(hostId);
    await deleteHostEnvironmentVariable(
      deps.db,
      deps.config.dataDir,
      hostId,
      input.name,
    );
    changed();
    return context.json(await view(hostId));
  });
}
