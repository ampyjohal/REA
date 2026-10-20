import { createHash } from "node:crypto";

import { expect, it } from "vitest";

import { sanitizeBrowserUrl } from "./browserObservation.js";
import {
  BROWSER_SCENARIO_START_STEP,
  browserScenarioCompletenessSchema,
  browserScenarioEventSchema,
  browserScenarioStepSchema,
  browserStepArtifactsSchema,
  classifyBrowserScenarioCompleteness,
  browserScenarioEventKindFamily,
  deriveStepCompleteness,
} from "./browserScenarioCaptureValues.js";
import {
  browserScenarioFixtureCapture,
  scenarioFixtureCompleteness,
  scenarioFixtureKeepingEvents,
  scenarioFixtureUrl,
} from "./browserScenarioCapture.fixture.js";
import {
  browserScenarioCaptureSchema,
  type BrowserScenarioCapture,
} from "./browserScenarioCapture.js";
import { DEFAULT_BROWSER_SCENARIO_CAPTURE_LIMITS } from "./browserScenarioCaptureLimits.js";

const networkEvent = {
  sequence: 1,
  step_index: 0,
  transaction_id: "request-1",
  redirected_from_transaction_id: null,
  redirected_from_transaction_state: "root",
  method: "GET",
  url: sanitizeBrowserUrl("https://example.test/resource"),
  resource_type: "document",
  header_names: [],
} as const;

it("requires transaction IDs and explicit unknown redirect predecessors", () => {
  const request = {
    ...networkEvent,
    kind: "request",
    status: null,
    failure: null,
  } as const;
  expect(
    browserScenarioEventSchema.safeParse({
      ...request,
      transaction_id: undefined,
    }).success,
  ).toBe(false);
  expect(
    browserScenarioEventSchema.safeParse({
      ...request,
      redirected_from_transaction_id: undefined,
    }).success,
  ).toBe(false);
  expect(
    browserScenarioEventSchema.safeParse({
      ...request,
      redirected_from_transaction_id: "request-0",
      redirected_from_transaction_state: "unknown",
    }).success,
  ).toBe(false);
});

it("parses each network outcome without contradictory status or failure data", () => {
  expect(
    browserScenarioEventSchema.safeParse({
      ...networkEvent,
      kind: "response",
      status: null,
      failure: null,
    }).success,
  ).toBe(false);
  expect(
    browserScenarioEventSchema.safeParse({
      ...networkEvent,
      kind: "request-failed",
      status: 500,
      failure: "connection reset",
    }).success,
  ).toBe(false);
});

it("keeps WebSocket payload representation tied to its payload type", () => {
  const frame = {
    sequence: 1,
    step_index: 0,
    kind: "websocket-frame-received",
    url: sanitizeBrowserUrl("https://example.test/socket"),
    payload_bytes: 3,
    truncated: false,
  } as const;
  expect(
    browserScenarioEventSchema.safeParse({
      ...frame,
      payload_type: "binary",
      payload_text: "abc",
    }).success,
  ).toBe(false);
  expect(
    browserScenarioEventSchema.safeParse({
      ...frame,
      payload_type: "text",
      payload_text: "abc",
    }).success,
  ).toBe(true);
});

it("does not attach a content digest to redacted storage secrets", () => {
  expect(
    browserStepArtifactsSchema.safeParse({
      screenshot: { state: "not_requested" },
      dom: { state: "not_requested" },
      accessibility: { state: "not_requested" },
      url: { state: "not_requested" },
      history: { state: "not_requested" },
      storage: {
        state: "captured",
        value: {
          cookies: [],
          local_storage: [
            {
              name: "session",
              value_state: "redacted-secret",
              value_sha256: "a".repeat(64),
            },
          ],
          session_storage: [],
        },
      },
    }).success,
  ).toBe(false);
});

it("accepts complete storage, history, and text artifacts beyond former caps", () => {
  const text = "x".repeat(1_048_577);
  const fingerprint = {
    name: "entry",
    value_state: "hashed",
    value_sha256: "a".repeat(64),
  } as const;
  const parsed = browserStepArtifactsSchema.safeParse({
    screenshot: { state: "not_requested" },
    dom: {
      state: "captured",
      value: {
        sha256: createHash("sha256").update(text).digest("hex"),
        bytes: Buffer.byteLength(text),
        text,
      },
    },
    accessibility: { state: "not_requested" },
    url: { state: "not_requested" },
    history: {
      state: "captured",
      value: {
        length: 257,
        current_url: sanitizeBrowserUrl("https://example.test/"),
        navigation_entries: Array.from({ length: 257 }, () => ({
          type: "navigate",
          name: sanitizeBrowserUrl("https://example.test/"),
        })),
      },
    },
    storage: {
      state: "captured",
      value: {
        cookies: Array.from({ length: 513 }, () => ({
          name: fingerprint.name,
          domain: "example.test",
          path: "/",
          secure: true,
          http_only: false,
          same_site: "Lax",
          value_state: fingerprint.value_state,
          value_sha256: fingerprint.value_sha256,
        })),
        local_storage: Array.from({ length: 513 }, () => fingerprint),
        session_storage: Array.from({ length: 513 }, () => fingerprint),
      },
    },
  });

  expect(parsed.success).toBe(true);
});

