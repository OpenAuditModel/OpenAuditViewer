/**
 * Verification of previous-hash chains.
 *
 * Ported from conformance/src/integrity/verify-chain.ts. The grouping and
 * link-checking rules are unchanged: events are grouped strictly by
 * `integrity.chainId`, ordered by `sequence`, and linked by comparing each
 * event's `integrity.previousHash` against its predecessor's declared
 * `integrity.hash`.
 *
 * This is deliberately NOT relaxed to group by `sequence` alone when
 * `chainId` is absent, which is a common shape in practice: a producer may
 * declare `sequence` and a self-`integrity.hash` per event while keeping its
 * previous-event link somewhere this app cannot check — under `extensions`,
 * as part of a scheme needing a key it does not have. Inventing a grouping
 * the data does not declare would let the interface show a green "chain
 * intact" state for a linkage nobody ever asserted cryptographically. Such
 * events are reported as unassigned, same as the CLI, with the specific
 * reason why.
 *
 * Adaptations from the CLI version: schema validation goes through this
 * app's own `validateEvent` instead of an injectable validator (same change
 * as lint-event.ts / verify-event.ts), digest verification is awaited, and
 * there is no signature/publicKey parameter (see verify-event.ts).
 */
import { validateEvent as validateAgainstSchema } from "../schema";
import { digestsEqual } from "./digest";
import { readIntegrity, verifyEventIntegrity } from "./verify-event";
import type { ChainReport, ChainVerificationResult, Finding, Note, PassedCheck } from "./types";

/** One event offered for chain verification. */
export interface ChainEventInput {
  readonly label: string;
  readonly event: unknown;
}

