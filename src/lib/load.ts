/**
 * Folder picking and file reading, via Tauri's dialog and fs plugins.
 *
 * Reading happens through the OS-native APIs those plugins wrap, not a
 * browser file input, so a whole folder tree can be walked without a user
 * having to multi-select five hundred files by hand.
 */
import { open, save } from "@tauri-apps/plugin-dialog";
import { readDir, readTextFile, writeTextFile } from "@tauri-apps/plugin-fs";
import { parseFile } from "./parse";
import type { LoadedEvent, LoadSummary } from "./types";

const RECOGNIZED_EXTENSIONS = [".json", ".jsonl", ".ndjson"];

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

/** Reads and parses every recognized file under `folder`. */
export async function loadFolder(
  folder: string,
): Promise<{ events: LoadedEvent[]; summary: LoadSummary }> {
  const files = await listFiles(folder);
  const events: LoadedEvent[] = [];
  const filesFailed: { file: string; reason: string }[] = [];

  for (const file of files) {
    try {
      const text = await readTextFile(file);
      events.push(...parseFile(file, text));
    } catch (cause) {
      filesFailed.push({ file, reason: (cause as Error).message });
    }
  }

  return { events, summary: { filesRead: files.length, filesFailed } };
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
