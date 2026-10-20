import type { Readable } from "node:stream";
import { finished } from "node:stream/promises";
import { setImmediate } from "node:timers/promises";
import { jsonValueByteLength } from "../domain/jsonValueByteLength.js";
import type { JsonValue } from "../domain/jsonValue.js";
import { normalizeArtifactPath } from "./ArtifactPaths.js";
import { lstat, type FileHandle } from "node:fs/promises";

import type { PyInstallerMetadata } from "../domain/artifactFormatMetadata.js";
import {
  cookieMetadata,
  scriptPythonMagic,
} from "./pyinstaller/PyInstallerMetadata.js";
import { artifactExpansionBudgetBytes } from "../domain/artifactExpansionBudget.js";
import { OwnedFileHandle } from "../filesystem/OwnedFileHandle.js";
import {
  NonRegularFileReadError,
  RegularFileAdmissionFailure,
  RegularFileOperationCancelled,
  openRegularFile,
  sameRegularFileState,
  type StableRegularFileDescriptor,
} from "../filesystem/RegularFile.js";
import {
  ArtifactReaderFailure,
  sameArtifactEntry,
  type ArtifactEntry,
  type ArtifactReader,
} from "./ArtifactReader.js";
import { abortIfNeeded, hashReadable } from "./ArtifactHash.js";
import { readArtifactFileChunks } from "./readArtifactFileChunks.js";
import { ArtifactResourceScope } from "./ArtifactResourceScope.js";
import { artifactIntegrityDetails } from "../domain/artifactIntegrity.js";
import { PyInstallerPyzStore } from "./pyinstaller/PyInstallerPyzStore.js";
import { pyInstallerMemberStream } from "./pyinstaller/PyInstallerMemberStream.js";
import {
  findPyInstallerCookie,
  readCArchiveToc,
  type CArchiveEntry,
  type PyInstallerCookie,
} from "./pyinstaller/CArchiveLayout.js";
import {
  archiveUsesEncryption,
  projectPyzContainer,
  projectPyzMember,
  projectStoredMember,
  sealMember,
  type PyInstallerMember,
} from "./pyinstaller/CArchiveMembers.js";
import { readPyzArchive, type PyzArchive } from "./pyinstaller/PyzArchive.js";
import type { PyInstallerFailure } from "./pyinstaller/PyInstallerFailure.js";

const MAX_PARSED_FACT_BYTES = 32 * 1024 * 1024;
const MAX_RETAINED_ENTRY_BYTES = 64 * 1024 * 1024;
const RECORD_OWNERSHIP_RESERVATION = 256;

interface PyzImage {
  readonly archive: PyzArchive;
  readonly handle: FileHandle;
  readonly start: number;
}

interface LoadedArchive {
  readonly members: readonly PyInstallerMember[];
}

/**
 * Read-only inventory of a PyInstaller CArchive appended to a native executable.
 * Encrypted PYZ entries are reported and not decoded. Code members are not decompiled.
 */
export class PyInstallerArtifactReader implements ArtifactReader {
  readonly format = "pyinstaller" as const;
  #owner: OwnedFileHandle | undefined;
  #source: StableRegularFileDescriptor | undefined;
  #opening: Promise<FileHandle> | undefined;
  #closed = false;
  readonly #scope = new ArtifactResourceScope();
  readonly #lifecycle = new AbortController();
  #boundSha256: string | undefined;
  #loaded: Promise<LoadedArchive> | undefined;
  #budget = 0;
  #charged = 0;
  #parsedFactBytes = 0;
  #retainedEntryBytes = 0;
  #metadata: PyInstallerMetadata | undefined;
  readonly #pyzStore = new PyInstallerPyzStore();
  readonly #members = new Map<string, PyInstallerMember>();
  readonly #openedPyzSizes = new Map<string, number>();

  constructor(
    private readonly path: string,
    source?: StableRegularFileDescriptor,
  ) {
    this.#source = source;
  }

  formatMetadata(): PyInstallerMetadata | undefined {
    return this.#metadata === undefined ? undefined : { ...this.#metadata };
  }

