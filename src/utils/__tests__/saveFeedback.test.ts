import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../ipc', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../ipc')>()),
  invokeIpc: vi.fn(),
}));

import {
  autosaveFailureMessage,
  surfaceSaveFailure,
  surfaceImportFailure,
  completeImportToSingleView,
  finalizeDeferredSaveWarnings,
  deferredSaveWarnings,
  presentImportReceipt,
  finishImportWithoutOrphanSuggestions,
  type ImportDialogUi,
  type ImportReceiptWithUnanchoredCount,
} from '../saveFeedback';
import { importReceiptSummaryParts } from '../importReceipt';
import { invokeIpc } from '../ipc';
import i18n from '../../i18n';
import { FS_PATH_NOT_FOUND, FS_PATH_TOO_LONG, FS_PERMISSION_DENIED } from '../saveErrors';
import { useProjectStore } from '../../store/projectStore';
import { useUIStore } from '../../store/uiStore';
import type { ValidationWarning } from '../../types/ipc/ValidationWarning';
import type { ImportReceipt } from '../../types/ipc/ImportReceipt';

const invokeIpcMock = vi.mocked(invokeIpc);

const mockUi = (): ImportDialogUi & { [K in keyof ImportDialogUi]: ReturnType<typeof vi.fn> } => ({
  closeDialog: vi.fn(),
  setView: vi.fn(),
  triggerFitToBounds: vi.fn(),
  openDialog: vi.fn(),
  showToast: vi.fn(),
});

const receiptFixture = (warnings: string[] = []): ImportReceipt => ({
  source_format: 'Ariane TML',
  file_name: 'cave.tml',
  sections_found: 2,
  sections_imported: 2,
  shot_count: 40,
  closures_requested: 0,
  closures_created: 0,
  unit_conversion: null,
  warnings,
  info: [],
});

describe('surfaceSaveFailure', () => {
  beforeEach(() => {
    useProjectStore.setState({ integritySaveBlocked: false, integrityDialogOpen: false });
  });

  it('routes a save-blocked failure to Review & Repair, not an error window', () => {
    useProjectStore.setState({ integritySaveBlocked: true });
    const openDialog = vi.fn();

    surfaceSaveFailure("Can't save: 1 unresolved cross-reference", openDialog);

    // No error dialog - instead the integrity (Review & Repair) dialog opens.
    expect(openDialog).not.toHaveBeenCalled();
    expect(useProjectStore.getState().integrityDialogOpen).toBe(true);
  });

  it('shows the error dialog for a real (non-integrity) failure', () => {
    const openDialog = vi.fn();

    surfaceSaveFailure('Disk full', openDialog);

    expect(openDialog).toHaveBeenCalledWith('error', {
      message: 'Disk full',
      title: 'Save Failed',
    });
    expect(useProjectStore.getState().integrityDialogOpen).toBe(false);
  });

  it('does nothing when there is no error and the project is not save-blocked', () => {
    const openDialog = vi.fn();

    surfaceSaveFailure(undefined, openDialog);

    expect(openDialog).not.toHaveBeenCalled();
    expect(useProjectStore.getState().integrityDialogOpen).toBe(false);
  });

  it('leaves a permission denial to the folder-access guidance dialog', () => {
    const openDialog = vi.fn();

    surfaceSaveFailure(`${FS_PERMISSION_DENIED}: Failed to create save file: ...`, openDialog);

    expect(openDialog).not.toHaveBeenCalled();
  });

  it('says the folder is gone instead of relaying SQLite (#429)', () => {
    const openDialog = vi.fn();

    surfaceSaveFailure(
      `${FS_PATH_NOT_FOUND}: Cannot save to Z:\\surveys\\cave.stalx: the folder no longer exists or the drive is not connected`,
      openDialog
    );

    const [dialog, data] = openDialog.mock.calls[0] as [string, { message: string }];
    expect(dialog).toBe('error');
    expect(data.message).not.toContain(FS_PATH_NOT_FOUND);
    expect(data.message).toContain('the folder no longer exists or the drive is not connected');
  });

  it('names the path length for an over-MAX_PATH destination (#429)', () => {
    const openDialog = vi.fn();

    surfaceSaveFailure(
      `${FS_PATH_TOO_LONG}: Failed to create save file: Failed to open database`,
      openDialog
    );

    const [, data] = openDialog.mock.calls[0] as [string, { message: string }];
    expect(data.message).not.toContain(FS_PATH_TOO_LONG);
    expect(data.message).not.toContain('Failed to open database');
    expect(data.message).toContain('too long');
  });
});

