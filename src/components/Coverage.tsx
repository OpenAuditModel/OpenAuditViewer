/**
 * The Coverage tab: which profiles reach this archive, and what they checked.
 *
 * The Events tab answers "does this event conform?" one row at a time. This
 * answers the question a reviewer asks about a whole archive, and the answer
 * most archives get is uncomfortable: a profile governs an event only when one
 * of its rules selects the event's name, and an archive whose names were
 * chosen without reference to the profiles is governed by none of them. That
 * is reported as governing nothing rather than as conforming, here as in the
 * CLI, because silence is not conformance.
 *
 * Every number comes from the published engines through `lib/coverage.ts`. The
 * work is a profile check per event per profile, so it waits for a click, like
 * the digest sweep — the rule the Overview tab already follows for whole-set
 * work.
 *
 * **Not a score.** "4 of 15 rules selected" describes this event set. It is
 * not a percentage, a grade or a target, and nothing here renders it as a
 * proportion of a whole, because a profile is not a checklist an archive is
 * supposed to fill.
 */
import { useRef, useState } from "react";
import type { LoadedEvent } from "../lib/types";
import { governsNothing, summariseArchiveCoverage, type CoverageReport } from "../lib/coverage";
import { REFUSED_PROFILES } from "../lib/profiles";

interface Props {
  readonly events: readonly LoadedEvent[];
  readonly onSelectRow: (rowId: string) => void;
}

type State =
  | { readonly status: "idle" }
  | { readonly status: "running" }
  | { readonly status: "done"; readonly report: CoverageReport };

/** The rule counts one profile reached, as words rather than a ratio. */
function ruleSummary(selected: number, applied: number, total: number): string {
  if (selected === 0) {
    return `no rule of ${total} was selected`;
  }
  const appliedText =
    applied === selected
      ? "every one contributed requirements"
      : `${applied} contributed requirements`;
  return `${selected} of ${total} rules selected, ${appliedText}`;
}

export function Coverage({ events, onSelectRow }: Props) {
  const [state, setState] = useState<State>({ status: "idle" });
  const onScreen = useRef(events);
  onScreen.current = events;

  function run(): void {
    const requested = events;
    setState({ status: "running" });
    // Synchronous and potentially long: yielding once lets the running state
    // paint before the main thread is taken.
    setTimeout(() => {
      const report = summariseArchiveCoverage(requested);
      if (onScreen.current === requested) {
        setState({ status: "done", report });
      }
    }, 0);
  }

  if (events.length === 0) {
    return <p className="empty-state">Open a folder to measure profile coverage.</p>;
  }

  return (
    <div className="coverage">
      <div className="panel">
        <div className="block-head">
          <span className="label">
            <span className="swatch resource"></span>Profile coverage
          </span>
          {state.status === "done" ? (
            <span className="muted">
              {state.report.checked} events checked
              {state.report.unparsed > 0 ? `, ${state.report.unparsed} unreadable` : ""}
            </span>
          ) : null}
        </div>
        <div className="block-body">
          <p className="detail-note">
            A profile governs an event when one of its rules selects the event&rsquo;s name. An
            event no rule selects is <strong>not applicable</strong> — the profile said nothing
            about it, which is not the same as approving it. Rule counts describe this archive; they
            are not a score.
          </p>
          {state.status !== "done" ? (
            <button
              type="button"
              className="secondary-button"
              onClick={run}
              disabled={state.status === "running"}
            >
              {state.status === "running"
                ? "Measuring…"
                : `Measure coverage of ${events.length} events`}
            </button>
          ) : null}
          {REFUSED_PROFILES.length > 0 ? (
            <p className="detail-note">
              {REFUSED_PROFILES.length} profile
              {REFUSED_PROFILES.length === 1 ? " is" : "s are"} written in a rule vocabulary this
              build does not implement and {REFUSED_PROFILES.length === 1 ? "was" : "were"} not
              evaluated:{" "}
              {REFUSED_PROFILES.map(
                (profile) => `${profile.name} (${profile.profileVersion})`,
              ).join(", ")}
              .
            </p>
          ) : null}
        </div>
      </div>

      {state.status === "done" ? (
        <>
          {governsNothing(state.report) ? (
            <p className="detail-note">
              No profile governs a single event in this archive. Every event is reported not
              applicable, which says nothing about whether the events are right — only that no
              published profile claims to check them. The usual cause is event names shaped
              differently from the naming convention the profiles select on.
            </p>
          ) : null}
          <div className="coverage-list">
            {state.report.profiles.map(({ coverage, governed }) => {
              const { events: totals, rules, nameTotals } = coverage;
              const reached = nameTotals.governed > 0;
              return (
                <div className="panel" key={coverage.profile.name}>
                  <div className="block-head">
                    <span className="label">{coverage.profile.name}</span>
                    <span className={reached ? "count-ok" : "muted"}>
                      {reached
                        ? `${totals.conforming} conforming, ${totals.violations} with violations`
                        : "governs nothing here"}
                    </span>
                  </div>
                  <div className="block-body">
                    <p className="muted">
                      {ruleSummary(rules.selected, rules.applied, rules.total)}.{" "}
                      {nameTotals.governed} of {nameTotals.distinct} event names governed.
                    </p>
                    {rules.selectedButNeverApplied.length > 0 ? (
                      <p className="detail-note">
                        {rules.selectedButNeverApplied.length} rule
                        {rules.selectedButNeverApplied.length === 1 ? "" : "s"} selected an event
                        and required nothing of it, because a condition never held:{" "}
                        {rules.selectedButNeverApplied.join(", ")}. Each one looked enforced and was
                        not.
                      </p>
                    ) : null}
                    {governed.length > 0 ? (
                      <div className="coverage-rows">
                        {governed.slice(0, 8).map(({ row, result }) => (
                          <button
                            type="button"
                            className="bar-row"
                            key={row.rowId}
                            onClick={() => onSelectRow(row.rowId)}
                            title="Open this event"
                          >
                            <span className="bar-name">{row.eventName ?? row.rowId}</span>
                            <span
                              className={
                                result.status === "violations" ? "bar-flag bad" : "bar-flag"
                              }
                            >
                              {result.status === "violations"
                                ? `${result.errors.length} violation${result.errors.length === 1 ? "" : "s"}`
                                : "conforming"}
                            </span>
                          </button>
                        ))}
                        {governed.length > 8 ? (
                          <p className="muted">and {governed.length - 8} more</p>
                        ) : null}
                      </div>
                    ) : null}
                  </div>
                </div>
              );
            })}
          </div>
        </>
      ) : null}
    </div>
  );
}
