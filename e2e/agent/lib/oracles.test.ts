/**
 * Unit tests for the leftover-temp oracle's filename match. The sweep only
 * reports what this predicate selects, so a staging suffix it cannot see is a
 * silently-passing `check_problems` (issue #270): the SpeleoDB dump extract
 * stages at `<file>.download.tmp`, which is NOT `.stalx.tmp`, in exactly the
 * directory the oracle scans.
 */
import { describe, expect, it } from 'vitest';
import { isLeftoverTempName } from './oracles';

describe('isLeftoverTempName', () => {
  it('matches the atomic-save staging file (core/save.rs)', () => {
    expect(isLeftoverTempName('project.stalx.tmp')).toBe(true);
  });

  it('matches the SpeleoDB dump staging file (speleodb/dump.rs)', () => {
    // download_temp_path() appends to the WHOLE file name, so the `.stalx` stays
    // in the middle and the name does not end in `.stalx.tmp`.
    expect(isLeftoverTempName('project.stalx.download.tmp')).toBe(true);
  });

  it('ignores the project itself and unrelated neighbours', () => {
    expect(isLeftoverTempName('project.stalx')).toBe(false);
    expect(isLeftoverTempName('project.tml')).toBe(false);
    expect(isLeftoverTempName('notes.txt')).toBe(false);
    // A bare `.tmp` from something else is not ours to report.
    expect(isLeftoverTempName('scratch.tmp')).toBe(false);
  });
});
