/**
 * Where the problems in an archive concentrate.
 *
 * This answers "where do I start?" and deliberately not "how good is this
 * archive?". A quality score would have to aggregate the four honest numbers
 * this app already reports — validity, privacy findings, tamper-evidence and
 * profile conformance — into one, and an aggregate becomes a target: an
 * archive with a percentage gets filed, an archive with four numbers gets
 * read. Design principle 12 refuses to treat completeness as quality, and the
 * same reasoning refuses a composite.
 *
 * It also invents no judgement. Every count below is a regrouping of findings
 * the published engines already produced, ordered by where the work is. A
 * check this application made and the CLI did not would be a divergence, which
 * `CONTRIBUTING.md` forbids and the parity suite exists to catch — an
 * application quietly stricter than the tool it claims to agree with is a bug
 * even when its answer looks more useful.
 */
import type { LoadedEvent } from "./types";

/** One place problems gather, and what kind they are. */
export interface Concentration {
  /** The file, event name or application this row is about. */
  readonly key: string;
  /** Events attributed to it. */
  readonly events: number;
  readonly invalid: number;
  readonly findings: number;
  /** Events carrying at least one privacy finding. */
  readonly flagged: number;
}

export interface Triage {
  /** Files holding schema-invalid events, most first. */
  readonly files: readonly Concentration[];
  /** Event names carrying privacy findings, most first. */
  readonly names: readonly Concentration[];
  /** Applications with problems of either kind, most first. */
  readonly applications: readonly Concentration[];
  /** True when nothing needs triage: no invalid event, no finding. */
  readonly clean: boolean;
}

function group(
  events: readonly LoadedEvent[],
  keyOf: (row: LoadedEvent) => string,
): Map<string, { events: number; invalid: number; findings: number; flagged: number }> {
  const byKey = new Map<
    string,
    { events: number; invalid: number; findings: number; flagged: number }
  >();
  for (const row of events) {
    const key = keyOf(row);
    const entry = byKey.get(key) ?? { events: 0, invalid: 0, findings: 0, flagged: 0 };
    entry.events += 1;
    if (!row.valid) {
      entry.invalid += 1;
    }
    entry.findings += row.privacyFindings.length;
    if (row.privacyFindings.length > 0) {
      entry.flagged += 1;
    }
    byKey.set(key, entry);
  }
  return byKey;
}

/**
 * Orders by problems first and volume second, so a file with three invalid
 * events out of three outranks one with three out of nine hundred. Ties break
 * on the key, so two runs over one archive produce the same order.
 */
function rank(
  grouped: ReturnType<typeof group>,
  weight: (entry: { invalid: number; findings: number }) => number,
  limit: number,
): Concentration[] {
  return [...grouped.entries()]
    .map(([key, entry]) => ({ key, ...entry }))
    .filter((entry) => weight(entry) > 0)
    .sort(
      (left, right) =>
        weight(right) - weight(left) ||
        right.events - left.events ||
        left.key.localeCompare(right.key, "en"),
    )
    .slice(0, limit);
}

/** How many rows of each kind to offer. Enough to start, few enough to read. */
const LIMIT = 5;

/**
 * Groups the archive's existing findings by where they came from.
 *
 * Nothing here is recomputed: validity and privacy findings are already on
 * each row by the time a folder finishes loading.
 */
export function triage(events: readonly LoadedEvent[]): Triage {
  const files = rank(
    group(events, (row) => row.sourceFile),
    (entry) => entry.invalid,
    LIMIT,
  );
  const names = rank(
    group(events, (row) => row.eventName ?? "(no event name)"),
    (entry) => entry.findings,
    LIMIT,
  );
  const applications = rank(
    group(events, (row) => row.applicationName ?? "(unknown application)"),
    (entry) => entry.invalid + entry.findings,
    LIMIT,
  );

  return {
    files,
    names,
    applications,
    clean: files.length === 0 && names.length === 0 && applications.length === 0,
  };
}
