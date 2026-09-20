# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

While the project is **experimental**, breaking changes are possible in any release and are labelled
as such.

## Unreleased

### Added — the Coverage tab

The Events tab answers whether one event conforms. This answers what a reviewer asks about a whole
archive: which of the ten profiles reach it, and what they actually checked. Per profile it shows
the events governed, conforming and violating, how many rules were selected out of the total, how
many of those contributed requirements, and — the number worth having — the rules that selected an
event and then required nothing of it, because a condition never held. Each of those looked enforced
and was not.

The counters come from the package's own `summariseCoverage`, over results from the same
`checkProfile` the detail panel uses, so this tab is the per-event verdicts grouped rather than a
second opinion about them. A test asserts that for every governed row.

A profile that reaches nothing is reported as governing nothing, never as satisfied: an event no
rule selects is not applicable, and not applicable is not conformance. When no profile governs a
single event the tab says so plainly, and says the usual cause is event names shaped differently
from the convention the profiles select on. Nothing is drawn as a percentage or a bar: "7 of 15
rules selected" describes an archive, not its quality, and a profile is not a checklist an archive
is meant to fill. A core-invalid row is not offered to any profile, since a profile never evaluates
an event the core rejects, and counting it as ungoverned ten times would say something false about
ten profiles at once.

Measuring waits for a click, like the digest sweep: it is one profile check per event per profile.

### Changed — the schema and the profiles are imported, not copied

`src/schema/audit-event.schema.json` and the ten files under `src/profiles/` were copies of
documents the pinned package already ships, kept in step by `npm run sync-vendored` and watched by a
parity assertion. Both are deleted. The schema and the profiles are now imported from
`@openauditmodel/cli` — pinned to an exact version, resolved by Vite at build time, so the app still
works offline and still fetches nothing at run time.

What this removes is a class of defect rather than a bug: engines from one release evaluating a
schema or a profile from another cannot happen when there is one place any of it comes from. The
parity suite's "vendored equals the pinned release" comparison is replaced by one that reads the
package's files back and asserts the app is holding them, and it now also checks that the registry
covers every profile the package publishes — so a profile added upstream is a failure here rather
than a silent absence. The precompiled validator is generated from the package's schema too, and
regenerating it produced the same bytes, which is the evidence the copies had not drifted.

Keeping up with the specification is now `npm install @openauditmodel/cli@<version> --save-exact`
followed by `npm run verify`. `npm run sync-vendored` and `tools/sync-vendored.mjs` are gone.

### Changed behaviour — a signature this verifier cannot check no longer reads as verified

**Breaking** in the sense every "changed behaviour" entry here is: an event that this app reported
as verified may now be reported as not verified. Specifically, an event whose `integrity.signature`
declares an algorithm the reference implementation does not implement — anything other than
Ed25519, ECDSA-P256-SHA256 and RSA-PSS-SHA256 — fails verification with
`unsupported-signature-algorithm`, as it has in the CLI since 0.3.0. A signature that can never be checked must not read as verified; the CLI closed that
silent pass in 0.3.0 and this app did not follow, because integrity is the one engine still carried
here rather than imported. A declared signature in an implemented algorithm is now shown as
declared and not checked, which is what the CLI says without a key. Nothing about hash or chain
verification changed.

### Added — integrity parity against the conformance kit

The differential parity suite compares the imported engines against the package and deliberately
excludes integrity, because there is no second implementation of it to run — the port is the only
copy in this app. The kit manifest records what the reference implementation answers for every
fixture with integrity material and for every published chain directory, so the port is now
asserted against those: the verdict and the finding kinds, never the wording. This is the one place
in the suite where a stored, upstream-generated expectation is the right instrument, because the
code it checks is deliberately not shared.

It found the divergence above on its first run, and the next one on the first pin to canonical
0.5.0 — see the entry below. That is what it is for: a divergence between the two integrity engines
is found by a test before a release, rather than by a user after one.

### Changed — pinned to `@openauditmodel/cli` 0.5.0, and the signature list follows it