it("accepts complete scenario output beyond former string caps", () => {
  const longText = "detail".repeat(1_000);
  const step = (index: number) => ({
    step_index: index,
    ...(index === 0
      ? BROWSER_SCENARIO_START_STEP
      : { step_id: longText, action: longText }),
    elapsed_ms: 0,
    before_url: sanitizeBrowserUrl("https://example.test/"),
    after_url: sanitizeBrowserUrl("https://example.test/"),
    event_sequence_start: 1,
    event_sequence_end: 0,
    artifacts: {
      screenshot: { state: "not_requested" },
      dom: { state: "not_requested" },
      accessibility: { state: "not_requested" },
      url: { state: "not_requested" },
      history: { state: "not_requested" },
      storage: { state: "not_requested" },
    },
    completeness: {
      status: "complete",
      equality_eligible: true,
      missing_sections: [],
      truncated_sections: [],
    },
    status: "completed",
    error: null,
  });
  const parsed = browserScenarioCaptureSchema.parse({
    browser: {
      mode: "launch",
      process_ownership: "provider-owned",
      cleanup: "terminated-owned-process",
      product: longText,
      version: longText,
    },
    scenario: {
      start_origin: longText,
      action_count: 1,
      secret_references: [longText],
      network_content: {
        request_body: false,
        response_body: false,
        header_values: false,
      },
      event_families: [],
      limits: DEFAULT_BROWSER_SCENARIO_CAPTURE_LIMITS,
    },
    duration_ms: 0,
    steps: [step(0), step(1)],
    events: {
      retained: 0,
      dropped: 0,
      items: [],
      omissions: {
        by_kind: [],
        network_transactions: [],
        network_transaction_range: null,
      },
    },
    completeness: {
      status: "complete",
      equality_eligible: true,
      missing_sections: [],
      truncated_sections: [],
    },
    limitations: Array.from({ length: 65 }, () => longText),
  });

  expect(parsed.steps[1]?.step_id).toBe(longText);
  expect(parsed.limitations).toHaveLength(65);
});

/** Complete capture input with network omission accounting. */
const omissionAccountingInput = () => {
  const outputStep = (index: number) => ({
    step_index: index,
    ...(index === 0
      ? BROWSER_SCENARIO_START_STEP
      : { step_id: `step-${index}`, action: "wait_for_timeout" }),
    elapsed_ms: 0,
    before_url: sanitizeBrowserUrl("http://127.0.0.1/"),
    after_url: sanitizeBrowserUrl("http://127.0.0.1/"),
    event_sequence_start: 1,
    event_sequence_end: 0,
    artifacts: {
      screenshot: { state: "not_requested" },
      dom: { state: "not_requested" },
      accessibility: { state: "not_requested" },
      url: { state: "not_requested" },
      history: { state: "not_requested" },
      storage: { state: "not_requested" },
    },
    completeness: {
      status: "complete",
      equality_eligible: true,
      missing_sections: [],
      truncated_sections: [],
    },
    status: "completed",
    error: null,
  });
  return {
    browser: {
      mode: "launch",
      process_ownership: "provider-owned",
      cleanup: "terminated-owned-process",
      product: "Chromium",
      version: "fixture",
    },
    scenario: {
      start_origin: "http://127.0.0.1",
      action_count: 1,
      secret_references: [],
      network_content: {
        request_body: false,
        response_body: true,
        header_values: false,
      },
      event_families: ["network"],
      limits: {
        ...DEFAULT_BROWSER_SCENARIO_CAPTURE_LIMITS,
        max_total_event_allocation_bytes: 32 * 1024 * 1024,
      },
    },
    duration_ms: 1,
    steps: [outputStep(0), outputStep(1)],
    events: {
      retained: 0,
      dropped: 2,
      items: [],
      omissions: {
        by_kind: [
          {
            kind: "network-content",
            count: 1,
            reasons: ["max-total-event-allocation-bytes"],
          },
          {
            kind: "request",
            count: 1,
            reasons: ["max-network-transactions"],
          },
        ],
        network_transactions: [
          {
            transaction_id: "request-1",
            omitted_kinds: ["network-content"],
            reasons: ["max-total-event-allocation-bytes"],
          },
        ],
        network_transaction_range: {
          first_transaction_id: "request-2",
          last_transaction_id: "request-2",
          count: 1,
          reason: "max-network-transactions",
        },
      },
    },
    completeness: {
      status: "incomplete",
      equality_eligible: false,
      missing_sections: ["events"],
      truncated_sections: [],
    },
    limitations: ["Event coverage is incomplete."],
  };
};

