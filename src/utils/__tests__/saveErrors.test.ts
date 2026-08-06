import { describe, it, expect } from 'vitest';
import {
  FS_PATH_NOT_FOUND,
  FS_PATH_TOO_LONG,
  FS_PERMISSION_DENIED,
  classifySaveError,
  isPathError,
  isPermissionError,
} from '../saveErrors';

describe('isPermissionError', () => {
  it('detects the backend permission marker prefix', () => {
    expect(
      isPermissionError(`${FS_PERMISSION_DENIED}: Failed to create save file: ...`)
    ).toBe(true);
  });

  it('does not flag unrelated save errors', () => {
    // The crux: a real corruption / generic failure must not be treated as a
    // permission problem (which would show the wrong remediation).
    expect(isPermissionError('Failed to save project: disk full')).toBe(false);
    expect(isPermissionError('Database integrity check failed')).toBe(false);
  });

  it('does not flag a destination failure', () => {
    // #429: the missing-folder and over-MAX_PATH markers used to arrive as
    // FS_PERMISSION_DENIED, which is what put Windows users in front of the
    // macOS folder-access dialog.
    expect(isPermissionError(`${FS_PATH_NOT_FOUND}: Cannot save to Z:\\cave.stalx`)).toBe(false);
    expect(isPermissionError(`${FS_PATH_TOO_LONG}: Failed to create save file`)).toBe(false);
  });

  it('handles null/undefined safely', () => {
    expect(isPermissionError(null)).toBe(false);
    expect(isPermissionError(undefined)).toBe(false);
    expect(isPermissionError('')).toBe(false);
  });
});

describe('classifySaveError', () => {
  it('maps each backend marker to its own kind', () => {
    expect(classifySaveError(`${FS_PERMISSION_DENIED}: denied`)).toBe('permission');
    expect(classifySaveError(`${FS_PATH_NOT_FOUND}: the folder no longer exists`)).toBe(
      'path-not-found'
    );
    expect(classifySaveError(`${FS_PATH_TOO_LONG}: too long`)).toBe('path-too-long');
  });

  it('treats an unmarked error - and no error at all - as other', () => {
    expect(classifySaveError('Failed to save project: no space left on device')).toBe('other');
    expect(classifySaveError(null)).toBe('other');
    expect(classifySaveError(undefined)).toBe('other');
  });
});

describe('isPathError', () => {
  it('covers both destination failures and nothing else', () => {
    expect(isPathError(`${FS_PATH_NOT_FOUND}: gone`)).toBe(true);
    expect(isPathError(`${FS_PATH_TOO_LONG}: 335 chars`)).toBe(true);
    expect(isPathError(`${FS_PERMISSION_DENIED}: denied`)).toBe(false);
    expect(isPathError('Failed to save project')).toBe(false);
    expect(isPathError(null)).toBe(false);
  });
});
