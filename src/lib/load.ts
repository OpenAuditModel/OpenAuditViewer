/**
 * Folder picking and file reading, via Tauri's dialog and fs plugins.
 *
 * Reading happens through the OS-native APIs those plugins wrap, not a
 * browser file input, so a whole folder tree can be walked without a user
 * having to multi-select five hundred files by hand.
 *
 * Every bound this module applies is reported in the summary it returns, and
 * every path it decides not to read is named there with its reason. A viewer
 * that shows part of a folder without saying so is worse than one that
 * refuses to open it.
 */
import { open, save } from "@tauri-apps/plugin-dialog";
import {
  readDir,
  readTextFile,
  readTextFileLines,
  stat,
  writeTextFile,
} from "@tauri-apps/plugin-fs";
import { Resource } from "@tauri-apps/api/core";
import { isJsonLines, parseFile, parseJsonLine } from "./parse";
import type { LoadedEvent, LoadSummary, PathNotice } from "./types";

const RECOGNIZED_EXTENSIONS = [".json", ".jsonl", ".ndjson"];

/** The bounds a load applies. Defaults are the only values the application
 * uses; they are parameters so that each bound can be exercised in a test
 * without building a folder large enough to reach it. */
export interface LoadLimits {
  /**
   * Largest `.json` document read.
   *
   * A JSON document has to be parsed whole — there is no meaningful prefix of
   * one — so its size is the memory it costs, and the only defence is to
   * decline before reading. JSON Lines files have no such limit: they are
   * streamed a line at a time and bounded by the event ceiling instead.
   */
  readonly maxJsonBytes: number;
  /**
   * Ceiling on events held at once, across the whole folder.
   *
   * This is a viewer: everything it has read stays in memory so it can be
   * sorted, filtered and cross-referenced. Without a ceiling, a folder large
   * enough — by accident or on purpose — exhausts the webview and takes the
   * window with it. Stopping and saying so is the lesser failure.
   */
  readonly maxEvents: number;
  /**
   * Deepest directory nesting followed. Bounds the walk against symlink
   * cycles and pathological trees; a legitimate log archive does not sit 32
   * directories deep.
   */
  readonly maxDirectoryDepth: number;
}

export const DEFAULT_LOAD_LIMITS: LoadLimits = {
  maxJsonBytes: 32 * 1024 * 1024,
  maxEvents: 100_000,
  maxDirectoryDepth: 32,
};

/** Events parsed between yields, so the window can still paint while loading. */
const YIELD_INTERVAL = 2_000;

/** Rows appended per `push` call. See {@link appendBounded}. */
const APPEND_CHUNK = 10_000;

