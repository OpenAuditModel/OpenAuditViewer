/**
 * The archive report: everything this application established about a folder,
 * assembled in one place so it can be read on screen or printed.
 *
 * A printed page outlives the session that produced it and travels further
 * than the person who made it — which is why the shape below carries what was
 * *not* established as prominently as what was. A report that lists three
 * intact chains and omits that chain verification cannot see a deleted tail is
 * worse than no report, because it reads as assurance to someone who was not
 * at the screen.
 *
 * This is not a document format. It is a data shape for rendering, held here
 * rather than in the component so that it can be tested and so the numbers in
 * it are the ones the tabs already show. The canonical repository's `inspect`
 * command will define the portable Audit Analysis Result; nothing here should
 * be mistaken for it or consumed as one.
 */
import { summariseArchiveCoverage } from "./coverage";
import { verifyChains } from "./integrity/chain";
import { readIntegrity, verifyEventIntegrity } from "./integrity/verify-event";
import type { SignatureVerifier } from "./integrity/trusted-key";
import { REFUSED_PROFILES } from "./profiles";
import type { LoadedEvent, LoadSummary } from "./types";
import { SEVERITY_ORDER, type Severity } from "@openauditmodel/cli/conformance/privacy/types.js";

/** What the folder held, and what of it was read. */
export interface ArchiveSection {
  readonly folder: string | undefined;
  readonly events: number;
  readonly filesRead: number;
  readonly filesFound: number;
  readonly unreadableFiles: number;
  readonly skippedFiles: number;
  readonly unreadableDirectories: number;
  /** True when loading stopped at the ceiling: the folder holds more than this. */
  readonly truncated: boolean;
  readonly eventLimit: number;
}

export interface ValiditySection {
  readonly valid: number;
  readonly invalid: number;
  /** Files holding at least one event the schema rejected, most first, capped. */
  readonly worstFiles: readonly { readonly file: string; readonly invalid: number }[];
  /** How many files hold invalid events in total, so a truncated table says so. */
  readonly filesWithInvalid: number;
}

export interface PrivacySection {
  readonly findings: number;
  readonly eventsAffected: number;
  readonly bySeverity: Readonly<Record<Severity, number>>;
  readonly byRule: readonly { readonly ruleId: string; readonly count: number }[];
}

export interface IntegritySection {
  /** Events declaring an `integrity.hash`, which is what the Overview counts. */
  readonly declared: number;
  readonly verified: number;
  /** Failures, capped for the page; `failedTotal` is how many there were. */
  readonly failed: readonly { readonly label: string; readonly kinds: readonly string[] }[];
  readonly failedTotal: number;
  /**
   * Events declaring `integrity.signature`, and the key they were checked
   * against — or none, in which case a declared signature was reported and not
   * checked, and every one of those events is counted verified on its hash.
   */
  readonly signatures: {
    readonly declared: number;
    readonly checkedWith:
      | { readonly keyType: string; readonly fingerprint: string; readonly fileName: string }
      | undefined;
  };
  /** Chain counts only. The full report carries chain identifiers and digests. */
  readonly chains:
    | {
        readonly checked: number;
        readonly intact: number;
        /** Events carrying a chainId that could not be assigned to a chain at all. */
        readonly unassigned: number;
        /** False when any chain is broken or any member could not be verified. */
        readonly allIntact: boolean;
      }
    | undefined;
}

/**
 * What one profile reached, as the page prints it.
 *
 * Deliberately not the `CoverageReport` the tab uses: that carries the rows a
 * profile governed so the tab can open them, and a row carries its whole
 * event. This report holds only what it prints. The distinction is not
 * theoretical — the first test written against this caught the events riding
 * along inside it.
 */
export interface ProfileSection {
  readonly name: string;
  readonly version: string;
  readonly conforming: number;
  readonly violations: number;
  readonly notApplicable: number;
  readonly governedNames: number;
  readonly distinctNames: number;
  readonly rulesSelected: number;
  readonly rulesTotal: number;
  /** Rules that selected an event and required nothing, a condition never holding. */
  readonly selectedButNeverApplied: readonly string[];
}

export interface ArchiveReport {
  readonly generatedAt: string;
  readonly archive: ArchiveSection;
  readonly validity: ValiditySection;
  readonly privacy: PrivacySection;
  readonly integrity: IntegritySection;
  readonly profiles: readonly ProfileSection[];
  /** Profiles this build refused because it cannot read their rule vocabulary. */
  readonly refusedProfiles: readonly { readonly name: string; readonly profileVersion: string }[];
}

/**
 * How many rows each printed table shows.
 *
 * A printed table that stops without saying so reads as the whole list to
 * someone holding only the paper, so both totals are carried beside the rows
 * and the page prints what it left out.
 */
const FILES_SHOWN = 10;
const FAILED_SHOWN = 20;

