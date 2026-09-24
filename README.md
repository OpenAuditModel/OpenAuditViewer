# OpenAuditViewer

A desktop application for reading [OpenAuditModel](https://github.com/OpenAuditModel/OpenAuditModel)
audit logs. Point it at a folder — a few files or a few hundred, from one application or a dozen —
or at a Kafka topic, and it validates every event, scans for values that should not be in an audit
log, verifies tamper-evidence digests and chains, checks domain profiles, and reconstructs the flows
that crossed application boundaries.

The analysis runs entirely on your machine. The app reads only from sources you point it at, sends
audit content nowhere — no telemetry, no crash reporting, no remote validation service — and writes
nothing except an export you ask for and the list of Kafka sources you save. It opens a network
connection for two things, and only when you ask: reading a window from a Kafka broker you saved,
and an update check in Settings that asks GitHub for the latest release tag. Never on launch, never
on a timer. A folder is read without any network at all.

**Status: 1.0.** It reads OpenAuditModel 1.0 events, and events written under 0.1. Every verdict it
shows comes from the published engines and is held to the command line tool's by tests, so as a
reader and verifier it is as stable as the specification it implements. It has not been externally
audited, and it is not yet proven in production — the same claim the specification makes about
itself.

An event is validated against the schema of the version it declares. One that declares a version
this app does not implement — a later minor, another major — is shown as **not evaluated**: never as
valid, because nothing was checked, and not as invalid, because nothing was found wrong.

![The Overview tab, showing counts, a per-application breakdown, privacy findings by rule, and chain health](assets/overview.png)

_The Overview tab. Screenshots on this page show the demo dataset produced by `npm run demo-logs`,
which deliberately contains invalid events, planted credential-shaped values and a damaged hash
chain._

## Why it exists

The specification ships a CLI that answers these questions one command at a time. That is the right
shape for CI, and the wrong shape for the afternoon when someone hands you an archive and asks what
is in it. This is the same analysis with a table in front of it.

Privacy linting and profile conformance are not reimplemented here: this app imports the engines
from `@openauditmodel/cli`, pinned to one exact release along with the schema and the profile
definitions it evaluates. Integrity stays local, because Web Crypto is asynchronous where Node's
hashing is not. A test suite runs both sides over every fixture the published conformance kit names
and asserts the answers are identical, so "the answers match the CLI" is a check rather than a
claim.

## What it reads

Every recognized file under the folder you pick, recursively:

| Format               | Notes                            |
| -------------------- | -------------------------------- |
| `.json`              | One event, or an array of events |
| `.jsonl` / `.ndjson` | One event per line               |

Only what the specification defines. CSV and other flat exports are deliberately not read: the
event model is a JSON structure, and mapping arbitrary columns onto it would mean inventing a
correspondence the producer never declared, then presenting the result as conformant. Converting
an export to JSON Lines is the producer's decision to make, and their mapping to document.

### From a Kafka topic

**Read from Kafka…** reads a window of a topic, from every partition or the ones you name:

- **Newest** or **Oldest** — the newest or oldest _n_ records across the whole topic, by the time
  each record carries (500 unless you say otherwise);
- **Newest per partition** — the last _n_ records of each partition;
- **Time range** — from a date and time, until another or until now;
- **Offsets** — from one offset in every partition (`120`) or one for each partition
  (`0:120, 2:40`), to an offset or to the end;
- **Everything** — from the oldest record the broker holds.

A window ends where it was told to, or at the end each partition had when reading started. With
**Keep listening**, reading then goes on: records that arrive afterwards are added to the screen as
they come — at most once a second — with a **Listening** badge in the toolbar and a Stop beside it.
A window opens in the Events table newest read first, so new records fade in at the top; scrolled
further down, the rows you are reading stay where they are and a pill says how many arrived above.
The Source column sorts by the order events were read in, for a folder as for a window.
A filter — event name starts with, application, text the record contains — keeps only the events
that match; the broker still sends every record in the range, and the window says how many were
read and how many kept. Each record's value is read as one event, exactly as a line of a JSON Lines
file is; its topic, partition and offset are where it came from, shown beside the event (the Source
column reads `partition@offset`) and never added to it.

- **Nothing is left on the broker.** Partitions are assigned and sought, never subscribed, so no
  consumer group is joined; no offset is committed; a topic that does not exist is reported, not
  created. The broker sees a client named `openaudit-viewer`. librdkafka still names a group,
  `openaudit-viewer-readonly`, and asks which broker coordinates it — on a cluster no consumer has
  ever used, that first question makes the broker create its internal offsets topic, as any
  consumer's would — but the group is never joined and holds nothing.
- **Connections:** TLS with SASL (PLAIN, SCRAM-SHA-256 or SCRAM-SHA-512), TLS alone, or no TLS at
  all — which the form warns against, since the events then cross the network unencrypted. SASL
  without TLS is not offered. The broker's certificate is verified against the public certificate
  authorities, or against a CA file you choose for a private one.
- **Saving a source** asks for confirmation in a system dialog that names the brokers, the
  connection and the user. The password goes to the system keychain — macOS Keychain, Windows
  Credential Manager — and is sent only to the brokers, as the user and over the connection it was
  entered for: change any of those and it has to be entered again. The source list itself is a file
  in the app's configuration folder, with no secret in it.
- **A window is bounded**: 100,000 events, 256 MB of records, five minutes, and 30 seconds without a
  record. Whichever ends it is shown, and a window that stopped before its end says so above
  everything else. Listening counts what it adds against the same 100,000 and stops after eight
  hours; it never stalls, since waiting is what it does.
- **Chains and flows are judged on the window.** A chain whose events are spread across partitions,
  read from a point in time or by the newest records of each partition, has holes the window left.
  A link across such a hole is shown as **not checked** — neither held nor broken — and a chain
  whose only findings are those is counted apart from intact and broken ones. Read from the oldest
  record to check whole chains.
- **Not supported:** client certificates (mutual TLS), OAUTHBEARER and cloud-provider sign-in such
  as AWS IAM, Kerberos, and values that are not JSON text — Avro, Protobuf and Schema Registry
  framing. Each is a deliberate edge of this release, not an oversight.

## What it checks

- **Schema validation** against the canonical schema, reporting the same
  messages and JSON Pointers as the CLI.
- **Privacy linting** with the specification's deterministic rules: credential-shaped field names,
  known token formats, connection strings, credentials in URLs, high-entropy values, oversized
  payloads. A finding names the rule and the path, never the value.
- **Digest verification** — `integrity.hash` recomputed with RFC 8785 canonicalization and
  SHA-256/384/512. Per event, or across the whole folder on request.
- **Chain verification** — events sharing an `integrity.chainId`, ordered by `sequence`, with every
  `previousHash` link checked against its predecessor, and each chain drawable as that line of links
  with every finding placed on the member it names.
- **Profile conformance** against the ten published profiles, for whichever ones govern each event.

- **Signature verification against a key you choose** — Ed25519, ECDSA-P256-SHA256 and
  RSA-PSS-SHA256, the three algorithms `auditmodel verify-integrity --public-key` verifies. Choose
  the producer's public key in the **Tamper evidence** panel of the Overview; every digest check,
  chain and report then verifies signatures against it, and the report says which key that was.

**Which key is the only question that matters, and the app cannot answer it.** A signature that
verifies proves the event was sealed by the holder of that key — so a key taken from the same
folder as the events proves nothing, since whoever wrote the events could have written the key.
Take it from wherever the producer publishes it, and compare the SHA-256 fingerprint the panel shows
with the one they publish. The app keeps no key registry and resolves no `keyId`; a key is trusted
for the session and forgotten when the app closes.

Without a key, a declared signature is still never passed over in silence, and this matches the CLI
run without `--public-key` exactly: a signature in an algorithm the reference implementation
implements is shown as declared and not checked, with the verdict resting on the hash alone; a
signature in an algorithm it does not implement **fails** verification, with or without a key,
because a signature that can never be checked must not read as verified.

Verification runs in the app's Rust process, not in the webview. The key file is chosen in a native
dialog opened from Rust and read there; the webview, which renders untrusted log content, never
sees the key or names a path. Rust is also where the reference verifier's behaviour can be matched:
Web Crypto requires an RSA-PSS salt length up front where the CLI accepts whatever the signer chose,
and its Ed25519 support depends on the webview runtime a machine happens to have. Every answer is
held to the CLI's by test vectors the canonical package itself produced. One differs on purpose, and
refuses something the CLI accepts: an RSASSA-PSS key that restricts its own parameters. A
small-order Ed25519 key (under which a trivial signature verifies for any message) and an Ed25519
signature whose R is a small-order point were two more until canonical 1.0.0 refused them as well;
the two now refuse them in the same words. Some files are also refused when chosen, where the
CLI would load them: a private key, a PKCS#1 `RSA PUBLIC KEY` and a certificate (each with the
command that converts it), an RSA key with an even modulus or exponent or an exponent below 3, an RSA
modulus over 16,384 bits, and anything that is not a regular file of at most 64 KiB.