The reference implementation now verifies `ECDSA-P256-SHA256` and `RSA-PSS-SHA256` beside Ed25519,
so an event signed with either of them is verified there and must not be reported here as carrying a
signature nobody can check. The pin moved and the parity suite failed on exactly those two published
fixtures, as designed; the algorithm list in this app's integrity port now has all three. Nothing
else about the port changed, and this app still verifies no signature: it has no key, and the list
exists only to tell "declared, not checked" from "cannot be checked at all".

The pinned release brings a larger corpus — 327 fixtures and seven chain directories — and two new
kit families, `checkpoints` and `proofs`, recording verdicts for documents that are not events. This
app reads neither: the parity suite compares what it computes, and checkpoint and proof verification
are not ported here. Two chain directories are new to the suite, and one of them is worth naming.
`examples/integrity/invalid/truncated-chain/` is a chain whose most recent events were deleted, and
both the reference implementation and this app report it **intact**, because a truncated chain is
internally consistent and chain verification cannot see what is not there. The CLI's new
`verify-checkpoint` is what sees it, given a checkpoint recorded beyond the store's reach. The
README's limitations now say so rather than leaving a reader to assume an intact chain is a complete
one.

### Removed — the Linux CI build

CI compiled the application on Ubuntu on every push, for a platform the project has never published
and, as of this release, has decided not to target. Windows and macOS are the platforms; a job that
proved Linux still compiled was proving something nobody was going to ship. The README now says so
in one sentence instead of two paragraphs of hedging, and says what it would take to change the
decision: being asked.

## 0.4.0 - 2026-09-19

### Added — a signed, notarized macOS build

Releases now carry a universal disk image alongside the Windows executable. It is signed with a
Developer ID certificate and notarized by Apple, which is the difference between an application that
opens on a double click and one macOS refuses to open at all: an unsigned app downloaded from the
internet is not merely warned about the way SmartScreen warns, it is blocked, and recent macOS
versions removed the right-click escape hatch.

**The release job proves it rather than assuming it.** After building, it mounts the image, runs
`spctl --assess --type execute`, `codesign --verify --deep --strict` and `xcrun stapler validate`
against the application inside, and fails the release if any of the three does. A notarization that
silently did not happen produces an artifact that passes every earlier step and fails on the first
machine that opens it.

One image covers Apple Silicon and Intel. The signing material lives in a keychain created for the
run and deleted at the end of it, and the notarization key is written to the runner's temporary
directory and removed in the same step — both in an `always()` block, so a failed build does not
leave them behind.

CI also builds on `macos-latest` now. That job publishes nothing; it exists so that a compilation
failure on macOS is found on the pull request rather than at the tag.

The README said until now that macOS was not published because the application had never been run
there, and that shipping a binary for a platform nobody has tried would be a claim rather than a
release. It has now been run: built natively on an Apple Silicon Mac, pointed at a folder of 563
files, and watched to report 811 events, the seven it could not read and the twenty-seven
directories it did not enter — with the package's privacy and profile engines producing the same
verdicts they produce everywhere else.

### Added — a differential parity suite against the published engines

The README has claimed that this app answers the same as the `openauditmodel` CLI. That was an
assertion: the privacy and profile engines here are ports, and nothing compared them.

`src/lib/__tests__/parity.test.ts` runs both engines — the ported ones and the ones in
`@openauditmodel/cli` — over every fixture the published conformance kit names, and asserts the
answers are identical. Both sides are computed in the test, so there is no stored expectation to
rot. It covers privacy linting and all ten profiles across 320 fixtures, plus the precompiled
validator against the package's own.

The package is pinned to an exact version, and the suite asserts that the vendored schema and the
ten vendored profiles are byte-identical to that release's. Split provenance — engines from one
release, the artifacts they evaluate from another — is the failure this pin exists to prevent.

### Changed — privacy and profile analysis comes from the published package

