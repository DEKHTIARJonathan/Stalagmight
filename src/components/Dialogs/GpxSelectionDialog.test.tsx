/**
 * Component test (#110/#391) - GPX waypoints-only import must apply the same
 * deferred-save gate as the TML/Compass/Walls dialogs: a "SYSTEM" save-failure
 * warning means the import is unsaved, so it must lead the receipt's warning
 * rows (docs/notifications.md - one event, one surface).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('../../utils/telemetry', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../utils/telemetry')>()),
  trackDialogComplete: vi.fn(),
  setSource: vi.fn(),
}));

import GpxSelectionDialog from './GpxSelectionDialog';
import { useProjectStore } from '../../store/projectStore';
import { useUIStore } from '../../store/uiStore';
import type { CommandResult, GpxFile, ValidationWarning } from '../../types/commands';
import type { ImportReceipt } from '../../types/ipc/ImportReceipt';

const SAVE_WARNING: ValidationWarning = {
  code: 'SYSTEM',
  message:
    'Imported, but could not save the new project to disk: disk full. ' +
    'Your changes are unsaved - please save manually.',
  severity: 'warning',
};

const RECEIPT: ImportReceipt = {
  source_format: 'GPX',
  file_name: 'waypoints.gpx',
  sections_found: 0,
  sections_imported: 0,
  shot_count: 0,
  closures_requested: 0,
  closures_created: 0,
  unit_conversion: null,
  warnings: [],
};

const waypointsOnlyGpx: GpxFile = {
  name: 'waypoints.gpx',
  waypoints: [{ latitude: 1, longitude: 2, elevation: null, name: 'wpt-1', comment: null, time: null }],
  tracks: [],
  routes: [],
};

const ok = (warnings: ValidationWarning[], import_receipt?: ImportReceipt): CommandResult =>
  ({ success: true, error: null, warnings, section_ids: [], import_receipt } as CommandResult);

let executeGpxImport: ReturnType<typeof vi.fn>;
let calculateFileHash: ReturnType<typeof vi.fn>;
let checkDuplicateImport: ReturnType<typeof vi.fn>;
let openDialog: ReturnType<typeof vi.fn>;
let closeDialog: ReturnType<typeof vi.fn>;
let showToast: ReturnType<typeof vi.fn>;

beforeEach(() => {
  openDialog = vi.fn();
  closeDialog = vi.fn();
  showToast = vi.fn();
  executeGpxImport = vi.fn();
  calculateFileHash = vi.fn().mockResolvedValue('hash');
  checkDuplicateImport = vi.fn().mockResolvedValue(false);
  useProjectStore.setState({ executeGpxImport, calculateFileHash, checkDuplicateImport });
  useUIStore.setState({
    openDialog,
    closeDialog,
    setView: vi.fn(),
    triggerFitToBounds: vi.fn(),
    showToast,
  });
});

describe('GpxSelectionDialog waypoints-only import (#110/#391)', () => {
  it('threads the save warning into the receipt as its leading row on a deferred-save partial success', async () => {
    executeGpxImport.mockResolvedValue(ok([SAVE_WARNING], RECEIPT));

    render(<GpxSelectionDialog gpxFile={waypointsOnlyGpx} filePath="/tmp/waypoints.gpx" />);
    await userEvent.click(await screen.findByTestId('gpx-import-confirm'));

    await waitFor(() =>
      expect(openDialog).toHaveBeenCalledWith(
        'import-receipt',
        expect.objectContaining({
          receipt: expect.objectContaining({
            warnings: [SAVE_WARNING.message, ...RECEIPT.warnings],
          }),
        }),
      ),
    );
    expect(openDialog).not.toHaveBeenCalledWith('error', expect.anything());
  });

  it('opens the modal for a zero-count receipt even with no warnings (#442)', async () => {
    executeGpxImport.mockResolvedValue(ok([], RECEIPT));

    render(<GpxSelectionDialog gpxFile={waypointsOnlyGpx} filePath="/tmp/waypoints.gpx" />);
    await userEvent.click(await screen.findByTestId('gpx-import-confirm'));

    await waitFor(() =>
      expect(openDialog).toHaveBeenCalledWith('import-receipt', { receipt: RECEIPT }),
    );
    expect(showToast).not.toHaveBeenCalled();
  });

  it('toasts a warning-free, non-empty receipt instead of opening the modal (#411/#420)', async () => {
    const nonEmptyReceipt: ImportReceipt = { ...RECEIPT, sections_imported: 1, shot_count: 3 };
    executeGpxImport.mockResolvedValue(ok([], nonEmptyReceipt));

    render(<GpxSelectionDialog gpxFile={waypointsOnlyGpx} filePath="/tmp/waypoints.gpx" />);
    await userEvent.click(await screen.findByTestId('gpx-import-confirm'));

    await waitFor(() => expect(showToast).toHaveBeenCalledTimes(1));
    expect(openDialog).not.toHaveBeenCalledWith('import-receipt', expect.anything());
  });
});