function emptySeverities(): Record<Severity, number> {
  return { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
}

function privacyOf(events: readonly LoadedEvent[]): PrivacySection {
  const bySeverity = emptySeverities();
  const byRule = new Map<string, number>();
  let findings = 0;
  let eventsAffected = 0;

  for (const row of events) {
    if (row.privacyFindings.length > 0) {
      eventsAffected += 1;
    }
    for (const finding of row.privacyFindings) {
      findings += 1;
      bySeverity[finding.severity] += 1;
      byRule.set(finding.ruleId, (byRule.get(finding.ruleId) ?? 0) + 1);
    }
  }

  return {
    findings,
    eventsAffected,
    bySeverity,
    byRule: [...byRule.entries()]
      .map(([ruleId, count]) => ({ ruleId, count }))
      .sort((left, right) => right.count - left.count || left.ruleId.localeCompare(right.ruleId)),
  };
}

function validityOf(events: readonly LoadedEvent[]): ValiditySection {
  const perFile = new Map<string, number>();
  let invalid = 0;
  for (const row of events) {
    if (!row.valid) {
      invalid += 1;
      perFile.set(row.sourceFile, (perFile.get(row.sourceFile) ?? 0) + 1);
    }
  }
  return {
    valid: events.length - invalid,
    invalid,
    worstFiles: [...perFile.entries()]
      .map(([file, count]) => ({ file, invalid: count }))
      .sort((left, right) => right.invalid - left.invalid || left.file.localeCompare(right.file))
      .slice(0, FILES_SHOWN),
    filesWithInvalid: perFile.size,
  };
}

/**
 * Builds the whole report. Verifies every declared digest and every chain, so
 * it is the most expensive thing in the application and always waits for a
 * click.
 */
export async function buildArchiveReport(
  events: readonly LoadedEvent[],
  summary: LoadSummary | undefined,
  folder: string | undefined,
  signatureVerifier?: SignatureVerifier,
): Promise<ArchiveReport> {
  const withKey = signatureVerifier === undefined ? {} : { signatureVerifier };

  // The same set the Overview sweeps, defined the same way: a declared hash is
  // what there is to verify. Counting every event with an `integrity` object
  // would make the two tabs give different answers about one folder.
  const withIntegrity = events.filter(
    (row) => row.event !== null && typeof readIntegrity(row.event)?.hash === "string",
  );

  let verified = 0;
  const failed: { label: string; kinds: readonly string[] }[] = [];
  for (const row of withIntegrity) {
    // Schema validation is left on, unlike the Overview sweep, which runs over
    // rows already known to be valid. An event the core schema rejects is not
    // a verified event — `verify-integrity` fails it, and a page that printed
    // it under "Digests verified" would claim something the CLI does not.
    const result = await verifyEventIntegrity(row.event, row.sourceFile, withKey);
    if (result.verified) {
      verified += 1;
    } else {
      failed.push({ label: row.rowId, kinds: result.findings.map((finding) => finding.kind) });
    }
  }

  const chainMembers = events.filter(
    (row) => row.event !== null && typeof readIntegrity(row.event)?.chainId === "string",
  );
  const coverage = summariseArchiveCoverage(events);

  const chainReport =
    chainMembers.length === 0
      ? undefined
      : await verifyChains(
          chainMembers.map((row) => ({ label: row.rowId, event: row.event })),
          withKey,
        );

  // Counts only. A `ChainReport` carries producer-declared chain identifiers,
  // every member's declared and calculated digest, and finding detail lines —
  // none of which the page prints, and all of which would ride along in
  // anything that serialised this structure.
  const chains =
    chainReport === undefined
      ? undefined
      : {
          checked: chainReport.chains.length,
          intact: chainReport.chains.filter((chain) => chain.intact).length,
          unassigned: chainReport.unassigned.length,
          allIntact: chainReport.intact,
        };

  return {
    generatedAt: new Date().toISOString(),
    archive: {
      folder,
      events: events.length,
      filesRead: summary?.filesRead ?? 0,
      filesFound: summary?.filesFound ?? 0,
      unreadableFiles: summary?.filesFailed.length ?? 0,
      skippedFiles: summary?.filesSkipped.length ?? 0,
      unreadableDirectories: summary?.directoriesFailed.length ?? 0,
      truncated: summary?.truncated ?? false,
      eventLimit: summary?.eventLimit ?? 0,
    },
    validity: validityOf(events),
    privacy: privacyOf(events),
    integrity: {
      declared: withIntegrity.length,
      verified,
      failed: failed.slice(0, FAILED_SHOWN),
      failedTotal: failed.length,
      signatures: {
        declared: withIntegrity.filter((row) => {
          const signature = readIntegrity(row.event)?.signature;
          return signature !== null && typeof signature === "object" && !Array.isArray(signature);
        }).length,
        checkedWith:
          signatureVerifier === undefined
            ? undefined
            : {
                keyType: signatureVerifier.key.keyType,
                fingerprint: signatureVerifier.key.fingerprint,
                fileName: signatureVerifier.key.fileName,
              },
      },
      chains,
    },
    profiles: coverage.profiles.map((entry) => ({
      name: entry.coverage.profile.name,
      version: entry.coverage.profile.version,
      conforming: entry.coverage.events.conforming,
      violations: entry.coverage.events.violations,
      notApplicable: entry.coverage.events.notApplicable,
      governedNames: entry.coverage.nameTotals.governed,
      distinctNames: entry.coverage.nameTotals.distinct,
      rulesSelected: entry.coverage.rules.selected,
      rulesTotal: entry.coverage.rules.total,
      selectedButNeverApplied: entry.coverage.rules.selectedButNeverApplied,
    })),
    refusedProfiles: REFUSED_PROFILES.map((profile) => ({
      name: profile.name,
      profileVersion: profile.profileVersion,
    })),
  };
}

export { SEVERITY_ORDER };
export type { Severity };
