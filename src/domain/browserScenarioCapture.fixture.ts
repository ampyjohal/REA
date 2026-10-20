import { createHash } from "node:crypto";

import {
  browserScenarioSchema,
  type BrowserScenario,
} from "./browserScenario.js";
import {
  browserScenarioCaptureSchema,
  type BrowserScenarioCapture,
} from "./browserScenarioCapture.js";
import {
  browserScenarioCompletenessSchema,
  classifyBrowserScenarioCompleteness,
  deriveStepCompleteness,
  type BrowserScenarioEvent,
  type BrowserScenarioStep,
  type BrowserStepArtifacts,
} from "./browserScenarioCaptureValues.js";
import { DEFAULT_BROWSER_SCENARIO_CAPTURE_LIMITS } from "./browserScenarioCaptureLimits.js";
import { digestCanonicalValue } from "./canonicalDigest.js";
import { jsonObjectSchema, type JsonValue } from "./jsonValue.js";

const ORIGIN = "http://127.0.0.1:8080";

/** Sanitized URL as the scenario provider records it. */
export const scenarioFixtureUrl = (path: string) => ({
  url: `${ORIGIN}${path}`,
  origin: ORIGIN,
  query_parameter_names: [],
  redacted: false,
});

const textArtifact = (text: string) => {
  const bytes = Buffer.from(text);
  return {
    state: "captured" as const,
    value: {
      sha256: createHash("sha256").update(bytes).digest("hex"),
      bytes: bytes.byteLength,
      text,
    },
  };
};

const notRequested = { state: "not_requested" as const };

const stepArtifacts = (
  overrides: Partial<BrowserStepArtifacts>,
): BrowserStepArtifacts => ({
  screenshot: notRequested,
  dom: notRequested,
  accessibility: notRequested,
  url: notRequested,
  history: notRequested,
  storage: notRequested,
  ...overrides,
});

const step = (
  input: Omit<BrowserScenarioStep, "completeness" | "status" | "error"> & {
    readonly status?: BrowserScenarioStep["status"];
    readonly error?: string;
  },
): BrowserScenarioStep => {
  const status = input.status ?? "completed";
  const outcome =
    status === "completed"
      ? { status, error: null }
      : { status, error: input.error ?? "step did not complete" };
  return {
    ...input,
    ...outcome,
    completeness: deriveStepCompleteness({
      status,
      artifacts: input.artifacts,
    }),
  } as BrowserScenarioStep;
};

interface NetworkEventFixture {
  readonly sequence: number;
  readonly stepIndex: number;
  readonly kind: "request" | "response" | "request-finished";
  readonly transactionId: string;
  readonly method: string;
  readonly path: string;
}

const network = ({
  sequence,
  stepIndex,
  kind,
  transactionId,
  method,
  path,
}: NetworkEventFixture): BrowserScenarioEvent =>
  ({
    sequence,
    step_index: stepIndex,
    kind,
    transaction_id: transactionId,
    redirected_from_transaction_id: null,
    redirected_from_transaction_state: "root",
    method,
    url: scenarioFixtureUrl(path),
    resource_type: path === "/app" ? "document" : "fetch",
    header_names: [],
    status: kind === "response" ? 200 : null,
    failure: null,
  }) as BrowserScenarioEvent;

const consoleEvent = (
  sequence: number,
  stepIndex: number,
  text: string,
): BrowserScenarioEvent => ({
  sequence,
  step_index: stepIndex,
  kind: "console",
  level: "info",
  text,
  url: null,
});

/** Accessibility text of the settings page before the dialog opens and after it closes. */
export const SCENARIO_FIXTURE_CLOSED_TREE =
  '- main:\n  - button "Settings"\n  - button "Save"';
/** Accessibility text while the settings dialog is open. */
export const SCENARIO_FIXTURE_OPEN_TREE =
  '- main:\n  - button "Settings"\n  - button "Save"\n- dialog "Settings":\n  - button "Close"';

