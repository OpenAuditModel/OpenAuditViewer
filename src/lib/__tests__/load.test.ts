/**
 * Loader tests.
 *
 * The Tauri fs plugin is replaced with an in-memory folder tree so that the
 * loader's own decisions — what it walks, what it declines, what it stops
 * short of, and what it says about each — are testable in the same run as the
 * rest of the suite, without a desktop build and without writing audit files
 * to disk. The bounds are passed in rather than defaulted so a test can reach
 * a ceiling without building a folder large enough to reach the real one.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

/** The fake filesystem, and what the loader did to it. Hoisted because
 * `vi.mock` factories run before the module body. */
const disk = vi.hoisted(() => ({
  /** Directory path → entries, as the fs plugin reports them. */
  directories: new Map<string, { name: string; isDirectory: boolean; isFile: boolean }[]>(),
  /** File path → contents. */
  files: new Map<string, string>(),
  /** Directories that throw when listed, and the message they throw. */
  unlistable: new Map<string, string>(),
  /** Files that throw when read, and the message they throw. */
  unreadable: new Map<string, string>(),
  /** Sizes reported by `stat`, when a test wants one bigger than the content. */
  sizes: new Map<string, number>(),
  /** Resource ids closed through Tauri's core resource API. */
  closed: [] as number[],
  /** Line iterators handed out, so a test can assert one was released. */
  streams: [] as { path: string; rid: number | null }[],
  nextRid: 1,
}));

function directory(name: string) {
  return { name, isDirectory: true, isFile: false };
}

function file(name: string) {
  return { name, isDirectory: false, isFile: true };
}

vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: vi.fn(),
  save: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  // Only the surface the loader uses: close by resource id.
  Resource: class {
    constructor(private readonly rid: number) {}
    async close(): Promise<void> {
      disk.closed.push(this.rid);
    }
  },
}));

vi.mock("@tauri-apps/plugin-fs", () => ({
  readDir: async (path: string) => {
    const failure = disk.unlistable.get(path);
    if (failure !== undefined) {
      throw new Error(failure);
    }
    const entries = disk.directories.get(path);
    if (entries === undefined) {
      throw new Error(`no such directory: ${path}`);
    }
    return entries;
  },
  readTextFile: async (path: string) => {
    const failure = disk.unreadable.get(path);
    if (failure !== undefined) {
      throw new Error(failure);
    }
    const contents = disk.files.get(path);
    if (contents === undefined) {
      throw new Error(`no such file: ${path}`);
    }
    return contents;
  },
  stat: async (path: string) => ({
    size: disk.sizes.get(path) ?? new TextEncoder().encode(disk.files.get(path) ?? "").byteLength,
  }),
  // Mirrors the plugin's own iterator, including the two properties this
  // matters for: it exposes the resource id holding the file, and it clears
  // that id only when iteration runs to the end. Nothing releases it when a
  // consumer stops early — which is the leak the loader has to close itself.
  readTextFileLines: async (path: string) => {
    const contents = disk.files.get(path);
    if (contents === undefined) {
      throw new Error(`no such file: ${path}`);
    }
    const lines = contents.split("\n");
    let index = 0;
    const stream = {
      path,
      rid: null as number | null,
      async next(): Promise<IteratorResult<string>> {
        if (stream.rid === null) {
          stream.rid = disk.nextRid++;
        }
        if (index >= lines.length) {
          stream.rid = null;
          return { value: undefined as unknown as string, done: true };
        }
        return { value: lines[index++] as string, done: false };
      },
      [Symbol.asyncIterator]() {
        return stream;
      },
    };
    disk.streams.push(stream);
    return stream;
  },
  writeTextFile: vi.fn(),
}));

import { DEFAULT_LOAD_LIMITS, appendBounded, loadFolder } from "../load";
import { parseFile } from "../parse";

function minimalEvent(id: string): Record<string, unknown> {
  return {
    specVersion: "0.1",
    id,
    time: "2026-03-14T11:47:52.108Z",
    event: { name: "configuration.setting.update", category: "configuration", outcome: "success" },
    actor: { type: "user", id: "user-1" },
    resource: { type: "configuration", id: "cfg-1" },
    application: { name: "test-app", environment: "production" },
  };
}

function eventJson(index: number): string {
  return JSON.stringify(minimalEvent(`018f1b70-2c18-7f3a-b46d-${String(index).padStart(12, "0")}`));
}

/** A JSON Lines file with `count` events, one per line. */
function jsonLines(count: number): string {
  return Array.from({ length: count }, (_unused, index) => eventJson(index + 1)).join("\n") + "\n";
}

/** A `.json` document holding an array of `count` events. */
function jsonArray(count: number): string {
  return `[${Array.from({ length: count }, (_unused, index) => eventJson(index + 1)).join(",")}]`;
}

