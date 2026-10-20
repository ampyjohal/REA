import { expect, it } from "vitest";

import {
  analysisViewRequestSchema,
  projectAnalysisView,
  type AnalysisViewParent,
  type AnalysisViewResult,
} from "./analysisView.js";
import {
  browserScenarioCaptureSchema,
  type BrowserScenarioCapture,
} from "../browserScenarioCapture.js";
import {
  SCENARIO_FIXTURE_OPEN_TREE,
  scenarioFixtureCompleteness,
  scenarioFixtureKeepingEvents,
  browserScenarioFixtureCapture,
  browserScenarioFixtureParameters,
  browserScenarioFixtureScenario,
} from "../browserScenarioCapture.fixture.js";
import {
  browserScenarioEventKindFamily,
  classifyBrowserScenarioCompleteness,
} from "../browserScenarioCaptureValues.js";
import { UNAVAILABLE_SUBJECT_LIMITATION } from "../evidence.js";
import { AnalysisInputError } from "../analysisErrorCore.js";
import { freezeJsonSnapshot } from "../immutableJson.js";
import { jsonObjectSchema, type JsonValue } from "../jsonValue.js";

const PARENT_ID = `ev_${"c".repeat(64)}`;

const parent = (
  capture: BrowserScenarioCapture = browserScenarioFixtureCapture(),
  parameters: unknown = browserScenarioFixtureParameters(
    browserScenarioFixtureScenario(),
  ),
): AnalysisViewParent => ({
  evidenceId: PARENT_ID,
  operation: "capture_browser_scenario",
  normalizedResult: capture,
  subject: null,
  parameters,
  limitations: [
    UNAVAILABLE_SUBJECT_LIMITATION,
    ...capture.limitations,
    "Browser host platform and architecture were not observed.",
  ],
  artifact: null,
});

/** A parent whose recorded scenario declares what the capture restates. */
const declaredParent = (
  capture: BrowserScenarioCapture,
): AnalysisViewParent => {
  const scenario = browserScenarioFixtureScenario();
  const parameters = browserScenarioFixtureParameters({
    ...scenario,
    capture: {
      ...scenario.capture,
      events: [...capture.scenario.event_families],
      network: capture.scenario.network_content,
    },
  });
  return parent(capture, {
    ...parameters,
    browser: {
      ...jsonObjectSchema.parse(parameters["browser"]),
      mode: capture.browser.mode,
    },
  });
};

const project = (
  view: unknown,
  source: AnalysisViewParent = parent(),
): AnalysisViewResult => {
  const result = projectAnalysisView(
    source,
    analysisViewRequestSchema.parse(view),
  );
  if (!result.ok) throw result.error;
  return result.value;
};

const failure = (view: unknown, source: AnalysisViewParent = parent()) => {
  const result = projectAnalysisView(
    source,
    analysisViewRequestSchema.parse(view),
  );
  if (result.ok) throw new Error("expected the view to be rejected");
  return result.error;
};

const stepPage = (result: AnalysisViewResult) => {
  if (result.kind !== "browser-scenario" || result.page.collection !== "steps")
    throw new Error(`unexpected ${result.kind} view`);
  return result.page.items;
};

const artifactOf = (
  row: ReturnType<typeof stepPage>[number],
  artifact: string,
) => row.artifacts.find((entry) => entry.artifact === artifact);

