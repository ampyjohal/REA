import { z } from "zod";
import type { AnalysisError } from "../analysisErrorBase.js";
import type { BrowserScenarioCapture } from "../browserScenarioCapture.js";
import { BROWSER_SCENARIO_STATE_ARTIFACTS } from "../browserScenarioDiffEvidence.js";
import {
  browserScenarioActionClass,
  type BrowserScenarioActionClass,
} from "../browserScenarioSteps.js";
import {
  browserScenarioSnapshotKindSchema,
  requestedScenarioArtifacts,
} from "../browserScenarioValues.js";
import { browserNetworkContentSelectionValuesSchema } from "../browserNetworkEvidence.js";
import { capturedScenarioFields } from "../browserScenarioCaptureFields.js";
import { browserScenarioCaptureLimitsValuesSchema } from "../browserScenarioCaptureLimits.js";
import { browserScenarioEventFamilySchema } from "../browserScenarioCaptureValues.js";
import { digestCanonicalValue } from "../canonicalDigest.js";
import { jsonObjectSchema } from "../jsonValue.js";
import { err, ok, type Result } from "../result.js";
import type { AnalysisViewParent } from "./analysisView.js";
import { analysisViewInputError } from "./analysisViewErrors.js";

const recordedActionSchema = z.looseObject({
  step_id: z.string().min(1),
  action: z.string().min(1),
});
const recordedParametersSchema = z.looseObject({
  actions: z.array(z.unknown()),
});

/**
 * Bind each action step to the exact declaration recorded in the parent
 * parameters. The Evidence ID authenticates the parameters; only identity
 * fields are checked, so historical declarations are never re-defaulted.
 */
export interface RecordedAction {
  readonly declaration: z.output<typeof jsonObjectSchema>;
  readonly actionClass: BrowserScenarioActionClass;
}

export const recordedActions = (
  parent: AnalysisViewParent,
  capture: BrowserScenarioCapture,
): Result<readonly RecordedAction[], AnalysisError> => {
  const mismatch = (path: readonly (string | number)[], message: string) =>
    err(
      analysisViewInputError([
        {
          path: ["source", "parameters", ...path],
          reason: "invalid_value",
          message,
        },
      ]),
    );
  const parameters = recordedParametersSchema.safeParse(parent.parameters);
  if (!parameters.success)
    return mismatch(
      ["actions"],
      "Browser scenario Evidence parameters must record the declared actions.",
    );
  const { actions } = parameters.data;
  if (actions.length !== capture.steps.length - 1)
    return mismatch(
      ["actions"],
      "Recorded actions must match the capture's action steps one to one.",
    );
  const recorded: RecordedAction[] = [];
  for (const [index, raw] of actions.entries()) {
    const step = capture.steps[index + 1];
    const identity = recordedActionSchema.safeParse(raw);
    const declaration = jsonObjectSchema.safeParse(raw);
    const actionClass =
      step === undefined ? undefined : browserScenarioActionClass(step.action);
    if (
      step === undefined ||
      actionClass === undefined ||
      !identity.success ||
      !declaration.success ||
      identity.data.step_id !== step.step_id ||
      identity.data.action !== step.action
    )
      return mismatch(
        ["actions", index],
        `Recorded action ${String(index)} must declare a known action with the step_id and action of capture step ${String(index + 1)}.`,
      );
    recorded.push({ declaration: declaration.data, actionClass });
  }
  return ok(recorded);
};

const recordedScenarioSchema = z.looseObject({
  browser: z.looseObject({ mode: z.enum(["launch", "connect"]) }),
  start_url: z.looseObject({ url: z.string().refine(URL.canParse) }),
  actions: z.array(z.unknown()),
  secrets: z.array(z.looseObject({ secret_id: z.string() })),
  capture: z.looseObject({
    after_each_step: z.array(browserScenarioSnapshotKindSchema),
    at_end: z.array(browserScenarioSnapshotKindSchema),
    events: z.array(browserScenarioEventFamilySchema),
    network: browserNetworkContentSelectionValuesSchema,
    limits: browserScenarioCaptureLimitsValuesSchema,
  }),
});

const scenarioFields = [
  "start_origin",
  "action_count",
  "secret_references",
  "network_content",
  "event_families",
  "limits",
] as const satisfies readonly (keyof BrowserScenarioCapture["scenario"])[];

const sameValue = (left: unknown, right: unknown): boolean =>
  digestCanonicalValue(left, "Browser scenario field") ===
  digestCanonicalValue(right, "Browser scenario field");

/**
 * The capture restates its scenario from the declaration recorded in the
 * parent parameters but records no artifact selection. Bind both: the browser
 * mode and scenario fields equal the declaration's projection, and each step
 * records exactly the artifacts the declaration requested there.
 */
export const checkRecordedScenario = (
  parent: AnalysisViewParent,
  capture: BrowserScenarioCapture,
): Result<void, AnalysisError> => {
  const issue = (path: readonly (string | number)[], message: string) =>
    err(
      analysisViewInputError([
        { path: ["source", ...path], reason: "invalid_value", message },
      ]),
    );
  const parameters = recordedScenarioSchema.safeParse(parent.parameters);
  if (!parameters.success)
    return issue(
      [
        "parameters",
        ...(parameters.error.issues[0]?.path ?? []).filter(
          (key): key is string | number => typeof key !== "symbol",
        ),
      ],
      "Browser scenario Evidence parameters must record the declared browser, start URL, secrets and capture selection.",
    );
  const declared = parameters.data;
  if (capture.browser.mode !== declared.browser.mode)
    return issue(
      ["normalized_result", "browser", "mode"],
      `The capture records ${capture.browser.mode} mode, but the recorded scenario declared ${declared.browser.mode}.`,
    );
  const expected = capturedScenarioFields(declared);
  for (const field of scenarioFields)
    if (!sameValue(capture.scenario[field], expected[field]))
      return issue(
        ["normalized_result", "scenario", field],
        `The capture's scenario ${field} does not restate the recorded scenario declaration.`,
      );
  const actionCount = capture.steps.length - 1;
  for (const [index, step] of capture.steps.entries()) {
    const requested = requestedScenarioArtifacts(
      declared.capture,
      index,
      actionCount,
    );
    for (const artifact of BROWSER_SCENARIO_STATE_ARTIFACTS) {
      const recorded = step.artifacts[artifact].state !== "not_requested";
      if (recorded !== requested.has(artifact))
        return issue(
          ["normalized_result", "steps", index, "artifacts", artifact],
          recorded
            ? `Step ${String(index)} records ${artifact}, which the recorded scenario did not request there.`
            : `The recorded scenario requested ${artifact} at step ${String(index)}, but the step records it as not requested.`,
        );
    }
  }
  return ok(undefined);
};
