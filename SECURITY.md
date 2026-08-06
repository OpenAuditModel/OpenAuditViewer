# Security Policy

## Supported versions

| Version | Status                                 |
| ------- | -------------------------------------- |
| 0.1     | Experimental. Fixes applied to `main`. |

OpenAuditViewer is **experimental**. It has not been externally audited, and there is no long-term
support commitment.

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

The app opens files it has no reason to trust. The adversary is **file content**, not the person
running the application: someone hands over an archive of audit logs, and reading it should not
compromise the machine it is read on.

That shapes the design:

- **No egress.** The app never transmits audit content: no telemetry, no crash reporting and no
  remote validation service, including the project's own. Opening a documented external link hands
  a URL to the system browser; that is the only outbound action. The invariant is about where data
  goes, not about whether a socket exists — anything the app reads, it reads from a source the
  operator selected.
- **Filesystem access is scoped to what was picked.** The Tauri capabilities grant no static path.
  Reading is possible only within the folder chosen in the native dialog, writing only to the file
  chosen in the save dialog.
- **No runtime code generation.** The schema validator is precompiled at build time, and the
  shipped Content-Security-Policy has no `unsafe-eval`. CI fails if the bundle regains either.
- **The webview cannot navigate away** from the bundled application.
- **Hostile structure is survivable.** `JSON.parse` accepts nesting deeper than a validator or
  serializer can process, so those failures are caught and reported as ordinary findings rather
  than being allowed to take down the window.
- **Findings never carry values.** Privacy messages are static rule constants; only paths, rule
  identifiers and counts are interpolated.

## In scope

- Anything that lets file content execute code, escape the picked folder, reach the network, or
  crash the application in a way the user cannot recover from.
- Any case where the app reports an event as verified when the OpenAuditModel CLI would not, or
  reports a chain as intact when a link is broken. A viewer that is wrong about integrity is worse
  than no viewer.
- Any case where a finding, an error message or an export includes a value that should not have
  left the file it came from.
- Vulnerable dependencies.

## Out of scope

- The observation that a clean privacy scan does not prove a log is free of sensitive data. That is
  a documented limit of static analysis; see the OpenAuditModel specification, `privacy.md` §6.
- The observation that verifying a digest does not prove a log is complete. Deleting an entire
  chain leaves nothing to detect; see `integrity.md` §8.
- Missing signature verification. The app deliberately does not check `integrity.signature`: it has
  no key registry and no way to obtain a trusted key, and checking a signature against a key taken
  from the same untrusted source would prove nothing.
- The unsigned release binaries. This is stated in the README, not concealed.

## Handling audit data safely

Audit logs concentrate who did what to whom, are usually retained longer than production data, and
are often readable by more people than the data they describe. This app reads them locally and
writes nothing except an export you explicitly ask for — but the responsibility for where those
files live, and who can open them, stays with you.
