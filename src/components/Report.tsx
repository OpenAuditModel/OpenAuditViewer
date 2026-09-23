/**
 * The archive report: one page carrying everything the application
 * established about a folder, and everything it did not.
 *
 * A printed page outlives the session and travels further than the person who
 * made it. That shapes every choice here. The limits section is not an
 * appendix — it sits with the findings, because a reader holding a printout
 * cannot ask the screen what "3 chains intact" leaves out. The
 * conformance-is-not-compliance line is printed, not shown only on screen,
 * for the same reason: it is on its way to an auditor precisely when it is
 * easiest to lose.
 *
 * It is a page, not a document format. Printing is the browser's, so the
 * operator decides what happens to it; nothing is written to disk by this
 * app, and nothing here should be consumed as a result shape. The canonical
 * repository's `inspect` will define that, and this app should read it rather
 * than invent one three releases early.
 */
import { useEffect, useRef, useState } from "react";
import { buildArchiveReport, SEVERITY_ORDER, type ArchiveReport } from "../lib/report";
import type { LoadedEvent, LoadSummary } from "../lib/types";
import { useTrustedKey } from "../hooks/useTrustedKey";
import { formatFingerprint } from "../lib/integrity/trusted-key";
import { displayPath } from "../lib/paths";

interface Props {
  readonly events: readonly LoadedEvent[];
  readonly summary: LoadSummary | undefined;
  readonly folder: string | undefined;
}

type State =
  | { readonly status: "idle" }
  | { readonly status: "running" }
  | { readonly status: "done"; readonly report: ArchiveReport };

function Row({ label, value }: { readonly label: string; readonly value: string | number }) {
  return (
    <tr>
      <td>{label}</td>
      <td>{value}</td>
    </tr>
  );
}

