import type { FileHandle } from "node:fs/promises";
import { lstat, mkdtemp, open, rm } from "node:fs/promises";
import type { Stats } from "node:fs";
import { Readable } from "node:stream";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OwnedFileHandle } from "../../filesystem/OwnedFileHandle.js";
import {
  openRegularFile,
  RegularFileAdmissionFailure,
  sameRegularFileState,
} from "../../filesystem/RegularFile.js";
import { ArtifactReaderFailure } from "../ArtifactReader.js";
import { abortIfNeeded } from "../ArtifactHash.js";
import { readArtifactFileChunks } from "../readArtifactFileChunks.js";
import { pyInstallerMemberStream } from "./PyInstallerMemberStream.js";
import type { CArchiveEntry } from "./CArchiveLayout.js";
import type { PyInstallerMember } from "./CArchiveMembers.js";

interface StoredImage {
  readonly path: string;
  readonly initial: Stats;
}
export interface PyInstallerMemberSource {
  readonly source: Readable;
  readonly verify?: () => Promise<void>;
  readonly close?: (primary?: unknown) => Promise<void>;
}

/** The reader's operation scope drains work before retiring these private files. */
export class PyInstallerPyzStore {
  #root: string | undefined;
  #serial = 0;
  readonly #owners = new Map<FileHandle, OwnedFileHandle>();
  readonly #images = new Map<FileHandle, StoredImage>();

  async spool(
    handle: FileHandle,
    archiveStart: number,
    entry: CArchiveEntry,
    signal?: AbortSignal,
  ): Promise<{ handle: FileHandle; start: number }> {
    abortIfNeeded(signal);
    if (entry.compressedSize === 0)
      throw new ArtifactReaderFailure(
        "format",
        "Compressed PYZ image has no zlib bytes",
      );
    this.#root ??= await mkdtemp(join(tmpdir(), "rea-pyz-"));
    const path = join(this.#root, String(this.#serial++));
    const writer = await open(path, "wx", 0o600);
    this.#owners.set(writer, new OwnedFileHandle(writer));
    abortIfNeeded(signal);
    const source = readArtifactFileChunks(handle, {
      start: archiveStart + entry.offset,
      end: archiveStart + entry.offset + entry.compressedSize - 1,
      signal,
    });
    const stream = pyInstallerMemberStream(source, {
      compressed: true,
      header: undefined,
      expectedBytes: entry.uncompressedSize,
      maxBytes: entry.uncompressedSize,
      signal: signal ?? new AbortController().signal,
    });
    const copied = this.#writeImage(writer, stream.output, signal);
    const outcomes = await Promise.allSettled([stream.completion, copied]);
    // A failed native write can retire the upstream stream. Preserve that I/O
    // failure instead of replacing it with a secondary premature-close error.
    const copy = outcomes[1];
    if (copy?.status === "rejected") throw copy.reason;
    const decoded = outcomes[0];
    if (decoded?.status === "rejected") throw decoded.reason;
    await this.release(writer);
    abortIfNeeded(signal);
    const opened = await this.#admit(path, signal);
    this.#images.set(opened, { path, initial: await opened.stat() });
    return { handle: opened, start: 0 };
  }

  async release(handle: FileHandle): Promise<void> {
    const owner = this.#owners.get(handle);
    if (owner === undefined) return;
    await owner.close();
    this.#owners.delete(handle);
  }

  async memberSource(
    read: NonNullable<PyInstallerMember["read"]>,
    root: FileHandle | undefined,
    signal: AbortSignal,
  ): Promise<PyInstallerMemberSource> {
    let handle = read.kind === "carchive" ? root : read.handle;
    if (handle === undefined)
      throw new ArtifactReaderFailure(
        "unavailable",
        "PyInstaller archive is closed",
      );
    const image = read.kind === "pyz" ? this.#images.get(handle) : undefined;
    let verify: (() => Promise<void>) | undefined;
    let close: ((primary?: unknown) => Promise<void>) | undefined;
    if (image !== undefined) {
      handle = await this.#admit(image.path, signal);
      const opened = handle;
      verify = () => this.#verifyImage(opened, image);
      close = async (primary) => {
        try {
          await this.release(opened);
        } catch (cause: unknown) {
          throw ArtifactReaderFailure.withCleanup(
            primary ?? cause,
            ArtifactReaderFailure.cleanupObservation(cause, image.path),
          );
        }
      };
      await verify();
    }
    abortIfNeeded(signal);
    const start =
      read.kind === "carchive"
        ? read.archiveStart + read.source.offset
        : read.offset;
    const length =
      read.kind === "carchive" ? read.source.compressedSize : read.length;
    const source =
      length === 0
        ? Readable.from([])
        : readArtifactFileChunks(handle, {
            start,
            end: start + length - 1,
            signal,
          });
    source.on("error", () => undefined);
    return {
      source,
      ...(verify === undefined ? {} : { verify }),
      ...(close === undefined ? {} : { close }),
    };
  }

  async close(): Promise<void> {
    for (const [handle, owner] of this.#owners) {
      await owner.close();
      this.#owners.delete(handle);
    }
    if (this.#root !== undefined) {
      await rm(this.#root, { recursive: true, force: true });
      this.#root = undefined;
    }
    this.#images.clear();
  }

  async #admit(path: string, signal?: AbortSignal): Promise<FileHandle> {
    try {
      const handle = await openRegularFile(path, {
        symlinks: "reject",
        signal,
      });
      this.#owners.set(handle, new OwnedFileHandle(handle));
      return handle;
    } catch (cause: unknown) {
      if (cause instanceof RegularFileAdmissionFailure)
        this.#owners.set(cause.owner.handle, cause.owner);
      throw cause;
    }
  }

  async #writeImage(
    handle: FileHandle,
    source: Readable,
    signal?: AbortSignal,
  ): Promise<void> {
    let position = 0;
    for await (const chunk of source as AsyncIterable<Buffer>) {
      // Stop writing after cancellation; drain only already-produced bytes so
      // the descriptor source can report its in-flight I/O outcome truthfully.
      if (signal?.aborted) continue;
      let offset = 0;
      try {
        while (offset < chunk.length) {
          const { bytesWritten } = await handle.write(
            chunk,
            offset,
            chunk.length - offset,
            position,
          );
          if (bytesWritten === 0)
            throw new ArtifactReaderFailure(
              "io",
              "Private PYZ write made no progress",
            );
          offset += bytesWritten;
          position += bytesWritten;
          if (signal?.aborted) break;
        }
      } catch (cause: unknown) {
        const failure =
          cause instanceof ArtifactReaderFailure
            ? cause
            : new ArtifactReaderFailure(
                "io",
                "Private PYZ image could not be written",
                { cause },
              );
        source.destroy(failure);
        throw failure;
      }
    }
    abortIfNeeded(signal);
  }

  async #verifyImage(handle: FileHandle, image: StoredImage): Promise<void> {
    const states = await Promise.all([handle.stat(), lstat(image.path)]);
    if (states.some((state) => !sameRegularFileState(image.initial, state)))
      throw new ArtifactReaderFailure(
        "integrity",
        "Private PYZ image changed after parsing",
      );
  }
}
