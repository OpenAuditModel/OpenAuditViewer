/**
 * The Overview tab: a summary of everything loaded, before any row is
 * selected. All numbers here are computed from data already in memory —
 * nothing is re-read from disk and nothing leaves the machine.
 *
 * Chain verification and the digest sweep run here asynchronously: chains
 * automatically (there are usually few chain members), the full digest sweep
 * only on request, since hashing every event of a large folder is work the
 * user should ask for rather than pay on every load.
 */
import { useEffect, useMemo, useState } from "react";
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

  useEffect(() => {
    setSweep({ status: "idle" });

    if (chainMembers.length === 0) {
      setChainReport(undefined);
      return;
    }

    let cancelled = false;
    setChainsVerifying(true);
    void verifyChains(
      chainMembers.map((row) => ({
        label: row.rowId,
        event: row.event as Record<string, unknown>,
      })),
    ).then((report) => {
      if (!cancelled) {
        setChainReport(report);
        setChainsVerifying(false);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [chainMembers]);

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
    setSweep({ status: "running" });
    let verified = 0;
    const failed: { label: string; message: string }[] = [];

    for (const row of withHash) {
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
