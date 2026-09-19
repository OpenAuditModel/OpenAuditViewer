/**
 * Verification of a single event's own digest.
 *
 * Ported from conformance/src/integrity/verify-event.ts, adapted the same
 * way lint-event.ts was: schema validation calls this app's own
 * `validateEvent` directly instead of taking an injectable validator, and
 * `calculateDigest` is awaited since Web Crypto is asynchronous.
 *
 * Signature verification itself is intentionally not ported: the viewer only
 * ever has the public event data a user opened from disk, and no key to check
 * a signature against. What *is* ported is what the CLI does about a declared
 * signature when it has no key, because the two must agree. An algorithm the
 * reference implementation does not implement fails verification — a signature
 * that can never be checked must not read as verified (specification/integrity.md
 * §6.1) — and an implemented algorithm is reported as declared but not checked,
 * with the verdict resting on the hash alone. Until 0.5.0 this app skipped the
 * first case and reported such an event verified; the parity suite found it.
 *
 * This proves that the event has not been altered since its digest was
 * calculated. It proves nothing about whether the event was ever stored, is
 * still stored, or belongs to a complete chain — see chain.ts for that.
 */
import { validateEvent as validateAgainstSchema } from "../schema";
import { CanonicalizationError, isSupportedCanonicalization } from "./canonicalize";
import {
  calculateDigest,
  digestByteLength,
  digestsEqual,
  isHexDigest,
  isSupportedHashAlgorithm,
} from "./digest";
import {
  SUPPORTED_CANONICALIZATIONS,
  SUPPORTED_HASH_ALGORITHMS,
  SUPPORTED_SIGNATURE_ALGORITHMS,
  type EventVerificationResult,
  type Finding,
  type PassedCheck,
} from "./types";

export interface VerifyEventOptions {
  /** Validate against the canonical schema first. Defaults to true. */
  readonly validateSchema?: boolean;
}

/** The integrity object of an event, once it is known to be an object. */
interface IntegrityObject {
  readonly canonicalization?: unknown;
  readonly hashAlgorithm?: unknown;
  readonly hash?: unknown;
  readonly previousHash?: unknown;
  readonly chainId?: unknown;
  readonly signature?: unknown;
}

/** `integrity.signature`, once it is known to be an object. Read defensively:
 * chain verification bypasses schema validation on the assumption it already
 * ran once for the same event. */
function readSignature(signature: unknown): { algorithm: string; value: string } | undefined {
  if (signature === null || typeof signature !== "object" || Array.isArray(signature)) {
    return undefined;
  }
  const record = signature as Record<string, unknown>;
  const algorithm = record["algorithm"];
  const value = record["value"];
  if (typeof algorithm !== "string" || typeof value !== "string") {
    return undefined;
  }
  return { algorithm, value };
}

function failure(
  label: string,
  finding: Finding,
  checks: readonly PassedCheck[] = [],
): EventVerificationResult {
  return { label, verified: false, checks, findings: [{ ...finding, label }] };
}

/** Reads the integrity object of an event, or `undefined` when there is none. */
export function readIntegrity(event: unknown): IntegrityObject | undefined {
  if (event === null || typeof event !== "object" || Array.isArray(event)) {
    return undefined;
  }
  const integrity = (event as Record<string, unknown>)["integrity"];
  if (integrity === null || typeof integrity !== "object" || Array.isArray(integrity)) {
    return undefined;
  }
  return integrity as IntegrityObject;
}

/**
 * Verifies that an event's declared `integrity.hash` matches a digest
 * recalculated from the event itself.
 */
