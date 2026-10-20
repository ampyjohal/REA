import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, it } from "vitest";

import {
  assertRizinEmptyInferiorInventory,
  RizinDebugSessionManager,
} from "../../../src/rizin/RizinDebugSessionManager.js";
import {
  spawnOwnedProviderProcess,
  type ProviderProcessHandle,
} from "../../../src/process/ProviderProcess.js";
import { evidenceSchema } from "../../../src/domain/evidence.js";
import { absoluteCallerPath } from "../../../src/filesystem/callerPath.js";
import {
  createRizinTestManager,
  rizinTestInferiorTty,
} from "./RizinTestInferiorTty.js";
import { createInjectedProcess } from "./RizinDebugSessionCoverage.fixtures.js";

let directory: string | undefined;
const managers: Array<{ closeAll(): Promise<void> }> = [];
const inferiorProcesses: ChildProcess[] = [];
const ownedProviderProcesses: ProviderProcessHandle[] = [];

it("accepts only ended retained identities for an empty Rizin inventory", async () => {
  const identity = { pid: "123", startTime: "100" };

  await expect(
    assertRizinEmptyInferiorInventory([identity], async () => "100"),
  ).rejects.toThrow("still active");
  await expect(
    assertRizinEmptyInferiorInventory([identity], async () => "101"),
  ).resolves.toBeUndefined();
  await expect(
    assertRizinEmptyInferiorInventory([identity], async () => null),
  ).resolves.toBeUndefined();
});

const startRizinWithProvider = async (
  provider: string,
): Promise<{
  manager: RizinDebugSessionManager;
  sessionId: string | undefined;
}> => {
  const manager = createRizinTestManager({ REA_RIZIN_COMMAND: provider });
  managers.push(manager);
  const started = await manager.start({
    path: "/tmp/fixture.bin",
    inferior_tty: await rizinTestInferiorTty(),
  });
  expect(started.ok).toBe(true);
  return {
    manager,
    sessionId: started.ok ? started.value.session_id : undefined,
  };
};

const startRizinWithOwnedStop = async (provider: string) => {
  let debuggerProcess: ProviderProcessHandle | undefined;
  const manager = new RizinDebugSessionManager(
    { ...process.env, REA_RIZIN_COMMAND: provider },
    {
      platform: "linux",
      spawnProcess: async (options) => {
        const launched = await spawnOwnedProviderProcess(options);
        debuggerProcess = launched.process;
        return launched;
      },
    },
  );
  managers.push(manager);
  const started = await manager.start({
    path: "/tmp/fixture.bin",
    inferior_tty: await rizinTestInferiorTty(),
  });
  if (!started.ok) throw started.error;
  return {
    manager,
    sessionId: started.value.session_id,
    exitDebugger: async () => {
      if (debuggerProcess === undefined)
        throw new Error("Provider did not spawn");
      const exited = new Promise<void>((resolve) =>
        debuggerProcess?.once("exit", () => resolve()),
      );
      debuggerProcess.kill("SIGTERM");
      await exited;
    },
  };
};

const expectOwnedProcessExited = async (pidText: string): Promise<void> => {
  const pid = Number(pidText);
  expect(Number.isInteger(pid)).toBe(true);
  expect(() => process.kill(pid, 0)).toThrow();
};

afterEach(async () => {
  for (const inferior of inferiorProcesses.splice(0)) {
    if (inferior.exitCode !== null || inferior.signalCode !== null) continue;
    const exited = new Promise<void>((resolveExit) =>
      inferior.once("exit", () => resolveExit()),
    );
    inferior.kill("SIGTERM");
    await exited;
  }
  await Promise.all(
    managers
      .splice(0)
      .map((manager) => manager.closeAll().catch(() => undefined)),
  );
  for (const provider of ownedProviderProcesses.splice(0)) {
    if (provider.exitCode !== null || provider.signalCode !== null) continue;
    const exited = new Promise<void>((resolveExit) =>
      provider.once("exit", () => resolveExit()),
    );
    provider.kill("SIGTERM");
    await Promise.race([
      exited,
      new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 1_000)),
    ]);
    if (provider.exitCode === null && provider.signalCode === null) {
      const killed = new Promise<void>((resolveExit) =>
        provider.once("exit", () => resolveExit()),
      );
      provider.kill("SIGKILL");
      await killed;
    }
  }
  if (directory !== undefined)
    await rm(directory, { recursive: true, force: true });
  directory = undefined;
});

const spawnTestInferior = async (): Promise<ChildProcess> => {
  const inferior = spawn(
    process.execPath,
    ["-e", "setInterval(() => {}, 1000)"],
    {
      stdio: "ignore",
    },
  );
  inferiorProcesses.push(inferior);
  await new Promise<void>((resolveSpawn, rejectSpawn) => {
    inferior.once("spawn", resolveSpawn);
    inferior.once("error", rejectSpawn);
  });
  return inferior;
};

const spawnTestInferiorOnTty = async (
  ttyPath: string,
): Promise<ChildProcess> => {
  const ttyFd = openSync(ttyPath, "w");
  let inferior: ChildProcess;
  try {
    inferior = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      stdio: [ttyFd, ttyFd, ttyFd],
    });
  } finally {
    closeSync(ttyFd);
  }
  inferiorProcesses.push(inferior);
  await new Promise<void>((resolveSpawn, rejectSpawn) => {
    inferior.once("spawn", resolveSpawn);
    inferior.once("error", rejectSpawn);
  });
  return inferior;
};

const createInferiorInventoryProvider = async (
  rows: readonly { readonly fd: number; readonly pid: number }[],
): Promise<string> => {
  directory = await mkdtemp(join(tmpdir(), "rea-rizin-owned-inferior-"));
  const provider = join(directory, "fake-rizin-owned-inferior.mjs");
  await writeFile(
    provider,
    `#!/usr/bin/env node
process.stdout.write("\\0");
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  input += chunk;
  for (;;) {
    const boundary = input.indexOf("\\n"); if (boundary < 0) break;
    const line = input.slice(0, boundary); input = input.slice(boundary + 1);
    if (line === "olj") process.stdout.write(JSON.stringify(${JSON.stringify(rows.map(({ fd, pid }) => ({ fd, raised: true, uri: `ptrace://${pid}` })))} ) + "\\0");
    else if (line === "e dbg.exitkills") process.stdout.write("true\\0");
    else if (line.startsWith("!echo ")) process.stdout.write(line.slice(6) + "\\0");
    else process.stdout.write("\\0");
  }
});
`,
  );
  await chmod(provider, 0o700);
  return provider;
};

const createRetryEmptyInventoryProvider = async (
  pid: number,
): Promise<string> => {
  directory = await mkdtemp(join(tmpdir(), "rea-rizin-empty-retry-"));
  const provider = join(directory, "fake-rizin-empty-retry.mjs");
  await writeFile(
    provider,
    `#!/usr/bin/env node
process.stdout.write("\\0");
let input = "";
let inventory = 0;
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  input += chunk;
  for (;;) {
    const boundary = input.indexOf("\\n"); if (boundary < 0) break;
    const line = input.slice(0, boundary); input = input.slice(boundary + 1);
    if (line === "olj") {
      inventory += 1;
      process.stdout.write((inventory === 1 ? JSON.stringify([{ fd: 12, raised: true, uri: "ptrace://${pid}" }]) : "[]") + "\\0");
    }
    else if (line === "e dbg.exitkills") process.stdout.write("false\\0");
    else if (line.startsWith("!echo ")) process.stdout.write(line.slice(6) + "\\0");
    else process.stdout.write("\\0");
  }
});
`,
  );
  await chmod(provider, 0o700);
  return provider;
};

const spawnTestInferiorWithMutableInput = async (
  ttyPath: string,
  statePath: string,
): Promise<ChildProcess> => {
  const ttyFd = openSync(ttyPath, "w");
  let inferior: ChildProcess;
  try {
    inferior = spawn(
      process.execPath,
      [
        "-e",
        `const { closeSync, openSync, writeFileSync } = require("node:fs");
const [ttyPath, statePath] = process.argv.slice(1);
const replaceInput = (path, state) => {
  closeSync(0);
  if (openSync(path, "r") !== 0) throw new Error("stdin was not reopened as fd 0");
  writeFileSync(statePath, state);
};
process.on("SIGUSR1", () => replaceInput("/dev/zero", "unclassified"));
process.on("SIGUSR2", () => replaceInput(ttyPath, "restored"));
setInterval(() => {}, 1000);`,
        ttyPath,
        statePath,
      ],
      { stdio: [ttyFd, ttyFd, ttyFd] },
    );
  } finally {
    closeSync(ttyFd);
  }
  inferiorProcesses.push(inferior);
  await new Promise<void>((resolveSpawn, rejectSpawn) => {
    inferior.once("spawn", resolveSpawn);
    inferior.once("error", rejectSpawn);
  });
  return inferior;
};

const createPostDetachInputTransitionProvider = async (
  pid: number,
  commandsPath: string,
): Promise<string> => {
  directory = await mkdtemp(join(tmpdir(), "rea-rizin-detached-sink-"));
  const provider = join(directory, "fake-rizin-detached-sink.mjs");
  await writeFile(
    provider,
    `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
