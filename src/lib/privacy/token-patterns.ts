/**
 * Recognizers for credential-shaped values.
 *
 * Ported from conformance/src/privacy/token-patterns.ts in the main
 * OpenAuditModel repository, unchanged except for `decodeJsonObject`: the
 * original uses Node's `Buffer`, which does not exist in a Tauri webview.
 * Here it decodes base64url via `atob` + `TextDecoder`, tuned to match
 * Buffer's lenient semantics exactly (see the comments in the function) so
 * that the same JWT-shaped value is flagged here and by the CLI.
 *
 * Every pattern is anchored, uses bounded quantifiers and contains no nested
 * quantifier or back-reference, so none can backtrack catastrophically. No
 * pattern uses look-behind, which keeps them portable across engines.
 *
 * A match identifies a value **shaped like** a credential. Nothing here checks
 * whether a credential is real, current or usable, and no matched value is ever
 * returned to a caller: the functions answer yes or no, so that a value cannot
 * leak into a report by accident.
 */
import { RULES } from "./rules";

const AUTHORIZATION_HEADER =
  /^(?:Bearer|Basic|Digest|ApiKey|Token)\s+[A-Za-z0-9._~+/=-]{16,4096}$/i;

const PRIVATE_KEY_MARKERS: readonly string[] = [
  "BEGIN PRIVATE KEY",
  "BEGIN RSA PRIVATE KEY",
  "BEGIN DSA PRIVATE KEY",
  "BEGIN EC PRIVATE KEY",
  "BEGIN OPENSSH PRIVATE KEY",
  "BEGIN PGP PRIVATE KEY BLOCK",
  "BEGIN ENCRYPTED PRIVATE KEY",
];

const BASE64URL_SEGMENT = /^[A-Za-z0-9_-]{4,8192}$/;

const PREFIXED_TOKEN_PATTERNS: ReadonlyArray<{
  readonly pattern: RegExp;
  readonly ruleId: string;
}> = [
  { pattern: /^(?:AKIA|ASIA)[A-Z0-9]{16}$/, ruleId: RULES.AWS_ACCESS_KEY_ID.id },
  { pattern: /^gh[pousr]_[A-Za-z0-9]{36,255}$/, ruleId: RULES.GITHUB_TOKEN.id },
  { pattern: /^github_pat_[A-Za-z0-9_]{22,255}$/, ruleId: RULES.GITHUB_TOKEN.id },
  { pattern: /^glpat-[A-Za-z0-9_-]{20,255}$/, ruleId: RULES.GITLAB_TOKEN.id },
  { pattern: /^xox[abprs]-[A-Za-z0-9-]{10,255}$/, ruleId: RULES.SLACK_TOKEN.id },
  { pattern: /^(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,255}$/, ruleId: RULES.PAYMENT_SECRET_KEY.id },
  { pattern: /^AIza[A-Za-z0-9_-]{35}$/, ruleId: RULES.CLOUD_API_KEY.id },
];

export function matchesAuthorizationHeader(value: string): boolean {
  return AUTHORIZATION_HEADER.test(value.trim());
}

export function containsPrivateKeyMaterial(value: string): boolean {
  return PRIVATE_KEY_MARKERS.some((marker) => value.includes(marker));
}

export function isJwtStructured(value: string): boolean {
  const segments = value.split(".");
  if (segments.length !== 3) {
    return false;
  }

  const [header, payload] = segments;
  if (header === undefined || payload === undefined) {
    return false;
  }
  if (!BASE64URL_SEGMENT.test(header) || !BASE64URL_SEGMENT.test(payload)) {
    return false;
  }

  const decodedHeader = decodeJsonObject(header);
  if (decodedHeader === undefined || typeof decodedHeader["alg"] !== "string") {
    return false;
  }

  return decodeJsonObject(payload) !== undefined;
}

/** Decodes a base64url segment to a JSON object, or `undefined`. Never returns content to a report.
 *
 * Matches Node's `Buffer.from(segment, "base64url")` + `toString("utf8")`
 * semantics, which the CLI uses, in the two places `atob`/`TextDecoder` are
 * stricter: a segment of length ≡ 1 (mod 4) has its dangling character
 * discarded (Buffer drops it silently; padded, `atob` would throw), and
 * invalid UTF-8 decodes with U+FFFD replacement instead of throwing. Being
 * stricter here would mean a JWT the CLI flags passes silently in the app. */
function decodeJsonObject(segment: string): Record<string, unknown> | undefined {
  let text: string;
  try {
    let base64 = segment.replaceAll("-", "+").replaceAll("_", "/");
    if (base64.length % 4 === 1) {
      base64 = base64.slice(0, -1);
    }
    const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    text = new TextDecoder("utf-8").decode(bytes);
  } catch {
    return undefined;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return undefined;
  }
  return parsed as Record<string, unknown>;
}

export function matchKnownTokenFormat(value: string): string | undefined {
  if (isJwtStructured(value)) {
    return RULES.JWT_TOKEN.id;
  }
  for (const { pattern, ruleId } of PREFIXED_TOKEN_PATTERNS) {
    if (pattern.test(value)) {
      return ruleId;
    }
  }
  return undefined;
}
