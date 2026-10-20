import { z } from "zod";
import { browserNetworkContentUnavailable } from "./browserNetworkEvidence.js";
import {
  capturedFieldsSchema,
  type CapturedFields,
} from "./browserScenarioCaptureFields.js";
import { refineScenarioEvents } from "./browserScenarioCaptureEvents.js";
import {
  BROWSER_SCENARIO_POPUP_GAP_FAMILIES,
  BROWSER_SCENARIO_START_STEP,
  classifyBrowserScenarioCompleteness,
  deriveStepCompleteness,
  enabledScenarioEventFamilies,
  sameCompletenessSections,
  type BrowserScenarioCompletenessSection,
} from "./browserScenarioCaptureValues.js";

/** Step 0 is always the producer's completed implicit start navigation. */
const refineStartStep = (
  { steps }: CapturedFields,
  context: z.RefinementCtx,
): void => {
  const start = steps[0];
  if (
    start !== undefined &&
    (start.step_id !== BROWSER_SCENARIO_START_STEP.step_id ||
      start.action !== BROWSER_SCENARIO_START_STEP.action ||
      start.status !== "completed")
  )
    context.addIssue({
      code: "custom",
      path: ["steps", 0],
      message: `Step 0 must be the completed implicit start navigation (step_id ${BROWSER_SCENARIO_START_STEP.step_id}, action ${BROWSER_SCENARIO_START_STEP.action})`,
    });
  // Later windows rise from here, so every receipt belongs to a window or follows one.
  if (
    start !== undefined &&
    start.event_sequence_start !==
      BROWSER_SCENARIO_START_STEP.event_sequence_start
  )
    context.addIssue({
      code: "custom",
      path: ["steps", 0, "event_sequence_start"],
      message: `Step 0's receipt window starts at event sequence ${String(BROWSER_SCENARIO_START_STEP.event_sequence_start)}`,
    });
};

const BROWSER_IDENTITIES = {
  launch: {
    process_ownership: "provider-owned",
    cleanup: "terminated-owned-process",
  },
  connect: { process_ownership: "external", cleanup: "disconnected-external" },
} as const;

/** Launch owns and terminates its browser; connect attaches to and disconnects from one. */
const refineBrowserIdentity = (
  { browser }: CapturedFields,
  context: z.RefinementCtx,
): void => {
  const expected = BROWSER_IDENTITIES[browser.mode];
  if (
    browser.process_ownership !== expected.process_ownership ||
    browser.cleanup !== expected.cleanup
  )
    context.addIssue({
      code: "custom",
      path: ["browser"],
      message: `A ${browser.mode} capture records process_ownership ${expected.process_ownership} and cleanup ${expected.cleanup}`,
    });
};

/** What in the capture itself shows that event coverage is incomplete. */
const eventGapCause = ({
  browser,
  scenario,
  events,
}: CapturedFields): string | undefined => {
  if (browser.mode === "connect") return "Connect mode";
  if (events.dropped > 0) return "Dropping events";
  const selected = enabledScenarioEventFamilies(
    scenario.event_families,
    scenario.network_content,
  );
  const popupGap = BROWSER_SCENARIO_POPUP_GAP_FAMILIES.some((family) =>
    selected.includes(family),
  );
  for (const event of events.items) {
    if (event.kind === "request-unfinished")
      return `Unfinished request ${event.transaction_id}`;
    if (
      event.kind === "network-content" &&
      browserNetworkContentUnavailable(event.headers, event.body)
    )
      return `Unavailable network content for ${event.transaction_id}`;
    if (event.kind === "popup-opened" && popupGap)
      return "A popup opened while frame, worker, WebSocket or download events were selected";
  }
  return undefined;
};

/**
 * Capture completeness aggregates the step ledgers that the steps' own facts
 * determine; only event coverage adds to it, and events are missing whenever
 * the capture shows an event gap.
 */
const refineCaptureCompleteness = (
  capture: CapturedFields,
  context: z.RefinementCtx,
): void => {
  const missing: readonly BrowserScenarioCompletenessSection[] =
    capture.completeness.missing_sections;
  const eventsMissing = missing.includes("events");
  const ledgers = capture.steps.map(deriveStepCompleteness);
  const expected = classifyBrowserScenarioCompleteness(
    [
      ...ledgers.flatMap(({ missing_sections: sections }) => sections),
      ...(eventsMissing ? (["events"] as const) : []),
    ],
    ledgers.flatMap(({ truncated_sections: sections }) => sections),
  );
  if (
    !sameCompletenessSections(missing, expected.missing_sections) ||
    !sameCompletenessSections(
      capture.completeness.truncated_sections,
      expected.truncated_sections,
    )
  )
    context.addIssue({
      code: "custom",
      path: ["completeness"],
      message:
        "Capture completeness must aggregate the step completeness ledgers, each section once; only events may add a missing section",
    });
  const gap = eventsMissing ? undefined : eventGapCause(capture);
  if (gap !== undefined)
    context.addIssue({
      code: "custom",
      path: ["completeness", "missing_sections"],
      message: `${gap} leaves event coverage incomplete, so events must be missing`,
    });
};

