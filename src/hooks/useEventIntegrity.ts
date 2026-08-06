/**
 * Lazily verifies the selected event's digest and, when it declares a
 * `chainId`, the chain it belongs to.
 *
 * This runs per-selection rather than eagerly for every loaded event: digest
 * verification is cheap per event, but a folder can hold thousands of rows,
 * and chain verification re-walks every member of a chain on top of that.
 * Doing all of it eagerly on folder load would make opening a large folder
 * noticeably slower for a payoff (chain state for rows the user may never
 * look at) most sessions don't need. A generation counter discards results
 * from a selection the user has already moved past.
 */
import { useEffect, useRef, useState } from "react";
import type { LoadedEvent } from "../lib/types";
import { readIntegrity, verifyEventIntegrity } from "../lib/integrity/verify-event";
import { verifyChains } from "../lib/integrity/chain";
import type {
  ChainVerificationResult,
  EventVerificationResult,
  Finding,
} from "../lib/integrity/types";

export type IntegrityState =
  | { readonly status: "none" }
  | { readonly status: "verifying" }
  | { readonly status: "done"; readonly result: EventVerificationResult };

export type ChainState =
  | { readonly status: "none" }
  | { readonly status: "verifying" }
  | {
      readonly status: "done";
      readonly chainId: string;
      readonly result: ChainVerificationResult;
      /** Events declaring this chainId that could not be verified at all
       * (schema-invalid). A chain is not intact while these exist. */
      readonly unassigned: readonly Finding[];
    };

export function useEventIntegrity(
  row: LoadedEvent | undefined,
  allEvents: readonly LoadedEvent[],
): { readonly integrity: IntegrityState; readonly chain: ChainState } {
  const [integrity, setIntegrity] = useState<IntegrityState>({ status: "none" });
  const [chain, setChain] = useState<ChainState>({ status: "none" });
  const generation = useRef(0);

  useEffect(() => {
    generation.current += 1;
    const thisRun = generation.current;

    if (row === undefined || !row.valid || row.event === null) {
      setIntegrity({ status: "none" });
      setChain({ status: "none" });
      return;
    }

    const declared = readIntegrity(row.event);
    if (typeof declared?.hash !== "string") {
      setIntegrity({ status: "none" });
      setChain({ status: "none" });
      return;
    }

    setIntegrity({ status: "verifying" });
    void verifyEventIntegrity(row.event, row.sourceFile).then((result) => {
      if (generation.current === thisRun) {
        setIntegrity({ status: "done", result });
      }
    });

    const chainId = typeof declared.chainId === "string" ? declared.chainId : undefined;
    if (chainId === undefined) {
      setChain({ status: "none" });
      return;
    }

    setChain({ status: "verifying" });
    // Schema-invalid members are included on purpose: verifyChains reports
    // them as unassigned, and a chain with an unverifiable member must not
    // be presented as intact. Excluding them here would let tampering that
    // breaks an event's schema hide that event from the chain view.
    const members = allEvents
      .filter((candidate) => candidate.event !== null)
      .filter((candidate) => readIntegrity(candidate.event)?.chainId === chainId)
      .map((candidate) => ({
        label: candidate.rowId,
        event: candidate.event as Record<string, unknown>,
      }));

    void verifyChains(members).then((report) => {
      if (generation.current !== thisRun) {
        return;
      }
      const result = report.chains.find((candidate) => candidate.chainId === chainId);
      setChain(
        result === undefined
          ? { status: "none" }
          : { status: "done", chainId, result, unassigned: report.unassigned },
      );
    });
  }, [row, allEvents]);

  return { integrity, chain };
}