process.stdout.write("\\0");
let input = "";
let detached = false;
let pendingDetach = false;
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  input += chunk;
  for (;;) {
    const boundary = input.indexOf("\\n"); if (boundary < 0) break;
    const line = input.slice(0, boundary); input = input.slice(boundary + 1);
    appendFileSync(${JSON.stringify(commandsPath)}, line + "\\n");
    if (line === "olj") process.stdout.write((detached ? "[]" : JSON.stringify([{ fd: 12, raised: true, uri: "ptrace://${pid}" }])) + "\\0");
    else if (line === "e dbg.exitkills") process.stdout.write("false\\0");
    else if (line.startsWith("o- ")) {
      detached = true;
      pendingDetach = true;
      process.kill(${pid}, "SIGUSR1");
    }
    else if (line.startsWith("!echo ")) {
      const marker = line.slice(6);
      if (pendingDetach) {
        pendingDetach = false;
        setTimeout(() => process.stdout.write(marker + "\\0"), 100);
      } else process.stdout.write(marker + "\\0");
    }
    else process.stdout.write("\\0");
  }
});
`,
  );
  await chmod(provider, 0o700);
  return provider;
};

const createMalformedDetachReadbackProvider = async (
  pid: number,
  commandsPath: string,
): Promise<string> => {
  const provider = join(directory!, "fake-rizin-malformed-detach-readback.mjs");
  await writeFile(
    provider,
    `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
process.stdout.write("\\0");
let input = "";
let detached = false;
let postDetachReadbacks = 0;
let pendingDetach = false;
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  input += chunk;
  for (;;) {
    const boundary = input.indexOf("\\n"); if (boundary < 0) break;
    const line = input.slice(0, boundary); input = input.slice(boundary + 1);
    appendFileSync(${JSON.stringify(commandsPath)}, line + "\\n");
    if (line === "olj") {
      if (!detached) process.stdout.write(JSON.stringify([{ fd: 12, raised: true, uri: "ptrace://${pid}" }]) + "\\0");
      else if (postDetachReadbacks++ === 0) process.stdout.write("{malformed\\0");
      else process.stdout.write("[]\\0");
    }
    else if (line === "e dbg.exitkills") process.stdout.write("false\\0");
    else if (line.startsWith("o- ")) {
      detached = true;
      pendingDetach = true;
      process.kill(${pid}, "SIGUSR1");
    }
    else if (line.startsWith("!echo ")) {
      const marker = line.slice(6);
      if (pendingDetach) {
        pendingDetach = false;
        setTimeout(() => process.stdout.write(marker + "\\0"), 100);
      } else process.stdout.write(marker + "\\0");
    }
    else process.stdout.write("\\0");
  }
});
`,
  );
  await chmod(provider, 0o700);
  return provider;
};

const createRetryableDetachProvider = async (
  pid: number,
  commandsPath: string,
): Promise<string> => {
  const provider = join(directory!, "fake-rizin-retryable-detach.mjs");
  await writeFile(
    provider,
    `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
process.stdout.write("\\0");
let input = "";
let detachAttempts = 0;
let detached = false;
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  input += chunk;
  for (;;) {
    const boundary = input.indexOf("\\n"); if (boundary < 0) break;
    const line = input.slice(0, boundary); input = input.slice(boundary + 1);
    appendFileSync(${JSON.stringify(commandsPath)}, line + "\\n");
    if (line === "olj") process.stdout.write(JSON.stringify(detached ? [] : [{ fd: 12, raised: true, uri: "ptrace://${pid}" }]) + "\\0");
    else if (line === "e dbg.exitkills") process.stdout.write("false\\0");
    else if (line === "o- 12") { detachAttempts += 1; if (detachAttempts >= 2) detached = true; }
    else if (line.startsWith("!echo ")) process.stdout.write(line.slice(6) + "\\0");
    else process.stdout.write("\\0");
  }
});
`,
  );
  await chmod(provider, 0o700);
  return provider;
};

const createAdditionalActiveAfterDetachProvider = async (
  selectedPid: number,
  additionalPid: number,
  commandsPath: string,
): Promise<string> => {
  const provider = join(
    directory!,
    "fake-rizin-additional-active-after-detach.mjs",
  );
  await writeFile(
    provider,
    `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
process.stdout.write("\\0");
let input = "";
let detached = false;
let postDetachReadbacks = 0;
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  input += chunk;
  for (;;) {
    const boundary = input.indexOf("\\n"); if (boundary < 0) break;
    const line = input.slice(0, boundary); input = input.slice(boundary + 1);
    appendFileSync(${JSON.stringify(commandsPath)}, line + "\\n");
    if (line === "olj") {
      const rows = !detached
        ? [{ fd: 12, raised: true, uri: "ptrace://${selectedPid}" }]
        : postDetachReadbacks++ === 0
          ? [{ fd: 13, raised: true, uri: "ptrace://${additionalPid}" }]
          : [];
      process.stdout.write(JSON.stringify(rows) + "\\0");
    }
    else if (line === "e dbg.exitkills") process.stdout.write("false\\0");
    else if (line === "o- 12") detached = true;
    else if (line.startsWith("!echo ")) process.stdout.write(line.slice(6) + "\\0");
    else process.stdout.write("\\0");
  }
});
`,
  );
  await chmod(provider, 0o700);
  return provider;
};

const createStaleSelectedRowWithActiveAdditionalProvider = async (
  selectedPid: number,
  additionalPid: number,
  commandsPath: string,
): Promise<string> => {
  const provider = join(
    directory!,
    "fake-rizin-stale-selected-row-active-additional.mjs",
  );
  await writeFile(
    provider,
    `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
process.stdout.write("\\0");
let input = "";
let detached = false;
let postDetachReadbacks = 0;
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  input += chunk;
  for (;;) {
    const boundary = input.indexOf("\\n"); if (boundary < 0) break;
    const line = input.slice(0, boundary); input = input.slice(boundary + 1);
    appendFileSync(${JSON.stringify(commandsPath)}, line + "\\n");
    if (line === "olj") {
      if (!detached) process.stdout.write(JSON.stringify([{ fd: 12, raised: true, uri: "ptrace://${selectedPid}" }]) + "\\0");
      else {
        postDetachReadbacks += 1;
        const rows = postDetachReadbacks === 1
          ? [{ fd: 13, raised: true, uri: "ptrace://${additionalPid}" }]
          : postDetachReadbacks === 2
            ? [{ fd: 12, raised: true, uri: "ptrace://${selectedPid}" }]
            : postDetachReadbacks === 3
              ? [{ fd: 13, raised: true, uri: "ptrace://${additionalPid}" }]
              : [];
        process.stdout.write(JSON.stringify(rows) + "\\0");
      }
    }
    else if (line === "e dbg.exitkills") process.stdout.write("false\\0");
    else if (line.startsWith("o- ")) detached = true;
    else if (line.startsWith("!echo ")) process.stdout.write(line.slice(6) + "\\0");
    else process.stdout.write("\\0");
  }
});
`,
  );
  await chmod(provider, 0o700);
  return provider;
};

const createLateDetachProvider = async (
  pid: number,
  providerDirectory: string,
  completionPath: string,
): Promise<string> => {
  const provider = join(providerDirectory, "fake-rizin-late-detach.mjs");
  await writeFile(
    provider,
    `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
process.stdout.write("\\0");
let input = "";
let detached = false;
let pendingDetach = false;
let pendingExitPolicyReadback = false;
let exitPolicyReadbacks = 0;
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  input += chunk;
  for (;;) {
    const boundary = input.indexOf("\\n"); if (boundary < 0) break;
    const line = input.slice(0, boundary); input = input.slice(boundary + 1);
    if (line === "olj") process.stdout.write((detached ? "[]" : JSON.stringify([{ fd: 12, raised: true, uri: "ptrace://${pid}" }])) + "\\0");
    else if (line === "e dbg.exitkills") {
      exitPolicyReadbacks += 1;
      pendingExitPolicyReadback = true;
    }
    else if (line.startsWith("o- ")) {
      pendingDetach = true;
      setTimeout(() => { detached = true; }, 700);
    }
    else if (line.startsWith("!echo ")) {
      const marker = line.slice(6);
      if (pendingExitPolicyReadback) {
        pendingExitPolicyReadback = false;
        setTimeout(() => {
          if (exitPolicyReadbacks >= 2)
            writeFileSync(${JSON.stringify(completionPath)}, "done");
          process.stdout.write("false\\0" + marker + "\\0");
        }, 700);
      } else if (pendingDetach) {
        pendingDetach = false;
        setTimeout(() => {
          process.stdout.write(marker + "\\0");
        }, 700);
      } else process.stdout.write(marker + "\\0");
    }
    else process.stdout.write("\\0");
  }
});
`,
  );
  await chmod(provider, 0o700);
  return provider;
};

const createReusedPidPtraceProvider = async (
  pid: number,
  providerDirectory: string,
  commandsPath: string,
): Promise<string> => {
  const provider = join(providerDirectory, "fake-rizin-reused-pid.mjs");
  await writeFile(
    provider,
    `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