const sameUrl = (
  left: CapturedFields["steps"][number]["before_url"],
  right: CapturedFields["steps"][number]["after_url"],
): boolean => JSON.stringify(left) === JSON.stringify(right);

/**
 * A cancelled step captured nothing, and every step after the first action
 * that did not complete is a cancellation that never ran: no elapsed time,
 * navigation or received events. Step 0's outcome is the start-step rule's.
 */
const refineStepOutcomes = (
  { steps }: CapturedFields,
  context: z.RefinementCtx,
): void => {
  let unfinished = false;
  for (const [index, step] of steps.entries()) {
    if (
      step.status === "cancelled" &&
      Object.values(step.artifacts).some(
        ({ state }) => state === "captured" || state === "truncated",
      )
    )
      context.addIssue({
        code: "custom",
        path: ["steps", index, "artifacts"],
        message: "A cancelled step has no captured artifact",
      });
    if (
      unfinished &&
      (step.status !== "cancelled" ||
        step.elapsed_ms !== 0 ||
        step.event_sequence_end !== step.event_sequence_start - 1 ||
        !sameUrl(step.before_url, step.after_url))
    )
      context.addIssue({
        code: "custom",
        path: ["steps", index],
        message:
          "Steps after an action that did not complete are cancellations that never ran: no elapsed time, navigation or received events",
      });
    if (index > 0 && step.status !== "completed") unfinished = true;
  }
};

/** Step-indexed browser scenario observation. */
export const browserScenarioCaptureSchema = capturedFieldsSchema.superRefine(
  (capture, context) => {
    refineBrowserIdentity(capture, context);
    refineScenarioEvents(capture, context);
    refineStartStep(capture, context);
    refineStepOutcomes(capture, context);
    refineCaptureCompleteness(capture, context);
    const bySequence = new Map(
      capture.events.items.map((event) => [event.sequence, event]),
    );
    if (bySequence.size !== capture.events.items.length)
      context.addIssue({
        code: "custom",
        path: ["events", "items"],
        message: "Event sequence numbers must be unique",
      });
    for (const [index, event] of capture.events.items.entries()) {
      if (event.kind !== "network-content") continue;
      const source = bySequence.get(event.source_event_sequence);
      if (
        source?.kind !== event.phase ||
        source.transaction_id !== event.transaction_id ||
        source.sequence >= event.sequence
      )
        context.addIssue({
          code: "custom",
          path: ["events", "items", index, "source_event_sequence"],
          message:
            "Network content must reference an earlier matching transaction phase",
        });
    }
    if (capture.events.retained !== capture.events.items.length)
      context.addIssue({
        code: "custom",
        path: ["events", "retained"],
        message: "Retained event count must equal items length",
      });
    if (
      capture.events.omissions.by_kind.reduce(
        (count, omission) => count + omission.count,
        0,
      ) !== capture.events.dropped
    )
      context.addIssue({
        code: "custom",
        path: ["events", "omissions", "by_kind"],
        message: "Per-kind omission counts must equal the dropped event count",
      });
    if (capture.steps.length !== capture.scenario.action_count + 1)
      context.addIssue({
        code: "custom",
        path: ["steps"],
        message: "Capture must include initial state and one entry per action",
      });
    const expectedIndices = capture.steps.map((_, index) => index);
    if (
      capture.steps.some(
        ({ step_index: index }, offset) => index !== expectedIndices[offset],
      )
    )
      context.addIssue({
        code: "custom",
        path: ["steps"],
        message: "Step indices must be contiguous from zero",
      });
    if (
      capture.events.items.some(
        ({ step_index: index }) => index >= capture.steps.length,
      )
    )
      context.addIssue({
        code: "custom",
        path: ["events", "items"],
        message: "Event references an unknown step index",
      });
  },
);
export type BrowserScenarioCapture = z.infer<
  typeof browserScenarioCaptureSchema
>;

/** Capture fields shared by complete results and retained partial observations. */
export type BrowserScenarioCaptureData = Omit<
  BrowserScenarioCapture,
  "browser" | "steps" | "completeness" | "events"
> & {
  readonly browser: Omit<BrowserScenarioCapture["browser"], "cleanup"> & {
    readonly cleanup:
      | BrowserScenarioCapture["browser"]["cleanup"]
      | "incomplete";
  };
  readonly steps: readonly BrowserScenarioCapture["steps"][number][];
  readonly events: Omit<BrowserScenarioCapture["events"], "items"> & {
    readonly items: readonly BrowserScenarioCapture["events"]["items"][number][];
  };
};

/** Browser scenario data retained when an operation fails before a complete result. */
export interface BrowserScenarioPartialObservation {
  readonly kind: "browser-scenario-observation";
  readonly capture: BrowserScenarioCaptureData;
}
