/**
 * Unit tests for DetailLink component helper functions.
 *
 * Tests focus on the exported utility functions for test ID and aria-label generation.
 * Component integration is tested via Playwright.
 */

import { describe, it, expect } from 'vitest';
import { generateTestId, generateAriaLabel, type DetailLinkType, type DetailLinkTarget } from '../DetailLink';

describe('generateTestId', () => {
  describe('station links', () => {
    it('generates correct test ID for station', () => {
      const target: DetailLinkTarget = { sectionId: 2, position: 5 };
      expect(generateTestId('station', target)).toBe('station-2-5-link');
    });

    it('generates correct test ID for first station in first section', () => {
      const target: DetailLinkTarget = { sectionId: 1, position: 1 };
      expect(generateTestId('station', target)).toBe('station-1-1-link');
    });

    it('handles large numbers', () => {
      const target: DetailLinkTarget = { sectionId: 123, position: 456 };
      expect(generateTestId('station', target)).toBe('station-123-456-link');
    });
  });

  describe('shot links', () => {
    it('generates correct test ID for shot', () => {
      const target: DetailLinkTarget = { sectionId: 2, position: 3 };
      expect(generateTestId('shot', target)).toBe('shot-2-3-link');
    });

    it('generates correct test ID for first shot', () => {
      const target: DetailLinkTarget = { sectionId: 1, position: 1 };
      expect(generateTestId('shot', target)).toBe('shot-1-1-link');
    });

    it('handles large numbers', () => {
      const target: DetailLinkTarget = { sectionId: 99, position: 88 };
      expect(generateTestId('shot', target)).toBe('shot-99-88-link');
    });
  });

  describe('section links', () => {
    it('generates correct test ID for section', () => {
      const target: DetailLinkTarget = { sectionId: 2 };
      expect(generateTestId('section', target)).toBe('section-2-link');
    });

    it('ignores position for section links', () => {
      const target: DetailLinkTarget = { sectionId: 5, position: 99 };
      expect(generateTestId('section', target)).toBe('section-5-link');
    });

    it('generates correct test ID for first section', () => {
      const target: DetailLinkTarget = { sectionId: 1 };
      expect(generateTestId('section', target)).toBe('section-1-link');
    });
  });

  describe('edge cases', () => {
    it('handles undefined position for station (though invalid usage)', () => {
      const target: DetailLinkTarget = { sectionId: 1 };
      // This would be invalid usage, but function should not crash
      expect(generateTestId('station', target)).toBe('station-1-undefined-link');
    });

    it('handles zero values (edge case)', () => {
      const target: DetailLinkTarget = { sectionId: 0, position: 0 };
      expect(generateTestId('shot', target)).toBe('shot-0-0-link');
    });
  });
});

describe('generateAriaLabel', () => {
  describe('station labels', () => {
    it('generates correct aria-label for station', () => {
      expect(generateAriaLabel('station', '2:5')).toBe('Select station 2:5');
    });

    it('handles station with name', () => {
      expect(generateAriaLabel('station', '1:1 (Entrance)')).toBe('Select station 1:1 (Entrance)');
    });
  });

  describe('shot labels', () => {
    it('generates correct aria-label for shot', () => {
      expect(generateAriaLabel('shot', '2:3')).toBe('Select shot 2:3');
    });

    it('handles shot with additional info', () => {
      expect(generateAriaLabel('shot', '5:10')).toBe('Select shot 5:10');
    });
  });

  describe('section labels', () => {
    it('generates correct aria-label for section', () => {
      expect(generateAriaLabel('section', '2: Main Passage')).toBe('Select section 2: Main Passage');
    });

    it('handles unnamed section', () => {
      expect(generateAriaLabel('section', '3: Unnamed')).toBe('Select section 3: Unnamed');
    });

    it('handles section with just ID', () => {
      expect(generateAriaLabel('section', '1')).toBe('Select section 1');
    });
  });

  describe('display text variations', () => {
    it('handles empty display text', () => {
      expect(generateAriaLabel('station', '')).toBe('Select station ');
    });

    it('handles special characters in display text', () => {
      expect(generateAriaLabel('section', '1: Cave "A"')).toBe('Select section 1: Cave "A"');
    });

    it('handles numbers only', () => {
      expect(generateAriaLabel('shot', '123')).toBe('Select shot 123');
    });
  });
});

describe('type safety', () => {
  it('accepts all valid link types', () => {
    const types: DetailLinkType[] = ['station', 'shot', 'section'];
    const target: DetailLinkTarget = { sectionId: 1, position: 1 };

    for (const type of types) {
      const testId = generateTestId(type, target);
      expect(testId).toContain('-link');

      const ariaLabel = generateAriaLabel(type, '1:1');
      expect(ariaLabel).toContain('Select');
    }
  });

  it('target requires sectionId', () => {
    const validTarget: DetailLinkTarget = { sectionId: 1 };
    expect(validTarget.sectionId).toBe(1);
    expect(validTarget.position).toBeUndefined();
  });

  it('target with position', () => {
    const validTarget: DetailLinkTarget = { sectionId: 1, position: 5 };
    expect(validTarget.sectionId).toBe(1);
    expect(validTarget.position).toBe(5);
  });
});

describe('test ID format consistency', () => {
  it('all test IDs end with -link suffix', () => {
    const targets = [
      { type: 'station' as const, target: { sectionId: 1, position: 1 } },
      { type: 'shot' as const, target: { sectionId: 2, position: 3 } },
      { type: 'section' as const, target: { sectionId: 5 } },
    ];

    for (const { type, target } of targets) {
      const testId = generateTestId(type, target);
      expect(testId).toMatch(/-link$/);
    }
  });

  it('test IDs contain the type', () => {
    const types: DetailLinkType[] = ['station', 'shot', 'section'];
    const target: DetailLinkTarget = { sectionId: 1, position: 1 };

    for (const type of types) {
      const testId = generateTestId(type, target);
      expect(testId).toContain(type);
    }
  });

  it('test IDs use hyphen separators', () => {
    const target: DetailLinkTarget = { sectionId: 2, position: 5 };
    const testId = generateTestId('station', target);

    // Should not contain any other separators
    expect(testId).not.toContain(':');
    expect(testId).not.toContain('_');
    expect(testId).not.toContain(' ');
  });
});

describe('aria-label format consistency', () => {
  it('all aria-labels start with "Select"', () => {
    const types: DetailLinkType[] = ['station', 'shot', 'section'];

    for (const type of types) {
      const ariaLabel = generateAriaLabel(type, 'test');
      expect(ariaLabel).toMatch(/^Select /);
    }
  });

  it('aria-labels include the element type', () => {
    const types: DetailLinkType[] = ['station', 'shot', 'section'];

    for (const type of types) {
      const ariaLabel = generateAriaLabel(type, 'test');
      expect(ariaLabel).toContain(type);
    }
  });

  it('aria-labels include the display text', () => {
    const displayTexts = ['1:1', '5:10', 'Main Passage', '99'];

    for (const displayText of displayTexts) {
      const ariaLabel = generateAriaLabel('station', displayText);
      expect(ariaLabel).toContain(displayText);
    }
  });
});
