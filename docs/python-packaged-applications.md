# Python packaged applications

REA statically inventories PyInstaller executables with an appended CArchive.
`inspect_artifact` and `extract_artifact` share the same reader through CLI and
MCP. They read archive bytes without launching the application. Bytecode
source decompilation, encrypted PYZ recovery, zipapp and PEX analysis are outside
this capability.

## Facts and focused queries

The root occurrence's `format_metadata` records the CArchive layout (2.0 or
2.1), archive and cookie offsets, table extent, entry count, raw Python version,
normalized major/minor when known, library name and encryption marker. Member
metadata retains the original name, table index, type, compression flag,
relative offset and known directory record extent. Logical paths use archive
path rules; the source name retains its spelling, including backslashes.
`relative_offset` is relative to the CArchive start for CArchive rows, or to
the decoded PYZ image for PYZ rows. A CArchive directory record starts at
`archive_start + toc_offset + directory_record_offset`; its size is
`directory_record_size`. PYZ row directory extents remain unknown.

CArchive type `o` entries are runtime options. They are metadata occurrences,
with no content artifact or extractable file. Their query paths are
`__pyinstaller__/runtime-options/<table index>`; the option text is
`format_metadata.source_name`. Repeated declarations retain distinct occurrence
identities. These paths do not claim output filesystem names.

Request `detail: "summary"` for a compact inspection, then query retained
Evidence with `inspect_analysis_view`. An inventory view can select
`collection: "occurrences"`, `entry_kinds: ["metadata"]`, exact logical paths or
occurrence IDs, requested `fields`, and `offset`/`limit`. Filters intersect;
identities, parent Evidence and coverage survive projection. Full inventory
Evidence remains available for export. A compact reply reduces returned context;
it still performs the complete member inventory and hashing work.
Focused views add calls and tool-schema costs. A complete small inventory can
cost less overall; prefer compact delivery when the full member graph would
overwhelm the answer.

```bash
rea inspect-artifact /absolute/path/hello --detail summary --evidence_output /absolute/new/evidence.json --json
rea extract-artifact /absolute/path/hello --json
```

## Decoding and evidence limits

Inventory hashes members individually through bounded streams. Stored PYZ
images use descriptor ranges; outer-compressed images stream to private files,
which the reader owns through cleanup and any cleanup retry. Extraction binds
the selected carrier to its inventoried digest and checks source identity and
state before and after reading. It does not retain expanded module bodies.

Only the PYZ header and marshal directory are loaded for listing. PYZ tables
have a 16 MiB budget; CArchive tables have a 32 MiB budget. Parsed facts and
projected entry metadata have separate 32 MiB and 64 MiB serialized budgets,
including per-record bookkeeping reservations. Plaintext expansion has an
aggregate archive-derived budget. Exceeding a budget returns a resource failure.

Supported final Python bytecode magic values cover Python 3.7 through 3.14.
Supported marshal directory values are lists, tuples, strings, integers and
bytes. An unsupported magic or directory stays an opaque member with a
limitation and `pyz_status: "opaque"`; its module contents remain unknown.
The directory declares compressed module lengths, so uncompressed declared
sizes and source spans inside decoded data remain unknown.

PYZ modules receive a derived 16-byte `.pyc` header from their own supported
magic. CArchive bytecode receives that header only when every sibling PYZ magic
and the cookie's Python version agree. Otherwise it retains its original bytes
and `bytecode_header: "unknown"`. `bytecode_magic` and graph derivation edges
identify synthesized headers; member digests cover the resulting derived files.
These headers do not establish successful execution or decompilation.

The module `pyimod00_crypto_key` is recorded as an encryption marker. Affected
PYZ blobs are reported without decoding; extraction refuses encrypted entries.

Detection searches the last 16 MiB for a cookie, allowing a trailing macOS code
signature within that bound. Member offsets are relative to the archive start:
cookie position plus cookie size minus package length. Native bootloader
analysis remains available through the native tools.
