import { expect, it } from "vitest";
import { WebRuntimeService } from "./WebRuntimeService.js";
import {
  recordingWebRuntimePort,
  webExecutionFixture,
  webListenersFixture,
} from "./WebRuntimeService.fixture.js";
import { err, ok } from "../domain/result.js";
import {
  AnalysisCancelledError,
  AnalysisOutputError,
  AnalysisTimeoutError,
} from "../domain/analysisErrorCore.js";
import { ProviderCleanupError } from "../domain/providerCleanupError.js";
import { parseEvidence } from "../domain/evidence.js";

it("rejects malformed input and prior cancellation without calling a provider", async () => {
  const provider = recordingWebRuntimePort();
  const service = new WebRuntimeService({
    identity: () => provider.identity(),
    observeExecution: () => {
      throw new Error("Provider must not be called");
    },
    inspectEventListeners: () => {
      throw new Error("Provider must not be called");
    },
  });
  const malformed = await service.observe({
    cdp_endpoint: "https://remote.example",
    target_id: "page",
  });
  if (malformed.ok)
    throw new Error("Invalid endpoint must fail before execution");
  expect(malformed.error._tag).toBe("AnalysisInputError");
  const reason = { requested: "stop before provider admission" };
  const cancelled = await service.inspect(
    {},
    { signal: AbortSignal.abort(reason) },
  );
  if (cancelled.ok)
    throw new Error("Prior cancellation must fail before inspection");
  expect(cancelled.error._tag).toBe("AnalysisCancelledError");
  expect(cancelled.error.cause).toBe(reason);
});

it("preserves actual provider failures and rejects changed target/selector identities", async () => {
  const provider = recordingWebRuntimePort();
  const args = {
    cdp_endpoint: "http://127.0.0.1:9222",
    target_id: "selected-page",
    selector: "#selected",
  };
  const captured = webListenersFixture();
  const timeout = new AnalysisTimeoutError("observe_web_execution", 20_000);
  const service = new WebRuntimeService({
    identity: () => provider.identity(),
    observeExecution: async () => err(timeout),
    inspectEventListeners: async () =>
      ok({
        ...captured,
        selected_node: { ...captured.selected_node, selector: "#different" },
      }),
  });
  const failed = await service.observe({
    cdp_endpoint: args.cdp_endpoint,
    target_id: args.target_id,
    observation_ms: 5,
  });
  expect(failed).toEqual(err(timeout));
  const changed = await service.inspect(args);
  if (changed.ok) throw new Error("Changed selection must be rejected");
  expect(changed.error._tag).toBe("AnalysisOutputError");
});

it("converts raw execution retained by provider cleanup failure into partial Evidence", async () => {
  const args = {
    cdp_endpoint: "http://127.0.0.1:9222",
    target_id: "selected-page",
    observation_ms: 5,
  };
  const execution = webExecutionFixture(args.target_id, args.observation_ms);
  const failure = new ProviderCleanupError(
    "rea-cdp-browser",
    ["selected-page"],
    { reason: "target detach failed" },
    { operation: "observe_web_execution", partialObservation: execution },
  );
  const result = await new WebRuntimeService({
    identity: () => ({
      id: "web-runtime",
      name: "Runtime fixture",
      version: "1",
    }),
    observeExecution: async () => err(failure),
    inspectEventListeners: async () => err(failure),
  }).observe(args);
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.error).toBe(failure);
    expect(result.error.cleanupIncomplete).toBe(true);
    expect(parseEvidence(result.error.partialObservation)).toMatchObject({
      operation: "observe_web_execution",
      normalized_result: execution,
    });
  }
});

it.each([
  {
    method: "observe" as const,
    operation: "observe_web_execution",
    partial: { instrumentation: {}, window: {} },
  },
  {
    method: "inspect" as const,
    operation: "inspect_web_event_listeners",
    partial: { selected_node: {}, listeners: [] },
  },
])(
  "preserves cancellation with malformed $method observations",
  async ({ method, operation, partial }) => {
    const reason = { requested: `stop ${method}` };
    const failure = new AnalysisCancelledError(operation, {
      cause: reason,
      partialObservation: partial as never,
    });
    const port = recordingWebRuntimePort();
    const service = new WebRuntimeService({
      identity: () => port.identity(),
      observeExecution: async () => err(failure),
      inspectEventListeners: async () => err(failure),
    });
    const input =
      method === "observe"
        ? {
            cdp_endpoint: "http://127.0.0.1:9222",
            target_id: "selected-page",
            observation_ms: 5,
          }
        : {
            cdp_endpoint: "http://127.0.0.1:9222",
            target_id: "selected-page",
            selector: "#selected",
          };

    const result =
      method === "observe"
        ? await service.observe(input)
        : await service.inspect(input);

    expect(result).toEqual(err(failure));
    expect(failure.cause).toBe(reason);
    expect(failure.partialObservation).toBe(partial);
  },
);

it("retains completed execution Evidence on late abort and keeps invalid output primary", async () => {
  const input = {
    cdp_endpoint: "http://127.0.0.1:9222",
    target_id: "selected-page",
    observation_ms: 5,
  };
  const unused = new AnalysisTimeoutError(
    "inspect_web_event_listeners",
    20_000,
  );
  const controller = new AbortController();
  const cancellationReason = new Error(
    "caller cancelled the runtime observation",
  );
  const completed = await new WebRuntimeService({
    identity: () => ({
      id: "web-runtime",
      name: "Runtime fixture",
      version: "1",
    }),
    observeExecution: async () => {
      controller.abort(cancellationReason);
      return ok(webExecutionFixture(input.target_id, input.observation_ms));
    },
    inspectEventListeners: async () => err(unused),
  }).observe(input, { signal: controller.signal });
  if (completed.ok) throw new Error("Expected late cancellation");
  expect(completed.error._tag).toBe("AnalysisCancelledError");
  expect(completed.error.cause).toBe(cancellationReason);
  expect(parseEvidence(completed.error.partialObservation)).toMatchObject({
    operation: "observe_web_execution",
    normalized_result: webExecutionFixture(
      input.target_id,
      input.observation_ms,
    ),
  });

  const late = new AbortController();
  const invalid = await new WebRuntimeService({
    identity: () => ({
      id: "web-runtime",
      name: "Runtime fixture",
      version: "1",
    }),
    observeExecution: async () => {
      late.abort();
      return ok(webExecutionFixture(input.target_id, input.observation_ms));
    },
    inspectEventListeners: async () => err(unused),
  }).observe(
    { ...input, allowed_origins: ["https://allowed.example"] },
    { signal: late.signal },
  );
  expect(invalid).toMatchObject({
    ok: false,
    error: { _tag: "AnalysisOutputError" },
  });
  if (!invalid.ok) expect(invalid.error).toBeInstanceOf(AnalysisOutputError);
});