/** Bounds small enough to reach in a test, over a folder small enough to read. */
const SMALL_LIMITS = { maxJsonBytes: 4096, maxEvents: 3, maxDirectoryDepth: 2 };

beforeEach(() => {
  disk.directories.clear();
  disk.files.clear();
  disk.unlistable.clear();
  disk.unreadable.clear();
  disk.sizes.clear();
  disk.closed.length = 0;
  disk.streams.length = 0;
  disk.nextRid = 1;
});

describe("loadFolder: walking a folder", () => {
  it("reads recognized files at every depth and ignores the rest", async () => {
    disk.directories.set("/logs", [file("a.json"), file("notes.txt"), directory("nested")]);
    disk.directories.set("/logs/nested", [file("b.jsonl"), file("c.ndjson")]);
    disk.files.set("/logs/a.json", eventJson(1));
    disk.files.set("/logs/nested/b.jsonl", jsonLines(1));
    disk.files.set("/logs/nested/c.ndjson", jsonLines(1));

    const { events, summary } = await loadFolder("/logs", DEFAULT_LOAD_LIMITS);

    expect(summary.filesFound).toBe(3);
    expect(summary.filesRead).toBe(3);
    expect(events).toHaveLength(3);
    expect(events.every((row) => row.valid)).toBe(true);
    expect(summary.truncated).toBe(false);
  });

  it("names a dependency directory it deliberately skipped", async () => {
    disk.directories.set("/logs", [file("a.json"), directory("node_modules")]);
    disk.directories.set("/logs/node_modules", [file("buried.json")]);
    disk.files.set("/logs/a.json", eventJson(1));
    disk.files.set("/logs/node_modules/buried.json", eventJson(2));

    const { events, summary } = await loadFolder("/logs", DEFAULT_LOAD_LIMITS);

    expect(events).toHaveLength(1);
    expect(summary.directoriesSkipped).toEqual([
      { path: "/logs/node_modules", reason: "dependency or build directory" },
    ]);
  });

  it("names a directory it stopped at for the depth limit", async () => {
    disk.directories.set("/logs", [directory("one")]);
    disk.directories.set("/logs/one", [directory("two")]);
    disk.directories.set("/logs/one/two", [directory("three")]);
    disk.directories.set("/logs/one/two/three", [file("deep.json")]);
    disk.files.set("/logs/one/two/three/deep.json", eventJson(1));

    const { events, summary } = await loadFolder("/logs", SMALL_LIMITS);

    expect(events).toHaveLength(0);
    expect(summary.directoriesSkipped).toEqual([
      { path: "/logs/one/two/three", reason: "deeper than the 2-directory limit" },
    ]);
  });

  it("fails outright when the picked folder itself cannot be listed", async () => {
    disk.unlistable.set("/logs", "permission denied");

    await expect(loadFolder("/logs", DEFAULT_LOAD_LIMITS)).rejects.toThrow("permission denied");
  });

  it("names a directory it could not list and loads the rest of the folder", async () => {
    disk.directories.set("/logs", [file("a.json"), directory("locked"), directory("open")]);
    disk.directories.set("/logs/open", [file("b.json")]);
    disk.unlistable.set("/logs/locked", "permission denied");
    disk.files.set("/logs/a.json", eventJson(1));
    disk.files.set("/logs/open/b.json", eventJson(2));

    const { events, summary } = await loadFolder("/logs", DEFAULT_LOAD_LIMITS);

    expect(events).toHaveLength(2);
    expect(summary.directoriesFailed).toEqual([
      { path: "/logs/locked", reason: "permission denied" },
    ]);
  });
});

describe("loadFolder: files it does not turn into events", () => {
  it("names a file it could not read, with the reason, and loads the rest", async () => {
    disk.directories.set("/logs", [file("broken.json"), file("fine.json")]);
    disk.files.set("/logs/broken.json", eventJson(1));
    disk.files.set("/logs/fine.json", eventJson(2));
    disk.unreadable.set("/logs/broken.json", "input/output error");

    const { events, summary } = await loadFolder("/logs", DEFAULT_LOAD_LIMITS);

    expect(events).toHaveLength(1);
    expect(summary.filesRead).toBe(1);
    expect(summary.filesFailed).toEqual([
      { path: "/logs/broken.json", reason: "input/output error" },
    ]);
  });

  it("declines a JSON document larger than the size limit before reading it", async () => {
    disk.directories.set("/logs", [file("huge.json")]);
    disk.files.set("/logs/huge.json", eventJson(1));
    disk.sizes.set("/logs/huge.json", 64 * 1024 * 1024);

    const { events, summary } = await loadFolder("/logs", DEFAULT_LOAD_LIMITS);

    expect(events).toHaveLength(0);
    expect(summary.filesSkipped[0]?.path).toBe("/logs/huge.json");
    expect(summary.filesSkipped[0]?.reason).toBe(
      "64 MB exceeds the 32 MB limit for a single JSON document",
    );
  });
});