export function Report({ events, summary, folder }: Props) {
  const [state, setState] = useState<State>({ status: "idle" });
  const { verifier, key, choose } = useTrustedKey();
  const onScreen = useRef(events);
  onScreen.current = events;
  const keyInUse = useRef(verifier);
  keyInUse.current = verifier;

  // A report states which key its signatures were checked with. Once the user
  // trusts another key, or none, the page on screen describes a choice that is
  // no longer in effect, so it goes and the next one is asked for.
  useEffect(() => {
    setState({ status: "idle" });
  }, [verifier]);

  async function run(): Promise<void> {
    const requested = events;
    const requestedKey = verifier;
    setState({ status: "running" });
    const report = await buildArchiveReport(requested, summary, folder, requestedKey);
    if (onScreen.current === requested && keyInUse.current === requestedKey) {
      setState({ status: "done", report });
    }
  }

  if (events.length === 0) {
    return <p className="empty-state">Open a folder to produce a report.</p>;
  }

  if (state.status !== "done") {
    return (
      <div className="report">
        <div className="panel">
          <div className="block-head">
            <span className="label">Archive report</span>
          </div>
          <div className="block-body">
            <p className="detail-note">
              One page covering what was loaded, what validated, what the privacy linter found, what
              verified, and which profiles reached this archive — with what none of it establishes.
              Producing it verifies every declared digest and every chain and measures every
              profile, so it waits for a click.
            </p>
            <div className="sweep-row">
              <span className="detail-note-inline">
                {key === undefined
                  ? "Signatures: not checked — no public key chosen."
                  : `Signatures: checked with the ${key.keyType} key ${formatFingerprint(key.fingerprint).slice(0, 19)}… from ${key.fileName}.`}
              </span>{" "}
              <button type="button" className="link-button" onClick={() => void choose()}>
                {key === undefined ? "Choose a public key…" : "Choose another…"}
              </button>
            </div>
            <div className="sweep-row">
              <button
                type="button"
                className="secondary-button"
                onClick={() => void run()}
                disabled={state.status === "running"}
              >
                {state.status === "running"
                  ? "Producing…"
                  : `Produce a report for ${events.length} events`}
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  const { report } = state;
  const { archive, validity, privacy, integrity, profiles } = report;
  const reached = profiles.filter((entry) => entry.governedNames > 0);

  return (
    <div className="report">
      <div className="report-actions">
        <button type="button" className="secondary-button" onClick={() => window.print()}>
          Print
        </button>
        <button
          type="button"
          className="secondary-button"
          onClick={() => setState({ status: "idle" })}
        >
          Produce again
        </button>
      </div>

      <article className="report-page">
        <header>
          <h2>Archive report</h2>
          <p className="report-meta">
            {archive.folder ?? "folder"} · generated {report.generatedAt}
          </p>
        </header>

        <section>
          <h3>What this report is</h3>
          <p>
            A record of what the OpenAuditViewer established about the files in this folder, on the
            machine that produced it, entirely offline. Every number below was computed from the
            events as they were read.
          </p>
          <p className="report-warning">
            <strong>Conformance is not compliance.</strong> Nothing here is evidence of meeting any
            law, regulation, standard or contract, and no section should be presented as such. A
            profile states that an event carries the fields a domain agreed it should carry; it says
            nothing about whether what the event records actually happened, or whether it was
            permitted.
          </p>
        </section>

        <section>
          <h3>The archive</h3>
          <table className="report-table">
            <tbody>
              <Row label="Events loaded" value={archive.events} />
              <Row
                label="Files read"
                value={`${archive.filesRead} of ${archive.filesFound} found`}
              />
              {archive.unreadableFiles > 0 ? (
                <Row label="Files that could not be read" value={archive.unreadableFiles} />
              ) : null}
              {archive.skippedFiles > 0 ? (
                <Row label="Files declined for size" value={archive.skippedFiles} />
              ) : null}
              {archive.unreadableDirectories > 0 ? (
                <Row
                  label="Directories that could not be listed"
                  value={archive.unreadableDirectories}
                />
              ) : null}
            </tbody>
          </table>
          {archive.truncated ? (
            <p className="report-warning">
              Loading stopped at {archive.eventLimit} events.{" "}
              <strong>This folder holds more than was read</strong>, and every count below describes
              the part that was.
            </p>
          ) : null}
        </section>

        <section>
          <h3>Schema validity</h3>
          <table className="report-table">
            <tbody>
              <Row label="Valid against the canonical schema" value={validity.valid} />
              <Row label="Invalid" value={validity.invalid} />
            </tbody>
          </table>
          {validity.worstFiles.length > 0 ? (
            <table className="report-table">
              <thead>
                <tr>
                  <th>File</th>
                  <th>Invalid events</th>
                </tr>
              </thead>
              <tbody>
                {validity.worstFiles.map((entry) => (
                  <tr key={entry.file}>
                    <td>{entry.file}</td>
                    <td>{entry.invalid}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : null}
          {validity.filesWithInvalid > validity.worstFiles.length ? (
            <p className="report-note">
              and {validity.filesWithInvalid - validity.worstFiles.length} further file
              {validity.filesWithInvalid - validity.worstFiles.length === 1 ? "" : "s"} holding
              invalid events, not listed here.
            </p>
          ) : null}
        </section>

        <section>
          <h3>Privacy</h3>
          <p>
            {privacy.findings === 0
              ? "No values shaped like credentials or unminimized payloads were found."
              : `${privacy.findings} findings across ${privacy.eventsAffected} events.`}
          </p>
          {privacy.findings > 0 ? (
            <>
              <table className="report-table">
                <thead>
                  <tr>
                    <th>Severity</th>
                    <th>Findings</th>
                  </tr>
                </thead>
                <tbody>
                  {SEVERITY_ORDER.filter((severity) => privacy.bySeverity[severity] > 0).map(
                    (severity) => (
                      <tr key={severity}>
                        <td>{severity}</td>
                        <td>{privacy.bySeverity[severity]}</td>
                      </tr>
                    ),
                  )}
                </tbody>
              </table>
              <table className="report-table">
                <thead>
                  <tr>
                    <th>Rule</th>
                    <th>Findings</th>
                  </tr>
                </thead>
                <tbody>
                  {privacy.byRule.map((entry) => (
                    <tr key={entry.ruleId}>
                      <td>{entry.ruleId}</td>
                      <td>{entry.count}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          ) : null}
          <p className="report-note">
            A clean result is not proof the archive is safe. The linter reports values shaped like
            secrets; a password that is an ordinary word, and most personal data, match nothing. No
            value that produced a finding appears in this report.
          </p>
        </section>

        <section>
          <h3>Tamper-evidence</h3>
          <table className="report-table">
            <tbody>
              <Row label="Events declaring integrity material" value={integrity.declared} />
              <Row label="Digests verified" value={integrity.verified} />
              <Row label="Digests that failed" value={integrity.failed.length} />
              <Row label="Events declaring a signature" value={integrity.signatures.declared} />
              <Row
                label="Signatures checked with"
                value={
                  integrity.signatures.checkedWith === undefined
                    ? "no key — declared, not checked"
                    : `${integrity.signatures.checkedWith.keyType} key ${formatFingerprint(integrity.signatures.checkedWith.fingerprint)}`
                }
              />
              {integrity.chains !== undefined ? (
                <>
                  <Row label="Chains checked" value={integrity.chains.checked} />
                  <Row label="Chains intact" value={integrity.chains.intact} />
                  {integrity.chains.unassigned > 0 ? (
                    <Row
                      label="Chain members that could not be verified"
                      value={integrity.chains.unassigned}
                    />
                  ) : null}
                </>
              ) : null}
            </tbody>
          </table>
          {integrity.failed.length > 0 ? (
            <table className="report-table">
              <thead>
                <tr>
                  <th>Event</th>
                  <th>Finding</th>
                </tr>
              </thead>
              <tbody>
                {integrity.failed.map((entry) => (
                  <tr key={entry.label}>
                    <td title={entry.label}>{displayPath(entry.label, report.archive.folder)}</td>
                    <td>{entry.kinds.join(", ")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : null}
          {integrity.failedTotal > integrity.failed.length ? (
            <p className="report-note">
              and {integrity.failedTotal - integrity.failed.length} more not listed here.
            </p>
          ) : null}
          {integrity.chains !== undefined && !integrity.chains.allIntact ? (
            <p className="report-warning">
              <strong>Not every chain is intact.</strong>{" "}
              {integrity.chains.unassigned > 0
                ? `${integrity.chains.unassigned} event${integrity.chains.unassigned === 1 ? "" : "s"} declaring a chain could not be verified, so the chains they belong to are not established.`
                : "At least one chain has a broken link or a modified event."}
            </p>
          ) : null}
          <p className="report-note">
            Verification detects modification of the events that were supplied. It does not prove
            they are all the events that existed: a chain whose most recent entries were deleted is
            internally consistent and is reported intact here. Seeing that requires a checkpoint
            recorded outside the store, which this application does not read.{" "}
            {integrity.signatures.checkedWith === undefined
              ? "Signatures were not checked: no public key was chosen, so every event that declares one is counted on its hash alone."
              : `Signatures were checked against the key in ${integrity.signatures.checkedWith.fileName}, chosen by whoever produced this report. A signature that verifies proves the event was sealed by the holder of that key — and says as much about the producer as the place that key came from does.`}
          </p>
        </section>

        <section>
          <h3>Profiles</h3>
          <p>
            {reached.length === 0
              ? "No published profile governs a single event in this archive."
              : `${reached.length} of ${profiles.length} profiles govern events here.`}{" "}
            An event no rule selects is reported not applicable, which is not conformance: the
            profile said nothing about it.
          </p>
          {reached.length > 0 ? (
            <table className="report-table">
              <thead>
                <tr>
                  <th>Profile</th>
                  <th>Conforming</th>
                  <th>Violations</th>
                  <th>Rules selected</th>
                </tr>
              </thead>
              <tbody>
                {reached.map((entry) => (
                  <tr key={entry.name}>
                    <td>{entry.name}</td>
                    <td>{entry.conforming}</td>
                    <td>{entry.violations}</td>
                    <td>
                      {entry.rulesSelected} of {entry.rulesTotal}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : null}
          {report.refusedProfiles.length > 0 ? (
            <p className="report-warning">
              {report.refusedProfiles.length} profile
              {report.refusedProfiles.length === 1 ? " was" : "s were"} not evaluated, being written
              in a rule vocabulary this build does not implement:{" "}
              {report.refusedProfiles
                .map((profile) => `${profile.name} (${profile.profileVersion})`)
                .join(", ")}
              .
            </p>
          ) : null}
          <p className="report-note">
            Rule counts describe this archive. They are not a score, a percentage or a target, and a
            profile is not a checklist an archive is meant to fill.
          </p>
        </section>

        <section>
          <h3>What this report does not establish</h3>
          <ul className="report-list">
            <li>
              That the events describe what actually happened. Nothing here reads the systems they
              came from.
            </li>
            <li>
              That the archive is complete. Deleted events leave no trace an internal check can
              find.
            </li>
            <li>
              {integrity.signatures.checkedWith === undefined
                ? "That any signature is genuine. None was verified; no public key was chosen."
                : "That the key is the producer's. The signatures were checked against it; whose key it is was the choice of whoever produced this report."}
            </li>
            <li>
              That the events are free of personal data. The linter finds shapes, not meaning.
            </li>
            <li>
              Compliance with anything. Conformance to a specification is not compliance with a law,
              a regulation, a standard or a contract.
            </li>
          </ul>
        </section>
      </article>
    </div>
  );
}
