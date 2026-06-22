/**
 * Component test (#110) — TML import must surface a partial-success deferred-save
 * warning BEFORE the optional orphan-placement step, rather than closing as if
 * fully successful. The "unsaved — save manually" message must not be buried.
 *
 * The shared helper's logic is covered by utils/__tests__/saveFeedback.test.ts;
 * this guards the dialog wiring + the warning-before-orphan ordering decision.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('../../utils/telemetry', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../utils/telemetry')>()),
  trackDialogComplete: vi.fn(),
  setSource: vi.fn(),
}));

import TmlImportDialog from './TmlImportDialog';
import { useProjectStore } from '../../store/projectStore';
import { useUIStore } from '../../store/uiStore';
import type { CommandResult, TmlFile, ValidationWarning } from '../../types/commands';

const SYSTEM_WARNING: ValidationWarning = {
  code: 'SYSTEM',
  message:
    'Imported, but could not save the new project to disk: disk full. ' +
    'Your changes are unsaved — please save manually.',
  severity: 'warning',
};

const tmlFile: TmlFile = {
  cave_name: 'Test Cave',
  unit: 'Metric',
  use_magnetic_azimuth: false,
  first_start_absolute_elevation: 0,
  geo_coding: null,
  sections: [],
  closures: [],
};

let executeTmlImport: ReturnType<typeof vi.fn>;
let openDialog: ReturnType<typeof vi.fn>;
let closeDialog: ReturnType<typeof vi.fn>;

beforeEach(() => {
  openDialog = vi.fn();
  closeDialog = vi.fn();
  executeTmlImport = vi.fn();
  useProjectStore.setState({
    executeTmlImport,
    calculateFileHash: vi.fn(async () => 'hash'),
    checkDuplicateImport: vi.fn(async () => false),
    startLoading: vi.fn(() => 0),
    setLoadingProgress: vi.fn(),
    resetLoading: vi.fn(),
  });
  useUIStore.setState({
    openDialog,
    closeDialog,
    setView: vi.fn(),
    triggerFitToBounds: vi.fn(),
  });
});

/** The confirm button is gated on the on-mount duplicate-hash check resolving. */
async function clickImport() {
  const btn = (await screen.findByTestId('tml-import-confirm')) as HTMLButtonElement;
  await waitFor(() => expect(btn.disabled).toBe(false));
  await userEvent.click(btn);
}

describe('TmlImportDialog warning surfacing (#110)', () => {
  it('surfaces a deferred-save warning instead of closing as fully successful', async () => {
    executeTmlImport.mockResolvedValue({
      success: true,
      error: null,
      warnings: [SYSTEM_WARNING],
      section_ids: [],
    } as CommandResult);

    render(<TmlImportDialog tmlFile={tmlFile} filePath="/tmp/cave.tml" />);
    await clickImport();

    await waitFor(() =>
      expect(openDialog).toHaveBeenCalledWith('error', {
        title: 'Import Warning',
        message: SYSTEM_WARNING.message,
      }),
    );
  });

  it('opens no warning dialog when the import fully succeeds', async () => {
    executeTmlImport.mockResolvedValue({
      success: true,
      error: null,
      warnings: [],
      section_ids: [],
    } as CommandResult);

    render(<TmlImportDialog tmlFile={tmlFile} filePath="/tmp/cave.tml" />);
    await clickImport();

    await waitFor(() => expect(closeDialog).toHaveBeenCalled());
    expect(openDialog).not.toHaveBeenCalled();
  });
});
