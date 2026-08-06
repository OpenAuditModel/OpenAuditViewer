/**
 * Types for declarative profile conformance.
 *
 * Ported verbatim from conformance/src/profiles/types.ts (pure TypeScript,
 * no Node dependency).
 *
 * A profile adds requirements to the core model for a specific domain. It can
 * only ever add: the rule vocabulary can require a value to be present or equal
 * to a scalar, and can do nothing else. There is no way to express "this core
 * field is optional here", because there is no keyword that removes anything.
 *
 * Profile conformance is not legal or regulatory compliance, and a profile is
 * not a regulatory mapping. See decisions/0008-declarative-profile-conformance.md.
 */

/** How a rule reports its violations. Unrelated to the privacy linter's severities. */
export type RuleSeverity = "info" | "warning" | "error";

/** A scalar a condition or required value compares against. */
export type Scalar = string | number | boolean | null;

export interface Condition {
  readonly path: string;
  readonly equals: Scalar;
}

export interface RequiredValue {
  readonly path: string;
  readonly equals: Scalar;
}

export type MetadataType = "string" | "number" | "integer" | "boolean" | "object" | "array";

export interface RequiredMetadata {
  /** JSON Pointer relative to `/metadata`. */
  readonly path: string;
  readonly type: MetadataType;
}

export interface ProfileRule {
  readonly id: string;
  readonly description: string;
  readonly rationale?: string;
  readonly severity?: RuleSeverity;
  readonly events?: readonly string[];
  readonly eventPrefixes?: readonly string[];
  readonly when?: Condition;
  readonly requiredPaths?: readonly string[];
  readonly requiredMetadata?: readonly RequiredMetadata[];
  readonly requiredValues?: readonly RequiredValue[];
  readonly recommendedPaths?: readonly string[];
}

export interface ProfileDefinition {
  readonly profileVersion: string;
  readonly name: string;
  readonly version: string;
  readonly status: "experimental" | "stable" | "deprecated";
  readonly coreVersions: readonly string[];
  readonly title: string;
  readonly description: string;
  readonly rules: readonly ProfileRule[];
}

/**
 * Outcome of checking one event.
 *
 * `not-applicable` exists so that the tool never claims a document-sharing event
 * conforms to an identity profile. Silence is not conformance.
 */
export type ProfileStatus = "conforming" | "violations" | "not-applicable" | "core-invalid";

/** A profile requirement that was not met. Never carries an event value. */
export interface ProfileFinding {
  readonly ruleId: string;
  /** JSON Pointer to the location the requirement concerns. */
  readonly path: string;
  readonly message: string;
  readonly severity: RuleSeverity;
}

export interface ProfileCheckResult {
  readonly label: string;
  readonly eventId?: string;
  readonly status: ProfileStatus;
  /** Whether the event validates against the canonical core schema. */
  readonly coreValid: boolean;
  /** Whether the event satisfies every applicable profile requirement. */
  readonly profileValid: boolean;
  readonly profile: { readonly name: string; readonly version: string };
  readonly matchedRules: readonly string[];
  readonly errors: readonly ProfileFinding[];
  readonly warnings: readonly ProfileFinding[];
  /** Rendered core schema issues, present only when core validation failed. */
  readonly coreIssues: readonly string[];
}

/**
 * Whether a profile applies to an event declaring a given core specification
 * version.
 */
export function supportsCoreVersion(profile: ProfileDefinition, specVersion: unknown): boolean {
  return typeof specVersion === "string" && profile.coreVersions.includes(specVersion);
}
