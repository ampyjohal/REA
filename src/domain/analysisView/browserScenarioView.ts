import { z } from "zod";

import type { AnalysisError } from "../analysisErrorBase.js";
import { analysisViewInputError } from "./analysisViewErrors.js";
import {
  browserScenarioCaptureSchema,
  type BrowserScenarioCapture,
} from "../browserScenarioCapture.js";
import { browserScenarioEventFamilySchema } from "../browserScenarioCaptureValues.js";
import {
  BROWSER_SCENARIO_STATE_ARTIFACTS,
  type BrowserScenarioStateArtifact,
} from "../browserScenarioDiffEvidence.js";
import {
  projectBrowserScenarioSteps,
  type BrowserScenarioStepFacts,
  type BrowserScenarioStepProjection,
  type ReceivedScenarioEvents,
} from "../browserScenarioSteps.js";
import { err, ok, type Result } from "../result.js";
import { parseAnalysisViewResult } from "./analysisViewParent.js";
import type {
  AnalysisViewParent,
  AnalysisViewRequest,
  UnsignedAnalysisView,
} from "./analysisView.js";
import {
  boundedViewMessages,
  completeWithinViewCoverage,
  pageViewCoverage,
} from "./analysisViewCoverage.js";
import { analysisTextPage } from "./analysisViewText.js";
import {
  checkRecordedScenario,
  recordedActions,
  type RecordedAction,
} from "./browserScenarioViewDeclarations.js";
import {
  browserScenarioStepRowSchema,
  browserScenarioSummarySchema,
  browserScenarioViewPageSchema,
  receivedEventsSchema,
  textItemSchema,
} from "./browserScenarioViewSchemas.js";

type StepRow = z.output<typeof browserScenarioStepRowSchema>;

const stepRow = (
  facts: BrowserScenarioStepFacts,
  action: RecordedAction | undefined,
): StepRow => {
  const { step, state, changes } = facts;
  const artifacts = BROWSER_SCENARIO_STATE_ARTIFACTS.flatMap((artifact) => {
    const observed = state[artifact];
    const change = changes === undefined ? null : changes[artifact];
    if (
      observed.state === "not_requested" &&
      (change === null || change === "not_compared")
    )
      return [];
    const recorded = step.artifacts[artifact];
    return [
      {
        artifact,
        coverage: observed.state,
        reason:
          recorded.state === "missing" || recorded.state === "truncated"
            ? recorded.reason
            : null,
        comparison_sha256: observed.sha256,
        change,
      },
    ];
  });
  return {
    step_index: step.step_index,
    step_id: step.step_id,
    action_class: action?.actionClass ?? "start-navigation",
    action: action?.declaration ?? null,
    status: step.status,
    error: step.error,
    elapsed_ms: step.elapsed_ms,
    before_url: step.before_url,
    after_url: step.after_url,
    artifacts,
    events_received: {
      coverage: facts.eventCoverage,
      sequence_start: step.event_sequence_start,
      sequence_end: step.event_sequence_end,
      retained: facts.eventsReceived.retained,
      kinds: [...facts.eventsReceived.kinds],
    },
    network_transactions: facts.networkTransactions,
  };
};

const tally = <Value extends string>(
  values: readonly Value[],
  keys: readonly Value[],
): Record<Value, number> => {
  const counts = Object.fromEntries(keys.map((key) => [key, 0])) as Record<
    Value,
    number
  >;
  for (const value of values) counts[value] += 1;
  return counts;
};