it("compares each step with the previous capture and keeps recorded declarations", () => {
  const result = project({ kind: "browser-scenario", collection: "steps" });
  const rows = stepPage(result);

  expect(result).toMatchObject({
    parent_evidence_id: PARENT_ID,
    parent_operation: "capture_browser_scenario",
    artifact: { path: "", sha256: null },
    source_completeness: "incomplete",
    enabled_event_families: ["console", "network"],
    // The save response arrives after the final capture and belongs to no row.
    received_outside_step_windows: {
      retained: 2,
      kinds: [
        { kind: "request-finished", count: 1 },
        { kind: "response", count: 1 },
      ],
    },
    coverage: { status: "page", examined: 5, total: 5, exhausted: true },
  });
  expect(rows.map(({ action_class }) => action_class)).toEqual([
    "start-navigation",
    "input",
    "input",
    "input",
    "wait",
  ]);
  expect(rows[0]).toMatchObject({
    action: null,
    network_transactions: { coverage: "captured", retained: 1 },
  });
  expect(artifactOf(rows[0]!, "accessibility")).toMatchObject({
    coverage: "captured",
    change: null,
  });
  // Unrequested before and after: omitted rather than repeated.
  expect(artifactOf(rows[0]!, "screenshot")).toBeUndefined();

  expect(rows[1]?.action).toEqual(browserScenarioFixtureScenario().actions[0]);
  expect(artifactOf(rows[1]!, "accessibility")?.change).toBe("changed");
  expect(artifactOf(rows[1]!, "url")?.change).toBe("unchanged");

  // Closing the dialog restores the recorded accessibility text of step 0.
  expect(artifactOf(rows[2]!, "accessibility")).toMatchObject({
    change: "changed",
    comparison_sha256: artifactOf(rows[0]!, "accessibility")?.comparison_sha256,
  });

  expect(rows[3]).toMatchObject({
    status: "failed",
    error: "locator.click: Timeout 500ms exceeded.",
    network_transactions: { coverage: "captured", retained: 1 },
    events_received: {
      coverage: "captured",
      sequence_start: 5,
      sequence_end: 6,
      retained: 2,
      kinds: [
        { kind: "console", count: 1 },
        { kind: "request", count: 1 },
      ],
    },
  });
  expect(artifactOf(rows[3]!, "accessibility")?.change).toBe("unchanged");

  expect(rows[4]).toMatchObject({
    status: "cancelled",
    events_received: { retained: 0, kinds: [] },
  });
  for (const artifact of ["accessibility", "url", "screenshot"])
    expect(artifactOf(rows[4]!, artifact)).toMatchObject({
      coverage: "missing",
      reason: "action was not executed after an earlier failure",
      comparison_sha256: null,
      change: "unknown",
    });
});

it("summarizes coverage, step changes and events received outside step windows", () => {
  const result = project({ kind: "summary" });
  if (result.kind !== "summary" || !("step_changes" in result.summary))
    throw new Error("expected a browser scenario summary");
  const { summary } = result;

  expect(summary.step_statuses).toEqual({
    completed: 3,
    failed: 1,
    cancelled: 1,
  });
  expect(
    summary.artifact_coverage.find(({ artifact }) => artifact === "screenshot"),
  ).toEqual({
    artifact: "screenshot",
    captured: 0,
    not_requested: 4,
    missing: 1,
    truncated: 0,
  });
  expect(
    summary.step_changes.find(({ artifact }) => artifact === "accessibility"),
  ).toEqual({
    artifact: "accessibility",
    changed: 2,
    unchanged: 1,
    unknown: 1,
    not_compared: 0,
  });
  expect(summary.events).toEqual({
    declared_families: ["console", "network"],
    enabled_families: ["console", "network"],
    retained: 8,
    dropped: 0,
    received_outside_step_windows: {
      retained: 2,
      kinds: [
        { kind: "request-finished", count: 1 },
        { kind: "response", count: 1 },
      ],
    },
  });
  expect(summary.network_transactions).toEqual({
    coverage: "captured",
    retained: 2,
    without_retained_request: 0,
    omitted_by_transaction_limit: 0,
  });
  expect(result.limitations).toEqual(
    expect.arrayContaining([
      expect.stringContaining("Cancelled steps have no post-action capture"),
    ]),
  );
  expect(result.unknowns).toEqual(
    expect.arrayContaining([
      expect.stringContaining(
        "screenshot was requested at some steps but not others",
      ),
    ]),
  );
});

it("pages retained text by UTF-16 code units and reports uncaptured text", () => {
  const first = project({
    kind: "browser-scenario",
    collection: "text",
    step_index: 1,
    artifact: "accessibility",
    limit: 10,
  });
  expect(first).toMatchObject({
    page: {
      collection: "text",
      step_id: "open-settings",
      item: {
        coverage: "captured",
        text: SCENARIO_FIXTURE_OPEN_TREE.slice(0, 10),
        unit: "utf16-code-units",
        total_code_units: SCENARIO_FIXTURE_OPEN_TREE.length,
      },
    },
    coverage: { next_offset: 10, exhausted: false },
  });

  expect(
    project({
      kind: "browser-scenario",
      collection: "text",
      step_index: 4,
      artifact: "accessibility",
      limit: 10,
    }),
  ).toMatchObject({
    page: {
      item: {
        coverage: "missing",
        reason: "action was not executed after an earlier failure",
      },
    },
    coverage: { status: "empty", exhausted: true },
  });
  expect(
    project({
      kind: "browser-scenario",
      collection: "text",
      step_index: 0,
      artifact: "dom",
      limit: 10,
    }),
  ).toMatchObject({
    page: { item: { coverage: "not_requested", reason: null } },
  });
  expect(
    failure({
      kind: "browser-scenario",
      collection: "text",
      step_index: 9,
      artifact: "dom",
      limit: 10,
    }),
  ).toBeInstanceOf(AnalysisInputError);
});

