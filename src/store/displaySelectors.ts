/**
 * Display toggle defaults and selectors for computing effective display values.
 *
 * DISPLAY_DEFAULTS is the SINGLE SOURCE OF TRUTH for display toggle default values.
 * It is used by uiStore for both initial state and resetDisplaySettings.
 *
 * The effective value selectors compute the "effective" visibility of dependent toggles,
 * which depends on both the toggle's own state and its parent toggle's state.
 */

/**
 * Display toggle defaults. This is the SINGLE SOURCE OF TRUTH for default values.
 * Used by uiStore for initial state and resetDisplaySettings.
 */
export const DISPLAY_DEFAULTS = {
  showStations: true,
  showShots: true,
  showSectionNames: true,
  showStationLabels: false,
  showShotData: false,
  showVirtualShots: true,
  showZeroDatum: true,
  showGrid: false,
  showScaleBar: true,
  showSatellite: false,
  showDepthGradient: false,
  gridSpacing: 10,
} as const;

/**
 * Compute effective visibility of virtual shots.
 * Virtual shots are only visible when both showShots AND showVirtualShots are true.
 */
export function getEffectiveShowVirtualShots(showShots: boolean, showVirtualShots: boolean): boolean {
  return showShots && showVirtualShots;
}

/**
 * Compute effective visibility of shot data labels.
 * Shot data is only visible when both showShots AND showShotData are true.
 */
export function getEffectiveShowShotData(showShots: boolean, showShotData: boolean): boolean {
  return showShots && showShotData;
}
