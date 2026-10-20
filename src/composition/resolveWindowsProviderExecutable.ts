import { stat } from "node:fs/promises";
import { spawn } from "node:child_process";
import { win32 } from "node:path";

import { ProviderStartupDeadline } from "../process/ProviderDeadline.js";
import { ABORTED, waitForAbortable } from "../process/AbortablePromise.js";
import { PROVIDER_COMMAND_RESOLUTION_CAPACITY_ERROR_CODE } from "../application/reverse/ReverseEngineeringCommandPort.js";

export interface WindowsExecutableLookup {
  /** Windows-formatted working directory; defaults to the process CWD. */
  readonly cwd?: string;
  /** Test seam for Windows paths when running on a non-Windows host. */
  readonly isFile?: (
    path: string,
    signal?: AbortSignal,
  ) => boolean | Promise<boolean>;
  readonly signal?: AbortSignal | undefined;
  /** Total startup lookup budget, including stalled network filesystem probes. */
  readonly timeoutMs?: number;
  /** Track non-cancellable filesystem probes until their physical completion. */
  readonly onProbe?: (probe: Promise<unknown>) => void;
}
type WindowsFileProbe = NonNullable<WindowsExecutableLookup["isFile"]>;

/**
 * `\\server\share\...` and `//server/share/...` are UNC roots. A single
 * leading separator is drive- or root-relative, and four leading separators
 * are malformed rather than UNC, so neither may take this branch.
 */
const isUncPath = (value: string): boolean => /^[\\/]{2}(?![\\/])/u.test(value);

const splitWindowsPath = (value: string): readonly string[] => {
  const entries: string[] = [];
  let start = 0;
  let quoted = false;
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] === '"') quoted = !quoted;
    else if (value[index] === ";" && !quoted) {
      entries.push(value.slice(start, index));
      start = index + 1;
    }
  }
  entries.push(value.slice(start));
  return entries.flatMap((entry) => {
    if (entry.startsWith('"') && entry.endsWith('"') && entry.length >= 2)
      return [entry.slice(1, -1)];
    return entry.includes('"') ? [] : [entry];
  });
};

const isRegularFile = async (
  path: string,
  signal?: AbortSignal,
): Promise<boolean> => {
  if (isUncPath(path)) return isRegularFileInOwnedProcess(path, signal);
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
};

const isRegularFileInOwnedProcess = (
  path: string,
  signal?: AbortSignal,
): Promise<boolean> =>
  new Promise((resolve, reject) => {
    const isAborted = (): boolean => signal?.aborted === true;
    if (isAborted()) {
      reject(signal?.reason ?? new DOMException("Aborted", "AbortError"));
      return;
    }
    const child = spawn(
      process.execPath,
      [
        "-e",
        "const fs=require('node:fs');try{process.exitCode=fs.statSync(process.argv[1]).isFile()?0:1}catch{process.exitCode=1}",
        path,
      ],
      {
        stdio: "ignore",
        windowsHide: true,
        env:
          process.env.SystemRoot === undefined
            ? {}
            : { SystemRoot: process.env.SystemRoot },
      },
    );
    const cleanup = (): void => signal?.removeEventListener("abort", onAbort);
    const onAbort = (): void => {
      child.kill();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    child.once("error", (cause) => {
      cleanup();
      reject(cause);
    });
    child.once("exit", (code) => {
      cleanup();
      if (isAborted())
        reject(signal?.reason ?? new DOMException("Aborted", "AbortError"));
      else resolve(code === 0);
    });
    if (isAborted()) onAbort();
  });

const MAX_PENDING_WINDOWS_PATH_PROBES = 8;
let pendingWindowsPathProbes = 0;

const probeWindowsPathEntry = (
  isFile: WindowsFileProbe,
  path: string,
  onProbe?: (probe: Promise<unknown>) => void,
  signal?: AbortSignal,
): Promise<boolean> => {
  if (pendingWindowsPathProbes >= MAX_PENDING_WINDOWS_PATH_PROBES)
    throw Object.assign(
      new Error(
        "Windows provider PATH lookup capacity is exhausted by filesystem probes that have not settled.",
      ),
      { code: PROVIDER_COMMAND_RESOLUTION_CAPACITY_ERROR_CODE },
    );
  pendingWindowsPathProbes += 1;
  let probe: Promise<boolean>;
  try {
    probe = Promise.resolve(isFile(path, signal));
  } catch (cause) {
    pendingWindowsPathProbes -= 1;
    throw cause;
  }
  void probe.then(
    () => {
      pendingWindowsPathProbes -= 1;
    },
    () => {
      pendingWindowsPathProbes -= 1;
    },
  );
  onProbe?.(probe);
  return probe;
};

/** Resolve against every selected PATH entry within a cancellable startup budget. */
export const resolveWindowsProviderExecutable = async (
  executable: string,
  environment: Readonly<NodeJS.ProcessEnv>,
  lookup: WindowsExecutableLookup = {},
): Promise<string> => {
  lookup.signal?.throwIfAborted();
  const cwd = lookup.cwd ?? process.cwd();
  const absolute = (...paths: string[]): string => win32.resolve(cwd, ...paths);
  // A UNC selection is already absolute. Return it verbatim instead of
  // re-rooting it against the process drive through win32.resolve(cwd, ...).
  if (isUncPath(executable)) return executable;
  if (
    win32.isAbsolute(executable) ||
    executable.includes("/") ||
    executable.includes("\\") ||
    win32.parse(executable).root !== ""
  )
    return absolute(executable);

  const pathValue = environment.PATH ?? environment.Path ?? environment.path;
  if (pathValue === undefined) return executable;
  const pathEntries = splitWindowsPath(pathValue);
  const explicitExtension = win32.extname(executable).toLowerCase();
  if (explicitExtension !== "" && ![".com", ".exe"].includes(explicitExtension))
    return executable;
  const extensions =
    explicitExtension !== ""
      ? [""]
      : (environment.PATHEXT ?? environment.PathExt ?? ".COM;.EXE")
          .split(";")
          .filter((extension) =>
            [".com", ".exe"].includes(extension.toLowerCase()),
          );

  const isFile = lookup.isFile ?? isRegularFile;
  const deadline = new ProviderStartupDeadline(
    lookup.timeoutMs ?? 120_000,
    lookup.signal,
  );
  try {
    for (const entry of pathEntries) {
      if (entry.length === 0) continue;
      for (const extension of extensions) {
        deadline.signal.throwIfAborted();
        const candidate = isUncPath(entry)
          ? win32.join(entry, `${executable}${extension}`)
          : absolute(entry, `${executable}${extension}`);
        // Keep a handler on a late filesystem rejection after cancellation.
        const found = await waitForAbortable(
          probeWindowsPathEntry(
            isFile,
            candidate,
            lookup.onProbe,
            deadline.signal,
          ),
          deadline.signal,
        );
        if (found === ABORTED) deadline.signal.throwIfAborted();
        if (found) return candidate;
      }
    }
    return executable;
  } catch (cause) {
    if (deadline.interruption === "timeout")
      throw Object.assign(
        new Error(
          "Provider PATH lookup timed out; set an absolute REA_OBJDUMP_COMMAND or REA_RIZIN_COMMAND path.",
          { cause },
        ),
        { code: "ETIMEDOUT" },
      );
    throw cause;
  } finally {
    deadline.dispose();
  }
};
