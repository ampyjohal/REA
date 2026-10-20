import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { Ajv2020 } from "ajv/dist/2020.js";
import { expect, it } from "vitest";

import { createArtifactBinarySession } from "../../../src/composition/binary.js";
import {
  PYTHON_39_MAGIC,
  cArchiveExecutable,
  pyzArchive,
} from "../../../src/artifacts/pyinstaller/CArchive.fixture.js";
import { artifactInspectionResultSchema } from "../../../src/domain/artifactInspection.js";
import { parseEvidence } from "../../../src/domain/evidence.js";
import { analysisViewResultSchema } from "../../../src/domain/analysisView/analysisView.js";
import { createServer } from "../../../src/server/createServer.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

it("inventories a PyInstaller executable through inspect_artifact", async () => {
  const directory = await createTestTempDirectory("rea-pyinstaller-mcp-");
  const path = join(directory, "hello");
  await writeFile(
    path,
    cArchiveExecutable({
      layout: "2.1",
      pythonVersion: 312,
      pythonLibrary: "libpython3.12.so",
      members: [
        {
          name: "pyi-contents-directory _internal",
          typeCode: "o",
          payload: Buffer.alloc(0),
          compress: false,
        },
        {
          name: "pyi-contents-directory _internal",
          typeCode: "o",
          payload: Buffer.alloc(0),
          compress: false,
        },
        {
          name: "hello",
          typeCode: "s",
          payload: Buffer.from("print('hi')"),
          compress: false,
        },
        {
          name: "PYZ.pyz",
          typeCode: "z",
          payload: pyzArchive({
            magic: PYTHON_39_MAGIC,
            modules: [{ name: "app", typeCode: 0, body: Buffer.from("app") }],
          }),
          compress: false,
        },
      ],
    }),
  );
  const session = await createArtifactBinarySession(process.env);
  const server = createServer({ kind: "session", session });
  const client = new Client({ name: "pyinstaller-mcp-test", version: "1" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const opened = await client.callTool({
      name: "open_binary",
      arguments: { path },
    });
    expect(opened.isError).not.toBe(true);
    const inspected = await client.callTool({
      name: "inspect_artifact",
      arguments: {},
    });
    expect(inspected.isError).not.toBe(true);
    const inspection = artifactInspectionResultSchema.parse(
      parseEvidence(inspected.structuredContent).normalized_result,
    );
    expect(inspection.subject.root_format).toBe("pyinstaller");
    expect(inspection.next_probes).toEqual([]);
    expect(
      inspection.substeps[0]?.evidence.normalized_result.occurrences.map(
        (occurrence) => occurrence.logical_path,
      ),
    ).toEqual(expect.arrayContaining(["hello", "PYZ.pyz/app.pyc"]));
    const parent = parseEvidence(inspected.structuredContent);
    const compact = await client.callTool({
      name: "inspect_artifact",
      arguments: { detail: "summary" },
    });
    expect(compact.isError).not.toBe(true);
    const summary = parseEvidence(compact.structuredContent).normalized_result;
    expect(summary).toMatchObject({
      kind: "summary",
      summary: {
        root_format_metadata: { kind: "pyinstaller", python_version_raw: 312 },
        observed_entry_kind_counts: { metadata: 2 },
        source_coverage: { status: "complete" },
      },
    });
    const definition = (await client.listTools()).tools.find(
      (tool) => tool.name === "inspect_analysis_view",
    );
    expect(definition?.outputSchema).toBeDefined();
    const ajv = new Ajv2020({ strict: false, validateFormats: false });
    const inputSchema: Record<string, unknown> = definition!.inputSchema;
    const outputSchema: Record<string, unknown> = definition!.outputSchema!;
    const input = ajv.compile(inputSchema);
    const output = ajv.compile(outputSchema);
    const ids: string[] = [];
    for (const offset of [0, 1, 2]) {
      const args = {
        source: { kind: "retained-evidence", evidence_id: parent.evidence_id },
        view: {
          kind: "inventory",
          collection: "occurrences",
          entry_kinds: ["metadata"],
          fields: ["format_metadata"],
          offset,
          limit: 1,
        },
      };
      expect(input(args), JSON.stringify(input.errors)).toBe(true);
      const reply = await client.callTool({
        name: "inspect_analysis_view",
        arguments: args,
      });
      expect(reply.isError).not.toBe(true);
      expect(
        output(reply.structuredContent),
        JSON.stringify(output.errors),
      ).toBe(true);
      const evidence = parseEvidence(reply.structuredContent);
      const view = analysisViewResultSchema.parse(evidence.normalized_result);
      if (view.kind !== "inventory") throw new Error("Expected inventory page");
      expect(view.parent_evidence_id).toBe(parent.evidence_id);
      expect(evidence.evidence_links).toContain(parent.evidence_id);
      expect(view.coverage.total).toBe(2);
      if (offset < 2) {
        expect(view.items).toHaveLength(1);
        expect(view.items[0]).toMatchObject({
          artifact_id: null,
          format_metadata: { source_name: "pyi-contents-directory _internal" },
        });
        expect(view.items[0]).not.toHaveProperty("logical_path");
        const row = view.items[0];
        if (row === undefined || !("occurrence_id" in row))
          throw new Error("Expected occurrence identity");
        ids.push(row.occurrence_id);
      } else expect(view.items).toEqual([]);
    }
    expect(new Set(ids).size).toBe(2);
  } finally {
    await client.close();
    await server.close();
    await session.close();
  }
});
