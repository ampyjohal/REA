import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { expect, it } from "vitest";

import type { BinarySessionPort } from "../../../src/application/binary/BinarySessionPort.js";
import { toolContract } from "../../../src/contracts/toolContracts.js";
import { AnalysisOutputError } from "../../../src/domain/analysisErrorCore.js";
import { err, ok } from "../../../src/domain/result.js";
import { silentLogger } from "../../../src/logger.js";
import { EvidenceMcpServer } from "../../../src/server/EvidenceMcpServer.js";
import { registerCloseLifecycleTool } from "../../../src/server/registerCloseLifecycleTool.js";
import { createToolResultDelivery } from "../../../src/server/toolResult.js";
import type { LifecycleToolRegistration } from "../../../src/server/registerSessionTools.js";
import { parseMcpToolError } from "../../fixtures/mcpToolError.js";

it("retains a written snapshot receipt when its failed close is aggregated", async () => {
  const directory = await mkdtemp(
    join(tmpdir(), "rea-snapshot-close-receipt-"),
  );
  const snapshotPath = join(directory, "analysis.json");
  const receipt = {
    path: snapshotPath,
    bytes: 127,
    primitive_entries: 2,
    workflow_entries: 1,
    evidence_records: 3,
  };
  const snapshotFailure = new AnalysisOutputError(
    "close_binary",
    "snapshot was written but the analysis owner could not close",
    {
      cleanup: {
        reason: "analysis cleanup is incomplete",
        resources: ["analysis"],
      },
      diagnostics: { saved_snapshot: receipt },
    },
  );
  const session = {
    closeWithSnapshot: async (path: string) => {
      await writeFile(path, JSON.stringify({ saved: true }));
      return err(snapshotFailure);
    },
  } as unknown as BinarySessionPort;
  const reverseFailure = new AnalysisOutputError(
    "close_binary",
    "reverse writer remains",
    {
      cleanup: {
        reason: "reverse cleanup is incomplete",
        resources: ["reverse"],
      },
    },
  );
  const processFailure = new AnalysisOutputError(
    "close_binary",
    "process writer remains",
    {
      cleanup: {
        reason: "process cleanup is incomplete",
        resources: ["process"],
      },
    },
  );
  const server = new EvidenceMcpServer(
    { name: "snapshot-close-receipt-test", version: "1" },
    {},
    undefined,
    createToolResultDelivery(undefined),
  );
  const registration = {
    server,
    session,
    logger: silentLogger,
    openContract: toolContract("open_binary"),
    closeContract: toolContract("close_binary"),
    statusContract: toolContract("binary_session"),
    startedAt: new Date(0).toISOString(),
    availabilityPolicy: () => ({}) as never,
    androidAnalysisAvailability: async () => ({}) as never,
    closeProcessResources: async () => err(processFailure),
    retryReverseEngineeringCleanup: async () => err(reverseFailure),
  } satisfies LifecycleToolRegistration;
  registerCloseLifecycleTool(registration);
  const client = new Client({
    name: "snapshot-close-receipt-test",
    version: "1",
  });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const result = await client.callTool({
      name: "close_binary",
      arguments: { snapshot_path: snapshotPath },
    });
    expect(await readFile(snapshotPath, "utf8")).toBe('{"saved":true}');
    expect(result.isError).toBe(true);
    expect(parseMcpToolError(result).error).toMatchObject({
      details: {
        diagnostics: { saved_snapshot: receipt },
      },
    });
  } finally {
    await Promise.allSettled([client.close(), server.close()]);
    await rm(directory, { recursive: true, force: true });
  }
});
