/**
 * Turning absolute paths into something worth putting on screen.
 *
 * The loader reports every path it could not read in full, because that is
 * what identifies it; a notice showing only the file name would leave a user
 * with three `events.jsonl` in different subfolders no wiser about which one
 * was skipped. Shown relative to the folder they picked, the path is both
 * short and unambiguous.
 */

/**
 * The path as it should be shown, relative to the opened folder when it lies
 * inside it, and unchanged when it does not.
 */
export function displayPath(path: string, folder?: string): string {
  if (folder === undefined || !path.startsWith(folder)) {
    return path;
  }
  const relative = path.slice(folder.length).replace(/^[/\\]+/, "");
  return relative.length > 0 ? relative : path;
}
