/**
 * Component test (#110) — GPX import warning surfacing.
 *
 * Must surface the deferred-save partial-success warning ("imported but
 * unsaved"), but must NOT modal the routine per-shot validation warnings that
 * ride along on a fully-saved import. The helper's filtering logic is unit-tested
 * in utils/__tests__/saveFeedback.test.ts; this guards the dialog wiring.
 * (GPX has no orphan-placement step, so there's no ordering concern here.)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('../../utils/telemetry', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../utils/telemetry')>()),
  trackDialogComplete: vi.fn(),
  setSource: vi.fn(),
}));

import GpxPlacementDialog from './GpxPlacementDialog';
import { useProjectStore } from '../../store/projectStore';
import { useUIStore } from '../../store/uiStore';
import type { CommandResult, GpxFile, ValidationWarning } from '../../types/commands';

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

const emptyGpx: GpxFile = { name: 'cave.gpx', waypoints: [], tracks: [], routes: [] };

const ok = (warnings: ValidationWarning[]): CommandResult =>
  ({ success: true, error: null, warnings, section_ids: [] } as CommandResult);

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
  it('surfaces the deferred-save warning on an otherwise-successful import', async () => {
    executeGpxImport.mockResolvedValue(ok([SAVE_WARNING]));

    render(<GpxPlacementDialog />);
    await userEvent.click(await screen.findByTestId('gpx-import-confirm'));

    await waitFor(() =>
      expect(openDialog).toHaveBeenCalledWith('error', expect.objectContaining({ title: 'Import Warning' })),
    );
  });

  it('does NOT modal a routine validation warning on a saved import', async () => {
    executeGpxImport.mockResolvedValue(ok([VALIDATION_WARNING]));

    render(<GpxPlacementDialog />);
    await userEvent.click(await screen.findByTestId('gpx-import-confirm'));

    await waitFor(() => expect(closeDialog).toHaveBeenCalled());
    expect(openDialog).not.toHaveBeenCalled();
  });

  it('opens no dialog when the import fully succeeds with no warnings', async () => {
    executeGpxImport.mockResolvedValue(ok([]));

    render(<GpxPlacementDialog />);
    await userEvent.click(await screen.findByTestId('gpx-import-confirm'));

    await waitFor(() => expect(closeDialog).toHaveBeenCalled());
    expect(openDialog).not.toHaveBeenCalled();
  });
});
