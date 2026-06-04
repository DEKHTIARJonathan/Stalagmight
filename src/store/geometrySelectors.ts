/**
 * Selectors for picking the active cave geometry based on the display mode.
 *
 * The project store always holds the raw `measured` geometry in
 * `stations`/`surveyData` (the source of truth used by stats, data tables, and
 * editing). The closure-adjusted geometry is fetched lazily into
 * `stationsAdjusted`/`surveyDataAdjusted`. These selectors pick whichever set
 * matches the current `geometryMode`, falling back to measured when the adjusted
 * set hasn't been fetched yet or was invalidated by an edit.
 */
import type { Station } from '../types/project';
import type { SurveyData } from '../types/survey-data';
import type { GeometryMode } from './uiStore';

/**
 * Minimal slice of the project store needed to resolve the active geometry.
 * Declared locally (rather than importing the full store type) to avoid a
 * module cycle with projectStore.
 */
export interface GeometrySlice {
  stations: Station[];
  surveyData: SurveyData | null;
  stationsAdjusted: Station[] | null;
  surveyDataAdjusted: SurveyData | null;
}

/**
 * Station coordinates for the active mode. Falls back to the measured set when
 * the adjusted set is unavailable (not yet fetched / invalidated).
 */
export function selectActiveStations(s: GeometrySlice, mode: GeometryMode): Station[] {
  if (mode === 'closureAdjusted' && s.stationsAdjusted) {
    return s.stationsAdjusted;
  }
  return s.stations;
}

/**
 * Struct-of-arrays survey data for the active mode (measured fallback).
 */
export function selectActiveSurveyData(
  s: GeometrySlice,
  mode: GeometryMode
): SurveyData | null {
  if (mode === 'closureAdjusted' && s.surveyDataAdjusted) {
    return s.surveyDataAdjusted;
  }
  return s.surveyData;
}
