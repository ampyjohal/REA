import { crc32 } from "node:zlib";
import { describe, expect, it, onTestFinished } from "vitest";
import { CdpBrowserProvider } from "../../../src/browser/CdpBrowserProvider.js";
import { captureWebScreenshotInputSchema } from "../../../src/domain/webScreenshot.js";
import { startFakeCdpBrowser } from "../../fixtures/fakeCdpBrowser.js";
describe("screenshot committed document identity", () => {
  it.each(["requested-only", "same-url-history"])(
    "accepts unchanged identity after %s",
    async (kind) => {
      const browser = await startFakeCdpBrowser({
        commandEvents: ({ method, sessionId }, origin) =>
          method !== "Page.captureScreenshot"
            ? undefined
            : [
                {
                  method:
                    kind === "requested-only"
                      ? "Page.frameRequestedNavigation"
                      : "Page.navigatedWithinDocument",
                  ...(sessionId === undefined ? {} : { sessionId }),
                  params: {
                    frameId: "frame-main",
                    url: `${origin}${kind === "requested-only" ? "/pending" : "/app?token=frame-secret"}`,
                    reason: "scriptInitiated",
                    disposition: "currentTab",
                    navigationType: "historyApi",
                  },
                },
              ],
      });
      onTestFinished(async () => browser.close());
      const result = await new CdpBrowserProvider().captureScreenshot(
        captureWebScreenshotInputSchema.parse({
          cdp_endpoint: browser.endpoint,
          allowed_origins: [browser.allowedOrigin],
          target_id: "allowed-page",
        }),
      );
      expect(result.ok).toBe(true);
    },
  );

  it.each([24, 32, "crc"])(
    "rejects incomplete or corrupt PNG IHDR: %s",
    async (kind) => {
      const png = Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jv4sAAAAASUVORK5CYII=",
        "base64",
      );
      if (kind === "crc") png[29] = (png[29] ?? 0) ^ 1;
      const bytes = typeof kind === "number" ? png.subarray(0, kind) : png;
      const browser = await startFakeCdpBrowser({
        commandResult: ({ method }) =>
          method === "Page.captureScreenshot"
            ? { data: bytes.toString("base64") }
            : undefined,
      });
      onTestFinished(async () => browser.close());
      const result = await new CdpBrowserProvider().captureScreenshot(
        captureWebScreenshotInputSchema.parse({
          cdp_endpoint: browser.endpoint,
          allowed_origins: [browser.allowedOrigin],
          target_id: "allowed-page",
        }),
      );
      expect(result).toMatchObject({
        ok: false,
        error: { reason: "protocol_error" },
      });
    },
  );
  it.each([
    ["missing screenshot data", {}],
    ["invalid base64 screenshot data", { data: "not base64%%%" }],
  ])("reports %s as a protocol error", async (_label, result) => {
    const browser = await startFakeCdpBrowser({
      commandResult: ({ method }) =>
        method === "Page.captureScreenshot" ? result : undefined,
    });
    onTestFinished(async () => {
      await browser.close();
    });
    const observation = await new CdpBrowserProvider().captureScreenshot(
      captureWebScreenshotInputSchema.parse({
        cdp_endpoint: browser.endpoint,
        allowed_origins: [browser.allowedOrigin],
        target_id: "allowed-page",
      }),
    );
    expect(observation).toMatchObject({
      ok: false,
      error: { reason: "protocol_error" },
    });
  });

  it.each([
    { offset: 8, value: 14 },
    { offset: 16, value: 0x8000_0000 },
    { offset: 20, value: 0x8000_0000 },
  ])("rejects invalid screenshot IHDR metadata", async ({ offset, value }) => {
    const bytes = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jv4sAAAAASUVORK5CYII=",
      "base64",
    );
    bytes.writeUInt32BE(value, offset);
    bytes.writeUInt32BE(crc32(bytes.subarray(12, 29)), 29);
    const browser = await startFakeCdpBrowser({
      commandResult: ({ method }) =>
        method === "Page.captureScreenshot"
          ? { data: bytes.toString("base64") }
          : undefined,
    });
    onTestFinished(async () => {
      await browser.close();
    });
    const result = await new CdpBrowserProvider().captureScreenshot(
      captureWebScreenshotInputSchema.parse({
        cdp_endpoint: browser.endpoint,
        allowed_origins: [browser.allowedOrigin],
        target_id: "allowed-page",
      }),
    );
    expect(result).toMatchObject({
      ok: false,
      error: { reason: "protocol_error" },
    });
  });
  it.each(["loader-main", "loader-reloaded"])(
    "distinguishes %s for the same URL",
    async (screenshotDocumentLoader) => {
      const browser = await startFakeCdpBrowser({ screenshotDocumentLoader });
      onTestFinished(async () => {
        await browser.close();
      });
      const result = await new CdpBrowserProvider().captureScreenshot(
        captureWebScreenshotInputSchema.parse({
          cdp_endpoint: browser.endpoint,
          allowed_origins: [browser.allowedOrigin],
          target_id: "allowed-page",
        }),
      );
      if (screenshotDocumentLoader === "loader-main")
        expect(result.ok).toBe(true);
      else
        expect(result).toMatchObject({
          ok: false,
          error: { reason: "target_changed" },
        });
    },
  );
});

