/**
 * Unit tests for toolUtils - NON_INTERACTIVE_TOOLS and isNonInteractiveTool.
 */

import { describe, it, expect } from 'vitest';
import {
  isNonInteractiveTool,
  navigationToolsEnabled,
  NON_INTERACTIVE_TOOLS,
  shouldResetNavigationTool,
  toolCursor,
} from '../toolUtils';
import type { ToolType } from '../../store/uiStore';
import type { Config } from '../../types/config';
import { defaultConfig } from '../../types/config';

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

  describe('navigationToolsEnabled (#409)', () => {
    const withSetting = (show: boolean): Config => ({
      ...defaultConfig,
      map: {
        ...defaultConfig.map,
        controls: { ...defaultConfig.map.controls, show_navigation_tools: show },
      },
    });

    // config is null between mount and loadConfig() resolving. Hiding the tools is
    // the safe answer there: showing them and yanking them away a tick later is the
    // visible failure, and anything that RESETS state guards on config != null.
    it('is false while the config has not loaded yet', () => {
      expect(navigationToolsEnabled(null)).toBe(false);
      expect(navigationToolsEnabled(undefined)).toBe(false);
    });

    it('is false by default', () => {
      expect(navigationToolsEnabled(defaultConfig)).toBe(false);
    });

    it('reads the setting off a loaded config', () => {
      expect(navigationToolsEnabled(withSetting(true))).toBe(true);
      expect(navigationToolsEnabled(withSetting(false))).toBe(false);
    });

    describe('shouldResetNavigationTool', () => {
      it('kicks a navigation tool once a loaded config hides the group', () => {
        expect(shouldResetNavigationTool(withSetting(false), 'pan')).toBe(true);
        expect(shouldResetNavigationTool(withSetting(false), 'zoom')).toBe(true);
      });

      // The boot-kick regression this predicate exists to prevent: config is null
      // until loadConfig() resolves, and a user whose SAVED setting is on may have
      // Pan/Zoom as their restored tool. Resetting on the null placeholder would
      // kick them off it before the real config ever arrived.
      it('never fires while the config has not loaded, whatever the tool', () => {
        expect(shouldResetNavigationTool(null, 'pan')).toBe(false);
        expect(shouldResetNavigationTool(undefined, 'zoom')).toBe(false);
      });

      it('leaves the tool alone when the group is shown or the tool is not navigation', () => {
        expect(shouldResetNavigationTool(withSetting(true), 'pan')).toBe(false);
        expect(shouldResetNavigationTool(withSetting(false), 'select')).toBe(false);
      });
    });
  });
});
