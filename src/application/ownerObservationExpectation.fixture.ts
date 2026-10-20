import { expect } from "vitest";
import type { AnalysisError } from "../domain/analysisErrorBase.js";
import { projectAnalysisError } from "../domain/analysisErrorProjection.js";
import type { Result } from "../domain/result.js";

/** Assert the service returned the same owner error and its cause. */
export const expectOwnerError = <T>(
  result: Result<T, AnalysisError>,
  failure: AnalysisError,
  cause: unknown,
): AnalysisError => {
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("Expected the owner failure");
  expect(result.error).toBe(failure);
  expect(result.error.cause).toBe(cause);
  return result.error;
};

/** A JSON-safe incomplete observation stays on the owner error. */
export const expectKeptPartial = (
  error: AnalysisError,
  partial: unknown,
  code: "cancelled" | "provider_timeout" = "cancelled",
): void => {
  expect(error.partialObservation).toBe(partial);
  expect(error.secondaryFailures).toHaveLength(0);
  expect(projectAnalysisError(error)).toMatchObject({
    code,
    details: { partial_observation: partial },
  });
};

/** A non-JSON partial is cleared and recorded as a secondary output failure. */
export const expectDroppedPartial = (
  error: AnalysisError,
  reason: string,
  code: "cancelled" | "provider_timeout" = "cancelled",
): void => {
  expect(error.partialObservation).toBeUndefined();
  expect(error.secondaryFailures).toMatchObject([
    { _tag: "AnalysisOutputError", reason },
  ]);
  expect(projectAnalysisError(error).code).toBe(code);
};
