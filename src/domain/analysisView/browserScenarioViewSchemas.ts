import { z } from "zod";

import { sanitizedBrowserUrlSchema } from "../browserObservation.js";
import { browserScenarioCaptureSchema } from "../browserScenarioCapture.js";
import {
  browserScenarioCompletenessSchema,
  browserScenarioEventFamilySchema,
  browserScenarioEventKindSchema,
} from "../browserScenarioCaptureValues.js";
import { BROWSER_SCENARIO_STATE_ARTIFACTS } from "../browserScenarioDiffEvidence.js";
import { browserScenarioEvidenceStateSchema } from "../browserScenarioDiffValues.js";
import { digestSchema } from "../digests.js";
import { jsonObjectSchema } from "../jsonValue.js";

const stateArtifactSchema = z.enum(BROWSER_SCENARIO_STATE_ARTIFACTS);
const coverageStateSchema = browserScenarioEvidenceStateSchema;

/** Step pages or one step's retained artifact text from capture_browser_scenario Evidence. */
export const browserScenarioViewRequestSchema = z.discriminatedUnion(
  "collection",
  [
    z.strictObject({
      kind: z.literal("browser-scenario"),
      collection: z.literal("steps"),
      offset: z.number().int().nonnegative().default(0),
      limit: z.number().int().positive().default(64),
    }),
    z.strictObject({
      kind: z.literal("browser-scenario"),
      collection: z.literal("text"),
      step_index: z
        .number()
        .int()
        .nonnegative()
        .describe("Recorded step_index whose post-step artifact is read."),
      artifact: z
        .enum(["accessibility", "dom"])
        .describe(
          "Retained text artifact: Playwright aria-snapshot text or page HTML.",
        ),
      offset: z.number().int().nonnegative().default(0),
      limit: z
        .number()
        .int()
        .positive()
        .describe("UTF-16 code units to return from offset."),
    }),
  ],
);

const eventKindCountsSchema = z.array(
  z.strictObject({
    kind: browserScenarioEventKindSchema,
    count: z.number().int().positive(),
  }),
);

export const receivedEventsSchema = z.strictObject({
  retained: z.number().int().nonnegative(),
  kinds: eventKindCountsSchema,
});

const eventCoverageSchema = coverageStateSchema.describe(
  "Capture-wide event coverage: not_requested when no family was observed; missing or truncated event sections, including connect-mode attachment and dropped events, apply to every step.",
);

const networkTransactionsSchema = z
  .strictObject({
    coverage: eventCoverageSchema,
    retained: z
      .number()
      .int()
      .nonnegative()
      .nullable()
      .describe(
        "Retained transaction count; null when network was not observed.",
      ),
  })
  .describe(
    "Network transactions attributed to the step of their retained request event; a transaction without a retained request counts toward no step.",
  );

const stepArtifactSchema = z.strictObject({
  artifact: stateArtifactSchema,
  coverage: coverageStateSchema.describe(
    "Capture state after this step, projected through the step completeness ledger; not_requested means REA did not look.",
  ),
  reason: z
    .string()
    .min(1)
    .nullable()
    .describe("Recorded reason for missing or truncated coverage."),
  comparison_sha256: digestSchema
    .nullable()
    .describe(
      "compare_web_captures digest of the recorded value without normalization rules; equal digests mean equal recorded values, not equal application state.",
    ),
  change: z
    .enum(["changed", "unchanged", "unknown", "not_compared"])
    .nullable()
    .describe(
      "Comparison with the previous step's capture of this artifact; null for the start navigation.",
    ),
});

/** One recorded step with its comparison to the previous step's capture. */
export const browserScenarioStepRowSchema = z.strictObject({
  step_index: z.number().int().nonnegative(),
  step_id: z.string().min(1),
  action_class: z
    .enum(["start-navigation", "navigation", "input", "wait"])
    .describe(
      "Declared action family; wait steps dispatch no input, so their differences come from page activity or capture side effects.",
    ),
  action: jsonObjectSchema
    .nullable()
    .describe(
      "Exact recorded action declaration from the parent Evidence parameters; null for the start navigation.",
    ),
  status: z.enum(["completed", "failed", "cancelled"]),
  error: z.string().nullable(),
  elapsed_ms: z.number().int().nonnegative(),
  before_url: sanitizedBrowserUrlSchema.describe(
    "Sanitized URL recorded when the step started.",
  ),
  after_url: sanitizedBrowserUrlSchema.describe(
    "Sanitized URL recorded after the step's capture finished.",
  ),
  artifacts: z
    .array(stepArtifactSchema)
    .describe(
      "Artifacts requested at this step or the previous one, in comparison order.",
    ),
  events_received: receivedEventsSchema
    .extend({
      coverage: eventCoverageSchema,
      sequence_start: z.number().int().min(1),
      sequence_end: z.number().int().nonnegative(),
    })
    .describe(
      "Retained events of the enabled families received inside this step's sequence window; receipt does not establish that the step's action caused them.",
    ),
  network_transactions: networkTransactionsSchema,
});

