# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

While the project is **experimental**, breaking changes are possible in any release and are labelled
as such.

## Unreleased

## 0.2.0 - 2026-08-17

### Added — reading is bounded, and every bound is reported

An oversized or hostile archive cannot exhaust the window: JSON Lines files are streamed a line at a
time, a `.json` document larger than 32 MB is declined before it is read, and a load stops at
100,000 events. Every limit that applies is reported on screen.

### Fixed — a load no longer loses files, or events, without saying so

- A `.json` array of a few hundred thousand events was appended in a single call that passed every
  row as an argument. Past a few hundred thousand that exceeds the engine's argument limit: the call
  threw, the loader caught it as an unreadable file, and every event in the file disappeared behind
  the words "1 unreadable". Rows are appended in chunks, which has no such ceiling.
- The event ceiling was only checked between files, so a single `.json` document could carry a load
  past it — and, when it was the last file read, past it with no banner at all. The ceiling now
  applies inside a document, and a load that had to stop short says so.
- A file that could not be read was counted but never named. It is now listed with the reason, the
  way a file declined for its size already was.
- Directories the walk does not enter — dependency and build trees, and anything past the depth
  limit — are counted on screen. A directory that was never entered can hold audit logs.
- One unreadable subdirectory aborted the entire load, so a permission denied deep in a tree cost
  the user every event in the folder. It is now reported and stepped over.
- A load that stopped at the ceiling left the file it was reading open. The plugin's line iterator
  has no `return()`, so leaving its loop early cannot ask it to clean up, and the file stayed open
  in the Rust process for the lifetime of the window. The loader now releases it through Tauri's
  core resource API, which the capability already permits: nothing wider than reading is granted in
  order to release what reading opened.

### Changed behaviour — the flow map draws the selected flow, not the whole folder

**Breaking** for anyone who used the map to survey a folder: that view is gone.

The map aggregated every flow in the folder while sitting directly above one flow's detail, and
nothing on screen said so. Its numbers were folder-wide — an application showing "3 ev" above a
flow that used it twice — and selecting a flow dimmed the edges that flow did not use while leaving
every node at full strength, so an application no part of the selected flow still read as one of
its participants.

The aggregate also drew applications in columns by observed depth whether or not they had ever
exchanged anything: a folder holding twenty applications in unrelated flows put seven strangers in
one column, suggesting a relationship the events never showed.

The map is now scoped to the selected flow, and so is every figure on it — transition counts,
median gaps, failure counts and each application's event count are that flow's own. Selecting
another flow redraws it. A flow that never left one application says so rather than drawing an
empty panel.

### Changed behaviour — chain verification of a large folder waits to be asked

Chain verification ran on every load, digesting every member of every chain in parallel through Web
Crypto. That is instant for the few chains an ordinary folder holds, and something else entirely for
a folder loaded to the event ceiling. Above 5,000 chain members it is now offered as a button
instead — the rule the per-event digest sweep already followed.

## 0.1.0

First release. A desktop application that opens a folder of audit logs and analyses them locally.

### Reading

- `.json` (a single event or an array) and `.jsonl` / `.ndjson` (one event per line). Formats the
  specification does not define are not read, rather than mapped onto the event model by guesswork.
- Folder trees are walked recursively, skipping dependency and build directories.

### Analysis

All of it offline, ported from the OpenAuditModel conformance tooling so that the answers match the
`openauditmodel` CLI:

- **Schema validation** against the vendored canonical schema, with the CLI's error messages and
  JSON Pointers.
- **Privacy linting** — the specification's deterministic rules for credential field names, known
  token formats, connection strings, URL userinfo, entropy and size. Findings carry rule
  identifiers and paths, never the value that produced them.
- **Digest verification** — `integrity.hash` recomputed via RFC 8785 canonicalization and
  SHA-256/384/512, for the selected event or for every event on request.
- **Chain verification** — events sharing an `integrity.chainId` ordered by `sequence`, each
  `previousHash` link checked. Events without a chain identifier are reported as unassigned, never
  inferred into a chain.
- **Profile conformance** against the ten published profiles, for whichever profiles govern the
  event's name.

Signature verification is deliberately absent: the app has no key registry, and a signature checked
against a key from the same untrusted source proves nothing.

### Presentation

- **Events** — sortable, filterable table with schema and privacy status per row; a detail panel
  showing findings, integrity, chain, profile results and a `change.before`/`after` diff.
- **Overview** — totals, per-application breakdown, privacy findings by severity and rule, chain
  health, and an on-demand sweep of every digest.
- **Traces** — cross-application flows reconstructed from `request.traceId` and
  `request.correlationId`, shown as an aggregated service map with per-transition counts, median
  gaps and failure counts, plus a per-flow timeline. Map nodes can be rearranged, and the layout
  persists.
- Bookmarks, export of the filtered view as JSON Lines, and a light/dark theme choice.

### Security

- Filesystem access is limited to the folder picked in the native dialog and the file chosen when
  exporting; the capabilities file grants no static path.
- A Content-Security-Policy without `unsafe-eval` ships with the release build. The schema validator
  is precompiled at build time so that no runtime code generation is needed.
- The webview cannot navigate away from the bundled application, and external links are handed to
  the system browser through a scoped allow list.
- Depth failures from hostile structure are reported as findings instead of crashing the window.

Release binaries are unsigned; Windows SmartScreen will warn on first run of a downloaded copy.