process.stdout.write("\\0");
let input = "";
let detached = false;
let exitPolicyReadbacks = 0;
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  input += chunk;
  for (;;) {
    const boundary = input.indexOf("\\n"); if (boundary < 0) break;
    const line = input.slice(0, boundary); input = input.slice(boundary + 1);
    appendFileSync(${JSON.stringify(commandsPath)}, line + "\\n");
    if (line === "olj") process.stdout.write((detached ? "[]" : JSON.stringify([{ fd: 12, raised: true, uri: "ptrace://${pid}" }])) + "\\0");
    else if (line === "e dbg.exitkills") process.stdout.write((exitPolicyReadbacks++ === 0 ? "true" : "false") + "\\0");
    else if (line === "o- 12") detached = true;
    else if (line.startsWith("!echo ")) process.stdout.write(line.slice(6) + "\\0");
    else process.stdout.write("\\0");
  }
});
`,
  );
  await chmod(provider, 0o700);
  return provider;
};

const createStaleRowAfterDetachProvider = async (
  stalePid: number,
  livePid: number,
  commandsPath: string,
): Promise<string> => {
  const provider = join(directory!, "fake-rizin-stale-row-after-detach.mjs");
  await writeFile(
    provider,
    `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
process.stdout.write("\\0");
let input = "";
let inventoryReads = 0;
let detached = false;
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  input += chunk;
  for (;;) {
    const boundary = input.indexOf("\\n"); if (boundary < 0) break;
    const line = input.slice(0, boundary); input = input.slice(boundary + 1);
    appendFileSync(${JSON.stringify(commandsPath)}, line + "\\n");
    if (line === "olj") {
      inventoryReads += 1;
      const rows = detached || inventoryReads > 2
        ? [{ fd: 12, raised: true, uri: "ptrace://${stalePid}" }]
        : [
            { fd: 12, raised: true, uri: "ptrace://${stalePid}" },
            { fd: 13, raised: true, uri: "ptrace://${livePid}" },
          ];
      process.stdout.write(JSON.stringify(rows) + "\\0");
    }
    else if (line === "e dbg.exitkills") process.stdout.write("false\\0");
    else if (line === "o- 13") detached = true;
    else if (line.startsWith("!echo ")) process.stdout.write(line.slice(6) + "\\0");
    else process.stdout.write("\\0");
  }
});
`,
  );
  await chmod(provider, 0o700);
  return provider;
};

const createOmittedInferiorProvider = async (
  firstPid: number,
  retainedPid: number,
  commandsPath: string,
): Promise<string> => {
  const provider = join(directory!, "fake-rizin-omitted-inferior.mjs");
  await writeFile(
    provider,
    `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
process.stdout.write("\\0");
let input = "";
let inventory = 0;
let detached = false;
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  input += chunk;
  for (;;) {
    const boundary = input.indexOf("\\n"); if (boundary < 0) break;
    const line = input.slice(0, boundary); input = input.slice(boundary + 1);
    appendFileSync(${JSON.stringify(commandsPath)}, line + "\\n");
    if (line === "olj") {
      inventory += 1;
      const rows = detached ? [] : inventory === 1
        ? [{ fd: 12, raised: true, uri: "ptrace://${firstPid}" }, { fd: 13, raised: true, uri: "ptrace://${retainedPid}" }]
        : [{ fd: 13, raised: true, uri: "ptrace://${retainedPid}" }];
      process.stdout.write(JSON.stringify(rows) + "\\0");
    }
    else if (line === "e dbg.exitkills") process.stdout.write("false\\0");
    else if (line.startsWith("o- ")) detached = true;
    else if (line.startsWith("!echo ")) process.stdout.write(line.slice(6) + "\\0");
    else process.stdout.write("\\0");
  }
});
`,
  );
  await chmod(provider, 0o700);
  return provider;
};

const createNewOmittedInferiorProvider = async (
  firstPid: number,
  newPid: number,
  commandsPath: string,
): Promise<string> => {
  const provider = join(directory!, "fake-rizin-new-omitted-inferior.mjs");
  await writeFile(
    provider,
    `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
process.stdout.write("\\0");
let input = "";
let inventory = 0;
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  input += chunk;
  for (;;) {
    const boundary = input.indexOf("\\n"); if (boundary < 0) break;
    const line = input.slice(0, boundary); input = input.slice(boundary + 1);
    appendFileSync(${JSON.stringify(commandsPath)}, line + "\\n");
    if (line === "olj") {
      inventory += 1;
      const rows = inventory === 1
        ? [{ fd: 12, raised: true, uri: "ptrace://${firstPid}" }]
        : inventory === 2
          ? [{ fd: 13, raised: true, uri: "ptrace://${newPid}" }]
          : [];
      process.stdout.write(JSON.stringify(rows) + "\\0");
    }
    else if (line === "e dbg.exitkills") process.stdout.write("false\\0");
    else if (line.startsWith("!echo ")) process.stdout.write(line.slice(6) + "\\0");
    else process.stdout.write("\\0");
  }
});
`,
  );
  await chmod(provider, 0o700);
  return provider;
};

it("keeps persistent Rizin sessions unavailable on Windows", async () => {
  const rizin = await createRizinTestManager(
    { REA_RIZIN_COMMAND: "/missing/rizin" },
    { platform: "win32" },
  ).start({
    path: "/tmp/fixture.bin",
    inferior_tty: "unused-before-platform-admission",
  });
  expect(rizin.ok).toBe(false);
  if (!rizin.ok) {
    expect(rizin.error._tag).toBe("AnalysisCapabilityUnavailableError");
    expect(rizin.error.message).toContain("Linux /proc descriptor readback");
  }
});

it.skipIf(process.platform === "win32")(
  "rejects startup when Rizin exits immediately after its initial frame",
  async () => {
    const injected = createInjectedProcess({
      startup: (control) => {
        control.output(Buffer.from("startup diagnostic\0partial trailing"));
        control.exit();
      },
    });
    const manager = createRizinTestManager(
      { REA_RIZIN_COMMAND: "injected-rizin" },
      { spawnProcess: injected.spawnProcess },
    );
    managers.push(manager);

    const started = await manager.start({
      path: "/tmp/fixture.bin",
      inferior_tty: await rizinTestInferiorTty(),
    });

    expect(started.ok).toBe(false);
    if (!started.ok) {
      expect(started.error._tag).toBe("AnalysisCapabilityUnavailableError");
      expect(started.error.message).toContain("exited");
      expect(started.error.message).not.toContain("timed out");
      expect(started.error.capturedOutput).toMatchObject({
        stdout: "startup diagnostic\npartial trailing",
        stderr: "",
        truncated: false,
      });
    }
  },
);

it.skipIf(process.platform === "win32")(
  "preserves partial Rizin stdout when startup times out before its first frame",
  async () => {
    const injected = createInjectedProcess({
      startup: (control) => control.output("partial startup diagnostic"),
    });
    const manager = createRizinTestManager(
      { REA_RIZIN_COMMAND: "injected-rizin" },
      { spawnProcess: injected.spawnProcess, startupTimeoutMs: 25 },
    );
    managers.push(manager);

    const started = await manager.start({
      path: "/tmp/fixture.bin",
      inferior_tty: await rizinTestInferiorTty(),
    });

    expect(started.ok).toBe(false);
    if (!started.ok) {
      expect(started.error._tag).toBe("AnalysisTimeoutError");
      expect(started.error.capturedOutput).toMatchObject({
        stdout: expect.stringContaining("partial startup diagnostic"),
        stderr: "",
        truncated: false,
      });
    }
  },
);

it.skipIf(process.platform === "win32")(
  "keeps session UTF-8 status cumulative while command evidence reports only its frames",
  async () => {
    directory = await mkdtemp(join(tmpdir(), "rea-rizin-command-utf8-scope-"));
    const provider = join(directory, "fake-rizin-command-utf8-scope.mjs");
    await writeFile(
      provider,
      `#!/usr/bin/env node