/** Declared four-action scenario recorded in the fixture's Evidence parameters. */
export const browserScenarioFixtureScenario = (
  overrides: Readonly<Record<string, unknown>> = {},
): BrowserScenario =>
  browserScenarioSchema.parse({
    browser: { mode: "launch", executable_path: "/opt/chromium/chrome" },
    start_url: { url: `${ORIGIN}/app` },
    actions: [
      {
        step_id: "open-settings",
        action: "click",
        locator: { kind: "role", role: "button", name: "Settings" },
      },
      {
        step_id: "close-settings",
        action: "click",
        locator: { kind: "role", role: "button", name: "Close" },
      },
      {
        step_id: "save",
        action: "click",
        locator: { kind: "test_id", value: "save" },
        timeout_ms: 500,
      },
      {
        step_id: "confirm-saved",
        action: "wait_for",
        locator: { kind: "role", role: "dialog", name: "Saved" },
        state: "visible",
      },
    ],
    capture: {
      after_each_step: ["accessibility", "url"],
      at_end: ["screenshot"],
      events: ["console", "network"],
    },
    ...overrides,
  });

const fixtureSteps = (): BrowserScenarioStep[] => {
  const page = scenarioFixtureUrl("/app");
  const cancelledReason = "action was not executed after an earlier failure";
  return [
    step({
      step_index: 0,
      step_id: "scenario_start",
      action: "goto_start",
      elapsed_ms: 30,
      before_url: page,
      after_url: page,
      event_sequence_start: 1,
      event_sequence_end: 3,
      artifacts: stepArtifacts({
        accessibility: textArtifact(SCENARIO_FIXTURE_CLOSED_TREE),
        url: { state: "captured", value: page },
      }),
    }),
    step({
      step_index: 1,
      step_id: "open-settings",
      action: "click",
      elapsed_ms: 12,
      before_url: page,
      after_url: page,
      event_sequence_start: 4,
      event_sequence_end: 4,
      artifacts: stepArtifacts({
        accessibility: textArtifact(SCENARIO_FIXTURE_OPEN_TREE),
        url: { state: "captured", value: page },
      }),
    }),
    step({
      step_index: 2,
      step_id: "close-settings",
      action: "click",
      elapsed_ms: 11,
      before_url: page,
      after_url: page,
      event_sequence_start: 5,
      event_sequence_end: 4,
      artifacts: stepArtifacts({
        accessibility: textArtifact(SCENARIO_FIXTURE_CLOSED_TREE),
        url: { state: "captured", value: page },
      }),
    }),
    step({
      step_index: 3,
      step_id: "save",
      action: "click",
      status: "failed",
      error: "locator.click: Timeout 500ms exceeded.",
      elapsed_ms: 520,
      before_url: page,
      after_url: page,
      event_sequence_start: 5,
      event_sequence_end: 6,
      artifacts: stepArtifacts({
        accessibility: textArtifact(SCENARIO_FIXTURE_CLOSED_TREE),
        url: { state: "captured", value: page },
      }),
    }),
    step({
      step_index: 4,
      step_id: "confirm-saved",
      action: "wait_for",
      status: "cancelled",
      error: "not executed after an earlier action failure",
      elapsed_ms: 0,
      before_url: page,
      after_url: page,
      event_sequence_start: 7,
      event_sequence_end: 6,
      artifacts: stepArtifacts({
        screenshot: { state: "missing", reason: cancelledReason },
        accessibility: { state: "missing", reason: cancelledReason },
        url: { state: "missing", reason: cancelledReason },
      }),
    }),
  ];
};

const fixtureEvents = (): BrowserScenarioEvent[] => [
  network({
    sequence: 1,
    stepIndex: 0,
    kind: "request",
    transactionId: "t-page",
    method: "GET",
    path: "/app",
  }),
  network({
    sequence: 2,
    stepIndex: 0,
    kind: "response",
    transactionId: "t-page",
    method: "GET",
    path: "/app",
  }),
  consoleEvent(3, 0, "ready"),
  consoleEvent(4, 1, "settings-open"),
  network({
    sequence: 5,
    stepIndex: 3,
    kind: "request",
    transactionId: "t-save",
    method: "POST",
    path: "/api/save",
  }),
  consoleEvent(6, 3, "saving"),
  network({
    sequence: 7,
    stepIndex: 3,
    kind: "response",
    transactionId: "t-save",
    method: "POST",
    path: "/api/save",
  }),
  network({
    sequence: 8,
    stepIndex: 3,
    kind: "request-finished",
    transactionId: "t-save",
    method: "POST",
    path: "/api/save",
  }),
];

