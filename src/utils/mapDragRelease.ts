/**
 * Ending MapLibre drags that are RELEASED outside the map canvas.
 *
 * MapLibre's mouse drag handlers implement `mouseup` only, and that name is
 * dispatched from a listener bound on the map's canvas container; a release
 * anywhere else in the document arrives as `mouseupWindow`, which no drag
 * handler implements. A left-drag released over floating chrome (dock reveal
 * handles, dialog frames, MapLibre's own navigation/scale controls in the
 * sibling control container) therefore never reaches dragEnd: the map stays
 * "moving" - and events that hang off it, like `moveend`, never fire - until
 * some later mousemove self-heals it. Forwarding the real mouseup into the
 * handler manager ends the drag through the normal path (deferred
 * dragend/moveend, inertia preserved).
 *
 * Forwarding is idempotent: dragEnd early-returns when no drag is in flight,
 * so a release that had nothing to do with the map is a no-op. That is what
 * makes several simultaneously-mounted maps safe - each attaches its own
 * forwarder, and the ones whose drag is not live simply do nothing.
 */

import type { Map as MaplibreMap } from 'maplibre-gl';

/**
 * The map to forward to, either directly or - for callers that hold it in a
 * ref that may be empty when the forwarder is attached, or replaced later -
 * as an accessor resolved at event time.
 */
export type DragReleaseMapSource = MaplibreMap | (() => MaplibreMap | null | undefined);

/**
 * Forward mouse releases that land outside `map`'s canvas container into that
 * map's handler manager, so drags released over surrounding chrome still end.
 *
 * @returns an unregister function; call it before `map.remove()`.
 */
export function attachDragReleaseForwarder(source: DragReleaseMapSource): () => void {
  const handleMouseUpOutsideCanvas = (e: MouseEvent) => {
    const map = typeof source === 'function' ? source() : source;
    if (!map) return;
    // MapLibre's own container listener already ends drags released in there;
    // forwarding those as well would dispatch `mouseup` to the handlers twice.
    const canvasContainer = map.getCanvasContainer();
    if (e.target instanceof Node && canvasContainer.contains(e.target)) return;
    // Dispatching with no event name runs the plain `mouseup` handlers, i.e.
    // dragEnd. Guarded so a future MapLibre without these public members
    // degrades to the old (stuck drag) behavior instead of throwing.
    const handlers = map.handlers as { handleEvent?: (event: Event) => void } | undefined;
    if (typeof handlers?.handleEvent === 'function') {
      handlers.handleEvent(e);
    }
  };

  window.addEventListener('mouseup', handleMouseUpOutsideCanvas, { capture: true });
  return () => {
    window.removeEventListener('mouseup', handleMouseUpOutsideCanvas, { capture: true });
  };
}
