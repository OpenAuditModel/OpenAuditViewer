/**
 * The three list shapes the integrity and chain blocks share: checks that
 * passed, findings that did not, and notes that are neither.
 *
 * Notes matter as their own category. "sequence numbers are not contiguous"
 * is an observation, not a failure, and rendering it as one would tell a
 * reader their chain is broken when it is not.
 */
import type { Finding, Note, PassedCheck } from "../../lib/integrity/types";

export function CheckList({ checks }: { readonly checks: readonly PassedCheck[] }) {
  if (checks.length === 0) {
    return null;
  }
  return (
    <ul className="check-list">
      {checks.map((check, index) => (
        <li className="check-ok" key={index}>
          {check.message}
        </li>
      ))}
    </ul>
  );
}

export function FindingList({ findings }: { readonly findings: readonly Finding[] }) {
  if (findings.length === 0) {
    return null;
  }
  return (
    <ul className="check-list">
      {findings.map((finding, index) => (
        <li className="check-bad" key={index}>
          <div>
            {finding.label ? <code>{finding.label}</code> : null} {finding.message}
          </div>
          {finding.detail && finding.detail.length > 0 ? (
            <div className="finding-rec">{finding.detail.join(" · ")}</div>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

export function NoteList({ notes }: { readonly notes: readonly Note[] }) {
  if (notes.length === 0) {
    return null;
  }
  return (
    <ul className="check-list">
      {notes.map((note, index) => (
        <li className="check-info" key={index}>
          {note.message}
          {note.detail && note.detail.length > 0 ? (
            <div className="finding-rec">{note.detail.join(" · ")}</div>
          ) : null}
        </li>
      ))}
    </ul>
  );
}
