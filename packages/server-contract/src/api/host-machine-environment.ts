import { z } from "zod";
import {
  defineRoute,
  jsonRequest,
  jsonResponse,
  noRequest,
} from "@bb/hono-typed-routes";
import type { PathId } from "../common.js";
import {
  machineEnvironmentDeleteSchema,
  machineEnvironmentSetSchema,
  projectMachineEnvironmentListSchema,
  type MachineEnvironmentDelete,
  type MachineEnvironmentSet,
} from "./machine-environment.js";
import {
  machineEnvironmentReplaceSchema,
  type MachineEnvironmentReplace,
} from "./system.js";

export const hostMachineEnvironmentListSchema =
  projectMachineEnvironmentListSchema.extend({ hostId: z.string() });
export type HostMachineEnvironmentList = z.infer<
  typeof hostMachineEnvironmentListSchema
>;

type HostEnvironmentRoute<
  Method extends "get" | "put" | "post" | "delete",
  Request,
> = {
  path: "/hosts/:id/machine-environment";
  method: Method;
  request: Request;
  response: {
    status: 200;
    format: "json";
    readonly output?: HostMachineEnvironmentList;
  };
};

export const hostMachineEnvironmentRoutes: {
  machineEnvironment: HostEnvironmentRoute<
    "get",
    ReturnType<typeof noRequest<PathId>>
  >;
  replaceMachineEnvironment: HostEnvironmentRoute<
    "put",
    ReturnType<typeof jsonRequest<PathId, MachineEnvironmentReplace>>
  >;
  setMachineEnvironmentVariable: HostEnvironmentRoute<
    "post",
    ReturnType<typeof jsonRequest<PathId, MachineEnvironmentSet>>
  >;
  deleteMachineEnvironmentVariable: HostEnvironmentRoute<
    "delete",
    ReturnType<typeof jsonRequest<PathId, MachineEnvironmentDelete>>
  >;
} = {
  machineEnvironment: defineRoute({
    path: "/hosts/:id/machine-environment",
    method: "get",
    request: noRequest<PathId>(),
    response: jsonResponse<HostMachineEnvironmentList>(),
  }),
  replaceMachineEnvironment: defineRoute({
    path: "/hosts/:id/machine-environment",
    method: "put",
    request: jsonRequest<PathId, MachineEnvironmentReplace>(
      machineEnvironmentReplaceSchema,
    ),
    response: jsonResponse<HostMachineEnvironmentList>(),
  }),
  setMachineEnvironmentVariable: defineRoute({
    path: "/hosts/:id/machine-environment",
    method: "post",
    request: jsonRequest<PathId, MachineEnvironmentSet>(
      machineEnvironmentSetSchema,
    ),
    response: jsonResponse<HostMachineEnvironmentList>(),
  }),
  deleteMachineEnvironmentVariable: defineRoute({
    path: "/hosts/:id/machine-environment",
    method: "delete",
    request: jsonRequest<PathId, MachineEnvironmentDelete>(
      machineEnvironmentDeleteSchema,
    ),
    response: jsonResponse<HostMachineEnvironmentList>(),
  }),
};
