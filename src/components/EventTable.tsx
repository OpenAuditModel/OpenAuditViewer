import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { LoadedEvent } from "../lib/types";

/** Fixed row height (enforced in CSS) — the basis of virtualization math. */
const ROW_HEIGHT = 28;
/** Rows rendered beyond the viewport on each side, so fast scrolling never blanks. */
const OVERSCAN = 12;
/** Below this many rows the whole table renders directly; spacer rows and
 * scroll math buy nothing at small sizes. */
const VIRTUALIZE_THRESHOLD = 400;

/** `arrival` is the order rows were read in: files in the order they were
 * opened, a Kafka window in the order its records arrived. */
export type SortKey =
  | "time"
  | "applicationName"
  | "eventName"
  | "eventCategory"
  | "outcome"
  | "actorId"
  | "valid"
  | "arrival";

/** How long a newly arrived row takes to settle, and how far apart the rows
 * of one batch start: a batch fades in from the top down. */
const ARRIVAL_STAGGER_MS = 45;
const ARRIVAL_STAGGER_CAP = 20;

interface Props {
  readonly events: readonly LoadedEvent[];
  readonly selectedRowId: string | undefined;
  readonly onSelect: (rowId: string) => void;
  readonly bookmarks: ReadonlySet<string>;
  readonly onToggleBookmark: (rowId: string) => void;
  /** The order the table opens in. The app remounts the table per load. */
  readonly initialSort?: { readonly key: SortKey; readonly ascending: boolean };
  /** Rows that just arrived while listening: they fade in, and when the
   * reader is scrolled away from the top the rows in view stay where they are. */
  readonly fresh?: ReadonlySet<string>;
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
  initialSort,
  fresh,
}: Props) {
  const [sortKey, setSortKey] = useState<SortKey>(initialSort?.key ?? "time");
  const [sortAscending, setSortAscending] = useState(initialSort?.ascending ?? false);
  // New rows that landed above the reader while they were scrolled down.
  const [newAbove, setNewAbove] = useState(0);

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
    const readOrder = new Map(events.map((row, index) => [row.rowId, index]));
    const copy = [...events];
    copy.sort((left, right) => {
      let comparison: number;
      if (sortKey === "arrival") {
        comparison = (readOrder.get(left.rowId) ?? 0) - (readOrder.get(right.rowId) ?? 0);
      } else if (sortKey === "time") {
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

  // Newest read first, and the reader scrolled away from the top: the rows
  // that arrived go above them, so the view moves down by exactly those rows
  // and what they were reading stays put. A pill says how many are waiting.
  useLayoutEffect(() => {
    const wrapper = wrapperRef.current;
    if (fresh === undefined || fresh.size === 0 || wrapper === null) {
      return;
    }
    if (sortKey !== "arrival" || sortAscending || wrapper.scrollTop < ROW_HEIGHT) {
      return;
    }
    const above = events.reduce((count, row) => count + (fresh.has(row.rowId) ? 1 : 0), 0);
    wrapper.scrollTop += above * ROW_HEIGHT;
    setScrollTop(wrapper.scrollTop);
    setNewAbove((current) => current + above);
    // Only a new batch moves the view; `events` changes with it, and is read
    // here for the batch's rows only.
  }, [fresh]);

  // Where each fresh row falls in the batch, top down, for its fade-in delay.
  const freshRank = useMemo(() => {
    const rank = new Map<string, number>();
    if (fresh === undefined || fresh.size === 0) {
      return rank;
    }
    for (const row of sorted) {
      if (fresh.has(row.rowId)) {
        rank.set(row.rowId, rank.size);
      }
    }
    return rank;
  }, [sorted, fresh]);

  function toggleSort(key: SortKey): void {
    setNewAbove(0);
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
      onScroll={(event) => {
        // Tracked whether virtualized or not: rows added by listening can take
        // the table past the threshold, and its first virtualized render must
        // know where the reader already is.
        const top = (event.target as HTMLDivElement).scrollTop;
        setScrollTop(top);
        if (top < ROW_HEIGHT && newAbove > 0) {
          setNewAbove(0);
        }
      }}
    >
      {newAbove > 0 ? (
        <div className="new-rows-anchor">
          <button
            type="button"
            className="new-rows-pill"
            onClick={() => {
              wrapperRef.current?.scrollTo({ top: 0, behavior: "smooth" });
              setNewAbove(0);
            }}
          >
            ↑ {newAbove.toLocaleString()} new
          </button>
        </div>
      ) : null}
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
            <th
              onClick={() => toggleSort("arrival")}
              title="Sort by the order events were read in: newest read first, or oldest"
            >
              Source
              {sortKey === "arrival" ? (sortAscending ? " ▲" : " ▼") : ""}
            </th>
          </tr>
        </thead>
        <tbody>
          {virtualized && startIndex > 0 ? (
            <tr style={{ height: startIndex * ROW_HEIGHT }} aria-hidden="true" />
          ) : null}
          {visible.map((row) => {
            const rank = freshRank.get(row.rowId);
            const classes = [
              row.rowId === selectedRowId ? "selected" : "",
              rank === undefined ? "" : "fresh",
            ]
              .filter((name) => name !== "")
              .join(" ");
            return (
              <tr
                key={row.rowId}
                className={classes === "" ? undefined : classes}
                style={
                  rank === undefined
                    ? undefined
                    : {
                        animationDelay: `${Math.min(rank, ARRIVAL_STAGGER_CAP) * ARRIVAL_STAGGER_MS}ms`,
                      }
                }
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
                    className={
                      row.valid ? "status-ok" : row.notEvaluated ? "status-muted" : "status-bad"
                    }
                    title={
                      row.valid
                        ? "valid"
                        : row.notEvaluated
                          ? "not evaluated: declares a specification version this app does not implement"
                          : "invalid"
                    }
                  >
                    {row.valid ? "✓" : row.notEvaluated ? "?" : "✕"}
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
                  {row.resourceType && row.resourceId
                    ? `${row.resourceType}/${row.resourceId}`
                    : "—"}
                </td>
                <td className="source-cell" title={row.sourceFile}>
                  {row.sourceFile.split(/[/\\]/).pop()}
                </td>
              </tr>
            );
          })}
          {virtualized && endIndex < sorted.length ? (
            <tr style={{ height: (sorted.length - endIndex) * ROW_HEIGHT }} aria-hidden="true" />
          ) : null}
        </tbody>
      </table>
      {sorted.length === 0 ? <p className="empty-state">No events loaded yet.</p> : null}
    </div>
  );
}