process.stdout.write(Buffer.from([0xff, 0]));
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  input += chunk;
  for (;;) {
    const boundary = input.indexOf("\\n"); if (boundary < 0) break;
    const line = input.slice(0, boundary); input = input.slice(boundary + 1);
    if (line === "invalid-output") process.stdout.write(Buffer.from([0xfe, 0]));
    else if (!line.startsWith("!echo ")) process.stdout.write("valid output\\0");
    else process.stdout.write(line.slice(6) + "\\0");
  }
});
`,
    );
    await chmod(provider, 0o700);
    const { manager, sessionId } = await startRizinWithProvider(provider);
    if (sessionId === undefined) return;

    expect(manager.status(sessionId)?.output_invalid_utf8).toBe(true);
    const firstValid = await manager.execute(sessionId, "valid-before-invalid");
    expect(firstValid.ok).toBe(true);
    if (firstValid.ok) {
      expect(firstValid.value.result).not.toHaveProperty("output_invalid_utf8");
      expect(firstValid.value.evidence.raw_result).not.toHaveProperty(
        "output_invalid_utf8",
      );
      expect(firstValid.value.evidence.normalized_result).not.toHaveProperty(
        "output_invalid_utf8",
      );
      expect(firstValid.value.evidence.limitations.join(" ")).not.toContain(
        "Collected command frames contained invalid UTF-8 bytes",
      );
    }

    const invalid = await manager.execute(sessionId, "invalid-output");
    expect(invalid.ok).toBe(true);
    if (invalid.ok) {
      expect(invalid.value.result.output_invalid_utf8).toBe(true);
      expect(invalid.value.evidence.raw_result).toMatchObject({
        output_invalid_utf8: true,
      });
      expect(invalid.value.evidence.normalized_result).toMatchObject({
        output_invalid_utf8: true,
      });
      expect(invalid.value.evidence.limitations.join(" ")).toContain(
        "Collected command frames contained invalid UTF-8 bytes; decoded text may contain replacement characters.",
      );
    }

    const laterValid = await manager.execute(sessionId, "valid-after-invalid");
    expect(laterValid.ok).toBe(true);
    if (laterValid.ok) {
      expect(laterValid.value.result).not.toHaveProperty("output_invalid_utf8");
      expect(laterValid.value.evidence.raw_result).not.toHaveProperty(
        "output_invalid_utf8",
      );
      expect(laterValid.value.evidence.normalized_result).not.toHaveProperty(
        "output_invalid_utf8",
      );
      expect(laterValid.value.evidence.limitations.join(" ")).not.toContain(
        "Collected command frames contained invalid UTF-8 bytes",
      );
    }
    expect(manager.status(sessionId)?.output_invalid_utf8).toBe(true);
  },
);

it.skipIf(process.platform !== "linux")(
  "reuses a successful Rizin detach that completed after the cleanup timeout",
  async () => {
    const tty = await rizinTestInferiorTty();
    const inferior = await spawnTestInferiorOnTty(tty);
    const pid = inferior.pid;
    expect(pid).toBeDefined();
    if (pid === undefined) return;
    directory = await mkdtemp(join(tmpdir(), "rea-rizin-late-detach-"));
    const completionPath = join(directory, "complete");
    const provider = await createLateDetachProvider(
      pid,
      directory,
      completionPath,
    );
    let resolveDetachVerified!: (value: boolean) => void;
    const detachVerified = new Promise<boolean>((resolve) => {
      resolveDetachVerified = resolve;
    });
    const manager = new RizinDebugSessionManager(
      { ...process.env, REA_RIZIN_COMMAND: provider },
      {
        platform: "linux",
        onInferiorDetachVerified: (result: { readonly status: string }) =>
          resolveDetachVerified(result.status === "detached"),
        spawnProcess: async (options) => {
          const launched = await spawnOwnedProviderProcess(options);
          ownedProviderProcesses.push(launched.process);
          return launched;
        },
      },
    );
    managers.push(manager);
    const started = await manager.start({
      path: "/tmp/fixture.bin",
      inferior_tty: tty,
    });
    expect(started.ok).toBe(true);
    if (!started.ok) return;

    const firstClose = await manager.close(started.value.session_id);
    expect(firstClose.ok).toBe(false);
    if (!firstClose.ok)
      expect(firstClose.error.message).toContain("not verified within 1000 ms");

    const completion = await Promise.race([
      detachVerified,
      new Promise<boolean>((resolve) =>
        setTimeout(() => resolve(false), 4_000),
      ),
    ]);
    expect(completion).toBe(true);
    expect(await readFile(completionPath, "utf8")).toBe("done");

    const retried = await manager.retryCleanupFailures();
    expect(
      retried,
      JSON.stringify(manager.status(started.value.session_id)),
    ).toEqual({
      ok: true,
      value: null,
    });
    expect(manager.status(started.value.session_id)).toBeUndefined();
    expect(inferior.exitCode).toBeNull();
  },
);

it.skipIf(process.platform !== "linux")(
  "reconciles a stale Rizin PID row only when the replacement is not traced by the owned debugger",
  async () => {
    directory = await mkdtemp(join(tmpdir(), "rea-rizin-reused-pid-"));
    const commandsPath = join(directory, "commands");
    const provider = await createReusedPidPtraceProvider(
      45_678,
      directory,
      commandsPath,
    );
    const identityObservations: string[] = [];
    const manager = new RizinDebugSessionManager(
      { ...process.env, REA_RIZIN_COMMAND: provider },
      {
        platform: "linux",
        readProcessStartTime: async () => {
          const observed = identityObservations.length === 0 ? "100" : "200";
          identityObservations.push(observed);
          return observed;
        },
        readProcessTracerPid: async () => 0,
        readProcessTaskIds: async () => new Set(),
        spawnProcess: async (options) => {
          const launched = await spawnOwnedProviderProcess(options);
          ownedProviderProcesses.push(launched.process);
          return launched;
        },
      },
    );
    managers.push(manager);
    const started = await manager.start({
      path: "/tmp/fixture.bin",
      inferior_tty: await rizinTestInferiorTty(),
    });
    expect(started.ok).toBe(true);
    if (!started.ok) return;

    expect((await manager.close(started.value.session_id)).ok).toBe(false);
    expect((await manager.retryCleanupFailures()).ok).toBe(false);
    expect(await manager.retryCleanupFailures()).toEqual({
      ok: true,
      value: null,
    });

    expect(identityObservations[0]).toBe("100");
    expect(
      identityObservations.slice(1).every((value) => value === "200"),
    ).toBe(true);
    expect(await readFile(commandsPath, "utf8")).not.toContain("o- 12");
    expect(manager.status(started.value.session_id)).toBeUndefined();
  },
);

it.skipIf(process.platform !== "linux")(
  "retains selected detach proof while another active inferior blocks cleanup",
  async () => {
    const tty = await rizinTestInferiorTty();
    const selected = await spawnTestInferiorOnTty(tty);
    const additional = await spawnTestInferiorOnTty(tty);
    const selectedPid = selected.pid;
    const additionalPid = additional.pid;
    expect(selectedPid).toBeDefined();
    expect(additionalPid).toBeDefined();
    if (selectedPid === undefined || additionalPid === undefined) return;
    directory = await mkdtemp(join(tmpdir(), "rea-rizin-active-row-retry-"));
    const commandsPath = join(directory, "commands");
    const provider = await createAdditionalActiveAfterDetachProvider(
      selectedPid,
      additionalPid,
      commandsPath,
    );
    const { manager, sessionId } = await startRizinWithOwnedStop(provider);

    expect((await manager.close(sessionId)).ok).toBe(false);
    expect(manager.status(sessionId)).toBeDefined();
    expect(selected.exitCode).toBeNull();

    expect((await manager.retryCleanupFailures()).ok).toBe(false);
    expect(manager.status(sessionId)).toBeDefined();
    expect(selected.exitCode).toBeNull();

    const additionalExit = new Promise<void>((resolve) =>
      additional.once("exit", () => resolve()),
    );
    additional.kill("SIGTERM");
    await additionalExit;
    expect(await manager.retryCleanupFailures()).toEqual({
      ok: true,
      value: null,
    });
    expect(
      (await readFile(commandsPath, "utf8")).match(/^o- 12$/gm),
    ).toHaveLength(1);
    expect(selected.exitCode).toBeNull();
    expect(manager.status(sessionId)).toBeUndefined();
  },
);

it.skipIf(process.platform !== "linux")(
  "invalidates selected detach proof when a stale selected row hides another active inferior",
  async () => {
    const tty = await rizinTestInferiorTty();
    const selected = await spawnTestInferiorOnTty(tty);
    const additional = await spawnTestInferiorOnTty(tty);
    const selectedPid = selected.pid;
    const additionalPid = additional.pid;
    expect(selectedPid).toBeDefined();
    expect(additionalPid).toBeDefined();
    if (selectedPid === undefined || additionalPid === undefined) return;
    directory = await mkdtemp(join(tmpdir(), "rea-rizin-stale-proof-retry-"));
    const commandsPath = join(directory, "commands");
    const provider = await createStaleSelectedRowWithActiveAdditionalProvider(
      selectedPid,
      additionalPid,
      commandsPath,
    );
    const { manager, sessionId } = await startRizinWithOwnedStop(provider);

    expect((await manager.close(sessionId)).ok).toBe(false);
    expect((await manager.retryCleanupFailures()).ok).toBe(false);
    expect(manager.status(sessionId)).toBeDefined();
    expect(selected.exitCode).toBeNull();
    expect(additional.exitCode).toBeNull();

    const additionalExit = new Promise<void>((resolve) =>
      additional.once("exit", () => resolve()),
    );
    additional.kill("SIGTERM");
    await additionalExit;
    expect(await manager.retryCleanupFailures()).toEqual({
      ok: true,
      value: null,
    });
    expect(selected.exitCode).toBeNull();
    expect(manager.status(sessionId)).toBeUndefined();
  },
);

it.skipIf(process.platform !== "linux")(
  "reconciles a completed detach after its first inventory readback is malformed",
  async () => {
    const tty = await rizinTestInferiorTty();
    const inferior = await spawnTestInferiorOnTty(tty);
    const pid = inferior.pid;
    expect(pid).toBeDefined();
    if (pid === undefined) return;
    directory = await mkdtemp(
      join(tmpdir(), "rea-rizin-detach-readback-retry-"),
    );
    const commandsPath = join(directory, "commands");
    const provider = await createMalformedDetachReadbackProvider(
      pid,
      commandsPath,
    );
    const { manager, sessionId } = await startRizinWithOwnedStop(provider);
    expect((await manager.close(sessionId)).ok).toBe(false);
    expect(await manager.retryCleanupFailures()).toEqual({
      ok: true,
      value: null,
    });
    expect(
      (await readFile(commandsPath, "utf8")).match(/^o- 12$/gm),
    ).toHaveLength(1);
    expect(inferior.exitCode).toBeNull();
    expect(manager.status(sessionId)).toBeUndefined();
  },
);

it.skipIf(process.platform !== "linux")(
  "retries detach after a definitive readback still shows the selected inferior",
  async () => {
    const tty = await rizinTestInferiorTty();
    const inferior = await spawnTestInferiorOnTty(tty);
    const pid = inferior.pid;
    expect(pid).toBeDefined();
    if (pid === undefined) return;
    directory = await mkdtemp(join(tmpdir(), "rea-rizin-retryable-detach-"));
    const commandsPath = join(directory, "commands");
    const provider = await createRetryableDetachProvider(pid, commandsPath);
    const { manager, sessionId } = await startRizinWithOwnedStop(provider);

    expect((await manager.close(sessionId)).ok).toBe(false);
    expect(manager.status(sessionId)).toBeDefined();
    expect(inferior.exitCode).toBeNull();

    expect(await manager.retryCleanupFailures()).toEqual({
      ok: true,
      value: null,
    });
    expect(
      (await readFile(commandsPath, "utf8")).match(/^o- 12$/gm),
    ).toHaveLength(2);
    expect(inferior.exitCode).toBeNull();
    expect(manager.status(sessionId)).toBeUndefined();
  },
);

it.skipIf(process.platform !== "linux")(
  "preserves confirmed detach when an unrelated stale Rizin row survives readback",
  async () => {
    const tty = await rizinTestInferiorTty();
    const inferior = await spawnTestInferiorOnTty(tty);
    const livePid = inferior.pid;
    expect(livePid).toBeDefined();
    if (livePid === undefined) return;
    const stalePid = 45_678;
    directory = await mkdtemp(join(tmpdir(), "rea-rizin-stale-row-readback-"));
    const commandsPath = join(directory, "commands");
    const provider = await createStaleRowAfterDetachProvider(
      stalePid,
      livePid,
      commandsPath,
    );
    const staleIdentityReads: string[] = [];
    const manager = new RizinDebugSessionManager(
      { ...process.env, REA_RIZIN_COMMAND: provider },
      {
        platform: "linux",
        readProcessStartTime: async (pid) => {
          if (pid !== String(stalePid)) return "300";
          const observed = staleIdentityReads.length === 0 ? "100" : "200";
          staleIdentityReads.push(observed);
          return observed;
        },
        readProcessTracerPid: async () => 0,
        readProcessTaskIds: async () => new Set(),
        spawnProcess: async (options) => {
          const launched = await spawnOwnedProviderProcess(options);
          ownedProviderProcesses.push(launched.process);
          return launched;
        },
      },
    );
    managers.push(manager);
    const started = await manager.start({
      path: "/tmp/fixture.bin",
      inferior_tty: tty,
    });
    expect(started.ok).toBe(true);
    if (!started.ok) return;

    expect((await manager.close(started.value.session_id)).ok).toBe(false);
    expect(await manager.retryCleanupFailures()).toEqual({
      ok: true,
      value: null,
    });

    const commands = await readFile(commandsPath, "utf8");
    expect(commands.match(/^o- 13$/gm)).toHaveLength(1);
    expect(manager.status(started.value.session_id)).toBeUndefined();
    expect(inferior.exitCode).toBeNull();
  },
);

it.skipIf(process.platform !== "linux")(
  "does not ignore a reused PID that appears after a transient identity read failure",
  async () => {
    const tty = await rizinTestInferiorTty();
    const inferior = await spawnTestInferiorOnTty(tty);
    const livePid = inferior.pid;
    expect(livePid).toBeDefined();
    if (livePid === undefined) return;
    const stalePid = 45_679;
    directory = await mkdtemp(join(tmpdir(), "rea-rizin-reused-row-readback-"));
    const commandsPath = join(directory, "commands");
    const provider = await createStaleRowAfterDetachProvider(
      stalePid,
      livePid,
      commandsPath,
    );
    const staleIdentityReads: Array<string | null> = [
      "100", // first observed identity
      "200", // reused PID during retry inventory
      "200", // replacement identity recheck
      null, // transient disappearance in post-detach inventory
      "300", // a different identity appears at the same PID
      "300", // replacement identity stability check
    ];
    const tracerPids = [0, 777];
    const manager = new RizinDebugSessionManager(
      { ...process.env, REA_RIZIN_COMMAND: provider },
      {
        platform: "linux",
        readProcessStartTime: async (pid) => {
          if (pid !== String(stalePid)) return "300";
          const next = staleIdentityReads.shift();
          return next === undefined ? "300" : next;
        },
        readProcessTracerPid: async () => tracerPids.shift() ?? 777,
        readProcessTaskIds: async () => new Set(["777"]),
        spawnProcess: async (options) => {
          const launched = await spawnOwnedProviderProcess(options);
          ownedProviderProcesses.push(launched.process);
          return launched;
        },
      },
    );
    managers.push(manager);
    const started = await manager.start({
      path: "/tmp/fixture.bin",
      inferior_tty: tty,
    });
    expect(started.ok).toBe(true);
    if (!started.ok) return;

    expect((await manager.close(started.value.session_id)).ok).toBe(false);
    expect((await manager.retryCleanupFailures()).ok).toBe(false);

    const commands = await readFile(commandsPath, "utf8");
    expect(commands.match(/^o- 13$/gm)).toHaveLength(1);
    expect(manager.status(started.value.session_id)).toBeDefined();
    expect(inferior.exitCode).toBeNull();
  },
);

it.skipIf(process.platform !== "linux")(
  "retries descriptor verification after Rizin confirms detach without detaching twice",
  async () => {
    const ttyPath = await rizinTestInferiorTty();
    directory = await mkdtemp(join(tmpdir(), "rea-rizin-detached-sink-test-"));
    const statePath = join(directory, "inferior-input-state");
    const commandsPath = join(directory, "commands");
    const inferior = await spawnTestInferiorWithMutableInput(
      ttyPath,
      statePath,
    );
    const pid = inferior.pid;
    expect(pid).toBeDefined();
    if (pid === undefined) return;
    const provider = await createPostDetachInputTransitionProvider(
      pid,
      commandsPath,
    );
    const { manager, sessionId } = await startRizinWithOwnedStop(provider);
    expect(sessionId).toBeDefined();
    if (sessionId === undefined) return;

    const firstClose = await manager.close(sessionId);
    expect(firstClose.ok).toBe(false);
    if (!firstClose.ok) expect(firstClose.error.cleanupIncomplete).toBe(true);
    await expect.poll(() => readFile(statePath, "utf8")).toBe("unclassified");

    inferior.kill("SIGUSR2");
    await expect.poll(() => readFile(statePath, "utf8")).toBe("restored");
    expect(await manager.retryCleanupFailures()).toEqual({
      ok: true,
      value: null,
    });
    expect(
      (await readFile(commandsPath, "utf8")).match(/^o- 12$/gm),
    ).toHaveLength(1);
    expect(manager.status(sessionId)).toBeUndefined();
  },
);

it.skipIf(process.platform !== "linux")(
  "re-verifies output policy and descriptors for a replacement traced by the owned debugger",
  async () => {
    const inferior = await spawnTestInferiorOnTty(await rizinTestInferiorTty());
    const pid = inferior.pid;
    expect(pid).toBeDefined();
    if (pid === undefined) return;
    directory = await mkdtemp(
      join(tmpdir(), "rea-rizin-attached-replacement-"),
    );
    const commandsPath = join(directory, "commands");
    const provider = await createReusedPidPtraceProvider(
      pid,
      directory,
      commandsPath,
    );
    const identityObservations: string[] = [];
    const manager = new RizinDebugSessionManager(
      { ...process.env, REA_RIZIN_COMMAND: provider },
      {
        platform: "linux",
        readProcessStartTime: async () => {
          const observed = identityObservations.length === 0 ? "100" : "200";
          identityObservations.push(observed);
          return observed;
        },
        readProcessTracerPid: async () => 777,
        readProcessTaskIds: async () => new Set(["777"]),
        spawnProcess: async (options) => {
          const launched = await spawnOwnedProviderProcess(options);
          ownedProviderProcesses.push(launched.process);
          return launched;
        },
      },
    );
    managers.push(manager);
    const started = await manager.start({
      path: "/tmp/fixture.bin",
      inferior_tty: await rizinTestInferiorTty(),
    });
    expect(started.ok).toBe(true);
    if (!started.ok) return;

    expect((await manager.close(started.value.session_id)).ok).toBe(false);
    expect((await manager.retryCleanupFailures()).ok).toBe(false);
    expect(await manager.retryCleanupFailures()).toEqual({
      ok: true,
      value: null,
    });

    expect(identityObservations[0]).toBe("100");
    expect(
      identityObservations.slice(1).every((value) => value === "200"),
    ).toBe(true);
    expect(await readFile(commandsPath, "utf8")).toContain("o- 12");
    expect(manager.status(started.value.session_id)).toBeUndefined();
    expect(inferior.exitCode).toBeNull();
  },
);

it.skipIf(process.platform !== "linux")(
  "retains cleanup when Rizin cannot determine whether a replacement is still traced",
  async () => {
    directory = await mkdtemp(join(tmpdir(), "rea-rizin-unknown-replacement-"));
    const commandsPath = join(directory, "commands");
    const provider = await createReusedPidPtraceProvider(
      45_678,
      directory,
      commandsPath,
    );
    const identityObservations: string[] = [];
    let tracerKnown = false;
    const manager = new RizinDebugSessionManager(
      { ...process.env, REA_RIZIN_COMMAND: provider },
      {
        platform: "linux",
        readProcessStartTime: async () => {
          const observed = identityObservations.length === 0 ? "100" : "200";
          identityObservations.push(observed);
          return observed;
        },
        readProcessTracerPid: async () => {
          if (!tracerKnown) throw new Error("injected unreadable TracerPid");
          return 0;
        },
        readProcessTaskIds: async () => new Set(),
        spawnProcess: async (options) => {
          const launched = await spawnOwnedProviderProcess(options);
          ownedProviderProcesses.push(launched.process);
          return launched;
        },
      },
    );
    managers.push(manager);
    const started = await manager.start({
      path: "/tmp/fixture.bin",
      inferior_tty: await rizinTestInferiorTty(),
    });
    expect(started.ok).toBe(true);
    if (!started.ok) return;

    expect((await manager.close(started.value.session_id)).ok).toBe(false);
    expect((await manager.retryCleanupFailures()).ok).toBe(false);
    expect(await readFile(commandsPath, "utf8")).not.toContain("o- 12");
    expect(manager.status(started.value.session_id)?.state).toBe("closed");

    tracerKnown = true;
    expect((await manager.retryCleanupFailures()).ok).toBe(false);
    expect(await manager.retryCleanupFailures()).toEqual({
      ok: true,
      value: null,
    });
    expect(manager.status(started.value.session_id)).toBeUndefined();
  },
);

it.skipIf(process.platform !== "linux")(
  "does not forget an active inferior after descriptor failure and an empty retry inventory",
  async () => {
    const inferior = await spawnTestInferior();
    const pid = inferior.pid;
    expect(pid).toBeDefined();
    if (pid === undefined) return;
    const provider = await createRetryEmptyInventoryProvider(pid);
    const detachResults: string[] = [];
    const manager = new RizinDebugSessionManager(
      { ...process.env, REA_RIZIN_COMMAND: provider },
      {
        platform: "linux",
        spawnProcess: async (options) => {
          const launched = await spawnOwnedProviderProcess(options);
          ownedProviderProcesses.push(launched.process);
          return launched;
        },
        stopProcess: async (session) => {
          try {
            const detached = await session.detachInferior?.();
            detachResults.push(detached?.status ?? "missing-detach-capability");
          } catch (cause) {
            detachResults.push(
              cause instanceof Error ? cause.message : String(cause),
            );
          }
          return { status: "incomplete", reason: "injected retained debugger" };
        },
      },
    );
    managers.push(manager);
    const started = await manager.start({
      path: "/tmp/fixture.bin",
      inferior_tty: await rizinTestInferiorTty(),
    });
    expect(started.ok).toBe(true);
    if (!started.ok) return;

    expect((await manager.close(started.value.session_id)).ok).toBe(false);
    expect((await manager.retryCleanupFailures()).ok).toBe(false);

    expect(detachResults).toHaveLength(2);
    expect(detachResults[0]).toContain("descriptor 1");
    expect(detachResults[1]).toContain("still active");
    expect(manager.status(started.value.session_id)?.state).toBe("closed");
  },
);

it.skipIf(process.platform !== "linux")(
  "does not stop Rizin while a retained inferior is omitted from a non-empty retry inventory",
  async () => {
    const omitted = await spawnTestInferior();
    const retained = await spawnTestInferiorOnTty(await rizinTestInferiorTty());
    expect(omitted.pid).toBeDefined();
    expect(retained.pid).toBeDefined();
    if (omitted.pid === undefined || retained.pid === undefined) return;
    directory = await mkdtemp(join(tmpdir(), "rea-rizin-omitted-inferior-"));
    const commandsPath = join(directory, "commands");
    const provider = await createOmittedInferiorProvider(
      omitted.pid,
      retained.pid,
      commandsPath,
    );
    const detachResults: string[] = [];
    const manager = new RizinDebugSessionManager(
      { ...process.env, REA_RIZIN_COMMAND: provider },
      {
        platform: "linux",
        spawnProcess: async (options) => {
          const launched = await spawnOwnedProviderProcess(options);
          ownedProviderProcesses.push(launched.process);
          return launched;
        },
        stopProcess: async (session) => {
          try {
            detachResults.push(
              (await session.detachInferior?.())?.status ??
                "missing-detach-capability",
            );
          } catch (cause) {
            detachResults.push(
              cause instanceof Error ? cause.message : String(cause),
            );
          }
          return { status: "incomplete", reason: "injected retained debugger" };
        },
      },
    );
    managers.push(manager);
    const started = await manager.start({
      path: "/tmp/fixture.bin",
      inferior_tty: await rizinTestInferiorTty(),
    });
    expect(started.ok).toBe(true);
    if (!started.ok) return;

    expect((await manager.close(started.value.session_id)).ok).toBe(false);
    expect((await manager.retryCleanupFailures()).ok).toBe(false);
    expect(detachResults[0]).toContain(
      "multiple or ambiguous ptrace inferiors",
    );
    expect(detachResults[1]).toContain(
      `omitted retained inferior PID ${omitted.pid} from the ptrace inventory while it is still active`,
    );
    expect(await readFile(commandsPath, "utf8")).not.toContain("o- 13");

    omitted.kill("SIGTERM");
    await new Promise<void>((resolve) => omitted.once("exit", () => resolve()));
    expect((await manager.retryCleanupFailures()).ok).toBe(false);
    expect(detachResults[2]).toBe("detached");
    expect(await readFile(commandsPath, "utf8")).toContain("o- 13");
  },
);

it.skipIf(process.platform !== "linux")(
  "retains newly observed inferiors when a retry omits an earlier active target",
  async () => {
    const omitted = await spawnTestInferior();
    const newlyObserved = await spawnTestInferiorOnTty(
      await rizinTestInferiorTty(),
    );
    expect(omitted.pid).toBeDefined();
    expect(newlyObserved.pid).toBeDefined();
    if (omitted.pid === undefined || newlyObserved.pid === undefined) return;
    directory = await mkdtemp(join(tmpdir(), "rea-rizin-new-omitted-"));
    const commandsPath = join(directory, "commands");
    const provider = await createNewOmittedInferiorProvider(
      omitted.pid,
      newlyObserved.pid,
      commandsPath,
    );
    const detachResults: string[] = [];
    const manager = new RizinDebugSessionManager(
      { ...process.env, REA_RIZIN_COMMAND: provider },
      {
        platform: "linux",
        spawnProcess: async (options) => {
          const launched = await spawnOwnedProviderProcess(options);
          ownedProviderProcesses.push(launched.process);
          return launched;
        },
        stopProcess: async (session) => {
          try {
            detachResults.push(
              (await session.detachInferior?.())?.status ??
                "missing-detach-capability",
            );
          } catch (cause) {
            detachResults.push(
              cause instanceof Error ? cause.message : String(cause),
            );
          }
          return { status: "incomplete", reason: "injected retained debugger" };
        },
      },
    );
    managers.push(manager);
    const started = await manager.start({
      path: "/tmp/fixture.bin",
      inferior_tty: await rizinTestInferiorTty(),
    });
    expect(started.ok).toBe(true);
    if (!started.ok) return;

    expect((await manager.close(started.value.session_id)).ok).toBe(false);
    expect((await manager.retryCleanupFailures()).ok).toBe(false);
    expect(detachResults[0]).toContain("descriptor 1");
    expect(detachResults[1]).toContain(
      `omitted retained inferior PID ${omitted.pid}`,
    );

    omitted.kill("SIGTERM");
    await new Promise<void>((resolve) => omitted.once("exit", () => resolve()));
    expect((await manager.retryCleanupFailures()).ok).toBe(false);
    expect(detachResults[2]).toContain(
      `identified PID ${newlyObserved.pid} is still active`,
    );
    expect(await readFile(commandsPath, "utf8")).not.toContain("o- 13");

    newlyObserved.kill("SIGTERM");
    await new Promise<void>((resolve) =>
      newlyObserved.once("exit", () => resolve()),
    );
    expect((await manager.retryCleanupFailures()).ok).toBe(false);
    expect(detachResults[3]).toBe("no-inferior");
  },
);

it.skipIf(process.platform !== "linux")(
  "clears retained Rizin cleanup after its identified inferior exits",
  async () => {
    const inferior = await spawnTestInferior();
    const pid = inferior.pid;
    expect(pid).toBeDefined();
    if (pid === undefined) return;
    const provider = await createInferiorInventoryProvider([{ fd: 12, pid }]);
    const { manager, sessionId, exitDebugger } =
      await startRizinWithOwnedStop(provider);
    if (sessionId === undefined) return;

    const firstClose = await manager.close(sessionId);

    expect(firstClose.ok, JSON.stringify(firstClose)).toBe(false);
    if (!firstClose.ok) expect(firstClose.error.cleanupIncomplete).toBe(true);
    await exitDebugger();
    expect((await manager.retryCleanupFailures()).ok).toBe(false);
    expect(manager.status(sessionId)?.state).toBe("closed");

    const inferiorExited = new Promise<void>((resolveExit) =>
      inferior.once("exit", () => resolveExit()),
    );
    inferior.kill("SIGTERM");
    await inferiorExited;
    const retried = await manager.retryCleanupFailures();

    expect(retried).toEqual({ ok: true, value: null });
    if (!firstClose.ok) expect(firstClose.error.cleanupIncomplete).toBe(false);
    expect(manager.status(sessionId)).toBeUndefined();
  },
);

it.skipIf(process.platform !== "linux")(
  "keeps Rizin cleanup unknown when an inferior inventory is only partially captured",
  async () => {
    const inferior = await spawnTestInferior();
    const pid = inferior.pid;
    expect(pid).toBeDefined();
    if (pid === undefined) return;
    const provider = await createInferiorInventoryProvider([
      { fd: 12, pid },
      { fd: 13, pid: 999_999_999 },
    ]);
    const { manager, sessionId, exitDebugger } =
      await startRizinWithOwnedStop(provider);
    if (sessionId === undefined) return;

    expect((await manager.close(sessionId)).ok).toBe(false);
    await exitDebugger();
    const closed = await manager.close(sessionId);

    expect(closed.ok, JSON.stringify(closed)).toBe(false);
    if (!closed.ok)
      expect(closed.error.message).toContain("no owner proof confirms");
    expect(manager.status(sessionId)).toBeDefined();
  },
);

it.skipIf(process.platform === "win32")(
  "retains Rizin cleanup when target state is unknown at debugger exit",
  async () => {
    directory = await mkdtemp(join(tmpdir(), "rea-rizin-unknown-target-"));
    const provider = join(directory, "fake-rizin-unknown-target.mjs");
    await writeFile(
      provider,
      `#!/usr/bin/env node