it("validates reported event limits and omission accounting", () => {
  const capture = browserScenarioCaptureSchema.safeParse(
    omissionAccountingInput(),
  );
  if (!capture.success) throw new Error("Expected valid omission accounting");
  expect(capture.data.scenario.limits.max_total_event_allocation_bytes).toBe(
    32 * 1024 * 1024,
  );
  expect(
    browserScenarioCaptureSchema.safeParse({
      ...capture.data,
      events: {
        ...capture.data.events,
        dropped: 3,
      },
    }).success,
  ).toBe(false);
  for (const limits of [
    {},
    { max_events: DEFAULT_BROWSER_SCENARIO_CAPTURE_LIMITS.max_events },
  ])
    expect(
      browserScenarioCaptureSchema.safeParse({
        ...capture.data,
        scenario: { ...capture.data.scenario, limits },
      }).success,
    ).toBe(false);
  expect(
    browserScenarioCaptureSchema.safeParse({
      ...capture.data,
      scenario: { ...capture.data.scenario, limits: undefined },
    }).success,
  ).toBe(false);
});

it("limits event omission accounting to selected families", () => {
  const capture = browserScenarioCaptureSchema.parse(omissionAccountingInput());
  const selecting = (
    eventFamilies: (typeof capture.scenario.event_families)[number][],
    responseBody: boolean,
  ) =>
    browserScenarioCaptureSchema.safeParse({
      ...capture,
      scenario: {
        ...capture.scenario,
        event_families: eventFamilies,
        network_content: {
          ...capture.scenario.network_content,
          response_body: responseBody,
        },
      },
    });
  // Selecting network content alone enables network observation.
  expect(selecting([], true).success).toBe(true);
  expect(
    selecting(["console"], false).error?.issues.map(({ path }) => path),
  ).toEqual([
    ["events", "omissions", "by_kind", 0, "kind"],
    ["events", "omissions", "by_kind", 1, "kind"],
    ["events", "omissions", "network_transactions", 0],
    ["events", "omissions", "network_transaction_range"],
  ]);
  // Per-transaction records name only network kinds.
  expect(
    browserScenarioCaptureSchema
      .safeParse({
        ...capture,
        events: {
          ...capture.events,
          omissions: {
            ...capture.events.omissions,
            network_transactions: [
              ...capture.events.omissions.network_transactions,
              {
                transaction_id: "request-1",
                omitted_kinds: ["popup-opened"],
                reasons: ["max-total-event-allocation-bytes"],
              },
            ],
          },
        },
      })
      .error?.issues.map(({ path }) => path),
  ).toEqual([
    ["events", "omissions", "network_transactions", 1, "omitted_kinds", 0],
  ]);
  // Popup discovery serves every selected family, so an unadmitted popup page
  // is an omission whenever any family is selected.
  const popupDiscovery = (
    eventFamilies: (typeof capture.scenario.event_families)[number][],
  ) =>
    browserScenarioCaptureSchema.safeParse({
      ...capture,
      scenario: {
        ...capture.scenario,
        event_families: eventFamilies,
        network_content: {
          request_body: false,
          response_body: false,
          header_values: false,
        },
      },
      events: {
        ...capture.events,
        dropped: 1,
        omissions: {
          by_kind: [
            { kind: "popup-opened", count: 1, reasons: ["max-events"] },
          ],
          network_transactions: [],
          network_transaction_range: null,
        },
      },
    }).success;
  expect(popupDiscovery(["console"])).toBe(true);
  expect(popupDiscovery([])).toBe(false);
});

it("keeps step completeness equal to the step's artifacts and outcome", () => {
  const step = browserScenarioFixtureCapture().steps[1];
  if (step === undefined) throw new Error("Expected a fixture step");
  const issues = (changes: Record<string, unknown>) =>
    browserScenarioStepSchema
      .safeParse({ ...step, ...changes })
      .error?.issues.map(({ path }) => path);
  const failedCompleteness = classifyBrowserScenarioCompleteness(
    [...step.completeness.missing_sections, "action"],
    step.completeness.truncated_sections,
  );

  expect(issues({})).toBeUndefined();
  expect(
    issues({
      completeness: classifyBrowserScenarioCompleteness([], ["accessibility"]),
    }),
  ).toEqual([["completeness"]]);
  expect(
    issues({
      artifacts: {
        ...step.artifacts,
        dom: { state: "missing", reason: "DOM capture failed" },
      },
    }),
  ).toEqual([["completeness"]]);
  expect(issues({ status: "failed", error: "click failed" })).toEqual([
    ["completeness"],
  ]);
  expect(
    issues({
      status: "failed",
      error: "click failed",
      completeness: failedCompleteness,
    }),
  ).toBeUndefined();
  expect(issues({ completeness: failedCompleteness })).toEqual([
    ["completeness"],
  ]);
});

