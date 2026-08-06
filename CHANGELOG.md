# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

While the project is **experimental**, breaking changes are possible in any release and are labelled
as such.

## Unreleased

## 0.1.0

First release. A desktop application that opens a folder of audit logs and analyses them locally.

### Reading

- `.json` (a single event or an array) and `.jsonl` / `.ndjson` (one event per line). Formats the
  specification does not define are not read, rather than mapped onto the event model by guesswork.
- Folder trees are walked recursively, skipping dependency and build directories.
- Reading is bounded so that an oversized or hostile archive cannot exhaust the window: JSON Lines
  files are streamed a line at a time, a `.json` document larger than 32 MB is declined before it is
  read, and a load stops at 100,000 events. Every limit that applies is reported on screen.

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