process.stdout.write("\\0");
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  input += chunk;
  for (;;) {
    const boundary = input.indexOf("\\n"); if (boundary < 0) break;
    const line = input.slice(0, boundary); input = input.slice(boundary + 1);
    if (line === "olj") process.stdout.write("not-json\\0");
    else if (line.startsWith("!echo ")) process.stdout.write(line.slice(6) + "\\0");
  }
});
`,
    );
    await chmod(provider, 0o700);
    const { manager, sessionId, exitDebugger } =
      await startRizinWithOwnedStop(provider);
    if (sessionId === undefined) return;

    expect((await manager.close(sessionId)).ok).toBe(false);
    await exitDebugger();
    const closed = await manager.close(sessionId);

    expect(closed.ok, JSON.stringify(closed)).toBe(false);
    if (!closed.ok)
      expect(closed.error.message).toContain("no owner proof confirms");
    expect(manager.status(sessionId)).toBeDefined();
  },
);

it.skipIf(process.platform === "win32")(
  "preserves command parameters in Rizin observation evidence",
  async () => {
    directory = await mkdtemp(join(tmpdir(), "rea-rizin-command-evidence-"));
    const provider = join(directory, "fake-rizin-command-evidence.mjs");
    const inferiorTty = await rizinTestInferiorTty();
    await writeFile(
      provider,
      `#!/usr/bin/env node
