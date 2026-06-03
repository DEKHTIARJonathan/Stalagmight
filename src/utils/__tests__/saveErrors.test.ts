import { describe, it, expect } from 'vitest';
import { FS_PERMISSION_DENIED, isPermissionError } from '../saveErrors';

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

  it('handles null/undefined safely', () => {
    expect(isPermissionError(null)).toBe(false);
    expect(isPermissionError(undefined)).toBe(false);
    expect(isPermissionError('')).toBe(false);
  });
});
