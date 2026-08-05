/**
 * Component test (#110) - TML import warning surfacing.
 *
 * The dialog must surface the deferred-save partial-success warning ("imported
 * but unsaved") BEFORE the optional orphan-placement step - but must NOT modal
 * (or skip orphan for) the routine per-shot validation warnings (LONG_SHOT, …)
 * that ride along on a fully-saved import (those are surfaced via the data-table
 * UI). The helper's filtering logic is unit-tested in
 * utils/__tests__/saveFeedback.test.ts; this guards the dialog wiring + ordering.
 *
 * Plus the #411 repairs: a terminal failure never navigates, the empty project a
 * cancelled/failed import leaves behind is acknowledged, Cancel is dead while the
 * import runs, and the preview counts what will actually import.
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
import type { CommandResult, TmlFile, TmlShot, ValidationWarning } from '../../types/commands';
import type { ImportReceipt } from '../../types/ipc/ImportReceipt';
import type { Project } from '../../types/project';

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

/** What the backend reports for a file whose every section was dropped (#411). */
const EMPTY_RECEIPT: ImportReceipt = {
  source_format: 'Ariane TML',
  file_name: 'cave.tml',
  sections_found: 2,
  sections_imported: 0,
  shot_count: 0,
  closures_requested: 0,
  closures_created: 0,
  unit_conversion: null,
  warnings: ['2 sections had no shots after filtering and were dropped'],
};

/**
 * The REAL wire shape of an import that created no section: `section_ids` is
 * `#[serde(skip_serializing_if = "Vec::is_empty")]`, so the key is ABSENT -
 * not present-and-empty. Every mock in the repo writes the key, which is
 * exactly why a bare `result.section_ids.length` survived here; only this tier
 * can express the omission.
 */
const okWithoutSectionIds = (receipt: ImportReceipt): CommandResult =>
  ({ success: true, error: null, warnings: [], import_receipt: receipt } as unknown as CommandResult);

/** A section carrying one shot per flavour asked for. */
const shot = (overrides: Partial<TmlShot> = {}): TmlShot =>
  ({
    id: 1n,
    from_id: 0n,
    shot_type: 'Real',
    azimuth: 0,
    length: 10,
    depth: 2,
    depth_in: 1,
    inclination: 0,
    left: 1,
    right: 1,
    up: 1,
    down: 1,
    comment: null,
    explorer: null,
    date: null,
    color: '#3b82f6',
    excluded: false,
    latitude: 0,
    longitude: 0,
    closure_to_id: 0n,
    section: 'S',
    ...overrides,
  }) as TmlShot;

const withShots = (shots: TmlShot[]): TmlFile => ({
  ...tmlFile,
  sections: [
    {
      name: 'S',
      shots,
      surveyor: null,
      date: null,
      color: '#3b82f6',
      is_branch_split: false,
      start_ariane_id: 0n,
      end_ariane_id: 0n,
      start_depth: 0,
    },
  ],
});

let executeTmlImport: ReturnType<typeof vi.fn>;
let openDialog: ReturnType<typeof vi.fn>;
let closeDialog: ReturnType<typeof vi.fn>;
let setView: ReturnType<typeof vi.fn>;
let triggerFitToBounds: ReturnType<typeof vi.fn>;
let closeProject: ReturnType<typeof vi.fn>;
let deleteProject: ReturnType<typeof vi.fn>;

beforeEach(() => {
  openDialog = vi.fn();
  closeDialog = vi.fn();
  setView = vi.fn();
  triggerFitToBounds = vi.fn();
  executeTmlImport = vi.fn();
  closeProject = vi.fn(async () => ({ success: true }) as CommandResult);
  deleteProject = vi.fn(async () => ({ success: true }) as CommandResult);
  invokeIpcMock.mockReset();
  invokeIpcMock.mockResolvedValue([]); // suggest_orphan_placements → no suggestions
  useProjectStore.setState({
    executeTmlImport,
    calculateFileHash: vi.fn(async () => 'hash'),
    startLoading: vi.fn(() => 0),
    setLoadingProgress: vi.fn(),
    resetLoading: vi.fn(),
    closeProject,
    deleteProject,
    databaseOpen: false,
    project: null,
  });
  useUIStore.setState({
    openDialog,
    closeDialog,
    setView,
    triggerFitToBounds,
    setImportContext: vi.fn(),
    importContext: null,
  });
});

