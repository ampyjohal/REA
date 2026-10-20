import {
  reportLifecycleEnd,
  reportLifecycleStart,
} from "./lifecycleProgress.js";
import { err, ok } from "../domain/result.js";
import { AnalysisError } from "../domain/analysisErrorBase.js";
import { analysisErrorWithCleanupFailure } from "../domain/analysisErrorCleanup.js";
import type { Result } from "../domain/result.js";
import { mcpProgressReporter } from "./mcpProgress.js";
import type { LifecycleToolRegistration } from "./registerSessionTools.js";
import { logToolExecution } from "./toolLogging.js";
import { toolRegistrationOptions } from "./toolRegistrationOptions.js";

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
    if (resourceClose.status === "rejected") throw resourceClose.reason;
    if (reverseCleanup.status === "rejected") throw reverseCleanup.reason;
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
    return failure === undefined ? closed : err(failure);
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
        closeWithResources((afterResourceClose) =>
          session.closeWithSnapshot(snapshotPath, input.overwrite, {
            progress,
            afterResourceClose,
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
