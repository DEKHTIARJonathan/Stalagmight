/**
 * Unit tests for toolUtils - NON_INTERACTIVE_TOOLS and isNonInteractiveTool.
 */

import { describe, it, expect } from 'vitest';
import { isNonInteractiveTool, NON_INTERACTIVE_TOOLS, toolCursor } from '../toolUtils';
import type { ToolType } from '../../store/uiStore';

/** Every member of `ToolType`. The annotation is the guard: dropping a tool
 *  from `ToolType` reds this file, so the exhaustiveness case below cannot go
 *  quietly out of date. */
const ALL_TOOLS: ToolType[] = [
  'select', 'pan', 'zoom', 'merge', 'measure',
  'move_station', 'move_segment', 'move_shot',
  'comment', 'move_comment',
];

describe('toolUtils', () => {
  describe('NON_INTERACTIVE_TOOLS', () => {
    it('includes pan', () => {
      expect(NON_INTERACTIVE_TOOLS).toContain('pan');
    });

    it('includes zoom', () => {
      expect(NON_INTERACTIVE_TOOLS).toContain('zoom');
    });
  });

  describe('isNonInteractiveTool', () => {
    it('returns true for pan', () => {
      expect(isNonInteractiveTool('pan')).toBe(true);
    });

    it('returns true for zoom', () => {
      expect(isNonInteractiveTool('zoom')).toBe(true);
    });

    it('returns false for select', () => {
      expect(isNonInteractiveTool('select')).toBe(false);
    });
  });

  describe('toolCursor', () => {
    // #316: three copies of this table had drifted apart in MapCanvas, and a
    // blank answer from any one of them is what erased the active tool's
    // cursor. Both properties below are what the single owner has to hold.
    it('gives every tool a non-empty cursor', () => {
      for (const tool of ALL_TOOLS) {
        expect(toolCursor(tool), `tool "${tool}" has no cursor`).not.toBe('');
      }
    });

    it('pins the canonical cursor per tool', () => {
      expect(ALL_TOOLS.map(toolCursor)).toEqual([
        'default',    // select
        'grab',       // pan
        'zoom-in',    // zoom
        'cell',       // merge
        'crosshair',  // measure
        'move',       // move_station
        'move',       // move_segment
        'move',       // move_shot
        'crosshair',  // comment
        'crosshair',  // move_comment
      ]);
    });

    it('falls back to the arrow for a value from outside the type system', () => {
      expect(toolCursor('not_a_tool' as ToolType)).toBe('default');
    });
  });
});
