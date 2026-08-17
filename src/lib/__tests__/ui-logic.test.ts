/**
 * Tests for the logic behind the interface: what the table shows, and where
 * the flow map puts things. Both were extracted out of components so they
 * could be checked here rather than by clicking.
 */
import { describe, expect, it } from "vitest";
import { ANY, EMPTY_FILTER, applicationOptions, filterEvents, outcomeOptions } from "../filter";
import {
  MARGIN_X,
  MARGIN_Y,
  COLUMN_GAP,
  ROW_GAP,
  NODE_R,
  buildNodePositions,
  clampPosition,
  computeViewSize,
  edgeGeometry,
  edgeWidth,
  healthColor,
  mergePositions,
} from "../flow-layout";
import type { FlowTopology } from "../trace";
import { displayPath } from "../paths";
import { filesNeverOpened } from "../summary";
import type { LoadedEvent, LoadSummary } from "../types";

function row(overrides: Partial<LoadedEvent>): LoadedEvent {
  return {
    rowId: "r1",
    sourceFile: "a.jsonl",
    sourceFormat: "jsonl",
    event: {},
    valid: true,
    errors: [],
    privacyFindings: [],
    ...overrides,
  } as LoadedEvent;
}

const NO_BOOKMARKS: ReadonlySet<string> = new Set();

describe("event filtering", () => {
  const events = [
    row({
      rowId: "a",
      applicationName: "payments",
      outcome: "success",
      eventName: "payment.capture",
      valid: true,
    }),
    row({
      rowId: "b",
      applicationName: "gateway",
      outcome: "failure",
      eventName: "route.forward",
      valid: true,
    }),
    row({
      rowId: "c",
      applicationName: "payments",
      outcome: "success",
      eventName: "login",
      valid: false,
    }),
  ];

  it("returns everything when nothing is set", () => {
    expect(filterEvents(events, EMPTY_FILTER, NO_BOOKMARKS)).toHaveLength(3);
  });

  it("filters by application, outcome and validity independently", () => {
    expect(
      filterEvents(events, { ...EMPTY_FILTER, application: "payments" }, NO_BOOKMARKS).map(
        (r) => r.rowId,
      ),
    ).toEqual(["a", "c"]);
    expect(
      filterEvents(events, { ...EMPTY_FILTER, outcome: "failure" }, NO_BOOKMARKS).map(
        (r) => r.rowId,
      ),
    ).toEqual(["b"]);
    expect(
      filterEvents(events, { ...EMPTY_FILTER, validity: "invalid" }, NO_BOOKMARKS).map(
        (r) => r.rowId,
      ),
    ).toEqual(["c"]);
  });

  it("treats the ANY sentinel as no restriction", () => {
    expect(filterEvents(events, { ...EMPTY_FILTER, application: ANY }, NO_BOOKMARKS)).toHaveLength(
      3,
    );
  });

  it("searches case-insensitively across the fields the table shows", () => {
    expect(
      filterEvents(events, { ...EMPTY_FILTER, search: "  PAYMENT.cap " }, NO_BOOKMARKS).map(
        (r) => r.rowId,
      ),
    ).toEqual(["a"]);
  });

  it("does not match on fields the table does not display", () => {
    const hidden = [row({ rowId: "h", sourceFile: "secret-folder/x.jsonl", eventName: "e" })];
    expect(filterEvents(hidden, { ...EMPTY_FILTER, search: "secret" }, NO_BOOKMARKS)).toHaveLength(
      0,
    );
  });

  it("restricts to bookmarks only when asked", () => {
    const bookmarks = new Set(["b"]);
    expect(filterEvents(events, EMPTY_FILTER, bookmarks)).toHaveLength(3);
    expect(
      filterEvents(events, { ...EMPTY_FILTER, bookmarkedOnly: true }, bookmarks).map(
        (r) => r.rowId,
      ),
    ).toEqual(["b"]);
  });

  it("offers each distinct option once, sorted", () => {
    expect(applicationOptions(events)).toEqual(["gateway", "payments"]);
    expect(outcomeOptions(events)).toEqual(["failure", "success"]);
  });
});

