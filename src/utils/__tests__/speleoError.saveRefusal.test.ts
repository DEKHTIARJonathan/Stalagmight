/**
 * [#576 NF-W2SAVE-1] A Done/Push whose pre-push save refused says why, in the
 * words a refused save gets - never with the save's routing marker.
 *
 * The backend used to answer every refused pre-push flush with "failed to flush
 * project before push". It now passes the save's own reason through, marker and
 * all, and the push-failure banner renders it through `humanizeSpeleoError`.
 */
import { describe, expect, it } from 'vitest';

import i18n from '../../i18n';
import { humanizeSpeleoError } from '../speleoError';

const dto = (message: string) => ({ message, action: 'Fatal', status: null, transport: null });

describe('humanizeSpeleoError and a refused pre-push save (#576 NF-W2SAVE-1)', () => {
  it.each([
    [
      'PROJECT_SETTINGS_UNREADABLE: Can\'t save: this project\'s stored validation thresholds could not be read when it was opened.',
      () => i18n.t('banners.settingsUnreadable.saveRefused'),
    ],
    [
      'NEWER_FILE_READ_ONLY: Saving is disabled: this project was saved by a newer version of Stalagmight.',
      () => i18n.t('banners.newerFile.saveRefused'),
    ],
    [
      'FS_PATH_NOT_FOUND: Failed to save project: the folder is gone',
      () => i18n.t('banners.autosave.pathNotFound'),
    ],
  ])('names the save refusal without its marker: %s', (message, expected) => {
    const shown = humanizeSpeleoError(dto(message), 'Could not push changes');
    // The operation frame drops a trailing period, as for every SpeleoDB error.
    expect(shown).toBe(`Could not push changes: ${expected().replace(/\.\s*$/, '')}`);
    expect(shown).not.toMatch(/[A-Z_]{8,}:/);
  });

  it('relays an unmarked save failure as the backend wrote it', () => {
    expect(humanizeSpeleoError(dto('Failed to save project: disk full.'), 'Could not push changes')).toBe(
      'Could not push changes: Failed to save project: disk full',
    );
  });
});
