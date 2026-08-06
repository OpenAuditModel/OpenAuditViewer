/**
 * RFC 6901 JSON Pointer resolution.
 *
 * Ported verbatim from conformance/src/profiles/resolve-pointer.ts.
 *
 * Resolution reads own enumerable properties only. It never walks a prototype,
 * never invokes an accessor and never evaluates anything: a profile definition
 * is data, and a pointer taken from one must not be able to reach `__proto__`,
 * `constructor` or any inherited member of the event being checked.
 */

/** Deepest pointer accepted, so that a hostile pointer cannot drive unbounded work. */
export const MAX_POINTER_DEPTH = 32;

export interface PointerResolution {
  /** Whether the pointer resolved to a member that exists. */
  readonly found: boolean;
  readonly value: unknown;
}

const NOT_FOUND: PointerResolution = { found: false, value: undefined };

/** Decodes one reference token: `~1` to `/`, then `~0` to `~`, in that order. */
export function decodeReferenceToken(token: string): string {
  return token.replaceAll("~1", "/").replaceAll("~0", "~");
}

/** Splits a pointer into its decoded reference tokens, or `undefined` if malformed. */
export function pointerTokens(pointer: string): string[] | undefined {
  if (pointer === "") {
    return [];
  }
  if (!pointer.startsWith("/")) {
    return undefined;
  }

  const tokens = pointer.slice(1).split("/");
  if (tokens.length > MAX_POINTER_DEPTH) {
    return undefined;
  }
  return tokens.map(decodeReferenceToken);
}

/** Joins a base pointer and a relative pointer, as `/metadata` + `/role/id`. */
export function concatPointer(base: string, relative: string): string {
  return `${base}${relative}`;
}

function isIndex(token: string): boolean {
  return token === "0" || /^[1-9][0-9]{0,9}$/.test(token);
}

/**
 * Resolves a JSON Pointer against a parsed JSON value.
 *
 * Returns `found: false` for a malformed pointer, a member that does not exist,
 * an out-of-range array index, or any attempt to traverse a non-container.
 */
export function resolvePointer(root: unknown, pointer: string): PointerResolution {
  const tokens = pointerTokens(pointer);
  if (tokens === undefined) {
    return NOT_FOUND;
  }

  let current: unknown = root;

  for (const token of tokens) {
    if (current === null || typeof current !== "object") {
      return NOT_FOUND;
    }

    if (Array.isArray(current)) {
      if (!isIndex(token)) {
        return NOT_FOUND;
      }
      const index = Number(token);
      if (index >= current.length) {
        return NOT_FOUND;
      }
      current = current[index];
      continue;
    }

    // `Object.hasOwn` keeps inherited and prototype members unreachable.
    if (!Object.hasOwn(current, token)) {
      return NOT_FOUND;
    }
    current = (current as Record<string, unknown>)[token];
  }

  return { found: true, value: current };
}

/**
 * Whether a resolved value counts as **present** for a profile requirement.
 *
 * Present means: the member exists, is not null, and is not an empty string,
 * array or object. `false` and `0` are present — they are answers, not absences,
 * and a profile that could not require `mfa: false` to be recorded would be
 * unable to distinguish "not recorded" from "recorded as false".
 *
 * This differs deliberately from the privacy linter's notion of a populated
 * value, which excludes booleans because a credential cannot be `true`.
 */
export function isPresent(resolution: PointerResolution): boolean {
  if (!resolution.found) {
    return false;
  }

  const { value } = resolution;
  if (value === null || value === undefined) {
    return false;
  }
  if (typeof value === "string") {
    return value.length > 0;
  }
  if (Array.isArray(value)) {
    return value.length > 0;
  }
  if (typeof value === "object") {
    return Object.keys(value as Record<string, unknown>).length > 0;
  }
  return true;
}

/** JSON type of a value, using the profile metadata type vocabulary. */
export function jsonTypeOf(value: unknown): string {
  if (value === null) {
    return "null";
  }
  if (Array.isArray(value)) {
    return "array";
  }
  if (Number.isInteger(value)) {
    return "integer";
  }
  return typeof value;
}

/** Whether a value matches a declared metadata type. `integer` is a subset of `number`. */
export function matchesMetadataType(value: unknown, expected: string): boolean {
  const actual = jsonTypeOf(value);
  if (expected === "number") {
    return actual === "number" || actual === "integer";
  }
  return actual === expected;
}