const selectingFamilies = (
  eventFamilies: BrowserScenarioCapture["scenario"]["event_families"],
  responseBody: boolean,
  keep: (event: BrowserScenarioCapture["events"]["items"][number]) => boolean,
) => {
  const fixture = scenarioFixtureKeepingEvents(
    browserScenarioFixtureCapture(),
    keep,
  );
  return {
    ...fixture,
    scenario: {
      ...fixture.scenario,
      event_families: eventFamilies,
      network_content: {
        ...fixture.scenario.network_content,
        response_body: responseBody,
      },
    },
  };
};

const networkEvents = ({
  kind,
}: BrowserScenarioCapture["events"]["items"][number]) =>
  browserScenarioEventKindFamily(kind) === "network";

it("treats network content selection as enabled network observation", () => {
  const steps = { kind: "browser-scenario", collection: "steps" };
  const contentOnly = stepPage(
    project(
      steps,
      declaredParent(
        browserScenarioCaptureSchema.parse(
          selectingFamilies([], true, networkEvents),
        ),
      ),
    ),
  );
  expect(contentOnly[3]?.events_received.coverage).toBe("captured");
  expect(contentOnly[3]?.network_transactions.retained).not.toBeNull();

  const nothingSelected = stepPage(
    project(
      steps,
      declaredParent(
        browserScenarioCaptureSchema.parse(
          selectingFamilies([], false, () => false),
        ),
      ),
    ),
  );
  expect(nothingSelected[3]?.events_received.coverage).toBe("not_requested");
  expect(nothingSelected[3]?.network_transactions).toEqual({
    coverage: "not_requested",
    retained: null,
  });
});

it("rejects retained events from families the scenario did not select", () => {
  const unselected = selectingFamilies(["console"], false, networkEvents);
  expect(
    failure(
      { kind: "browser-scenario", collection: "steps" },
      { ...parent(), normalizedResult: unselected },
    ),
  ).toMatchObject({
    issues: expect.arrayContaining([
      expect.objectContaining({
        path: ["source", "normalized_result", "events", "items", 0, "kind"],
      }),
    ]),
  });
});

it("rejects a step 0 that is not the completed implicit start navigation", () => {
  const fixture = browserScenarioFixtureCapture();
  const start = fixture.steps[0];
  if (start === undefined) throw new Error("Expected the start step");
  for (const replacement of [
    { step_id: "open-settings", action: "click" },
    {
      status: "failed",
      error: "navigation failed",
      completeness: classifyBrowserScenarioCompleteness(
        [...start.completeness.missing_sections, "action"],
        start.completeness.truncated_sections,
      ),
    },
  ]) {
    const steps = fixture.steps.map((step) =>
      step.step_index === 0 ? { ...step, ...replacement } : step,
    );
    expect(
      failure(
        { kind: "browser-scenario", collection: "steps" },
        {
          ...parent(),
          normalizedResult: {
            ...fixture,
            steps,
            completeness: scenarioFixtureCompleteness(steps),
          },
        },
      ),
    ).toMatchObject({
      issues: [{ path: ["source", "normalized_result", "steps", 0] }],
    });
  }
});

it("rejects a start window that leaves earlier receipts outside every window", () => {
  const fixture = browserScenarioFixtureCapture();
  expect(
    fixture.events.items.filter(({ sequence }) => sequence <= 2),
  ).toMatchObject([{ step_index: 0 }, { step_index: 0 }]);
  expect(
    failure(
      { kind: "browser-scenario", collection: "steps" },
      {
        ...parent(),
        normalizedResult: {
          ...fixture,
          steps: fixture.steps.map((step) =>
            step.step_index === 0
              ? { ...step, event_sequence_start: 2, event_sequence_end: 2 }
              : step,
          ),
        },
      },
    ),
  ).toMatchObject({
    issues: [
      {
        path: [
          "source",
          "normalized_result",
          "steps",
          0,
          "event_sequence_start",
        ],
      },
    ],
  });
});