process.stdout.write("\\0");
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  input += chunk;
  for (;;) {
    const boundary = input.indexOf("\\n"); if (boundary < 0) break;
    const line = input.slice(0, boundary); input = input.slice(boundary + 1);
    if (!line.startsWith("!echo ")) process.stdout.write("command output\\0");
    else process.stdout.write(line.slice(6) + "\\0");
  }
});
`,
    );
    await chmod(provider, 0o700);
    const manager = createRizinTestManager({ REA_RIZIN_COMMAND: provider });
    managers.push(manager);
    const callerSelectedPath = "./relative/../fixture.bin";
    const resolvedPath = absoluteCallerPath(callerSelectedPath);
    const started = await manager.start({
      path: callerSelectedPath,
      inferior_tty: inferiorTty,
    });
    expect(started.ok).toBe(true);
    if (!started.ok) return;

    const executed = await manager.execute(started.value.session_id, "dr");

    expect(executed.ok).toBe(true);
    if (executed.ok)
      expect(executed.value.evidence.parameters).toEqual({
        session_id: started.value.session_id,
        command: "dr",
        inferior_tty: inferiorTty,
        launch_provenance: {
          caller_selected_path: callerSelectedPath,
          resolved_path: resolvedPath,
        },
      });
    if (executed.ok)
      expect(executed.value.evidence.limitations).toContain(
        "Launch provenance records the original and resolved startup paths; it does not establish the current target after unrestricted debugger commands.",
      );
  },
);

it.skipIf(process.platform === "win32")(
  "keeps queued Rizin commands serialized when a waiting request is cancelled",
  async () => {
    directory = await mkdtemp(join(tmpdir(), "rea-rizin-queue-cancel-"));
    const provider = join(directory, "fake-rizin-queue-cancel.mjs");
    const overlapPath = join(directory, "overlap");
    await writeFile(
      provider,
      `#!/usr/bin/env node