it.each(
  [7, "missing-hash"].flatMap((fragment) =>
    ["initial", "event", "final"].flatMap((phase) =>
      ["allowed", "foreign", "missing"].map((scope) => ({
        fragment,
        phase,
        scope,
      })),
    ),
  ),
)(
  "keeps malformed screenshot fragments distinct from scope exits: $phase/$scope/$fragment",
  async ({ fragment, phase, scope }) => {
    const browser = await startFakeCdpBrowser({
      commandResult: ({ method }, origin, reads) =>
        method === "Page.getFrameTree" &&
        (phase === "initial" || (phase === "final" && reads > 1))
          ? {
              frameTree: {
                frame: {
                  id: "frame-main",
                  loaderId: "loader-main",
                  ...(scope === "missing"
                    ? {}
                    : {
                        url:
                          scope === "foreign"
                            ? "https://foreign.test/"
                            : `${origin}/app?token=frame-secret`,
                      }),
                  urlFragment: fragment,
                },
              },
            }
          : undefined,
      commandEvents: ({ method, sessionId }, origin) =>
        phase === "event" && method === "Page.captureScreenshot"
          ? [
              {
                method: "Page.frameNavigated",
                ...(sessionId === undefined ? {} : { sessionId }),
                params: {
                  frame: {
                    id: "frame-main",
                    loaderId: "loader-main",
                    ...(scope === "missing"
                      ? {}
                      : {
                          url:
                            scope === "foreign"
                              ? "https://foreign.test/"
                              : `${origin}/app?token=frame-secret`,
                        }),
                    urlFragment: fragment,
                  },
                },
              },
            ]
          : undefined,
    });
    onTestFinished(async () => browser.close());
    const result = await new CdpBrowserProvider().captureScreenshot(
      captureWebScreenshotInputSchema.parse({
        cdp_endpoint: browser.endpoint,
        allowed_origins: [browser.allowedOrigin],
        target_id: "allowed-page",
      }),
    );
    expect(result).toMatchObject({
      ok: false,
      error: {
        reason: scope === "foreign" ? "target_not_allowed" : "protocol_error",
      },
    });
  },
);

it("retains a foreign base scope even when its fragment is malformed", async () => {
  const browser = await startFakeCdpBrowser({
    commandEvents: ({ method, sessionId }) =>
      method === "Page.captureScreenshot"
        ? [
            {
              method: "Page.frameNavigated",
              ...(sessionId === undefined ? {} : { sessionId }),
              params: {
                frame: {
                  id: "frame-main",
                  loaderId: "foreign",
                  url: "https://foreign.test/",
                  urlFragment: 7,
                },
              },
            },
          ]
        : undefined,
  });
  onTestFinished(async () => browser.close());
  const result = await new CdpBrowserProvider().captureScreenshot(
    captureWebScreenshotInputSchema.parse({
      cdp_endpoint: browser.endpoint,
      allowed_origins: [browser.allowedOrigin],
      target_id: "allowed-page",
    }),
  );
  expect(result).toMatchObject({
    ok: false,
    error: { reason: "target_not_allowed" },
  });
});
