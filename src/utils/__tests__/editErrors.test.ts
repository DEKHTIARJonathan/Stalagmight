import { describe, it, expect } from 'vitest';
import i18n from '../../i18n';
import {
  EDIT_DISABLED,
  EDIT_REVERIFY_DIVERGED,
  READ_ONLY_EDIT_NOTICE,
  WORKSPACE_READ_ONLY,
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

describe('READ_ONLY_EDIT_NOTICE', () => {
  it('names the read-only workspace for a Plan/Export refusal (#576 C5)', () => {
    const error = `${EDIT_DISABLED}: ${WORKSPACE_READ_ONLY}: Move station 1:1 is disabled: the Plan workspace is read-only.`;
    expect(isEditDisabledError(error)).toBe(true);
    expect(READ_ONLY_EDIT_NOTICE(error)).toBe(i18n.t('editGate.workspaceReadOnlyNotice'));
    expect(READ_ONLY_EDIT_NOTICE(error)).not.toBe(i18n.t('editGate.readOnlyNotice'));
  });

  it('keeps the lock notice for a SpeleoDB refusal and the version notice for a newer file', () => {
    expect(READ_ONLY_EDIT_NOTICE(`${EDIT_DISABLED}: Undo is disabled: this SpeleoDB project is open read-only.`)).toBe(
      i18n.t('editGate.readOnlyNotice'),
    );
    expect(READ_ONLY_EDIT_NOTICE(`${EDIT_DISABLED}: NEWER_FILE_READ_ONLY: Undo is disabled: newer.`)).toBe(
      i18n.t('editGate.newerFileNotice'),
    );
  });
});

// [#576 RV5-F4-5] The adoption hand-over refusal carries its own second code, so
// the notice says the project is being handed over instead of inviting a Start
// editing click in the middle of the adoption's own lock operations.
describe('READ_ONLY_EDIT_NOTICE during a SpeleoDB adoption', () => {
  const error =
    'EDIT_DISABLED: ADOPTION_IN_PROGRESS: Move station 1:1 is disabled: this project is being handed over to ' +
    'SpeleoDB. Edit it once the upload has finished.';

  it('says the project is being handed over, not "click Start editing"', () => {
    const notice = READ_ONLY_EDIT_NOTICE(error);
    console.log(`[RV5-F4-5] notice for an adoption refusal: "${notice}"`);
    expect(isEditDisabledError(error)).toBe(true);
    expect(notice).toBe(i18n.t('editGate.adoptionInProgressNotice'));
    expect(notice).not.toBe(i18n.t('editGate.readOnlyNotice'));
    expect(notice).not.toMatch(/Start editing/);
  });
});
