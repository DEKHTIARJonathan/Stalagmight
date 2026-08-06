/**
 * Which map gestures the active tool leaves to MapLibre.
 *
 * Plain left-drag pans the map under every tool (#409). Two modes take the
 * gesture back, because in each the drag itself is the interaction:
 *  - the zoom tool, where dragging draws the zoom box;
 *  - placement mode, which confirms on pointerdown, so a drag would drop the
 *    station at the press point instead of where the finger ended.
 *
 * Carrying a move ghost is deliberately NOT one of them. The drop is
 * click-gated instead: MapCanvas's `handlePointerUp` commits only when the
 * press-to-release travel stays inside `CUSTOM_PAN_CLAIM_PX` (MapLibre's own
 * `clickTolerance`), so a press that actually travels is a PAN and leaves the
 * ghost in flight, still following the cursor. That is also why carrying keeps
 * `touchAction: 'manipulation'`: on touch, a one-finger drag pans and a tap
 * drops.
 */

import type { ToolType } from '../store/uiStore';

export interface MapGestureMode {
  dragPan: boolean;
  touchAction: 'none' | 'manipulation';
}

export function mapGestureMode(args: {
  activeTool: ToolType;
  placementActive: boolean;
}): MapGestureMode {
  const modal = args.placementActive || args.activeTool === 'zoom';
  return {
    dragPan: !modal,
    touchAction: modal ? 'none' : 'manipulation',
  };
}
