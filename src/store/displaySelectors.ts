/**
 * Display toggle defaults and selectors for computing effective display values.
 *
 * DISPLAY_DEFAULTS is the SINGLE SOURCE OF TRUTH for display toggle default values.
 * It is used by uiStore for both initial state and resetDisplaySettings.
 *
 * The effective value selectors compute the "effective" visibility of dependent toggles,
 * which depends on both the toggle's own state and its parent toggle's state.
 */

import type { ShotKind } from '../types/ipc/ShotKind';

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
  showJumps: true,
  showZeroDatum: true,
  showGrid: false,
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
 * Compute effective visibility of jump shots (#27).
 * Same shape as the reference selector: jumps need the master shots toggle too.
 */
export function getEffectiveShowJumps(showShots: boolean, showJumps: boolean): boolean {
  return showShots && showJumps;
}

/**
 * Is a shot of this kind currently drawn on the map? (#27)
 *
 * The one predicate every "the user hid this geometry, so drop the thing
 * attached to it" effect should use. Jumps and References became independent
 * toggles, so testing `kind !== 'Normal'` against the reference toggle alone -
 * which is what the mechanical `is_reference` rewrite left behind - treats a
 * still-visible jump as hidden, and silently discards its selection, its
 * measure snap, or its contribution to a fit-bounds.
 *
 * An unresolvable shot (`undefined`, e.g. a lookup that raced a project
 * refresh) reads as Normal. That matches the backend's `ShotKind::from_u8`
 * fallback and is the conservative answer here too: "visible" means the caller
 * leaves it alone rather than throwing away user state on a transient miss.
 */
export function isShotKindVisible(
  kind: ShotKind | undefined,
  showShots: boolean,
  showJumps: boolean,
  showReferenceShots: boolean
): boolean {
  if (!showShots) return false;
  if (kind === 'Jump') return getEffectiveShowJumps(showShots, showJumps);
  if (kind === 'Reference') return getEffectiveShowReferenceShots(showShots, showReferenceShots);
  return true;
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
 * Station comments are visible when showStationComments is true, regardless of station visibility.
 */
export function getEffectiveShowStationComments(_showStations: boolean, showStationComments: boolean): boolean {
  return showStationComments;
}

/**
 * Compute effective visibility of shot comments.
 * Shot comments are only visible when both showShots AND showShotComments are true.
 */
export function getEffectiveShowShotComments(showShots: boolean, showShotComments: boolean): boolean {
  return showShots && showShotComments;
}
