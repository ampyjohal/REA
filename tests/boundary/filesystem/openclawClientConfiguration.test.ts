import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { readClientRegistrationStatuses } from "../../../src/application/ClientRegistrationStatus.js";
import { npxRegistrationCommand } from "../../../src/application/ClientRegistrationIdentity.js";
import { configureClientConfiguration } from "../../../src/application/SetupClientConfiguration.js";
import { skillDestinations } from "../../../src/application/SetupSkill.js";
import { supportedClients } from "../../../src/application/SupportedClients.js";
import { systemUninstallHost } from "../../../src/application/Uninstall.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { clearClientLocationEnvironment } from "../../fixtures/clientEnvironment.js";

/**
 * The registration command setup writes on the host running the tests. Windows
 * wraps it in `cmd.exe /d /c`, so the expected entry follows the host too.
 */
const command = npxRegistrationCommand(process.platform);

beforeEach(clearClientLocationEnvironment);
afterEach(() => vi.unstubAllEnvs());

const openclawPath = (
  home: string,
  platform: NodeJS.Platform = "linux",
  env: Parameters<typeof supportedClients>[2] = {},
) =>
  supportedClients(home, platform, env).find(({ name }) => name === "openclaw");

describe("OpenClaw configuration paths", () => {
  it("resolves the openclaw.json file and marker directory", () => {
    expect(openclawPath("/home/a")).toEqual({
      name: "openclaw",
      displayName: "OpenClaw",
      configPath: join("/home/a", ".openclaw", "openclaw.json"),
      markerPath: join("/home/a", ".openclaw"),
      format: "json",
    });
    expect(openclawPath("/Users/a", "darwin")?.configPath).toBe(
      join("/Users/a", ".openclaw", "openclaw.json"),
    );
    expect(openclawPath("C:\\Users\\a", "win32")?.configPath).toBe(
      join("C:\\Users\\a", ".openclaw", "openclaw.json"),
    );
  });

  it("honors the OPENCLAW_HOME override", () => {
    expect(
      openclawPath("/home/a", "linux", { OPENCLAW_HOME: "/opt/openclaw" })
        ?.configPath,
    ).toBe(join("/opt/openclaw", "openclaw.json"));
    expect(
      openclawPath("/home/a", "linux", { OPENCLAW_HOME: "" })?.configPath,
    ).toBe(join("/home/a", ".openclaw", "openclaw.json"));
  });

  it("resolves the personal skills directory beside the config root", () => {
    expect(
      skillDestinations("/home/a", ["openclaw"]).map(({ path }) => path),
    ).toEqual([
      join("/home/a", ".openclaw", "skills", "reverse-engineer-anything"),
    ]);
    expect(
      skillDestinations("/home/a", ["openclaw"], {
        OPENCLAW_HOME: "/opt/openclaw",
      }).map(({ path }) => path),
    ).toEqual([join("/opt/openclaw", "skills", "reverse-engineer-anything")]);
  });
});

describe("OpenClaw JSON registration", () => {
  const openclawClient = async () => {
    const home = await createTestTempDirectory("rea-openclaw-");
    const client = openclawPath(home, process.platform);
    if (client?.markerPath === undefined)
      throw new Error("missing OpenClaw client");
    await mkdir(client.markerPath, { recursive: true });
    return { home, client };
  };

  it("upserts rea into mcpServers while preserving unrelated settings", async () => {
    const { home, client } = await openclawClient();
    await writeFile(
      client.configPath,
      `{
  "mcpServers": {
    "other": { "command": "other-server" }
  },
  "agents": { "defaults": { "model": "openclaw-default" } }
}`,
    );

    expect(
      (await configureClientConfiguration(client, {}, command)).status,
    ).toBe("configured");
    const parsed = JSON.parse(await readFile(client.configPath, "utf8"));
    expect(parsed.mcpServers.other).toEqual({ command: "other-server" });
    expect(parsed.agents.defaults.model).toBe("openclaw-default");
    expect(parsed.mcpServers.rea).toEqual({
      command: command[0],
      args: command.slice(1),
    });

    expect(await configureClientConfiguration(client, {}, command)).toEqual({
      status: "unchanged",
    });
    expect(
      (
        await readClientRegistrationStatuses(home, undefined, {
          platform: process.platform,
          environment: {},
        })
      ).find(({ client }) => client === "openclaw"),
    ).toMatchObject({ state: "aligned", command });
  });

  it("creates the mcpServers table in an existing settings file without servers", async () => {
    const { client } = await openclawClient();
    await writeFile(
      client.configPath,
      JSON.stringify({ agents: { defaults: { verbose: true } } }, null, 2),
    );
    expect(
      (await configureClientConfiguration(client, {}, command)).status,
    ).toBe("configured");
    const parsed = JSON.parse(await readFile(client.configPath, "utf8"));
    expect(parsed.agents.defaults.verbose).toBe(true);
    expect(parsed.mcpServers.rea).toEqual({
      command: command[0],
      args: command.slice(1),
    });
  });

  it("registers into an empty settings file", async () => {
    const { client } = await openclawClient();
    await writeFile(client.configPath, "");
    expect(
      (await configureClientConfiguration(client, {}, command)).status,
    ).toBe("configured");
    const parsed = JSON.parse(await readFile(client.configPath, "utf8"));
    expect(parsed.mcpServers.rea).toEqual({
      command: command[0],
      args: command.slice(1),
    });
  });

  it("removes only the rea entry on uninstall", async () => {
    const { home, client } = await openclawClient();
    await writeFile(
      client.configPath,
      JSON.stringify(
        { mcpServers: { other: { command: "other-server" } } },
        null,
        2,
      ),
    );
    await configureClientConfiguration(client, {}, command);

    expect((await systemUninstallHost(home).removeClient(client)).status).toBe(
      "removed",
    );
    const parsed = JSON.parse(await readFile(client.configPath, "utf8"));
    expect(parsed.mcpServers.other).toEqual({ command: "other-server" });
    expect(parsed.mcpServers.rea).toBeUndefined();
  });
});
