/**
 * `change.before` / `change.after`, as a per-path diff when both sides are
 * objects and side by side when they are not.
 *
 * The core model allows either side to be any JSON value, so there is no
 * shape to rely on. Falling back to two panes is honest about that; forcing
 * a diff onto two strings would invent structure the producer never wrote.
 */
import { diffChange, formatDiffValue } from "../../lib/diff";
import { DetailBlock, plural } from "./DetailBlock";

interface Props {
  readonly event: Record<string, unknown>;
}

export function ChangeBlock({ event }: Props) {
  const change = event["change"];
  if (change === null || typeof change !== "object" || Array.isArray(change)) {
    return null;
  }

  const { before, after } = change as { before?: unknown; after?: unknown };
  if (before === undefined && after === undefined) {
    return null;
  }

  const rows = diffChange(before, after);

  // Not an object pair: show both sides whole rather than inventing paths.
  if (rows === undefined) {
    return (
      <DetailBlock label="Change" swatch="resource">
        <div className="diff-panes">
          <div>
            <div className="diff-pane-label">before</div>
            <pre className="detail-json diff-pane-before">{formatDiffValue(before) || "—"}</pre>
          </div>
          <div>
            <div className="diff-pane-label">after</div>
            <pre className="detail-json diff-pane-after">{formatDiffValue(after) || "—"}</pre>
          </div>
        </div>
      </DetailBlock>
    );
  }

  return (
    <DetailBlock
      label="Change"
      swatch="resource"
      tone={rows.length > 0 ? "warn" : "ok"}
      status={rows.length > 0 ? plural(rows.length, "path") : "no differences"}
    >
      {rows.length === 0 ? (
        <div className="detail-note-inline">before and after are identical.</div>
      ) : (
        <table className="diff-table">
          <thead>
            <tr>
              <th>Path</th>
              <th>Before</th>
              <th>After</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.path}>
                <td>
                  <code>{row.path}</code>
                </td>
                <td className={row.kind === "added" ? "" : "diff-before"}>
                  {formatDiffValue(row.before)}
                </td>
                <td className={row.kind === "removed" ? "" : "diff-after"}>
                  {formatDiffValue(row.after)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </DetailBlock>
  );
}