describe("loadFolder: the event ceiling", () => {
  it("stops inside a single JSON document rather than overshooting it", async () => {
    disk.directories.set("/logs", [file("many.json")]);
    disk.files.set("/logs/many.json", jsonArray(10));

    const { events, summary } = await loadFolder("/logs", SMALL_LIMITS);

    expect(events).toHaveLength(SMALL_LIMITS.maxEvents);
    expect(summary.truncated).toBe(true);
    expect(summary.eventLimit).toBe(SMALL_LIMITS.maxEvents);
  });

  it("stops inside a JSON Lines file and releases the file it stopped reading", async () => {
    disk.directories.set("/logs", [file("many.jsonl")]);
    disk.files.set("/logs/many.jsonl", jsonLines(10));

    const { events, summary } = await loadFolder("/logs", SMALL_LIMITS);

    expect(events).toHaveLength(SMALL_LIMITS.maxEvents);
    expect(summary.truncated).toBe(true);
    // The iterator was abandoned mid-file, so its resource id is still set —
    // and the loader closed it rather than leaving the file open.
    expect(disk.closed).toHaveLength(1);
    expect(disk.streams[0]?.rid).toBe(disk.closed[0]);
  });

  it("closes nothing when a JSON Lines file is read to its end", async () => {
    disk.directories.set("/logs", [file("small.jsonl")]);
    disk.files.set("/logs/small.jsonl", jsonLines(2));

    const { events } = await loadFolder("/logs", DEFAULT_LOAD_LIMITS);

    expect(events).toHaveLength(2);
    // The iterator released the file itself when it ran out of lines; there is
    // no id left to close, and the loader must not invent one.
    expect(disk.streams[0]?.rid).toBeNull();
    expect(disk.closed).toEqual([]);
  });

  // The regression this whole group exists for. A `.json` array of a few
  // hundred thousand entries used to be appended with `push(...rows)`, which
  // threw RangeError; the loader caught it as an unreadable file and every
  // event in it disappeared behind a count. The rows here are strings rather
  // than events so that the test measures the append, not the validator.
  it("keeps what fits of a JSON array too large to append in one call", async () => {
    disk.directories.set("/logs", [file("many.json")]);
    disk.files.set("/logs/many.json", JSON.stringify(Array.from({ length: 300_000 }, () => "x")));

    const { events, summary } = await loadFolder("/logs", {
      ...DEFAULT_LOAD_LIMITS,
      maxEvents: 200_000,
    });

    expect(events).toHaveLength(200_000);
    expect(summary.filesFailed).toEqual([]);
    expect(summary.truncated).toBe(true);
  });

  it("does not open a further file once the ceiling is reached", async () => {
    disk.directories.set("/logs", [file("a.json"), file("b.json")]);
    disk.files.set("/logs/a.json", jsonArray(3));
    disk.files.set("/logs/b.json", jsonArray(3));

    const { events, summary } = await loadFolder("/logs", SMALL_LIMITS);

    expect(events).toHaveLength(3);
    expect(summary.filesRead).toBe(1);
    expect(summary.filesFound).toBe(2);
    expect(summary.truncated).toBe(true);
  });
});

describe("appendBounded", () => {
  // The regression this exists for: `push(...rows)` with an array this long
  // throws RangeError, and the loader then reported a whole file as unreadable.
  const enormous = parseFile("many.json", jsonArray(1)).flatMap((row) =>
    Array.from({ length: 300_000 }, () => row),
  );

  it("appends an array too long to pass as arguments in one call", () => {
    const target: typeof enormous = [];

    expect(appendBounded(target, enormous, 500_000)).toBe(false);
    expect(target).toHaveLength(enormous.length);
  });

  it("stops at the limit and reports that it left rows behind", () => {
    const target: typeof enormous = [];

    expect(appendBounded(target, enormous, 1_000)).toBe(true);
    expect(target).toHaveLength(1_000);
  });

  it("reports nothing left behind when everything fits", () => {
    const rows = parseFile("few.json", jsonArray(2));
    const target: typeof rows = [];

    expect(appendBounded(target, rows, 10)).toBe(false);
    expect(target).toHaveLength(2);
  });

  it("takes nothing when the target is already full", () => {
    const rows = parseFile("few.json", jsonArray(2));
    const target = parseFile("full.json", jsonArray(2));

    expect(appendBounded(target, rows, 2)).toBe(true);
    expect(target).toHaveLength(2);
  });
});
