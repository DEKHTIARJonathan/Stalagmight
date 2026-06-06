import { describe, it, expect } from 'vitest';
import {
  TOOL_GROUPS,
  getGroupForTool,
  isGroupedTool,
  getStandaloneTools,
} from '../toolGroups';

// ---------------------------------------------------------------------------
// TOOL_GROUPS constant
// ---------------------------------------------------------------------------

describe('TOOL_GROUPS', () => {
  it('contains navigate and move groups', () => {
    const ids = TOOL_GROUPS.map((g) => g.id);
    expect(ids).toContain('navigate');
    expect(ids).toContain('move');
  });

  it('navigate group contains pan and zoom', () => {
    const nav = TOOL_GROUPS.find((g) => g.id === 'navigate')!;
    expect(nav.tools).toContain('pan');
    expect(nav.tools).toContain('zoom');
    expect(nav.defaultTool).toBe('pan');
  });

  it('move group contains move_segment, move_shot, move_station', () => {
    const move = TOOL_GROUPS.find((g) => g.id === 'move')!;
    expect(move.tools).toContain('move_segment');
    expect(move.tools).toContain('move_shot');
    expect(move.tools).toContain('move_station');
    expect(move.defaultTool).toBe('move_segment');
  });
});

// ---------------------------------------------------------------------------
// getGroupForTool
// ---------------------------------------------------------------------------

describe('getGroupForTool', () => {
  it('returns navigate group for pan', () => {
    const group = getGroupForTool('pan');
    expect(group).toBeDefined();
    expect(group!.id).toBe('navigate');
  });

  it('returns navigate group for zoom', () => {
    const group = getGroupForTool('zoom');
    expect(group).toBeDefined();
    expect(group!.id).toBe('navigate');
  });

  it('returns move group for move_station', () => {
    const group = getGroupForTool('move_station');
    expect(group).toBeDefined();
    expect(group!.id).toBe('move');
  });

  it('returns undefined for standalone tools', () => {
    expect(getGroupForTool('select')).toBeUndefined();
    expect(getGroupForTool('merge')).toBeUndefined();
    expect(getGroupForTool('measure')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// isGroupedTool
// ---------------------------------------------------------------------------

describe('isGroupedTool', () => {
  it('returns true for grouped tools', () => {
    expect(isGroupedTool('pan')).toBe(true);
    expect(isGroupedTool('zoom')).toBe(true);
    expect(isGroupedTool('move_segment')).toBe(true);
    expect(isGroupedTool('move_shot')).toBe(true);
    expect(isGroupedTool('move_station')).toBe(true);
  });

  it('returns false for standalone tools', () => {
    expect(isGroupedTool('select')).toBe(false);
    expect(isGroupedTool('merge')).toBe(false);
    expect(isGroupedTool('measure')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// getStandaloneTools
// ---------------------------------------------------------------------------

describe('getStandaloneTools', () => {
  it('excludes all grouped tools', () => {
    const standalone = getStandaloneTools();
    expect(standalone).not.toContain('pan');
    expect(standalone).not.toContain('zoom');
    expect(standalone).not.toContain('move_segment');
    expect(standalone).not.toContain('move_shot');
    expect(standalone).not.toContain('move_station');
  });

  it('includes standalone tools', () => {
    const standalone = getStandaloneTools();
    expect(standalone).toContain('select');
    expect(standalone).toContain('merge');
    expect(standalone).toContain('measure');
  });

  it('returns consistent results on repeated calls', () => {
    const first = getStandaloneTools();
    const second = getStandaloneTools();
    expect(first).toEqual(second);
  });
});