  async prepareContainer(
    expectedSha256: string,
    signal?: AbortSignal,
  ): Promise<void> {
    const active = this.#signal(signal);
    await this.#scope.run(async () => {
      const handle = await this.#openHandle(active);
      await this.#verifySource();
      const observed =
        this.#boundSha256 ??
        (
          await hashReadable(
            readArtifactFileChunks(handle, { signal: active }),
            active,
          )
        ).sha256;
      await this.#verifySource();
      abortIfNeeded(active);
      if (observed !== expectedSha256)
        throw new ArtifactReaderFailure(
          "integrity",
          "PyInstaller carrier changed after inventory",
          undefined,
          artifactIntegrityDetails(
            ".",
            { algorithm: "sha256", digest: expectedSha256 },
            observed,
            false,
          ),
        );
      this.#boundSha256 = observed;
    });
  }

  async *entries(signal?: AbortSignal): AsyncIterable<ArtifactEntry> {
    const active = this.#signal(signal);
    const loaded = await this.#scope.run(async () => {
      const value = await this.#load(active);
      await this.#verifySource();
      this.#members.clear();
      return value;
    });
    for (const member of loaded.members) {
      abortIfNeeded(active);
      const sealed = sealMember(member);
      this.#members.set(sealed.entry.adapterKey, sealed);
      yield sealed.entry;
    }
  }

  async open(entry: ArtifactEntry, signal?: AbortSignal): Promise<Readable> {
    const active = this.#signal(signal);
    return this.#scope.run(async () => {
      const stored = this.#members.get(entry.adapterKey);
      if (stored === undefined || !sameArtifactEntry(entry, stored.entry))
        throw new ArtifactReaderFailure(
          "integrity",
          `PyInstaller entry was not produced by this reader: ${entry.path}`,
        );
      if (entry.kind !== "file")
        throw new ArtifactReaderFailure(
          "format",
          `PyInstaller entry is not a regular file: ${entry.path}`,
        );
      if (entry.encrypted)
        throw new ArtifactReaderFailure(
          "unavailable",
          `PYZ entry is encrypted and was not decoded: ${entry.path}`,
        );
      const read = stored.read;
      if (read === undefined)
        throw new ArtifactReaderFailure(
          "format",
          `PyInstaller entry has no readable bytes: ${entry.path}`,
        );
      await this.#verifySource();
      const previousSize =
        read.kind === "pyz"
          ? this.#openedPyzSizes.get(entry.adapterKey)
          : undefined;
      if (read.kind === "pyz" && previousSize === undefined)
        this.#charge(read.header?.length ?? 0);
      const parts = await this.#pyzStore.memberSource(
        read,
        this.#source?.handle,
        active,
      );
      if (active.aborted) {
        parts.source.destroy();
        await finished(parts.source, { cleanup: true }).catch(() => undefined);
        abortIfNeeded(active);
      }
      const stream = pyInstallerMemberStream(parts.source, {
        compressed: read.kind === "pyz" || read.source.compressionFlag === 1,
        header: read.header,
        expectedBytes:
          read.kind === "carchive"
            ? read.source.uncompressedSize
            : previousSize,
        maxBytes:
          read.kind === "carchive"
            ? read.source.uncompressedSize
            : (previousSize ?? this.#budget - this.#charged),
        signal: active,
        ...(read.kind === "pyz" && previousSize === undefined
          ? { charge: (bytes: number) => this.#charge(bytes) }
          : {}),
        complete: async (bytes) => {
          await parts.verify?.();
          await this.#verifySource();
          abortIfNeeded(active);
          if (read.kind === "pyz" && previousSize === undefined)
            this.#openedPyzSizes.set(entry.adapterKey, bytes);
        },
      });
      void this.#scope
        .run(async () => {
          let primary: unknown;
          try {
            await stream.completion;
          } catch (cause: unknown) {
            primary = cause;
          }
          await parts.close?.(primary);
          if (primary !== undefined) throw primary;
        })
        .catch((cause: unknown) =>
          stream.output.destroy(
            cause instanceof Error
              ? cause
              : new Error("PyInstaller stream failed", { cause }),
          ),
        );
      return stream.output;
    });
  }

  provenance(): readonly [] {
    return [];
  }

  async close(): Promise<void> {
    this.#closed = true;
    const closing = new ArtifactReaderFailure(
      "unavailable",
      "PyInstaller reader closed",
    );
    this.#lifecycle.abort(closing);
    await this.#scope.close();
    await this.#pyzStore.close();
    await this.#owner?.close();
    this.#owner = undefined;
    this.#source = undefined;
    this.#closed = true;
    this.#loaded = undefined;
    this.#members.clear();
    this.#openedPyzSizes.clear();
  }

  #signal(signal?: AbortSignal): AbortSignal {
    abortIfNeeded(signal);
    if (this.#closed)
      throw new ArtifactReaderFailure(
        "unavailable",
        "PyInstaller archive is closed",
      );
    return signal === undefined
      ? this.#lifecycle.signal
      : AbortSignal.any([signal, this.#lifecycle.signal]);
  }

  async #load(signal?: AbortSignal): Promise<LoadedArchive> {
    this.#loaded ??= this.#parse(signal);
    return this.#loaded;
  }

  async #parse(signal?: AbortSignal): Promise<LoadedArchive> {
    const handle = await this.#openHandle(signal);
    await this.#verifySource();
    const size = (await handle.stat()).size;
    const cookie = await this.#cookie(handle, size);
    this.#budget = artifactExpansionBudgetBytes(cookie.packageLength);
    const toc = await this.#toc(handle, cookie);
    for (const entry of toc) {
      this.#charge(entry.uncompressedSize);
      this.#reserveMetadata({ ...entry }, false);
    }
    const images = await this.#pyzImages(handle, cookie, toc, signal);
    const magic = scriptPythonMagic(
      cookie,
      [...images.values()].map((image) => image.archive),
    );
    const encrypted = archiveUsesEncryption(toc);
    const members = await this.#project(
      toc,
      cookie,
      images,
      magic,
      encrypted,
      signal,
    );
    for (const member of members)
      if (member.read?.kind === "carchive")
        this.#charge(member.read.header?.length ?? 0);
    await this.#verifySource();
    this.#metadata = cookieMetadata(
      cookie,
      toc.length,
      toc.filter((entry) => entry.typeCode === "o").length,
      encrypted,
    );
    return { members };
  }

  async #openHandle(signal?: AbortSignal): Promise<FileHandle> {
    abortIfNeeded(signal);
    if (this.#closed)
      throw new ArtifactReaderFailure(
        "unavailable",
        "PyInstaller archive is closed",
      );
    if (this.#source !== undefined) return this.#source.handle;
    // Admission belongs to the reader. A departing caller cannot cancel a peer
    // or replace a late descriptor owner; every caller joins the same admission.
    this.#opening ??= this.#admit();
    let handle: FileHandle;
    try {
      handle = await this.#opening;
    } catch (cause: unknown) {
      if (
        cause instanceof ArtifactReaderFailure &&
        cause.reason === "cancelled" &&
        signal?.aborted
      )
        throw new ArtifactReaderFailure("cancelled", cause.message, {
          cause: signal.reason,
          cleanup: cause.cleanup,
          cleanupLeases: cause.cleanupLeases,
        });
      throw cause;
    }
    abortIfNeeded(signal);
    return handle;
  }

  async #admit(): Promise<FileHandle> {
    try {
      const handle = await openRegularFile(this.path, {
        symlinks: "reject",
        signal: this.#lifecycle.signal,
      });
      this.#owner = new OwnedFileHandle(handle);
      this.#source = { handle, initial: await handle.stat() };
      return handle;
    } catch (cause: unknown) {
      if (cause instanceof RegularFileAdmissionFailure)
        this.#owner = cause.owner;
      throw openFailure(this.path, cause);
    }
  }

  async #cookie(handle: FileHandle, size: number): Promise<PyInstallerCookie> {
    const found = await findPyInstallerCookie(handle, size);
    if (found === undefined)
      throw new ArtifactReaderFailure(
        "format",
        "PyInstaller CArchive cookie was not found",
      );
    if (!found.ok) throw failure(found.error);
    return found.value;
  }

  async #toc(
    handle: FileHandle,
    cookie: PyInstallerCookie,
  ): Promise<readonly CArchiveEntry[]> {
    const toc = await readCArchiveToc(handle, cookie);
    if (!toc.ok) throw failure(toc.error);
    return toc.value;
  }

  async #pyzImages(
    handle: FileHandle,
    cookie: PyInstallerCookie,
    toc: readonly CArchiveEntry[],
    signal: AbortSignal | undefined,
  ): Promise<ReadonlyMap<CArchiveEntry, PyzImage>> {
    const images = new Map<CArchiveEntry, PyzImage>();
    for (const entry of toc) {
      if (entry.typeCode !== "z") continue;
      abortIfNeeded(signal);
      const spooled =
        entry.compressionFlag === 0
          ? undefined
          : await this.#pyzStore.spool(
              handle,
              cookie.archiveStart,
              entry,
              signal,
            );
      const source = spooled ?? {
        handle,
        start: cookie.archiveStart + entry.offset,
      };
      const parsed = await readPyzArchive(
        source.handle,
        source.start,
        entry.uncompressedSize,
        signal,
      );
      if (!parsed.ok) throw failure(parsed.error);
      if (parsed.value.kind === "entries")
        for (const item of parsed.value.entries)
          this.#reserveMetadata({ ...item, container: entry.name }, false);
      if (spooled !== undefined) await this.#pyzStore.release(spooled.handle);
      images.set(entry, {
        archive: parsed.value,
        handle: source.handle,
        start: source.start,
      });
    }
    return images;
  }

  async #project(
    toc: readonly CArchiveEntry[],
    cookie: PyInstallerCookie,
    images: ReadonlyMap<CArchiveEntry, PyzImage>,
    magic: Buffer | undefined,
    encrypted: boolean,
    signal: AbortSignal | undefined,
  ): Promise<PyInstallerMember[]> {
    const members: PyInstallerMember[] = [];
    const append = (member: PyInstallerMember): void => {
      const entry = {
        ...member.entry,
        path: normalizeArtifactPath(member.entry.path),
      };
      this.#reserveMetadata(
        {
          path: entry.path,
          adapter_key: entry.adapterKey,
          format_metadata: entry.formatMetadata ?? null,
          limitations: [...entry.limitations],
        },
        true,
      );
      members.push({ ...member, entry });
    };
    for (const entry of toc) {
      if (members.length % 256 === 0) await setImmediate();
      abortIfNeeded(signal);
      const image = entry.typeCode === "z" ? images.get(entry) : undefined;
      if (image === undefined) {
        append(projectStoredMember(entry, cookie.archiveStart, magic));
        continue;
      }
      append(
        projectPyzContainer(
          entry,
          cookie.archiveStart,
          image.archive,
          encrypted,
        ),
      );
      if (image.archive.kind !== "entries") continue;
      for (const item of image.archive.entries) {
        if (members.length % 256 === 0) await setImmediate();
        abortIfNeeded(signal);
        append(
          projectPyzMember(
            entry,
            item,
            encrypted,
            image.archive.pythonMagic,
            item.namespace || encrypted
              ? undefined
              : {
                  handle: image.handle,
                  offset: image.start + item.offset,
                  length: item.length,
                },
          ),
        );
      }
    }
    return members;
  }

  async #verifySource(): Promise<void> {
    const source = this.#source;
    if (source === undefined)
      throw new ArtifactReaderFailure(
        "unavailable",
        "PyInstaller archive is closed",
      );
    const [opened, currentPath] = await Promise.all([
      source.handle.stat(),
      lstat(this.path),
    ]);
    if (
      !sameRegularFileState(source.initial, opened) ||
      !sameRegularFileState(source.initial, currentPath)
    )
      throw new ArtifactReaderFailure(
        "integrity",
        `PyInstaller source changed during reading: ${this.path}`,
      );
  }

  #reserveMetadata(value: JsonValue, projected: boolean): void {
    const used = projected ? this.#retainedEntryBytes : this.#parsedFactBytes;
    const limit = projected ? MAX_RETAINED_ENTRY_BYTES : MAX_PARSED_FACT_BYTES;
    const remaining = limit - used - RECORD_OWNERSHIP_RESERVATION;
    const bytes = remaining < 0 ? 0 : jsonValueByteLength(value, remaining);
    if (remaining < 0 || bytes > remaining)
      throw new ArtifactReaderFailure(
        "limit",
        "PyInstaller directory facts exceed their serialized metadata budget",
        { boundary: "memory" },
      );
    if (projected)
      this.#retainedEntryBytes += bytes + RECORD_OWNERSHIP_RESERVATION;
    else this.#parsedFactBytes += bytes + RECORD_OWNERSHIP_RESERVATION;
  }

  #charge(bytes: number): void {
    if (
      !Number.isSafeInteger(bytes) ||
      bytes < 0 ||
      this.#charged + bytes > this.#budget
    )
      throw new ArtifactReaderFailure(
        "limit",
        `PyInstaller members declare ${String(this.#charged + Math.max(0, bytes))} uncompressed bytes, exceeding the decompression budget`,
      );
    this.#charged += bytes;
  }
}

const failure = (error: PyInstallerFailure): ArtifactReaderFailure =>
  new ArtifactReaderFailure(error.reason, error.message);

const openFailure = (path: string, cause: unknown): ArtifactReaderFailure => {
  if (cause instanceof ArtifactReaderFailure) return cause;
  if (cause instanceof RegularFileOperationCancelled)
    return new ArtifactReaderFailure(
      "cancelled",
      "PyInstaller file admission cancelled",
      { cause: cause.reason },
    );
  if (cause instanceof RegularFileAdmissionFailure)
    return ArtifactReaderFailure.withCleanup(
      openFailure(path, cause.cause),
      ArtifactReaderFailure.cleanupObservation(cause.cleanupCause, path),
    );
  if (cause instanceof NonRegularFileReadError)
    return new ArtifactReaderFailure(
      "format",
      `PyInstaller source is not a regular file: ${path}`,
      { cause },
    );
  return new ArtifactReaderFailure(
    "io",
    "PyInstaller archive could not be opened",
    {
      cause,
    },
  );
};
