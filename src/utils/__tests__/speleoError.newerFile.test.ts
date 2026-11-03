/**
 * [#576 NF-W9BE-1] NEWER_FILE_READ_ONLY is the code a refused SAVE of a project a
 * newer Stalagmight saved carries - and also the code a SpeleoDB verb refuses such a
 * project with before any save: a download that would install it (open, View,
 * Restore, Update), Start editing, Force edit. The humanizer read every one of them
 * as a refused save, "Not saved: ...", for an open or a Start editing that saved
 * nothing. It now says what happened - the project is from a newer version, update
 * to edit it - unless the verb saves first (Push, Done, Publish), where the refused
 * save's own wording stands.
 */
import { describe, expect, it } from 'vitest';

import i18n from '../../i18n';
import { humanizeSpeleoError } from '../speleoError';
import type { CommandErrorCode } from '../../types/ipc/CommandErrorCode';

const dto = (code: CommandErrorCode, message: string) => ({ code, message });

// The backend's words for the two refusal shapes (speleodb_pull.rs
// refuse_a_newer_download, AppState::newer_file_refusal); the UI never shows them.
const DOWNLOAD_REFUSED = dto(
  'NEWER_FILE_READ_ONLY',
  'this project on SpeleoDB was saved by a newer version of Stalagmight (file format 99), so it was not downloaded and your copy is unchanged. Update Stalagmight to open it.',
);
const VERB_REFUSED = dto('NEWER_FILE_READ_ONLY', 'this project was saved by a newer version of Stalagmight');

const noPeriod = (s: string) => s.replace(/\.\s*$/, '');

describe('humanizeSpeleoError: a newer-version refusal outside a save (#576 NF-W9BE-1)', () => {
  it.each([
    ['an open / download', DOWNLOAD_REFUSED, 'speleodb.errors.openFailed'],
    ['a revision restore', DOWNLOAD_REFUSED, 'speleodb.restore.failed'],
    ['Start editing', VERB_REFUSED, 'speleodb.editBar.toasts.startFailed'],
  ] as const)('%s reads as a project from a newer version, not as a refused save', (_what, err, prefixKey) => {
    const prefix = i18n.t(prefixKey);
    const shown = humanizeSpeleoError(err, prefix);

    expect(shown).toBe(`${prefix}: ${noPeriod(i18n.t('banners.newerFile.lead'))}`);
    expect(shown).not.toContain(noPeriod(i18n.t('banners.newerFile.saveRefused')));
    expect(shown).not.toMatch(/Not saved/);
  });

  it('a verb that saves first (Push, Done, Publish) keeps the refused-save wording', () => {
    const prefix = i18n.t('speleodb.editBar.toasts.pushFailed');

    expect(humanizeSpeleoError(VERB_REFUSED, prefix, { saves: true })).toBe(
      `${prefix}: ${noPeriod(i18n.t('banners.newerFile.saveRefused'))}`,
    );
  });

  it('the save context changes nothing for the other save refusals', () => {
    const notFound = dto('FS_PATH_NOT_FOUND', 'Failed to save project: the folder is gone');

    expect(humanizeSpeleoError(notFound, 'X')).toBe(humanizeSpeleoError(notFound, 'X', { saves: true }));
    expect(humanizeSpeleoError(notFound, 'X')).toBe(`X: ${noPeriod(i18n.t('banners.autosave.pathNotFound'))}`);
  });
});
