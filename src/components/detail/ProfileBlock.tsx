/**
 * Domain profile conformance for one event.
 *
 * Only profiles that govern this event's name reach this block; a profile
 * with nothing to say about an event is not evidence of anything and is
 * filtered out before rendering. Errors fail conformance, warnings do not —
 * they are kept visually distinct so a reader can tell "this is wrong" from
 * "this is recommended".
 */
import type { ProfileCheckResult, ProfileFinding } from "../../lib/profiles";
import { DetailBlock } from "./DetailBlock";

interface Props {
  readonly results: readonly ProfileCheckResult[];
}

function FindingRow({
  finding,
  pill,
}: {
  readonly finding: ProfileFinding;
  readonly pill: string;
}) {
  return (
    <div className="finding">
      <span className={`sev-pill ${pill}`}>{finding.severity}</span>
      <div className="finding-text">
        <div>
          <span className="rule-id">{finding.ruleId}</span> <code>{finding.path}</code>
        </div>
        <div className="finding-message">{finding.message}</div>
      </div>
    </div>
  );
}

export function ProfileBlock({ results }: Props) {
  if (results.length === 0) {
    return null;
  }

  const conforming = results.filter((result) => result.profileValid).length;
  const allConform = conforming === results.length;

  return (
    <DetailBlock
      label="Profiles"
      swatch="resource"
      tone={allConform ? "ok" : "bad"}
      status={`${conforming}/${results.length} conforming`}
    >
      {results.map((result) => (
        <div className="profile-result" key={result.profile.name}>
          <div className="rule-line">
            <span className="rule-id">{result.profile.name}</span>
            <span className="detail-note-inline">
              {result.matchedRules.length} rule{result.matchedRules.length === 1 ? "" : "s"}
            </span>
            <span className={result.profileValid ? "count-ok" : "count-bad"}>
              {result.profileValid ? "conforming" : `${result.errors.length} violations`}
            </span>
          </div>
          {result.errors.map((error, index) => (
            <FindingRow finding={error} pill="sev-high" key={`e${index}`} />
          ))}
          {result.warnings.map((warning, index) => (
            <FindingRow finding={warning} pill="sev-medium" key={`w${index}`} />
          ))}
        </div>
      ))}
    </DetailBlock>
  );
}
