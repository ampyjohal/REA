import type { EvidenceProvider } from "../../domain/evidence.js";
import type {
  ObjdumpSelection,
  RizinInput,
} from "../../domain/reverseEngineering.js";

/** Capacity refusal emitted before a provider command has been resolved. */
export const PROVIDER_COMMAND_RESOLUTION_CAPACITY_ERROR_CODE =
  "EREA_PROVIDER_COMMAND_RESOLUTION_CAPACITY";

/** Provider-neutral command profile consumed by the shared application workflow. */
export interface ReverseEngineeringProviderCommand {
  readonly executable: string;
  readonly arguments: readonly string[];
  readonly identity: EvidenceProvider;
  readonly environmentOverrides?: Readonly<NodeJS.ProcessEnv>;
}

/** Provider-specific command construction stays outside the application layer. */
export interface ReverseEngineeringCommandPort {
  /** Wait until canceled provider-resolution filesystem probes physically settle. */
  drainPendingResolution?(): Promise<void>;
  objdump(
    input: ObjdumpSelection,
    options?: { readonly signal?: AbortSignal; readonly cwd?: string },
  ):
    | ReverseEngineeringProviderCommand
    | Promise<ReverseEngineeringProviderCommand>;
  rizin(
    input: RizinInput,
    options?: { readonly signal?: AbortSignal; readonly cwd?: string },
  ):
    | ReverseEngineeringProviderCommand
    | Promise<ReverseEngineeringProviderCommand>;
}
