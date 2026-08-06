import { useEffect, useMemo, useRef, useState } from "react";
import type { LoadedEvent } from "../lib/types";

/** Fixed row height (enforced in CSS) — the basis of virtualization math. */
const ROW_HEIGHT = 28;
/** Rows rendered beyond the viewport on each side, so fast scrolling never blanks. */
const OVERSCAN = 12;
/** Below this many rows the whole table renders directly; spacer rows and
 * scroll math buy nothing at small sizes. */
const VIRTUALIZE_THRESHOLD = 400;

type SortKey =
  "time" | "applicationName" | "eventName" | "eventCategory" | "outcome" | "actorId" | "valid";

interface Props {
  readonly events: readonly LoadedEvent[];
  readonly selectedRowId: string | undefined;
  readonly onSelect: (rowId: string) => void;
  readonly bookmarks: ReadonlySet<string>;
  readonly onToggleBookmark: (rowId: string) => void;
}

const COLUMNS: ReadonlyArray<{ key: SortKey; label: string }> = [
  { key: "valid", label: "" },
  { key: "time", label: "Time" },
  { key: "applicationName", label: "Application" },
  { key: "eventName", label: "Event" },
  { key: "eventCategory", label: "Category" },
  { key: "outcome", label: "Outcome" },
  { key: "actorId", label: "Actor" },
];

export function EventTable({
  events,
  selectedRowId,
  onSelect,
  bookmarks,
  onToggleBookmark,
}: Props) {
  const [sortKey, setSortKey] = useState<SortKey>("time");
  const [sortAscending, setSortAscending] = useState(false);

  const wrapperRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(600);

  useEffect(() => {
    const wrapper = wrapperRef.current;
    if (wrapper === null) {
      return;
    }
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry !== undefined) {
        setViewportHeight(entry.contentRect.height);
      }
    });
    observer.observe(wrapper);
    return () => observer.disconnect();
  }, []);

  const sorted = useMemo(() => {
    const copy = [...events];
    copy.sort((left, right) => {
      let comparison: number;
      if (sortKey === "time") {
        // Compared as instants, not strings: RFC 3339 permits non-UTC
        // offsets, and "10:00+03:00" sorts after "09:00Z" as text even
        // though it happens before it.
        const leftMs = left.time === undefined ? Number.NEGATIVE_INFINITY : Date.parse(left.time);
        const rightMs =
          right.time === undefined ? Number.NEGATIVE_INFINITY : Date.parse(right.time);
        const leftKey = Number.isNaN(leftMs) ? Number.NEGATIVE_INFINITY : leftMs;
        const rightKey = Number.isNaN(rightMs) ? Number.NEGATIVE_INFINITY : rightMs;
        comparison = leftKey === rightKey ? 0 : leftKey < rightKey ? -1 : 1;
      } else {
        const leftValue = sortKey === "valid" ? String(left.valid) : (left[sortKey] ?? "");
        const rightValue = sortKey === "valid" ? String(right.valid) : (right[sortKey] ?? "");
        comparison = leftValue.localeCompare(rightValue);
      }
      return sortAscending ? comparison : -comparison;
    });
    return copy;
  }, [events, sortKey, sortAscending]);

  function toggleSort(key: SortKey): void {
    if (key === sortKey) {
      setSortAscending((current) => !current);
    } else {
      setSortKey(key);
      setSortAscending(true);
    }
  }

  const virtualized = sorted.length > VIRTUALIZE_THRESHOLD;
  const startIndex = virtualized ? Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN) : 0;
  const endIndex = virtualized
    ? Math.min(sorted.length, startIndex + Math.ceil(viewportHeight / ROW_HEIGHT) + OVERSCAN * 2)
    : sorted.length;
  const visible = virtualized ? sorted.slice(startIndex, endIndex) : sorted;

  return (
    <div
      className="event-table-wrapper"
      ref={wrapperRef}
      onScroll={
        virtualized
          ? (event) => setScrollTop((event.target as HTMLDivElement).scrollTop)
          : undefined
      }
    >
      <table className="event-table">
        <thead>
          <tr>
            <th aria-label="Bookmark"></th>
            {COLUMNS.map((column) => (
              <th key={column.key} onClick={() => toggleSort(column.key)}>
                {column.label}
                {sortKey === column.key ? (sortAscending ? " ▲" : " ▼") : ""}
              </th>
            ))}
            <th>Resource</th>
            <th>Source</th>
          </tr>
        </thead>
        <tbody>
          {virtualized && startIndex > 0 ? (
            <tr style={{ height: startIndex * ROW_HEIGHT }} aria-hidden="true" />
          ) : null}
          {visible.map((row) => (
            <tr
              key={row.rowId}
              className={row.rowId === selectedRowId ? "selected" : undefined}
              onClick={() => onSelect(row.rowId)}
            >
              <td className="star-cell">
                <button
                  type="button"
                  className={bookmarks.has(row.rowId) ? "star-button starred" : "star-button"}
                  title={bookmarks.has(row.rowId) ? "Remove bookmark" : "Bookmark"}
                  onClick={(clickEvent) => {
                    clickEvent.stopPropagation();
                    onToggleBookmark(row.rowId);
                  }}
                >
                  {bookmarks.has(row.rowId) ? "★" : "☆"}
                </button>
              </td>
              <td className="status-cluster">
                <span
                  className={row.valid ? "status-ok" : "status-bad"}
                  title={row.valid ? "valid" : "invalid"}
                >
                  {row.valid ? "✓" : "✕"}
                </span>
                {row.privacyFindings.length > 0 ? (
                  <span
                    className="mini-flag privacy"
                    title={`${row.privacyFindings.length} privacy finding${row.privacyFindings.length === 1 ? "" : "s"}: ${row.privacyFindings.map((f) => f.ruleId).join(", ")}`}
                  >
                    !
                  </span>
                ) : null}
              </td>
              <td>{row.time ?? "—"}</td>
              <td>{row.applicationName ?? "—"}</td>
              <td>{row.eventName ?? "—"}</td>
              <td>{row.eventCategory ?? "—"}</td>
              <td>{row.outcome ?? "—"}</td>
              <td>{row.actorId ?? "—"}</td>
              <td>
                {row.resourceType && row.resourceId ? `${row.resourceType}/${row.resourceId}` : "—"}
              </td>
              <td className="source-cell" title={row.sourceFile}>
                {row.sourceFile.split(/[/\\]/).pop()}
              </td>
            </tr>
          ))}
          {virtualized && endIndex < sorted.length ? (
            <tr style={{ height: (sorted.length - endIndex) * ROW_HEIGHT }} aria-hidden="true" />
          ) : null}
        </tbody>
      </table>
      {sorted.length === 0 ? <p className="empty-state">No events loaded yet.</p> : null}
    </div>
  );
}
