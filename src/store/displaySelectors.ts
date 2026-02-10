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
  showReferenceShots: true,
  showZeroDatum: true,
  showGrid: false,
  showScaleBar: true,
  showSatellite: false,
  showDepthGradient: false,
  showStationComments: false,
  showShotComments: false,
  showDevStats: false,
  gridSpacing: 10,
} as const;

/**
 * Compute effective visibility of reference shots.
 * Reference shots are only visible when both showShots AND showReferenceShots are true.
 */
export function getEffectiveShowReferenceShots(showShots: boolean, showReferenceShots: boolean): boolean {
  return showShots && showReferenceShots;
}

/**
 * Compute effective visibility of shot data labels.
 * Shot data is only visible when both showShots AND showShotData are true.
 */
export function getEffectiveShowShotData(showShots: boolean, showShotData: boolean): boolean {
  return showShots && showShotData;
}

/**
 * Compute effective visibility of station comments.
 * Station comments are only visible when both showStations AND showStationComments are true.
 */
export function getEffectiveShowStationComments(showStations: boolean, showStationComments: boolean): boolean {
  return showStations && showStationComments;
}

/**
 * Compute effective visibility of shot comments.
 * Shot comments are only visible when both showShots AND showShotComments are true.
 */
export function getEffectiveShowShotComments(showShots: boolean, showShotComments: boolean): boolean {
  return showShots && showShotComments;
}