export const textItemSchema = z.union([
  z.strictObject({
    coverage: z.literal("captured"),
    text: z.string(),
    unit: z.literal("utf16-code-units"),
    artifact_sha256: digestSchema.describe(
      "Producer SHA-256 of the complete retained artifact text.",
    ),
    total_code_units: z.number().int().nonnegative(),
  }),
  z.strictObject({
    coverage: z.enum(["not_requested", "missing", "truncated"]),
    reason: z.string().min(1).nullable(),
  }),
]);

/** Selected page of one browser scenario capture. */
export const browserScenarioViewPageSchema = z.discriminatedUnion(
  "collection",
  [
    z.strictObject({
      collection: z.literal("steps"),
      items: z.array(browserScenarioStepRowSchema),
    }),
    z.strictObject({
      collection: z.literal("text"),
      step_index: z.number().int().nonnegative(),
      step_id: z.string().min(1),
      artifact: z.enum(["accessibility", "dom"]),
      item: textItemSchema,
    }),
  ],
);

/** Capture facts every page needs to read its rows, independent of the selected page. */
export const browserScenarioViewContextSchema = z.strictObject({
  source_completeness: z.enum(["complete", "incomplete", "truncated"]),
  enabled_event_families: z
    .array(browserScenarioEventFamilySchema)
    .describe(
      "Event families observed for every step; other families were not observed.",
    ),
  received_outside_step_windows: receivedEventsSchema.describe(
    "Retained events received between step windows or after the final capture; they appear on no step row.",
  ),
});

/** Run-level capture facts and step tallies; step rows and text stay retained. */
export const browserScenarioSummarySchema = z.strictObject({
  browser: browserScenarioCaptureSchema.shape.browser,
  start_origin: z.string().min(1),
  action_count: z.number().int().positive(),
  duration_ms: z.number().int().nonnegative(),
  step_statuses: z.strictObject({
    completed: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    cancelled: z.number().int().nonnegative(),
  }),
  artifact_coverage: z
    .array(
      z.strictObject({
        artifact: stateArtifactSchema,
        captured: z.number().int().nonnegative(),
        not_requested: z.number().int().nonnegative(),
        missing: z.number().int().nonnegative(),
        truncated: z.number().int().nonnegative(),
      }),
    )
    .describe("Per-artifact capture states across all steps."),
  step_changes: z
    .array(
      z.strictObject({
        artifact: stateArtifactSchema,
        changed: z.number().int().nonnegative(),
        unchanged: z.number().int().nonnegative(),
        unknown: z.number().int().nonnegative(),
        not_compared: z.number().int().nonnegative(),
      }),
    )
    .describe(
      "Per-artifact comparisons of each step with the previous step's capture.",
    ),
  events: z.strictObject({
    declared_families: z.array(browserScenarioEventFamilySchema),
    enabled_families: z
      .array(browserScenarioEventFamilySchema)
      .describe(
        "Declared families plus network when network content was selected.",
      ),
    retained: z.number().int().nonnegative(),
    dropped: z.number().int().nonnegative(),
    received_outside_step_windows: receivedEventsSchema.describe(
      "Retained events received between step windows or after the final capture.",
    ),
  }),
  network_transactions: networkTransactionsSchema.extend({
    without_retained_request: z
      .number()
      .int()
      .nonnegative()
      .nullable()
      .describe(
        "Retained transactions whose request event was dropped or never observed; included in retained but in no step row. Null when network was not observed.",
      ),
    omitted_by_transaction_limit: z
      .number()
      .int()
      .nonnegative()
      .describe(
        "Transactions dropped whole once max_network_transactions was reached; not included in retained.",
      ),
  }),
  completeness: browserScenarioCompletenessSchema,
  limitation_count: z.number().int().nonnegative(),
});
