import { constants as fsConstants } from "node:fs";
import { readlink, realpath, stat } from "node:fs/promises";

/** Classification of an inferior's standard input after its debugger detaches. */
export type InferiorInputSink = "durable" | "not-inherited";

interface SelectedTerminal {
  readonly path: string;
  readonly dev: number | bigint;
  readonly ino: number | bigint;
}

const NULL_DEVICE = "/dev/null";

/**
 * Read Linux `/proc` descriptor 0 for an identified inferior.
 *
 * Standard input is durable when it is the caller-selected terminal and
 * independent of the debugger when it is a regular file or the null device.
 * Any other target, including a pipe that may be the debugger's own stdin, is
 * unproven.
 */
export const verifyInferiorInputSink = async (
  pid: string,
  terminal: SelectedTerminal,
): Promise<InferiorInputSink> => {
  if (process.platform !== "linux")
    throw new Error(
      "Inferior input descriptors can only be verified through Linux /proc.",
    );
  const descriptorPath = `/proc/${pid}/fd/0`;
  const destination = await readlink(descriptorPath);
  const observed = await stat(descriptorPath);
  const isCharacterDevice =
    (observed.mode & fsConstants.S_IFMT) === fsConstants.S_IFCHR;
  if (
    isCharacterDevice &&
    observed.dev === terminal.dev &&
    observed.ino === terminal.ino &&
    (await realpath(destination)) === terminal.path
  )
    return "durable";
  if (isCharacterDevice && destination === NULL_DEVICE) return "not-inherited";
  if ((observed.mode & fsConstants.S_IFMT) === fsConstants.S_IFREG)
    return "not-inherited";
  throw new Error(
    "Inferior standard input is neither the selected terminal, the null device, nor an open regular file; its independence from the debugger is unverified.",
  );
};
