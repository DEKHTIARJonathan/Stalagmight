/**
 * Unit tests for the active-geometry selectors.
 */
import { describe, it, expect } from 'vitest';
import {
  selectActiveStations,
  selectActiveSurveyData,
  type GeometrySlice,
} from '../geometrySelectors';
import type { Station } from '../../types/project';
import type { SurveyData } from '../../types/survey-data';

const measuredStations = [{ tag: 'measured' } as unknown as Station];
const adjustedStations = [{ tag: 'adjusted' } as unknown as Station];
const measuredSurvey = { tag: 'measured' } as unknown as SurveyData;
const adjustedSurvey = { tag: 'adjusted' } as unknown as SurveyData;

const full: GeometrySlice = {
  stations: measuredStations,
  surveyData: measuredSurvey,
  stationsAdjusted: adjustedStations,
  surveyDataAdjusted: adjustedSurvey,
};

describe('geometrySelectors', () => {
  it('returns the measured set in measured mode', () => {
    expect(selectActiveStations(full, 'measured')).toBe(measuredStations);
    expect(selectActiveSurveyData(full, 'measured')).toBe(measuredSurvey);
  });

  it('returns the adjusted set in closureAdjusted mode', () => {
    expect(selectActiveStations(full, 'closureAdjusted')).toBe(adjustedStations);
    expect(selectActiveSurveyData(full, 'closureAdjusted')).toBe(adjustedSurvey);
  });

  it('falls back to measured when the adjusted set is not yet available', () => {
    const slice: GeometrySlice = { ...full, stationsAdjusted: null, surveyDataAdjusted: null };
    expect(selectActiveStations(slice, 'closureAdjusted')).toBe(measuredStations);
    expect(selectActiveSurveyData(slice, 'closureAdjusted')).toBe(measuredSurvey);
  });
});