/** The project a new-project import created: open, and still empty. */
function openEmptyImportProject() {
  useProjectStore.setState({ project: { sections: [] } as unknown as Project });
  useUIStore.setState({ importContext: 'new-project' });
}

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
    render(<TmlImportDialog tmlFile={withShots([shot()])} filePath="/tmp/cave.tml" />);

    await clickImport();

    await waitFor(() =>
      expect(openDialog).toHaveBeenCalledWith('error', expect.objectContaining({ title: 'Import Warning' })),
    );
    expect(orphanCalled()).toBe(false); // the save warning short-circuits before the orphan step
  });

  it('does NOT modal a routine validation warning on a saved import - orphan still runs', async () => {
    executeTmlImport.mockResolvedValue(ok([VALIDATION_WARNING], [1]));
    render(<TmlImportDialog tmlFile={withShots([shot()])} filePath="/tmp/cave.tml" />);

    await clickImport();

    await waitFor(() => expect(orphanCalled()).toBe(true)); // proceeded past the warning gate
    expect(openDialog).not.toHaveBeenCalledWith('error', expect.objectContaining({ title: 'Import Warning' }));
  });

  it('shows the receipt when the import created nothing and section_ids is absent (#411)', async () => {
    executeTmlImport.mockResolvedValue(okWithoutSectionIds(EMPTY_RECEIPT));
    // A non-empty PREVIEW: this guards the backend dropping everything it
    // promised (sections_imported: 0 with real content going in), which is
    // distinct from this dialog's own zero-shot preview gate - that one blocks
    // Import outright and never reaches the backend at all.
    render(<TmlImportDialog tmlFile={withShots([shot()])} filePath="/tmp/cave.tml" />);

    await clickImport();

    await waitFor(() =>
      expect(openDialog).toHaveBeenCalledWith('import-receipt', { receipt: EMPTY_RECEIPT }),
    );
    // Not a transport failure: reading the absent key used to throw, and the
    // catch reported the empty import as a broken IPC call.
    expect(openDialog).not.toHaveBeenCalledWith('error', expect.anything());
    expect(orphanCalled()).toBe(false);
  });

  it('opens no warning dialog when the import fully succeeds with no warnings', async () => {
    executeTmlImport.mockResolvedValue(ok([], []));
    render(<TmlImportDialog tmlFile={withShots([shot()])} filePath="/tmp/cave.tml" />);

    await clickImport();

    await waitFor(() => expect(closeDialog).toHaveBeenCalled());
    expect(openDialog).not.toHaveBeenCalled();
  });
});

describe('TmlImportDialog failure handling (#411 C2)', () => {
  it('reports a backend failure WITHOUT navigating into the empty project', async () => {
    executeTmlImport.mockResolvedValue({
      success: false,
      error: 'Section 2 is unreadable',
      warnings: [],
      section_ids: [],
    } as unknown as CommandResult);
    render(<TmlImportDialog tmlFile={withShots([shot()])} filePath="/tmp/cave.tml" />);

    await clickImport();

    await waitFor(() =>
      expect(openDialog).toHaveBeenCalledWith(
        'error',
        expect.objectContaining({ title: 'Import Errors', message: 'Section 2 is unreadable' }),
      ),
    );
    // The dialog closes (its work is over), but the navigate/fit half of the
    // exit sequence must not run - that showed the empty project first.
    expect(setView).not.toHaveBeenCalled();
    expect(triggerFitToBounds).not.toHaveBeenCalled();
  });

  it('asks about the empty project it was importing into instead of a bare error', async () => {
    openEmptyImportProject();
    executeTmlImport.mockResolvedValue({
      success: false,
      error: 'Section 2 is unreadable',
      warnings: [],
      section_ids: [],
    } as unknown as CommandResult);
    render(<TmlImportDialog tmlFile={withShots([shot()])} filePath="/tmp/cave.tml" />);

    await clickImport();

    expect(await screen.findByTestId('tml-import-residue-dialog')).toBeInTheDocument();
    expect(screen.getByTestId('tml-import-residue-error')).toHaveTextContent('Section 2 is unreadable');
    expect(setView).not.toHaveBeenCalled();
  });

  it('disables Cancel while the import is in flight', async () => {
    executeTmlImport.mockReturnValue(new Promise(() => {})); // never settles
    render(<TmlImportDialog tmlFile={withShots([shot()])} filePath="/tmp/cave.tml" />);

    const cancel = (await screen.findByTestId('tml-import-cancel')) as HTMLButtonElement;
    expect(cancel.disabled).toBe(false);

    await clickImport();

    await waitFor(() => expect(cancel.disabled).toBe(true));
    await userEvent.click(cancel);
    expect(closeDialog).not.toHaveBeenCalled();
  });
});