interface ChainMember {
  readonly label: string;
  readonly event: unknown;
  readonly sequence?: number;
  readonly hash?: string;
  readonly previousHash?: string;
  readonly hashAlgorithm?: string;
  readonly canonicalization?: string;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asSequence(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
}

/** Orders members deterministically: by sequence, then by label for equal sequences. */
function compareMembers(left: ChainMember, right: ChainMember): number {
  const leftSequence = left.sequence ?? Number.MAX_SAFE_INTEGER;
  const rightSequence = right.sequence ?? Number.MAX_SAFE_INTEGER;
  if (leftSequence !== rightSequence) {
    return leftSequence - rightSequence;
  }
  return left.label.localeCompare(right.label, "en");
}

async function verifyOneChain(
  chainId: string,
  members: readonly ChainMember[],
): Promise<ChainVerificationResult> {
  const findings: Finding[] = [];
  const notes: Note[] = [];
  const checks: PassedCheck[] = [];

  // Every event's own digest must hold before its links mean anything.
  let digestsValid = true;
  const results = await Promise.all(
    members.map((member) =>
      verifyEventIntegrity(member.event, member.label, { validateSchema: false }),
    ),
  );
  for (const result of results) {
    if (!result.verified) {
      digestsValid = false;
      findings.push(...result.findings);
    }
  }
  if (digestsValid && members.length > 0) {
    checks.push({ message: `all ${members.length} event digests valid` });
  }

  // A chain is only comparable if every member seals itself the same way: a
  // `previousHash` produced by a different algorithm can never equal the
  // predecessor's `hash`.
  const algorithms = new Set(members.map((member) => member.hashAlgorithm ?? "(none)"));
  const canonicalizations = new Set(members.map((member) => member.canonicalization ?? "(none)"));
  if (algorithms.size > 1 || canonicalizations.size > 1) {
    findings.push({
      kind: "algorithm-mismatch",
      message: "events in this chain do not share one hash algorithm and canonicalization",
      detail: [
        `hash algorithms: ${[...algorithms].sort().join(", ")}`,
        `canonicalizations: ${[...canonicalizations].sort().join(", ")}`,
      ],
    });
  }

  // Ordering is by `sequence`; without it there is no deterministic order.
  const withoutSequence = members.filter((member) => member.sequence === undefined);
  for (const member of withoutSequence) {
    findings.push({
      kind: "sequence-missing",
      label: member.label,
      message: "event declares no sequence, so it cannot be ordered within the chain",
    });
  }

  const ordered = [...members].sort(compareMembers);

  const bySequence = new Map<number, ChainMember[]>();
  for (const member of ordered) {
    if (member.sequence === undefined) {
      continue;
    }
    const bucket = bySequence.get(member.sequence);
    if (bucket === undefined) {
      bySequence.set(member.sequence, [member]);
    } else {
      bucket.push(member);
    }
  }

  for (const [sequence, bucket] of [...bySequence.entries()].sort((a, b) => a[0] - b[0])) {
    if (bucket.length > 1) {
      findings.push({
        kind: "duplicate-sequence",
        message: `sequence ${sequence} is declared by ${bucket.length} events`,
        detail: bucket.map((member) => member.label),
      });
    }
  }

  // Links are compared against the predecessor's *declared* hash. Every declared
  // hash has already been checked against a recalculated digest above, so this
  // is as strong as comparing against the recalculation while keeping a
  // modified event and a broken link reported as separate, locatable problems.
  const linkable = ordered.filter((member) => member.sequence !== undefined);
  let linksValid = true;

  for (const [index, member] of linkable.entries()) {
    if (index === 0) {
      if (member.previousHash !== undefined) {
        notes.push({
          message: "chain does not start at a genesis event",
          detail: [
            `first supplied event ${member.label} declares previousHash`,
            "the supplied set is a segment; the events before it were not verified",
          ],
        });
      }
      continue;
    }

    const predecessor = linkable[index - 1];
    if (predecessor === undefined) {
      continue;
    }

    if (member.previousHash === undefined) {
      linksValid = false;
      findings.push({
        kind: "previous-hash-missing",
        label: member.label,
        message: "event declares no previousHash but is not the first event in the chain",
      });
      continue;
    }

    if (predecessor.hash === undefined || !digestsEqual(member.previousHash, predecessor.hash)) {
      linksValid = false;
      findings.push({
        kind: "broken-link",
        label: member.label,
        message: "previousHash does not match the preceding event",
        detail: [
          `preceding event:       ${predecessor.label}`,
          `declared previousHash: ${member.previousHash}`,
          `preceding event hash:  ${predecessor.hash ?? "(none declared)"}`,
        ],
      });
    }
  }

  if (linksValid && linkable.length > 1) {
    checks.push({ message: `all ${linkable.length - 1} previous-hash links valid` });
  }
  if (linkable.length > 0 && linkable[0]?.previousHash === undefined) {
    checks.push({ message: "chain starts at a genesis event" });
  }

  // A gap is not a failure: the core model permits non-contiguous sequences, and
  // an event removed from the middle would break a link rather than only a gap.
  const sequences = [...new Set(linkable.map((member) => member.sequence as number))].sort(
    (a, b) => a - b,
  );
  const first = sequences[0];
  const last = sequences[sequences.length - 1];
  if (first !== undefined && last !== undefined && last - first + 1 !== sequences.length) {
    notes.push({
      message: "sequence numbers are not contiguous",
      detail: [
        `observed: ${sequences.join(", ")}`,
        "the core model permits gaps; a removed event would also break a link",
      ],
    });
  }

  return {
    chainId,
    eventCount: members.length,
    ...(first === undefined ? {} : { firstSequence: first }),
    ...(last === undefined ? {} : { lastSequence: last }),
    intact: findings.length === 0,
    checks,
    findings,
    notes,
  };
}

/**
 * Verifies every chain present in a set of events.
 *
 * Events are grouped by `integrity.chainId`; a set containing several chains is
 * verified as several independent chains, which is the intended model — a
 * single global chain is never required.
 */
export async function verifyChains(inputs: readonly ChainEventInput[]): Promise<ChainReport> {
  const unassigned: Finding[] = [];
  const groups = new Map<string, ChainMember[]>();

  for (const input of inputs) {
    const issues = validateAgainstSchema(input.event);
    if (issues.length > 0) {
      const shown = issues.slice(0, 3).map((issue) => `${issue.path}  ${issue.message}`);
      unassigned.push({
        kind: "schema-invalid",
        label: input.label,
        message: "event does not conform to the canonical schema",
        detail:
          issues.length > shown.length
            ? [...shown, `and ${issues.length - shown.length} further schema issues`]
            : shown,
      });
      continue;
    }

    const integrity = readIntegrity(input.event);
    if (integrity === undefined) {
      unassigned.push({
        kind: "integrity-missing",
        label: input.label,
        message: "event carries no integrity object and cannot belong to a chain",
      });
      continue;
    }

    const chainId = asString(integrity.chainId);
    if (chainId === undefined) {
      unassigned.push({
        kind: "chain-id-missing",
        label: input.label,
        message: "event declares no integrity.chainId, so it cannot be assigned to a chain",
      });
      continue;
    }

    const sequence = asSequence((input.event as Record<string, unknown>)["sequence"]);
    const hash = asString(integrity.hash);
    const previousHash = asString(integrity.previousHash);
    const hashAlgorithm = asString(integrity.hashAlgorithm);
    const canonicalization = asString(integrity.canonicalization);

    const member: ChainMember = {
      label: input.label,
      event: input.event,
      ...(sequence === undefined ? {} : { sequence }),
      ...(hash === undefined ? {} : { hash }),
      ...(previousHash === undefined ? {} : { previousHash }),
      ...(hashAlgorithm === undefined ? {} : { hashAlgorithm }),
      ...(canonicalization === undefined ? {} : { canonicalization }),
    };

    const group = groups.get(chainId);
    if (group === undefined) {
      groups.set(chainId, [member]);
    } else {
      group.push(member);
    }
  }

  const orderedGroups = [...groups.entries()].sort((left, right) =>
    left[0].localeCompare(right[0], "en"),
  );
  const chains = await Promise.all(
    orderedGroups.map(([chainId, members]) => verifyOneChain(chainId, members)),
  );

  return {
    chains,
    unassigned,
    eventCount: inputs.length,
    intact: unassigned.length === 0 && chains.every((chain) => chain.intact),
  };
}
