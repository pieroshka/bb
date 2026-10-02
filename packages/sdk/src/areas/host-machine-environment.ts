import type {
  HostMachineEnvironmentList,
  MachineEnvironmentReplace,
  MachineEnvironmentSet,
} from "@bb/server-contract";
import { signalRequestArgs, type CreateSdkAreaArgs } from "./common.js";

export interface HostMachineEnvironmentArea {
  experimental_machineEnvironment(args: {
    hostId: string;
    signal?: AbortSignal;
  }): Promise<HostMachineEnvironmentList>;
  experimental_replaceMachineEnvironment(
    args: { hostId: string } & MachineEnvironmentReplace,
  ): Promise<HostMachineEnvironmentList>;
  experimental_setMachineEnvironmentVariable(
    args: { hostId: string } & MachineEnvironmentSet,
  ): Promise<HostMachineEnvironmentList>;
  experimental_deleteMachineEnvironmentVariable(args: {
    hostId: string;
    name: string;
  }): Promise<HostMachineEnvironmentList>;
}

export function createHostMachineEnvironmentArea({
  transport,
}: CreateSdkAreaArgs): HostMachineEnvironmentArea {
  return {
    experimental_machineEnvironment(input) {
      return transport.readJson(
        transport.api.v1.hosts[":id"]["machine-environment"].$get(
          { param: { id: input.hostId } },
          ...signalRequestArgs(input.signal),
        ),
      );
    },
    experimental_replaceMachineEnvironment({ hostId, ...input }) {
      return transport.readJson(
        transport.api.v1.hosts[":id"]["machine-environment"].$put({
          param: { id: hostId },
          json: input,
        }),
      );
    },
    experimental_setMachineEnvironmentVariable({ hostId, ...input }) {
      return transport.readJson(
        transport.api.v1.hosts[":id"]["machine-environment"].$post({
          param: { id: hostId },
          json: input,
        }),
      );
    },
    experimental_deleteMachineEnvironmentVariable({ hostId, name }) {
      return transport.readJson(
        transport.api.v1.hosts[":id"]["machine-environment"].$delete({
          param: { id: hostId },
          json: { name },
        }),
      );
    },
  };
}