This app carried its own copy of the privacy and profile engines, ported from the conformance
tooling. Two thousand one hundred and ninety-six lines of that copy are gone, replaced by
`@openauditmodel/cli` pinned to an exact version. What is left in their place is
`src/lib/engines.ts`: the seam that binds this app's precompiled validator to the published engines,
which take a validator as a parameter for exactly this reason.

The answers did not move — the parity suite above was written first and ran green across the swap,
over every fixture the kit names.

**Integrity stays local**, and that is not an oversight: Web Crypto is asynchronous where Node's
hashing is not, which is a real difference rather than drift. The vendored profile registry stays
too, because the package's profile loaders read the filesystem and this app has no filesystem to
read from inside the webview. Neither of the two Node-bound modules is imported, and the bundle is
measured rather than assumed: 554,173 bytes with the ported engines, 554,425 with the package's —
252 bytes for the swap itself, and 555,212 for this release once the refusal below is in. No new
dependency, no Node builtin and no runtime code generation in the built assets.

What this buys is direction: analysis behaviour now changes upstream first and arrives here by
bumping one pin. What it costs is stated too — this app inherits upstream's fixes and upstream's
bugs alike.

### Changed behaviour — a profile this build cannot evaluate is refused rather than reported conforming

**Breaking** for anyone reading a folder with a profile newer than this build: a profile that was
silently half-applied is now not applied at all, and says so.

A profile declares the rule vocabulary it is written in. The engines read the rule keys they know
and ignore the rest — which is correct for a tool that is never handed an unknown one, and wrong
here: a rule this build cannot evaluate contributes no requirement, so the event comes back
**conforming**. The first profile written in an extended vocabulary would have made this app quietly
more permissive than the CLI, which is a defect even when the friendlier answer looks like a
feature.

Profiles are now partitioned on load. Anything declaring a profile version this build does not
implement is refused, and the detail panel lists it by name next to the ones it did evaluate, with
the version it declares. Ten of ten vendored profiles are evaluated today; the count of refusals is
shown precisely so that it can never be zero silently.

### Changed — the Traces tab is now Observed Flow

It infers flows from `request.traceId`, `request.correlationId` and ordering. A causal graph needs
`request.parentSpanId`, which the model does not carry, and a tab called Traces invites the reader
to believe the app has one. The name now says what the view actually knows.

### Fixed — a validation issue's detail no longer disappears into its message

The parity suite found this on its first run. `validateEvent` narrowed each issue to the two fields
the detail panel renders, appending the issue's `detail` to its message in parentheses and dropping
`keyword`. The verdicts were identical and no path moved, but the wording was this app's own, while
`src/lib/schema.ts` claimed in a comment that an invalid file "shows the same message" as the CLI.

Issues now keep the shape the published engines produce, and the panel does the laying out — which
is where a presentation choice belongs. On screen the detail still follows the message; in the code
it is a field rather than a sentence fragment. The reader's own issues, for a file that is not an
event or a document too deeply nested to validate, carry `keyword: "reader"`, so that the field
never claims a schema keyword produced them.

## 0.3.0 - 2026-09-01

### Changed behaviour — the vendored incident-management profile moves to 0.2

**Breaking** for anyone reading a folder of incident events: an event this viewer
reported as `not-applicable` may now be reported as a violation.

The canonical profile gained the two-segment twin of every `<domain>.case.<action>` selector, so a
system that models an incident directly rather than as a separate _case_ record — emitting
`incident.create` rather than `incident.case.create` — is governed instead of passed over. Seventeen
selectors become twenty-four; the fifteen rules are unchanged, and no rule was added, removed or
retargeted.

Until this refresh the viewer and the `auditmodel` CLI disagreed about real events. On the reference
204-event export the CLI reports fifteen violations where this viewer reported `not-applicable`, and
verdict parity with the CLI is the whole of what this application claims. A viewer that is quietly
more permissive than the CLI is a defect even when its answer looks friendlier.

Data only: the profile introduces no rule key the evaluator does not implement, so nothing under
`src/lib/` changed. `sync-vendored` reports one file updated and ten unchanged.

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
