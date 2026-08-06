/**
 * Chain verification for the chain this event belongs to.
 *
 * `unassigned` is counted into the issue total on purpose: an event that
 * declares this chain but could not be verified at all — because it fails
 * the schema — leaves a hole in the chain. Reporting the chain as intact
 * while one of its members is unverifiable would be the most misleading
 * thing this panel could say.
 */
import type { ChainState } from "../../hooks/useEventIntegrity";
import { DetailBlock, plural } from "./DetailBlock";
import { CheckList, FindingList, NoteList } from "./VerificationLists";

interface Props {
  readonly chain: ChainState;
}

export function ChainBlock({ chain }: Props) {
  if (chain.status === "none") {
    return null;
  }

  if (chain.status === "verifying") {
    return <DetailBlock label="Chain" swatch="chain" tone="pending" status="verifying…" />;
  }

  const { result, unassigned, chainId } = chain;
  const intact = result.intact && unassigned.length === 0;
  const issues = result.findings.length + unassigned.length;
  const range =
    result.firstSequence !== undefined && result.lastSequence !== undefined
      ? ` · sequence ${result.firstSequence}–${result.lastSequence}`
      : "";

  return (
    <DetailBlock
      label="Chain"
      swatch="chain"
      tone={intact ? "ok" : "bad"}
      status={intact ? `${result.eventCount} events, intact` : plural(issues, "issue")}
    >
      <div className="detail-note-inline">
        <code>{chainId}</code> · {plural(result.eventCount, "event")}
        {range}
      </div>
      <CheckList checks={result.checks} />
      <FindingList findings={result.findings} />
      <FindingList findings={unassigned} />
      <NoteList notes={result.notes} />
    </DetailBlock>
  );
}
