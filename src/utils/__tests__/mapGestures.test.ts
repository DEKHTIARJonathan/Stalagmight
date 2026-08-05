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
  describe('idle (no placement, no move drag)', () => {
    it.each(PANNING_TOOLS)('%s pans on drag', (activeTool) => {
      expect(mapGestureMode({ activeTool, placementActive: false, moveDragActive: false }))
        .toEqual({ dragPan: true, touchAction: 'manipulation' });
    });

    it('zoom keeps the drag for its zoom box', () => {
      expect(mapGestureMode({ activeTool: 'zoom', placementActive: false, moveDragActive: false }))
        .toEqual({ dragPan: false, touchAction: 'none' });
    });
  });

  describe('placement mode', () => {
    it.each(ALL_TOOLS)('%s stops panning', (activeTool) => {
      expect(mapGestureMode({ activeTool, placementActive: true, moveDragActive: false }))
        .toEqual({ dragPan: false, touchAction: 'none' });
    });
  });

  describe('move drag in flight', () => {
    it.each(ALL_TOOLS)('%s stops panning', (activeTool) => {
      expect(mapGestureMode({ activeTool, placementActive: false, moveDragActive: true }))
        .toEqual({ dragPan: false, touchAction: 'none' });
    });
  });

  it('both modal flags together still stop panning', () => {
    expect(mapGestureMode({ activeTool: 'select', placementActive: true, moveDragActive: true }))
      .toEqual({ dragPan: false, touchAction: 'none' });
  });
});