describe('autosaveFailureMessage (#429)', () => {
  it('gives each destination failure its own banner line, never the raw marker', () => {
    const gone = autosaveFailureMessage(`${FS_PATH_NOT_FOUND}: Cannot save to Z:\\cave.stalx`);
    const tooLong = autosaveFailureMessage(`${FS_PATH_TOO_LONG}: Failed to create save file`);
    const denied = autosaveFailureMessage(`${FS_PERMISSION_DENIED}: denied`);

    for (const line of [gone, tooLong, denied]) {
      expect(line).toBeTruthy();
      expect(line).not.toContain('FS_');
    }
    expect(new Set([gone, tooLong, denied]).size).toBe(3);
  });

  it('relays an unmarked failure as the backend wrote it', () => {
    expect(autosaveFailureMessage('Disk full: no space left on device')).toBe(
      'Disk full: no space left on device'
    );
    expect(autosaveFailureMessage(null)).toBeTruthy();
  });
});

describe('deferredSaveWarnings (#110)', () => {
  const w = (code: string, message = code): ValidationWarning => ({ code, message, severity: 'warning' });

  it('keeps only the "SYSTEM" deferred-save warning, dropping per-shot validation warnings', () => {
    // The adversarial case the change must get right: a successful import that
    // ALSO carries routine validation warnings must not be treated as a save
    // failure.
    const result = deferredSaveWarnings([
      w('LONG_SHOT', 'Shot 3:5 length above threshold'),
      w('SYSTEM', 'Imported, but could not save … please save manually.'),
      w('AZIMUTH_DEVIATION'),
    ]);

    expect(result.map((x) => x.code)).toEqual(['SYSTEM']);
  });

  it('returns empty for a fully-saved import carrying only validation warnings', () => {
    expect(deferredSaveWarnings([w('LONG_SHOT'), w('SHORT_SHOT')])).toEqual([]);
  });

  it('handles empty and undefined', () => {
    expect(deferredSaveWarnings([])).toEqual([]);
    expect(deferredSaveWarnings(undefined)).toEqual([]);
  });
});

describe('finalizeDeferredSaveWarnings (#110)', () => {
  const sys = (message: string): ValidationWarning => ({ code: 'SYSTEM', message, severity: 'warning' });
  const val = (code: string): ValidationWarning => ({ code, message: code, severity: 'warning' });

  it('returns false and surfaces nothing for a fully-saved import with validation warnings', () => {
    const ui = mockUi();

    const handled = finalizeDeferredSaveWarnings([val('LONG_SHOT')], 'tml-import', ui, receiptFixture());

    expect(handled).toBe(false);
    expect(ui.closeDialog).not.toHaveBeenCalled();
    expect(ui.openDialog).not.toHaveBeenCalled();
  });

  it('threads the save warning into the receipt as its LEADING row', () => {
    // The "unsaved" warning must outrank format caveats: it goes first, so the
    // receipt's 3-row visible window can never hide it behind converter notes.
    const ui = mockUi();
    const saveMsg =
      'Imported, but could not save the new project to disk: disk full. ' +
      'Your changes are unsaved - please save manually.';

    const handled = finalizeDeferredSaveWarnings(
      [val('LONG_SHOT'), sys(saveMsg)],
      'tml-import',
      ui,
      receiptFixture(['2 zero-shot sections were skipped']),
    );

    expect(handled).toBe(true);
    expect(ui.closeDialog).toHaveBeenCalled();
    expect(ui.openDialog).toHaveBeenCalledWith('import-receipt', {
      receipt: expect.objectContaining({
        warnings: [saveMsg, '2 zero-shot sections were skipped'],
      }),
    });
  });

  it('falls back to a warning dialog when the result carried no receipt', () => {
    const ui = mockUi();

    const handled = finalizeDeferredSaveWarnings([sys('first'), sys('second')], 'tml-import', ui);

    expect(handled).toBe(true);
    expect(ui.openDialog).toHaveBeenCalledWith('error', {
      title: 'Import Warning',
      message: 'first\n\nsecond',
      hideReportHint: true,
    });
  });
});