## What it shows

**Events** — a sortable, filterable table. Each row carries its validity and a flag when the
privacy scan found something. Selecting one opens a panel with the schema findings, the privacy
findings, integrity and chain results, profile conformance, a per-path diff of
`change.before`/`change.after`, and the raw JSON.

![The Events tab, with an event selected and the detail panel listing five profile violations](assets/events.png)

The selected event above is valid against the core schema and clean of privacy findings, and still
fails the incident-management profile five times over: it records no authorization decision, no
incident status and no reason for a priority change. Core validity and domain conformance are
separate questions, and the panel keeps them separate.

**Overview** — totals, a per-application breakdown that filters the table when clicked, privacy
findings by severity and by rule, chain health, a button to verify every digest at once, and
**Where to start**: the same findings grouped by the file, event name and application they came
from, so the work has an order. There is no quality score anywhere in this application, and that is
deliberate — aggregating validity, privacy, tamper-evidence and conformance into one number turns
four honest answers into a target, and the specification's own design principles refuse to treat a
fuller event as a better one.

**Report** — one page carrying everything the application established about the folder, and
everything it did not: what was loaded, what validated, what the privacy linter found, what verified,
which profiles reached it, and a closing section naming what none of it establishes. It prints
through the browser's own print dialog, so what happens to the page is the operator's decision and
nothing is written to disk by the app. The conformance-is-not-compliance line is printed, not shown
only on screen, because a report is on its way to an auditor exactly when that line is easiest to
lose. It is a page, not a document format.

