import { describe, expect, it } from 'vitest';
import {
  systemCardTestId,
  systemRowTestId,
  warningMessageTestId,
  warningOpenShotTestId,
  warningResolveTestId,
  warningUndoResolveTestId,
} from '../testId';

describe('test ID contracts', () => {
  it('encodes filesystem paths used by project cards and rows', () => {
    expect(systemCardTestId('/projects/cave alpha.stalx')).toBe('system-card-%2Fprojects%2Fcave%20alpha.stalx');
    expect(systemRowTestId('/projects/cave alpha.stalx')).toBe('system-row-%2Fprojects%2Fcave%20alpha.stalx');
  });

  it('keeps warning B stable after warning A leaves the list', () => {
    const warningA = { sectionId: 1, shotId: 2, code: 'LENGTH' };
    const warningB = { sectionId: 3, shotId: 8, code: 'DEPTH_DIFF', datumStationIndex: 2 };
    const before = [warningA, warningB].map(warningResolveTestId);
    const after = [warningB].map(warningResolveTestId);

    expect(after[0]).toBe(before[1]);
    expect(after[0]).toBe('warning-3%3A8%3ADEPTH_DIFF%3Ad2-resolve');
    expect(warningUndoResolveTestId(warningB)).toBe('warning-3%3A8%3ADEPTH_DIFF%3Ad2-undo-resolve');
    expect(warningMessageTestId(warningB)).toBe('warning-3%3A8%3ADEPTH_DIFF%3Ad2-message');
    expect(warningOpenShotTestId(warningB)).toBe('warning-3%3A8%3ADEPTH_DIFF%3Ad2-open-shot');
  });
});
