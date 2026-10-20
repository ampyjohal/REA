import { getEventListeners } from "node:events";
import { expect, it, onTestFinished } from "vitest";

import { CdpBrowserProvider } from "../../../src/browser/CdpBrowserProvider.js";
import { observeWebSessionInputSchema } from "../../../src/domain/browserSession.js";
import { startFakeCdpBrowser } from "../../fixtures/fakeCdpBrowser.js";

it.each(
  [false, true].flatMap((directPage) =>
    ["Page.setLifecycleEventsEnabled", "Page.getFrameTree"].map((delivery) => ({
      directPage,
      delivery,
    })),
  ),
)(
  "excludes historical lifecycle replay and retains the initial loader's new milestones: $directPage/$delivery",
  async ({ directPage, delivery }) => {
    let reads = 0;
    const browser = await startFakeCdpBrowser({
      ...(directPage
        ? { pageScopedVersionWebSocket: true, omitTargetWebSocket: true }
        : {}),
      eventsBeforeReply: [
        "Page.setLifecycleEventsEnabled",
        "Page.getFrameTree",
      ],
      commandResult: ({ method }) =>
        method === "Performance.getMetrics"
          ? { metrics: [{ name: "Timestamp", value: 100 }] }
          : undefined,
      commandEvents: ({ method, sessionId }) => {
        if (method === "Page.getFrameTree") reads += 1;
        if (
          method !== delivery ||
          (delivery === "Page.getFrameTree" && reads < 2)
        )
          return undefined;
        return [99, 100, 101].map((timestamp) => ({
          method: "Page.lifecycleEvent",
          ...(sessionId === undefined ? {} : { sessionId }),
          params: {
            frameId: "frame-main",
            loaderId: "loader-main",
            name: "load",
            timestamp,
          },
        }));
      },
    });
    const provider = new CdpBrowserProvider();
    onTestFinished(async () => {
      await provider.close();
      await browser.close();
    });
    const result = await provider.observeSession(
      observeWebSessionInputSchema.parse({
        cdp_endpoint: browser.endpoint,
        allowed_origins: [browser.allowedOrigin],
        target_id: "allowed-page",
        observation_ms: 1,
      }),
    );
    if (!result.ok) throw result.error;
    expect(result.value.timeline.map(({ timestamp }) => timestamp)).toEqual([
      100, 101,
    ]);
    expect(result.value.timeline.map(({ sequence }) => sequence)).toEqual([
      1, 2,
    ]);
    expect(
      result.value.timeline.every(
        ({ loader_id }) => loader_id === "loader-main",
      ),
    ).toBe(true);
    expect(result.value.completeness.excluded).toEqual([]);
    expect(result.value.window.end_reason).toBe("window_elapsed");
    await expect.poll(() => browser.activeConnectionCount()).toBe(0);
  },
);

it("marks lifecycle events with unknown time incomplete without discarding valid activity", async () => {
  const browser = await startFakeCdpBrowser({
    eventsBeforeReply: ["Page.setLifecycleEventsEnabled"],
    commandEvents: ({ method, sessionId }, origin) =>
      method === "Page.setLifecycleEventsEnabled"
        ? [
            ...[undefined, null, "100", -1].map((timestamp) => ({
              method: "Page.lifecycleEvent",
              ...(sessionId === undefined ? {} : { sessionId }),
              params: {
                frameId: "frame-main",
                loaderId: "loader-main",
                name: "load",
                timestamp,
              },
            })),
            {
              method: "Page.lifecycleEvent",
              ...(sessionId === undefined ? {} : { sessionId }),
              params: { frameId: "foreign-frame", name: "load" },
            },
            {
              method: "Page.lifecycleEvent",
              sessionId: "foreign-session",
              params: { frameId: "frame-main", name: "load" },
            },
            {
              method: "Page.lifecycleEvent",
              ...(sessionId === undefined ? {} : { sessionId }),
              params: {
                frameId: "frame-main",
                loaderId: "loader-new",
                name: "load",
                timestamp: 101,
              },
            },
            {
              method: "Page.navigatedWithinDocument",
              ...(sessionId === undefined ? {} : { sessionId }),
              params: { frameId: "frame-main", url: `${origin}/history` },
            },
          ]
        : undefined,
  });
  const provider = new CdpBrowserProvider();
  onTestFinished(async () => {
    await provider.close();
    await browser.close();
  });
  const result = await provider.observeSession(
    observeWebSessionInputSchema.parse({
      cdp_endpoint: browser.endpoint,
      allowed_origins: [browser.allowedOrigin],
      target_id: "allowed-page",
      observation_ms: 1,
    }),
  );
  if (!result.ok) throw result.error;
  expect(result.value.timeline.map(({ type }) => type)).toEqual([
    "lifecycle",
    "same_document_navigation",
  ]);
  expect(result.value.timeline[0]).toMatchObject({
    timestamp: 101,
    loader_id: "loader-new",
  });
  expect(result.value.completeness.excluded).toEqual([
    { section: "timeline", reason: "invalid_protocol_value", count: 4 },
  ]);
  await expect.poll(() => browser.activeConnectionCount()).toBe(0);
});