**Coverage** — which of the ten profiles reach this archive at all, and what each one actually
checked: events governed, conforming and violating, rules selected, and the rules that selected an
event and then required nothing of it because a condition never held. Every number is the per-event
engine's, grouped — the same counters `auditmodel check-coverage` reports for the same folder,
events the core schema rejects included, so the tab cannot become a second opinion. A profile that governs nothing is
reported as governing nothing, never as satisfied — an event no rule selects is **not applicable**,
and not applicable is not conformance. Nothing here is rendered as a percentage or a grade: "7 of 15
rules selected" describes this archive, not its quality. Measuring is a button, because it is a
profile check per event per profile.

**Observed Flow** — cross-application flows, built from `request.traceId` and
`request.correlationId`. Where events declare `request.parentSpanId` (added in OpenAuditModel 1.0),
each caller is joined to the callee that names it, drawn solid; where they do not, neighbours in
time are joined, drawn dashed and labelled as order in time only.
An aggregated service map shows which applications hand work to which, with the transition count,
median gap and failure count on each edge, and a health ring on each node. Selecting a flow
highlights the path it actually took; selecting a node filters the events to that application.
Below the map, each flow appears as a per-application timeline and an ordered event list.

![The Observed Flow tab, showing the service map, a per-application timeline and the ordered events of one flow](assets/traces.png)

The flow above starts with a monitoring alert, passes through the gateway to a payment authorization
that fails, schedules a retry, and ends ten hours later with an incident being opened — five events
from four applications, linked only because they carry the same `traceId`.

Flows are built only from identifiers the producer declared. Grouping by "same resource" or "same
actor" would link events that merely touch the same thing, and showing that as one flow would claim
more than the data says.