process.stdout.write("\\0");
let input = "";
let firstActive = false;
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  input += chunk;
  for (;;) {
    const boundary = input.indexOf("\\n"); if (boundary < 0) break;
    const line = input.slice(0, boundary); input = input.slice(boundary + 1);
    if (line === "first") firstActive = true;
    if (line === "third" && firstActive) import("node:fs/promises").then((fs) => fs.writeFile(${JSON.stringify(overlapPath)}, "overlap"));
    if (line.startsWith("!echo ")) {
      const marker = line.slice(6);
      if (firstActive) setTimeout(() => { firstActive = false; process.stdout.write(marker + "\\0"); }, 100);
      else process.stdout.write(marker + "\\0");
    }
  }
});
`,
    );
    await chmod(provider, 0o700);
    const { manager, sessionId } = await startRizinWithProvider(provider);
    if (sessionId === undefined) return;
    const first = manager.execute(sessionId, "first");
    const controller = new AbortController();
    const second = manager.execute(sessionId, "second", controller.signal);
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
    controller.abort();
    const third = manager.execute(sessionId, "third");
    expect((await second).ok).toBe(false);
    expect((await first).ok).toBe(true);
    expect((await third).ok).toBe(true);
    await expect(readFile(overlapPath, "utf8")).rejects.toThrow();
  },
);

it.skipIf(process.platform === "win32")(
  "preserves a truncated single Rizin frame that exceeds the protocol limit",
  async () => {
    directory = await mkdtemp(join(tmpdir(), "rea-rizin-frame-overflow-"));
    const provider = join(directory, "fake-rizin-frame-overflow.mjs");
    await writeFile(
      provider,
      `#!/usr/bin/env node
process.stdout.write("\\0");
let input = "";
let sent = false;
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  input += chunk;
  for (;;) {
    const boundary = input.indexOf("\\n"); if (boundary < 0) break;
    const line = input.slice(0, boundary); input = input.slice(boundary + 1);
    if (!line.startsWith("!echo ") && !sent) {
      sent = true;
      process.stdout.write("z".repeat(16 * 1024 * 1024 + 32) + "\\0");
    }
  }
});
`,
    );
    await chmod(provider, 0o700);
    const { manager, sessionId } = await startRizinWithProvider(provider);
    if (sessionId === undefined) return;

    const result = await manager.execute(sessionId, "px");

    expect(result.ok, result.ok ? "" : result.error.message).toBe(true);
    if (result.ok) {
      expect(
        Buffer.byteLength(result.value.result.output, "utf8"),
      ).toBeLessThanOrEqual(16 * 1024 * 1024);
      expect(result.value.result).toMatchObject({
        output_truncated: true,
        completion_status: "unknown",
      });
      expect(result.value.evidence.parameters).toMatchObject({
        session_id: sessionId,
        command: "px",
        inferior_tty: expect.any(String),
      });
    }
    expect(manager.status(sessionId)).toBeDefined();
  },
);

it.skipIf(process.platform === "win32")(
  "returns bounded partial Rizin output with unknown completion after overflow",
  async () => {
    directory = await mkdtemp(join(tmpdir(), "rea-rizin-output-overflow-"));
    const provider = join(directory, "fake-rizin-output-overflow.mjs");
    await writeFile(
      provider,
      `#!/usr/bin/env node
process.stdout.write("\\0");
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  input += chunk;
  for (;;) {
    const boundary = input.indexOf("\\n"); if (boundary < 0) break;
    const line = input.slice(0, boundary); input = input.slice(boundary + 1);
    if (line.startsWith("!echo ")) process.stdout.write(line.slice(6) + "\\0");
    else if (line === "olj") process.stdout.write(JSON.stringify([{ fd: 12, raised: true, uri: "ptrace://" + process.ppid }]) + "\\0");
    else if (line === "px") process.stdout.write("x".repeat(10 * 1024 * 1024) + "\\0" + "y".repeat(10 * 1024 * 1024) + "\\0");
    else process.stdout.write("\\0");
  }
});
`,
    );
    await chmod(provider, 0o700);
    const { manager, sessionId } = await startRizinWithProvider(provider);
    if (sessionId === undefined) return;

    const result = await manager.execute(sessionId, "px");

    expect(result.ok, result.ok ? "" : result.error.message).toBe(true);
    if (result.ok) {
      expect(
        Buffer.byteLength(result.value.result.output, "utf8"),
      ).toBeLessThanOrEqual(16 * 1024 * 1024);
      expect(result.value.result).toMatchObject({
        output_truncated: true,
        completion_status: "unknown",
      });
    }
    expect(manager.status(sessionId)).toBeDefined();
  },
);

it.skipIf(process.platform === "win32")(
  "waits for the Rizin process to exit when command correlation times out",
  async () => {
    directory = await mkdtemp(join(tmpdir(), "rea-rizin-command-timeout-"));
    const provider = join(directory, "fake-rizin-command-timeout.mjs");
    await writeFile(
      provider,
      `#!/usr/bin/env node
