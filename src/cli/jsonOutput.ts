import type { Writable } from "node:stream";

import { bufferedJsonParts, jsonParts } from "../domain/jsonSerialization.js";

type JsonOutputFormat = "json" | "jsonl";

export const JSONL_COVERAGE_SCHEMA =
  "https://rea.dev/schemas/jsonl-coverage-v1.json" as const;
export const JSONL_ERROR_SCHEMA =
  "https://rea.dev/schemas/jsonl-error-v1.json" as const;

export interface ExtractedRowCollection {
  readonly records: readonly unknown[];
  readonly coverage?: Readonly<Record<string, unknown>>;
  readonly limitations?: readonly string[];
  readonly unknowns?: readonly string[];
}

/** Extract deterministic records and coverage from row-oriented results. */
export const extractRowCollection = (
  value: unknown,
): ExtractedRowCollection | undefined => {
  if (Array.isArray(value)) {
    return { records: value };
  }
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const candidate = value as Record<string, unknown>;
  const inner =
    typeof candidate.normalized_result === "object" &&
    candidate.normalized_result !== null
      ? (candidate.normalized_result as Record<string, unknown>)
      : candidate;

  let records: readonly unknown[] | undefined;
  if (Array.isArray(inner.rows)) records = inner.rows;
  else if (Array.isArray(inner.items)) records = inner.items;
  else if (Array.isArray(inner.occurrences)) records = inner.occurrences;
  else if (Array.isArray(inner.records)) records = inner.records;

  if (records === undefined) return undefined;

  const coverage =
    typeof inner.coverage === "object" && inner.coverage !== null
      ? (inner.coverage as Record<string, unknown>)
      : undefined;

  const limitations = Array.isArray(inner.limitations)
    ? (inner.limitations as string[])
    : Array.isArray(candidate.limitations)
      ? (candidate.limitations as string[])
      : undefined;

  const unknowns = Array.isArray(inner.unknowns)
    ? (inner.unknowns as string[])
    : Array.isArray(candidate.unknowns)
      ? (candidate.unknowns as string[])
      : undefined;

  return {
    records,
    ...(coverage !== undefined ? { coverage } : {}),
    ...(limitations !== undefined ? { limitations } : {}),
    ...(unknowns !== undefined ? { unknowns } : {}),
  };
};

/** Determine if a CLI result has a clear row/record boundary for JSON Lines. */
export const hasClearRecordBoundary = (
  value: unknown,
  hasFilter = false,
): boolean => {
  if (hasFilter) return true;
  return extractRowCollection(value) !== undefined;
};

export const isJsonLinesError = (value: unknown): boolean => {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  if (candidate.ok === false && "error" in candidate) return true;
  if (
    typeof candidate.code === "string" &&
    typeof candidate.category === "string" &&
    typeof candidate.message === "string"
  )
    return true;
  return false;
};

export const formatJsonLinesError = (
  value: unknown,
): Record<string, unknown> => {
  if (typeof value === "object" && value !== null) {
    const candidate = value as Record<string, unknown>;
    if (candidate.ok === false && "error" in candidate) {
      return {
        $schema: JSONL_ERROR_SCHEMA,
        type: "error",
        ok: false,
        error: candidate.error,
        ...(candidate.meta !== undefined ? { meta: candidate.meta } : {}),
      };
    }
  }
  return {
    $schema: JSONL_ERROR_SCHEMA,
    type: "error",
    ok: false,
    error: value,
  };
};

/**
 * Write ordinary JSON without constructing a document-sized string.
 *
 * `json` is indented for a terminal reader. Piped or redirected output, which
 * agents and scripts consume, is compact: indentation adds no information and
 * measured 16-45% more model tokens on real results. The value is identical.
 */
export const writeJsonOutput = async (
  value: unknown,
  destination: Writable,
  format: JsonOutputFormat = "json",
): Promise<void> => {
  for (const part of bufferedJsonParts(
    jsonOutputParts(value, format, isTerminal(destination)),
  ))
    await writeOutputText(destination, part);
};

const isTerminal = (destination: Writable): boolean =>
  "isTTY" in destination && destination.isTTY === true;

export const writeOutputText = (
  destination: Writable,
  part: string,
): Promise<void> =>
  new Promise((resolve, reject) => {
    const onError = (cause: unknown): void => reject(cause);
    destination.once("error", onError);
    try {
      destination.write(part, (cause) => {
        if (cause) {
          // A Writable can emit its error after invoking the write callback.
          setImmediate(() => destination.off("error", onError));
          reject(cause);
        } else {
          destination.off("error", onError);
          resolve();
        }
      });
    } catch (cause: unknown) {
      destination.off("error", onError);
      reject(cause);
    }
  });

/** The exact formatted document, including its final newline. */
export function* jsonOutputParts(
  value: unknown,
  format: JsonOutputFormat,
  pretty = true,
): Generator<string> {
  if (format === "jsonl") {
    if (isJsonLinesError(value)) {
      yield* jsonParts(formatJsonLinesError(value));
      yield "\n";
      return;
    }
    const collection = extractRowCollection(value);
    if (collection !== undefined) {
      for (const item of collection.records) {
        yield* jsonParts(item);
        yield "\n";
      }
      if (collection.coverage !== undefined) {
        const coverageRecord: Record<string, unknown> = {
          $schema: JSONL_COVERAGE_SCHEMA,
          type: "coverage",
          coverage: collection.coverage,
        };
        if (collection.limitations && collection.limitations.length > 0)
          coverageRecord.limitations = collection.limitations;
        if (collection.unknowns && collection.unknowns.length > 0)
          coverageRecord.unknowns = collection.unknowns;
        yield* jsonParts(coverageRecord);
        yield "\n";
      }
      return;
    }
  }
  yield* jsonParts(value, pretty && format === "json");
  yield "\n";
}