/** Hands control back to the event loop so the interface stays responsive. */
function yieldToUi(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** Directories never worth recursing into: build output and dependency trees
 * routinely hold thousands of unrelated files, and picking a repository root
 * as the folder to scan is a completely reasonable thing for a user to do. */
const SKIPPED_DIRECTORIES = new Set([
  "node_modules",
  "target",
  "dist",
  ".git",
  ".idea",
  ".vscode",
  "coverage",
]);

function isRecognized(name: string): boolean {
  const lower = name.toLowerCase();
  return RECOGNIZED_EXTENSIONS.some((extension) => lower.endsWith(extension));
}

/** What walking a folder tree produced: the files to read, and the directories
 * that were not walked, each with the reason it was not. */
interface Walk {
  readonly files: string[];
  readonly directoriesSkipped: PathNotice[];
  readonly directoriesFailed: PathNotice[];
}

/**
 * Collects every recognized file under `root` into `walk`, recursing into
 * subdirectories.
 *
 * A directory that cannot be listed is recorded and stepped over rather than
 * thrown out of: one unreadable subdirectory — a permission denied deep in a
 * tree is the ordinary case — must not cost the user the whole folder.
 */
async function walkFolder(root: string, limits: LoadLimits, walk: Walk, depth = 0): Promise<void> {
  let entries;
  try {
    entries = await readDir(root);
  } catch (cause) {
    walk.directoriesFailed.push({ path: root, reason: (cause as Error).message });
    return;
  }

  for (const entry of entries) {
    const path = `${root}/${entry.name}`;
    if (entry.isDirectory) {
      if (SKIPPED_DIRECTORIES.has(entry.name)) {
        walk.directoriesSkipped.push({ path, reason: "dependency or build directory" });
        continue;
      }
      if (depth + 1 > limits.maxDirectoryDepth) {
        walk.directoriesSkipped.push({
          path,
          reason: `deeper than the ${limits.maxDirectoryDepth}-directory limit`,
        });
        continue;
      }
      await walkFolder(path, limits, walk, depth + 1);
    } else if (isRecognized(entry.name)) {
      walk.files.push(path);
    }
  }
}

/**
 * Appends `rows` to `target` without exceeding `limit`, and reports whether
 * anything had to be left behind.
 *
 * Chunked on purpose. `push(...rows)` passes every row as a separate
 * argument, and an array of a few hundred thousand exceeds the argument limit
 * of the engine: the call throws `RangeError`, the loader catches it as an
 * unreadable file, and every event in a large `.json` array disappears behind
 * a count. Appending in chunks has no such ceiling.
 */
export function appendBounded(
  target: LoadedEvent[],
  rows: readonly LoadedEvent[],
  limit: number,
): boolean {
  const room = Math.max(0, limit - target.length);
  const taken = Math.min(room, rows.length);

  for (let index = 0; index < taken; index += APPEND_CHUNK) {
    target.push(...rows.slice(index, Math.min(index + APPEND_CHUNK, taken)));
  }

  return taken < rows.length;
}

/**
 * Releases the file behind a line iterator that was abandoned before its end.
 *
 * `readTextFileLines` hands back an iterator with no `return()`, so leaving
 * its `for await` early — which is exactly what reaching the event ceiling
 * does — cannot tell it to clean up, and the file stays open in the Rust
 * process for the lifetime of the window. The iterator does carry the id of
 * the resource holding that file, and Tauri's core resource API closes a
 * resource by id; `core:default` already permits it, so releasing what
 * reading opened grants nothing wider than reading.
 *
 * Best effort by design: failing to close is not a reason to fail a load that
 * otherwise succeeded, and a plugin release that stops exposing the id leaves
 * behaviour exactly where it was before this existed. An iterator that ran to
 * its end has already released the file and reports no id, so this is a
 * no-op there.
 */
async function closeLineStream(lines: AsyncIterableIterator<string>): Promise<void> {
  const rid = (lines as AsyncIterableIterator<string> & { readonly rid?: unknown }).rid;
  if (typeof rid !== "number") {
    return;
  }
  try {
    await new Resource(rid).close();
  } catch {
    // Deliberately ignored: see above.
  }
}

/** Opens the native folder picker and returns the chosen path, or undefined if cancelled.
 *
 * `recursive: true` matters for security, not convenience: the dialog plugin
 * extends the fs scope with the picked path, and with this flag the grant
 * covers the whole picked tree — which is what lets the capabilities file
 * carry NO static path scope at all. */
export async function pickFolder(): Promise<string | undefined> {
  const selected = await open({ directory: true, multiple: false, recursive: true });
  return selected ?? undefined;
}

/**
 * Reads and parses every recognized file under `folder`.
 *
 * Bounded on purpose, and never silently: a file declined for its size, a
 * directory that could not be listed, a directory deliberately not walked and
 * a load stopped at the event ceiling all appear in the summary.
 */
export async function loadFolder(
  folder: string,
  limits: LoadLimits = DEFAULT_LOAD_LIMITS,
): Promise<{ events: LoadedEvent[]; summary: LoadSummary }> {
  const walk: Walk = { files: [], directoriesSkipped: [], directoriesFailed: [] };
  await walkFolder(folder, limits, walk);

  // A subdirectory that cannot be listed is part of a load; the picked folder
  // failing to list is a load that did not happen. Saying so plainly beats an
  // empty table with a note underneath it.
  const rootFailure = walk.directoriesFailed.find((notice) => notice.path === folder);
  if (rootFailure !== undefined) {
    throw new Error(rootFailure.reason);
  }

  const events: LoadedEvent[] = [];
  const filesFailed: PathNotice[] = [];
  const filesSkipped: PathNotice[] = [];

  let filesRead = 0;
  let sinceYield = 0;
  let truncated = false;

  for (const file of walk.files) {
    if (events.length >= limits.maxEvents) {
      truncated = true;
      break;
    }

    try {
      if (isJsonLines(file)) {
        const lines = await readTextFileLines(file);
        let lineNumber = 0;
        try {
          for await (const line of lines) {
            lineNumber += 1;
            if (events.length >= limits.maxEvents) {
              truncated = true;
              break;
            }
            const row = parseJsonLine(file, line, lineNumber);
            if (row !== undefined) {
              events.push(row);
            }
            sinceYield += 1;
            if (sinceYield >= YIELD_INTERVAL) {
              sinceYield = 0;
              await yieldToUi();
            }
          }
        } finally {
          await closeLineStream(lines);
        }
      } else {
        const { size } = await stat(file);
        if (size > limits.maxJsonBytes) {
          filesSkipped.push({
            path: file,
            reason: `${Math.round(size / 1024 / 1024)} MB exceeds the ${Math.round(limits.maxJsonBytes / 1024 / 1024)} MB limit for a single JSON document`,
          });
          continue;
        }
        const text = await readTextFile(file);
        // The document is parsed whole before the ceiling is applied: a JSON
        // document has no meaningful prefix, and the size limit above is what
        // bounds this branch. What the ceiling then decides is how much is
        // kept — and that a load which had to stop says so.
        if (appendBounded(events, parseFile(file, text), limits.maxEvents)) {
          truncated = true;
        }
        await yieldToUi();
      }
      filesRead += 1;
    } catch (cause) {
      filesFailed.push({ path: file, reason: (cause as Error).message });
    }
  }

  return {
    events,
    summary: {
      filesRead,
      filesFound: walk.files.length,
      filesFailed,
      filesSkipped,
      directoriesSkipped: walk.directoriesSkipped,
      directoriesFailed: walk.directoriesFailed,
      truncated,
      eventLimit: limits.maxEvents,
    },
  };
}

/**
 * Exports the given rows as JSON Lines through a native save dialog.
 *
 * Rows that could not be read as an event are skipped: there is nothing to
 * write for them. The rest are written exactly as they were parsed; nothing
 * is redacted, added or reformatted beyond one-line JSON serialisation.
 * Returns the number of events written, or undefined when the user cancelled
 * the dialog.
 */
export async function exportRows(rows: readonly LoadedEvent[]): Promise<number | undefined> {
  const exportable = rows.filter((row) => row.event !== null);

  const target = await save({
    defaultPath: "openaudit-export.jsonl",
    filters: [{ name: "JSON Lines", extensions: ["jsonl"] }],
  });
  if (target === null) {
    return undefined;
  }

  const text = exportable.map((row) => JSON.stringify(row.event)).join("\n") + "\n";
  await writeTextFile(target, text);
  return exportable.length;
}
