import type { BrowserScenarioCapture } from "./browserScenarioCapture.js";
import {
  enabledScenarioEventFamilies,
  type BrowserScenarioEvent,
  type BrowserScenarioEventFamily,
  type BrowserScenarioStep,
} from "./browserScenarioCaptureValues.js";
import type { BrowserScenarioAction } from "./browserScenarioValues.js";
import {
  captureEventEvidenceState,
  observeScenarioStepState,
  type BrowserScenarioStateArtifact,
  type ScenarioArtifactObservation,
} from "./browserScenarioDiffEvidence.js";
import { classifyScenarioArtifactObservations } from "./browserScenarioDiff.js";
import { scenarioNetworkTransactions } from "./browserScenarioNetworkComparison.js";
import type { BrowserScenarioEvidenceState } from "./browserScenarioDiffValues.js";
import type { AnalysisInputIssue } from "./analysisErrorCore.js";
import { err, ok, type Result } from "./result.js";

/** How one step changed page state relative to the previous step's capture. */
export type BrowserScenarioStepChange =
  | "changed"
  | "unchanged"
  | "unknown"
  | "not_compared";

/** Declared action families; the start navigation precedes every action. */
export type BrowserScenarioActionClass =
  | "start-navigation"
  | "navigation"
  | "input"
  | "wait";

const ACTION_CLASSES: Readonly<
  Record<BrowserScenarioAction["action"], BrowserScenarioActionClass>
> = {
  goto: "navigation",
  click: "input",
  fill: "input",
  press: "input",
  select_option: "input",
  check: "input",
  uncheck: "input",
  wait_for: "wait",
  wait_for_timeout: "wait",
};

const ACTION_CLASS_BY_KIND: ReadonlyMap<string, BrowserScenarioActionClass> =
  new Map(Object.entries(ACTION_CLASSES));

/** Classify a recorded action kind; unrecognized kinds stay unclassified. */
export const browserScenarioActionClass = (
  action: string,
): BrowserScenarioActionClass | undefined => ACTION_CLASS_BY_KIND.get(action);

/** Event kinds received in one sequence window, in kind order. */
export interface ReceivedScenarioEvents {
  readonly retained: number;
  readonly kinds: readonly {
    readonly kind: BrowserScenarioEvent["kind"];
    readonly count: number;
  }[];
}

/** Retained network transactions; the count is null when network was not observed. */
export interface ScenarioNetworkTransactionCount {
  readonly coverage: BrowserScenarioEvidenceState;
  readonly retained: number | null;
}

/** Capture-wide transactions, including those no step can be attributed. */
export interface ScenarioNetworkTransactionTotals extends ScenarioNetworkTransactionCount {
  /** Retained transactions whose request event was not retained, so no step counts them. */
  readonly withoutRetainedRequest: number | null;
}

type StepState = Readonly<
  Record<BrowserScenarioStateArtifact, ScenarioArtifactObservation>
>;

/** One recorded step with its derived comparison and event accounting. */
export interface BrowserScenarioStepFacts {
  readonly step: BrowserScenarioStep;
  readonly state: StepState;
  /** Comparison with the previous step's capture; absent for the start navigation. */
  readonly changes:
    | Readonly<Record<BrowserScenarioStateArtifact, BrowserScenarioStepChange>>
    | undefined;
  readonly eventCoverage: BrowserScenarioEvidenceState;
  readonly eventsReceived: ReceivedScenarioEvents;
  readonly networkTransactions: ScenarioNetworkTransactionCount;
}

/** Step facts plus accounting that belongs to no single step. */
export interface BrowserScenarioStepProjection {
  readonly steps: readonly BrowserScenarioStepFacts[];
  readonly enabledEventFamilies: readonly BrowserScenarioEventFamily[];
  /** Events received between step windows or after the final capture, such as final network drains. */
  readonly receivedOutsideStepWindows: ReceivedScenarioEvents;
  readonly networkTransactions: ScenarioNetworkTransactionTotals;
}

const tallyKinds = (
  events: readonly BrowserScenarioEvent[],
): ReceivedScenarioEvents => {
  const counts = new Map<BrowserScenarioEvent["kind"], number>();
  for (const { kind } of events) counts.set(kind, (counts.get(kind) ?? 0) + 1);
  return {
    retained: events.length,
    kinds: [...counts]
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([kind, count]) => ({ kind, count })),
  };
};

interface ReceiptWindows {
  readonly byStep: readonly BrowserScenarioEvent[][];
  readonly outside: readonly BrowserScenarioEvent[];
}

const windowIssue = (
  path: readonly (string | number)[],
  message: string,
): Result<never, AnalysisInputIssue> =>
  err({ path, reason: "invalid_value", message });

/**
 * Steps whose recorded windows received events, after checking that every
 * window, empty ones included, starts after the previous step's window ends.
 */
const nonEmptyWindows = (
  capture: BrowserScenarioCapture,
): Result<readonly BrowserScenarioStep[], AnalysisInputIssue> => {
  const windows: BrowserScenarioStep[] = [];
  let previous: BrowserScenarioStep | undefined;
  for (const step of capture.steps) {
    const { event_sequence_start: start, event_sequence_end: end } = step;
    if (end < start - 1)
      return windowIssue(
        ["steps", step.step_index, "event_sequence_end"],
        `Step ${String(step.step_index)} event window ends before it starts.`,
      );
    if (previous !== undefined && start <= previous.event_sequence_end)
      return windowIssue(
        ["steps", step.step_index, "event_sequence_start"],
        `Step ${String(step.step_index)} event window starts at or before the end of step ${String(previous.step_index)}'s window; recorded windows rise with step_index.`,
      );
    previous = step;
    if (end >= start) windows.push(step);
  }
  return ok(windows);
};