describe('presentImportReceipt (#411/#420)', () => {
  it('surfaces a warning-free receipt as a toast, never opens the modal', () => {
    const ui = mockUi();

    presentImportReceipt(receiptFixture(), ui);

    expect(ui.openDialog).not.toHaveBeenCalled();
    expect(ui.showToast).toHaveBeenCalledTimes(1);
    expect(ui.showToast).toHaveBeenCalledWith(expect.stringContaining('Ariane TML'), 'import-receipt', 'success');
  });

  it('keeps the modal for a receipt with even one warning, never toasts', () => {
    const ui = mockUi();

    presentImportReceipt(receiptFixture(['2 zero-shot sections were skipped']), ui);

    expect(ui.showToast).not.toHaveBeenCalled();
    expect(ui.openDialog).toHaveBeenCalledWith('import-receipt', {
      receipt: expect.objectContaining({ warnings: ['2 zero-shot sections were skipped'] }),
    });
  });

  it('keeps the modal for a zero-count receipt even with no warnings (#442)', () => {
    const ui = mockUi();
    const empty: ImportReceipt = { ...receiptFixture(), sections_imported: 0, shot_count: 0 };

    presentImportReceipt(empty, ui);

    expect(ui.showToast).not.toHaveBeenCalled();
    expect(ui.openDialog).toHaveBeenCalledWith('import-receipt', { receipt: empty });
  });

  it('keeps the modal when sections_imported is zero even if shot_count disagrees (#442)', () => {
    // shot_count is summed from the sections the import ATTEMPTED
    // (command_import.rs), sections_imported from what actually landed - they
    // only agree today because the import loop is all-or-nothing. Pin the
    // guard on sections_imported alone so a future partial-drop path can't
    // slip a "nothing landed" receipt through as a toast just because
    // shot_count is stale/nonzero.
    const ui = mockUi();
    const disagreeing: ImportReceipt = { ...receiptFixture(), sections_imported: 0, shot_count: 40 };

    presentImportReceipt(disagreeing, ui);

    expect(ui.showToast).not.toHaveBeenCalled();
    expect(ui.openDialog).toHaveBeenCalledWith('import-receipt', { receipt: disagreeing });
  });

  it('keeps the modal for a unit-converted receipt even with no warnings', () => {
    const ui = mockUi();
    const converted: ImportReceipt = {
      ...receiptFixture(),
      unit_conversion: 'Lengths converted from feet to meters',
    };

    presentImportReceipt(converted, ui);

    expect(ui.showToast).not.toHaveBeenCalled();
    expect(ui.openDialog).toHaveBeenCalledWith('import-receipt', { receipt: converted });
  });

  it('toasts a warning-free, non-converted receipt (control case)', () => {
    const ui = mockUi();
    const plain: ImportReceipt = { ...receiptFixture(), unit_conversion: null };

    presentImportReceipt(plain, ui);

    expect(ui.openDialog).not.toHaveBeenCalled();
    expect(ui.showToast).toHaveBeenCalledTimes(1);
  });

  it('an info line does not promote a warning-free receipt from toast to dialog (#446)', () => {
    const ui = mockUi();
    // The shape `finishImportWithoutOrphanSuggestions` actually produces:
    // the full sentence rides `info` (for the modal path), the SHORT toast
    // form is driven by `unanchoredCount` (item 5).
    const withInfo: ImportReceiptWithUnanchoredCount = {
      ...receiptFixture(),
      info: ['1 section is not connected to a zero datum'],
      unanchoredCount: 1,
    };

    presentImportReceipt(withInfo, ui);

    expect(ui.openDialog).not.toHaveBeenCalled();
    expect(ui.showToast).toHaveBeenCalledTimes(1);
  });

  it('the toast never carries the full info sentence - only the short scale (#446)', () => {
    const ui = mockUi();
    const withInfo: ImportReceiptWithUnanchoredCount = {
      ...receiptFixture(),
      info: ['3 sections are not connected to a zero datum'],
      unanchoredCount: 3,
    };

    presentImportReceipt(withInfo, ui);

    const [message] = ui.showToast.mock.calls[0] as [string, string, string];
    expect(message).toContain('3 sections unanchored');
    expect(message).not.toContain('3 sections are not connected to a zero datum');
  });

  it('the modal path (ImportReceiptDialog via importReceiptSummaryParts) still gets the full sentence', () => {
    const withInfo: ImportReceipt = {
      ...receiptFixture(['triggers the modal']),
      info: ['3 sections are not connected to a zero datum'],
    };

    const parts = importReceiptSummaryParts(withInfo, i18n.t);

    expect(parts).toContain('3 sections are not connected to a zero datum');
  });
});