const summarize = (
  capture: BrowserScenarioCapture,
  projection: BrowserScenarioStepProjection,
  limitationCount: number,
): z.output<typeof browserScenarioSummarySchema> => {
  const receivedOutside = (
    events: ReceivedScenarioEvents,
  ): z.output<typeof receivedEventsSchema> => ({
    retained: events.retained,
    kinds: [...events.kinds],
  });
  return {
    browser: capture.browser,
    start_origin: capture.scenario.start_origin,
    action_count: capture.scenario.action_count,
    duration_ms: capture.duration_ms,
    step_statuses: tally(
      capture.steps.map(({ status }) => status),
      ["completed", "failed", "cancelled"],
    ),
    artifact_coverage: BROWSER_SCENARIO_STATE_ARTIFACTS.map((artifact) => ({
      artifact,
      ...tally(
        projection.steps.map(({ state }) => state[artifact].state),
        ["captured", "not_requested", "missing", "truncated"],
      ),
    })),
    step_changes: BROWSER_SCENARIO_STATE_ARTIFACTS.map((artifact) => ({
      artifact,
      ...tally(
        projection.steps.flatMap(({ changes }) =>
          changes === undefined ? [] : [changes[artifact]],
        ),
        ["changed", "unchanged", "unknown", "not_compared"],
      ),
    })),
    events: {
      declared_families: [...capture.scenario.event_families].sort(),
      enabled_families: [...projection.enabledEventFamilies],
      retained: capture.events.retained,
      dropped: capture.events.dropped,
      received_outside_step_windows: receivedOutside(
        projection.receivedOutsideStepWindows,
      ),
    },
    network_transactions: {
      coverage: projection.networkTransactions.coverage,
      retained: projection.networkTransactions.retained,
      without_retained_request:
        projection.networkTransactions.withoutRetainedRequest,
      omitted_by_transaction_limit:
        capture.events.omissions.network_transaction_range?.count ?? 0,
    },
    completeness: capture.completeness,
    limitation_count: limitationCount,
  };
};

const VIEW_LIMITATIONS = [
  "Step changes compare each step's capture with the previous step's capture; they do not attribute a difference to the action, and unchanged covers only that artifact at those two capture instants.",
  "Comparison digests apply no normalization rules: volatile text, values or animation frames report changed, redacted URL and storage values compare in redacted form, and equal digests do not establish equal application state.",
  "Artifacts are read one after another after each step. DOM and accessibility exclude iframe documents, while the viewport screenshot renders them; history.length counts joint session history; storage covers the current page URL's cookies and the current origin's web storage, so a cross-origin step compares different scopes.",
  "events_received counts receipt during each step's sequence window, not causation; responses can arrive during later steps, and events between windows or after the final capture appear on no row (see received_outside_step_windows).",
] as const;

const conditionalLimitations = (capture: BrowserScenarioCapture): string[] => [
  ...(capture.steps.some(({ status }) => status === "cancelled")
    ? [
        "Cancelled steps have no post-action capture and do not record whether the action began; after an earlier failure, after_url repeats before_url.",
      ]
    : []),
  ...(capture.browser.mode === "connect"
    ? [
        "Connect mode attached to a browser profile the scenario does not own; activity outside the scenario can change page and storage state.",
      ]
    : []),
];

/** Name artifacts compared at some steps but not others, without advising extra capture. */
const partiallyRequestedArtifacts = (
  projection: BrowserScenarioStepProjection,
): string[] => {
  const partial = BROWSER_SCENARIO_STATE_ARTIFACTS.filter(
    (artifact: BrowserScenarioStateArtifact) => {
      const requested = projection.steps.filter(
        ({ state }) => state[artifact].state !== "not_requested",
      ).length;
      return requested > 0 && requested < projection.steps.length;
    },
  );
  if (partial.length === 0) return [];
  return [
    `${partial.join(", ")} ${partial.length === 1 ? "was" : "were"} requested at some steps but not others, so comparisons with unrequested steps stay unknown. Include an artifact in capture.after_each_step only when its step changes are needed.`,
  ];
};

const unobservedFamilies = (
  projection: BrowserScenarioStepProjection,
): string[] => {
  const unobserved = browserScenarioEventFamilySchema.options.filter(
    (family) => !projection.enabledEventFamilies.includes(family),
  );
  return unobserved.length === 0
    ? []
    : [
        `Event families ${unobserved.join(", ")} were not observed; their absence from events_received or network_transactions is not absence from the page.`,
      ];
};

