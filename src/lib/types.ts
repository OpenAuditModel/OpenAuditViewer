export interface ValidationIssue {
  readonly path: string;
  readonly message: string;
}

export type { PrivacyFinding, Severity } from "./privacy/types";

export type SourceFormat = "json" | "jsonl";

/** One row in the table: a parsed event plus where it came from and whether it validates. */
export interface LoadedEvent {
  readonly rowId: string;
  readonly sourceFile: string;
  readonly sourceFormat: SourceFormat;
  /** The parsed event, or null when the text could not be read as one. */
  readonly event: Record<string, unknown> | null;
  readonly valid: boolean;
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
  readonly privacyFindings: readonly import("./privacy/types").PrivacyFinding[];
}

export interface LoadSummary {
  readonly filesRead: number;
  readonly filesFailed: readonly { readonly file: string; readonly reason: string }[];
}