const fixtureIssues = (
  edit: (capture: BrowserScenarioCapture) => unknown,
): unknown[] | undefined =>
  browserScenarioCaptureSchema
    .safeParse(edit(structuredClone(browserScenarioFixtureCapture())))
    .error?.issues.map(({ path }) => path);

const withItems = (
  capture: BrowserScenarioCapture,
  items: readonly unknown[],
) => ({
  ...capture,
  events: { ...capture.events, retained: items.length, items },
});

/** The shared fixture with the next free event sequence and its first request. */
const fixtureFacts = () => {
  const fixture = browserScenarioFixtureCapture();
  const next =
    Math.max(...fixture.events.items.map(({ sequence }) => sequence)) + 1;
  const request = fixture.events.items.find(({ kind }) => kind === "request");
  if (request?.kind !== "request")
    throw new Error("Expected a fixture request");
  return { fixture, next, request };
};

it("keeps browser ownership and transaction omissions consistent", () => {
  const { request } = fixtureFacts();
  const range = ["events", "omissions", "network_transaction_range"];
  const transactionDrop = {
    kind: "request",
    count: 1,
    reasons: ["max-network-transactions"],
  };

  expect(fixtureIssues((capture) => capture)).toBeUndefined();
  expect(
    fixtureIssues((capture) => ({
      ...capture,
      browser: { ...capture.browser, cleanup: "disconnected-external" },
    })),
  ).toEqual([["browser"]]);
  // Transaction-limit drops and the omitted transaction range imply each other.
  expect(
    fixtureIssues((capture) => ({
      ...capture,
      events: {
        ...capture.events,
        omissions: {
          ...capture.events.omissions,
          network_transaction_range: {
            first_transaction_id: "request-9",
            last_transaction_id: "request-9",
            count: 1,
            reason: "max-network-transactions",
          },
        },
      },
    })),
  ).toEqual([range]);
  expect(
    fixtureIssues((capture) => ({
      ...capture,
      events: {
        ...capture.events,
        dropped: 1,
        omissions: { ...capture.events.omissions, by_kind: [transactionDrop] },
      },
      completeness: scenarioFixtureCompleteness(capture.steps, true),
    })),
  ).toEqual([range]);
  expect(
    fixtureIssues((capture) => ({
      ...capture,
      events: {
        ...capture.events,
        dropped: 1,
        omissions: {
          ...capture.events.omissions,
          by_kind: [transactionDrop],
          network_transaction_range: {
            first_transaction_id: "request-8",
            last_transaction_id: "request-9",
            count: 2,
            reason: "max-network-transactions",
          },
        },
      },
      completeness: scenarioFixtureCompleteness(capture.steps, true),
    })),
  ).toEqual([range]);
  expect(
    fixtureIssues((capture) => ({
      ...capture,
      events: {
        ...capture.events,
        omissions: {
          ...capture.events.omissions,
          network_transactions: [
            {
              transaction_id: request.transaction_id,
              omitted_kinds: ["response"],
              reasons: ["max-events"],
            },
          ],
        },
      },
    })),
  ).toEqual([["events", "omissions", "network_transactions", 0]]);
});

it("keeps event sequences within the accounted events", () => {
  const { fixture } = fixtureFacts();
  const accounted = fixture.events.retained + fixture.events.dropped;
  const last = fixture.events.items.length - 1;
  expect(
    fixtureIssues((capture) => ({
      ...capture,
      events: {
        ...capture.events,
        items: capture.events.items.map((event, index) =>
          index === last ? { ...event, sequence: accounted + 5 } : event,
        ),
      },
    })),
  ).toEqual([["events", "items", last, "sequence"]]);
  expect(
    fixtureIssues((capture) => ({
      ...capture,
      steps: capture.steps.map((step) =>
        step.step_index === 0
          ? { ...step, event_sequence_end: accounted + 1 }
          : step,
      ),
    })),
  ).toEqual([["steps", 0, "event_sequence_end"]]);
  // Dropped events spend sequence numbers too.
  const lastItem = fixture.events.items.length - 1;
  expect(
    fixtureIssues((capture) => ({
      ...capture,
      events: {
        ...capture.events,
        dropped: 2,
        items: capture.events.items.map((event, index) =>
          index === lastItem ? { ...event, sequence: accounted + 2 } : event,
        ),
        omissions: {
          ...capture.events.omissions,
          by_kind: [{ kind: "console", count: 2, reasons: ["max-events"] }],
        },
      },
      completeness: scenarioFixtureCompleteness(capture.steps, true),
    })),
  ).toBeUndefined();
});