describe('TmlImportDialog empty-project residue (#411 C2)', () => {
  it('offers keep/discard when cancelling out of a project created for this import', async () => {
    openEmptyImportProject();
    render(<TmlImportDialog tmlFile={withShots([shot()])} filePath="/tmp/cave.tml" />);

    await userEvent.click(await screen.findByTestId('tml-import-cancel'));

    expect(await screen.findByTestId('tml-import-residue-dialog')).toBeInTheDocument();
    expect(closeDialog).not.toHaveBeenCalled();

    await userEvent.click(screen.getByTestId('tml-import-residue-keep'));
    expect(closeProject).not.toHaveBeenCalled();
    expect(deleteProject).not.toHaveBeenCalled();
    expect(closeDialog).toHaveBeenCalled();
  });

  it('discards the deferred project by closing it and returning to the project list', async () => {
    openEmptyImportProject();
    render(<TmlImportDialog tmlFile={withShots([shot()])} filePath="/tmp/cave.tml" />);

    await userEvent.click(await screen.findByTestId('tml-import-cancel'));
    await userEvent.click(await screen.findByTestId('tml-import-residue-discard'));

    await waitFor(() => expect(closeProject).toHaveBeenCalled());
    expect(deleteProject).not.toHaveBeenCalled(); // nothing on disk yet
    expect(setView).toHaveBeenCalledWith('global');
    expect(closeDialog).toHaveBeenCalled();
  });

  it('deletes the .stalx when the project was created with a save path', async () => {
    openEmptyImportProject();
    useProjectStore.setState({
      databaseOpen: true,
      project: { sections: [], file_path: '/tmp/new.stalx' } as unknown as Project,
    });
    render(<TmlImportDialog tmlFile={withShots([shot()])} filePath="/tmp/cave.tml" />);

    await userEvent.click(await screen.findByTestId('tml-import-cancel'));
    await userEvent.click(await screen.findByTestId('tml-import-residue-discard'));

    await waitFor(() => expect(deleteProject).toHaveBeenCalledWith('/tmp/new.stalx'));
    expect(closeProject).not.toHaveBeenCalled();
  });

  it('closes straight out when the project already holds sections', async () => {
    useProjectStore.setState({ project: { sections: [{}] } as unknown as Project });
    useUIStore.setState({ importContext: 'new-project' });
    render(<TmlImportDialog tmlFile={withShots([shot()])} filePath="/tmp/cave.tml" />);

    await userEvent.click(await screen.findByTestId('tml-import-cancel'));

    expect(closeDialog).toHaveBeenCalled();
    expect(screen.queryByTestId('tml-import-residue-dialog')).toBeNull();
  });
});

describe('TmlImportDialog preview honesty (#411 C4)', () => {
  it('counts only the shots that will actually import', async () => {
    const file = withShots([
      shot({ id: 1n }),
      shot({ id: 2n, excluded: true }),
      shot({ id: 3n, shot_type: 'Closure' }),
    ]);
    render(<TmlImportDialog tmlFile={file} filePath="/tmp/cave.tml" />);

    // 3 raw rows, but the CLOSURE marker never imports and the excluded shot is
    // out until the toggle says otherwise.
    expect(await screen.findByTestId('tml-shot-count')).toHaveTextContent('1');
    expect(screen.getByTestId('tml-section-row-0')).toHaveTextContent('1');

    await userEvent.click(screen.getByTestId('tml-include-excluded'));
    expect(screen.getByTestId('tml-shot-count')).toHaveTextContent('2');
  });

  it('blocks the import when nothing survives the current options', async () => {
    const file = withShots([shot({ shot_type: 'Closure' }), shot({ id: 2n, excluded: true })]);
    render(<TmlImportDialog tmlFile={file} filePath="/tmp/cave.tml" />);

    expect(await screen.findByTestId('tml-import-empty')).toBeInTheDocument();
    expect((screen.getByTestId('tml-import-confirm') as HTMLButtonElement).disabled).toBe(true);

    // The excluded shot is recoverable: opting it in re-enables the import.
    await userEvent.click(screen.getByTestId('tml-include-excluded'));
    expect((screen.getByTestId('tml-import-confirm') as HTMLButtonElement).disabled).toBe(false);
    expect(screen.queryByTestId('tml-import-empty')).toBeNull();
  });
});
