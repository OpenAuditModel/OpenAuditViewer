/**
 * Folder picking and file reading, via Tauri's dialog and fs plugins.
 *
 * Reading happens through the OS-native APIs those plugins wrap, not a
 * browser file input, so a whole folder tree can be walked without a user
 * having to multi-select five hundred files by hand.
 */
import { open, save } from "@tauri-apps/plugin-dialog";
import {
  readDir,
  readTextFile,
  readTextFileLines,
  stat,
  writeTextFile,
} from "@tauri-apps/plugin-fs";
import { isJsonLines, parseFile, parseJsonLine } from "./parse";
import type { LoadedEvent, LoadSummary } from "./types";

const RECOGNIZED_EXTENSIONS = [".json", ".jsonl", ".ndjson"];

/**
 * Largest `.json` document read.
 *
 * A JSON document has to be parsed whole — there is no meaningful prefix of
 * one — so its size is the memory it costs, and the only defence is to
 * decline before reading. JSON Lines files have no such limit: they are
 * streamed a line at a time and bounded by the event ceiling below instead.
 */
const MAX_JSON_BYTES = 32 * 1024 * 1024;

/**
 * Ceiling on events held at once, across the whole folder.
 *
 * This is a viewer: everything it has read stays in memory so it can be
 * sorted, filtered and cross-referenced. Without a ceiling, a folder large
 * enough — by accident or on purpose — exhausts the webview and takes the
 * window with it. Stopping and saying so is the lesser failure, and the
 * summary reports it rather than quietly showing a subset.
 */
const MAX_EVENTS = 100_000;

/** Events parsed between yields, so the window can still paint while loading. */
const YIELD_INTERVAL = 2_000;

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

/** Deepest directory nesting followed. Bounds the walk against symlink
 * cycles and pathological trees; a legitimate log archive does not sit 32
 * directories deep. */
const MAX_DIRECTORY_DEPTH = 32;

/** Lists every recognized file under `root`, recursing into subdirectories. */
async function listFiles(root: string, depth = 0): Promise<string[]> {
  if (depth > MAX_DIRECTORY_DEPTH) {
    return [];
  }
  const entries = await readDir(root);
  const files: string[] = [];

  for (const entry of entries) {
    if (entry.isDirectory && SKIPPED_DIRECTORIES.has(entry.name)) {
      continue;
    }
    const path = `${root}/${entry.name}`;
    if (entry.isDirectory) {
      files.push(...(await listFiles(path, depth + 1)));
    } else if (isRecognized(entry.name)) {
      files.push(path);
    }
  }

  return files;
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
 * Bounded on purpose, and never silently: a file declined for its size and a
 * load stopped at the event ceiling both appear in the summary, because a
 * viewer that shows part of a folder without saying so is worse than one
 * that refuses to open it.
 */
export async function loadFolder(
  folder: string,
): Promise<{ events: LoadedEvent[]; summary: LoadSummary }> {
  const files = await listFiles(folder);
  const events: LoadedEvent[] = [];
  const filesFailed: { file: string; reason: string }[] = [];
  const filesSkipped: { file: string; reason: string }[] = [];

  let filesRead = 0;
  let sinceYield = 0;
  let truncated = false;

  for (const file of files) {
    if (events.length >= MAX_EVENTS) {
      truncated = true;
      break;
    }

    try {
      if (isJsonLines(file)) {
        let lineNumber = 0;
        for await (const line of await readTextFileLines(file)) {
          lineNumber += 1;
          if (events.length >= MAX_EVENTS) {
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
      } else {
        const { size } = await stat(file);
        if (size > MAX_JSON_BYTES) {
          filesSkipped.push({
            file,
            reason: `${Math.round(size / 1024 / 1024)} MB exceeds the ${MAX_JSON_BYTES / 1024 / 1024} MB limit for a single JSON document`,
          });
          continue;
        }
        const text = await readTextFile(file);
        events.push(...parseFile(file, text));
        await yieldToUi();
      }
      filesRead += 1;
    } catch (cause) {
      filesFailed.push({ file, reason: (cause as Error).message });
    }
  }

  return {
    events,
    summary: {
      filesRead,
      filesFound: files.length,
      filesFailed,
      filesSkipped,
      truncated,
      eventLimit: MAX_EVENTS,
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
