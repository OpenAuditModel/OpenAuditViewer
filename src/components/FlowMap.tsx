/**
 * Aggregated service flow map, in the spirit of an APM topology view: every
 * application observed in any flow is a node with a health ring, every
 * observed transition is a directed edge carrying its own numbers —
 * transition count, median gap, failure count. Edge thickness scales with
 * volume. Selecting a trace in the list highlights the path it actually
 * took; clicking a node drills into that application's events.
 *
 * Everything drawn here is observed, not inferred: an edge exists only
 * where two consecutive events of one flow sit in different applications.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { applicationColor } from "../lib/app-color";
import {
  buildFlowTopology,
  formatDuration,
  pairKey,
  type FlowEdge,
  type TraceGroup,
} from "../lib/trace";
import {
  NODE_R,
  buildNodePositions,
  computeViewSize,
  edgeGeometry,
  edgeWidth,
  healthColor,
  mergePositions,
  type NodePosition,
} from "../lib/flow-layout";
import { useNodeDrag } from "../hooks/useNodeDrag";

interface Props {
  readonly groups: readonly TraceGroup[];
  readonly selectedKey: string | undefined;
  readonly onSelectApp: (name: string) => void;
}

export function FlowMap({ groups, selectedKey, onSelectApp }: Props) {
  const topology = useMemo(() => buildFlowTopology(groups), [groups]);
  const reducedMotion = useMemo(
    () => window.matchMedia("(prefers-reduced-motion: reduce)").matches,
    [],
  );

  const svgRef = useRef<SVGSVGElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [containerWidth, setContainerWidth] = useState(0);

  const toSvgPoint = useCallback((clientX: number, clientY: number): NodePosition | undefined => {
    const ctm = svgRef.current?.getScreenCTM();
    if (ctm === null || ctm === undefined) {
      return undefined;
    }
    const point = new DOMPoint(clientX, clientY).matrixTransform(ctm.inverse());
    return { x: point.x, y: point.y };
  }, []);

  const drag = useNodeDrag(toSvgPoint);

  // The canvas always spans the full visible strip at 1:1 scale, so its left
  // edge IS the container's left edge — no invisible boundary in the middle
  // of what looks like one continuous grid.
  useEffect(() => {
    const container = containerRef.current;
    if (container === null) {
      return;
    }
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry !== undefined) {
        setContainerWidth(entry.contentRect.width);
      }
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  const autoPositions = useMemo(() => buildNodePositions(topology), [topology]);
  const positions = useMemo(
    () => mergePositions(autoPositions, drag.overrides),
    [autoPositions, drag.overrides],
  );
  const viewSize = useMemo(
    () => computeViewSize(positions, containerWidth),
    [positions, containerWidth],
  );
  const renderSize = drag.renderSize(viewSize);
  const hasCustomLayout = useMemo(
    () => [...autoPositions.keys()].some((name) => Object.hasOwn(drag.overrides, name)),
    [autoPositions, drag.overrides],
  );

  if (topology.edges.length === 0) {
    return null;
  }

  function isActive(edge: FlowEdge): boolean {
    return selectedKey === undefined || edge.groupKeys.has(selectedKey);
  }

  return (
    <div className="flow-map" ref={containerRef}>
      {hasCustomLayout ? (
        <button type="button" className="flow-map-reset" onClick={drag.resetLayout}>
          Reset layout
        </button>
      ) : null}
      <svg
        ref={svgRef}
        viewBox={`0 0 ${renderSize.width} ${renderSize.height}`}
        width={renderSize.width}
        height={renderSize.height}
        role="img"
        aria-label="Aggregated application flow map"
      >
        <defs>
          <marker
            id="flow-arrow"
            viewBox="0 0 8 8"
            refX="7"
            refY="4"
            markerWidth="6.5"
            markerHeight="6.5"
            orient="auto-start-reverse"
          >
            <path d="M 0 0.8 L 7.2 4 L 0 7.2 z" className="flow-arrowhead" />
          </marker>
        </defs>

        {topology.edges.map((edge) => {
          const from = positions.get(edge.from);
          const to = positions.get(edge.to);
          if (from === undefined || to === undefined) {
            return null;
          }
          const backward = to.x <= from.x;
          const { path, mid } = edgeGeometry(from, to, backward);
          const active = isActive(edge);
          const color = edge.failures > 0 ? "var(--bad)" : applicationColor(edge.from);
          const pulses = !active || reducedMotion ? 0 : Math.min(edge.count, 3);
          const duration = backward ? 3.8 : 3;

          return (
            <g key={pairKey(edge.from, edge.to)} className={active ? "flow-g" : "flow-g dimmed"}>
              <path
                d={path}
                className={backward ? "flow-edge backward" : "flow-edge"}
                stroke={color}
                strokeWidth={edgeWidth(edge.count)}
                markerEnd="url(#flow-arrow)"
              >
                <title>
                  {edge.from} → {edge.to}: {edge.count} transition{edge.count === 1 ? "" : "s"},
                  median gap {formatDuration(Math.round(edge.medianDeltaMs))}
                  {edge.failures > 0 ? `, ${edge.failures} ending in failure` : ""}
                </title>
              </path>
              <text x={mid.x} y={mid.y} className="flow-edge-label">
                {edge.count}× · ~{formatDuration(Math.round(edge.medianDeltaMs))}
                {edge.failures > 0 ? ` · ${edge.failures} err` : ""}
              </text>
              {Array.from({ length: pulses }, (_, pulseIndex) => (
                <circle
                  key={pulseIndex}
                  r={edge.failures > 0 ? 4 : 3}
                  fill={color}
                  className="flow-pulse"
                >
                  <animateMotion
                    dur={`${duration}s`}
                    repeatCount="indefinite"
                    begin={`${(duration / pulses) * pulseIndex}s`}
                    path={path}
                  />
                </circle>
              ))}
            </g>
          );
        })}

        {topology.apps.map((app) => {
          const position = positions.get(app.name);
          if (position === undefined) {
            return null;
          }
          const ratio = app.events === 0 ? 0 : app.failures / app.events;
          const circumference = 2 * Math.PI * NODE_R;

          return (
            <g
              key={app.name}
              className="flow-node-group"
              onPointerDown={(event) => drag.startDrag(app.name, event, position, viewSize)}
              onClick={() => {
                if (!drag.consumeClickSuppression()) {
                  onSelectApp(app.name);
                }
              }}
              role="button"
              aria-label={`Filter events to ${app.name}`}
            >
              <title>
                {app.name}: {app.events} flow event{app.events === 1 ? "" : "s"}
                {app.failures > 0 ? `, ${app.failures} failures` : ", no failures"} — click to open,
                drag to rearrange
              </title>
              <circle cx={position.x} cy={position.y} r={NODE_R} className="flow-node" />
              <circle
                cx={position.x}
                cy={position.y}
                r={NODE_R}
                className="flow-health-ring"
                stroke={healthColor(app.failures, app.events)}
                strokeDasharray={
                  ratio === 0
                    ? undefined
                    : `${circumference * (1 - ratio)} ${circumference * ratio}`
                }
                transform={`rotate(-90 ${position.x} ${position.y})`}
              />
              {ratio > 0 ? (
                <circle
                  cx={position.x}
                  cy={position.y}
                  r={NODE_R}
                  className="flow-failure-arc"
                  strokeDasharray={`${circumference * ratio} ${circumference * (1 - ratio)}`}
                  transform={`rotate(${-90 + 360 * (1 - ratio)} ${position.x} ${position.y})`}
                />
              ) : null}
              <text
                x={position.x}
                y={position.y + 4}
                className="flow-node-initials"
                fill={applicationColor(app.name)}
              >
                {app.name.slice(0, 2).toUpperCase()}
              </text>
              <text
                x={position.x}
                y={position.y + NODE_R + 15}
                className="flow-node-label"
                fill={applicationColor(app.name)}
              >
                {app.name.length > 20 ? `${app.name.slice(0, 19)}…` : app.name}
              </text>
              <text x={position.x} y={position.y + NODE_R + 27} className="flow-node-count">
                {app.events} ev{app.failures > 0 ? ` · ${Math.round(ratio * 100)}% fail` : ""}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}