describe("flow map layout", () => {
  function topology(apps: { name: string; depth: number }[]): FlowTopology {
    return {
      apps: apps.map((app) => ({ ...app, events: 1, failures: 0 })),
      edges: [],
    };
  }

  it("places applications left to right by depth", () => {
    const positions = buildNodePositions(
      topology([
        { name: "a", depth: 0 },
        { name: "b", depth: 1 },
      ]),
    );
    expect(positions.get("a")?.x).toBe(MARGIN_X);
    expect(positions.get("b")?.x).toBe(MARGIN_X + COLUMN_GAP);
  });

  it("dense-ranks depths so a skipped depth leaves no empty column", () => {
    const positions = buildNodePositions(
      topology([
        { name: "a", depth: 0 },
        { name: "b", depth: 1 },
        { name: "c", depth: 3 },
      ]),
    );
    expect(positions.get("c")?.x).toBe(MARGIN_X + 2 * COLUMN_GAP);
  });

  it("staggers odd columns so horizontal edges do not overlap", () => {
    const positions = buildNodePositions(
      topology([
        { name: "a", depth: 0 },
        { name: "b", depth: 1 },
      ]),
    );
    expect(positions.get("a")?.y).toBe(MARGIN_Y);
    expect(positions.get("b")?.y).toBe(MARGIN_Y + ROW_GAP / 2);
  });

  it("lets a hand-placed position win over the computed one", () => {
    const automatic = new Map([["a", { x: 1, y: 2 }]]);
    expect(mergePositions(automatic, { a: { x: 50, y: 60 } }).get("a")).toEqual({ x: 50, y: 60 });
    expect(mergePositions(automatic, {}).get("a")).toEqual({ x: 1, y: 2 });
  });

  // An application may legally be called "constructor": the name comes from a
  // file. A plain `overrides[name] !== undefined` check would return an
  // inherited function here and place the node at undefined coordinates.
  it("ignores inherited object members when a name collides with one", () => {
    const automatic = new Map([["constructor", { x: 7, y: 8 }]]);
    expect(mergePositions(automatic, {}).get("constructor")).toEqual({ x: 7, y: 8 });
  });

  it("never lets the canvas be narrower than its container", () => {
    const positions = new Map([["a", { x: 100, y: 40 }]]);
    expect(computeViewSize(positions, 900).width).toBe(900);
    expect(computeViewSize(positions, 50).width).toBe(100 + MARGIN_X);
  });

  it("keeps a dragged node on the canvas", () => {
    expect(clampPosition(-500, -500)).toEqual({ x: NODE_R + 12, y: NODE_R + 12 });
    expect(clampPosition(99_999, 99_999)).toEqual({ x: 2400, y: 1400 });
  });

  it("grows edge width with volume but bounds it", () => {
    expect(edgeWidth(1)).toBeLessThan(edgeWidth(10));
    expect(edgeWidth(10_000)).toBeLessThanOrEqual(4);
  });

  it("colours a node by failure ratio", () => {
    expect(healthColor(0, 10)).toBe("var(--ok)");
    expect(healthColor(1, 10)).toBe("var(--warn)");
    expect(healthColor(5, 10)).toBe("var(--bad)");
  });

  it("routes a backward edge below both nodes so it does not retrace the forward path", () => {
    const from = { x: 300, y: 100 };
    const to = { x: 100, y: 100 };
    const backward = edgeGeometry(from, to, true);
    const forward = edgeGeometry(to, from, false);
    expect(backward.mid.y).toBeGreaterThan(from.y);
    expect(forward.mid.y).toBeLessThan(from.y);
  });
});

describe("paths shown in load notices", () => {
  it("shows a path inside the opened folder relative to it", () => {
    expect(displayPath("/logs/nested/events.jsonl", "/logs")).toBe("nested/events.jsonl");
    // Backslashes doubled deliberately: the separator under test is a single
    // backslash, and "D:\logs" would reach displayPath as "D:logs".
    expect(displayPath("D:\\logs\\nested\\events.jsonl", "D:\\logs")).toBe("nested\\events.jsonl");
  });

  it("leaves a path outside the opened folder, or with no folder, as it is", () => {
    expect(displayPath("/elsewhere/a.json", "/logs")).toBe("/elsewhere/a.json");
    expect(displayPath("/logs/a.json")).toBe("/logs/a.json");
  });

  // The folder itself is what failed — a relative path would be the empty
  // string, which names nothing.
  it("keeps the folder's own path when the folder is the subject", () => {
    expect(displayPath("/logs", "/logs")).toBe("/logs");
  });
});

describe("files a load never opened", () => {
  const summary = (overrides: Partial<LoadSummary>): LoadSummary => ({
    filesRead: 0,
    filesFound: 0,
    filesFailed: [],
    filesSkipped: [],
    directoriesSkipped: [],
    directoriesFailed: [],
    truncated: false,
    eventLimit: 100_000,
    ...overrides,
  });

  it("counts the files left after a load stopped at the ceiling", () => {
    expect(filesNeverOpened(summary({ filesFound: 12, filesRead: 3, truncated: true }))).toBe(9);
  });

  it("does not count a declined or unreadable file as one it never opened", () => {
    const stopped = summary({
      filesFound: 5,
      filesRead: 1,
      filesSkipped: [{ path: "/logs/big.json", reason: "too large" }],
      filesFailed: [{ path: "/logs/bad.json", reason: "input/output error" }],
      truncated: true,
    });
    expect(filesNeverOpened(stopped)).toBe(2);
  });

  it("is zero for a load that read everything it found", () => {
    expect(filesNeverOpened(summary({ filesFound: 4, filesRead: 4 }))).toBe(0);
  });
});
