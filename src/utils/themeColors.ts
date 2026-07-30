import { themeTokens } from '../theme/tokens';
import { SEVERITY_GREEN, SEVERITY_YELLOW, SEVERITY_RED } from './colors';

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
 * Keep in sync with src/theme/tokens.ts (tests enforce parity with CSS).
 */
const FALLBACK_MAP: Record<string, string> = { ...themeTokens.dark };

// Issue-severity ("traffic light") colors for the map's Issue-severity Display
// mode. Fixed (not theme-derived) so severity reads identically across UI themes.
// NB do not read this as a shared convention with the depth-gradient endpoints:
// those became theme-derived below, in this same file. Single-sourced from
// src/utils/colors.ts (same palette as getErrorColor).
const SEVERITY_CLEAR = SEVERITY_GREEN;
const SEVERITY_WARNING = SEVERITY_YELLOW;
const SEVERITY_ERROR = SEVERITY_RED;

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
  /** Issue-severity coloring (fixed across themes). */
  severityClear: string;
  severityWarning: string;
  severityError: string;
}

/**
 * Returns a complete color map for MapLibre paint properties.
 * All values are literal CSS color strings read from CSS variables.
 */
export function getMapThemeColors(): MapThemeColors {
  return {
    background: getThemeColor('--cc-map-background'),
    strokeColor: getThemeColor('--cc-stroke-color'),
    textHalo: getThemeColor('--cc-text-halo'),
    textHaloAlt: getThemeColor('--cc-text-halo-alt'),
    stationDefault: getThemeColor('--cc-station-default'),
    zeroDatum: getThemeColor('--cc-zero-datum'),
    // Read per theme, like every other map colour. These used to be pinned to the
    // dark values so depth reads identically across themes, but that only holds
    // while every canvas is dark: on the light theme's #faf7f2 paper the dark
    // endpoints draw shallow passages at 1.81:1 and their dark-theme labels at
    // 1.02:1, i.e. the survey is unreadable in depth mode. (Measured, not averaged:
    // an earlier revision of this comment said "roughly 1.5:1", which was neither
    // figure.) A theme that wants the canonical
    // gradient declares the canonical values; kaleido_eink already declared its
    // own and was silently ignored here.
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
    severityClear: SEVERITY_CLEAR,
    severityWarning: SEVERITY_WARNING,
    severityError: SEVERITY_ERROR,
  };
}
