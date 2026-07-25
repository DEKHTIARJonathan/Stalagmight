/**
 * Component test (#110) - TML import warning surfacing.
 *
 * The dialog must surface the deferred-save partial-success warning ("imported
 * but unsaved") BEFORE the optional orphan-placement step - but must NOT modal
 * (or skip orphan for) the routine per-shot validation warnings (LONG_SHOT, …)
 * that ride along on a fully-saved import (those are surfaced via the data-table
 * UI). The helper's filtering logic is unit-tested in
 * utils/__tests__/saveFeedback.test.ts; this guards the dialog wiring + ordering.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('../../utils/telemetry', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../utils/telemetry')>()),
  trackDialogComplete: vi.fn(),
  setSource: vi.fn(),
}));
// invokeIpc is used here only for suggest_orphan_placements; mock it so the
// orphan branch resolves and we can assert whether it ran.
vi.mock('../../utils/ipc', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../utils/ipc')>()),
  invokeIpc: vi.fn(),
}));

import TmlImportDialog from './TmlImportDialog';
import { invokeIpc } from '../../utils/ipc';
import { useProjectStore } from '../../store/projectStore';
import { useUIStore } from '../../store/uiStore';
import type { CommandResult, TmlFile, ValidationWarning } from '../../types/commands';

const invokeIpcMock = vi.mocked(invokeIpc);

const SAVE_WARNING: ValidationWarning = {
  code: 'SYSTEM',
  message:
    'Imported, but could not save the new project to disk: disk full. ' +
    'Your changes are unsaved - please save manually.',
  severity: 'warning',
};
const VALIDATION_WARNING: ValidationWarning = {
  code: 'LONG_SHOT',
  message: 'Shot 3:5 length 142.0m above maximum threshold 120.0m',
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

const ok = (warnings: ValidationWarning[], section_ids: number[] = []): CommandResult =>
  ({ success: true, error: null, warnings, section_ids } as CommandResult);

let executeTmlImport: ReturnType<typeof vi.fn>;
let openDialog: ReturnType<typeof vi.fn>;
let closeDialog: ReturnType<typeof vi.fn>;

beforeEach(() => {
  openDialog = vi.fn();
  closeDialog = vi.fn();
  executeTmlImport = vi.fn();
  invokeIpcMock.mockReset();
  invokeIpcMock.mockResolvedValue([]); // suggest_orphan_placements → no suggestions
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

const orphanCalled = () =>
  invokeIpcMock.mock.calls.some(([cmd]) => cmd === 'suggest_orphan_placements');

describe('TmlImportDialog warning surfacing (#110)', () => {
  it('surfaces the deferred-save warning before orphan placement, and skips orphan', async () => {
    executeTmlImport.mockResolvedValue(ok([SAVE_WARNING], [1]));
    render(<TmlImportDialog tmlFile={tmlFile} filePath="/tmp/cave.tml" />);

    await clickImport();

    await waitFor(() =>
      expect(openDialog).toHaveBeenCalledWith('error', expect.objectContaining({ title: 'Import Warning' })),
    );
    expect(orphanCalled()).toBe(false); // the save warning short-circuits before the orphan step
  });

  it('does NOT modal a routine validation warning on a saved import - orphan still runs', async () => {
    executeTmlImport.mockResolvedValue(ok([VALIDATION_WARNING], [1]));
    render(<TmlImportDialog tmlFile={tmlFile} filePath="/tmp/cave.tml" />);

    await clickImport();

    await waitFor(() => expect(orphanCalled()).toBe(true)); // proceeded past the warning gate
    expect(openDialog).not.toHaveBeenCalledWith('error', expect.objectContaining({ title: 'Import Warning' }));
  });

  it('opens no warning dialog when the import fully succeeds with no warnings', async () => {
    executeTmlImport.mockResolvedValue(ok([], []));
    render(<TmlImportDialog tmlFile={tmlFile} filePath="/tmp/cave.tml" />);

    await clickImport();

    await waitFor(() => expect(closeDialog).toHaveBeenCalled());
    expect(openDialog).not.toHaveBeenCalled();
  });
});