/** Name transactions no step row counts because their starting step is unknown. */
const unattributedTransactions = (
  projection: BrowserScenarioStepProjection,
): string[] => {
  const count = projection.networkTransactions.withoutRetainedRequest ?? 0;
  return count === 0
    ? []
    : [
        `${String(count)} retained network ${count === 1 ? "transaction has" : "transactions have"} no retained request event, so the step that started ${count === 1 ? "it" : "them"} is unknown; the summary total includes ${count === 1 ? "it" : "them"}, but no step row does.`,
      ];
};

const unknownsFor = (
  capture: BrowserScenarioCapture,
  projection: BrowserScenarioStepProjection,
): string[] => [
  "Controls and executable actions available in each state are not inventoried; accessibility is retained as aria-snapshot text, so absence from these views is not absence from the page.",
  "Only the declared actions were executed; states and transitions the scenario did not exercise remain unknown.",
  ...partiallyRequestedArtifacts(projection),
  ...unobservedFamilies(projection),
  ...unattributedTransactions(projection),
  ...(capture.completeness.status === "complete"
    ? []
    : [
        `The parent capture is ${capture.completeness.status} (missing: ${capture.completeness.missing_sections.join(", ") || "none"}; truncated: ${capture.completeness.truncated_sections.join(", ") || "none"}).`,
      ]),
];

const textItem = (
  facts: BrowserScenarioStepFacts,
  artifact: "accessibility" | "dom",
  offset: number,
  limit: number,
): Result<
  {
    readonly item: z.output<typeof textItemSchema>;
    readonly coverage: ReturnType<typeof pageViewCoverage>;
  },
  AnalysisError
> => {
  // The capture schema keeps step completeness equal to these artifact states.
  const recorded = facts.step.artifacts[artifact];
  if (recorded.state !== "captured")
    return ok({
      item: {
        coverage: recorded.state,
        reason: recorded.state === "not_requested" ? null : recorded.reason,
      },
      coverage: pageViewCoverage(offset, 0, 0),
    });
  const page = analysisTextPage(
    recorded.value.text,
    offset,
    limit,
    artifact === "dom" ? "DOM" : "Accessibility",
  );
  if (!page.ok) return page;
  return ok({
    item: {
      coverage: "captured",
      ...page.value.item,
      artifact_sha256: recorded.value.sha256,
      total_code_units: recorded.value.text.length,
    },
    coverage: page.value.coverage,
  });
};

type BrowserScenarioViewRequest = Extract<
  AnalysisViewRequest,
  { readonly kind: "browser-scenario" }
>;

/** Parent identity, limitations and unknowns shared by every page of one capture. */
const sharedFields = (
  parent: AnalysisViewParent,
  capture: BrowserScenarioCapture,
  projection: BrowserScenarioStepProjection,
) => ({
  parent_evidence_id: parent.evidenceId,
  parent_operation: "capture_browser_scenario" as const,
  parent_digest: parent.evidenceId.slice(3),
  artifact: { path: "", sha256: null },
  // Only parent-owned limitations may be omitted; the parent keeps them.
  limitations: boundedViewMessages(
    [...parent.limitations, ...capture.limitations],
    parent.evidenceId,
    "limitations",
    [...VIEW_LIMITATIONS, ...conditionalLimitations(capture)],
  ),
  unknowns: boundedViewMessages(
    unknownsFor(capture, projection),
    parent.evidenceId,
    "unknowns",
  ),
});

/** Everything a page needs from one parent beyond its own selection. */
interface ProjectedScenario {
  readonly evidenceId: string;
  readonly capture: BrowserScenarioCapture;
  readonly projection: BrowserScenarioStepProjection;
  readonly declarations: readonly RecordedAction[];
  readonly shared: ReturnType<typeof sharedFields>;
}

// A sealed parent result cannot change, and the content-addressed Evidence ID
// authenticates the parameters and limitations checked with it. One parse,
// projection and declaration check therefore stay exact for every later page
// of that Evidence. The weak reference lets memory pressure reclaim the copy;
// unsealed input and failed checks are checked again on each call.
const projectedScenarios = new WeakMap<object, WeakRef<ProjectedScenario>>();

