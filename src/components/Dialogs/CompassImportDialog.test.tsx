/**
 * Component test (#110) — Compass import warning surfacing.
 *
 * CompassImportDialog's warning-surfacing block is a copy-paste sibling of TML's
 * and can drift independently, so it gets its own coverage: the deferred-save
 * partial-success warning must surface before the orphan step, while routine
 * per-shot validation warnings on a fully-saved import must NOT modal or skip
 * orphan placement. Helper filtering is unit-tested in saveFeedback.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('../../utils/telemetry', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../utils/telemetry')>()),
  trackDialogComplete: vi.fn(),
  setSource: vi.fn(),
}));
vi.mock('../../utils/ipc', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../utils/ipc')>()),
  invokeIpc: vi.fn(),
}));

import CompassImportDialog from './CompassImportDialog';
import { invokeIpc } from '../../utils/ipc';
import { useProjectStore } from '../../store/projectStore';
import { useUIStore } from '../../store/uiStore';
import type { CommandResult, CompassFile, ValidationWarning } from '../../types/commands';

const invokeIpcMock = vi.mocked(invokeIpc);

const SAVE_WARNING: ValidationWarning = {
  code: 'SYSTEM',
  message:
    'Imported, but could not save the new project to disk: disk full. ' +
    'Your changes are unsaved — please save manually.',
  severity: 'warning',
};
const VALIDATION_WARNING: ValidationWarning = {
  code: 'LONG_SHOT',
  message: 'Shot 3:5 length 142.0m above maximum threshold 120.0m',
  severity: 'warning',
};

const compassFile: CompassFile = {
  cave_name: 'Test Cave',
  survey_count: 0,
  shot_count: 0,
  has_backsights: false,
  datum: null,
  utm_zone: null,
  has_georeference: false,
  declination_mode: 'File',
  length_unit: null,
  surveys: [],
  warnings: [],
};

const ok = (warnings: ValidationWarning[], section_ids: number[] = []): CommandResult =>
  ({ success: true, error: null, warnings, section_ids } as CommandResult);

let executeCompassImport: ReturnType<typeof vi.fn>;
let openDialog: ReturnType<typeof vi.fn>;
let closeDialog: ReturnType<typeof vi.fn>;

beforeEach(() => {
  openDialog = vi.fn();
  closeDialog = vi.fn();
  executeCompassImport = vi.fn();
  invokeIpcMock.mockReset();
  invokeIpcMock.mockResolvedValue([]); // suggest_orphan_placements → no suggestions
  useProjectStore.setState({
    executeCompassImport,
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

async function clickImport() {
  const btn = (await screen.findByTestId('compass-import-confirm')) as HTMLButtonElement;
  await waitFor(() => expect(btn.disabled).toBe(false));
  await userEvent.click(btn);
}

const orphanCalled = () =>
  invokeIpcMock.mock.calls.some(([cmd]) => cmd === 'suggest_orphan_placements');

describe('CompassImportDialog warning surfacing (#110)', () => {
  it('surfaces the deferred-save warning before orphan placement, and skips orphan', async () => {
    executeCompassImport.mockResolvedValue(ok([SAVE_WARNING], [1]));
    render(<CompassImportDialog compassFile={compassFile} filePath="/tmp/cave.dat" />);

    await clickImport();

    await waitFor(() =>
      expect(openDialog).toHaveBeenCalledWith('error', expect.objectContaining({ title: 'Import Warning' })),
    );
    expect(orphanCalled()).toBe(false);
  });

  it('does NOT modal a routine validation warning on a saved import — orphan still runs', async () => {
    executeCompassImport.mockResolvedValue(ok([VALIDATION_WARNING], [1]));
    render(<CompassImportDialog compassFile={compassFile} filePath="/tmp/cave.dat" />);

    await clickImport();

    await waitFor(() => expect(orphanCalled()).toBe(true));
    expect(openDialog).not.toHaveBeenCalledWith('error', expect.objectContaining({ title: 'Import Warning' }));
  });
});