it("rejects step completeness that contradicts the retained artifacts", () => {
  const fixture = browserScenarioFixtureCapture();
  expect(fixture.steps[1]?.artifacts.accessibility.state).toBe("captured");
  expect(
    failure(
      {
        kind: "browser-scenario",
        collection: "text",
        step_index: 1,
        artifact: "accessibility",
        limit: 10,
      },
      {
        ...parent(),
        normalizedResult: {
          ...fixture,
          steps: fixture.steps.map((step) =>
            step.step_index === 1
              ? {
                  ...step,
                  completeness: classifyBrowserScenarioCompleteness(
                    [],
                    ["accessibility"],
                  ),
                }
              : step,
          ),
        },
      },
    ),
  ).toMatchObject({
    issues: [
      { path: ["source", "normalized_result", "steps", 1, "completeness"] },
    ],
  });
});

it("rejects capture accounting that contradicts its steps or omissions", () => {
  const fixture = browserScenarioFixtureCapture();
  const rejected = (normalizedResult: unknown) =>
    failure({ kind: "summary" }, { ...parent(), normalizedResult });
  // A transaction-limited range without any dropped transaction event.
  expect(
    rejected({
      ...fixture,
      events: {
        ...fixture.events,
        omissions: {
          ...fixture.events.omissions,
          network_transaction_range: {
            first_transaction_id: "request-9",
            last_transaction_id: "request-9",
            count: 1,
            reason: "max-network-transactions",
          },
        },
      },
    }),
  ).toMatchObject({
    issues: [
      {
        path: [
          "source",
          "normalized_result",
          "events",
          "omissions",
          "network_transaction_range",
        ],
      },
    ],
  });
  // A complete capture ledger beside a failed and a cancelled step.
  expect(
    rejected({
      ...fixture,
      completeness: {
        status: "complete",
        equality_eligible: true,
        missing_sections: [],
        truncated_sections: [],
      },
    }),
  ).toMatchObject({
    issues: [{ path: ["source", "normalized_result", "completeness"] }],
  });
});

it("fails closed when recorded actions do not describe the capture steps", () => {
  const scenario = browserScenarioFixtureScenario();
  const parameters = browserScenarioFixtureParameters(scenario);
  const swapped = {
    ...parameters,
    actions: [
      scenario.actions[1],
      scenario.actions[0],
      ...scenario.actions.slice(2),
    ],
  };
  expect(
    failure(
      { kind: "browser-scenario", collection: "steps" },
      parent(undefined, swapped),
    ),
  ).toMatchObject({
    issues: [{ path: ["source", "parameters", "actions", 0] }],
  });
  expect(
    failure({ kind: "summary" }, parent(undefined, { scenario_sha256: "" })),
  ).toBeInstanceOf(AnalysisInputError);
});

it("rejects overlapping recorded event windows", () => {
  const fixture = browserScenarioFixtureCapture();
  const overlapping = browserScenarioCaptureSchema.parse({
    ...fixture,
    steps: fixture.steps.map((step) =>
      step.step_index === 1 ? { ...step, event_sequence_start: 3 } : step,
    ),
  });
  expect(
    failure(
      { kind: "browser-scenario", collection: "steps" },
      parent(overlapping),
    ),
  ).toMatchObject({
    issues: [
      {
        path: [
          "source",
          "normalized_result",
          "steps",
          1,
          "event_sequence_start",
        ],
      },
    ],
  });
});

it("states connect-mode ownership and rejects views for other parents", () => {
  const fixture = browserScenarioFixtureCapture();
  const connected = browserScenarioCaptureSchema.parse({
    ...fixture,
    browser: {
      ...fixture.browser,
      mode: "connect",
      process_ownership: "external",
      cleanup: "disconnected-external",
    },
    completeness: scenarioFixtureCompleteness(fixture.steps, true),
  });
  expect(
    project({ kind: "summary" }, declaredParent(connected)).limitations,
  ).toEqual(
    expect.arrayContaining([expect.stringContaining("Connect mode attached")]),
  );
  expect(
    failure({ kind: "page", collection: "modules", offset: 0, limit: 1 }),
  ).toBeInstanceOf(AnalysisInputError);
});

