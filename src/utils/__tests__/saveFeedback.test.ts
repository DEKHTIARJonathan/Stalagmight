import { describe, it, expect, vi, beforeEach } from 'vitest';

import { surfaceSaveFailure, surfaceImportWarnings } from '../saveFeedback';
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

describe('surfaceImportWarnings (#110)', () => {
  const warn = (message: string): ValidationWarning => ({
    code: 'SYSTEM',
    message,
    severity: 'warning',
  });

  it('is a no-op when there are no warnings (empty or undefined)', () => {
    const openDialog = vi.fn();

    surfaceImportWarnings([], openDialog);
    surfaceImportWarnings(undefined, openDialog);

    expect(openDialog).not.toHaveBeenCalled();
  });

  it('surfaces a deferred-save warning so the user knows the import is unsaved', () => {
    const openDialog = vi.fn();
    const message =
      'Imported, but could not save the new project to disk: disk full. ' +
      'Your changes are unsaved — please save manually.';

    surfaceImportWarnings([warn(message)], openDialog);

    expect(openDialog).toHaveBeenCalledWith('error', {
      title: 'Import Warning',
      message,
    });
  });

  it('joins multiple warnings into a single message', () => {
    const openDialog = vi.fn();

    surfaceImportWarnings([warn('first'), warn('second')], openDialog);

    expect(openDialog).toHaveBeenCalledWith('error', {
      title: 'Import Warning',
      message: 'first\n\nsecond',
    });
  });
});
