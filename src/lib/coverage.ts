/**
 * Profile coverage across a whole set of loaded events.
 *
 * The detail panel answers "does this event conform?" for one row. This
 * answers the question a reviewer asks about an archive: which profiles reach
 * it at all, and what did they actually check. Both numbers come from the
 * published engines — `checkProfile` through the seam in `engines.ts`, then
 * `summariseCoverage` unchanged from the package — so the counters here and
 * the CLI's `check-coverage` are the same counters by construction rather than
 * by agreement.
 *
 * Coverage is not a score. `summariseCoverage`'s own documentation says "4 of
 * 15 rules selected" describes an event set and is not a percentage, a grade
 * or a target, and the view built on this must not turn it into one: a profile
 * that governs nothing is reported as governing nothing, which is a fact about
 * the events and not a failure of the archive.
 */
import { checkProfile } from "./engines";
import { ALL_PROFILES } from "./profiles";
import { summariseCoverage } from "@openauditmodel/cli/conformance/profiles/coverage.js";
import type { ProfileCoverage } from "@openauditmodel/cli/conformance/profiles/coverage.js";
import type {
  ProfileCheckResult,
  ProfileDefinition,
} from "@openauditmodel/cli/conformance/profiles/types.js";
import type { LoadedEvent } from "./types";

export type { ProfileCoverage };

/** One profile's coverage, with the events it governed kept for the table. */
export interface ProfileCoverageRow {
  readonly coverage: ProfileCoverage;
  /**
   * Rows the profile governed — status `conforming` or `violations` — paired
   * with their result, so selecting a row from the coverage view opens the
   * event that produced the number.
   */
  readonly governed: readonly { readonly row: LoadedEvent; readonly result: ProfileCheckResult }[];
}

/** Everything the coverage tab shows, for one set of events. */
export interface CoverageReport {
  /** One entry per profile this build evaluates, in the order it lists them. */
  readonly profiles: readonly ProfileCoverageRow[];
  /** Events offered to the profiles: every row carrying a parsed event. */
  readonly checked: number;
  /** Rows with nothing to offer at all — the text could not be parsed as JSON. */
  readonly unparsed: number;
}

/**
 * Rows a profile can be asked about: every row that parsed as JSON.
 *
 * A core-invalid row goes in too. `summariseCoverage` is written to receive
 * the whole set — it counts `core-invalid` separately and still counts such an
 * event's name among the names it saw — so withholding those rows made this
 * tab's counters differ from `auditmodel check-coverage` for the same folder.
 * One conforming event beside one core-invalid one reported "1 of 1 names
 * governed" here and "2 distinct, 1 governed, 1 ungoverned" there. An app
 * quietly answering differently from the tool it claims to agree with is a
 * defect even when its answer looks tidier.
 */
function checkable(events: readonly LoadedEvent[]): LoadedEvent[] {
  return events.filter((row) => row.event !== null);
}

/** Runs every profile over every checkable event and summarises each. */
export function summariseArchiveCoverage(
  events: readonly LoadedEvent[],
  profiles: readonly ProfileDefinition[] = ALL_PROFILES,
): CoverageReport {
  const rows = checkable(events);
  const documents = rows.map((row) => row.event as Record<string, unknown>);

  const covered = profiles.map((profile) => {
    // Core validation runs for rows the loader already rejected, so the engine
    // reaches its own `core-invalid` verdict rather than being told to skip a
    // step whose answer it needs. For a row the loader validated, it is a
    // repeat of a known answer and the verdict is the same either way.
    const results = rows.map((row) =>
      checkProfile(row.event, row.sourceFile, profile, { validateCore: !row.valid }),
    );
    const governed = rows.flatMap((row, index) => {
      const result = results[index] as ProfileCheckResult;
      return result.status === "conforming" || result.status === "violations"
        ? [{ row, result }]
        : [];
    });
    return { coverage: summariseCoverage(documents, results, profile), governed };
  });

  return { profiles: covered, checked: rows.length, unparsed: events.length - rows.length };
}

/** True when no profile in the report governs a single event. */
export function governsNothing(report: CoverageReport): boolean {
  return report.profiles.every((entry) => entry.coverage.nameTotals.governed === 0);
}
