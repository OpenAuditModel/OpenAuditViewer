/**
 * RFC 8785 JSON Canonicalization Scheme.
 *
 * Ported from conformance/src/integrity/canonicalize.ts, unchanged except for
 * `canonicalBytes`: the original uses Node's `Buffer`, which does not exist
 * in a Tauri webview. Here it uses `TextEncoder`, which encodes UTF-8
 * identically.
 *
 * Canonicalization itself is delegated to the same `canonicalize` package
 * (Apache-2.0, no dependencies) the CLI uses, so this app cannot compute a
 * digest by a different procedure than the reference implementation.
 */
import canonicalizeValue from "canonicalize";

export const CANONICALIZATION_RFC8785 = "RFC8785";
export const SUPPORTED_CANONICALIZATIONS = [CANONICALIZATION_RFC8785] as const;

export const MAX_JSON_DEPTH = 200;

export class CanonicalizationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CanonicalizationError";
  }
}

function describePointer(pointer: string): string {
  return pointer === "" ? "the document root" : pointer;
}

function isPlainObject(value: object): boolean {
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

export function assertJsonValue(value: unknown, pointer = "", depth = 0): void {
  if (depth > MAX_JSON_DEPTH) {
    throw new CanonicalizationError(
      `structure is nested more than ${MAX_JSON_DEPTH} levels deep at ${describePointer(pointer)}`,
    );
  }

  if (value === null) {
    return;
  }

  switch (typeof value) {
    case "boolean":
    case "string":
      return;
    case "number":
      if (!Number.isFinite(value)) {
        throw new CanonicalizationError(
          `number at ${describePointer(pointer)} is not finite and cannot be canonicalized`,
        );
      }
      return;
    case "object":
      break;
    default:
      throw new CanonicalizationError(
        `value at ${describePointer(pointer)} has type "${typeof value}", which JSON cannot represent`,
      );
  }

  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      assertJsonValue(item, `${pointer}/${index}`, depth + 1);
    }
    return;
  }

  if (!isPlainObject(value as object)) {
    throw new CanonicalizationError(
      `value at ${describePointer(pointer)} is not a plain JSON object`,
    );
  }

  for (const [key, member] of Object.entries(value as Record<string, unknown>)) {
    if (member === undefined) {
      throw new CanonicalizationError(
        `member "${key}" at ${describePointer(pointer)} is undefined, which JSON cannot represent`,
      );
    }
    assertJsonValue(
      member,
      `${pointer}/${key.replaceAll("~", "~0").replaceAll("/", "~1")}`,
      depth + 1,
    );
  }
}

export function canonicalize(value: unknown): string {
  assertJsonValue(value);

  const canonical = canonicalizeValue(value);
  if (typeof canonical !== "string") {
    throw new CanonicalizationError("value could not be canonicalized");
  }

  return canonical;
}

const encoder = new TextEncoder();

export function canonicalBytes(value: unknown): Uint8Array {
  return encoder.encode(canonicalize(value));
}

export function isSupportedCanonicalization(identifier: string): boolean {
  return (SUPPORTED_CANONICALIZATIONS as readonly string[]).includes(identifier);
}
