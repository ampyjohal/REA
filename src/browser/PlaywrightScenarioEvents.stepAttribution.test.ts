import { EventEmitter } from "node:events";
import type { Page } from "playwright-core";
import { expect, it } from "vitest";

import {
  analysisViewRequestSchema,
  projectAnalysisView,
  type AnalysisViewParent,
} from "../domain/analysisView/analysisView.js";
import { browserScenarioCaptureSchema } from "../domain/browserScenarioCapture.js";
import {
  browserScenarioFixtureCapture,
  browserScenarioFixtureParameters,
  browserScenarioFixtureScenario,
  scenarioFixtureCompleteness,
} from "../domain/browserScenarioCapture.fixture.js";
import { capturedScenarioFields } from "../domain/browserScenarioCaptureFields.js";
import { BrowserScenarioSecrets } from "./BrowserScenarioSecrets.js";
import { PlaywrightScenarioEvents } from "./PlaywrightScenarioEvents.js";

// 120 request header names make the request event larger than its response.
// Under this per-event allocation limit the recorder drops the request and its
// completion but keeps the response.
const REQUEST_HEADERS = Array.from({ length: 120 }, (_, index) => ({
  name: `x-request-header-${String(index)}`,
  value: "v",
}));
const MAX_EVENT_ALLOCATION_BYTES = 23_168;

it("attributes a transaction whose request the recorder dropped to no step", async () => {
  const scenario = browserScenarioFixtureScenario({
    capture: {
      after_each_step: ["accessibility", "url"],
      at_end: ["screenshot"],
      events: ["network"],
      limits: { max_event_allocation_bytes: MAX_EVENT_ALLOCATION_BYTES },
    },
  });
  const secrets = BrowserScenarioSecrets.resolve(scenario, {});
  if (secrets === undefined) throw new Error("Expected resolved secrets");
  const context = new EventEmitter();
  const events = new PlaywrightScenarioEvents({
    page: new EventEmitter() as unknown as Page,
    context: context as never,
    ownsContext: true,
    enabled: new Set(["network"]),
    network: scenario.capture.network,
    limits: scenario.capture.limits,
    secrets,
  });
  const request = {
    method: () => "POST",
    url: () => scenario.start_url.url.replace("/app", "/api/save"),
    resourceType: () => "fetch",
    postDataBuffer: () => null,
    redirectedFrom: () => null,
    failure: () => null,
    headers: () =>
      Object.fromEntries(
        REQUEST_HEADERS.map(({ name, value }) => [name, value]),
      ),
    headersArray: async () => REQUEST_HEADERS,
  };
  // The save click sends the request; its response arrives during a later step.
  events.setStep(1);
  context.emit("request", request);
  events.setStep(3);
  context.emit("response", {
    request: () => request,
    url: () => request.url(),
    status: () => 200,
    headers: () => ({}),
    headersArray: async () => [],
    body: async () => Buffer.alloc(0),
  });
  context.emit("requestfinished", request);
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  await events.finish();
  const result = events.result();
  expect(
    result.items.map(({ kind, step_index: step }) => [kind, step]),
  ).toEqual([["response", 3]]);
  expect(result.omissions.by_kind).toContainEqual(
    expect.objectContaining({
      kind: "request",
      reasons: ["max-event-allocation-bytes"],
    }),
  );

  const fixture = browserScenarioFixtureCapture();
  const last = events.lastSequence();
  const windows = [
    [1, 0],
    [1, 1],
    [2, 1],
    [2, last],
    [last + 1, last],
  ];
  const steps = fixture.steps.map((step, index) => ({
    ...step,
    event_sequence_start: windows[index]?.[0] ?? 0,
    event_sequence_end: windows[index]?.[1] ?? 0,
  }));
  const capture = browserScenarioCaptureSchema.parse({
    ...fixture,
    scenario: capturedScenarioFields(scenario),
    steps,
    events: result,
    completeness: scenarioFixtureCompleteness(steps, true),
  });
  const parent: AnalysisViewParent = {
    evidenceId: `ev_${"d".repeat(64)}`,
    operation: "capture_browser_scenario",
    normalizedResult: capture,
    subject: null,
    parameters: browserScenarioFixtureParameters(scenario),
    limitations: [],
    artifact: null,
  };
  const project = (view: unknown) => {
    const projected = projectAnalysisView(
      parent,
      analysisViewRequestSchema.parse(view),
    );
    if (!projected.ok) throw projected.error;
    return projected.value;
  };
  const summary = project({ kind: "summary" });
  if (
    summary.kind !== "summary" ||
    !("network_transactions" in summary.summary)
  )
    throw new Error("Expected a browser scenario summary");
  expect(summary.summary.network_transactions).toEqual({
    coverage: "truncated",
    retained: 1,
    without_retained_request: 1,
    omitted_by_transaction_limit: 0,
  });
  expect(summary.unknowns).toEqual(
    expect.arrayContaining([
      expect.stringContaining(
        "1 retained network transaction has no retained request event",
      ),
    ]),
  );
  const page = project({ kind: "browser-scenario", collection: "steps" });
  if (page.kind !== "browser-scenario" || page.page.collection !== "steps")
    throw new Error("Expected a step page");
  expect(
    page.page.items.map(({ network_transactions: count }) => count.retained),
  ).toEqual([0, 0, 0, 0, 0]);
});