describe('finishImportWithoutOrphanSuggestions (#446)', () => {
  beforeEach(() => {
    invokeIpcMock.mockReset();
  });

  it('appends the info line and stamps unanchoredCount when the count is > 0', async () => {
    invokeIpcMock.mockResolvedValue(2);
    const ui = mockUi();

    await finishImportWithoutOrphanSuggestions('tml-import', ui, [1, 2], receiptFixture());

    expect(invokeIpcMock).toHaveBeenCalledWith(
      'count_unanchored_sections',
      { newlyImportedSectionIds: [1, 2] },
      expect.anything(),
    );
    expect(ui.showToast).toHaveBeenCalledTimes(1);
    const [message] = ui.showToast.mock.calls[0] as [string, string, string];
    expect(message).toContain('2 sections unanchored');
  });

  it('leaves the receipt untouched when the count is 0', async () => {
    invokeIpcMock.mockResolvedValue(0);
    const ui = mockUi();

    await finishImportWithoutOrphanSuggestions('tml-import', ui, [1], receiptFixture());

    expect(ui.showToast).toHaveBeenCalledTimes(1);
    const [message] = ui.showToast.mock.calls[0] as [string, string, string];
    expect(message).not.toContain('unanchored');
  });

  it('is non-fatal when the IPC call throws - the import still completes', async () => {
    invokeIpcMock.mockRejectedValue(new Error('boom'));
    const ui = mockUi();

    await finishImportWithoutOrphanSuggestions('tml-import', ui, [1], receiptFixture());

    expect(ui.closeDialog).toHaveBeenCalled();
    expect(ui.showToast).toHaveBeenCalledTimes(1);
    const [message] = ui.showToast.mock.calls[0] as [string, string, string];
    expect(message).not.toContain('unanchored');
  });

  it('does nothing (no IPC call) when there is no receipt to decorate', async () => {
    const ui = mockUi();

    await finishImportWithoutOrphanSuggestions('tml-import', ui, [1]);

    expect(invokeIpcMock).not.toHaveBeenCalled();
    expect(ui.closeDialog).toHaveBeenCalled();
  });

  it('routes through the dialog path when the resulting receipt also carries a warning', async () => {
    invokeIpcMock.mockResolvedValue(1);
    const ui = mockUi();

    await finishImportWithoutOrphanSuggestions(
      'tml-import',
      ui,
      [1],
      receiptFixture(['1 shot skipped']),
    );

    expect(ui.showToast).not.toHaveBeenCalled();
    expect(ui.openDialog).toHaveBeenCalledWith(
      'import-receipt',
      expect.objectContaining({
        receipt: expect.objectContaining({
          info: ['1 section is not connected to a zero datum'],
        }),
      }),
    );
  });
});

