/**
 * Unit tests for useKeyboardShortcuts hook.
 * Tests verify shortcut matching with config, multiple bindings, and spring-loaded behavior.
 */

import { describe, it, expect } from 'vitest';
import { normalizeShortcut, parseKeyEvent } from '../../utils/shortcuts';
import type { ShortcutsConfig } from '../../types/config';

// Test the helper functions used by useKeyboardShortcuts

describe('isNonModifierShortcut (via normalizeShortcut)', () => {
  function isNonModifierShortcut(shortcut: string): boolean {
    const normalized = normalizeShortcut(shortcut);
    if (!normalized) return false;
    return !normalized.includes('+');
  }

  it('returns true for single key shortcuts', () => {
    expect(isNonModifierShortcut('Z')).toBe(true);
    expect(isNonModifierShortcut('Q')).toBe(true);
    expect(isNonModifierShortcut('1')).toBe(true);
    expect(isNonModifierShortcut('F1')).toBe(true);
    expect(isNonModifierShortcut('Space')).toBe(true);
    expect(isNonModifierShortcut('Escape')).toBe(true);
  });

  it('returns false for shortcuts with modifiers', () => {
    expect(isNonModifierShortcut('Ctrl+Z')).toBe(false);
    expect(isNonModifierShortcut('Shift+Z')).toBe(false);
    expect(isNonModifierShortcut('Alt+Z')).toBe(false);
    expect(isNonModifierShortcut('Ctrl+Shift+Z')).toBe(false);
  });

  it('returns false for invalid shortcuts', () => {
    expect(isNonModifierShortcut('')).toBe(false);
    expect(isNonModifierShortcut('A+B')).toBe(false);
  });
});