export async function verifyEventIntegrity(
  event: unknown,
  label: string,
  options: VerifyEventOptions = {},
): Promise<EventVerificationResult> {
  const checks: PassedCheck[] = [];

  if (options.validateSchema !== false) {
    const issues = validateAgainstSchema(event);
    if (issues.length > 0) {
      const shown = issues.slice(0, 3).map((issue) => `${issue.path}  ${issue.message}`);
      const detail =
        issues.length > shown.length
          ? [...shown, `and ${issues.length - shown.length} further schema issues`]
          : shown;
      return failure(label, {
        kind: "schema-invalid",
        message: "event does not conform to the canonical schema",
        detail,
      });
    }
    checks.push({ message: "schema valid" });
  }

  const integrity = readIntegrity(event);
  if (integrity === undefined) {
    return failure(
      label,
      {
        kind: "integrity-missing",
        message: "event carries no integrity object, so there is nothing to verify",
        detail: ["integrity is optional in the core model; this command requires it"],
      },
      checks,
    );
  }

  const { canonicalization, hashAlgorithm, hash } = integrity;

  if (typeof hash !== "string") {
    return failure(
      label,
      { kind: "hash-missing", message: "integrity object declares no hash" },
      checks,
    );
  }

  if (typeof canonicalization !== "string") {
    return failure(
      label,
      {
        kind: "canonicalization-missing",
        message: "integrity object declares a hash but no canonicalization",
      },
      checks,
    );
  }

  if (!isSupportedCanonicalization(canonicalization)) {
    return failure(
      label,
      {
        kind: "unsupported-canonicalization",
        message: `canonicalization "${canonicalization}" is not implemented by this verifier`,
        detail: [`implemented: ${SUPPORTED_CANONICALIZATIONS.join(", ")}`],
      },
      checks,
    );
  }
  checks.push({ message: `canonicalization: ${canonicalization}` });

  if (typeof hashAlgorithm !== "string") {
    return failure(
      label,
      {
        kind: "hash-algorithm-missing",
        message: "integrity object declares a hash but no hash algorithm",
      },
      checks,
    );
  }

  if (!isSupportedHashAlgorithm(hashAlgorithm)) {
    return failure(
      label,
      {
        kind: "unsupported-algorithm",
        message: `hash algorithm "${hashAlgorithm}" is not implemented by this verifier`,
        detail: [
          `implemented: ${SUPPORTED_HASH_ALGORITHMS.join(", ")}`,
          "the schema keeps this vocabulary open; acceptance by the schema is not support",
        ],
      },
      checks,
    );
  }
  checks.push({ message: `hash algorithm: ${hashAlgorithm}` });

  if (!isHexDigest(hash)) {
    return failure(
      label,
      {
        kind: "malformed-hash",
        message: "declared hash is not lowercase hexadecimal",
        detail: ["digests are encoded as lowercase hexadecimal; see specification/integrity.md §5"],
      },
      checks,
    );
  }

  const expectedLength = digestByteLength(hashAlgorithm) * 2;
  if (hash.length !== expectedLength) {
    return failure(
      label,
      {
        kind: "digest-length-mismatch",
        message: `declared hash is ${hash.length} characters, but ${hashAlgorithm} produces ${expectedLength}`,
      },
      checks,
    );
  }

  let calculated: string;
  try {
    calculated = await calculateDigest(event, hashAlgorithm);
  } catch (cause) {
    const message =
      cause instanceof CanonicalizationError
        ? cause.message
        : `digest could not be calculated: ${(cause as Error).message}`;
    return failure(label, { kind: "canonicalization-failed", message }, checks);
  }

  if (!digestsEqual(hash, calculated)) {
    return {
      label,
      verified: false,
      checks,
      findings: [
        {
          kind: "hash-mismatch",
          label,
          message: "integrity hash mismatch",
          detail: [`declared:   ${hash}`, `calculated: ${calculated}`],
        },
      ],
      canonicalization,
      hashAlgorithm,
      declaredHash: hash,
      calculatedHash: calculated,
    };
  }

  checks.push({ message: "integrity hash valid" });

  // A declared signature is always reported on, never passed over in silence.
  const declared = readSignature(integrity.signature);
  if (declared !== undefined) {
    if (!(SUPPORTED_SIGNATURE_ALGORITHMS as readonly string[]).includes(declared.algorithm)) {
      return {
        label,
        verified: false,
        checks,
        findings: [
          {
            kind: "unsupported-signature-algorithm",
            label,
            message: `signature algorithm "${declared.algorithm}" is not implemented by this verifier`,
            detail: [
              `implemented by the reference implementation: ${SUPPORTED_SIGNATURE_ALGORITHMS.join(", ")}`,
              "a signature that can never be checked here must not read as verified",
            ],
          },
        ],
        canonicalization,
        hashAlgorithm,
        declaredHash: hash,
        calculatedHash: calculated,
      };
    }
    checks.push({
      message: `signature declared (${declared.algorithm}), not checked: this viewer holds no public key`,
    });
  }

  return {
    label,
    verified: true,
    checks,
    findings: [],
    canonicalization,
    hashAlgorithm,
    declaredHash: hash,
    calculatedHash: calculated,
  };
}
