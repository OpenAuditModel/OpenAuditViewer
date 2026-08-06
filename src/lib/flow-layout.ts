/**
 * Geometry for the flow map: where nodes sit and how edges curve between
 * them.
 *
 * Pure arithmetic, kept out of the component so it can be reasoned about and
 * tested without rendering an SVG. The component decides what to draw; this
 * decides where.
 */
import type { FlowTopology } from "./trace";

export interface NodePosition {
  readonly x: number;
  readonly y: number;
}

export const COLUMN_GAP = 190;
export const ROW_GAP = 96;
export const MARGIN_X = 80;
export const MARGIN_Y = 56;
export const NODE_R = 22;

/** Furthest a node may be dragged, so a stray gesture cannot send it off into empty canvas. */
export const MAX_X = 2400;
export const MAX_Y = 1400;

/**
 * Left-to-right by observed depth: entry applications first, downstream
 * ones after.
 *
 * Depths are dense-ranked before use. A flow whose applications sit at
 * depths 0, 1 and 3 would otherwise leave an empty column where 2 should
 * have been, which reads as a missing participant rather than as a gap in
 * the numbering.
 */
export function buildNodePositions(topology: FlowTopology): Map<string, NodePosition> {
  const depthRank = new Map<number, number>();
  for (const depth of [...new Set(topology.apps.map((app) => app.depth))].sort((a, b) => a - b)) {
    depthRank.set(depth, depthRank.size);
  }

  const byColumn = new Map<number, string[]>();
  for (const app of topology.apps) {
    const column = depthRank.get(app.depth) ?? 0;
    const entries = byColumn.get(column);
    if (entries === undefined) {
      byColumn.set(column, [app.name]);
    } else {
      entries.push(app.name);
    }
  }

  const positions = new Map<string, NodePosition>();
  for (const [column, names] of byColumn) {
    for (const [rowIndex, name] of names.entries()) {
      positions.set(name, {
        x: MARGIN_X + column * COLUMN_GAP,
        // Stagger odd columns half a row so horizontal edges don't overlap.
        y: MARGIN_Y + rowIndex * ROW_GAP + (column % 2 === 1 ? ROW_GAP / 2 : 0),
      });
    }
  }
  return positions;
}

/**
 * Hand-dragged positions win over the computed layout.
 *
 * The own-property check is load-bearing: application names come from
 * untrusted files, and `overrides["constructor"]` would otherwise return an
 * inherited function that passes an undefined check and puts a node at
 * coordinates of `undefined`.
 */
export function mergePositions(
  automatic: ReadonlyMap<string, NodePosition>,
  overrides: Readonly<Record<string, NodePosition>>,
): Map<string, NodePosition> {
  const merged = new Map<string, NodePosition>();
  for (const [name, position] of automatic) {
    merged.set(name, Object.hasOwn(overrides, name) ? (overrides[name] as NodePosition) : position);
  }
  return merged;
}

/** Canvas size: never narrower than the container, so its left edge is the container's. */
export function computeViewSize(
  positions: ReadonlyMap<string, NodePosition>,
  containerWidth: number,
): { width: number; height: number } {
  let maxX = 0;
  let maxY = 0;
  for (const position of positions.values()) {
    maxX = Math.max(maxX, position.x);
    maxY = Math.max(maxY, position.y);
  }
  return {
    width: Math.max(maxX + MARGIN_X, containerWidth),
    height: maxY + MARGIN_Y + 26,
  };
}

/** Keeps a dragged node on the canvas. */
export function clampPosition(x: number, y: number): NodePosition {
  return {
    x: Math.min(MAX_X, Math.max(NODE_R + 12, x)),
    y: Math.min(MAX_Y, Math.max(NODE_R + 12, y)),
  };
}

/** Thickness grows with volume, but logarithmically: one busy edge should not drown the rest. */
export function edgeWidth(count: number): number {
  return Math.min(4, 1.2 + Math.log2(count + 1));
}

/** Green while nothing failed, red once failures dominate, amber in between. */
export function healthColor(failures: number, events: number): string {
  if (failures === 0) {
    return "var(--ok)";
  }
  return failures / Math.max(1, events) >= 0.2 ? "var(--bad)" : "var(--warn)";
}

/**
 * The cubic an edge follows, plus the midpoint its label sits on.
 *
 * A backward edge dips below both nodes instead of retracing the forward
 * path, so a request and its response read as a loop rather than as one
 * doubled line.
 */
export function edgeGeometry(
  from: NodePosition,
  to: NodePosition,
  backward: boolean,
): { path: string; mid: NodePosition } {
  if (backward) {
    const dip = Math.max(from.y, to.y) + 52;
    const path = `M ${from.x} ${from.y + NODE_R} C ${from.x} ${dip}, ${to.x} ${dip}, ${to.x} ${to.y + NODE_R}`;
    return { path, mid: { x: (from.x + to.x) / 2, y: dip - 8 } };
  }

  const x1 = from.x + NODE_R + 3;
  const x2 = to.x - NODE_R - 9;
  const bend = Math.min(70, Math.abs(x2 - x1) * 0.4);
  const path = `M ${x1} ${from.y} C ${x1 + bend} ${from.y}, ${x2 - bend} ${to.y}, ${x2} ${to.y}`;
  return {
    path,
    mid: {
      x: (x1 + 3 * (x1 + bend) + 3 * (x2 - bend) + x2) / 8,
      y: (from.y * 4 + to.y * 4) / 8 - 8,
    },
  };
}