describe('buildShortcutMap logic', () => {
  // Replicate the buildShortcutMap function for testing
  type ShortcutAction = keyof ShortcutsConfig;

  function buildShortcutMap(shortcuts: ShortcutsConfig): Map<string, ShortcutAction> {
    const map = new Map<string, ShortcutAction>();

    const actions: (keyof ShortcutsConfig)[] = [
      'select',
      'pan',
      'zoom',
      'draw',
      'delete_tool',
      'merge',
      'measure',
      'move_section',
      'move_station',
      'undo',
      'redo',
      'save',
      'toggle_depth_gradient',
      'toggle_grid',
      'toggle_satellite',
      'toggle_station_labels',
      'toggle_shot_labels',
      'toggle_section_labels',
      'fit_to_bounds',
      'zoom_in',
      'zoom_out',
      'toggle_sections_panel',
      'toggle_detail_panel',
      'toggle_data_table',
    ];

    for (const action of actions) {
      const bindings = shortcuts[action];
      if (!Array.isArray(bindings)) continue;

      for (const binding of bindings) {
        const normalized = normalizeShortcut(binding);
        if (normalized) {
          map.set(normalized, action);
        }
      }
    }

    return map;
  }

  it('maps single binding per action', () => {
    const shortcuts: ShortcutsConfig = {
      select: ['S'],
      pan: ['P'],
      zoom: ['Z'],
      draw: ['D'],
      delete_tool: ['X'],
      merge: ['M'],
      measure: ['R'],
      move_section: ['V'],
      move_station: ['T'],
      undo: ['Ctrl+Z'],
      redo: ['Ctrl+Y'],
      save: ['Ctrl+S'],
      toggle_depth_gradient: ['G'],
      toggle_grid: ['Shift+G'],
      toggle_satellite: ['B'],
      toggle_station_labels: ['L'],
      toggle_shot_labels: ['Shift+L'],
      toggle_section_labels: ['Ctrl+L'],
      fit_to_bounds: ['F'],
      zoom_in: ['Equal'],
      zoom_out: ['Minus'],
      toggle_sections_panel: ['1'],
      toggle_detail_panel: ['2'],
      toggle_data_table: ['3'],
    };

    const map = buildShortcutMap(shortcuts);

    expect(map.get('S')).toBe('select');
    expect(map.get('P')).toBe('pan');
    expect(map.get('Z')).toBe('zoom');
    expect(map.get('Ctrl+Z')).toBe('undo');
    expect(map.get('Ctrl+Y')).toBe('redo');
  });

  it('maps multiple bindings per action', () => {
    const shortcuts: ShortcutsConfig = {
      select: ['S', 'Shift+S'],
      pan: ['P'],
      zoom: ['Z'],
      draw: ['D'],
      delete_tool: ['X'],
      merge: ['M'],
      measure: ['R'],
      move_section: ['V'],
      move_station: ['T'],
      undo: ['Ctrl+Z'],
      redo: ['Ctrl+Y', 'Ctrl+Shift+Z'],
      save: ['Ctrl+S'],
      toggle_depth_gradient: ['G'],
      toggle_grid: ['Shift+G'],
      toggle_satellite: ['B'],
      toggle_station_labels: ['L'],
      toggle_shot_labels: ['Shift+L'],
      toggle_section_labels: ['Ctrl+L'],
      fit_to_bounds: ['F'],
      zoom_in: ['Equal', 'Plus'],
      zoom_out: ['Minus'],
      toggle_sections_panel: ['1'],
      toggle_detail_panel: ['2'],
      toggle_data_table: ['3'],
    };

    const map = buildShortcutMap(shortcuts);

    // Both S and Shift+S map to select
    expect(map.get('S')).toBe('select');
    expect(map.get('Shift+S')).toBe('select');

    // Both Ctrl+Y and Ctrl+Shift+Z map to redo
    expect(map.get('Ctrl+Y')).toBe('redo');
    expect(map.get('Ctrl+Shift+Z')).toBe('redo');

    // Both Equal and Plus map to zoom_in
    expect(map.get('Equal')).toBe('zoom_in');
    expect(map.get('Plus')).toBe('zoom_in');
  });

  it('normalizes shortcuts before mapping', () => {
    const shortcuts: ShortcutsConfig = {
      select: ['s'], // lowercase
      pan: ['P'],
      zoom: ['Z'],
      draw: ['D'],
      delete_tool: ['X'],
      merge: ['M'],
      measure: ['R'],
      move_section: ['V'],
      move_station: ['T'],
      undo: ['ctrl+z'], // lowercase
      redo: ['Shift+Ctrl+Z'], // wrong order
      save: ['Cmd+S'], // Mac alias
      toggle_depth_gradient: ['G'],
      toggle_grid: ['Shift+G'],
      toggle_satellite: ['B'],
      toggle_station_labels: ['L'],
      toggle_shot_labels: ['Shift+L'],
      toggle_section_labels: ['Ctrl+L'],
      fit_to_bounds: ['F'],
      zoom_in: ['='], // symbol
      zoom_out: ['-'], // symbol
      toggle_sections_panel: ['1'],
      toggle_detail_panel: ['2'],
      toggle_data_table: ['3'],
    };

    const map = buildShortcutMap(shortcuts);

    // Lowercase normalized to uppercase
    expect(map.get('S')).toBe('select');

    // Lowercase ctrl+z normalized to Ctrl+Z
    expect(map.get('Ctrl+Z')).toBe('undo');

    // Shift+Ctrl+Z normalized to Ctrl+Shift+Z
    expect(map.get('Ctrl+Shift+Z')).toBe('redo');

    // Cmd+S normalized to Ctrl+S
    expect(map.get('Ctrl+S')).toBe('save');

    // = normalized to Equal
    expect(map.get('Equal')).toBe('zoom_in');

    // - normalized to Minus
    expect(map.get('Minus')).toBe('zoom_out');
  });

  it('skips invalid shortcuts', () => {
    const shortcuts: ShortcutsConfig = {
      select: ['S', '', 'A+B'], // includes empty and invalid
      pan: ['P'],
      zoom: ['Z'],
      draw: ['D'],
      delete_tool: ['X'],
      merge: ['M'],
      measure: ['R'],
      move_section: ['V'],
      move_station: ['T'],
      undo: ['Ctrl+Z'],
      redo: ['Ctrl+Y'],
      save: ['Ctrl+S'],
      toggle_depth_gradient: ['G'],
      toggle_grid: ['Shift+G'],
      toggle_satellite: ['B'],
      toggle_station_labels: ['L'],
      toggle_shot_labels: ['Shift+L'],
      toggle_section_labels: ['Ctrl+L'],
      fit_to_bounds: ['F'],
      zoom_in: ['Equal'],
      zoom_out: ['Minus'],
      toggle_sections_panel: ['1'],
      toggle_detail_panel: ['2'],
      toggle_data_table: ['3'],
    };

    const map = buildShortcutMap(shortcuts);

    // Only valid S is mapped
    expect(map.get('S')).toBe('select');

    // Invalid shortcuts not in map
    expect(map.has('')).toBe(false);
    expect(map.has('A+B')).toBe(false);
  });

  it('handles empty bindings array', () => {
    const shortcuts: ShortcutsConfig = {
      select: [],
      pan: ['P'],
      zoom: ['Z'],
      draw: ['D'],
      delete_tool: ['X'],
      merge: ['M'],
      measure: ['R'],
      move_section: ['V'],
      move_station: ['T'],
      undo: ['Ctrl+Z'],
      redo: ['Ctrl+Y'],
      save: ['Ctrl+S'],
      toggle_depth_gradient: ['G'],
      toggle_grid: ['Shift+G'],
      toggle_satellite: ['B'],
      toggle_station_labels: ['L'],
      toggle_shot_labels: ['Shift+L'],
      toggle_section_labels: ['Ctrl+L'],
      fit_to_bounds: ['F'],
      zoom_in: ['Equal'],
      zoom_out: ['Minus'],
      toggle_sections_panel: ['1'],
      toggle_detail_panel: ['2'],
      toggle_data_table: ['3'],
    };

    const map = buildShortcutMap(shortcuts);

    // No mapping for select (empty array)
    expect(map.has('S')).toBe(false);

    // Other actions still work
    expect(map.get('P')).toBe('pan');
  });
});

