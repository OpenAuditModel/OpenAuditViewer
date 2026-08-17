/**
 * Groups loaded events into cross-application flows.
 *
 * This implements the first two tiers of the linking ladder from the design:
 *
 *  1. `request.traceId` — the strongest signal: a W3C trace id was written
 *     by the applications themselves, so membership is declared, not guessed.
 *  2. `request.correlationId` — an event without a traceId joins a trace
 *     group when its correlationId also appears inside that group (the id
 *     was propagated but the tracer wasn't); otherwise correlation-only
 *     events form their own group.
 *
 * Weaker tiers (shared chainId, same resource, same actor) are deliberately
 * not implemented: they link events that merely touch the same thing, and
 * presenting that as "the same flow" would overstate what the data says.
 *
 * Groups with a single event are dropped — a flow of one is not a flow.
 */
import type { LoadedEvent } from "./types";

export interface TraceMember {
  readonly row: LoadedEvent;
  /** Milliseconds since epoch; events without a parseable time sort first. */
  readonly timeMs: number;
  readonly application: string;
}

export interface TraceGroup {
  readonly key: string;
  readonly kind: "trace" | "correlation";
  /** Time-ordered. */
  readonly members: readonly TraceMember[];
  /** Applications in order of first appearance — the flow itself. */
  readonly applications: readonly string[];
  readonly startMs: number;
  readonly endMs: number;
  readonly hasFailure: boolean;
}

function requestField(row: LoadedEvent, field: "traceId" | "correlationId"): string | undefined {
  if (row.event === null) {
    return undefined;
  }
  const request = row.event["request"];
  if (request === null || typeof request !== "object" || Array.isArray(request)) {
    return undefined;
  }
  const value = (request as Record<string, unknown>)[field];
  return typeof value === "string" ? value : undefined;
}

function toMember(row: LoadedEvent): TraceMember {
  const parsed = row.time === undefined ? Number.NaN : Date.parse(row.time);
  return {
    row,
    timeMs: Number.isNaN(parsed) ? 0 : parsed,
    application: row.applicationName ?? "(unknown)",
  };
}

function finishGroup(key: string, kind: TraceGroup["kind"], members: TraceMember[]): TraceGroup {
  members.sort((left, right) =>
    left.timeMs === right.timeMs
      ? left.row.rowId.localeCompare(right.row.rowId, "en")
      : left.timeMs - right.timeMs,
  );

  const applications: string[] = [];
  for (const member of members) {
    if (!applications.includes(member.application)) {
      applications.push(member.application);
    }
  }

  return {
    key,
    kind,
    members,
    applications,
    startMs: members[0]?.timeMs ?? 0,
    endMs: members[members.length - 1]?.timeMs ?? 0,
    hasFailure: members.some((member) => member.row.outcome === "failure"),
  };
}

/** Builds all trace/correlation groups with at least two members. */
export function buildTraceGroups(events: readonly LoadedEvent[]): TraceGroup[] {
  const usable = events.filter((row) => row.valid && row.event !== null);

  const byTrace = new Map<string, TraceMember[]>();
  const correlationToTraces = new Map<string, Set<string>>();
  const withoutTrace: LoadedEvent[] = [];

  for (const row of usable) {
    const traceId = requestField(row, "traceId");
    if (traceId === undefined) {
      withoutTrace.push(row);
      continue;
    }
    const bucket = byTrace.get(traceId);
    if (bucket === undefined) {
      byTrace.set(traceId, [toMember(row)]);
    } else {
      bucket.push(toMember(row));
    }
    const correlationId = requestField(row, "correlationId");
    if (correlationId !== undefined) {
      const traces = correlationToTraces.get(correlationId);
      if (traces === undefined) {
        correlationToTraces.set(correlationId, new Set([traceId]));
      } else {
        traces.add(traceId);
      }
    }
  }

  const byCorrelation = new Map<string, TraceMember[]>();
  for (const row of withoutTrace) {
    const correlationId = requestField(row, "correlationId");
    if (correlationId === undefined) {
      continue;
    }
    // Merge into a trace group only when the correlationId points at exactly
    // one trace. A correlationId spanning several traces (an incident id
    // carried across hours of separate operations, say) makes the merge
    // ambiguous — picking one trace would be a guess presented as a fact, so
    // such events stay in their own correlation group instead.
    const traces = correlationToTraces.get(correlationId);
    if (traces !== undefined && traces.size === 1) {
      const [traceKey] = traces;
      byTrace.get(traceKey as string)?.push(toMember(row));
      continue;
    }
    const bucket = byCorrelation.get(correlationId);
    if (bucket === undefined) {
      byCorrelation.set(correlationId, [toMember(row)]);
    } else {
      bucket.push(toMember(row));
    }
  }

  const groups: TraceGroup[] = [];
  for (const [key, members] of byTrace) {
    if (members.length >= 2) {
      groups.push(finishGroup(key, "trace", members));
    }
  }
  for (const [key, members] of byCorrelation) {
    if (members.length >= 2) {
      groups.push(finishGroup(key, "correlation", members));
    }
  }

  groups.sort((left, right) => left.startMs - right.startMs);
  return groups;
}

