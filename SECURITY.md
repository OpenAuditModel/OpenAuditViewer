# Security Policy

## Supported versions

| Version | Status                                                |
| ------- | ----------------------------------------------------- |
| 1.0.x   | Current release. Fixes applied to `main`.             |
| 0.6.x   | Superseded. No fixes; upgrade to the current release. |
| 0.5.x   | Superseded. No fixes; upgrade to the current release. |
| 0.4.x   | Superseded. No fixes; upgrade to the current release. |
| 0.3.x   | Superseded. No fixes; upgrade to the current release. |
| 0.2.x   | Superseded. No fixes; upgrade to the current release. |
| 0.1.x   | Superseded. No fixes; upgrade to the current release. |

**What receives fixes.** Only the newest release. A fix lands on `main` and ships in the next release;
there is no backport to an earlier minor. None is needed to stay current: every 1.x release reads
every event the one before it did, because the specification's 1.x versions only add
([ADR 0017](https://github.com/OpenAuditModel/OpenAuditModel/blob/main/decisions/0017-versioning-and-compatibility.md)).
A security fix is released as soon as it is ready. Every 0.x release is closed.

OpenAuditViewer has not been externally audited, and there is no long-term support commitment beyond
the above.

## Reporting a vulnerability

**Do not open a public issue for a security report.**

Report privately through GitHub's private vulnerability reporting on this repository
(Security → Report a vulnerability). If that is unavailable to you, open a public issue containing
only a request for a private contact channel, with no technical detail.

Please include what the issue is, how to reproduce it, and what an attacker gains. If reproducing it
needs an input file, construct a synthetic one — **never attach a real audit log**. A reproduction
case containing real names, addresses or resource identifiers turns a bug report into a disclosure.

Expect an acknowledgement within a few working days. This is a young project maintained on a
best-effort basis; there is no commercial response commitment, and saying so plainly is more useful
than a target nobody can hold to.

## Threat model

The app reads content it has no reason to trust. The adversary is **the content** — a file in an
archive, a record on a broker, and from 1.0 a broker's own responses — not the person running the
application: someone hands over an archive of audit logs, or a topic to read, and reading it should
not compromise the machine it is read on, or change the broker it was read from.

That shapes the design:

- **No egress of audit content.** The app never transmits what it reads: no telemetry, no crash
  reporting and no remote validation service, including the project's own. The invariant is about
  where data goes, not about whether a socket exists — anything the app reads, it reads from a
  source the operator selected.

  Three outbound actions exist, each requiring a click. Opening a documented external link hands a
  URL to the system browser. **Reading from Kafka** connects to the brokers of a source the operator
  saved, reads, and disconnects; it is described below. And **Checking for updates** issues one HTTPS GET to
  `api.github.com/repos/OpenAuditModel/OpenAuditViewer/releases/latest`, from the button in Settings
  and from nowhere else. It carries a User-Agent and an `Accept` header naming the GitHub media
  type, and nothing else: no query, no body, no cookies, no credentials, and nothing about the
  archive on screen or the machine. It is never performed on
  launch, on a timer, or in the background, and nothing about it is remembered between runs — an
  operator who never presses it, and never reads from Kafka, runs an application that never opens
  a socket.

  The request is made by Rust against a constant URL. The webview cannot supply one, and the
  Content-Security-Policy still forbids the frontend from reaching the network at all, so this
  cannot become a general HTTP client reachable from a page that renders untrusted log content.
  Exactly two strings are read out of the response, a tag and a URL, and neither is rendered as
  markup or opened without a second click.

- **Reading from Kafka changes nothing on the broker, and sends a credential nowhere new.** The
  `oav-kafka` crate assigns partitions and seeks, never subscribes, so no consumer group is joined;
  it never commits an offset; it asks for a topic's metadata with automatic creation off, so a
  missing topic is reported and not created. A test runs against a real broker and asserts the
  group it names, `openaudit-viewer-readonly`, never appears in the broker's group list — after a
  window and after listening. A window is bounded by 100,000 events, 256 MB, five minutes and a
  30-second stall, and a record over 8 MiB is refused rather than read. **Listening**, which keeps
  the connection open after the window to add what arrives, is its own request, shown by a badge
  with a Stop button for as long as it runs, counted against the same 100,000 events and ended
  after eight hours. What a broker sends is text handed to the same parser and engines as a
  file line, with the same limits.

  The webview names no broker address when it reads: it names a saved source. A source is saved
  only after a **native confirmation dialog**, drawn by the operating system, names its brokers, its
  protection and its user — a script in the webview cannot click it, so injected content cannot
  point the app at a new host. The password goes to the **system keychain** and never returns to
  the webview. It is tied to everything it was entered for — the brokers, the protection, the SASL
  mechanism, the user and the CA — and a source whose any of those change loses it unless it is
  entered again in the same save, which the dialog then states. SASL without TLS is not offered, TLS
  verifies the broker's certificate and host name against the public roots or a CA file the
  operator chose, and plaintext is allowed only as its own named choice with a warning that audit
  events will cross the network unencrypted. The source list is a file Rust writes in the app's
  configuration directory; it holds no secret. The keychain entry records what its password was
  entered for and is checked on every read, so a source list changed on disk behind the app's back
  finds the password refused rather than sent somewhere new. Every name the dialog shows is a single
  line: control characters, line and paragraph separators, bidirectional overrides and invisible
  characters are refused, so a value cannot hide a second host in the text the user confirms.

- **Filesystem access is scoped to what was picked.** The Tauri capabilities grant no static path.
  From the webview, reading is possible only within the folder chosen in the native dialog, writing
  only to the file chosen in the save dialog, and the app's own configuration and data folders are
  denied to it outright, whatever folder was picked. Rust itself writes one file, the Kafka source
  list in the app's configuration directory, and reads a CA file only from its own native dialog.
- **A trusted key never enters the webview.** The public key used to verify signatures is chosen
  in a native dialog that Rust opens, read by Rust (a regular file only, read to 64 KiB at most
  whatever its metadata says; PEM `PUBLIC KEY` only; a private key is refused by name) and held in memory for the session. The webview can neither name a path
  for it nor read its bytes: it receives a summary and a fingerprint, and each verification names
  that fingerprint, so a verdict cannot come back under a key the user has since replaced.
- **No runtime code generation.** The schema validator is precompiled at build time, and the
  shipped Content-Security-Policy has no `unsafe-eval`. CI fails if the bundle regains either.
- **The webview cannot navigate away** from the bundled application.
- **Hostile structure is survivable.** `JSON.parse` accepts nesting deeper than a validator or
  serializer can process, so those failures are caught and reported as ordinary findings rather
  than being allowed to take down the window.
- **Findings never carry values.** Privacy messages are static rule constants; only paths, rule
  identifiers and counts are interpolated.

## In scope

- Anything that lets file or record content execute code, escape the picked folder, reach the
  network, or crash the application in a way the user cannot recover from.
- Anything that lets content in the webview save or change a Kafka source without the native
  confirmation, send a saved password to a broker it was not entered for, or read it back; and
  anything that makes a read change the broker — join a group, commit an offset, create a topic.
- A chain reported intact, or a link reported held, across a hole a Kafka window left.
- Any case where the app reports an event as verified when the OpenAuditModel CLI would not, or
  reports a chain as intact when a link is broken. A viewer that is wrong about integrity is worse
  than no viewer. This includes a signature reported valid under a key the CLI would refuse.
- Any case where a finding, an error message or an export includes a value that should not have
  left the file it came from.
- Vulnerable dependencies.

## Out of scope

- The observation that a clean privacy scan does not prove a log is free of sensitive data. That is
  a documented limit of static analysis; see the OpenAuditModel specification, `privacy.md` §6.
- The observation that verifying a digest does not prove a log is complete. Deleting an entire
  chain leaves nothing to detect; see `integrity.md` §8.
- Whose key a trusted key is. The app verifies signatures against the key the operator chooses and
  cannot establish who holds it; a key taken from the same untrusted source as the events proves
  nothing, and the README says so beside the feature.
- The unsigned release binaries. This is stated in the README, not concealed.

## Handling audit data safely

Audit logs concentrate who did what to whom, are usually retained longer than production data, and
are often readable by more people than the data they describe. This app reads them locally and
writes nothing except an export you explicitly ask for, the Kafka sources you save — with no secret
in them — and their passwords, in the system keychain. The responsibility for where those files
live, and who can open them, stays with you.
