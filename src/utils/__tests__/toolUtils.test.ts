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
  });
});
