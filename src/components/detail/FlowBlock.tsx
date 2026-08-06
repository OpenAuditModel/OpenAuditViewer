/**
 * The cross-application flow this event belongs to, as an ordered list you
 * can step through.
 *
 * The key is shown with its kind — `trace` or `correlation` — because the
 * two are not equally strong evidence. A trace id was propagated by the
 * applications themselves; a correlation id only says two events named the
 * same operation.
 */
import { clockTime, type TraceGroup } from "../../lib/trace";
import { DetailBlock, plural } from "./DetailBlock";

interface Props {
  readonly flow: TraceGroup;
  readonly currentRowId: string;
  readonly onSelectRow: (rowId: string) => void;
}

export function FlowBlock({ flow, currentRowId, onSelectRow }: Props) {
  return (
    <DetailBlock
      label="Flow"
      swatch="resource"
      status={`${plural(flow.members.length, "event")} · ${plural(flow.applications.length, "app")}`}
    >
      <div className="detail-note-inline flow-summary">
        {flow.applications.join(" → ")}{" "}
        <code>
          ({flow.kind}: {flow.key})
        </code>
      </div>
      {flow.members.map((member) => {
        const isCurrent = member.row.rowId === currentRowId;
        return (
          <button
            type="button"
            key={member.row.rowId}
            className={isCurrent ? "flow-event current" : "flow-event"}
            disabled={isCurrent}
            onClick={() => onSelectRow(member.row.rowId)}
          >
            <span className="trace-event-time">{clockTime(member.row.time)}</span>
            <span className="flow-app">{member.application}</span>
            <span className="trace-event-name">{member.row.eventName ?? "?"}</span>
            <span className={member.row.outcome === "failure" ? "status-bad" : "status-ok"}>
              {member.row.outcome ?? "—"}
            </span>
          </button>
        );
      })}
    </DetailBlock>
  );
}
