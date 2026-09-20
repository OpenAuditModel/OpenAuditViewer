/**
 * The update check: comparing this build against the latest published release.
 *
 * The request itself is made by Rust (`src-tauri/src/update.rs`) and only when
 * the user clicks. This module holds the part worth testing — deciding what
 * the answer means — and the part that must never be assumed: a tag that
 * cannot be read is reported as unreadable, not as "you are up to date".
 *
 * Versions are compared numerically, segment by segment. String comparison
 * would put 0.10.0 before 0.9.0, which is the classic way a version check
 * tells someone they are current when they are three releases behind.
 */
import { invoke } from "@tauri-apps/api/core";

/** What the Rust command returns. */
export interface LatestRelease {
  readonly tag: string;
  readonly url: string;
}

export type UpdateState =
  | { readonly status: "idle" }
  | { readonly status: "checking" }
  /** This build is the latest published release. */
  | { readonly status: "current"; readonly version: string }
  | {
      readonly status: "behind";
      readonly current: string;
      readonly latest: string;
      readonly url: string;
    }
  /** This build is newer than anything published — a local or pre-release build. */
  | { readonly status: "ahead"; readonly current: string; readonly latest: string }
  /** The check could not be completed, or the answer could not be read. */
  | { readonly status: "failed"; readonly message: string };

/** Parses `0.5.1` or `v0.5.1` into numbers, or `undefined` when it is neither. */
export function parseVersion(text: string): readonly number[] | undefined {
  const trimmed = text.trim().replace(/^v/i, "");
  if (!/^\d+(\.\d+)*$/.test(trimmed)) {
    return undefined;
  }
  return trimmed.split(".").map((part) => Number(part));
}

/**
 * Orders two versions: negative when `left` is older, positive when newer.
 * Missing trailing segments count as zero, so `0.5` equals `0.5.0`.
 */
export function compareVersions(left: readonly number[], right: readonly number[]): number {
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) {
      return difference;
    }
  }
  return 0;
}

/**
 * Turns a released tag and this build's version into a state to show.
 *
 * A tag that cannot be parsed is a failure, never a pass. The check exists to
 * say whether this build is behind, and an answer it cannot read is not an
 * answer that it is not.
 */
export function compareWithRelease(current: string, release: LatestRelease): UpdateState {
  const mine = parseVersion(current);
  const theirs = parseVersion(release.tag);

  if (mine === undefined || theirs === undefined) {
    return {
      status: "failed",
      message: `could not compare this build (${current}) with the published tag (${release.tag})`,
    };
  }

  const order = compareVersions(mine, theirs);
  if (order < 0) {
    return { status: "behind", current, latest: release.tag, url: release.url };
  }
  if (order > 0) {
    return { status: "ahead", current, latest: release.tag };
  }
  return { status: "current", version: current };
}

/**
 * Asks for the latest release and reports what it means for this build.
 *
 * Nothing is stored and nothing is retried: one click, one request, one
 * answer.
 */
export async function checkForUpdate(current: string): Promise<UpdateState> {
  try {
    const release = await invoke<LatestRelease>("check_latest_release");
    return compareWithRelease(current, release);
  } catch (cause) {
    return { status: "failed", message: typeof cause === "string" ? cause : "the check failed" };
  }
}
