/**
 * Event filtering for the events table.
 *
 * Kept out of the component because it decides what a reader is and is not
 * shown, which is worth testing directly rather than through a rendered
 * table. The search matches the same fields the table displays — matching
 * something invisible would make results look arbitrary.
 */
import type { LoadedEvent } from "./types";

/** Sentinel for "no restriction" in the single-choice filters. */
export const ANY = "__all__";

/**
 * Label for events carrying no `application.name`.
 *
 * Exported because three places need the same string: the Overview breakdown
 * that groups by it, the triage list that ranks by it, and `App.tsx`, which
 * turns a click on that row into "no application filter" rather than a filter
 * for a literal application of this name. They disagreed once — triage said
 * "(unknown application)" — and clicking that row filtered the table to
 * nothing while the dropdown still read "All applications".
 */
export const UNKNOWN_APPLICATION = "(unknown)";

export type ValidityFilter = "all" | "valid" | "invalid";

export interface EventFilter {
  readonly search: string;
  readonly application: string;
  readonly outcome: string;
  readonly validity: ValidityFilter;
  readonly bookmarkedOnly: boolean;
}

export const EMPTY_FILTER: EventFilter = {
  search: "",
  application: ANY,
  outcome: ANY,
  validity: "all",
  bookmarkedOnly: false,
};

/** Fields the search box looks at, in the order they appear in the table. */
function searchableText(row: LoadedEvent): string {
  return [row.eventName, row.applicationName, row.actorId, row.resourceId, row.summary]
    .filter((value) => value !== undefined)
    .join(" ")
    .toLowerCase();
}

export function matchesFilter(
  row: LoadedEvent,
  filter: EventFilter,
  bookmarks: ReadonlySet<string>,
): boolean {
  if (filter.bookmarkedOnly && !bookmarks.has(row.rowId)) {
    return false;
  }
  if (filter.application !== ANY && row.applicationName !== filter.application) {
    return false;
  }
  if (filter.outcome !== ANY && row.outcome !== filter.outcome) {
    return false;
  }
  if (filter.validity === "valid" && !row.valid) {
    return false;
  }
  if (filter.validity === "invalid" && row.valid) {
    return false;
  }

  const needle = filter.search.trim().toLowerCase();
  return needle.length === 0 || searchableText(row).includes(needle);
}

export function filterEvents(
  events: readonly LoadedEvent[],
  filter: EventFilter,
  bookmarks: ReadonlySet<string>,
): LoadedEvent[] {
  return events.filter((row) => matchesFilter(row, filter, bookmarks));
}

/** Distinct values offered by a single-choice filter, sorted for a stable menu. */
function distinct(
  events: readonly LoadedEvent[],
  read: (row: LoadedEvent) => string | undefined,
): string[] {
  return [...new Set(events.map(read).filter((value) => value !== undefined))].sort();
}

export function applicationOptions(events: readonly LoadedEvent[]): string[] {
  return distinct(events, (row) => row.applicationName);
}

export function outcomeOptions(events: readonly LoadedEvent[]): string[] {
  return distinct(events, (row) => row.outcome);
}
