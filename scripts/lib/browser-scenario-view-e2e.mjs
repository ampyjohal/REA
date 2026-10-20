import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

import { toolContract } from "../../dist/contracts/toolContracts.js";
import { browserScenarioSchema } from "../../dist/domain/browserScenario.js";
import { mcpTextValue } from "./mcp-verifier-results.mjs";
import { closeVerifierResources } from "./verifier-cleanup.mjs";

const execute = promisify(execFile);

const APP_PAGE = `<!doctype html><html><head><title>REA transitions</title></head><body><main><h1>Settings demo</h1><button id="open">Open settings</button><a href="/details">Details</a><div id="dialog-root"></div></main><script>
const root = document.getElementById("dialog-root");
document.getElementById("open").addEventListener("click", () => {
  root.innerHTML = '<div role="dialog" aria-label="Settings"><p>Preferences</p><button id="close">Close settings</button></div>';
  document.getElementById("close").addEventListener("click", () => { root.innerHTML = ""; });
  fetch("/api/opened", { method: "POST" });
});
</script></body></html>`;
const DETAILS_PAGE =
  '<!doctype html><html><head><title>Details</title></head><body><main><h1 id="details">Details</h1><p>Static details page.</p></main></body></html>';

/** Serve the self-owned transition fixture on loopback. */
const startTransitionSite = async () => {
  const server = createServer((request, response) => {
    if (request.url === "/app" || request.url === "/details") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(request.url === "/app" ? APP_PAGE : DETAILS_PAGE);
      return;
    }
    if (request.url === "/api/opened" && request.method === "POST") {
      response.writeHead(204);
      response.end();
      return;
    }
    response.writeHead(404);
    response.end();
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("Transition fixture did not bind a TCP port");
  return {
    origin: `http://127.0.0.1:${String(address.port)}`,
    close: () =>
      new Promise((resolve, reject) =>
        server.close((error) =>
          error === undefined ? resolve(undefined) : reject(error),
        ),
      ),
  };
};

const transitionScenario = (executable, origin) =>
  browserScenarioSchema.parse({
    browser: { mode: "launch", executable_path: executable },
    start_url: { url: `${origin}/app` },
    actions: [
      {
        step_id: "open-settings",
        action: "click",
        locator: { kind: "role", role: "button", name: "Open settings" },
      },
      {
        step_id: "close-settings",
        action: "click",
        locator: { kind: "role", role: "button", name: "Close settings" },
      },
      {
        step_id: "open-details",
        action: "click",
        locator: { kind: "role", role: "link", name: "Details" },
      },
      {
        step_id: "details-ready",
        action: "wait_for",
        locator: { kind: "css", selector: "#details" },
        state: "visible",
      },
      {
        step_id: "missing-control",
        action: "click",
        locator: { kind: "test_id", value: "not-on-this-page" },
        timeout_ms: 300,
      },
      { step_id: "after-failure", action: "wait_for_timeout", duration_ms: 1 },
    ],
    capture: {
      after_each_step: ["accessibility", "url", "dom"],
      at_end: ["screenshot", "dom"],
      events: ["console", "network"],
    },
  });

const viewContract = toolContract("inspect_analysis_view");

const mcpEvidence = (result, operation) => {
  if (result.isError === true)
    throw new Error(`${operation} failed: ${mcpTextValue(result)}`);
  return JSON.parse(mcpTextValue(result));
};

const runCli = async (args) => {
  const { stdout } = await execute(
    process.execPath,
    ["scripts/rea.mjs", ...args, "--json"],
    { cwd: process.cwd(), env: process.env, maxBuffer: 64 * 1_024 * 1_024 },
  );
  return JSON.parse(stdout);
};

const artifactOf = (row, artifact) =>
  row.artifacts.find((entry) => entry.artifact === artifact);

/** Check the known transitions of the fixture against one projected step page. */
const assertTransitions = (rows) => {
  assert.equal(rows.length, 7);
  assert.deepEqual(
    rows.map(({ action_class: actionClass }) => actionClass),
    ["start-navigation", "input", "input", "input", "wait", "input", "wait"],
  );
  const accessibility = rows.map((row) => artifactOf(row, "accessibility"));
  const url = rows.map((row) => artifactOf(row, "url"));
  assert.equal(accessibility[1]?.change, "changed", "opening the dialog");
  assert.equal(url[1]?.change, "unchanged", "the dialog keeps the URL");
  assert.ok(rows[1].network_transactions.retained >= 1, "open sends a request");
  assert.equal(accessibility[2]?.change, "changed", "closing the dialog");
  assert.equal(
    accessibility[2]?.comparison_sha256,
    accessibility[0]?.comparison_sha256,
    "closing restores the recorded accessibility of the start page",
  );
  assert.notEqual(url[4]?.comparison_sha256, url[0]?.comparison_sha256);
  assert.equal(rows[5].status, "failed");
  assert.equal(typeof rows[5].error, "string");
  assert.equal(accessibility[5]?.change, "unchanged", "a failed click");
  assert.equal(rows[6].status, "cancelled");
  for (const artifact of ["accessibility", "url", "screenshot", "dom"])
    assert.deepEqual(
      {
        coverage: artifactOf(rows[6], artifact)?.coverage,
        change: artifactOf(rows[6], artifact)?.change,
      },
      { coverage: "missing", change: "unknown" },
      `${artifact} after the cancelled step stays unknown`,
    );
};

/** Every retained event is counted once: in one step window or outside all windows. */
const assertReceiptAccounting = (steps, capture) => {
  const view = steps.normalized_result;
  assert.deepEqual(view.enabled_event_families, ["console", "network"]);
  const inWindows = view.page.items.reduce(
    (total, row) => total + row.events_received.retained,
    0,
  );
  assert.equal(
    inWindows + view.received_outside_step_windows.retained,
    capture.normalized_result.events.retained,
  );
  for (const row of view.page.items)
    assert.equal(
      typeof row.network_transactions.retained,
      "number",
      "network was observed, so every step reports a count",
    );
};

/** Project portable Evidence through the compiled CLI from a temporary input file. */
const inlineCliView = async (evidence, view) => {
  const directory = await mkdtemp(join(tmpdir(), "rea-browser-scenario-view-"));
  try {
    const input = join(directory, "view.json");
    await writeFile(
      input,
      JSON.stringify({ source: { kind: "inline", evidence }, view }),
    );
    return await runCli(["inspect-analysis-view", input]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
};

const pageAllText = async (callView, stepIndex, artifact) => {
  let offset = 0;
  let text = "";
  let sha256;
  for (;;) {
    const view = await callView({
      kind: "browser-scenario",
      collection: "text",
      step_index: stepIndex,
      artifact,
      offset,
      limit: 64,
    });
    const { item } = view.normalized_result.page;
    assert.equal(item.coverage, "captured");
    text += item.text;
    sha256 = item.artifact_sha256;
    const next = view.normalized_result.coverage.next_offset;
    if (next === null) break;
    offset = next;
  }
  assert.equal(
    createHash("sha256").update(Buffer.from(text)).digest("hex"),
    sha256,
    "paged text reassembles the retained artifact",
  );
  return text;
};

/**
 * Capture a self-owned page with known transitions through stdio MCP, project
 * its step views from the retained record, and require the compiled CLI to
 * project identical views from the same Evidence inline.
 */
export async function verifyBrowserScenarioViews(executable) {
  const site = await startTransitionSite();
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL("../rea.mjs", import.meta.url)), "mcp"],
    env: process.env,
    stderr: "pipe",
  });
  const client = new Client({
    name: "browser-scenario-view-e2e",
    version: "1",
  });
  let failure;
  try {
    await client.connect(transport);
    const capture = mcpEvidence(
      await client.callTool({
        name: "capture_browser_scenario",
        arguments: transitionScenario(executable, site.origin),
      }),
      "capture_browser_scenario",
    );
    const source = {
      kind: "retained-evidence",
      evidence_id: capture.evidence_id,
    };
    const callView = async (view) =>
      viewContract.outputSchema.parse(
        mcpEvidence(
          await client.callTool({
            name: "inspect_analysis_view",
            arguments: { source, view },
          }),
          "inspect_analysis_view",
        ),
      );
    const steps = await callView({
      kind: "browser-scenario",
      collection: "steps",
    });
    assert.equal(steps.authority, "controlled-replay");
    assert.equal(steps.confidence, "derived");
    assert.deepEqual(steps.evidence_links, [capture.evidence_id]);
    assertTransitions(steps.normalized_result.page.items);
    const summary = await callView({ kind: "summary" });
    assert.deepEqual(summary.normalized_result.summary.step_statuses, {
      completed: 5,
      failed: 1,
      cancelled: 1,
    });
    const dialogText = await pageAllText(callView, 1, "accessibility");
    assert.match(dialogText, /dialog "Settings"/u);
    const detailsHtml = await pageAllText(callView, 4, "dom");
    assert.match(detailsHtml, /<h1 id="details">Details<\/h1>/u);
    assertReceiptAccounting(steps, capture);

    const cliSteps = await inlineCliView(capture, {
      kind: "browser-scenario",
      collection: "steps",
    });
    assert.equal(cliSteps.evidence_id, steps.evidence_id);
    assert.deepEqual(cliSteps.normalized_result, steps.normalized_result);
    return {
      mocked: false,
      cli: true,
      stdio_mcp: true,
      steps: steps.normalized_result.page.items.length,
      revisited_accessibility: true,
      cancelled_step_unknown: true,
      text_reassembled: dialogText.length + detailsHtml.length,
      capture_evidence_bytes: Buffer.byteLength(JSON.stringify(capture)),
      steps_view_bytes: Buffer.byteLength(JSON.stringify(steps)),
    };
  } catch (cause) {
    failure = cause;
    throw cause;
  } finally {
    await closeVerifierResources(
      [
        async () => {
          await client.close();
          await transport.close();
        },
        () => site.close(),
      ],
      failure,
    );
  }
}