it.each([
  {},
  { metrics: [] },
  { metrics: [{ name: "NavigationStart", value: 100 }] },
  { metrics: [{ name: "Timestamp", value: "100" }] },
  { metrics: [{ name: "Timestamp", value: null }] },
  { metrics: [{ name: "Timestamp", value: -1 }] },
  {
    metrics: [
      { name: "Timestamp", value: 100 },
      { name: "Timestamp", value: 101 },
    ],
  },
])("refuses to arm without one valid browser clock: %j", async (metrics) => {
  const browser = await startFakeCdpBrowser({
    commandResult: ({ method }) =>
      method === "Performance.getMetrics" ? metrics : undefined,
  });
  const provider = new CdpBrowserProvider();
  onTestFinished(async () => {
    await provider.close();
    await browser.close();
  });
  let armed = false;
  const result = await provider.observeSession(
    observeWebSessionInputSchema.parse({
      cdp_endpoint: browser.endpoint,
      allowed_origins: [browser.allowedOrigin],
      target_id: "allowed-page",
      observation_ms: 1,
    }),
    {
      progress: {
        async report(update) {
          if (update.completed === 1) armed = true;
        },
      },
    },
  );
  expect(result).toMatchObject({
    ok: false,
    error: {
      _tag: "BrowserObservationError",
      operation: "observe_web_session",
      reason: "protocol_error",
    },
  });
  expect(armed).toBe(false);
  const methods = browser.commands.map(({ method }) => method);
  expect(methods).toContain("Performance.disable");
  expect(methods).not.toContain("Page.setLifecycleEventsEnabled");
  expect(methods).toContain("Target.detachFromTarget");
  await expect.poll(() => browser.activeConnectionCount()).toBe(0);
});

it.each([
  "Performance.enable",
  "Performance.getMetrics",
  "Performance.disable",
])("closes the owned connection when %s fails", async (method) => {
  const browser = await startFakeCdpBrowser({ unsupportedMethods: [method] });
  const provider = new CdpBrowserProvider();
  onTestFinished(async () => {
    await provider.close();
    await browser.close();
  });
  const result = await provider.observeSession(
    observeWebSessionInputSchema.parse({
      cdp_endpoint: browser.endpoint,
      allowed_origins: [browser.allowedOrigin],
      target_id: "allowed-page",
      observation_ms: 1,
    }),
  );
  expect(result).toMatchObject({
    ok: false,
    error: {
      _tag: "BrowserObservationError",
      operation: "observe_web_session",
      reason: "protocol_error",
    },
  });
  expect(browser.commands.map(({ method }) => method)).not.toContain(
    "Page.setLifecycleEventsEnabled",
  );
  await expect.poll(() => browser.activeConnectionCount()).toBe(0);
});

it.each([
  "Performance.enable",
  "Performance.getMetrics",
  "Performance.disable",
])(
  "preserves cancellation and releases the session while %s is pending",
  async (method) => {
    const browser = await startFakeCdpBrowser({ hangOnMethod: method });
    const provider = new CdpBrowserProvider();
    const controller = new AbortController();
    onTestFinished(async () => {
      controller.abort();
      await provider.close();
      await browser.close();
    });
    const reason = { stop: method };
    const pending = provider.observeSession(
      observeWebSessionInputSchema.parse({
        cdp_endpoint: browser.endpoint,
        allowed_origins: [browser.allowedOrigin],
        target_id: "allowed-page",
        observation_ms: 1,
      }),
      { signal: controller.signal },
    );
    await expect
      .poll(() => browser.commands.some((command) => command.method === method))
      .toBe(true);
    controller.abort(reason);
    const result = await pending;
    expect(result).toMatchObject({
      ok: false,
      error: {
        _tag: "AnalysisCancelledError",
        operation: "observe_web_session",
      },
    });
    if (result.ok) throw new Error("Expected cancellation");
    expect(result.error.cause).toBe(reason);
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
    expect(browser.commands.map(({ method }) => method)).toContain(
      "Target.detachFromTarget",
    );
    await expect.poll(() => browser.activeConnectionCount()).toBe(0);
  },
);

it.each(
  [
    "Performance.enable",
    "Performance.getMetrics",
    "Performance.disable",
  ].flatMap((method) =>
    ["scope", "terminated"].map((ending) => ({ method, ending })),
  ),
)(
  "keeps target protection active during $method: $ending",
  async ({ method, ending }) => {
    const browser = await startFakeCdpBrowser({
      eventsBeforeReply: [method, "Page.setLifecycleEventsEnabled"],
      commandEvents: (command) =>
        command.method === method
          ? [
              {
                method:
                  ending === "scope"
                    ? "Page.frameNavigated"
                    : "Inspector.targetCrashed",
                ...(command.sessionId === undefined
                  ? {}
                  : { sessionId: command.sessionId }),
                params:
                  ending === "scope"
                    ? {
                        frame: {
                          id: "frame-main",
                          url: "https://outside.test/private",
                        },
                      }
                    : {},
              },
            ]
          : command.method === "Page.setLifecycleEventsEnabled"
            ? [
                {
                  method: "Page.lifecycleEvent",
                  ...(command.sessionId === undefined
                    ? {}
                    : { sessionId: command.sessionId }),
                  params: {
                    frameId: "frame-main",
                    loaderId: "loader-main",
                    name: "load",
                    timestamp: 101,
                  },
                },
              ]
            : undefined,
    });
    const provider = new CdpBrowserProvider();
    const controller = new AbortController();
    onTestFinished(async () => {
      controller.abort();
      await provider.close();
      await browser.close();
    });
    const result = await provider.observeSession(
      observeWebSessionInputSchema.parse({
        cdp_endpoint: browser.endpoint,
        allowed_origins: [browser.allowedOrigin],
        target_id: "allowed-page",
        observation_ms: 3_000_000_000,
      }),
      { signal: controller.signal },
    );
    if (!result.ok) throw result.error;
    expect(result.value.window.end_reason).toBe(
      ending === "scope" ? "target_left_scope" : "target_terminated",
    );
    expect(result.value.timeline).toHaveLength(1);
    if (ending === "scope") {
      expect(result.value.target.final_url).toBeNull();
      expect(JSON.stringify(result.value)).not.toContain("outside.test");
    }
    await expect.poll(() => browser.activeConnectionCount()).toBe(0);
  },
);
