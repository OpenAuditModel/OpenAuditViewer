/**
 * Digest verification for one event: was this event altered after its
 * `integrity.hash` was calculated?
 *
 * Verification is asynchronous because Web Crypto is, so the block has a
 * genuine third state. "verifying…" is shown rather than an optimistic
 * result, because a viewer that flashes "verified" before it has verified
 * anything is worse than one that makes you wait.
 */
import type { IntegrityState } from "../../hooks/useEventIntegrity";
import { DetailBlock, plural } from "./DetailBlock";
import { CheckList, FindingList } from "./VerificationLists";

interface Props {
  readonly integrity: IntegrityState;
}

export function IntegrityBlock({ integrity }: Props) {
  if (integrity.status === "none") {
    return null;
  }

  if (integrity.status === "verifying") {
    return <DetailBlock label="Integrity" swatch="integrity" tone="pending" status="verifying…" />;
  }

  const { verified, checks, findings } = integrity.result;

  return (
    <DetailBlock
      label="Integrity"
      swatch="integrity"
      tone={verified ? "ok" : "bad"}
      status={verified ? "hash verified" : plural(findings.length, "issue")}
    >
      <CheckList checks={checks} />
      <FindingList findings={findings} />
    </DetailBlock>
  );
}
