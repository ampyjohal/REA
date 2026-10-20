import { z } from "zod";
import { browserNetworkContentSelectionValuesSchema } from "./browserNetworkEvidence.js";
import { browserScenarioCaptureLimitsValuesSchema } from "./browserScenarioCaptureLimits.js";
import {
  browserScenarioCompletenessSchema,
  browserScenarioEventFamilySchema,
  browserScenarioEventOmissionsSchema,
  browserScenarioEventSchema,
  browserScenarioStepSchema,
} from "./browserScenarioCaptureValues.js";

/** The fields of one browser scenario capture, before cross-field rules. */
export const capturedFieldsSchema = z.strictObject({
  browser: z.strictObject({
    mode: z.enum(["launch", "connect"]),
    process_ownership: z.enum(["provider-owned", "external"]),
    cleanup: z.enum(["terminated-owned-process", "disconnected-external"]),
    product: z.string().min(1),
    version: z.string().min(1),
  }),
  scenario: z.strictObject({
    start_origin: z.string().min(1),
    action_count: z.number().int().min(1),
    secret_references: z.array(z.string().min(1)),
    network_content: browserNetworkContentSelectionValuesSchema,
    event_families: z.array(browserScenarioEventFamilySchema),
    limits: browserScenarioCaptureLimitsValuesSchema,
  }),
  duration_ms: z.number().int().min(0),
  steps: z.array(browserScenarioStepSchema).min(1),
  events: z.strictObject({
    retained: z.number().int().min(0),
    dropped: z.number().int().min(0),
    items: z.array(browserScenarioEventSchema),
    omissions: browserScenarioEventOmissionsSchema,
  }),
  completeness: browserScenarioCompletenessSchema,
  limitations: z.array(z.string().min(1)),
});
export type CapturedFields = z.infer<typeof capturedFieldsSchema>;

/** The declared scenario parts that the capture's scenario fields restate. */
export interface CapturedScenarioDeclaration {
  readonly start_url: { readonly url: string };
  readonly actions: readonly unknown[];
  readonly secrets: readonly { readonly secret_id: string }[];
  readonly capture: {
    readonly network: CapturedFields["scenario"]["network_content"];
    readonly events: readonly CapturedFields["scenario"]["event_families"][number][];
    readonly limits: CapturedFields["scenario"]["limits"];
  };
}

/** Project a declared scenario into the capture's scenario fields. */
export const capturedScenarioFields = (
  declaration: CapturedScenarioDeclaration,
): CapturedFields["scenario"] => ({
  start_origin: new URL(declaration.start_url.url).origin,
  action_count: declaration.actions.length,
  secret_references: declaration.secrets.map(({ secret_id: id }) => id).sort(),
  network_content: declaration.capture.network,
  event_families: [...new Set(declaration.capture.events)].sort(),
  limits: declaration.capture.limits,
});