const reparsed = (
  edit: (capture: BrowserScenarioCapture) => unknown,
): BrowserScenarioCapture =>
  browserScenarioCaptureSchema.parse(
    edit(structuredClone(browserScenarioFixtureCapture())),
  );

it("reports unobserved network as unknown instead of zero transactions", () => {
  const consoleOnly = reparsed((capture) => {
    const kept = scenarioFixtureKeepingEvents(
      capture,
      ({ kind }) => kind === "console",
    );
    return {
      ...kept,
      scenario: { ...kept.scenario, event_families: ["console"] },
    };
  });
  const result = project(
    { kind: "browser-scenario", collection: "steps" },
    declaredParent(consoleOnly),
  );
  const save = stepPage(result)[3];
  expect(save?.events_received).toMatchObject({
    coverage: "captured",
    kinds: [{ kind: "console", count: 1 }],
  });
  expect(save?.network_transactions).toEqual({
    coverage: "not_requested",
    retained: null,
  });
  expect(result.unknowns).toEqual(
    expect.arrayContaining([
      expect.stringMatching(/^Event families .*network.* were not observed/u),
    ]),
  );
});

it("applies capture-wide event coverage to every step", () => {
  const dropped = reparsed((capture) => ({
    ...capture,
    events: {
      ...capture.events,
      dropped: 1,
      omissions: {
        ...capture.events.omissions,
        by_kind: [{ kind: "console", count: 1, reasons: ["max-events"] }],
      },
    },
    completeness: scenarioFixtureCompleteness(capture.steps, true),
  }));
  const truncatedRows = stepPage(
    project({ kind: "browser-scenario", collection: "steps" }, parent(dropped)),
  );
  expect(
    truncatedRows.map(({ events_received: events }) => events.coverage),
  ).toEqual(["truncated", "truncated", "truncated", "truncated", "truncated"]);

  const connected = reparsed((capture) => ({
    ...capture,
    browser: {
      ...capture.browser,
      mode: "connect",
      process_ownership: "external",
      cleanup: "disconnected-external",
    },
    completeness: {
      ...capture.completeness,
      missing_sections: [...capture.completeness.missing_sections, "events"],
    },
  }));
  const connectedRows = stepPage(
    project(
      { kind: "browser-scenario", collection: "steps" },
      declaredParent(connected),
    ),
  );
  expect(connectedRows[0]?.events_received).toMatchObject({
    coverage: "missing",
    retained: 3,
  });
  expect(connectedRows[0]?.network_transactions).toEqual({
    coverage: "missing",
    retained: 1,
  });
});

it("keeps truncated artifacts and events between windows explicit", () => {
  const capture = reparsed((fixture) => {
    const steps = fixture.steps.map((step) =>
      step.step_index === 1
        ? {
            ...step,
            artifacts: {
              ...step.artifacts,
              accessibility: {
                state: "truncated",
                observed: 900,
                retained: 0,
                reason: "accessibility text exceeded its budget",
              },
            },
            completeness: {
              status: "truncated",
              equality_eligible: false,
              missing_sections: [],
              truncated_sections: ["accessibility"],
            },
          }
        : step.step_index === 3
          ? { ...step, event_sequence_start: 6 }
          : step,
    );
    return {
      ...fixture,
      steps,
      // Received before step 3 opened its window, the save request keeps step 2.
      events: {
        ...fixture.events,
        items: fixture.events.items.map((event) =>
          event.sequence === 5 ? { ...event, step_index: 2 } : event,
        ),
      },
      completeness: scenarioFixtureCompleteness(steps),
    };
  });
  const source = parent(capture);
  const rows = stepPage(
    project({ kind: "browser-scenario", collection: "steps" }, source),
  );
  expect(artifactOf(rows[1]!, "accessibility")).toMatchObject({
    coverage: "truncated",
    reason: "accessibility text exceeded its budget",
    comparison_sha256: null,
    change: "unknown",
  });
  expect(artifactOf(rows[2]!, "accessibility")?.change).toBe("unknown");
  // The save request now precedes step 3's window and belongs to no row.
  expect(rows[3]?.events_received).toMatchObject({
    sequence_start: 6,
    retained: 1,
    kinds: [{ kind: "console", count: 1 }],
  });
  expect(
    project({ kind: "browser-scenario", collection: "steps" }, source),
  ).toMatchObject({ received_outside_step_windows: { retained: 3 } });
  expect(
    project(
      {
        kind: "browser-scenario",
        collection: "text",
        step_index: 1,
        artifact: "accessibility",
        limit: 16,
      },
      source,
    ),
  ).toMatchObject({
    page: {
      item: {
        coverage: "truncated",
        reason: "accessibility text exceeded its budget",
      },
    },
  });
});

