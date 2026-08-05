import { describe, it, expect, vi, beforeEach } from 'vitest';

import {
  surfaceSaveFailure,
  surfaceImportFailure,
  completeImportToSingleView,
  finalizeDeferredSaveWarnings,
  deferredSaveWarnings,
  type ImportDialogUi,
} from '../saveFeedback';
import { useProjectStore } from '../../store/projectStore';
import { useUIStore } from '../../store/uiStore';
import type { ValidationWarning } from '../../types/ipc/ValidationWarning';
import type { ImportReceipt } from '../../types/ipc/ImportReceipt';

const mockUi = (): ImportDialogUi & { [K in keyof ImportDialogUi]: ReturnType<typeof vi.fn> } => ({
  closeDialog: vi.fn(),
  setView: vi.fn(),
  triggerFitToBounds: vi.fn(),
  openDialog: vi.fn(),
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

describe('surfaceImportFailure', () => {
  it('command failure: closes the dialog and reports WITHOUT the navigate/fit exit', () => {
    const ui = mockUi();

    surfaceImportFailure('tml-import', ui, { phase: 'command', error: 'Bad azimuth on shot 3' });

    expect(ui.closeDialog).toHaveBeenCalled();
    // #411 C2: the exit sequence dropped the user into the empty project the
    // import had just created - and fitted the map to it - BEFORE saying why.
    expect(ui.setView).not.toHaveBeenCalled();
    expect(ui.triggerFitToBounds).not.toHaveBeenCalled();
    expect(ui.openDialog).toHaveBeenCalledWith('error', {
      title: 'Import Errors',
      message: 'Bad azimuth on shot 3',
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
    expect(ui.openDialog).toHaveBeenCalledWith('error', {
      title: 'Nothing imported',
      message: 'No survey shots were found to import.',
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
