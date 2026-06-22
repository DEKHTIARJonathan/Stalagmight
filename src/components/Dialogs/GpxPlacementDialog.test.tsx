/**
 * Component test (#110) — non-DMP import dialogs must surface a partial-success
 * deferred-save warning instead of closing as if fully successful.
 *
 * The backend returns `success: true` WITH a warning ("Imported, but could not
 * save … please save manually.") when a new project's deferred save fails. The
 * GPX placement dialog previously branched only on `success`/`error`, so that
 * warning was dropped and the user never learned the import was only in memory.
 * This renders the real dialog and asserts the warning is surfaced.
 *
 * The helper's own logic is covered by utils/__tests__/saveFeedback.test.ts;
 * this is the wiring layer (the bug was the dialog ignoring `result.warnings`).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

// Telemetry is fire-and-forget; keep it from reaching Tauri IPC under jsdom.
vi.mock('../../utils/telemetry', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../utils/telemetry')>()),
  trackDialogComplete: vi.fn(),
  setSource: vi.fn(),
}));

import GpxPlacementDialog from './GpxPlacementDialog';
import { useProjectStore } from '../../store/projectStore';
import { useUIStore } from '../../store/uiStore';
import type { CommandResult, GpxFile, ValidationWarning } from '../../types/commands';

const SYSTEM_WARNING: ValidationWarning = {
  code: 'SYSTEM',
  message:
    'Imported, but could not save the new project to disk: disk full. ' +
    'Your changes are unsaved — please save manually.',
  severity: 'warning',
};

const emptyGpx: GpxFile = { name: 'cave.gpx', waypoints: [], tracks: [], routes: [] };

let executeGpxImport: ReturnType<typeof vi.fn>;
let openDialog: ReturnType<typeof vi.fn>;
let closeDialog: ReturnType<typeof vi.fn>;

beforeEach(() => {
  openDialog = vi.fn();
  closeDialog = vi.fn();
  executeGpxImport = vi.fn();
  useProjectStore.setState({ executeGpxImport });
  useUIStore.setState({
    openDialog,
    closeDialog,
    setView: vi.fn(),
    triggerFitToBounds: vi.fn(),
    dialogData: {
      gpxFile: emptyGpx,
      filePath: '/tmp/cave.gpx',
      fileHash: 'hash',
      importWaypoints: false,
      importTracks: true,
      importRoutes: true,
    },
  });
});

describe('GpxPlacementDialog warning surfacing (#110)', () => {
  it('surfaces a deferred-save warning on an otherwise-successful import', async () => {
    executeGpxImport.mockResolvedValue({
      success: true,
      error: null,
      warnings: [SYSTEM_WARNING],
      section_ids: [],
    } as CommandResult);

    render(<GpxPlacementDialog />);
    await userEvent.click(await screen.findByTestId('gpx-import-confirm'));

    await waitFor(() =>
      expect(openDialog).toHaveBeenCalledWith('error', {
        title: 'Import Warning',
        message: SYSTEM_WARNING.message,
      }),
    );
  });

  it('opens no dialog when the import fully succeeds (no warnings)', async () => {
    executeGpxImport.mockResolvedValue({
      success: true,
      error: null,
      warnings: [],
      section_ids: [],
    } as CommandResult);

    render(<GpxPlacementDialog />);
    await userEvent.click(await screen.findByTestId('gpx-import-confirm'));

    await waitFor(() => expect(closeDialog).toHaveBeenCalled());
    expect(openDialog).not.toHaveBeenCalled();
  });
});