it("records exactly the selected network content facets", () => {
  const { next, request } = fixtureFacts();
  const content = (
    selection: Record<string, boolean>,
    phase: "request" | "response",
    headers: unknown,
    body: unknown = { state: "not_requested" },
  ) =>
    fixtureIssues((capture) =>
      withItems(
        {
          ...capture,
          scenario: {
            ...capture.scenario,
            network_content: {
              request_body: false,
              response_body: false,
              header_values: false,
              ...selection,
            },
          },
        },
        [
          ...capture.events.items,
          {
            sequence: next,
            step_index: request.step_index,
            kind: "network-content",
            transaction_id: request.transaction_id,
            source_event_sequence: request.sequence,
            phase,
            headers,
            body,
          },
        ],
      ),
    );
  const item = ["events", "items", next - 1];
  const notRequested = { state: "not_requested" };

  expect(
    content({ header_values: true }, "request", {
      state: "captured",
      items: [],
    }),
  ).toBeUndefined();
  // A selected body recorded as never requested hides an unexamined facet.
  expect(content({ request_body: true }, "request", notRequested)).toEqual([
    [...item, "body"],
  ]);
  expect(content({ header_values: true }, "request", notRequested)).toEqual([
    [...item, "headers"],
  ]);
  // Unselected header values that were recorded anyway.
  expect(
    content({ request_body: true }, "request", {
      state: "captured",
      items: [],
    }),
  ).toEqual([
    [...item, "headers"],
    [...item, "body"],
  ]);
  // An unselected body that was recorded anyway.
  expect(
    content(
      { header_values: true },
      "request",
      { state: "captured", items: [] },
      {
        state: "captured",
        representation: "browser-exposed-request-bytes",
        encoding: "base64",
        content: "eA==",
        bytes: 1,
        sha256: createHash("sha256").update("x").digest("hex"),
        media_type: null,
        redacted: false,
      },
    ),
  ).toEqual([[...item, "body"]]);
  // No facet selected for the phase at all, even though headers were captured.
  expect(content({}, "request", { state: "captured", items: [] })).toEqual([
    item,
  ]);
  // A phase without any selected facet records no content.
  expect(content({ response_body: true }, "request", notRequested)).toEqual([
    item,
  ]);
});

