/**
 * The detail panel for one selected row.
 *
 * This component decides what is worth showing and in what order; each
 * analysis renders itself in `detail/`. The order is deliberate — schema
 * validity first, because nothing below it means much for an event the core
 * model rejects, then what the event might leak, then whether it was
 * altered, then where it came from and what it was meant to satisfy.
 */
import { useMemo } from "react";
import type { LoadedEvent } from "../lib/types";
import { useEventIntegrity } from "../hooks/useEventIntegrity";
import { ALL_PROFILES, checkProfile, type ProfileCheckResult } from "../lib/profiles";
import { safeStringify } from "../lib/diff";
import { buildTraceGroups, findGroupForRow } from "../lib/trace";
import { PrivacyBlock } from "./detail/PrivacyBlock";
import { IntegrityBlock } from "./detail/IntegrityBlock";
import { ChainBlock } from "./detail/ChainBlock";
import { FlowBlock } from "./detail/FlowBlock";
import { ProfileBlock } from "./detail/ProfileBlock";
import { ChangeBlock } from "./detail/ChangeBlock";

interface Props {
  readonly row: LoadedEvent | undefined;
  readonly allEvents: readonly LoadedEvent[];
  readonly bookmarked: boolean;
  readonly onToggleBookmark: (rowId: string) => void;
  readonly onSelectRow: (rowId: string) => void;
}

export function EventDetail({ row, allEvents, bookmarked, onToggleBookmark, onSelectRow }: Props) {
  const { integrity, chain } = useEventIntegrity(row, allEvents);

  const traceGroups = useMemo(() => buildTraceGroups(allEvents), [allEvents]);
  const flow = row === undefined ? undefined : findGroupForRow(traceGroups, row.rowId);

  // Profile checks are synchronous and cheap for one event; only profiles
  // that actually govern this event name are worth showing. A schema-invalid
  // row is not checked at all — a profile only adds to a conforming event.
  const profileResults = useMemo<readonly ProfileCheckResult[]>(() => {
    if (row === undefined || !row.valid || row.event === null) {
      return [];
    }
    return ALL_PROFILES.map((profile) =>
      checkProfile(row.event, row.sourceFile, profile, { validateCore: false }),
    ).filter((result) => result.status !== "not-applicable");
  }, [row]);

  if (row === undefined) {
    return (
      <div className="event-detail empty-state">
        <p>Select a row to see its full content.</p>
      </div>
    );
  }

  return (
    <div className="event-detail">
      <div className="detail-header">
        <button
          type="button"
          className={bookmarked ? "star-button starred" : "star-button"}
          title={bookmarked ? "Remove bookmark" : "Bookmark"}
          onClick={() => onToggleBookmark(row.rowId)}
        >
          {bookmarked ? "★" : "☆"}
        </button>
        <span className={row.valid ? "status-ok" : "status-bad"}>
          {row.valid ? "Valid" : "Invalid"}
        </span>
        <span className="detail-source" title={row.sourceFile}>
          {row.sourceFile} · {row.sourceFormat}
        </span>
      </div>

      {row.errors.length > 0 ? (
        <div className="detail-errors">
          <h3>Findings</h3>
          <ul>
            {row.errors.map((error, index) => (
              <li key={index}>
                <code>{error.path}</code> {error.message}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {row.valid ? <PrivacyBlock findings={row.privacyFindings} /> : null}

      <IntegrityBlock integrity={integrity} />

      {flow !== undefined ? (
        <FlowBlock flow={flow} currentRowId={row.rowId} onSelectRow={onSelectRow} />
      ) : null}

      <ProfileBlock results={profileResults} />

      <ChainBlock chain={chain} />

      {row.valid && row.event !== null ? <ChangeBlock event={row.event} /> : null}

      <h3>Event</h3>
      <pre className="detail-json">{safeStringify(row.event ?? {}, 2)}</pre>
    </div>
  );
}