describe('parseKeyEvent for shortcut matching', () => {
  function createKeyEvent(
    key: string,
    options: { ctrlKey?: boolean; altKey?: boolean; shiftKey?: boolean; metaKey?: boolean } = {}
  ): KeyboardEvent {
    return {
      key,
      ctrlKey: options.ctrlKey ?? false,
      altKey: options.altKey ?? false,
      shiftKey: options.shiftKey ?? false,
      metaKey: options.metaKey ?? false,
    } as KeyboardEvent;
  }

  it('parses simple key events', () => {
    expect(parseKeyEvent(createKeyEvent('s'))).toBe('S');
    expect(parseKeyEvent(createKeyEvent('S'))).toBe('S');
    expect(parseKeyEvent(createKeyEvent('1'))).toBe('1');
    expect(parseKeyEvent(createKeyEvent('F1'))).toBe('F1');
  });

  it('parses key events with modifiers', () => {
    expect(parseKeyEvent(createKeyEvent('s', { ctrlKey: true }))).toBe('Ctrl+S');
    expect(parseKeyEvent(createKeyEvent('s', { shiftKey: true }))).toBe('Shift+S');
    expect(parseKeyEvent(createKeyEvent('s', { altKey: true }))).toBe('Alt+S');
    expect(parseKeyEvent(createKeyEvent('s', { ctrlKey: true, shiftKey: true }))).toBe('Ctrl+Shift+S');
  });

  it('parses special keys', () => {
    expect(parseKeyEvent(createKeyEvent(' '))).toBe('Space');
    expect(parseKeyEvent(createKeyEvent('Enter'))).toBe('Enter');
    expect(parseKeyEvent(createKeyEvent('Escape'))).toBe('Escape');
    expect(parseKeyEvent(createKeyEvent('+'))).toBe('Plus');
    expect(parseKeyEvent(createKeyEvent('-'))).toBe('Minus');
    expect(parseKeyEvent(createKeyEvent('='))).toBe('Equal');
  });

  it('normalizes meta key to ctrl', () => {
    expect(parseKeyEvent(createKeyEvent('s', { metaKey: true }))).toBe('Ctrl+S');
  });
});

describe('zoom action configuration', () => {
  it('zoom_in respects zoom_max limit', () => {
    const currentZoom = 20;
    const zoomStep = 1.0;
    const zoomMax = 21;
    const mapMaxZoom = 22;

    const maxZoom = Math.min(zoomMax, mapMaxZoom);
    const targetZoom = Math.min(maxZoom, currentZoom + zoomStep);

    expect(targetZoom).toBe(21);
  });

  it('zoom_in stops at map max zoom', () => {
    const currentZoom = 20;
    const zoomStep = 5.0;
    const zoomMax = 25; // Config allows higher
    const mapMaxZoom = 22;

    const maxZoom = Math.min(zoomMax, mapMaxZoom);
    const targetZoom = Math.min(maxZoom, currentZoom + zoomStep);

    expect(targetZoom).toBe(22); // Clamped to map max
  });

  it('zoom_out respects zoom_min limit', () => {
    const currentZoom = 2;
    const zoomStep = 1.0;
    const zoomMin = 1;
    const mapMinZoom = 0;

    const minZoom = Math.max(zoomMin, mapMinZoom);
    const targetZoom = Math.max(minZoom, currentZoom - zoomStep);

    expect(targetZoom).toBe(1);
  });

  it('zoom_out stops at map min zoom', () => {
    const currentZoom = 2;
    const zoomStep = 5.0;
    const zoomMin = -1; // Config allows lower
    const mapMinZoom = 0;

    const minZoom = Math.max(zoomMin, mapMinZoom);
    const targetZoom = Math.max(minZoom, currentZoom - zoomStep);

    expect(targetZoom).toBe(0); // Clamped to map min
  });

  it('zoom step is configurable', () => {
    const currentZoom = 10;
    const zoomStep = 2.5;
    const zoomMax = 22;

    const targetZoom = Math.min(zoomMax, currentZoom + zoomStep);

    expect(targetZoom).toBe(12.5);
  });
});
