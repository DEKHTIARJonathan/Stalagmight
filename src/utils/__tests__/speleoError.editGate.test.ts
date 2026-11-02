/**
 * [#576 RV2-R-15] A SpeleoDB verb refused by the edit gate shows the gate's notice,
 * never its coded markers.
 *
 * Restore revision and Unwind are now refused in the read-only Plan and Export
 * workspaces with the same `EDIT_DISABLED: WORKSPACE_READ_ONLY: ...` refusal every
 * other survey change gets. Those dialogs render the error through
 * `humanizeSpeleoError`, which used to pass the raw coded string through.
 */
import { describe, expect, it } from 'vitest';

import i18n from '../../i18n';
import { humanizeSpeleoError } from '../speleoError';

const refusal = (what: string, mode: string) => ({
  message: `EDIT_DISABLED: WORKSPACE_READ_ONLY: ${what} is disabled: the ${mode} workspace is read-only. Switch to Survey to edit.`,
  action: 'Fatal',
  status: null,
  transport: null,
});

describe('humanizeSpeleoError and the edit gate (#576 RV2-R-15)', () => {
  it.each([
    ['Restore revision', 'Plan'],
    ['Unwind', 'Export'],
  ])('shows the workspace notice for a refused %s in %s', (what, mode) => {
    const shown = humanizeSpeleoError(refusal(what, mode), 'Could not restore the revision');
    expect(shown).toBe(i18n.t('editGate.workspaceReadOnlyNotice'));
    expect(shown).not.toContain('EDIT_DISABLED');
    expect(shown).not.toContain('WORKSPACE_READ_ONLY');
  });

  it('still frames every other SpeleoDB error with its operation', () => {
    const shown = humanizeSpeleoError(
      { message: 'Server error.', action: 'Retry', status: 503, transport: null },
      'Could not restore the revision',
    );
    expect(shown).toBe('Could not restore the revision: Server error');
  });
});
