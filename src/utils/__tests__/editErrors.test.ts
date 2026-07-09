import { describe, it, expect } from 'vitest';
import {
  EDIT_DISABLED,
  EDIT_REVERIFY_DIVERGED,
  READ_ONLY_EDIT_NOTICE,
  humanizeEditError,
  isEditDisabledError,
  isReverifyDivergedError,
} from '../editErrors';

describe('isEditDisabledError', () => {
  it('matches a prefixed read-only edit-gate rejection', () => {
    expect(
      isEditDisabledError(`${EDIT_DISABLED}: Move station is disabled: this SpeleoDB project is open read-only.`)
    ).toBe(true);
  });

  it('is false for unrelated errors, null, and undefined', () => {
    expect(isEditDisabledError('Some other failure')).toBe(false);
    expect(isEditDisabledError('')).toBe(false);
    expect(isEditDisabledError(null)).toBe(false);
    expect(isEditDisabledError(undefined)).toBe(false);
  });

  it('only matches at the start of the string (mirrors the backend prefix)', () => {
    expect(isEditDisabledError(`prefix ${EDIT_DISABLED}`)).toBe(false);
  });
});

describe('humanizeEditError', () => {
  it('replaces a raw EDIT_DISABLED rejection with the friendly notice', () => {
    expect(
      humanizeEditError(`${EDIT_DISABLED}: Set comment on station 0:2 is disabled: read-only.`, 'fallback'),
    ).toBe(READ_ONLY_EDIT_NOTICE);
  });

  it('passes an unrelated error through unchanged', () => {
    expect(humanizeEditError('Disk full', 'fallback')).toBe('Disk full');
  });

  it('uses the fallback when the error is null or undefined', () => {
    expect(humanizeEditError(null, 'fallback')).toBe('fallback');
    expect(humanizeEditError(undefined, 'fallback')).toBe('fallback');
  });
});

describe('isReverifyDivergedError', () => {
  it('matches a prefixed #202 re-verify divergence rejection', () => {
    expect(
      isReverifyDivergedError(
        `${EDIT_REVERIFY_DIVERGED}: the SpeleoDB lock or server version changed - reconcile before editing.`,
      ),
    ).toBe(true);
  });

  it('is distinct from the plain read-only gate and unrelated errors', () => {
    // A plain read-only rejection must NOT read as a divergence (different routing).
    expect(isReverifyDivergedError(`${EDIT_DISABLED}: Move station is disabled.`)).toBe(false);
    expect(isReverifyDivergedError('Some other failure')).toBe(false);
    expect(isReverifyDivergedError(null)).toBe(false);
    expect(isReverifyDivergedError(undefined)).toBe(false);
  });
});
