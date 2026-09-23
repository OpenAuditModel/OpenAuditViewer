/**
 * The chain picture draws what chain verification found, where it found it.
 *
 * Every chain here is sealed for real and verified by the chain engine; the
 * tests assert on the view built from that verdict, never on a verdict made
 * up for the test. A picture that could disagree with the engine would be the
 * app inventing a verdict of its own.
 */
import { describe, expect, it } from "vitest";
import { buildChainView, type ChainViewEvent, type ChainViewItem } from "../chain-view";
import { calculateDigest } from "../integrity/digest";
import { verifyChains } from "../integrity/chain";

type Event = Record<string, unknown>;

async function sealedChain(count: number, chainId = "chain-view-1"): Promise<Event[]> {
  return sealedLine(
    Array.from({ length: count }, (_, index) => index + 1),
    chainId,
  );
}

/**
 * Seals events with the given sequence numbers, each linked to the one before
 * it in the array — so a sequence may repeat without any link breaking.
 */
async function sealedLine(
  sequences: readonly number[],
  chainId = "chain-view-1",
): Promise<Event[]> {
  const events: Event[] = [];
  let previousHash: string | undefined;
  for (const [index, sequence] of sequences.entries()) {
    const event: Event = {
      specVersion: "0.1",
      id: `018f1b70-2c18-7f3a-b46d-${String(index + 1).padStart(12, "0")}`,
      time: "2026-09-23T10:00:00.000Z",
      sequence,
      event: { name: "data.record.update", category: "data-modification", outcome: "success" },
      actor: { type: "user", id: "user-1" },
      resource: { type: "record", id: `record-${sequence}` },
      application: { name: "chain-view-test", environment: "test" },
      integrity: {
        canonicalization: "RFC8785",
        hashAlgorithm: "SHA-256",
        hash: "",
        ...(previousHash === undefined ? {} : { previousHash }),
        chainId,
      },
    };
    const hash = await calculateDigest(event, "SHA-256");
    (event["integrity"] as Record<string, unknown>)["hash"] = hash;
    previousHash = hash;
    events.push(event);
  }
  return events;
}

async function viewOf(events: readonly Event[]) {
  const report = await verifyChains(
    events.map((event) => ({ label: `row-${String(event["id"])}`, event })),
  );
  const chain = report.chains[0];
  if (chain === undefined) throw new Error("no chain");
  return { chain, view: buildChainView(chain) };
}

function describeItems(items: readonly ChainViewItem[]): string[] {
  return items.map((item) =>
    item.type === "event"
      ? `#${item.sequence}${item.problems.length > 0 ? "!" : ""}${item.linkIn === "broken" ? " (broken in)" : ""}${item.duplicate ? " dup" : ""}`
      : item.type === "run"
        ? `run ${item.count} #${item.firstSequence}-${item.lastSequence}`
        : `gap #${item.from}-${item.to}`,
  );
}

function event(items: readonly ChainViewItem[], sequence: number): ChainViewEvent | undefined {
  return items.find(
    (item): item is ChainViewEvent => item.type === "event" && item.sequence === sequence,
  );
}

