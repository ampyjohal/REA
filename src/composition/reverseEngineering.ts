import type { ReverseEngineeringServiceRuntimeOptions } from "../application/reverse/ReverseEngineeringService.js";
import type { ReverseEngineeringCommandPort } from "../application/reverse/ReverseEngineeringCommandPort.js";
import { ReverseEngineeringService } from "../application/reverse/ReverseEngineeringService.js";
import {
  objdumpCommand,
  OBJDUMP_PROVIDER_IDENTITY,
} from "../objdump/ObjdumpCommand.js";
import {
  rizinCommand,
  RIZIN_PROVIDER_IDENTITY,
} from "../rizin/RizinCommand.js";
import { resolveWindowsProviderExecutable } from "./resolveWindowsProviderExecutable.js";
import type { WindowsExecutableLookup } from "./resolveWindowsProviderExecutable.js";

export interface ReverseEngineeringCommandPortOptions {
  /** Test seam for filesystem providers that implement non-cancellable lookup. */
  readonly windowsExecutableLookup?: Pick<WindowsExecutableLookup, "isFile">;
}

export const createReverseEngineeringCommandPort = (
  environment: Readonly<NodeJS.ProcessEnv>,
  platform: NodeJS.Platform = process.platform,
  options: ReverseEngineeringCommandPortOptions = {},
): ReverseEngineeringCommandPort => {
  const pendingResolution = new Set<Promise<unknown>>();
  const onProbe = (probe: Promise<unknown>): void => {
    pendingResolution.add(probe);
    void probe.then(
      () => pendingResolution.delete(probe),
      () => pendingResolution.delete(probe),
    );
  };
  const drainPendingResolution = async (): Promise<void> => {
    while (pendingResolution.size > 0)
      await Promise.allSettled(pendingResolution);
  };
  return {
    drainPendingResolution,
    objdump: async (input, commandOptions) => ({
      executable: await providerExecutable(
        environment.REA_OBJDUMP_COMMAND ?? "objdump",
        environment,
        platform,
        commandOptions?.signal,
        commandOptions?.cwd,
        options.windowsExecutableLookup?.isFile,
        onProbe,
      ),
      arguments: objdumpCommand(input),
      identity: OBJDUMP_PROVIDER_IDENTITY,
      environmentOverrides: { DEBUGINFOD_URLS: "" },
    }),
    rizin: async (input, commandOptions) => ({
      executable: await providerExecutable(
        environment.REA_RIZIN_COMMAND ?? "rizin",
        environment,
        platform,
        commandOptions?.signal,
        commandOptions?.cwd,
        options.windowsExecutableLookup?.isFile,
        onProbe,
      ),
      arguments: rizinCommand(input),
      identity: RIZIN_PROVIDER_IDENTITY,
    }),
  };
};

const providerExecutable = (
  executable: string,
  environment: Readonly<NodeJS.ProcessEnv>,
  platform: NodeJS.Platform,
  signal?: AbortSignal,
  cwd?: string,
  isFile?: WindowsExecutableLookup["isFile"],
  onProbe?: WindowsExecutableLookup["onProbe"],
): string | Promise<string> =>
  platform === "win32"
    ? resolveWindowsProviderExecutable(executable, environment, {
        signal,
        ...(isFile === undefined ? {} : { isFile }),
        ...(onProbe === undefined ? {} : { onProbe }),
        ...(cwd === undefined ? {} : { cwd }),
      })
    : executable;

/** Compose BYO reverse-engineering commands without acquiring tools at import time. */
export const createReverseEngineeringService = (
  environment: Readonly<NodeJS.ProcessEnv> = process.env,
  options: ReverseEngineeringServiceRuntimeOptions = {},
): ReverseEngineeringService => {
  const environmentSnapshot = { ...environment };
  return new ReverseEngineeringService({
    ...options,
    environment: environmentSnapshot,
    commands: createReverseEngineeringCommandPort(environmentSnapshot),
  });
};