it("leaves network content in unselected families to the family rule", () => {
  const { fixture, next, request } = fixtureFacts();
  const networkItems = fixture.events.items.flatMap(({ kind }, index) =>
    browserScenarioEventKindFamily(kind) === "network" ? [index] : [],
  );
  expect(
    fixtureIssues((capture) =>
      withItems(
        {
          ...capture,
          scenario: { ...capture.scenario, event_families: ["console"] },
        },
        [
          ...capture.events.items,
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
      ),
    ),
  ).toEqual(
    [...networkItems, next - 1].map((index) => [
      "events",
      "items",
      index,
      "kind",
    ]),
  );
});

it("drops no network content when no content facet is selected", () => {
  const { request } = fixtureFacts();
  expect(
    fixtureIssues((capture) => ({
      ...capture,
      events: {
        ...capture.events,
        dropped: 1,
        omissions: {
          by_kind: [
            { kind: "network-content", count: 1, reasons: ["max-events"] },
          ],
          network_transactions: [
            {
              transaction_id: request.transaction_id,
              omitted_kinds: ["network-content"],
              reasons: ["max-events"],
            },
          ],
          network_transaction_range: null,
        },
      },
      completeness: scenarioFixtureCompleteness(capture.steps, true),
    })),
  ).toEqual([["events", "omissions", "by_kind", 0, "kind"]]);
});

it("renumbers kept events, content anchors and windows in the fixture helper", () => {
  const { fixture, next } = fixtureFacts();
  // Anchor to the last request so removed console events precede its source.
  const request = fixture.events.items.findLast(
    ({ kind }) => kind === "request",
  );
  if (request?.kind !== "request")
    throw new Error("Expected a fixture request");
  expect(
    fixture.events.items.some(
      ({ kind, sequence }) => kind === "console" && sequence < request.sequence,
    ),
  ).toBe(true);
  const withContent = withItems(fixture, [
    ...fixture.events.items,
    {
      sequence: next,
      step_index: request.step_index,
      kind: "network-content",
      transaction_id: request.transaction_id,
      source_event_sequence: request.sequence,
      phase: "request",
      headers: { state: "captured", items: [] },
      body: { state: "not_requested" },
    },
  ]) as BrowserScenarioCapture;
  const kept = scenarioFixtureKeepingEvents(
    withContent,
    ({ kind }) => kind !== "console",
  );
  const keptRequest = kept.events.items.find(
    (event) =>
      event.kind === "request" &&
      event.transaction_id === request.transaction_id,
  );
  const keptContent = kept.events.items.find(
    ({ kind }) => kind === "network-content",
  );
  expect(keptContent).toMatchObject({
    source_event_sequence: keptRequest?.sequence,
  });
  expect(kept.events.items.map(({ sequence }) => sequence)).toEqual(
    kept.events.items.map((_, index) => index + 1),
  );
  expect(
    browserScenarioCaptureSchema.safeParse({
      ...kept,
      scenario: {
        ...kept.scenario,
        network_content: {
          ...kept.scenario.network_content,
          header_values: true,
        },
      },
    }).error?.issues,
  ).toBeUndefined();
  // Removing a kept content event's source would silently re-anchor it.
  expect(() =>
    scenarioFixtureKeepingEvents(withContent, ({ kind }) => kind !== "request"),
  ).toThrow(/loses its source event/u);
});

it("records one request per transaction", () => {
  const { next, request } = fixtureFacts();
  expect(
    fixtureIssues((capture) =>
      withItems(capture, [
        ...capture.events.items,
        { ...request, sequence: next },
      ]),
    ),
  ).toEqual([["events", "items", next - 1, "transaction_id"]]);
});

it("bounds drops of refused transactions by the recorded reasons", () => {
  const { fixture, request } = fixtureFacts();
  const last = fixture.events.items.length - 1;
  const range = (count: number) => ({
    first_transaction_id: "request-8",
    last_transaction_id: "request-9",
    count,
    reason: "max-network-transactions",
  });
  const accounting = (
    byKind: readonly { kind: string; count: number; reasons: string[] }[],
    transactions: readonly unknown[],
    transactionRange: unknown,
    lastSequence = fixture.events.items[last]?.sequence,
  ) =>
    fixtureIssues((capture) => ({
      ...capture,
      events: {
        ...capture.events,
        dropped: byKind.reduce((count, omission) => count + omission.count, 0),
        items: capture.events.items.map((event, index) =>
          index === last ? { ...event, sequence: lastSequence } : event,
        ),
        omissions: {
          by_kind: byKind,
          network_transactions: transactions,
          network_transaction_range: transactionRange,
        },
      },
      completeness: scenarioFixtureCompleteness(capture.steps, true),
    }));
  // by_kind counts both drops; one belongs to the admitted transaction.
  const mixed = {
    kind: "response",
    count: 2,
    reasons: ["max-network-transactions", "max-events"],
  };
  const admitted = [
    {
      transaction_id: request.transaction_id,
      omitted_kinds: ["response"],
      reasons: ["max-events"],
    },
  ];
  expect(accounting([mixed], admitted, range(1))).toBeUndefined();
  expect(accounting([mixed], admitted, range(2))).toEqual([
    ["events", "omissions", "network_transaction_range"],
  ]);
  // Drops of refused transactions spend no sequence numbers.
  const refusedOnly = {
    kind: "request",
    count: 2,
    reasons: ["max-network-transactions"],
  };
  const retained = fixture.events.retained;
  expect(accounting([refusedOnly], [], range(1), retained)).toBeUndefined();
  expect(accounting([refusedOnly], [], range(1), retained + 1)).toEqual([
    ["events", "items", last, "sequence"],
  ]);
  // Each listed reason stands for at least one drop.
  expect(
    accounting(
      [
        {
          kind: "console",
          count: 1,
          reasons: ["max-events", "max-event-allocation-bytes"],
        },
      ],
      [],
      null,
    ),
  ).toEqual([["events", "omissions", "by_kind", 0, "count"]]);
});

it("keeps retained events and admitted transactions within their limits", () => {
  const { fixture } = fixtureFacts();
  const limits = (changes: Record<string, number>) =>
    fixtureIssues((capture) => ({
      ...capture,
      scenario: {
        ...capture.scenario,
        limits: { ...capture.scenario.limits, ...changes },
      },
    }));
  const transactions = new Set(
    fixture.events.items.flatMap((event) =>
      "transaction_id" in event ? [event.transaction_id] : [],
    ),
  ).size;
  expect(limits({ max_events: fixture.events.retained })).toBeUndefined();
  expect(limits({ max_events: fixture.events.retained - 1 })).toEqual([
    ["events", "retained"],
  ]);
  expect(limits({ max_network_transactions: transactions })).toBeUndefined();
  expect(limits({ max_network_transactions: transactions - 1 })).toEqual([
    ["events", "items"],
  ]);
});

it("counts only network drops toward refused transactions", () => {
  const range = {
    first_transaction_id: "request-9",
    last_transaction_id: "request-9",
    count: 1,
    reason: "max-network-transactions",
  };
  expect(
    fixtureIssues((capture) => ({
      ...capture,
      events: {
        ...capture.events,
        dropped: 1,
        omissions: {
          by_kind: [
            {
              kind: "console",
              count: 1,
              reasons: ["max-network-transactions"],
            },
          ],
          network_transactions: [],
          network_transaction_range: range,
        },
      },
      completeness: scenarioFixtureCompleteness(capture.steps, true),
    })),
  ).toEqual([
    ["events", "omissions", "by_kind", 0],
    ["events", "omissions", "network_transaction_range"],
  ]);
});

it("backs each transaction omission with its per-kind drop", () => {
  const { request } = fixtureFacts();
  const transaction = (
    kind: string,
    reason: string,
    id = request.transaction_id,
  ) => ({
    transaction_id: id,
    omitted_kinds: [kind],
    reasons: [reason],
  });
  const omitting = (
    byKind: readonly { kind: string; count: number; reasons: string[] }[],
    transactions: readonly unknown[],
    range: unknown = null,
  ) =>
    fixtureIssues((capture) => ({
      ...capture,
      events: {
        ...capture.events,
        dropped: byKind.reduce((count, omission) => count + omission.count, 0),
        omissions: {
          by_kind: byKind,
          network_transactions: transactions,
          network_transaction_range: range,
        },
      },
      completeness: scenarioFixtureCompleteness(capture.steps, true),
    }));
  const responseDrop = { kind: "response", count: 1, reasons: ["max-events"] };
  const entry = (index: number) => [
    "events",
    "omissions",
    "network_transactions",
    index,
  ];
  const kindEntry = ["events", "omissions", "by_kind", 0];

  expect(
    omitting([responseDrop], [transaction("response", "max-events")]),
  ).toBeUndefined();
  // Metadata over its own budget is a per-transaction omission too.
  expect(
    omitting(
      [
        {
          kind: "request",
          count: 1,
          reasons: ["max-network-metadata-allocation-bytes"],
        },
      ],
      [transaction("request", "max-network-metadata-allocation-bytes")],
    ),
  ).toBeUndefined();
  // A dropped console event cannot stand behind an omitted response.
  expect(
    omitting(
      [{ kind: "console", count: 1, reasons: ["max-events"] }],
      [transaction("response", "max-events")],
    ),
  ).toEqual([entry(0)]);
  // Every kind a transaction omits needs its own drop.
  expect(
    omitting(
      [{ kind: "request", count: 1, reasons: ["max-events"] }],
      [
        {
          transaction_id: request.transaction_id,
          omitted_kinds: ["request", "response"],
          reasons: ["max-events"],
        },
      ],
    ),
  ).toEqual([entry(0)]);
  // More transactions omit a kind than events of that kind were dropped.
  expect(
    omitting(
      [responseDrop],
      [
        transaction("response", "max-events"),
        transaction("response", "max-events", "request-9"),
      ],
    ),
  ).toEqual([[...kindEntry, "count"]]);
  // Reasons must match in both directions.
  expect(
    omitting(
      [{ ...responseDrop, reasons: ["max-event-allocation-bytes"] }],
      [transaction("response", "max-events")],
    ),
  ).toEqual([entry(0), kindEntry]);
  expect(omitting([responseDrop], [])).toEqual([kindEntry]);
  // Refused transactions belong to the omitted range, not to per-transaction records.
  expect(
    omitting(
      [{ kind: "request", count: 1, reasons: ["max-network-transactions"] }],
      [transaction("request", "max-network-transactions")],
      {
        first_transaction_id: "request-9",
        last_transaction_id: "request-9",
        count: 1,
        reason: "max-network-transactions",
      },
    ),
  ).toEqual([entry(0)]);
});

it("keeps capture completeness equal to the aggregated step ledgers", () => {
  const { fixture } = fixtureFacts();
  // Capture completeness aggregates the step ledgers, and only events add to it.
  expect(
    fixtureIssues((capture) => ({
      ...capture,
      completeness: scenarioFixtureCompleteness(capture.steps.slice(0, 1)),
    })),
  ).toEqual([["completeness"]]);
  expect(
    fixtureIssues((capture) => ({
      ...capture,
      completeness: classifyBrowserScenarioCompleteness(
        [...capture.completeness.missing_sections, "frames"],
        capture.completeness.truncated_sections,
      ),
    })),
  ).toEqual([["completeness"]]);
  for (const completeness of [
    classifyBrowserScenarioCompleteness(fixture.completeness.missing_sections, [
      "dom",
    ]),
    {
      ...fixture.completeness,
      missing_sections: [...fixture.completeness.missing_sections, "action"],
    },
  ])
    expect(fixtureIssues((capture) => ({ ...capture, completeness }))).toEqual([
      ["completeness"],
    ]);
});

it("requires missing events whenever the capture shows an event gap", () => {
  const { fixture, next, request } = fixtureFacts();
  const eventsMissing = ["completeness", "missing_sections"];
  // Connect mode, dropped events and retained event gaps make events missing.
  for (const gap of [
    (capture: BrowserScenarioCapture) => ({
      ...capture,
      browser: {
        ...capture.browser,
        mode: "connect",
        process_ownership: "external",
        cleanup: "disconnected-external",
      },
    }),
    (capture: BrowserScenarioCapture) => ({
      ...capture,
      events: {
        ...capture.events,
        dropped: 1,
        omissions: {
          ...capture.events.omissions,
          by_kind: [{ kind: "console", count: 1, reasons: ["max-events"] }],
        },
      },
    }),
    (capture: BrowserScenarioCapture) =>
      withItems(capture, [
        ...capture.events.items,
        {
          ...request,
          sequence: next,
          kind: "request-unfinished",
          reason: "capture-ended",
        },
      ]),
    (capture: BrowserScenarioCapture) =>
      withItems(
        {
          ...capture,
          scenario: {
            ...capture.scenario,
            network_content: {
              ...capture.scenario.network_content,
              header_values: true,
            },
          },
        },
        [
          ...capture.events.items,
          {
            sequence: next,
            step_index: request.step_index,
            kind: "network-content",
            transaction_id: request.transaction_id,
            source_event_sequence: request.sequence,
            phase: "request",
            headers: {
              state: "unavailable",
              message: "headers were not exposed",
            },
            body: { state: "not_requested" },
          },
        ],
      ),
    (capture: BrowserScenarioCapture) =>
      withItems(
        {
          ...capture,
          scenario: {
            ...capture.scenario,
            event_families: ["console", "frames", "network", "popups"],
          },
        },
        [
          ...capture.events.items,
          {
            sequence: next,
            step_index: 1,
            kind: "popup-opened",
            url: null,
            name: null,
          },
        ],
      ),
  ])
    expect(fixtureIssues(gap)).toEqual([eventsMissing]);
  expect(
    browserScenarioCaptureSchema.safeParse({
      ...fixture,
      browser: {
        ...fixture.browser,
        mode: "connect",
        process_ownership: "external",
        cleanup: "disconnected-external",
      },
    }).error?.issues[0]?.message,
  ).toBe(
    "Connect mode leaves event coverage incomplete, so events must be missing",
  );
  // Without a gap family, a retained popup-opened leaves coverage complete.
  expect(
    fixtureIssues((capture) =>
      withItems(
        {
          ...capture,
          scenario: {
            ...capture.scenario,
            event_families: ["console", "network", "popups"],
          },
        },
        [
          ...capture.events.items,
          {
            sequence: next,
            step_index: 1,
            kind: "popup-opened",
            url: null,
            name: null,
          },
        ],
      ),
    ),
  ).toBeUndefined();
});

it("opens the start step's receipt window at the first event sequence", () => {
  expect(
    fixtureIssues((capture) => ({
      ...capture,
      steps: capture.steps.map((step) =>
        step.step_index === 0 ? { ...step, event_sequence_start: 2 } : step,
      ),
    })),
  ).toEqual([["steps", 0, "event_sequence_start"]]);
});

it("keeps steps after a failure as cancellations that never ran", () => {
  const fixture = browserScenarioFixtureCapture();
  const capturedUrl = fixture.steps[3]?.artifacts.url;
  expect(fixture.steps.map(({ status }) => status).slice(3)).toEqual([
    "failed",
    "cancelled",
  ]);
  const editLast = (changes: Record<string, unknown>) =>
    fixtureIssues((capture) => {
      const steps = capture.steps.map((step) =>
        step.step_index === 4 ? { ...step, ...changes } : step,
      );
      return {
        ...capture,
        steps,
        completeness: scenarioFixtureCompleteness(steps),
      };
    });

  expect(
    editLast({
      artifacts: { ...fixture.steps[4]?.artifacts, url: capturedUrl },
      completeness: classifyBrowserScenarioCompleteness(
        ["screenshot", "accessibility", "action"],
        [],
      ),
    }),
  ).toEqual([["steps", 4, "artifacts"]]);
  for (const changes of [
    {
      status: "completed",
      error: null,
      completeness: deriveStepCompleteness({
        status: "completed",
        artifacts: fixture.steps[4]!.artifacts,
      }),
    },
    { elapsed_ms: 5 },
    { after_url: scenarioFixtureUrl("/elsewhere") },
    { event_sequence_end: 7 },
  ])
    expect(editLast(changes)).toEqual([["steps", 4]]);
});

it("derives equality eligibility from exact completeness state", () => {
  expect(
    browserScenarioCompletenessSchema.safeParse({
      status: "complete",
      equality_eligible: false,
      missing_sections: [],
      truncated_sections: [],
    }).success,
  ).toBe(false);
  expect(
    browserScenarioCompletenessSchema.safeParse({
      status: "incomplete",
      equality_eligible: false,
      missing_sections: ["dom"],
      truncated_sections: ["events"],
    }).success,
  ).toBe(false);
});