/** The group a specific event belongs to, if any. */
export function findGroupForRow(
  groups: readonly TraceGroup[],
  rowId: string,
): TraceGroup | undefined {
  return groups.find((group) => group.members.some((member) => member.row.rowId === rowId));
}

/**
 * Collision-free identity for a group. The raw key alone is not unique: the
 * same identifier can appear as a traceId in some events and a
 * correlationId in others, producing two distinct groups with equal keys.
 */
export function groupIdentity(group: TraceGroup): string {
  return `${group.kind}:${group.key}`;
}

/**
 * Collision-free composite key for an application pair. No delimiter
 * character is safe against arbitrary names (the schema's identifier
 * pattern admits spaces, and control characters mid-string), so the pair is
 * encoded as a JSON array instead of concatenated.
 */
export function pairKey(from: string, to: string): string {
  return JSON.stringify([from, to]);
}

function parsePairKey(key: string): [string, string] {
  const [from = "", to = ""] = JSON.parse(key) as [string, string];
  return [from, to];
}

/** One application in the aggregated flow topology. */
export interface FlowApp {
  readonly name: string;
  /** Leftmost position this app was observed at across all flows: 0 = entry. */
  readonly depth: number;
  readonly events: number;
  readonly failures: number;
}

/** One observed transition between two applications, aggregated over all flows. */
export interface FlowEdge {
  readonly from: string;
  readonly to: string;
  readonly count: number;
  readonly failures: number;
  /** Median wall-clock gap between the two sides of the transition. */
  readonly medianDeltaMs: number;
}

export interface FlowTopology {
  readonly apps: readonly FlowApp[];
  readonly edges: readonly FlowEdge[];
}

function median(values: readonly number[]): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  const upper = sorted[middle] as number;
  if (sorted.length % 2 === 1) {
    return upper;
  }
  return ((sorted[middle - 1] as number) + upper) / 2;
}

/**
 * Builds the service topology of the flows given: which applications talk to
 * which, how often, how fast, and how healthily. An edge exists only where
 * two consecutive events of one flow sit in different applications — the map
 * states observed transitions, never inferred architecture.
 *
 * The viewer passes one flow, so every figure describes that flow. Passing
 * several aggregates them, which is why the numbers are counts and medians
 * rather than single observations.
 */
export function buildFlowTopology(groups: readonly TraceGroup[]): FlowTopology {
  const appStats = new Map<string, { depth: number; events: number; failures: number }>();
  const edgeStats = new Map<string, { count: number; failures: number; deltas: number[] }>();

  for (const group of groups) {
    for (const [index, application] of group.applications.entries()) {
      const entry = appStats.get(application);
      if (entry === undefined) {
        appStats.set(application, { depth: index, events: 0, failures: 0 });
      } else if (index < entry.depth) {
        entry.depth = index;
      }
    }

    for (const member of group.members) {
      const entry = appStats.get(member.application);
      if (entry !== undefined) {
        entry.events += 1;
        if (member.row.outcome === "failure") {
          entry.failures += 1;
        }
      }
    }

    for (let index = 1; index < group.members.length; index += 1) {
      const previous = group.members[index - 1];
      const current = group.members[index];
      if (previous === undefined || current === undefined) continue;
      if (previous.application === current.application) continue;

      const key = pairKey(previous.application, current.application);
      const entry = edgeStats.get(key) ?? { count: 0, failures: 0, deltas: [] };
      entry.count += 1;
      if (current.row.outcome === "failure") {
        entry.failures += 1;
      }
      entry.deltas.push(Math.max(0, current.timeMs - previous.timeMs));
      edgeStats.set(key, entry);
    }
  }

  const apps = [...appStats.entries()]
    .map(([name, entry]) => ({
      name,
      depth: entry.depth,
      events: entry.events,
      failures: entry.failures,
    }))
    .sort((left, right) => left.depth - right.depth || left.name.localeCompare(right.name, "en"));

  const edges = [...edgeStats.entries()].map(([key, entry]) => {
    const [from, to] = parsePairKey(key);
    return {
      from,
      to,
      count: entry.count,
      failures: entry.failures,
      medianDeltaMs: median(entry.deltas),
    };
  });

  return { apps, edges };
}

export function formatDuration(milliseconds: number): string {
  if (milliseconds < 1000) {
    return `${milliseconds} ms`;
  }
  if (milliseconds < 60_000) {
    return `${(milliseconds / 1000).toFixed(1)} s`;
  }
  const minutes = Math.floor(milliseconds / 60_000);
  const seconds = Math.round((milliseconds % 60_000) / 1000);
  if (minutes < 60) {
    return `${minutes} m ${String(seconds).padStart(2, "0")} s`;
  }
  const hours = Math.floor(minutes / 60);
  return `${hours} h ${String(minutes % 60).padStart(2, "0")} m`;
}

/** Clock part of an ISO timestamp, for compact display. */
export function clockTime(iso: string | undefined): string {
  if (iso === undefined) {
    return "—";
  }
  const tIndex = iso.indexOf("T");
  if (tIndex === -1) {
    return iso;
  }
  return iso.slice(tIndex + 1).replace(/(\.\d{3})\d*(Z|[+-].*)?$/, "$1");
}
