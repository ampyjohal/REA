import type {
  BrowserScenarioCompletenessSection,
  BrowserScenarioStep,
  BrowserStepArtifacts,
} from "./browserScenarioCaptureValues.js";
import type { BrowserScenarioCapture } from "./browserScenarioCapture.js";
import {
  fingerprintScenarioNetworkTransactions,
  scenarioNetworkTransactions,
  scenarioNetworkCoverageReason,
} from "./browserScenarioNetworkComparison.js";
import type {
  BrowserScenarioArtifactKind,
  BrowserScenarioEvidenceState,
  BrowserScenarioNormalizationRule,
} from "./browserScenarioDiffValues.js";
import { digestNormalizedScenarioValue } from "./browserScenarioNormalization.js";

/** Capture-state input consumed by browser scenario artifact comparison. */
export type CaptureState<Value> =
  | { readonly state: "captured"; readonly value: Value }
  | { readonly state: "not_requested" }
  | { readonly state: "missing"; readonly reason: string }
  | {
      readonly state: "truncated";
      readonly observed: number;
      readonly retained: number;
      readonly reason: string;
    };

/**
 * Project one recorded artifact through its step outcome. The capture schema
 * keeps step completeness equal to the artifact states and outcome, so only an
 * action that did not complete makes a captured value missing.
 */
export const artifactEvidenceState = <Value>(
  artifact: BrowserScenarioArtifactKind,
  state: CaptureState<Value>,
  step: BrowserScenarioStep,
): BrowserScenarioEvidenceState => {
  if (state.state !== "captured") return state.state;
  return artifact === "action_state" && step.status !== "completed"
    ? "missing"
    : "captured";
};

/** One recorded artifact as the comparison owner sees it at one step. */
export interface ScenarioArtifactObservation {
  readonly state: BrowserScenarioEvidenceState;
  /** Normalized comparison digest; present only for ledger-captured artifacts. */
  readonly sha256: string | null;
}

/** One recorded value to observe at one step, with its comparison projection. */
export interface ScenarioArtifactInput<Value> {
  readonly artifact: BrowserScenarioArtifactKind;
  readonly state: CaptureState<Value>;
  readonly step: BrowserScenarioStep;
  readonly rules: readonly BrowserScenarioNormalizationRule[];
  readonly project?: (value: Value) => unknown;
}

/** Project one recorded value through its step ledger and comparison digest. */
export const observeScenarioArtifact = <Value>({
  artifact,
  state,
  step,
  rules,
  project = (value) => value,
}: ScenarioArtifactInput<Value>): ScenarioArtifactObservation => {
  const evidenceState = artifactEvidenceState(artifact, state, step);
  return {
    state: evidenceState,
    sha256:
      evidenceState === "captured" && state.state === "captured"
        ? digestNormalizedScenarioValue(project(state.value), artifact, rules)
        : null,
  };
};

/** Step artifacts that record page state after the step, in comparison order. */
export const BROWSER_SCENARIO_STATE_ARTIFACTS = [
  "screenshot",
  "dom",
  "accessibility",
  "url",
  "history",
  "storage",
] as const satisfies readonly (keyof BrowserStepArtifacts)[];
export type BrowserScenarioStateArtifact = keyof BrowserStepArtifacts;

const textProjection = ({ text }: { readonly text: string }): string => text;

/** Observe every page-state artifact of one step with the shared projections. */
export const observeScenarioStepState = (
  step: BrowserScenarioStep,
  rules: readonly BrowserScenarioNormalizationRule[],
): Readonly<
  Record<BrowserScenarioStateArtifact, ScenarioArtifactObservation>
> => {
  const { artifacts } = step;
  return {
    screenshot: observeScenarioArtifact({
      artifact: "screenshot",
      state: artifacts.screenshot,
      step,
      rules,
      project: screenshotProjection,
    }),
    dom: observeScenarioArtifact({
      artifact: "dom",
      state: artifacts.dom,
      step,
      rules,
      project: textProjection,
    }),
    accessibility: observeScenarioArtifact({
      artifact: "accessibility",
      state: artifacts.accessibility,
      step,
      rules,
      project: textProjection,
    }),
    url: observeScenarioArtifact({
      artifact: "url",
      state: artifacts.url,
      step,
      rules,
    }),
    history: observeScenarioArtifact({
      artifact: "history",
      state: artifacts.history,
      step,
      rules,
    }),
    storage: observeScenarioArtifact({
      artifact: "storage",
      state: artifacts.storage,
      step,
      rules,
    }),
  };
};