/**
 * The producer opens each step's window just before making that step current,
 * and steps after the first action that did not complete never run. An event
 * therefore belongs to the last run step whose window had opened at receipt.
 */
const stepsThatRan = (
  capture: BrowserScenarioCapture,
): readonly BrowserScenarioStep[] => {
  const unfinished = capture.steps.findIndex(
    ({ step_index: index, status }) => index > 0 && status !== "completed",
  );
  return unfinished === -1
    ? capture.steps
    : capture.steps.slice(0, unfinished + 1);
};

/**
 * Group retained events by the step whose recorded sequence window received
 * them. The producer records rising, disjoint windows and indexes every event
 * by the step current at receipt; events between one step's capture and the
 * next step's start, or after the final capture, belong to no window but keep
 * the step that was current.
 */
const eventsByReceiptWindow = (
  capture: BrowserScenarioCapture,
): Result<ReceiptWindows, AnalysisInputIssue> => {
  const windows = nonEmptyWindows(capture);
  if (!windows.ok) return windows;
  const ran = stepsThatRan(capture);
  const byStep = capture.steps.map((): BrowserScenarioEvent[] => []);
  const outside: BrowserScenarioEvent[] = [];
  const events = capture.events.items
    .map((event, index) => ({ event, index }))
    .sort((left, right) => left.event.sequence - right.event.sequence);
  let cursor = 0;
  let current = 0;
  for (const { event, index } of events) {
    while (
      current + 1 < ran.length &&
      (ran[current + 1]?.event_sequence_start ?? Infinity) <= event.sequence
    )
      current += 1;
    const expected = ran[current]?.step_index ?? 0;
    if (event.step_index !== expected)
      return windowIssue(
        ["events", "items", index, "step_index"],
        `Event ${String(event.sequence)} was received while step ${String(expected)} was current but records step_index ${String(event.step_index)}.`,
      );
    while (
      cursor < windows.value.length &&
      (windows.value[cursor]?.event_sequence_end ?? 0) < event.sequence
    )
      cursor += 1;
    const window = windows.value[cursor];
    if (window === undefined || window.event_sequence_start > event.sequence)
      outside.push(event);
    else byStep[window.step_index]?.push(event);
  }
  return ok({ byStep, outside });
};

const compareWithPrevious = (
  previous: StepState,
  current: StepState,
): Readonly<
  Record<BrowserScenarioStateArtifact, BrowserScenarioStepChange>
> => {
  const change = (artifact: BrowserScenarioStateArtifact) =>
    classifyScenarioArtifactObservations(
      artifact,
      previous[artifact],
      current[artifact],
    ).status;
  return {
    screenshot: change("screenshot"),
    dom: change("dom"),
    accessibility: change("accessibility"),
    url: change("url"),
    history: change("history"),
    storage: change("storage"),
  };
};

/**
 * Project one capture into per-step facts. Each step is compared with the
 * previous step's capture using the run comparison owner without normalization
 * rules, events are accounted by recorded receipt window, and a network
 * transaction counts toward the step of its retained request. A transaction
 * whose request event was dropped or never observed has no known starting
 * step, so only the capture-wide totals count it.
 */
export const projectBrowserScenarioSteps = (
  capture: BrowserScenarioCapture,
): Result<BrowserScenarioStepProjection, AnalysisInputIssue> => {
  const received = eventsByReceiptWindow(capture);
  if (!received.ok) return received;
  const enabledEventFamilies = enabledScenarioEventFamilies(
    capture.scenario.event_families,
    capture.scenario.network_content,
  );
  const networkObserved = enabledEventFamilies.includes("network");
  const transactions = networkObserved
    ? scenarioNetworkTransactions(capture)
    : [];
  const transactionsByStep = new Map<number, number>();
  let withoutRetainedRequest = 0;
  for (const {
    step_index: index,
    request_retained: attributed,
  } of transactions)
    if (attributed)
      transactionsByStep.set(index, (transactionsByStep.get(index) ?? 0) + 1);
    else withoutRetainedRequest += 1;
  const eventCoverage =
    enabledEventFamilies.length === 0
      ? "not_requested"
      : captureEventEvidenceState(capture);
  let previous: StepState | undefined;
  const steps = capture.steps.map((step, index): BrowserScenarioStepFacts => {
    const state = observeScenarioStepState(step, []);
    const changes =
      previous === undefined ? undefined : compareWithPrevious(previous, state);
    previous = state;
    return {
      step,
      state,
      changes,
      eventCoverage,
      eventsReceived: tallyKinds(received.value.byStep[index] ?? []),
      networkTransactions: networkObserved
        ? {
            coverage: eventCoverage,
            retained: transactionsByStep.get(step.step_index) ?? 0,
          }
        : { coverage: "not_requested", retained: null },
    };
  });
  return ok({
    steps,
    enabledEventFamilies,
    receivedOutsideStepWindows: tallyKinds(received.value.outside),
    networkTransactions: networkObserved
      ? {
          coverage: captureEventEvidenceState(capture),
          retained: transactions.length,
          withoutRetainedRequest,
        }
      : {
          coverage: "not_requested",
          retained: null,
          withoutRetainedRequest: null,
        },
  });
};