## Running it

Requires Node.js 22 or newer. Building the desktop application also needs the Rust toolchain, and on
Windows the MSVC build tools ("Desktop development with C++", from either the standalone Build Tools
or a full Visual Studio installation). On macOS it needs the Xcode command line tools
(`xcode-select --install`), and a universal build needs both Rust targets:
`rustup target add aarch64-apple-darwin x86_64-apple-darwin`. The Kafka source builds librdkafka and
OpenSSL from source. On an Apple Silicon Mac that needs nothing more. Windows, an Intel Mac and a
universal build — whose x86_64 slice is compiled for another architecture — also need
[CMake](https://cmake.org/download/) on the `PATH`, and Windows needs Perl (Strawberry Perl, which the
CI runners already have).

```bash
npm install
npm run tauri dev      # development, with hot reload
npm test               # the test suite
npm run tauri build    # release binaries
```

`npm run dev` runs the frontend alone in a browser, with no Rust prerequisites — useful when working
on the interface. File loading needs the desktop shell.

Build through the Tauri CLI rather than calling `cargo build` yourself: the CLI is what tells the
application to load its bundled frontend instead of the development server, so a binary built with
bare cargo opens a window and renders nothing.

To have something to look at:

```bash
npm run demo-logs      # writes demo-logs/, then open that folder in the app
```

To try reading from Kafka, with Docker running:

```bash
npm run demo-logs
eval "$(src-tauri/kafka-source/tests/broker/start.sh)"   # a local broker, fresh certificates
tools/demo-kafka.sh                                       # the demo logs, on topic audit.demo
tools/demo-kafka.sh --trickle                             # then one a second, to listen to
```

Then save a source with bootstrap server `localhost:9092` and no TLS — or `localhost:9094` with TLS
and SASL, user `reader`, password `reader-secret`, and the CA file whose path `start.sh` printed.
`src-tauri/kafka-source/tests/broker/stop.sh` removes the broker.

The demo data is invented, deterministic and self-checking. It includes an intact hash chain, a
chain broken in three specific ways, events that trip seven privacy rules, profile violations, and
flows spanning four applications. Every credential-shaped value in it is recognisably fake.

## Keeping up with the specification

The schema, the ten profile definitions and the analysis engines all come from
`@openauditmodel/cli`, pinned to an exact version and bundled at build time. The app therefore works
offline and cannot hold a schema from one release beside engines from another — not because a test
catches it, but because there is only one place any of it comes from.

Keeping up is one line:

```bash
npm install @openauditmodel/cli@<version> --save-exact
npm run verify
```

The parity suite runs the pinned engines against the release's own fixture corpus and its
conformance kit, so a release that changed a verdict says so before the pin is committed. That is
how the 0.5.0 pin was taken: two new signature algorithms landed upstream, the suite failed on
exactly the two fixtures that moved, and the fix was one list.

## Security

The threat model is hostile content, not a hostile user: reading someone's audit archive — from a
folder or from a broker — should not compromise the machine reading it, and reading from a broker
should not change the broker.

- Reading from Kafka leaves nothing behind: partitions are assigned and sought, never subscribed, so
  no consumer group is joined; no offset is committed; asking for a topic never creates it. A test
  against a real broker holds each of these.
- A Kafka source is saved only after a system dialog — which nothing in the webview can click —
  names the brokers, the protection and the user. Its password goes to the system keychain, never
  returns to the webview, and is sent only to the brokers, as the user and over the connection it
  was entered for.

- From the webview, filesystem access is limited to the folder picked in the dialog and the file
  chosen when exporting. The capabilities file grants no static path.
- The release build ships a Content-Security-Policy with no `unsafe-eval`; the schema validator is
  precompiled so that no runtime code generation is needed. CI fails if either regresses.
- The webview cannot navigate away from the bundled app. External links open in the system browser
  through a scoped allow list.
- Structure too deeply nested to validate or display is reported as a finding rather than crashing
  the window.

See [SECURITY.md](SECURITY.md) for the full posture and how to report an issue.

## Distribution and code signing

