/**
 * Shared types and constants for tamper-evidence verification.
 *
 * Ported from conformance/src/integrity/types.ts. Pure TypeScript, no Node
 * dependency, so this is an unmodified copy.
 *
 * The tooling detects specific integrity failures. It does not prevent deletion
 * or modification, and it makes no claim that an event is immutable,
 * tamper-proof, legally binding or non-repudiable.
 */

/** Canonicalization identifier the v0.1 verifier implements: RFC 8785 JCS. */
export const CANONICALIZATION_RFC8785 = "RFC8785";

/** Canonicalization identifiers this verifier can execute. Matching is case-sensitive. */
export const SUPPORTED_CANONICALIZATIONS = [CANONICALIZATION_RFC8785] as const;

/**
 * Hash algorithms this verifier can execute, as normative identifiers.
 *
 * The schema keeps `integrity.hashAlgorithm` an open vocabulary so that new
 * algorithms can be adopted without a specification change. An identifier the
 * schema accepts is therefore not necessarily one this verifier implements: an
 * event declaring an algorithm outside this list is reported as
 * `unsupported-algorithm` rather than silently treated as verified.
 */
export const SUPPORTED_HASH_ALGORITHMS = ["SHA-256", "SHA-384", "SHA-512"] as const;

export type SupportedHashAlgorithm = (typeof SUPPORTED_HASH_ALGORITHMS)[number];

/** Digest length in bytes for each supported algorithm. */
export const DIGEST_BYTE_LENGTHS: Readonly<Record<SupportedHashAlgorithm, number>> = {
  "SHA-256": 32,
  "SHA-384": 48,
  "SHA-512": 64,
};

/**
 * JSON Pointers removed from an event before its digest is calculated.
 *
 * Everything else, including `sequence`, `integrity.previousHash`,
 * `integrity.chainId`, `integrity.batchId`, `integrity.hashAlgorithm` and
 * `integrity.canonicalization`, is part of the digest input.
 */
export const DIGEST_EXCLUDED_POINTERS = ["/integrity/hash", "/integrity/signature"] as const;

/** Why a single event failed verification. */
export type EventFindingKind =
  | "schema-invalid"
  | "integrity-missing"
  | "hash-missing"
  | "hash-algorithm-missing"
  | "canonicalization-missing"
  | "unsupported-canonicalization"
  | "unsupported-algorithm"
  | "malformed-hash"
  | "digest-length-mismatch"
  | "hash-mismatch"
  | "canonicalization-failed";

/** Why a chain failed verification. */
export type ChainFindingKind =
  | "chain-id-missing"
  | "sequence-missing"
  | "duplicate-sequence"
  | "previous-hash-missing"
  | "broken-link"
  | "algorithm-mismatch";

export type FindingKind = EventFindingKind | ChainFindingKind;

/** A single reason verification did not succeed. */
export interface Finding {
  readonly kind: FindingKind;
  /** One line, safe to print. Never contains event content. */
  readonly message: string;
  /** Ordered detail lines, such as the declared and calculated digests. */
  readonly detail?: readonly string[];
  /** Where the problem was found, when it applies to one event. */
  readonly label?: string;
}

/** An informational observation that does not by itself fail verification. */
export interface Note {
  readonly message: string;
  readonly detail?: readonly string[];
}

/** A check that passed, reported so that a successful run says what it proved. */
export interface PassedCheck {
  readonly message: string;
}

/** Outcome of verifying one event's own digest. */
export interface EventVerificationResult {
  readonly label: string;
  readonly verified: boolean;
  readonly checks: readonly PassedCheck[];
  readonly findings: readonly Finding[];
  readonly canonicalization?: string;
  readonly hashAlgorithm?: string;
  readonly declaredHash?: string;
  readonly calculatedHash?: string;
}

/** Outcome of verifying one chain. */
export interface ChainVerificationResult {
  readonly chainId: string;
  readonly eventCount: number;
  readonly firstSequence?: number;
  readonly lastSequence?: number;
  readonly intact: boolean;
  readonly checks: readonly PassedCheck[];
  readonly findings: readonly Finding[];
  readonly notes: readonly Note[];
}

/** Outcome of verifying every chain in a supplied set of events. */
export interface ChainReport {
  readonly chains: readonly ChainVerificationResult[];
  /** Events that could not be assigned to a chain at all. */
  readonly unassigned: readonly Finding[];
  readonly eventCount: number;
  readonly intact: boolean;
}