describe('completeImportToSingleView receipt routing (#411/#420)', () => {
  it('routes a warning-free receipt to the toast, not the receipt dialog', () => {
    const ui = mockUi();

    completeImportToSingleView('tml-import', ui, receiptFixture());

    expect(ui.closeDialog).toHaveBeenCalled();
    expect(ui.setView).toHaveBeenCalledWith('single');
    expect(ui.openDialog).not.toHaveBeenCalled();
    expect(ui.showToast).toHaveBeenCalledTimes(1);
  });

  it('routes a receipt carrying a warning to the receipt dialog, not a toast', () => {
    const ui = mockUi();

    completeImportToSingleView('tml-import', ui, receiptFixture(['1 shot skipped']));

    expect(ui.showToast).not.toHaveBeenCalled();
    expect(ui.openDialog).toHaveBeenCalledWith('import-receipt', {
      receipt: expect.objectContaining({ warnings: ['1 shot skipped'] }),
    });
  });
});

describe('surfaceImportFailure', () => {
  it('command failure: closes the dialog and reports WITHOUT the navigate/fit exit', () => {
    const ui = mockUi();

    surfaceImportFailure('tml-import', ui, { phase: 'command', error: 'Bad azimuth on shot 3' });

    expect(ui.closeDialog).toHaveBeenCalled();
    // #411 C2: the exit sequence dropped the user into the empty project the
    // import had just created - and fitted the map to it - BEFORE saying why.
    expect(ui.setView).not.toHaveBeenCalled();
    expect(ui.triggerFitToBounds).not.toHaveBeenCalled();
    // A rejected import command is the user's file, not a Stalagmight defect
    // (#447) - the report-a-bug hint is dropped.
    expect(ui.openDialog).toHaveBeenCalledWith('error', {
      title: 'Import Errors',
      message: 'Bad azimuth on shot 3',
      hideReportHint: true,
    });
  });

  it('transport failure: skips the shared exit sequence (no complete, no view switch)', () => {
    const ui = mockUi();

    surfaceImportFailure('walls-import', ui, {
      phase: 'transport',
      error: new Error('ipc timeout'),
      format: 'Walls',
    });

    expect(ui.closeDialog).not.toHaveBeenCalled();
    expect(ui.setView).not.toHaveBeenCalled();
    expect(ui.openDialog).toHaveBeenCalledWith('error', {
      title: 'Import Failed',
      message: 'ipc timeout',
    });
  });

  it('empty import: closes the dialog and says why, without the fitted-view exit', () => {
    const ui = mockUi();

    surfaceImportFailure('walls-import', ui, { phase: 'empty', message: 'No survey shots were found to import.' });

    expect(ui.closeDialog).toHaveBeenCalled();
    expect(ui.setView).not.toHaveBeenCalled();
    // Nothing surviving the chosen options is the user's toggles, not a defect
    // (#447) - the report-a-bug hint is dropped.
    expect(ui.openDialog).toHaveBeenCalledWith('error', {
      title: 'Nothing imported',
      message: 'No survey shots were found to import.',
      hideReportHint: true,
    });
  });
});

/**
 * `importContext` is read by `saveAfterImport` to decide between "write the
 * deferred initial save" and "just mark dirty". Left set past the end of its
 * flow, the next import whose route sets none inherits it and silently commits
 * the user's unrelated pending edits - so both flow terminators drop it.
 */
describe('import-context lifetime', () => {
  beforeEach(() => {
    useUIStore.setState({ importContext: 'new-project' });
  });

  it('is dropped by the success funnel', () => {
    completeImportToSingleView('tml-import', mockUi());

    expect(useUIStore.getState().importContext).toBeNull();
  });

  it.each(['command', 'transport', 'empty'] as const)('is dropped by a %s failure', (phase) => {
    const failure =
      phase === 'command'
        ? ({ phase, error: 'boom' } as const)
        : phase === 'transport'
          ? ({ phase, error: new Error('boom'), format: 'TML' } as const)
          : ({ phase, message: 'nothing to import' } as const);

    surfaceImportFailure('tml-import', mockUi(), failure);

    expect(useUIStore.getState().importContext).toBeNull();
  });
});