it("returns empty exhausted pages past the end", () => {
  expect(
    project({
      kind: "browser-scenario",
      collection: "steps",
      offset: 9,
      limit: 2,
    }),
  ).toMatchObject({
    page: { collection: "steps", items: [] },
    coverage: { status: "empty", next_offset: null, exhausted: true },
  });
  expect(
    project({
      kind: "browser-scenario",
      collection: "text",
      step_index: 1,
      artifact: "accessibility",
      offset: 10_000,
      limit: 16,
    }),
  ).toMatchObject({
    page: { item: { coverage: "captured", text: "" } },
    coverage: { status: "empty", exhausted: true },
  });
});

it("rejects inverted windows and events indexed to another step", () => {
  const inverted = reparsed((capture) => ({
    ...capture,
    steps: capture.steps.map((step) =>
      step.step_index === 1
        ? { ...step, event_sequence_start: 40, event_sequence_end: 2 }
        : step,
    ),
  }));
  expect(
    failure(
      { kind: "browser-scenario", collection: "steps" },
      parent(inverted),
    ),
  ).toMatchObject({
    issues: [
      {
        path: ["source", "normalized_result", "steps", 1, "event_sequence_end"],
      },
    ],
  });
  // An empty window still has to start after the previous step's window ends.
  const backwardEmpty = reparsed((capture) => ({
    ...capture,
    steps: capture.steps.map((step) =>
      step.step_index === 1
        ? { ...step, event_sequence_start: 2, event_sequence_end: 1 }
        : step,
    ),
  }));
  expect(
    failure(
      { kind: "browser-scenario", collection: "steps" },
      parent(backwardEmpty),
    ),
  ).toMatchObject({
    issues: [
      {
        path: [
          "source",
          "normalized_result",
          "steps",
          1,
          "event_sequence_start",
        ],
      },
    ],
  });
  const misindexed = reparsed((capture) => ({
    ...capture,
    events: {
      ...capture.events,
      items: capture.events.items.map((event) =>
        event.sequence === 4 ? { ...event, step_index: 2 } : event,
      ),
    },
  }));
  expect(
    failure(
      { kind: "browser-scenario", collection: "steps" },
      parent(misindexed),
    ),
  ).toMatchObject({
    issues: [
      {
        path: [
          "source",
          "normalized_result",
          "events",
          "items",
          3,
          "step_index",
        ],
      },
    ],
  });
});

