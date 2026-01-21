/**
 * Unit tests for toolUtils - NON_INTERACTIVE_TOOLS and isNonInteractiveTool.
 */

import { describe, it, expect } from 'vitest';
import { isNonInteractiveTool, NON_INTERACTIVE_TOOLS } from '../toolUtils';

describe('toolUtils', () => {
  describe('NON_INTERACTIVE_TOOLS', () => {
    it('includes pan', () => {
      expect(NON_INTERACTIVE_TOOLS).toContain('pan');
    });

    it('includes zoom', () => {
      expect(NON_INTERACTIVE_TOOLS).toContain('zoom');
    });

    it('does not include select', () => {
      expect(NON_INTERACTIVE_TOOLS).not.toContain('select');
    });

    it('does not include draw', () => {
      expect(NON_INTERACTIVE_TOOLS).not.toContain('draw');
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

    it('returns false for draw', () => {
      expect(isNonInteractiveTool('draw')).toBe(false);
    });

    it('returns false for delete', () => {
      expect(isNonInteractiveTool('delete')).toBe(false);
    });

    it('returns false for merge', () => {
      expect(isNonInteractiveTool('merge')).toBe(false);
    });

    it('returns false for measure', () => {
      expect(isNonInteractiveTool('measure')).toBe(false);
    });

    it('returns false for move_section', () => {
      expect(isNonInteractiveTool('move_section')).toBe(false);
    });

    it('returns false for move_station', () => {
      expect(isNonInteractiveTool('move_station')).toBe(false);
    });
  });
});
