/**
 * Theme color utilities for reading CSS custom properties at runtime.
 *
 * MapLibre GL JS does NOT read CSS variables directly. Colors passed to
 * setPaintProperty(), addLayer(), and style expressions must be literal
 * string values. This module reads CSS variables via getComputedStyle()
 * and provides a complete color map for MapLibre paint properties.
 *
 * Colors are computed once per theme change, not per feature/per frame.
 */

/**
 * Fallback map with dark-theme defaults for each --cc-* variable.
 * Prevents empty strings if called before CSS loads or during unusual mount timing.
 */
const FALLBACK_MAP: Record<string, string> = {
  '--cc-background': '#1a1a2e',
  '--cc-panel': '#16213e',
  '--cc-border': '#0f3460',
  '--cc-text-primary': '#f5f5f5',
  '--cc-text-secondary': '#a0a0a0',
  '--cc-accent': '#4ecdc4',
  '--cc-accent-on': '#1a1a2e',
  '--cc-stroke-color': '#ffffff',
  '--cc-stroke-light': 'rgba(255, 255, 255, 0.25)',
  '--cc-text-halo': '#1a1a2e',
  '--cc-text-halo-alt': 'rgba(0, 0, 0, 0.7)',
  '--cc-station-default': '#a0a0a0',
  '--cc-gray-line': '#666666',
  '--cc-gray-text': '#999999',
  '--cc-grid-default': '#333366',
  '--cc-zero-datum': '#ffd700',
  '--cc-compass-color': '#ffffff',
  '--cc-depth-shallow': '#4ecdc4',
  '--cc-depth-deep': '#ff6b6b',
  '--cc-depth-text': '#f5f5f5',
  '--cc-preview-bg': '#1a1a2e',
  '--cc-preview-text': '#f5f5f5',
  '--cc-snap-color': '#ff6b6b',
  '--cc-hover-highlight': '#ffcb77',
  '--cc-select-highlight': '#4ecdc4',
  '--cc-error': '#ff6b6b',
  '--cc-success': '#95e1d3',
};

/**
 * Read a CSS custom property value from the document root.
 * Returns the computed value or a fallback default if the variable is empty.
 */
export function getThemeColor(varName: string): string {
  if (typeof document === 'undefined') {
    return FALLBACK_MAP[varName] ?? '';
  }
  const value = getComputedStyle(document.documentElement).getPropertyValue(varName).trim();
  return value || (FALLBACK_MAP[varName] ?? '');
}

/**
 * Complete color map for MapLibre paint properties.
 * Called once on mount and again when resolvedTheme changes.
 */
export interface MapThemeColors {
  background: string;
  strokeColor: string;
  textHalo: string;
  textHaloAlt: string;
  stationDefault: string;
  zeroDatum: string;
  depthShallow: string;
  depthDeep: string;
  labelColor: string;
  grayLine: string;
  grayText: string;
  gridDefault: string;
  compassColor: string;
  previewBg: string;
  snapColor: string;
  hoverHighlight: string;
  selectHighlight: string;
}

/**
 * Returns a complete color map for MapLibre paint properties.
 * All values are literal CSS color strings read from CSS variables.
 */
export function getMapThemeColors(): MapThemeColors {
  return {
    background: getThemeColor('--cc-background'),
    strokeColor: getThemeColor('--cc-stroke-color'),
    textHalo: getThemeColor('--cc-text-halo'),
    textHaloAlt: getThemeColor('--cc-text-halo-alt'),
    stationDefault: getThemeColor('--cc-station-default'),
    zeroDatum: getThemeColor('--cc-zero-datum'),
    depthShallow: getThemeColor('--cc-depth-shallow'),
    depthDeep: getThemeColor('--cc-depth-deep'),
    labelColor: getThemeColor('--cc-depth-text'),
    grayLine: getThemeColor('--cc-gray-line'),
    grayText: getThemeColor('--cc-gray-text'),
    gridDefault: getThemeColor('--cc-grid-default'),
    compassColor: getThemeColor('--cc-compass-color'),
    previewBg: getThemeColor('--cc-preview-bg'),
    snapColor: getThemeColor('--cc-snap-color'),
    hoverHighlight: getThemeColor('--cc-hover-highlight'),
    selectHighlight: getThemeColor('--cc-select-highlight'),
  };
}
