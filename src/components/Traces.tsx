/**
 * The Traces tab: cross-application flows reconstructed from
 * request.traceId / request.correlationId.
 *
 * Left: every detected flow, as "which applications, in what order". Right:
 * the selected flow as one swimlane per application — a dot per event,
 * positioned by time — plus the full event list in order. Clicking an event
 * jumps to it in the Events tab.
 */
import { useMemo, useState } from "react";
import type { LoadedEvent } from "../lib/types";
import { FlowMap } from "./FlowMap";
import { applicationChipStyle, applicationColor } from "../lib/app-color";
import {
  buildTraceGroups,
  clockTime,
  formatDuration,
  groupIdentity,
  type TraceGroup,
  type TraceMember,
} from "../lib/trace";

interface Props {
  readonly events: readonly LoadedEvent[];
  readonly onOpenEvent: (rowId: string) => void;
  readonly onSelectApplication: (name: string) => void;
}

function dotPosition(member: TraceMember, group: TraceGroup): number {
  const span = group.endMs - group.startMs;
  if (span <= 0) {
    return 50;
  }
  const raw = ((member.timeMs - group.startMs) / span) * 100;
  return 2 + raw * 0.96;
}

function shortKey(group: TraceGroup): string {
  return group.key.length > 18 ? `${group.key.slice(0, 18)}…` : group.key;
}

export function Traces({ events, onOpenEvent, onSelectApplication }: Props) {
  const groups = useMemo(() => buildTraceGroups(events), [events]);
  // Selection is by group IDENTITY (kind + key): the same identifier can
  // exist as both a trace group and a correlation group, and raw keys would
  // make the second one unselectable.
  const [selectedIdentity, setSelectedIdentity] = useState<string | undefined>();

  const selected = groups.find((group) => groupIdentity(group) === selectedIdentity) ?? groups[0];

  if (groups.length === 0) {
    return (
      <div className="traces empty-state">
        <p>
          No cross-application flows found. Flows are built from <code>request.traceId</code> and{" "}
          <code>request.correlationId</code> — events without either cannot be linked without
          guessing, so they are not.
        </p>
      </div>
    );
  }

  return (
    <div className="traces">
      {selected === undefined ? null : (
        <FlowMap group={selected} onSelectApp={onSelectApplication} />
      )}

      <div className="traces-body">
        <div className="trace-list">
          {groups.map((group) => (
            <button
              type="button"
              key={groupIdentity(group)}
              className={
                selected !== undefined && groupIdentity(group) === groupIdentity(selected)
                  ? "trace-card selected"
                  : "trace-card"
              }
              onClick={() => setSelectedIdentity(groupIdentity(group))}
            >
              <div className="trace-card-head">
                <span className="trace-key" title={group.key}>
                  {shortKey(group)}
                </span>
                <span className="trace-kind">{group.kind}</span>
                {group.hasFailure ? <span className="bar-flag bad">failure</span> : null}
              </div>
              <div className="trace-flow">
                {group.applications.map((app, index) => (
                  <span key={app}>
                    {index > 0 ? <span className="flow-arrow"> → </span> : null}
                    <span className="app-chip" style={applicationChipStyle(app)}>
                      {app}
                    </span>
                  </span>
                ))}
              </div>
              <div className="trace-meta">
                {group.members.length} events · {formatDuration(group.endMs - group.startMs)}
              </div>
            </button>
          ))}
        </div>

        {selected !== undefined ? (
          <div className="trace-detail">
            <div className="trace-detail-head">
              <code title={selected.key}>{selected.key}</code>
              <span className="detail-note-inline">
                {selected.members.length} events across {selected.applications.length} application
                {selected.applications.length === 1 ? "" : "s"} ·{" "}
                {formatDuration(selected.endMs - selected.startMs)}
              </span>
            </div>

            <div className="lanes">
              {selected.applications.map((app) => (
                <div className="lane" key={app}>
                  <div className="lane-label" style={{ color: applicationColor(app) }} title={app}>
                    {app}
                  </div>
                  <div className="lane-track">
                    {selected.members
                      .filter((member) => member.application === app)
                      .map((member) => (
                        <button
                          type="button"
                          key={member.row.rowId}
                          className={
                            member.row.outcome === "failure" ? "lane-dot failed" : "lane-dot"
                          }
                          style={{
                            left: `${dotPosition(member, selected)}%`,
                            ...(member.row.outcome === "failure"
                              ? {}
                              : { background: applicationColor(app) }),
                          }}
                          title={`${clockTime(member.row.time)}  ${member.row.eventName ?? "?"} (${member.row.outcome ?? "?"})`}
                          onClick={() => onOpenEvent(member.row.rowId)}
                        />
                      ))}
                  </div>
                </div>
              ))}
              <div className="lane-axis">
                <span>{clockTime(selected.members[0]?.row.time)}</span>
                <span>{clockTime(selected.members[selected.members.length - 1]?.row.time)}</span>
              </div>
            </div>

            <div className="trace-events">
              {selected.members.map((member, index) => (
                <button
                  type="button"
                  className="trace-event-row"
                  key={member.row.rowId}
                  onClick={() => onOpenEvent(member.row.rowId)}
                >
                  <span className="trace-event-time">
                    {clockTime(member.row.time)}
                    {index > 0 ? (
                      <span className="trace-event-offset">
                        +{formatDuration(member.timeMs - selected.startMs)}
                      </span>
                    ) : null}
                  </span>
                  <span className="app-chip" style={applicationChipStyle(member.application)}>
                    {member.application}
                  </span>
                  <span className="trace-event-name">{member.row.eventName ?? "?"}</span>
                  <span
                    className={
                      member.row.outcome === "failure"
                        ? "status-bad"
                        : member.row.outcome === "success"
                          ? "status-ok"
                          : "detail-note-inline"
                    }
                  >
                    {member.row.outcome ?? "—"}
                  </span>
                  <span className="trace-event-actor">{member.row.actorId ?? ""}</span>
                </button>
              ))}
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
