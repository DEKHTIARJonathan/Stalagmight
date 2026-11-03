/**
 * #576 NF-AN4-N4: the DMP selection step's duplicate checks swallowed a failed
 * backend call ("graceful degradation"). The check exists to deselect sections the
 * project already holds and to warn about a re-imported file, so a failed check
 * silently let the user import duplicates believing there were none. The dialog
 * still lets them continue - the check is advisory - but now says it could not run.
 *
 * `.tsx` so vitest runs it under jsdom.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

vi.mock('react-i18next', async () => (await import('../../../test/factories/i18n')).i18nKeys('keyAndOptions'));

const store = {
  config: null,
  calculateFileHash: vi.fn(async (_path: string) => 'hash'),
  checkDuplicateImport: vi.fn(async (_hash: string) => false),
  checkSectionHashes: vi.fn(async (hashes: string[]) => hashes.map(() => false)),
};
vi.mock('../../../store/projectStore', () => ({
  useProjectStore: (sel: (s: unknown) => unknown) => sel(store),
}));

vi.mock('../DialogWrapper', async () =>
  (await import('../../../test/factories/components')).dialogWrapperStub({ testId: true }),
);

import DmpSelectionDialog from '../DmpSelectionDialog';
import type { DmpSection } from '../../../types/commands';
import { makeDmpFile, makeDmpSection, makeDmpShots } from '../../../test/factories/dmp';

const section = (name: string): DmpSection =>
  makeDmpSection({ version: 5, name, shots: makeDmpShots(3), content_hash: `hash-${name}` });

const file = makeDmpFile({ version: 5, sections: [section('AAA'), section('BBB')] });

const renderDialog = () =>
  render(<DmpSelectionDialog dmpFile={file} filePath="/tmp/dive.dmp" onCancel={vi.fn()} onContinue={vi.fn()} />);

describe('DMP selection: a failed duplicate check is said, not swallowed (#576 NF-AN4-N4)', () => {
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    store.calculateFileHash.mockReset().mockImplementation(async () => 'hash');
    store.checkDuplicateImport.mockReset().mockImplementation(async () => false);
    store.checkSectionHashes.mockReset().mockImplementation(async (hashes: string[]) => hashes.map(() => false));
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warn.mockRestore();
  });

  it('names the section-hash check that failed, and still lets the user continue', async () => {
    store.checkSectionHashes.mockImplementation(async () => {
      throw 'database is locked (test)';
    });
    renderDialog();

    const notice = await screen.findByTestId('duplicate-check-failed');
    expect(notice).toHaveTextContent('dialogs.dmpSelection.duplicateCheckFailed');
    expect(notice).toHaveTextContent('database is locked (test)');
    await waitFor(() => expect(screen.getByTestId('continue-button')).toBeEnabled());
    expect(warn).toHaveBeenCalled();
  });

  it('names the file-level check that failed', async () => {
    store.checkDuplicateImport.mockImplementation(async () => {
      throw new Error('no such table (test)');
    });
    renderDialog();

    const notice = await screen.findByTestId('duplicate-check-failed');
    expect(notice).toHaveTextContent('no such table (test)');
  });

  it('pin: says nothing when both checks ran', async () => {
    renderDialog();

    await waitFor(() => expect(screen.getByTestId('continue-button')).toBeEnabled());
    expect(screen.queryByTestId('duplicate-check-failed')).not.toBeInTheDocument();
  });
});
