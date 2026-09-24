/**
 * Validation issues have exactly the shape the published engines produce, so
 * that what this app shows and what `openauditmodel validate` prints cannot
 * drift apart in wording or in structure.
 *
 * `keyword` names the JSON Schema keyword behind the failure. A few issues are
 * produced by the reader rather than by the schema — a file that is not an
 * event, a document nested too deeply to validate, a validator that threw — and
 * those carry `"reader"`, so the field is never a lie about where a failure
 * came from.
 */
import type { ValidationIssue } from "@openauditmodel/cli/conformance/format-errors.js";

export type { ValidationIssue };

export type { PrivacyFinding, Severity } from "@openauditmodel/cli/conformance/privacy/types.js";

/** Where a row was read from: a JSON document, a JSON Lines file, or a record
 * of a Kafka topic. */
export type SourceFormat = "json" | "jsonl" | "kafka";

/** One row in the table: a parsed event plus where it came from and whether it validates. */
export interface LoadedEvent {
  readonly rowId: string;
  readonly sourceFile: string;
  readonly sourceFormat: SourceFormat;
  /** The parsed event, or null when the text could not be read as one. */
  readonly event: Record<string, unknown> | null;
  readonly valid: boolean;
  /**
   * The event declares a specification version this app does not implement,
   * so no schema was applied to it (ADR 0017 §3). Never valid — nothing was
   * checked — and not shown as invalid either, because nothing was found wrong.
   */
  readonly notEvaluated: boolean;
  readonly errors: readonly ValidationIssue[];
  readonly time?: string;
  readonly applicationName?: string;
  readonly environment?: string;
  readonly eventName?: string;
  readonly eventCategory?: string;
  readonly outcome?: string;
  readonly actorType?: string;
  readonly actorId?: string;
  readonly resourceType?: string;
  readonly resourceId?: string;
  readonly summary?: string;
  /** Privacy findings, only when `event` is non-null and schema-valid — a
   * schema-invalid or unmapped row is not deep-linted, the same rule the CLI
   * follows: traversing an arbitrary structure produces paths that mean
   * nothing. Never absent vs. empty by accident — see parse.ts. */
  readonly privacyFindings: readonly import("@openauditmodel/cli/conformance/privacy/types.js").PrivacyFinding[];
}

/** A path the loader did not turn into events, and why. */
export interface PathNotice {
  readonly path: string;
  readonly reason: string;
}

export interface LoadSummary {
  /** Files actually parsed. */
  readonly filesRead: number;
  /** Recognized files found in the folder, including any not read. */
  readonly filesFound: number;
  /** Files that could not be read at all. */
  readonly filesFailed: readonly PathNotice[];
  /** Files declined before reading, for their size. */
  readonly filesSkipped: readonly PathNotice[];
  /** Directories deliberately not descended into: dependency and build trees,
   * and anything past the depth limit. Expected rather than alarming, but
   * counted, because a folder the walk never entered can hold audit logs. */
  readonly directoriesSkipped: readonly PathNotice[];
  /** Directories that could not be listed at all. The rest of the folder is
   * still loaded: one unreadable subdirectory does not lose the others. */
  readonly directoriesFailed: readonly PathNotice[];
  /** True when loading stopped at the event ceiling: the folder holds more. */
  readonly truncated: boolean;
  readonly eventLimit: number;
  /** Present when the events are a window read from a Kafka topic, not a
   * folder; the file counts above are then all zero. */
  readonly window?: StreamWindowSummary;
}

/** Why reading a window ended, as the Rust side names it. */
export type WindowStop =
  | "end-of-window"
  | "event-limit"
  | "byte-limit"
  | "cancelled"
  | "timed-out"
  | "stalled"
  /** Not a stop: the window is read and the app is still listening. */
  | "listening"
  /** Listening ended with an error after the window was read. */
  | "failed";

/** What one partition contributed to a window. */
export interface WindowPartition {
  readonly partition: number;
  readonly startOffset: number;
  /** The partition's end when reading started: nothing at or after it was read. */
  readonly endOffset: number;
  /** The oldest offset the broker held when reading started. */
  readonly lowOffset: number;
  readonly records: number;
  readonly complete: boolean;
}

/** A window read from a Kafka topic: where from, how, and why it ended. */
export interface StreamWindowSummary {
  readonly sourceName: string;
  readonly bootstrapServers: readonly string[];
  readonly topic: string;
  readonly protection: string;
  /** What was asked for, in words: the range, and whether it was followed. */
  readonly start: string;
  /** The read-time filter, in words, when there was one. */
  readonly filter?: string;
  readonly partitions: readonly WindowPartition[];
  /** Records read from the broker, kept or not. */
  readonly scanned: number;
  /** Records kept: the ones that matched, when filtering. */
  readonly records: number;
  /** Of those, the ones that arrived after the window, while listening. */
  readonly followed: number;
  /** The whole window was read and listening went on after it: `stop` then
   * says how listening ended, not that the window was cut short. */
  readonly listened: boolean;
  /**
   * The window can have holes a chain runs across: it did not read every
   * partition from its first offset to its end, unfiltered. Only then is a
   * link across a gap reported as not checked rather than broken.
   */
  readonly edges: boolean;
  /** Why listening failed, when it did. */
  readonly error?: string;
  readonly stop: WindowStop;
  readonly maxEvents: number;
  /** When reading finished, as an ISO time. */
  readonly readAt: string;
}
