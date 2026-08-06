/**
 * Size analysis for the containers that are captured wholesale most often.
 *
 * Ported from conformance/src/privacy/size-analysis.ts, unchanged except for
 * the byte-length measurement: the original uses Node's `Buffer`, which does
 * not exist in a Tauri webview. Here it uses `TextEncoder`, which measures
 * UTF-8 bytes identically.
 *
 * This rule cannot tell a carefully chosen large object from a serialized
 * database row. It reports that a value is large enough to suggest the
 * second, and says so in those terms: the finding is about **minimization**,
 * not about personal data, and it never claims to know what the value
 * contains.
 */

export interface SizeThresholds {
  readonly serializedBytes: number;
  readonly totalProperties: number;
  readonly maxDepth: number;
  readonly maxArrayLength: number;
  readonly longestString: number;
}

export const SIZE_THRESHOLDS: SizeThresholds = {
  serializedBytes: 4096,
  totalProperties: 50,
  maxDepth: 6,
  maxArrayLength: 100,
  longestString: 2048,
};

export const MAX_PROFILE_DEPTH = 64;

export interface SizeProfile {
  readonly serializedBytes: number;
  readonly totalProperties: number;
  readonly maxDepth: number;
  readonly maxArrayLength: number;
  readonly longestString: number;
}

const encoder = new TextEncoder();

export function profileValue(value: unknown): SizeProfile {
  let totalProperties = 0;
  let maxDepth = 0;
  let maxArrayLength = 0;
  let longestString = 0;

  const walk = (node: unknown, depth: number): void => {
    if (depth > maxDepth) {
      maxDepth = depth;
    }
    if (depth >= MAX_PROFILE_DEPTH) {
      return;
    }

    if (typeof node === "string") {
      longestString = Math.max(longestString, node.length);
      return;
    }
    if (Array.isArray(node)) {
      maxArrayLength = Math.max(maxArrayLength, node.length);
      for (const item of node) {
        walk(item, depth + 1);
      }
      return;
    }
    if (node !== null && typeof node === "object") {
      for (const [, member] of Object.entries(node as Record<string, unknown>)) {
        totalProperties += 1;
        walk(member, depth + 1);
      }
    }
  };

  walk(value, 0);

  let serializedBytes: number;
  try {
    serializedBytes = encoder.encode(JSON.stringify(value) ?? "").length;
  } catch {
    serializedBytes = 0;
  }

  return { serializedBytes, totalProperties, maxDepth, maxArrayLength, longestString };
}

export function exceededSignals(
  profile: SizeProfile,
  thresholds: SizeThresholds = SIZE_THRESHOLDS,
): string[] {
  const signals: string[] = [];

  if (profile.serializedBytes > thresholds.serializedBytes) {
    signals.push(
      `serialized size ${profile.serializedBytes} bytes exceeds ${thresholds.serializedBytes}`,
    );
  }
  if (profile.totalProperties > thresholds.totalProperties) {
    signals.push(`${profile.totalProperties} properties exceeds ${thresholds.totalProperties}`);
  }
  if (profile.maxDepth > thresholds.maxDepth) {
    signals.push(`nesting depth ${profile.maxDepth} exceeds ${thresholds.maxDepth}`);
  }
  if (profile.maxArrayLength > thresholds.maxArrayLength) {
    signals.push(`array of ${profile.maxArrayLength} items exceeds ${thresholds.maxArrayLength}`);
  }
  if (profile.longestString > thresholds.longestString) {
    signals.push(
      `string of ${profile.longestString} characters exceeds ${thresholds.longestString}`,
    );
  }

  return signals;
}
