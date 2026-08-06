/**
 * Unit tests for mapGestures - which tools/modes leave drag to MapLibre (#409).
 */

import { describe, it, expect } from 'vitest';
import { mapGestureMode } from '../mapGestures';
import type { ToolType } from '../../store/uiStore';

/** Every member of `ToolType`. The annotation is the guard: dropping a tool
 *  from `ToolType` reds this file, so the tables below cannot go quietly out
 *  of date. */
const ALL_TOOLS: ToolType[] = [
  'select', 'pan', 'zoom', 'merge', 'measure',
  'move_station', 'move_segment', 'move_shot',
  'comment', 'move_comment',
];

/** Every tool that pans on a plain left-drag: all of them except zoom. */
const PANNING_TOOLS = ALL_TOOLS.filter((t) => t !== 'zoom');

describe('mapGestureMode', () => {
  describe('idle (no placement)', () => {
    it.each(PANNING_TOOLS)('%s pans on drag', (activeTool) => {
      expect(mapGestureMode({ activeTool, placementActive: false }))
        .toEqual({ dragPan: true, touchAction: 'manipulation' });
    });

    it('zoom keeps the drag for its zoom box', () => {
      expect(mapGestureMode({ activeTool: 'zoom', placementActive: false }))
        .toEqual({ dragPan: false, touchAction: 'none' });
    });
  });

  describe('placement mode', () => {
    it.each(ALL_TOOLS)('%s stops panning', (activeTool) => {
      expect(mapGestureMode({ activeTool, placementActive: true }))
        .toEqual({ dragPan: false, touchAction: 'none' });
    });
  });

  /**
   * A move ghost in flight is NOT modal any more: the drop is click-gated in
   * MapCanvas, so a press that travels pans the map and the ghost stays up. The
   * predicate cannot see the ghost at all - which is the assertion here: the
   * move tools answer exactly like every other panning tool, whether or not
   * something is being carried.
   */
  describe('the move tools (carrying or not)', () => {
    it.each<ToolType>(['move_station', 'move_segment', 'move_shot'])(
      '%s pans on drag; the drop is a click, not the drag',
      (activeTool) => {
        expect(mapGestureMode({ activeTool, placementActive: false }))
          .toEqual({ dragPan: true, touchAction: 'manipulation' });
      },
    );
  });

  it('placement still wins over a move tool', () => {
    expect(mapGestureMode({ activeTool: 'move_station', placementActive: true }))
      .toEqual({ dragPan: false, touchAction: 'none' });
  });
});
