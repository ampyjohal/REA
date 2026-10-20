import {
  reportLifecycleEnd,
  reportLifecycleStart,
} from "./lifecycleProgress.js";
import { err, ok } from "../domain/result.js";
import { AnalysisError } from "../domain/analysisErrorBase.js";
import { analysisErrorWithCleanupFailure } from "../domain/analysisErrorCleanup.js";
import { AnalysisOutputError } from "../domain/analysisErrorCore.js";
import type { Result } from "../domain/result.js";
import { mcpProgressReporter } from "./mcpProgress.js";
import type { LifecycleToolRegistration } from "./registerSessionTools.js";
import { logToolExecution } from "./toolLogging.js";
import { toolRegistrationOptions } from "./toolRegistrationOptions.js";
import type { JsonValue } from "../domain/jsonValue.js";

/** Expected lifecycle failures keep the same typed result when a child rejects. */
const closeResult = async <Value>(
  close: () => Promise<Result<Value, AnalysisError>>,
): Promise<Result<Value, AnalysisError>> => {
  try {
    return await close();
  } catch (cause: unknown) {
    if (cause instanceof AnalysisError) return err(cause);
    throw cause;
  }
};

/** Register provider cleanup and optional pre-close snapshot persistence. */
export const registerCloseLifecycleTool = ({
  server,
  session,
  logger,
  closeContract,
  closeProcessResources,
  retryReverseEngineeringCleanup,
}: LifecycleToolRegistration): void => {
  const closeWithResources = async <Value>(
    closeSession: (
      afterResourceClose: () => Promise<void>,
    ) => Promise<Result<Value, AnalysisError>>,
    snapshotReceipt?: (value: Value) => Readonly<Record<string, JsonValue>>,
  ): Promise<Result<Value, AnalysisError>> => {
    let reverseRetry:
      | Promise<PromiseSettledResult<Result<null, AnalysisError>>>
      | undefined;
    const retryReverse = async (): Promise<void> => {
      reverseRetry ??= Promise.allSettled([
        Promise.resolve().then(() =>
          closeResult(
            async () =>
              retryReverseEngineeringCleanup?.(closeContract.name) ?? ok(null),
          ),
        ),
      ]).then(([result]) => result!);
      await reverseRetry;
    };
    const [sessionClose, resourceClose] = await Promise.allSettled([
      closeResult(() => closeSession(retryReverse)),
      closeResult(closeProcessResources),
    ]);
    // Snapshot export/write or an unexpected session failure can return before
    // the resource-close hook. Retry those owners once after the transition.
    await retryReverse();
    const reverseCleanup = await reverseRetry!;
    if (sessionClose.status === "rejected") {
      if (resourceClose.status === "rejected")
        logger.warn(
          {
            error:
              resourceClose.reason instanceof Error
                ? resourceClose.reason.message
                : String(resourceClose.reason),
          },
          "Process capture cleanup threw while closing the session",
        );
      else if (!resourceClose.value.ok)
        logger.warn(
          { error: resourceClose.value.error.message },
          "Process capture cleanup failed while closing the session",
        );
      if (reverseCleanup.status === "rejected")
        logger.warn(
          { error: String(reverseCleanup.reason) },
          "Reverse-engineering cleanup threw while closing the session",
        );
      else if (!reverseCleanup.value.ok)
        logger.warn(
          { error: reverseCleanup.value.error.message },
          "Reverse-engineering cleanup failed while closing the session",
        );
      throw sessionClose.reason;
    }
    if (reverseCleanup.status === "rejected") {
      if (
        snapshotReceipt !== undefined &&
        sessionClose.status === "fulfilled" &&
        sessionClose.value.ok
      ) {
        const reverseFailure = new AnalysisOutputError(
          closeContract.name,
          "Reverse-engineering cleanup failed unexpectedly.",
          {
            cause: reverseCleanup.reason,
            cleanup: {
              reason: "cleanup callback rejected unexpectedly",
              resources: ["reverse-engineering cleanup"],
            },
          },
        );
        const resourceFailure =
          resourceClose.status === "rejected"
            ? new AnalysisOutputError(
                closeContract.name,
                "Process capture cleanup failed unexpectedly.",
                {
                  cause: resourceClose.reason,
                  cleanup: {
                    reason: "cleanup callback rejected unexpectedly",
                    resources: ["process capture cleanup"],
                  },
                },
              )
            : resourceClose.value.ok
              ? undefined
              : resourceClose.value.error;
        const failure =
          resourceFailure === undefined
            ? reverseFailure
            : analysisErrorWithCleanupFailure(
                reverseFailure,
                resourceFailure,
              ).bindCleanupDependencies([reverseFailure, resourceFailure]);
        return err(
          failure.retainDiagnostics(snapshotReceipt(sessionClose.value.value)),
        );
      }
      throw reverseCleanup.reason;
    }
    if (resourceClose.status === "rejected") {
      if (
        snapshotReceipt !== undefined &&
        sessionClose.status === "fulfilled" &&
        sessionClose.value.ok
      )
        return err(
          new AnalysisOutputError(
            closeContract.name,
            "Process capture cleanup failed unexpectedly.",
            {
              cause: resourceClose.reason,
              cleanup: {
                reason: "cleanup callback rejected unexpectedly",
                resources: ["process capture cleanup"],
              },
            },
          ).retainDiagnostics(snapshotReceipt(sessionClose.value.value)),
        );
      throw resourceClose.reason;
    }
    const closed = sessionClose.value;
    const resources = resourceClose.value;
    const reverse = reverseCleanup.value;
    // Keep live reverse ownership primary, but never let one successful retry
    // acknowledge independent session or process-capture owners.
    const failures = [
      ...(reverse.ok ? [] : [reverse.error]),
      ...(closed.ok ? [] : [closed.error]),
      ...(resources.ok ? [] : [resources.error]),
    ];
    let failure = failures[0];
    for (const next of failures.slice(1))
      if (failure !== undefined)
        failure = analysisErrorWithCleanupFailure(
          failure,
          next,
        ).bindCleanupDependencies([failure, next]);
    if (failure === undefined) return closed;
    if (snapshotReceipt !== undefined && closed.ok)
      failure.retainDiagnostics(snapshotReceipt(closed.value));
    else if (snapshotReceipt !== undefined && !closed.ok) {
      const savedSnapshot = closed.error.diagnostics?.saved_snapshot;
      if (savedSnapshot !== undefined)
        failure.retainDiagnostics({ saved_snapshot: savedSnapshot });
    }
    return err(failure);
  };
  server.registerTool(
    closeContract.name,
    toolRegistrationOptions(closeContract),
    async (input, context) => {
      const progress = mcpProgressReporter(context);
      const snapshotPath = input.snapshot_path;
      if (snapshotPath === undefined) {
        // Enqueue the lifecycle transition before awaiting progress transport so
        // a later open request cannot overtake this close.
        const closing = logToolExecution(logger, closeContract.name, () =>
          closeWithResources((afterResourceClose) =>
            session.close({ progress, afterResourceClose }),
          ),
        );
        await reportLifecycleStart(progress, closeContract.name);
        const closed = await closing;
        await reportLifecycleEnd(progress, closeContract.name, closed.ok);
        return server.delivery.toCallToolResult(closed, closeContract);
      }
      const closing = logToolExecution(logger, closeContract.name, () =>
        closeWithResources(
          (afterResourceClose) =>
            session.closeWithSnapshot(snapshotPath, input.overwrite, {
              progress,
              afterResourceClose,
            }),
          (receipt) => ({
            saved_snapshot: {
              path: receipt.path,
              bytes: receipt.bytes,
              primitive_entries: receipt.primitive_entries,
              workflow_entries: receipt.workflow_entries,
              evidence_records: receipt.evidence_records,
            },
          }),
        ),
      );
      await reportLifecycleStart(
        progress,
        closeContract.name,
        "saving snapshot; closing provider",
      );
      const closed = await closing;
      await reportLifecycleEnd(progress, closeContract.name, closed.ok);
      return server.delivery.toCallToolResult(
        closed.ok ? ok({ ...closed.value }) : closed,
        closeContract,
      );
    },
  );
};
