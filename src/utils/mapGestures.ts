/**
 * Which map gestures the active tool leaves to MapLibre.
 *
 * Plain left-drag pans the map under every tool (#409). Three modes take the
 * gesture back, because in each the drag itself is the interaction:
 *  - the zoom tool, where dragging draws the zoom box;
 *  - placement mode, which confirms on pointerdown, so a drag would drop the
 *    station at the press point instead of where the finger ended;
 *  - carrying a move ghost, whose drop fires on pointerup - MapLibre's
 *    clickTolerance gates clicks, not that.
 */

import type { ToolType } from '../store/uiStore';

export interface MapGestureMode {
  dragPan: boolean;
  touchAction: 'none' | 'manipulation';
}

export function mapGestureMode(args: {
  activeTool: ToolType;
  placementActive: boolean;
  moveDragActive: boolean;
}): MapGestureMode {
  const modal = args.placementActive || args.moveDragActive || args.activeTool === 'zoom';
  return {
    dragPan: !modal,
    touchAction: modal ? 'none' : 'manipulation',
  };
}
