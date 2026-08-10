/**
 * The Skip action on the zero-datum section picker (#F5): it must read as
 * secondary to the section cards, not compete with them, and it must carry a
 * visible cost line so skipping is an informed choice rather than the
 * path of least resistance.
 *
 * `.tsx` so vitest runs it under jsdom.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('react-i18next', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-i18next')>()),
  useTranslation: () => ({ t: (k: string) => k }),
}));

vi.mock('../../../store/projectStore', () => ({
  useProjectStore: (sel: (s: unknown) => unknown) => sel({ config: null }),
}));

vi.mock('../DialogWrapper', () => ({
  DialogWrapper: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

import ZeroDatumSelectionDialog from '../ZeroDatumSelectionDialog';
import type { DmpFile, DmpSection, DmpShot } from '../../../types/commands';
import type { DmpSelectionConfig } from '../DmpSelectionDialog';

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

function dmpFile(): DmpFile {
  const section: DmpSection = {
    version: 1,
    name: 'Anchor',
    direction: 'in',
    date: '2026-01-01',
    shots: Array.from({ length: 3 }, dmpShot),
    content_hash: 'hash-anchor',
  };
  return { version: 1, sections: [section] } as unknown as DmpFile;
}

const selectionConfig = {
  selectedIndices: new Set([0]),
  defaultSurveyor: 'S',
  defaultDate: '2026-01-01',
} as unknown as DmpSelectionConfig;

function renderDialog() {
  render(
    <ZeroDatumSelectionDialog
      dmpFile={dmpFile()}
      selectionConfig={selectionConfig}
      filePath="/tmp/anchor.dmp"
      onCancel={vi.fn()}
      onBack={vi.fn()}
      onSkip={vi.fn()}
      onSelectSection={vi.fn()}
    />,
  );
}

describe('ZeroDatumSelectionDialog skip button', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders Skip as a secondary action, not the primary one', () => {
    renderDialog();
    const skip = screen.getByTestId('zero-datum-selection-skip');
    // `data-primary-action` is only ever set on `variant="primary"` (Button.tsx) -
    // a component that regressed Skip back to primary would carry it again.
    expect(skip).not.toHaveAttribute('data-primary-action');
  });

  it('shows the cost of skipping next to the button', () => {
    renderDialog();
    expect(screen.getByTestId('zero-datum-selection-skip-cost')).toBeInTheDocument();
  });

  it('renders the section cards without the primary-action marker either (cards are buttons, not the dialog CTA)', () => {
    renderDialog();
    const card = screen.getByTestId('zero-datum-section-card-0');
    expect(card).not.toHaveAttribute('data-primary-action');
  });
});
