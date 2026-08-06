/**
 * Privacy findings for one event.
 *
 * The empty state says what was looked for rather than "no problems": a
 * deterministic scan that finds nothing has not established that an event is
 * safe, and the wording has to leave that door closed.
 */
import type { PrivacyFinding } from "../../lib/types";
import { DetailBlock, plural } from "./DetailBlock";

interface Props {
  readonly findings: readonly PrivacyFinding[];
}

export function PrivacyBlock({ findings }: Props) {
  const hasFindings = findings.length > 0;

  return (
    <DetailBlock
      label="Privacy"
      swatch="privacy"
      tone={hasFindings ? "warn" : "ok"}
      status={hasFindings ? plural(findings.length, "finding") : "clean"}
    >
      {hasFindings ? (
        findings.map((finding, index) => (
          <div className="finding" key={index}>
            <span className={`sev-pill sev-${finding.severity}`}>{finding.severity}</span>
            <div className="finding-text">
              <div>
                <span className="rule-id">{finding.ruleId}</span> <code>{finding.path}</code>
              </div>
              <div className="finding-message">{finding.message}</div>
              {finding.recommendation ? (
                <div className="finding-rec">{finding.recommendation}</div>
              ) : null}
            </div>
          </div>
        ))
      ) : (
        <div className="detail-note-inline">
          No credential-shaped values, tokens or connection strings found. A clean result is not a
          clearance — see specification/privacy.md.
        </div>
      )}
    </DetailBlock>
  );
}