const projectScenario = (
  parent: AnalysisViewParent,
): Result<ProjectedScenario, AnalysisError> => {
  const { normalizedResult } = parent;
  const sealed =
    parent.sealedResult === true &&
    typeof normalizedResult === "object" &&
    normalizedResult !== null;
  const cached = sealed
    ? projectedScenarios.get(normalizedResult)?.deref()
    : undefined;
  if (cached?.evidenceId === parent.evidenceId) return ok(cached);
  const parsed = parseAnalysisViewResult(browserScenarioCaptureSchema, parent);
  if (!parsed.ok) return parsed;
  const capture = parsed.value;
  const projection = projectBrowserScenarioSteps(capture);
  if (!projection.ok)
    return err(
      analysisViewInputError([
        {
          ...projection.error,
          path: ["source", "normalized_result", ...projection.error.path],
        },
      ]),
    );
  const declarations = recordedActions(parent, capture);
  if (!declarations.ok) return declarations;
  const selection = checkRecordedScenario(parent, capture);
  if (!selection.ok) return selection;
  const projected = {
    evidenceId: parent.evidenceId,
    capture,
    projection: projection.value,
    declarations: declarations.value,
    shared: sharedFields(parent, capture, projection.value),
  };
  if (sealed) projectedScenarios.set(normalizedResult, new WeakRef(projected));
  return ok(projected);
};

/** Select a step page or one step's text page. */
const selectedPage = (
  view: BrowserScenarioViewRequest,
  { projection, declarations }: ProjectedScenario,
): Result<
  {
    readonly page: z.output<typeof browserScenarioViewPageSchema>;
    readonly coverage: ReturnType<typeof pageViewCoverage>;
  },
  AnalysisError
> => {
  if (view.collection === "steps") {
    const items = projection.steps
      .slice(view.offset, view.offset + view.limit)
      .map((facts) =>
        stepRow(
          facts,
          facts.step.step_index === 0
            ? undefined
            : declarations[facts.step.step_index - 1],
        ),
      );
    return ok({
      page: { collection: "steps", items },
      coverage: pageViewCoverage(
        view.offset,
        items.length,
        projection.steps.length,
      ),
    });
  }
  const facts = projection.steps[view.step_index];
  if (facts === undefined)
    return err(
      analysisViewInputError([
        {
          path: ["view", "step_index"],
          reason: "out_of_range",
          message: `Select a recorded step_index from 0 to ${String(projection.steps.length - 1)}.`,
        },
      ]),
    );
  const text = textItem(facts, view.artifact, view.offset, view.limit);
  if (!text.ok) return text;
  return ok({
    page: {
      collection: "text",
      step_index: facts.step.step_index,
      step_id: facts.step.step_id,
      artifact: view.artifact,
      item: text.value.item,
    },
    coverage: text.value.coverage,
  });
};

/** Project retained capture_browser_scenario Evidence without reopening a browser. */
export const projectBrowserScenarioView = (
  parent: AnalysisViewParent,
  view: AnalysisViewRequest,
): Result<UnsignedAnalysisView, AnalysisError> => {
  if (view.kind !== "summary" && view.kind !== "browser-scenario")
    return err(
      analysisViewInputError([
        {
          path: ["view"],
          reason: "invalid_value",
          message:
            "Browser scenario captures support summary, browser-scenario, environment-manifest and environment-state views.",
        },
      ]),
    );
  const projected = projectScenario(parent);
  if (!projected.ok) return projected;
  const { capture, projection, shared } = projected.value;
  if (view.kind === "summary")
    return ok({
      kind: "summary",
      view,
      ...shared,
      summary: summarize(capture, projection, shared.limitations.length),
      coverage: completeWithinViewCoverage(
        projection.steps.length,
        projection.steps.length,
      ),
    });
  const selected = selectedPage(view, projected.value);
  if (!selected.ok) return selected;
  return ok({
    kind: "browser-scenario",
    view,
    page: selected.value.page,
    ...shared,
    source_completeness: capture.completeness.status,
    enabled_event_families: [...projection.enabledEventFamilies],
    received_outside_step_windows: {
      retained: projection.receivedOutsideStepWindows.retained,
      kinds: [...projection.receivedOutsideStepWindows.kinds],
    },
    coverage: selected.value.coverage,
  });
};
