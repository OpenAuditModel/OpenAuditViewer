/**
 * Deterministic JSON walker.
 *
 * Traversal uses own enumerable properties only, never reads a prototype and
 * never invokes an accessor: input always comes from `JSON.parse`, but a caller
 * could pass anything, and a linter that runs code contained in the thing it is
 * inspecting is a vulnerability rather than a tool.
 */

/** Depth at which traversal stops descending. */
export const MAX_LINT_DEPTH = 64;

/** One value encountered during traversal. */
export interface VisitedValue {
  /** JSON Pointer to this value. */
  readonly path: string;
  /** Property name this value was found under, absent for array items and roots. */
  readonly key?: string;
  readonly value: unknown;
  readonly depth: number;
}

/** Escapes a property name as a JSON Pointer reference token: `~` to `~0`, `/` to `~1`. */
export function pointerSegment(property: string): string {
  return property.replaceAll("~", "~0").replaceAll("/", "~1");
}

/** Appends a property name or array index to a JSON Pointer. */
export function joinPointer(base: string, segment: string | number): string {
  const encoded = typeof segment === "number" ? String(segment) : pointerSegment(segment);
  return `${base}/${encoded}`;
}

/**
 * Visits a value and every value beneath it, in a stable order.
 *
 * The root is visited first, then each member in own-property order. Traversal
 * stops at `MAX_LINT_DEPTH`; a document deep enough to reach it is reported by
 * the size rule rather than silently truncated in the caller's mind.
 */
export function traverse(
  root: unknown,
  basePath: string,
  visit: (visited: VisitedValue) => void,
): void {
  const walk = (value: unknown, path: string, key: string | undefined, depth: number): void => {
    visit({ path, ...(key === undefined ? {} : { key }), value, depth });

    if (depth >= MAX_LINT_DEPTH) {
      return;
    }

    if (Array.isArray(value)) {
      for (const [index, item] of value.entries()) {
        walk(item, joinPointer(path, index), undefined, depth + 1);
      }
      return;
    }

    if (value !== null && typeof value === "object") {
      for (const [property, member] of Object.entries(value as Record<string, unknown>)) {
        walk(member, joinPointer(path, property), property, depth + 1);
      }
    }
  };

  walk(root, basePath, undefined, 0);
}

/** Reads a nested value by property path, without traversing prototypes. */
export function readPath(root: unknown, properties: readonly string[]): unknown {
  let current: unknown = root;

  for (const property of properties) {
    if (current === null || typeof current !== "object" || Array.isArray(current)) {
      return undefined;
    }
    if (!Object.hasOwn(current, property)) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[property];
  }

  return current;
}
