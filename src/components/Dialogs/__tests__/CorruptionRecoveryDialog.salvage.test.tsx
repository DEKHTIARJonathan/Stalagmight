/**
 * [#576 HFI-3] The recovery dialog's "Export Salvageable Data": the file is
 * written by the backend (`write_salvaged_data`, under the write-path policy).
 * It used to be written from the webview with the fs plugin's `writeTextFile`,
 * which has no scope for user paths, so in the real app every salvage export
 * ended in "Salvage Failed: forbidden path" with nothing written.
 *
 * `.tsx` so vitest runs it under jsdom.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

import type { SalvagedData } from '../../../types/ipc/SalvagedData';

vi.mock('../../../utils/ipc');

const saveDialogMock = vi.hoisted(() => vi.fn());
vi.mock('../../../utils/fileDialogs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../utils/fileDialogs')>()),
  saveDialog: saveDialogMock,
}));

const closeDialog = vi.fn();
vi.mock('../../../store/uiStore', () => ({
  useUIStore: (sel: (s: unknown) => unknown) => sel({
    closeDialog,
    dialogData: { corruptPath: '/survey/CaveA.stalx', errorMessage: 'Database integrity check failed.' },
  }),
}));
vi.mock('../../../store/projectStore', () => ({
  useProjectStore: (sel: (s: unknown) => unknown) => sel({ loadProject: vi.fn() }),
}));
vi.mock('../../../utils/telemetry', async () =>
  (await import('../../../test/factories/telemetry')).telemetryStubs({ setProjectActionSource: vi.fn() }),
);
vi.mock('../DialogWrapper', async () => (await import('../../../test/factories/components')).dialogWrapperStub());

import '../../../i18n';
import CorruptionRecoveryDialog from '../CorruptionRecoveryDialog';
import { invokeIpcMock as invokeIpc } from '../../../test/factories/ipc';

const SALVAGED: SalvagedData = {
  projectName: 'CaveA',
  projectLocation: null,
  sectionCount: 2,
  shotCount: 17,
  mergeCount: 1,
  sectionsJson: '[]',
  fullProjectJson: '{"name":"CaveA"}',
  errors: [],
};

/** Script the backend: the salvage read answers SALVAGED, the write answers `write`. */
function backend(write: () => Promise<null>): void {
  invokeIpc.mockImplementation(async (command: string) => {
    if (command === 'export_salvageable_data') return SALVAGED;
    if (command === 'write_salvaged_data') return write();
    throw new Error(`unexpected ${command}`);
  });
}

async function exportSalvage(): Promise<void> {
  render(<CorruptionRecoveryDialog />);
  fireEvent.click(screen.getByTestId('recovery-export-salvage'));
}

describe('CorruptionRecoveryDialog salvage export (#576 HFI-3)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    invokeIpc.mockReset();
    saveDialogMock.mockResolvedValue('/survey/rescued/salvaged.json');
  });

  it('has the backend write the salvage file to the chosen path and reports what was saved', async () => {
    backend(async () => null);

    await exportSalvage();

    expect(await screen.findByText('Data Exported')).toBeInTheDocument();
    expect(invokeIpc).toHaveBeenCalledWith(
      'write_salvaged_data',
      { path: '/survey/CaveA.stalx', destPath: '/survey/rescued/salvaged.json' },
      expect.anything(),
    );
    expect(screen.getByText(/\/survey\/rescued\/salvaged\.json/)).toBeInTheDocument();
  });

  it('shows the backend reason when the write is refused, and claims nothing was saved', async () => {
    backend(async () => {
      throw new Error('Refused to change salvaged.json: that is inside a system folder');
    });

    await exportSalvage();

    expect(await screen.findByText('Salvage Failed')).toBeInTheDocument();
    expect(screen.getByText(/inside a system folder/)).toBeInTheDocument();
    expect(screen.queryByText('Data Exported')).toBeNull();
  });

  it('writes nothing when the save dialog is cancelled', async () => {
    saveDialogMock.mockResolvedValue(null);
    backend(async () => null);

    await exportSalvage();

    await waitFor(() => expect(saveDialogMock).toHaveBeenCalledTimes(1));
    expect(invokeIpc).toHaveBeenCalledWith('export_salvageable_data', { path: '/survey/CaveA.stalx' }, expect.anything());
    expect(invokeIpc).not.toHaveBeenCalledWith('write_salvaged_data', expect.anything(), expect.anything());
  });
});
