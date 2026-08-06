/**
 * The entropy heuristic.
 *
 * This is the only rule in the linter that guesses. It exists because a secret
 * can be stored under a harmless name in a format nobody publishes, and it is
 * deliberately conservative: every gate below is there to keep it quiet, and it
 * reports at low confidence unless the surrounding property name is itself
 * suspicious.
 *
 * A value must pass **all** of these to be reported:
 *
 *   1. It is a string of at least 24 and at most 4096 characters.
 *   2. It contains no whitespace, so ordinary prose is excluded.
 *   3. Every character is drawn from the token alphabet `A-Za-z0-9+/=_.-`.
 *   4. It uses at least 3 of the 4 character classes: lower case, upper case,
 *      digits, symbols. This excludes single-case words and hexadecimal runs.
 *   5. Its Shannon entropy is at least 4.0 bits per character.
 *   6. It is not a recognised safe format (see safe-formats.ts).
 *
 * The thresholds are fixed in v0.1 and are documented in
 * specification/privacy.md §6.
 */
import { isKnownSafeFormat } from "./safe-formats";

/** Shortest string the heuristic will consider. */
export const MIN_ENTROPY_LENGTH = 24;

/** Longest string the heuristic will consider; longer values are a size problem. */
export const MAX_ENTROPY_LENGTH = 4096;

/** Minimum Shannon entropy, in bits per character. */
export const ENTROPY_THRESHOLD = 4.0;

/** Minimum number of distinct character classes. */
export const MIN_CHARACTER_CLASSES = 3;

/** Characters a token may be built from. */
const TOKEN_ALPHABET = /^[A-Za-z0-9+/=_.-]+$/;

/** Shannon entropy of a string, in bits per character. */
export function shannonEntropy(value: string): number {
  if (value.length === 0) {
    return 0;
  }

  const counts = new Map<string, number>();
  for (const character of value) {
    counts.set(character, (counts.get(character) ?? 0) + 1);
  }

  let entropy = 0;
  for (const count of counts.values()) {
    const probability = count / value.length;
    entropy -= probability * Math.log2(probability);
  }

  return entropy;
}

/** Number of distinct character classes present: lower, upper, digit, symbol. */
export function characterClassCount(value: string): number {
  let classes = 0;
  if (/[a-z]/.test(value)) {
    classes += 1;
  }
  if (/[A-Z]/.test(value)) {
    classes += 1;
  }
  if (/[0-9]/.test(value)) {
    classes += 1;
  }
  if (/[^A-Za-z0-9]/.test(value)) {
    classes += 1;
  }
  return classes;
}

/** True when a value passes every gate of the entropy heuristic. */
export function isHighEntropyTokenCandidate(value: string): boolean {
  if (value.length < MIN_ENTROPY_LENGTH || value.length > MAX_ENTROPY_LENGTH) {
    return false;
  }
  if (/\s/.test(value)) {
    return false;
  }
  if (!TOKEN_ALPHABET.test(value)) {
    return false;
  }
  if (characterClassCount(value) < MIN_CHARACTER_CLASSES) {
    return false;
  }
  if (isKnownSafeFormat(value)) {
    return false;
  }
  return shannonEntropy(value) >= ENTROPY_THRESHOLD;
}
