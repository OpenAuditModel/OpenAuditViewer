/**
 * Event digest calculation and comparison.
 *
 * Ported from conformance/src/integrity/digest.ts. The procedure is
 * normative (specification/integrity.md §4): the same event must produce the
 * same digest in any conforming implementation, in any language — including
 * this one, running in a webview instead of Node.
 *
 * Two adaptations were needed:
 *  - Web Crypto's `crypto.subtle.digest` is asynchronous (Node's `createHash`
 *    is not), so `calculateDigest` is async here. It also accepts
 *    "SHA-256"/"SHA-384"/"SHA-512" directly, so unlike the CLI there is no
 *    name-mapping table.
 *  - `Buffer` and `timingSafeEqual` (`node:crypto`) don't exist in a webview.
 *    `digestsEqual` below does a plain byte comparison instead of a
 *    constant-time one. That's a deliberate scope narrowing, not an
 *    oversight: constant-time comparison defends against a timing side
 *    channel when a verifier is comparing an attacker-supplied digest over a
 *    network. This app only ever compares a locally computed digest against
 *    a value from a file the user opened on their own machine — there is no
 *    remote attacker in a position to time the comparison.
 */
import { canonicalBytes } from "./canonicalize";
import {
  DIGEST_BYTE_LENGTHS,
  SUPPORTED_HASH_ALGORITHMS,
  DIGEST_EXCLUDED_POINTERS,
  type SupportedHashAlgorithm,
} from "./types";

/** Lowercase hexadecimal, an even number of digits. The only accepted digest encoding. */
const HEX_DIGEST = /^([0-9a-f]{2})+$/;

/**
 * True when this verifier implements the declared algorithm. Matching is
 * case-sensitive: `sha256` is not `SHA-256`, and reinterpreting it would mean
 * guessing at what a producer meant.
 */
export function isSupportedHashAlgorithm(algorithm: string): algorithm is SupportedHashAlgorithm {
  return (SUPPORTED_HASH_ALGORITHMS as readonly string[]).includes(algorithm);
}

/** Digest length in bytes for a supported algorithm. */
export function digestByteLength(algorithm: SupportedHashAlgorithm): number {
  return DIGEST_BYTE_LENGTHS[algorithm];
}

/** True when a value is a well-formed lowercase hexadecimal digest. */
export function isHexDigest(value: unknown): value is string {
  return typeof value === "string" && HEX_DIGEST.test(value);
}

/**
 * Builds the digest input: a deep clone of the event with the self-referential
 * integrity members removed.
 *
 * Exactly two JSON Pointers are removed, `/integrity/hash` and
 * `/integrity/signature`. No other member is removed and no empty container is
 * pruned, so an `integrity` object left with no members is serialised as `{}`.
 * That rule is arbitrary but it must be fixed, because a producer that pruned
 * it and a verifier that did not would compute different digests.
 *
 * The input event is never mutated.
 */
export function buildDigestInput(event: unknown): unknown {
  const clone = structuredClone(event);

  if (clone !== null && typeof clone === "object" && !Array.isArray(clone)) {
    const record = clone as Record<string, unknown>;
    const integrity = record["integrity"];
    if (integrity !== null && typeof integrity === "object" && !Array.isArray(integrity)) {
      const integrityRecord = integrity as Record<string, unknown>;
      for (const pointer of DIGEST_EXCLUDED_POINTERS) {
        const member = pointer.slice("/integrity/".length);
        delete integrityRecord[member];
      }
    }
  }

  return clone;
}

function toHex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Calculates an event's digest and returns it as lowercase hexadecimal.
 *
 * Throws for an algorithm this verifier does not implement; callers that need
 * to report rather than throw should check `isSupportedHashAlgorithm` first.
 */
export async function calculateDigest(event: unknown, algorithm: string): Promise<string> {
  if (!isSupportedHashAlgorithm(algorithm)) {
    throw new Error(
      `unsupported hash algorithm "${algorithm}"; this verifier implements ${SUPPORTED_HASH_ALGORITHMS.join(", ")}`,
    );
  }

  const bytes = canonicalBytes(buildDigestInput(event));
  const digest = await crypto.subtle.digest(algorithm, bytes);
  return toHex(digest);
}

/**
 * Compares two digests as bytes. See the module comment for why this is a
 * plain comparison rather than a constant-time one in this app.
 */
export function digestsEqual(left: string, right: string): boolean {
  if (!isHexDigest(left) || !isHexDigest(right)) {
    return false;
  }

  return left === right;
}

export { SUPPORTED_HASH_ALGORITHMS, type SupportedHashAlgorithm };
