/**
 * The Overview tab: a summary of everything loaded, before any row is
 * selected. All numbers here are computed from data already in memory —
 * nothing is re-read from disk and nothing leaves the machine.
 *
 * Chain verification and the digest sweep run here asynchronously, and both
 * are bounded by the same rule: hashing every event of a large folder is work
 * the user should ask for rather than pay on every load. The digest sweep
 * always waits for a click; chain verification runs on open only while the
 * chains are small enough for that to cost nothing worth noticing.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import type { LoadedEvent, LoadSummary } from "../lib/types";
import { readIntegrity, verifyEventIntegrity } from "../lib/integrity/verify-event";
import { verifyChains } from "../lib/integrity/chain";
import type { ChainReport } from "../lib/integrity/types";
import { SEVERITY_ORDER, type Severity } from "../lib/privacy/types";

interface Props {
  readonly events: readonly LoadedEvent[];
  readonly summary: LoadSummary | undefined;
  readonly onSelectApplication: (name: string) => void;
}

interface AppRow {
  readonly name: string;
  readonly count: number;
  readonly invalid: number;
  readonly findings: number;
}

type SweepState =
  | { readonly status: "idle" }
  | { readonly status: "running" }
  | {
      readonly status: "done";
      readonly verified: number;
      readonly failed: readonly { readonly label: string; readonly message: string }[];
    };

const SEVERITY_CLASS: Readonly<Record<Severity, string>> = {
  critical: "sev-critical",
  high: "sev-high",
  medium: "sev-medium",
  low: "sev-low",
  info: "sev-info",
};

function shortChainId(chainId: string): string {
  return chainId.length > 12 ? `${chainId.slice(0, 12)}…` : chainId;
}

/**
 * Chain members verified without being asked.
 *
 * Verification digests every member of every chain, in parallel, through Web
 * Crypto. Measured on a sealed chain outside the webview it costs about 55 µs
 * a member and scales linearly, so this limit is roughly a quarter-second
 * there — and a webview on a modest machine is slower, which is what the
 * margin is for: past about a second a delay stops feeling like the folder
 * simply opened. A load that reached the event ceiling would be twenty times
 * this, and the answer for that is the one the digest sweep already gives:
 * offer the work, and let the user decide when to spend it.
 */
const AUTOMATIC_CHAIN_LIMIT = 5_000;