it("rejects receipt histories the event accounting cannot produce", () => {
  const fixture = browserScenarioFixtureCapture();
  const first = scenarioFixtureKeepingEvents(
    fixture,
    ({ sequence }) => sequence === 1,
  );
  // One retained event at sequence 100 with nothing dropped.
  const impossible = {
    ...first,
    steps: first.steps.map((step) =>
      step.step_index === 0
        ? { ...step, event_sequence_start: 1, event_sequence_end: 100 }
        : { ...step, event_sequence_start: 101, event_sequence_end: 100 },
    ),
    events: {
      ...first.events,
      items: first.events.items.map((event) => ({ ...event, sequence: 100 })),
    },
  };
  expect(
    failure(
      { kind: "browser-scenario", collection: "steps" },
      { ...parent(), normalizedResult: impossible },
    ),
  ).toMatchObject({
    issues: [
      {
        path: ["source", "normalized_result", "events", "items", 0, "sequence"],
      },
      {
        path: ["source", "normalized_result", "steps", 0, "event_sequence_end"],
      },
      {
        path: ["source", "normalized_result", "steps", 1, "event_sequence_end"],
      },
      {
        path: ["source", "normalized_result", "steps", 2, "event_sequence_end"],
      },
      {
        path: ["source", "normalized_result", "steps", 3, "event_sequence_end"],
      },
      {
        path: ["source", "normalized_result", "steps", 4, "event_sequence_end"],
      },
    ],
  });
  // A selected request body recorded as never requested.
  const request = fixture.events.items.find(({ kind }) => kind === "request");
  if (request?.kind !== "request")
    throw new Error("Expected a fixture request");
  const next = fixture.events.retained + 1;
  expect(
    failure(
      { kind: "summary" },
      {
        ...parent(),
        normalizedResult: {
          ...fixture,
          scenario: {
            ...fixture.scenario,
            network_content: {
              ...fixture.scenario.network_content,
              request_body: true,
            },
          },
          events: {
            ...fixture.events,
            retained: next,
            items: [
              ...fixture.events.items,
              {
                sequence: next,
                step_index: request.step_index,
                kind: "network-content",
                transaction_id: request.transaction_id,
                source_event_sequence: request.sequence,
                phase: "request",
                headers: { state: "not_requested" },
                body: { state: "not_requested" },
              },
            ],
          },
        },
      },
    ),
  ).toMatchObject({
    issues: [
      {
        path: [
          "source",
          "normalized_result",
          "events",
          "items",
          next - 1,
          "body",
        ],
      },
    ],
  });
});

it("binds each step's artifacts to the recorded scenario's selection", () => {
  const scenario = browserScenarioFixtureScenario();
  const withSelection = (capture: Record<string, unknown>) =>
    failure(
      { kind: "summary" },
      parent(
        undefined,
        browserScenarioFixtureParameters({
          ...scenario,
          capture: { ...scenario.capture, ...capture },
        }),
      ),
    );
  const artifact = (step: number, kind: string) => [
    "source",
    "normalized_result",
    "steps",
    step,
    "artifacts",
    kind,
  ];
  // DOM requested after every step, but no step records it.
  expect(
    withSelection({ after_each_step: ["accessibility", "dom", "url"] }),
  ).toMatchObject({ issues: [{ path: artifact(0, "dom") }] });
  // The final screenshot recorded without being requested.
  expect(withSelection({ at_end: [] })).toMatchObject({
    issues: [{ path: artifact(4, "screenshot") }],
  });
  const withoutCapture = Object.fromEntries(
    Object.entries(browserScenarioFixtureParameters(scenario)).filter(
      ([key]) => key !== "capture",
    ),
  );
  expect(
    failure({ kind: "summary" }, parent(undefined, withoutCapture)),
  ).toMatchObject({
    issues: [{ path: ["source", "parameters", "capture"] }],
  });
});

it("binds the capture's scenario fields to the recorded declaration", () => {
  const scenario = browserScenarioFixtureScenario();
  const parameters = browserScenarioFixtureParameters(scenario);
  const declaring = (changes: Record<string, unknown>) =>
    failure(
      { kind: "summary" },
      parent(undefined, { ...parameters, ...changes }),
    );
  const field = (...path: (string | number)[]) => [
    "source",
    "normalized_result",
    ...path,
  ];
  const capture = jsonObjectSchema.parse(parameters["capture"]);
  // A requested response body that the capture restates as unselected.
  expect(
    declaring({
      capture: {
        ...capture,
        network: {
          ...jsonObjectSchema.parse(capture["network"]),
          response_body: true,
        },
      },
    }),
  ).toMatchObject({ issues: [{ path: field("scenario", "network_content") }] });
  expect(
    declaring({
      capture: { ...capture, events: ["console", "network", "page-errors"] },
    }),
  ).toMatchObject({ issues: [{ path: field("scenario", "event_families") }] });
  expect(
    declaring({
      capture: {
        ...capture,
        limits: { ...jsonObjectSchema.parse(capture["limits"]), max_events: 1 },
      },
    }),
  ).toMatchObject({ issues: [{ path: field("scenario", "limits") }] });
  expect(
    declaring({
      browser: {
        ...jsonObjectSchema.parse(parameters["browser"]),
        mode: "connect",
      },
    }),
  ).toMatchObject({ issues: [{ path: field("browser", "mode") }] });
  expect(declaring({ secrets: undefined })).toMatchObject({
    issues: [{ path: ["source", "parameters", "secrets"] }],
  });
});