await import("node:fs/promises").then((fs) => fs.writeFile(${JSON.stringify(join(directory ?? "", "pid"))}, String(process.pid)));
process.stdout.write("\\0");
process.stdin.setEncoding("utf8");
process.stdin.on("data", () => process.stdout.write(Buffer.from([0xff, 0])));
`,
    );
    await chmod(provider, 0o700);
    const manager = createRizinTestManager(
      { REA_RIZIN_COMMAND: provider },
      { frameTimeoutMs: 40 },
    );
    managers.push(manager);
    const started = await manager.start({
      path: "/tmp/fixture.bin",
      inferior_tty: await rizinTestInferiorTty(),
    });
    expect(started.ok).toBe(true);
    if (!started.ok) return;

    const result = await manager.execute(started.value.session_id, "dr");

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.result).toMatchObject({
        output: "�",
        output_truncated: true,
        completion_status: "unknown",
        output_invalid_utf8: true,
      });
      expect(result.value.evidence.limitations).toContain(
        "Collected command frames contained invalid UTF-8 bytes; decoded text may contain replacement characters.",
      );
    }
    await expectOwnedProcessExited(
      await readFile(join(directory, "pid"), "utf8"),
    );
    expect(manager.status(started.value.session_id)?.state).toBe("closed");
  },
);

it.skipIf(process.platform === "win32")(
  "cancels a running Rizin command and retains its closed status",
  async () => {
    directory = await mkdtemp(join(tmpdir(), "rea-rizin-command-cancel-"));
    const provider = join(directory, "fake-rizin-command-cancel.mjs");
    await writeFile(
      provider,
      `#!/usr/bin/env node
process.stdout.write("\\0");
let input = "";
let stalled = false;
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  input += chunk;
  for (;;) {
    const boundary = input.indexOf("\\n"); if (boundary < 0) break;
    const line = input.slice(0, boundary); input = input.slice(boundary + 1);
    if (line === "slow") {
      stalled = true;
      process.stdout.write(Buffer.from([0xff, 0]));
    }
    else if (line.startsWith("!echo ") && !stalled) process.stdout.write(line.slice(6) + "\\n\\0");
  }
});
`,
    );
    await chmod(provider, 0o700);
    const manager = createRizinTestManager(
      { REA_RIZIN_COMMAND: provider },
      { frameTimeoutMs: 5_000 },
    );
    managers.push(manager);
    const callerSelectedPath = "./cancelled/../fixture.bin";
    const resolvedPath = absoluteCallerPath(callerSelectedPath);
    const started = await manager.start({
      path: callerSelectedPath,
      inferior_tty: await rizinTestInferiorTty(),
    });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 50);

    const result = await manager.execute(
      started.value.session_id,
      "slow",
      controller.signal,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error._tag).toBe("AnalysisCancelledError");
      expect(result.error.partialObservation).toMatchObject({
        normalized_result: { output_invalid_utf8: true },
        limitations: expect.arrayContaining([
          "Collected command frames contained invalid UTF-8 bytes; decoded text may contain replacement characters.",
        ]),
        parameters: {
          launch_provenance: {
            caller_selected_path: callerSelectedPath,
            resolved_path: resolvedPath,
          },
        },
      });
    }
    expect(manager.status(started.value.session_id)?.state).toBe("closed");
  },
);

it.skipIf(process.platform === "win32")(
  "reports bounded Rizin stderr retention in session status",
  async () => {
    directory = await mkdtemp(join(tmpdir(), "rea-rizin-diagnostic-limit-"));
    const provider = join(directory, "fake-rizin-diagnostic-limit.mjs");
    await writeFile(
      provider,
      `#!/usr/bin/env node
process.stderr.write("x".repeat(100000));
process.stdout.write("\\0");
process.stdin.resume();
`,
    );
    await chmod(provider, 0o700);
    const manager = createRizinTestManager({
      REA_RIZIN_COMMAND: provider,
    });
    managers.push(manager);
    const started = await manager.start({
      path: "/tmp/fixture.bin",
      inferior_tty: await rizinTestInferiorTty(),
    });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));

    expect(
      manager.status(started.value.session_id)?.diagnostics_truncated,
    ).toBe(true);
  },
);

it.skipIf(process.platform === "win32")(
  "returns cancellation when Rizin startup is cancelled after spawn",
  async () => {
    directory = await mkdtemp(join(tmpdir(), "rea-rizin-start-cancel-"));
    const provider = join(directory, "fake-rizin-start-cancel.mjs");
    await writeFile(
      provider,
      `#!/usr/bin/env node\nprocess.stdin.resume();\nsetInterval(() => {}, 1000);\n`,
    );
    await chmod(provider, 0o700);
    const manager = createRizinTestManager({
      REA_RIZIN_COMMAND: provider,
    });
    managers.push(manager);
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 50);

    const started = await manager.start(
      { path: "/tmp/fixture.bin", inferior_tty: await rizinTestInferiorTty() },
      controller.signal,
    );

    expect(started.ok).toBe(false);
    if (!started.ok) expect(started.error._tag).toBe("AnalysisCancelledError");
  },
);

it.skipIf(process.platform === "win32")(
  "converts a Rizin stdin pipe failure into a provider session error",
  async () => {
    directory = await mkdtemp(join(tmpdir(), "rea-rizin-stdin-error-"));
    const provider = join(directory, "fake-rizin-stdin-error.mjs");
    await writeFile(
      provider,
      `#!/usr/bin/env node
process.stdout.write("\\0");
setTimeout(() => import("node:fs").then((fs) => fs.closeSync(0)), 40);
setInterval(() => {}, 1000);
`,
    );
    await chmod(provider, 0o700);
    const manager = createRizinTestManager({
      REA_RIZIN_COMMAND: provider,
    });
    managers.push(manager);
    const started = await manager.start({
      path: "/tmp/fixture.bin",
      inferior_tty: await rizinTestInferiorTty(),
    });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 80));

    const result = await manager.execute(started.value.session_id, "dr");

    expect(result.ok).toBe(false);
    expect(manager.status(started.value.session_id)?.state).toBe("closed");
  },
);

it.skipIf(process.platform === "win32")(
  "preserves Rizin process-exit reason and partial command output",
  async () => {
    directory = await mkdtemp(join(tmpdir(), "rea-rizin-command-exit-"));
    const provider = join(directory, "fake-rizin-command-exit.mjs");
    const writerPidPath = join(directory, "writer.pid");
    await writeFile(
      provider,
      `#!/usr/bin/env node
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
process.stdout.write("\\0");
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  input += chunk;
  for (;;) {
    const boundary = input.indexOf("\\n");
    if (boundary < 0) break;
    const line = input.slice(0, boundary); input = input.slice(boundary + 1);
    if (line === "exit-now") {
      const writer = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "inherit" });
      writeFileSync(${JSON.stringify(writerPidPath)}, String(writer.pid));
      process.stdout.write(Buffer.concat([Buffer.from("partial-before-exit\\0second-partial\\0"), Buffer.from([0xff, 0])]), () => process.exit(7));
    }
  }
});
`,
    );
    await chmod(provider, 0o700);
    let writerObserved = false;
    const manager = createRizinTestManager(
      { REA_RIZIN_COMMAND: provider },
      {
        stopProcess: async () => {
          const writerPid = Number(await readFile(writerPidPath, "utf8"));
          try {
            process.kill(writerPid, 0);
            writerObserved = true;
          } catch {
            writerObserved = false;
          }
          return {
            status: "incomplete",
            reason: "owned output writer is still active",
          };
        },
      },
    );
    managers.push(manager);
    const callerSelectedPath = "./exit/../fixture.bin";
    const resolvedPath = absoluteCallerPath(callerSelectedPath);
    const started = await manager.start({
      path: callerSelectedPath,
      inferior_tty: await rizinTestInferiorTty(),
    });
    expect(started.ok).toBe(true);
    if (!started.ok) return;

    const exited = await manager.execute(started.value.session_id, "exit-now");

    expect(exited.ok).toBe(false);
    expect(writerObserved).toBe(true);
    if (!exited.ok) {
      expect(exited.error.cleanup).toEqual({
        reason: "owned output writer is still active",
        resources: [started.value.session_id],
      });
      expect(exited.error.partialObservation).toMatchObject({
        normalized_result: {
          output: ["partial-before-exit", "second-partial", "�"].join("\n"),
          completion_status: "unknown",
          output_invalid_utf8: true,
        },
        parameters: {
          command: "exit-now",
          session_id: started.value.session_id,
          launch_provenance: {
            caller_selected_path: callerSelectedPath,
            resolved_path: resolvedPath,
          },
        },
      });
      const partialEvidence = evidenceSchema.parse(
        exited.error.partialObservation,
      );
      expect(partialEvidence.limitations.join(" ")).toContain(
        "Rizin exited before the command-completion marker; retained frame output is partial and command completion is unknown.",
      );
    }
    const writerPid = Number(await readFile(writerPidPath, "utf8"));
    process.kill(writerPid, "SIGKILL");
  },
);