/**
 * Event coverage for the whole capture. The capture schema keeps missing
 * "events" the only event section in any completeness ledger and requires it
 * whenever events were dropped, so one rule covers every step.
 */
export const captureEventEvidenceState = (
  capture: BrowserScenarioCapture,
): BrowserScenarioEvidenceState => {
  const missing: readonly BrowserScenarioCompletenessSection[] =
    capture.completeness.missing_sections;
  if (capture.events.dropped > 0) return "truncated";
  return missing.includes("events") ? "missing" : "captured";
};

/** Select stable action fields for normalized comparison. */
export const actionState = (step: BrowserScenarioStep) => ({
  action: step.action,
  status: step.status,
  before_url: step.before_url,
  after_url: step.after_url,
  error: step.error,
});

/** One step's ordered events and a single indexed network graph. */
export interface ScenarioStepEvents {
  readonly events: readonly unknown[];
  readonly network_transactions: readonly string[];
}

/** Build one graph and fingerprint index per capture, then select in linear total work. */
export const prepareScenarioEvents = (
  capture: BrowserScenarioCapture,
  rules: readonly BrowserScenarioNormalizationRule[],
): {
  readonly coverageReason: string | undefined;
  readonly forStep: (stepIndex: number) => ScenarioStepEvents;
} => {
  const eventsByStep = new Map<number, unknown[]>();
  for (const { sequence: _sequence, step_index, ...event } of capture.events
    .items) {
    if ("transaction_id" in event) continue;
    const events = eventsByStep.get(step_index) ?? [];
    events.push(event);
    eventsByStep.set(step_index, events);
  }
  const nodes = scenarioNetworkTransactions(capture);
  const fingerprints = fingerprintScenarioNetworkTransactions(nodes, rules);
  const networkByStep = new Map<number, string[]>();
  for (const [index, node] of nodes.entries()) {
    const step = networkByStep.get(node.step_index) ?? [];
    const fingerprint = fingerprints[index];
    if (fingerprint === undefined)
      throw new Error("Network comparison node has no fingerprint");
    step.push(fingerprint);
    networkByStep.set(node.step_index, step);
  }
  for (const fingerprintsForStep of networkByStep.values())
    fingerprintsForStep.sort();
  return {
    coverageReason: scenarioNetworkCoverageReason(capture, nodes),
    forStep: (stepIndex) => ({
      events: eventsByStep.get(stepIndex) ?? [],
      network_transactions: networkByStep.get(stepIndex) ?? [],
    }),
  };
};

/** Different content selection is missing comparability, not an observed website change. */
export const networkContentCoverageReason = (
  before: BrowserScenarioCapture,
  after: BrowserScenarioCapture,
): string | undefined => {
  const left = before.scenario.network_content;
  const right = after.scenario.network_content;
  return left.request_body !== right.request_body ||
    left.response_body !== right.response_body ||
    left.header_values !== right.header_values
    ? "Network content selections differ; capture both sides with matching content selection before comparing network evidence."
    : undefined;
};

/** Different event-family selection is missing comparability, not an observed website change. */
export const eventFamilyCoverageReason = (
  before: BrowserScenarioCapture,
  after: BrowserScenarioCapture,
): string | undefined => {
  const left = before.scenario.event_families;
  const right = after.scenario.event_families;
  const leftFamilies = new Set(left);
  const rightFamilies = new Set(right);
  return leftFamilies.size === rightFamilies.size &&
    [...leftFamilies].every((family) => rightFamilies.has(family))
    ? undefined
    : `Event family selections differ (${familyList(leftFamilies)} before, ${familyList(rightFamilies)} after); capture both sides with matching event families before comparing event evidence.`;
};

const familyList = (families: ReadonlySet<string>): string =>
  families.size === 0 ? "none" : [...families].sort().join(", ");

/** Wrap one value as captured comparison evidence. */
export const captured = <Value>(value: Value): CaptureState<Value> => ({
  state: "captured",
  value,
});

/** Retain stable screenshot identity without embedding image bytes. */
const screenshotProjection = (
  screenshot: Extract<
    BrowserStepArtifacts["screenshot"],
    { state: "captured" }
  >["value"],
) => ({
  sha256: screenshot.sha256,
  bytes: screenshot.bytes,
  media_type: screenshot.media_type,
});