it("rejects events outside every window that name another step", () => {
  const fixture = browserScenarioFixtureCapture();
  const lastWindowEnd = Math.max(
    ...fixture.steps.map(({ event_sequence_end: end }) => end),
  );
  const late = fixture.events.items.findIndex(
    ({ sequence }) => sequence > lastWindowEnd,
  );
  // The failed save step stays current after the final capture.
  expect(fixture.events.items[late]?.step_index).toBe(3);
  for (const stepIndex of [4, 0])
    expect(
      failure(
        { kind: "browser-scenario", collection: "steps" },
        parent(
          reparsed((capture) => ({
            ...capture,
            events: {
              ...capture.events,
              items: capture.events.items.map((event, index) =>
                index === late ? { ...event, step_index: stepIndex } : event,
              ),
            },
          })),
        ),
      ),
    ).toMatchObject({
      issues: [
        {
          path: [
            "source",
            "normalized_result",
            "events",
            "items",
            late,
            "step_index",
          ],
        },
      ],
    });
});

it("carries the capture's own limitations even when the envelope omits them", () => {
  const capture = browserScenarioCaptureSchema.parse({
    ...browserScenarioFixtureCapture(),
    limitations: ["Capture-local caveat kept only in the result."],
  });
  const source = { ...parent(capture), limitations: [] };
  for (const view of [
    { kind: "summary" },
    { kind: "browser-scenario", collection: "steps" },
  ])
    expect(project(view, source).limitations).toContain(
      "Capture-local caveat kept only in the result.",
    );
});

it("keeps the view's own limitations when parent limitations exceed the budget", () => {
  const source = parent();
  const crowded: AnalysisViewParent = {
    ...source,
    limitations: Array.from(
      { length: 12 },
      (_, index) =>
        `Network metadata was omitted for request-${String(index)}: ${"x".repeat(1_000)}`,
    ),
  };
  const { limitations } = project({ kind: "summary" }, crowded);
  for (const owned of [
    "Step changes compare each step's capture",
    "Comparison digests apply no normalization rules",
    "Artifacts are read one after another",
    "events_received counts receipt",
    "Cancelled steps have no post-action capture",
  ])
    expect(limitations).toEqual(
      expect.arrayContaining([expect.stringContaining(owned)]),
    );
  expect(limitations).toEqual(
    expect.arrayContaining([
      expect.stringMatching(/additional limitations omitted from this view/u),
    ]),
  );
});

it("reuses one sealed parent's checks across pages but never across Evidence", () => {
  const capture = freezeJsonSnapshot(
    browserScenarioFixtureCapture() as unknown as JsonValue,
  ) as unknown as BrowserScenarioCapture;
  const scenario = browserScenarioFixtureScenario();
  const sealed = (evidenceId: string, source: AnalysisViewParent) => ({
    ...source,
    evidenceId,
    sealedResult: true,
  });
  const valid = sealed(PARENT_ID, parent(capture));
  const drifted = sealed(
    `ev_${"e".repeat(64)}`,
    parent(capture, {
      ...browserScenarioFixtureParameters(scenario),
      actions: scenario.actions.slice(1),
    }),
  );
  const relabelled = sealed(`ev_${"f".repeat(64)}`, {
    ...parent(capture),
    limitations: ["Limitation recorded only by the relabelled Evidence."],
  });
  const steps = (offset: number) => ({
    kind: "browser-scenario",
    collection: "steps",
    offset,
    limit: 2,
  });
  const actionsRejected = {
    issues: [{ path: ["source", "parameters", "actions"] }],
  };

  // A failed check is not retained for the next parent of the same result.
  expect(failure(steps(0), drifted)).toMatchObject(actionsRejected);
  expect(
    [0, 2, 4].flatMap((offset) =>
      stepPage(project(steps(offset), valid)).map(({ action }) => action),
    ),
  ).toEqual([null, ...scenario.actions]);
  // Another Evidence ID over the same sealed result is checked on its own.
  expect(failure({ kind: "summary" }, drifted)).toMatchObject(actionsRejected);
  expect(project({ kind: "summary" }, relabelled).limitations).toContain(
    "Limitation recorded only by the relabelled Evidence.",
  );
  expect(project({ kind: "summary" }, valid).limitations).not.toContain(
    "Limitation recorded only by the relabelled Evidence.",
  );
});
