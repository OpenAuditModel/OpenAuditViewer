/**
 * Reading a load summary: the few figures the interface states that are not
 * fields of their own.
 */
import type { LoadSummary } from "./types";

/**
 * Files the walk found and the load never opened.
 *
 * A load that reaches the event ceiling stops where it is, and every file
 * after that point is left unread. Those files are not failures and not
 * declined — nothing went wrong with them — so they belong in neither notice
 * list, and without this figure the only sign of them is a count of files
 * found that does not match the count read.
 */
export function filesNeverOpened(summary: LoadSummary): number {
  return Math.max(
    0,
    summary.filesFound -
      summary.filesRead -
      summary.filesSkipped.length -
      summary.filesFailed.length,
  );
}
