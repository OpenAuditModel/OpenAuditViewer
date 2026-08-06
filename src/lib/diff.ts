/**
 * Structural diff of `change.before` / `change.after`.
 *
 * The core model allows before/after to be any JSON value. When both sides
 * are plain objects, a per-path diff is far more readable than two JSON
 * dumps; for anything else (strings, numbers, arrays at the root, or mixed
 * types) the caller falls back to showing both sides whole.
 *
 * Arrays are compared as whole values, not element-diffed: audit change
 * snapshots rarely contain long arrays, and an element-level array diff
 * (with moves and splices) costs far more complexity than the readability
 * it buys here.
 */

export type DiffKind = "added" | "removed" | "changed";

export interface DiffRow {
  readonly path: string;
  readonly kind: DiffKind;
  readonly before?: unknown;
  readonly after?: unknown;
}

const MAX_DIFF_DEPTH = 16;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function sameJson(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) {
    return true;
  }
  try {
    return JSON.stringify(left) === JSON.stringify(right);
  } catch {
    // Nesting beyond the engine's stack. Reporting "changed" is the honest
    // fallback: the values could not be proven equal.
    return false;
  }
}

function walk(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  path: string,
  depth: number,
  rows: DiffRow[],
): void {
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();

  for (const key of keys) {
    const childPath = `${path}/${key.replaceAll("~", "~0").replaceAll("/", "~1")}`;
    const inBefore = Object.hasOwn(before, key);
    const inAfter = Object.hasOwn(after, key);

    if (inBefore && !inAfter) {
      rows.push({ path: childPath, kind: "removed", before: before[key] });
      continue;
    }
    if (!inBefore && inAfter) {
      rows.push({ path: childPath, kind: "added", after: after[key] });
      continue;
    }

    const beforeValue = before[key];
    const afterValue = after[key];

    if (isPlainObject(beforeValue) && isPlainObject(afterValue) && depth < MAX_DIFF_DEPTH) {
      walk(beforeValue, afterValue, childPath, depth + 1, rows);
      continue;
    }

    if (!sameJson(beforeValue, afterValue)) {
      rows.push({ path: childPath, kind: "changed", before: beforeValue, after: afterValue });
    }
  }
}

/**
 * Diffs two change snapshots per path, or returns `undefined` when the
 * shapes don't support it (caller shows both sides whole instead).
 */
export function diffChange(before: unknown, after: unknown): DiffRow[] | undefined {
  if (!isPlainObject(before) || !isPlainObject(after)) {
    return undefined;
  }
  const rows: DiffRow[] = [];
  walk(before, after, "", 0, rows);
  return rows;
}

/** Renders one diff cell value the way the raw-JSON pane would. */
export function formatDiffValue(value: unknown): string {
  if (value === undefined) {
    return "";
  }
  if (typeof value === "string") {
    return value;
  }
  return safeStringify(value, 1);
}

/**
 * JSON.stringify that survives hostile input. `JSON.parse` accepts nesting
 * far deeper than `JSON.stringify` can serialize, so a value read from a
 * file is not guaranteed to be re-serializable — and a throw here would
 * happen mid-render, taking the whole tree down with it.
 */
export function safeStringify(value: unknown, indent: number): string {
  try {
    return JSON.stringify(value, null, indent) ?? String(value);
  } catch {
    return "(value is nested too deeply to display)";
  }
}
