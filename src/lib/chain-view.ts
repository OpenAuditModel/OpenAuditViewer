/**
 * What the chain picture draws, derived from what chain verification found.
 *
 * Nothing here judges anything. Every mark on the picture is a finding or a
 * note the chain engine already produced, placed at the member it names, in
 * the order the engine checked the links. A chain the engine calls intact
 * cannot be drawn with a break, and a break cannot be drawn anywhere the
 * engine did not report one.
 *
 * Long healthy stretches are folded into a single run so that a chain of
 * thousands of events draws in a line: every member with a finding is shown on
 * its own, with the member before it — a broken link is a relation between two
 * events, and showing only one of them would not say which pair disagrees.
 */
import type { ChainVerificationResult, Finding } from "./integrity/types";

/** How a member's own link to the member before it stands. `unchecked`: the
 * member before it is outside the window that was read. */
export type LinkState = "start" | "valid" | "broken" | "missing" | "unchecked";

export interface ChainViewEvent {
  readonly type: "event";
  readonly label: string;
  readonly sequence: number;
  readonly linkIn: LinkState;
  /** Findings about this event itself: its digest, its signature, its link. */
  readonly problems: readonly Finding[];
  /** Another member of this chain declares the same sequence. */
  readonly duplicate: boolean;
}

export interface ChainViewRun {
  readonly type: "run";
  /** Members folded into this run. Every one verified, and every link into one held. */
  readonly count: number;
  readonly firstSequence: number;
  readonly lastSequence: number;
}

export interface ChainViewGap {
  readonly type: "gap";
  /** The first and last sequence number absent between two members. */
  readonly from: number;
  readonly to: number;
}

export type ChainViewItem = ChainViewEvent | ChainViewRun | ChainViewGap;

export interface ChainView {
  readonly items: readonly ChainViewItem[];
  /** The first member declares a `previousHash`: the set begins mid-chain. */
  readonly startsMidChain: boolean;
  /** Findings that name no single member, such as mixed hash algorithms. */
  readonly chainFindings: readonly Finding[];
  /** Members with no sequence, which cannot be placed on the line at all. */
  readonly unsequenced: readonly string[];
}

/** Shorter than this, a healthy stretch is drawn member by member. */
const SMALLEST_RUN = 3;

const LINK_KINDS = new Set(["broken-link", "previous-hash-missing", "link-outside-window"]);

/**
 * One word for a chain: intact, broken, or — for a window read from a stream,
 * when the only findings are links to events outside it — not fully checked.
 * Unassigned members (schema-invalid events declaring the chain) make a chain
 * broken, as they do everywhere: nothing about them was verified.
 */
export type ChainVerdict = "intact" | "unchecked" | "broken";

export function chainVerdict(
  result: Pick<ChainVerificationResult, "intact" | "findings">,
  unassigned = 0,
): ChainVerdict {
  if (result.intact && unassigned === 0) {
    return "intact";
  }
  const windowOnly =
    unassigned === 0 &&
    result.findings.length > 0 &&
    result.findings.every((finding) => finding.kind === "link-outside-window");
  return windowOnly ? "unchecked" : "broken";
}

export function buildChainView(result: ChainVerificationResult): ChainView {
  const order = result.order;
  const byLabel = new Map<string, Finding[]>();
  const chainFindings: Finding[] = [];
  for (const finding of result.findings) {
    // Duplicate sequences name their members in `detail`, not `label`; they are
    // drawn as a mark on each member rather than listed as a chain finding.
    if (finding.kind === "duplicate-sequence") {
      continue;
    }
    if (finding.label === undefined) {
      chainFindings.push(finding);
      continue;
    }
    const list = byLabel.get(finding.label) ?? [];
    list.push(finding);
    byLabel.set(finding.label, list);
  }

  const sequenceCounts = new Map<number, number>();
  for (const position of order) {
    sequenceCounts.set(position.sequence, (sequenceCounts.get(position.sequence) ?? 0) + 1);
  }

  const members: ChainViewEvent[] = order.map((position, index) => {
    const problems = byLabel.get(position.label) ?? [];
    const linkFinding = problems.find((finding) => LINK_KINDS.has(finding.kind));
    const linkIn: LinkState =
      index === 0
        ? "start"
        : linkFinding === undefined
          ? "valid"
          : linkFinding.kind === "broken-link"
            ? "broken"
            : linkFinding.kind === "link-outside-window"
              ? "unchecked"
              : "missing";
    return {
      type: "event",
      label: position.label,
      sequence: position.sequence,
      linkIn,
      problems,
      duplicate: (sequenceCounts.get(position.sequence) ?? 0) > 1,
    };
  });

  const notable = members.map(
    (member, index) =>
      index === 0 || index === members.length - 1 || member.problems.length > 0 || member.duplicate,
  );
  const shown = notable.map((isNotable, index) => isNotable || notable[index + 1] === true);

  const items: ChainViewItem[] = [];
  let pending: ChainViewEvent[] = [];

  const flush = (): void => {
    if (pending.length >= SMALLEST_RUN) {
      items.push({
        type: "run",
        count: pending.length,
        firstSequence: (pending[0] as ChainViewEvent).sequence,
        lastSequence: (pending[pending.length - 1] as ChainViewEvent).sequence,
      });
    } else {
      items.push(...pending);
    }
    pending = [];
  };

  for (const [index, member] of members.entries()) {
    const previous = members[index - 1];
    if (previous !== undefined && member.sequence - previous.sequence > 1) {
      flush();
      items.push({ type: "gap", from: previous.sequence + 1, to: member.sequence - 1 });
    }
    if (shown[index]) {
      flush();
      items.push(member);
    } else {
      pending.push(member);
    }
  }
  flush();

  const startsMidChain = result.notes.some(
    (note) => note.message === "chain does not start at a genesis event",
  );

  return { items, startsMidChain, chainFindings, unsequenced: result.unsequenced };
}