export function Overview({ events, summary, onSelectApplication }: Props) {
  const [chainReport, setChainReport] = useState<ChainReport | undefined>();
  const [chainsVerifying, setChainsVerifying] = useState(false);
  const [sweep, setSweep] = useState<SweepState>({ status: "idle" });

  const validRows = useMemo(
    () => events.filter((row) => row.valid && row.event !== null),
    [events],
  );

  const withHash = useMemo(
    () => validRows.filter((row) => typeof readIntegrity(row.event)?.hash === "string"),
    [validRows],
  );

  // Includes schema-invalid rows on purpose: verifyChains reports them as
  // unassigned, and a chain with an unverifiable member is not intact.
  const chainMembers = useMemo(
    () =>
      events.filter(
        (row) => row.event !== null && typeof readIntegrity(row.event)?.chainId === "string",
      ),
    [events],
  );

  const chainInputs = useMemo(
    () =>
      chainMembers.map((row) => ({
        label: row.rowId,
        event: row.event as Record<string, unknown>,
      })),
    [chainMembers],
  );

  useEffect(() => {
    setSweep({ status: "idle" });

    // Nothing to verify, or too much to verify unasked. Either way the report
    // from a folder opened earlier has to go: leaving it on screen beside a
    // different folder's events would describe data that is no longer shown.
    if (chainInputs.length === 0 || chainInputs.length > AUTOMATIC_CHAIN_LIMIT) {
      setChainReport(undefined);
      // Nothing is running for this folder — including anything a previous
      // folder left running, whose result this component will discard.
      setChainsVerifying(false);
      return;
    }

    let cancelled = false;
    setChainsVerifying(true);
    void verifyChains(chainInputs).then((report) => {
      if (!cancelled) {
        setChainReport(report);
        setChainsVerifying(false);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [chainInputs]);

  // Which events are on screen right now. Work started on request runs for as
  // long as it runs, and the user is free to open another folder meanwhile;
  // whatever it computed then describes data nobody is looking at any more,
  // and painting it over the new folder's numbers would be the app claiming
  // something the events on screen do not say.
  const onScreen = useRef(events);
  useEffect(() => {
    onScreen.current = events;
  }, [events]);

  /** Verifies chains a load was too large to verify on open. */
  async function runChainVerification(): Promise<void> {
    const requested = events;
    setChainsVerifying(true);
    const report = await verifyChains(chainInputs);
    if (onScreen.current !== requested) {
      return;
    }
    setChainReport(report);
    setChainsVerifying(false);
  }

  const applications = useMemo<AppRow[]>(() => {
    const byName = new Map<string, { count: number; invalid: number; findings: number }>();
    for (const row of events) {
      const name = row.applicationName ?? "(unknown)";
      const entry = byName.get(name) ?? { count: 0, invalid: 0, findings: 0 };
      entry.count += 1;
      if (!row.valid) entry.invalid += 1;
      entry.findings += row.privacyFindings.length;
      byName.set(name, entry);
    }
    return [...byName.entries()]
      .map(([name, entry]) => ({ name, ...entry }))
      .sort((left, right) => right.count - left.count);
  }, [events]);

  const severityCounts = useMemo(() => {
    const counts: Record<Severity, number> = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
    for (const row of events) {
      for (const finding of row.privacyFindings) {
        counts[finding.severity] += 1;
      }
    }
    return counts;
  }, [events]);

  const topRules = useMemo(() => {
    const byRule = new Map<string, number>();
    for (const row of events) {
      for (const finding of row.privacyFindings) {
        byRule.set(finding.ruleId, (byRule.get(finding.ruleId) ?? 0) + 1);
      }
    }
    return [...byRule.entries()].sort((left, right) => right[1] - left[1]).slice(0, 5);
  }, [events]);

  const totalFindings = events.reduce((sum, row) => sum + row.privacyFindings.length, 0);
  const invalidCount = events.length - events.filter((row) => row.valid).length;
  const eventsWithFindings = events.filter((row) => row.privacyFindings.length > 0).length;
  const maxAppCount = applications[0]?.count ?? 1;

  async function runDigestSweep(): Promise<void> {
    const requested = events;
    setSweep({ status: "running" });
    let verified = 0;
    const failed: { label: string; message: string }[] = [];

    for (const row of withHash) {
      // Abandoned rather than finished when the folder it was started for is
      // no longer the one on screen.
      if (onScreen.current !== requested) {
        return;
      }
      const result = await verifyEventIntegrity(row.event, row.sourceFile, {
        validateSchema: false,
      });
      if (result.verified) {
        verified += 1;
      } else {
        failed.push({
          label: row.rowId,
          message: result.findings.map((finding) => finding.message).join("; "),
        });
      }
    }

    setSweep({ status: "done", verified, failed });
  }

  if (events.length === 0) {
    return (
      <div className="overview empty-state">
        <p>Open a folder to see an overview of its audit events.</p>
      </div>
    );
  }

  return (
    <div className="overview">
      <div className="stat-grid">
        <div className="stat-card">
          <div className="stat-value">{events.length}</div>
          <div className="stat-label">Events</div>
        </div>
        <div className="stat-card">
          <div className={invalidCount > 0 ? "stat-value stat-bad" : "stat-value stat-good"}>
            {invalidCount}
          </div>
          <div className="stat-label">Schema invalid</div>
        </div>
        <div className="stat-card">
          <div className={totalFindings > 0 ? "stat-value stat-warned" : "stat-value stat-good"}>
            {totalFindings}
          </div>
          <div className="stat-label">Privacy findings</div>
        </div>
        <div className="stat-card">
          <div className="stat-value">{withHash.length}</div>
          <div className="stat-label">With integrity hash</div>
        </div>
        <div className="stat-card">
          <div className="stat-value">{summary?.filesRead ?? "—"}</div>
          <div className="stat-label">Files read</div>
        </div>
        <div className="stat-card">
          <div className="stat-value">{applications.length}</div>
          <div className="stat-label">Applications</div>
        </div>
      </div>

      <div className="overview-columns">
        <div className="panel">
          <div className="block-head">
            <span className="label">
              <span className="swatch resource"></span>Applications
            </span>
          </div>
          <div className="block-body">
            {applications.map((app) => (
              <button
                type="button"
                className="bar-row"
                key={app.name}
                title={`Show only ${app.name}`}
                onClick={() => onSelectApplication(app.name)}
              >
                <span className="bar-name">{app.name}</span>
                <span className="bar-track">
                  <span
                    className="bar-fill"
                    style={{ width: `${(app.count / maxAppCount) * 100}%` }}
                  />
                </span>
                <span className="bar-count">{app.count}</span>
                {app.invalid > 0 ? (
                  <span className="bar-flag bad">{app.invalid} invalid</span>
                ) : null}
                {app.findings > 0 ? (
                  <span className="bar-flag warn">{app.findings} findings</span>
                ) : null}
              </button>
            ))}
          </div>
        </div>

        <div className="panel">
          <div className="block-head">
            <span className="label">
              <span className="swatch privacy"></span>Privacy findings
            </span>
            <span className={totalFindings > 0 ? "count-warn" : "count-ok"}>
              {totalFindings > 0 ? `${eventsWithFindings} events affected` : "clean"}
            </span>
          </div>
          <div className="block-body">
            {totalFindings === 0 ? (
              <div className="detail-note-inline">
                No credential-shaped values, tokens or connection strings found. A clean result is
                not a clearance — see specification/privacy.md.
              </div>
            ) : (
              <>
                <div className="severity-row">
                  {SEVERITY_ORDER.map((severity) =>
                    severityCounts[severity] > 0 ? (
                      <span className={`sev-pill ${SEVERITY_CLASS[severity]}`} key={severity}>
                        {severity} {severityCounts[severity]}
                      </span>
                    ) : null,
                  )}
                </div>
                <div className="rule-list">
                  {topRules.map(([ruleId, count]) => (
                    <div className="rule-line" key={ruleId}>
                      <span className="rule-id">{ruleId}</span>
                      <span className="bar-count">{count}</span>
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>
        </div>
      </div>

      <div className="panel">
        <div className="block-head">
          <span className="label">
            <span className="swatch chain"></span>Tamper evidence
          </span>
          <span className="count-ok">
            {withHash.length} of {validRows.length} valid events declare a hash
          </span>
        </div>
        <div className="block-body">
          {chainMembers.length === 0 ? (
            <div className="detail-note-inline">
              No event declares <code>integrity.chainId</code>, so there are no chains to verify.
              Single-event digests can still be checked below.
            </div>
          ) : chainsVerifying ? (
            <div className="detail-note-inline">Verifying chains…</div>
          ) : chainReport !== undefined ? (
            <div className="chain-list">
              {chainReport.unassigned.length > 0 ? (
                <div className="check-bad rule-line">
                  {chainReport.unassigned.length} event
                  {chainReport.unassigned.length === 1 ? "" : "s"} declaring a chainId could not be
                  verified (schema-invalid) — the affected chains are not intact
                </div>
              ) : null}
              {chainReport.chains.map((chain) => (
                <div className="rule-line" key={chain.chainId}>
                  <span className="rule-id" title={chain.chainId}>
                    {shortChainId(chain.chainId)}
                  </span>
                  <span className="detail-note-inline">
                    {chain.eventCount} events
                    {chain.firstSequence !== undefined && chain.lastSequence !== undefined
                      ? `, seq ${chain.firstSequence}–${chain.lastSequence}`
                      : ""}
                  </span>
                  <span className={chain.intact ? "count-ok" : "count-bad"}>
                    {chain.intact ? "intact" : `${chain.findings.length} issues`}
                  </span>
                </div>
              ))}
            </div>
          ) : chainMembers.length > AUTOMATIC_CHAIN_LIMIT ? (
            <div className="sweep-row">
              <button
                type="button"
                className="secondary-button"
                onClick={() => void runChainVerification()}
              >
                Verify {chainMembers.length.toLocaleString()} chain members
              </button>
              <span className="detail-note-inline">
                Not verified on open: this many events is work to ask for rather than pay for every
                time a folder is opened.
              </span>
            </div>
          ) : null}

          <div className="sweep-row">
            {sweep.status === "idle" ? (
              <button
                type="button"
                className="secondary-button"
                disabled={withHash.length === 0}
                onClick={() => void runDigestSweep()}
              >
                Verify all {withHash.length} digests
              </button>
            ) : sweep.status === "running" ? (
              <span className="count-pending">verifying {withHash.length} digests…</span>
            ) : (
              <>
                <span className={sweep.failed.length === 0 ? "count-ok" : "count-bad"}>
                  {sweep.verified} verified · {sweep.failed.length} failed
                </span>
                {sweep.failed.slice(0, 10).map((failure) => (
                  <div className="check-bad rule-line" key={failure.label}>
                    <code>{failure.label}</code> {failure.message}
                  </div>
                ))}
                {sweep.failed.length > 10 ? (
                  <div className="detail-note-inline">and {sweep.failed.length - 10} more</div>
                ) : null}
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
