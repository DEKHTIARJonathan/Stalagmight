/**
 * #576 B13: what the DMP parser could not read (`DmpFile.warnings` - a last
 * section cut short, a section that stops at a damaged record, a section that
 * failed to read) is shown on the section-selection step, before the user
 * picks what to import. Until then the file looked complete.
 *
 * `.tsx` so vitest runs it under jsdom.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

vi.mock('react-i18next', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-i18next')>()),
  useTranslation: () => ({ t: (k: string) => k }),
}));

vi.mock('../../../store/projectStore', () => {
  const state = {
    config: null,
    calculateFileHash: async () => 'hash',
    checkDuplicateImport: async () => false,
    checkSectionHashes: async (hashes: string[]) => hashes.map(() => false),
  };
  return { useProjectStore: (sel: (s: unknown) => unknown) => sel(state) };
});

vi.mock('../DialogWrapper', () => ({
  DialogWrapper: ({ children, 'data-testid': testId }: { children: React.ReactNode; 'data-testid'?: string }) => (
    <div data-testid={testId}>{children}</div>
  ),
}));

import DmpSelectionDialog from '../DmpSelectionDialog';
import type { DmpFile, DmpSection, DmpShot } from '../../../types/commands';
import en from '../../../i18n/locales/en.json';

function dmpShot(): DmpShot {
  return {
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
  };
}

function section(name: string): DmpSection {
  return {
    version: 5,
    name,
    direction: 'in',
    date: '2026-01-01',
    shots: Array.from({ length: 3 }, dmpShot),
    content_hash: `hash-${name}`,
  };
}

const CUT_SHORT =
  'Section "BBB" (#2 in the file) has no end-of-section marker, so the download may have been cut short: 3 shots were read, the rest of the file was not.';
const DAMAGED =
  'Section "AAA" (#1 in the file) stops at a damaged record (Invalid shot type value: 9) after 2 shots; the rest of that section was not read.';

function renderDialog(file: DmpFile) {
  return render(
    <DmpSelectionDialog dmpFile={file} filePath="/tmp/dive.dmp" onCancel={vi.fn()} onContinue={vi.fn()} />,
  );
}

describe('DMP selection step: parse warnings (#576 B13)', () => {
  it('lists every warning the parser returned', async () => {
    renderDialog({ version: 5, sections: [section('AAA'), section('BBB')], warnings: [DAMAGED, CUT_SHORT] });

    const banner = await screen.findByTestId('dmp-parse-warnings');
    expect(banner).toHaveTextContent('dialogs.dmpSelection.parseWarningsTitle');
    expect(screen.getByTestId('dmp-parse-warning-0')).toHaveTextContent(DAMAGED);
    expect(screen.getByTestId('dmp-parse-warning-1')).toHaveTextContent(CUT_SHORT);
    expect(en.dialogs.dmpSelection.parseWarningsTitle).toBeTruthy();
  });

  it('shows nothing for a clean file, or one from an older backend without the field', async () => {
    const { unmount } = renderDialog({ version: 5, sections: [section('AAA')], warnings: [] });
    await waitFor(() => expect(screen.getByTestId('dmp-selection-dialog')).toBeInTheDocument());
    expect(screen.queryByTestId('dmp-parse-warnings')).toBeNull();
    unmount();

    renderDialog({ version: 5, sections: [section('AAA')] } as unknown as DmpFile);
    await waitFor(() => expect(screen.getByTestId('dmp-selection-dialog')).toBeInTheDocument());
    expect(screen.queryByTestId('dmp-parse-warnings')).toBeNull();
  });
});