describe("the chain picture", () => {
  it("folds an intact chain into its ends and one run", async () => {
    const { chain, view } = await viewOf(await sealedChain(10));
    expect(chain.intact).toBe(true);
    expect(describeItems(view.items)).toEqual(["#1", "run 7 #2-8", "#9", "#10"]);
    expect(view.startsMidChain).toBe(false);
    expect(view.chainFindings).toEqual([]);
  });

  it("draws a small chain member by member", async () => {
    const { view } = await viewOf(await sealedChain(3));
    expect(describeItems(view.items)).toEqual(["#1", "#2", "#3"]);
  });

  it("marks a modified event where the engine found it, with the member before it", async () => {
    const events = await sealedChain(10);
    (events[4]?.["resource"] as Record<string, unknown>)["id"] = "altered";
    const { chain, view } = await viewOf(events);
    expect(chain.intact).toBe(false);
    expect(describeItems(view.items)).toEqual([
      "#1",
      "#2",
      "#3",
      "#4",
      "#5!",
      "run 3 #6-8",
      "#9",
      "#10",
    ]);
    expect(event(view.items, 5)?.problems.map((problem) => problem.kind)).toEqual([
      "hash-mismatch",
    ]);
    // The link out of a modified event still matches its declared hash; the
    // engine keeps a modified event and a broken link apart, and so does this.
    expect(view.items.some((item) => item.type === "event" && item.linkIn === "broken")).toBe(
      false,
    );
  });

  it("shows a removed event as a gap and the link it broke", async () => {
    const events = await sealedChain(10);
    events.splice(4, 1);
    const { view } = await viewOf(events);
    // #7 and #8 are two healthy members, too few to fold into a run.
    expect(describeItems(view.items)).toEqual([
      "#1",
      "#2",
      "#3",
      "#4",
      "gap #5-5",
      "#6! (broken in)",
      "#7",
      "#8",
      "#9",
      "#10",
    ]);
    expect(event(view.items, 6)?.problems.map((problem) => problem.kind)).toEqual(["broken-link"]);
  });

  it("marks both members that declare one sequence", async () => {
    const events = await sealedChain(4);
    const copy = structuredClone(events[1] as Event);
    copy["id"] = "018f1b70-2c18-7f3a-b46d-999999999999";
    const { view } = await viewOf([...events, copy]);
    const duplicates = view.items.filter((item) => item.type === "event" && item.duplicate);
    expect(duplicates).toHaveLength(2);
    expect(duplicates.every((item) => item.type === "event" && item.sequence === 2)).toBe(true);
  });

  it("never folds a duplicated sequence into a run, even with no other finding", async () => {
    // Two events claim #6, and each is chained correctly to the one before it,
    // so no link breaks: the only finding is the unlabelled duplicate-sequence
    // one. Only the duplicate mark keeps them out of a run whose title says
    // every link held.
    const events = await sealedLine([1, 2, 3, 4, 5, 6, 6, 7, 8, 9, 10, 11, 12]);
    const { chain, view } = await viewOf(events);
    expect(chain.findings.map((finding) => finding.kind)).toEqual(["duplicate-sequence"]);
    const duplicates = view.items.filter((item) => item.type === "event" && item.duplicate);
    expect(duplicates).toHaveLength(2);
    for (const item of view.items) {
      if (item.type === "run") {
        expect(item.firstSequence > 6 || item.lastSequence < 6).toBe(true);
      }
    }
  });

  it("draws a missing previousHash as its own kind of break", async () => {
    const events = await sealedChain(6);
    const integrity = (events[3] as Event)["integrity"] as Record<string, unknown>;
    delete integrity["previousHash"];
    integrity["hash"] = await calculateDigest(events[3], "SHA-256");
    const { chain, view } = await viewOf(events);
    expect(chain.findings.map((finding) => finding.kind)).toContain("previous-hash-missing");
    expect(event(view.items, 4)?.linkIn).toBe("missing");
  });

  it("says when the loaded events begin mid-chain", async () => {
    const events = await sealedChain(6);
    const { chain, view } = await viewOf(events.slice(2));
    expect(chain.intact).toBe(true);
    expect(view.startsMidChain).toBe(true);
    expect(describeItems(view.items)[0]).toBe("#3");
  });

  it("keeps an event with no sequence off the line and says so", async () => {
    const events = await sealedChain(3);
    const unsequenced = structuredClone(events[2] as Event);
    delete unsequenced["sequence"];
    unsequenced["id"] = "018f1b70-2c18-7f3a-b46d-888888888888";
    const { view } = await viewOf([...events, unsequenced]);
    expect(view.unsequenced).toEqual([`row-${String(unsequenced["id"])}`]);
    const drawn = view.items.flatMap((item) => (item.type === "event" ? [item.label] : []));
    expect(drawn).not.toContain(`row-${String(unsequenced["id"])}`);
    expect(drawn).toHaveLength(3);
  });

  it("draws the members in the order the engine checked them", async () => {
    const events = await sealedChain(8);
    const shuffled = [
      events[5],
      events[0],
      events[7],
      events[2],
      events[1],
      events[6],
      events[4],
      events[3],
    ] as Event[];
    const { chain } = await viewOf(shuffled);
    expect(chain.order.map((position) => position.sequence)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(chain.intact).toBe(true);
  });

  it("never draws a break the engine did not report", async () => {
    // Over a set of damaged chains, every broken link on the picture has a
    // finding behind it and every link finding appears on the picture.
    for (const damage of [2, 4, 6]) {
      const events = await sealedChain(9);
      events.splice(damage, 1);
      const { chain, view } = await viewOf(events);
      const drawn = view.items
        .filter(
          (item): item is ChainViewEvent =>
            item.type === "event" && (item.linkIn === "broken" || item.linkIn === "missing"),
        )
        .map((item) => item.label);
      const found = chain.findings
        .filter(
          (finding) => finding.kind === "broken-link" || finding.kind === "previous-hash-missing",
        )
        .map((finding) => finding.label);
      expect(drawn).toEqual(found);
    }
  });
});
