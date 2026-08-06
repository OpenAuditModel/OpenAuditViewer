/**
 * Recognizers for values that must not be reported by the entropy heuristic.
 *
 * Audit events are full of long, random-looking strings that are supposed to be
 * there: event identifiers, trace context, integrity digests. Reporting them
 * would bury the findings that matter.
 *
 * These exclusions apply **only** to the generic entropy rule. A value under a
 * property named `password` is reported whatever it looks like, and a value
 * matching a known token format is reported even if it also looks like an
 * identifier.
 *
 * Every pattern here is anchored with a bounded quantifier, so none can
 * backtrack catastrophically.
 */

const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/** Crockford base32, excluding I, L, O and U. */
const ULID = /^[0-9ABCDEFGHJKMNPQRSTVWXYZ]{26}$/;

const TRACE_ID = /^[0-9a-f]{32}$/;
const SPAN_ID = /^[0-9a-f]{16}$/;

/** Lower-case hexadecimal digests of the lengths the integrity verifier supports. */
const HEX_DIGEST = /^(?:[0-9a-f]{64}|[0-9a-f]{96}|[0-9a-f]{128})$/;

const RFC3339 = /^\d{4}-\d{2}-\d{2}[Tt ]\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:[Zz]|[+-]\d{2}:\d{2})$/;

const NUMERIC_ID = /^\d{1,32}$/;

/**
 * A lower-case separated identifier or reference path, such as
 * `payments.settlement.completed`, `chain-platform-control-service` or
 * `records/root-cause-analysis/rca-2026-0418`.
 *
 * Two constraints keep this from swallowing real tokens. At least one separator
 * is required, so an unbroken run is never excluded. And upper case is not
 * accepted: a mixed-case alphanumeric run is exactly what a token looks like, so
 * matching one here would blind the entropy rule to the values it exists to
 * find. The cost is that an all-lower-case token containing a separator goes
 * unreported, which is an accepted false negative.
 */
const PLAIN_IDENTIFIER = /^[a-z][a-z0-9]*(?:[./_-][a-z0-9]+){1,32}$/;

/**
 * Values that stand in for a removed secret. Reporting these punishes the
 * behaviour the specification asks for, so they are not treated as exposures.
 * The list is deliberately short and matched exactly: a broad "looks masked"
 * rule would hide real values.
 */
const REDACTION_PLACEHOLDERS: ReadonlySet<string> = new Set([
  "[redacted]",
  "<redacted>",
  "redacted",
  "[masked]",
  "<masked>",
  "masked",
  "[removed]",
  "<removed>",
  "removed",
  "[omitted]",
  "<omitted>",
  "omitted",
  "[hidden]",
  "n/a",
  "null",
  "none",
  "-",
  "--",
]);

/** Any run of asterisks or bullet characters, such as `********`. */
const MASK_CHARACTERS = /^[*•·]{1,64}$/;

export function isUuid(value: string): boolean {
  return UUID.test(value);
}

export function isUlid(value: string): boolean {
  return ULID.test(value);
}

export function isTraceId(value: string): boolean {
  return TRACE_ID.test(value);
}

export function isSpanId(value: string): boolean {
  return SPAN_ID.test(value);
}

export function isHexDigest(value: string): boolean {
  return HEX_DIGEST.test(value);
}

export function isRfc3339Timestamp(value: string): boolean {
  return RFC3339.test(value);
}

export function isNumericIdentifier(value: string): boolean {
  return NUMERIC_ID.test(value);
}

export function isPlainIdentifier(value: string): boolean {
  return PLAIN_IDENTIFIER.test(value);
}

/** True when a value stands in for a secret that was removed. */
export function isRedactionPlaceholder(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed === "") {
    return true;
  }
  return REDACTION_PLACEHOLDERS.has(trimmed.toLowerCase()) || MASK_CHARACTERS.test(trimmed);
}

/** True when a value looks like a URL or a scheme-qualified locator. */
export function looksLikeLocator(value: string): boolean {
  return value.includes("://");
}

/**
 * True when a value has a recognised, non-secret shape. Consulted only by the
 * entropy heuristic.
 */
export function isKnownSafeFormat(value: string): boolean {
  return (
    isUuid(value) ||
    isUlid(value) ||
    isTraceId(value) ||
    isSpanId(value) ||
    isHexDigest(value) ||
    isRfc3339Timestamp(value) ||
    isNumericIdentifier(value) ||
    isPlainIdentifier(value) ||
    looksLikeLocator(value) ||
    isRedactionPlaceholder(value)
  );
}
