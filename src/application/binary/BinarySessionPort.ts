import type { InvestigationRecordPort } from "../investigation/InvestigationRecordPort.js";
import type { BinaryTarget } from "../../domain/binaryTargetTypes.js";
import type { JsonValue } from "../../domain/jsonValue.js";
import type { AnalysisSnapshot } from "../../domain/analysisSnapshot.js";
import type { AnalysisProfileCommitment } from "../../domain/analysisProfile.js";
import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import type { Result } from "../../domain/result.js";
import type { EvidenceIntegrityError } from "../../domain/evidenceErrors.js";
import type { BinarySessionOpenOptions } from "./BinarySessionOpen.js";
import type { WorkflowSnapshotRecordInput } from "./BinarySessionRecords.js";

import type {
  AnalysisExecution,
  AnalysisOperation,
  AnalysisOperationPort,
  ExecutionOptions,
  ProviderIdentity,
} from "../AnalysisProvider.js";

/** Receipt for an atomically saved snapshot followed by provider cleanup. */
export interface SavedAnalysisSnapshot {
  readonly path: string;
  readonly bytes: number;
  /** Eligible primitive query bindings. */
  readonly primitive_entries: number;
  /** Eligible composed workflow bindings, separate from primitive queries. */
  readonly workflow_entries: number;
  /** All retained Evidence records, including observations without a replay binding. */
  readonly evidence_records: number;
}

/** Cleanup extension runs inside the close transition before final ownership checks. */
export type BinarySessionCloseOptions = Pick<ExecutionOptions, "progress"> & {
  readonly retainProviderDocuments?: boolean;
  readonly afterResourceClose?: () => Promise<void>;
};

/** Target lifecycle used by CLI and MCP without exposing a concrete provider. */
export interface BinarySessionPort
  extends AnalysisOperationPort, InvestigationRecordPort {
  /** Execute only against a positively ready, already-created provider client. */
  executeIfProviderReady(
    operation: AnalysisOperation,
    parameters: Readonly<Record<string, JsonValue>>,
    options?: Pick<ExecutionOptions, "signal" | "selectorOrigin">,
  ): Promise<Result<AnalysisExecution, AnalysisError> | undefined>;
  /** Hold the active target binding through a complete composed operation. */
  withAdmittedAnalysis<Value>(
    operationName: string,
    signal: AbortSignal | undefined,
    operation: (analysis: AnalysisOperationPort) => Promise<Value>,
  ): Promise<Result<Value, AnalysisError>>;
  /** Serialize an external mutation and retire any active target afterward. */
  withAdmittedExternalMutation<Value>(
    _path: string | undefined,
    signal: AbortSignal | undefined,
    operation: (
      onDispatch: () => void,
    ) => Promise<Result<Value, AnalysisError>>,
    retirementFailure: (
      value: Result<Value, AnalysisError>,
      error: AnalysisError,
    ) => AnalysisError,
    operationName?: string,
    cleanupRecovery?: (
      failure: AnalysisError | undefined,
    ) => Promise<Result<null, AnalysisError>>,
    mutationStart?: "admission" | "provider-dispatch",
  ): Promise<Result<Result<Value, AnalysisError>, AnalysisError>>;
  open(
    path: string,
    options?: BinarySessionOpenOptions,
  ): Promise<Result<BinaryTarget, AnalysisError>>;
  close(
    options?: BinarySessionCloseOptions,
  ): Promise<Result<null, AnalysisError>>;
  /** Save a snapshot and close while excluding later provider requests. */
  closeWithSnapshot(
    path: string,
    overwrite: boolean,
    options?: BinarySessionCloseOptions,
  ): Promise<Result<SavedAnalysisSnapshot, AnalysisError>>;
  status(options?: { readonly signal?: AbortSignal }): Promise<JsonValue>;
  activeTarget(): BinaryTarget | undefined;
  exportAnalysisSnapshot(): Result<AnalysisSnapshot, AnalysisError>;
  importAnalysisSnapshot(
    snapshot: AnalysisSnapshot,
  ): Result<number, AnalysisError>;
  providerIdentity(operation?: AnalysisOperation): ProviderIdentity;
  analysisProfile(
    operation?: AnalysisOperation,
  ): AnalysisProfileCommitment | undefined;
  allowsSnapshotReplay(operation: AnalysisOperation): boolean;
  /** Invalidate cached Evidence before an external command may mutate the target. */
  recordWorkflowSnapshot(
    input: WorkflowSnapshotRecordInput,
  ): Result<null, EvidenceIntegrityError>;
  onAvailabilityChanged?(listener: () => void | Promise<void>): () => void;
  onAnalysisSnapshotChanged?(listener: () => void | Promise<void>): () => void;
}