/**
 * A capture as if the recorder had seen only the kept events: later sequence
 * numbers, source anchors and receipt windows close the gaps the others leave.
 */
export const scenarioFixtureKeepingEvents = (
  capture: BrowserScenarioCapture,
  keep: (event: BrowserScenarioEvent) => boolean,
) => {
  const removed = capture.events.items
    .filter((event) => !keep(event))
    .map(({ sequence }) => sequence);
  const removedThrough = (sequence: number) =>
    removed.filter((value) => value <= sequence).length;
  const renumber = (sequence: number) => sequence - removedThrough(sequence);
  const kept = capture.events.items.filter(keep);
  for (const event of kept)
    if (
      event.kind === "network-content" &&
      removed.includes(event.source_event_sequence)
    )
      throw new Error(
        `Kept network content ${String(event.sequence)} loses its source event`,
      );
  const items = kept.map((event) => ({
    ...event,
    sequence: renumber(event.sequence),
    ...(event.kind === "network-content"
      ? { source_event_sequence: renumber(event.source_event_sequence) }
      : {}),
  }));
  return {
    ...capture,
    steps: capture.steps.map((step) => ({
      ...step,
      event_sequence_start:
        step.event_sequence_start -
        removedThrough(step.event_sequence_start - 1),
      event_sequence_end:
        step.event_sequence_end - removedThrough(step.event_sequence_end),
    })),
    events: { ...capture.events, retained: items.length, items },
  };
};

/** Fixture steps where the start step received every recorded event sequence. */
export const scenarioFixtureStepsReceivingAll = (
  steps: readonly BrowserScenarioStep[],
  lastSequence: number,
) =>
  steps.map((step) =>
    step.step_index === 0
      ? { ...step, event_sequence_start: 1, event_sequence_end: lastSequence }
      : {
          ...step,
          event_sequence_start: lastSequence + 1,
          event_sequence_end: lastSequence,
        },
  );

/** Capture completeness aggregated from step ledgers, as the producer records it. */
export const scenarioFixtureCompleteness = (
  steps: readonly { readonly completeness: unknown }[],
  eventsMissing = false,
) => {
  const ledgers = steps.map(({ completeness }) =>
    browserScenarioCompletenessSchema.parse(completeness),
  );
  return classifyBrowserScenarioCompleteness(
    [
      ...ledgers.flatMap(({ missing_sections: missing }) => missing),
      ...(eventsMissing ? (["events"] as const) : []),
    ],
    ledgers.flatMap(({ truncated_sections: truncated }) => truncated),
  );
};

/**
 * One run of the fixture scenario: the dialog opens and closes, the save click
 * fails after sending a request, the final wait is cancelled, and the save
 * response arrives after the final capture.
 */
export const browserScenarioFixtureCapture = (): BrowserScenarioCapture => {
  const steps = fixtureSteps();
  const items = fixtureEvents();
  return browserScenarioCaptureSchema.parse({
    browser: {
      mode: "launch",
      process_ownership: "provider-owned",
      cleanup: "terminated-owned-process",
      product: "Chromium",
      version: "149.0.0.0",
    },
    scenario: {
      start_origin: ORIGIN,
      action_count: 4,
      secret_references: [],
      network_content: {
        request_body: false,
        response_body: false,
        header_values: false,
      },
      event_families: ["console", "network"],
      limits: DEFAULT_BROWSER_SCENARIO_CAPTURE_LIMITS,
    },
    duration_ms: 640,
    steps,
    events: {
      retained: items.length,
      dropped: 0,
      items,
      omissions: {
        by_kind: [],
        network_transactions: [],
        network_transaction_range: null,
      },
    },
    completeness: scenarioFixtureCompleteness(steps),
    limitations: [
      "Scenario events are ordered by receipt; receipt order does not prove causality.",
    ],
  });
};

/** Evidence parameters exactly as capture_browser_scenario records them. */
export const browserScenarioFixtureParameters = (
  scenario: BrowserScenario,
): Readonly<Record<string, JsonValue>> => ({
  ...jsonObjectSchema.parse(scenario),
  scenario_sha256: digestCanonicalValue(scenario, "Browser scenario"),
});