Releases ship **one portable executable for Windows x64** and **one universal disk image for
macOS**. Download, run, delete when you are done — nothing is installed and no administrator rights
are needed on either. `npm run tauri build` still produces an MSI and an NSIS installer locally if
you want them; they are simply not published.

The macOS image is **signed with a Developer ID certificate and notarized by Apple**, so it opens on
a double click with no Gatekeeper prompt. One image covers Apple Silicon and Intel. The release job
verifies this rather than assuming it: it mounts the image it just built and runs `spctl --assess`,
`codesign --verify` and `stapler validate` against the application inside, and fails the release if
any of the three does.

The Windows binary is **unsigned**, because there is no code-signing certificate for it. In
practice:

- Windows SmartScreen shows "Windows protected your PC" on first run of a downloaded copy; the user
  clicks "More info → Run anyway". Publishing a portable executable rather than an installer avoids
  a second prompt — an installer would also raise a UAC dialog reading "unknown publisher" — but it
  does not avoid the SmartScreen warning. Only a certificate does that.
- Nothing is blocked outright, but the warning is real friction for anyone who does not know where
  the file came from.
- Each release publishes a SHA-256 alongside the binary. That detects a corrupted or truncated
  download; it is not a substitute for a signature, since the checksum sits on the same page as the
  file it describes.
- The economical routes to signing are Azure Trusted Signing or Certum's open-source certificate.
  A self-signed certificate does not help: SmartScreen ignores it.
- The executable needs the WebView2 runtime, which is present on Windows 11 and installed alongside
  Edge on Windows 10. With no installer to bootstrap it, a machine without it needs it once from
  Microsoft.

Linux is not a target: no application is built, tested or published for it — CI runs only the Kafka
source's tests there, because the broker they need runs in Docker. Nothing about the application
prevents it — the same Rust shell and the same frontend would run under WebKitGTK — and it is added
if it is ever asked for, as a decision rather than a drift. Until then a Linux binary from any source
is not this project's.

## Known limitations

- **Signatures prove only as much as the key's source does.** The app verifies against the key you
  choose and cannot tell you whose key it is; see above.
- **No checkpoint or inclusion proof verification.** Chain verification proves that the events you
  opened are consistent with each other; it cannot prove they are all the events that existed. A
  chain whose most recent events were deleted is internally consistent and is reported here as
  intact — correctly, and that is the limit. Seeing a deleted tail takes a checkpoint recorded
  somewhere the store's administrators do not control, which the `auditmodel` CLI compares an
  archive against with `verify-checkpoint`; proving one event belongs to a published tree takes
  `verify-proof`. Neither is ported here yet.
- Everything read stays in memory, so loading is bounded: JSON Lines files are streamed a line at a
  time, a single `.json` document over 32 MB is declined rather than read, and a load stops at
  100,000 events. Each of those is reported on screen — as is every file that could not be read and
  every directory that was not entered — but it does mean a very large archive cannot be viewed
  whole.
- Verifying chains is automatic only while a folder holds fewer than 5,000 chain members. Above
  that it is a button, like the per-event digest sweep, rather than work every load pays for.
- Loading still reads and validates every file before the table fills in. The table virtualizes, so
  scrolling stays smooth, but the initial pass over a big folder takes time.
- Only JSON and JSON Lines are read, and from Kafka only record values that are JSON text; any other
  export has to be converted first.
- Reading from Kafka again replaces what is on screen; one read or one listening session runs at a
  time. Listening follows the partitions the topic had when it started.
- The schema, the profiles and the analysis engines all come from one pinned release, so they can
  lag the canonical repository until that pin is raised. A release the pin has not reached is not
  evaluated here, and a profile written in a rule vocabulary this build does not implement is
  refused by name rather than partly evaluated.
- Directory recursion is depth-limited and does not follow symlink cycles.
- Bookmarks last for the session. The flow map layout persists; the theme choice persists.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). The analysis comes from the specification's conformance
tooling and has to keep giving the same answers, so that document is mostly about which invariants
a change has to preserve.

Report security issues privately rather than in the tracker — [SECURITY.md](SECURITY.md) explains
how, and why a bug report should never carry a real audit log.

## License

[Apache License 2.0](LICENSE).
