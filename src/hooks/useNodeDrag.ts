/**
 * Dragging flow-map nodes, and remembering where they were put.
 *
 * Two decisions are worth keeping together with the code that depends on
 * them:
 *
 * - Listeners go on the window, not on the node. Pointer capture on an SVG
 *   element proved unreliable in the webview once the pointer outran the
 *   node it started on, which read to a user as the node "getting stuck".
 * - The canvas size is frozen for the duration of a drag. A canvas that
 *   grows as a node approaches its edge shifts the screen-to-viewBox
 *   transform under the pointer, and the node drifts away from the cursor.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import {
  FLOW_LAYOUT_CLEARED_EVENT,
  clearFlowLayout,
  loadFlowLayout,
  saveFlowLayout,
} from "../lib/settings";
import { clampPosition, type NodePosition } from "../lib/flow-layout";

type Size = { readonly width: number; readonly height: number };

interface ActiveDrag {
  readonly app: string;
  readonly offsetX: number;
  readonly offsetY: number;
  moved: boolean;
  readonly cleanup: () => void;
}

export interface NodeDrag {
  /** Hand-placed positions, keyed by application name. */
  readonly overrides: Readonly<Record<string, NodePosition>>;
  readonly dragging: boolean;
  /** Size to render at: frozen while a drag is in progress. */
  readonly renderSize: (live: Size) => Size;
  readonly startDrag: (
    app: string,
    event: React.PointerEvent,
    position: NodePosition,
    viewSize: Size,
  ) => void;
  /** True when the click that follows a drag should be ignored. Consumes the flag. */
  readonly consumeClickSuppression: () => boolean;
  readonly resetLayout: () => void;
}

export function useNodeDrag(
  toSvgPoint: (clientX: number, clientY: number) => NodePosition | undefined,
): NodeDrag {
  const [overrides, setOverrides] = useState<Record<string, NodePosition>>(loadFlowLayout);
  const [dragging, setDragging] = useState(false);
  const dragRef = useRef<ActiveDrag | null>(null);
  const suppressClickRef = useRef(false);
  const frozenSizeRef = useRef<Size | null>(null);

  // Detach listeners if the map unmounts mid-drag.
  useEffect(() => () => dragRef.current?.cleanup(), []);

  // Settings can clear the saved layout while the map is mounted.
  useEffect(() => {
    const onCleared = (): void => setOverrides({});
    window.addEventListener(FLOW_LAYOUT_CLEARED_EVENT, onCleared);
    return () => window.removeEventListener(FLOW_LAYOUT_CLEARED_EVENT, onCleared);
  }, []);

  const endDrag = useCallback((): void => {
    const drag = dragRef.current;
    if (drag === null) {
      return;
    }
    drag.cleanup();
    suppressClickRef.current = drag.moved;
    dragRef.current = null;
    frozenSizeRef.current = null;
    setDragging(false);
    setOverrides((current) => {
      saveFlowLayout(current);
      return current;
    });
  }, []);

  const startDrag = useCallback(
    (app: string, event: React.PointerEvent, position: NodePosition, viewSize: Size): void => {
      if (dragRef.current !== null) {
        return;
      }
      const point = toSvgPoint(event.clientX, event.clientY);
      if (point === undefined) {
        return;
      }

      const pointerId = event.pointerId;
      const onMove = (native: PointerEvent): void => {
        const drag = dragRef.current;
        if (drag === null || native.pointerId !== pointerId) {
          return;
        }
        const moved = toSvgPoint(native.clientX, native.clientY);
        if (moved === undefined) {
          return;
        }
        drag.moved = true;
        const next = clampPosition(moved.x + drag.offsetX, moved.y + drag.offsetY);
        setOverrides((current) => ({ ...current, [drag.app]: next }));
      };
      const onEnd = (native: PointerEvent): void => {
        if (native.pointerId === pointerId) {
          endDrag();
        }
      };
      const cleanup = (): void => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onEnd);
        window.removeEventListener("pointercancel", onEnd);
      };

      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onEnd);
      window.addEventListener("pointercancel", onEnd);

      dragRef.current = {
        app,
        offsetX: position.x - point.x,
        offsetY: position.y - point.y,
        moved: false,
        cleanup,
      };
      frozenSizeRef.current = viewSize;
      setDragging(true);
      event.preventDefault();
    },
    [toSvgPoint, endDrag],
  );

  const renderSize = useCallback(
    (live: Size): Size =>
      dragging && frozenSizeRef.current !== null ? frozenSizeRef.current : live,
    [dragging],
  );

  const consumeClickSuppression = useCallback((): boolean => {
    const suppressed = suppressClickRef.current;
    suppressClickRef.current = false;
    return suppressed;
  }, []);

  const resetLayout = useCallback((): void => {
    dragRef.current?.cleanup();
    dragRef.current = null;
    frozenSizeRef.current = null;
    setDragging(false);
    clearFlowLayout();
  }, []);

  return { overrides, dragging, renderSize, startDrag, consumeClickSuppression, resetLayout };
}
