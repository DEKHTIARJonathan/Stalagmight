import { describe, it, expect } from 'vitest';
import { getDeleteShotDialog, deriveRangeDeleteParams } from '../contextMenuHelpers';

describe('getDeleteShotDialog', () => {
  const sectionId = 1;
  const shotId = 10;
  const sectionName = 'Main Passage';

  it('returns confirm-delete with type=last-shot when totalShots is 1', () => {
    const result = getDeleteShotDialog(sectionId, shotId, true, true, 1, sectionName);
    expect(result.dialog).toBe('confirm-delete');
    expect(result.data.type).toBe('last-shot');
    expect(result.data.sectionId).toBe(sectionId);
    expect(result.data.shotId).toBe(shotId);
    expect(result.data.sectionName).toBe(sectionName);
  });

  it('returns delete-shot-choice for mid-section shot (not first, not last, totalShots >= 3)', () => {
    const result = getDeleteShotDialog(sectionId, shotId, false, false, 5, sectionName);
    expect(result.dialog).toBe('delete-shot-choice');
    expect(result.data.sectionId).toBe(sectionId);
    expect(result.data.shotId).toBe(shotId);
  });

  it('returns confirm-delete with type=shot for first shot in multi-shot section', () => {
    const result = getDeleteShotDialog(sectionId, shotId, true, false, 3, sectionName);
    expect(result.dialog).toBe('confirm-delete');
    expect(result.data.type).toBe('shot');
    expect(result.data.isFirst).toBe(true);
    expect(result.data.isLast).toBe(false);
  });

  it('returns confirm-delete with type=shot for last shot in multi-shot section', () => {
    const result = getDeleteShotDialog(sectionId, shotId, false, true, 4, sectionName);
    expect(result.dialog).toBe('confirm-delete');
    expect(result.data.type).toBe('shot');
    expect(result.data.isFirst).toBe(false);
    expect(result.data.isLast).toBe(true);
  });

  it('returns confirm-delete for edge-shot when totalShots is 2 (no true mid-shot possible)', () => {
    // With totalShots=2, isFirst=false, isLast=false shouldn't happen, but
    // the guard (totalShots >= 3) protects against it
    const result = getDeleteShotDialog(sectionId, shotId, false, false, 2, sectionName);
    expect(result.dialog).toBe('confirm-delete');
    expect(result.data.type).toBe('shot');
  });

  it('returns confirm-delete for invalid state (totalShots <= 0)', () => {
    const result = getDeleteShotDialog(sectionId, shotId, false, false, 0, sectionName);
    expect(result.dialog).toBe('confirm-delete');
    expect(result.data.type).toBe('shot');
  });

  it('includes totalShots in edge-shot data', () => {
    const result = getDeleteShotDialog(sectionId, shotId, true, false, 5, sectionName);
    expect(result.data.totalShots).toBe(5);
  });
});

describe('deriveRangeDeleteParams', () => {
  it('classifies a whole-section range', () => {
    expect(deriveRangeDeleteParams(0, 4, 5)).toEqual({
      kind: 'whole',
      removesSection: true,
      splitRequired: false,
    });
  });

  it('classifies a prefix range (starts at shot 0, shots remain after)', () => {
    expect(deriveRangeDeleteParams(0, 1, 5)).toEqual({
      kind: 'prefix',
      removesSection: false,
      splitRequired: false,
    });
  });

  it('classifies a suffix range (ends at last shot, shots remain before)', () => {
    expect(deriveRangeDeleteParams(3, 4, 5)).toEqual({
      kind: 'suffix',
      removesSection: false,
      splitRequired: false,
    });
  });

  it('classifies an interior range as split-required', () => {
    expect(deriveRangeDeleteParams(1, 3, 5)).toEqual({
      kind: 'interior',
      removesSection: false,
      splitRequired: true,
    });
  });

  it('treats a two-shot interior selection as interior', () => {
    expect(deriveRangeDeleteParams(2, 3, 6)).toEqual({
      kind: 'interior',
      removesSection: false,
      splitRequired: true,
    });
  });
});
