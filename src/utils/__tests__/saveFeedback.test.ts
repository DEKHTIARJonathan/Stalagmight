import { describe, it, expect, vi, beforeEach } from 'vitest';

import { surfaceSaveFailure, surfaceImportWarnings, deferredSaveWarnings } from '../saveFeedback';
import { useProjectStore } from '../../store/projectStore';
import type { ValidationWarning } from '../../types/ipc/ValidationWarning';

describe('surfaceSaveFailure', () => {
  beforeEach(() => {
    useProjectStore.setState({ integritySaveBlocked: false, integrityDialogOpen: false });
  });

  it('routes a save-blocked failure to Review & Repair, not an error window', () => {
    useProjectStore.setState({ integritySaveBlocked: true });
    const openDialog = vi.fn();

    surfaceSaveFailure("Can't save: 1 unresolved cross-reference", openDialog);

    // No error dialog — instead the integrity (Review & Repair) dialog opens.
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

describe('surfaceImportWarnings (#110)', () => {
  const sys = (message: string): ValidationWarning => ({ code: 'SYSTEM', message, severity: 'warning' });

  it('is a no-op when given no warnings', () => {
    const openDialog = vi.fn();

    surfaceImportWarnings([], openDialog);

    expect(openDialog).not.toHaveBeenCalled();
  });

  it('opens the warning dialog and suppresses the "report as a bug" footer', () => {
    const openDialog = vi.fn();
    const message =
      'Imported, but could not save the new project to disk: disk full. ' +
      'Your changes are unsaved — please save manually.';

    surfaceImportWarnings([sys(message)], openDialog);

    expect(openDialog).toHaveBeenCalledWith('error', {
      title: 'Import Warning',
      message,
      hideReportHint: true,
    });
  });

  it('joins multiple warnings into a single message', () => {
    const openDialog = vi.fn();

    surfaceImportWarnings([sys('first'), sys('second')], openDialog);

    expect(openDialog).toHaveBeenCalledWith('error', {
      title: 'Import Warning',
      message: 'first\n\nsecond',
      hideReportHint: true,
    });
  });
});
