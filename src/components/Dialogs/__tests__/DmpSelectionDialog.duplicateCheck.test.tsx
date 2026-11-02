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

vi.mock('react-i18next', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-i18next')>()),
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) =>
      opts ? `${key}:${JSON.stringify(opts)}` : key,
  }),
}));

const store = {
  config: null,
  calculateFileHash: vi.fn(async (_path: string) => 'hash'),
  checkDuplicateImport: vi.fn(async (_hash: string) => false),
  checkSectionHashes: vi.fn(async (hashes: string[]) => hashes.map(() => false)),
};
vi.mock('../../../store/projectStore', () => ({
  useProjectStore: (sel: (s: unknown) => unknown) => sel(store),
}));

vi.mock('../DialogWrapper', () => ({
  DialogWrapper: ({ children, 'data-testid': testId }: { children: React.ReactNode; 'data-testid'?: string }) => (
    <div data-testid={testId}>{children}</div>
  ),
}));

import DmpSelectionDialog from '../DmpSelectionDialog';
import type { DmpFile, DmpSection, DmpShot } from '../../../types/commands';

const shot = (): DmpShot => ({
  shot_type: 'Standard',
  heading_in: 10,
  heading_out: 10,
  length: 5,
  depth_in: 0,
  depth_out: 0,
  pitch_in: 0,
  pitch_out: 0,
  left: 0,
  right: 0,
  up: 0,
  down: 0,
  temperature: 0,
  hour: 0,
  minute: 0,
  second: 0,
  marker_index: 0,
});

const section = (name: string): DmpSection => ({
  version: 5,
  name,
  direction: 'in',
  date: '2026-01-01',
  shots: Array.from({ length: 3 }, shot),
  content_hash: `hash-${name}`,
});

const file = { version: 5, sections: [section('AAA'), section('BBB')], warnings: [] } as DmpFile;

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
