/**
 * One chain, drawn as the line of links chain verification walked.
 *
 * Every mark comes from buildChainView, which places the engine's own findings
 * and notes; nothing here decides whether a link holds. A member is a button
 * that opens the event, because the question a break raises is always "what
 * does this event say", and the answer is one click away rather than a search.
 */
import { buildChainView, type ChainViewItem, type LinkState } from "../lib/chain-view";
import type { ChainVerificationResult } from "../lib/integrity/types";

interface Props {
  readonly result: ChainVerificationResult;
  readonly onOpenEvent: (label: string) => void;
}

/** Problems listed under the line before the rest are summarised. */
const PROBLEMS_SHOWN = 20;

const LINK_TITLE: Readonly<Record<LinkState, string>> = {
  start: "",
  valid: "previousHash matches the preceding event",
  broken: "previousHash does not match the preceding event",
  missing: "no previousHash declared, but this is not the first event",
  unchecked:
    "the preceding event is outside the window that was read, so this link was not checked",
};

function Link({ state }: { readonly state: LinkState }) {
  return (
    <span className={`chain-link chain-link-${state}`} title={LINK_TITLE[state]} aria-hidden="true">
      {state === "valid" ? "" : state === "unchecked" ? "?" : "✕"}
    </span>
  );
}

/** A finding that says a link was not checked, rather than that something failed. */
function windowOnly(kind: string): boolean {
  return kind === "link-outside-window";
}

function Item({
  item,
  onOpenEvent,
}: {
  readonly item: ChainViewItem;
  readonly onOpenEvent: (label: string) => void;
}) {
  if (item.type === "gap") {
    return (
      <span className="chain-gap" title="These sequence numbers are absent from the events loaded">
        {item.from === item.to ? `#${item.from}` : `#${item.from}–${item.to}`} absent
      </span>
    );
  }
  if (item.type === "run") {
    return (
      <span
        className="chain-run"
        title="Every event digest in this run verified, and every link held"
      >
        {item.count} events · #{item.firstSequence}–{item.lastSequence}
      </span>
    );
  }
  const bad = item.problems.some((problem) => !windowOnly(problem.kind));
  return (
    <button
      type="button"
      className={bad ? "chain-node chain-node-bad" : "chain-node"}
      title={[
        item.label,
        ...item.problems.map((problem) => problem.message),
        ...(item.duplicate ? ["another event declares this sequence"] : []),
      ].join("\n")}
      onClick={() => onOpenEvent(item.label)}
    >
      #{item.sequence}
      {item.duplicate ? <span className="chain-dup">dup</span> : null}
    </button>
  );
}

export function ChainStrip({ result, onOpenEvent }: Props) {
  const view = buildChainView(result);
  const problems = view.items.flatMap((item) =>
    item.type === "event"
      ? item.problems.map((problem) => ({ label: item.label, sequence: item.sequence, problem }))
      : [],
  );

  return (
    <div className="chain-strip">
      <code className="chain-id">{result.chainId}</code>
      <p className="detail-note-inline">
        Drawn from the {result.eventCount} loaded event{result.eventCount === 1 ? "" : "s"} that
        declare this chain. An event that was not loaded, or was never written, cannot appear here —
        a chain whose newest events were deleted draws as a shorter, unbroken line.
      </p>

      <div className="chain-line">
        {view.startsMidChain ? (
          <span className="chain-gap" title="The first event loaded declares a previousHash">
            earlier events not loaded
          </span>
        ) : null}
        {view.items.map((item, index) => {
          const key =
            item.type === "event"
              ? `e-${item.label}`
              : item.type === "run"
                ? `r-${item.firstSequence}`
                : `g-${item.from}`;
          // The first member's link points at an event that was not loaded,
          // if at any; the stub before it says so, and no link is drawn as held.
          const linkState: LinkState | undefined =
            index === 0
              ? undefined
              : item.type === "event"
                ? item.linkIn === "start"
                  ? "valid"
                  : item.linkIn
                : item.type === "run"
                  ? "valid"
                  : undefined;
          return (
            <span className="chain-step" key={key}>
              {linkState !== undefined ? <Link state={linkState} /> : null}
              <Item item={item} onOpenEvent={onOpenEvent} />
            </span>
          );
        })}
      </div>

      {view.chainFindings.map((finding) => (
        <div className="check-bad rule-line" key={finding.message}>
          {finding.message}
        </div>
      ))}
      {view.unsequenced.length > 0 ? (
        <div className="check-bad rule-line">
          {view.unsequenced.length} event{view.unsequenced.length === 1 ? "" : "s"} declare no
          sequence and cannot be placed on the line.
        </div>
      ) : null}
      {problems.slice(0, PROBLEMS_SHOWN).map(({ label, sequence, problem }) => (
        <div
          className={windowOnly(problem.kind) ? "check-muted rule-line" : "check-bad rule-line"}
          key={`${label}-${problem.kind}`}
        >
          <button type="button" className="link-button" onClick={() => onOpenEvent(label)}>
            #{sequence}
          </button>
          {problem.message}
        </div>
      ))}
      {problems.length > PROBLEMS_SHOWN ? (
        <div className="detail-note-inline">
          and {problems.length - PROBLEMS_SHOWN} more not listed here.
        </div>
      ) : null}
    </div>
  );
}
