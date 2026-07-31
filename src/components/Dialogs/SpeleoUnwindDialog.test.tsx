/**
 * [#303] Component test - the Unwind confirmation (spec item 18's second half).
 *
 * Two things it has to get right. Cancelling must change NOTHING: the action downloads a
 * revision and replaces the working copy, so a dialog that acted on open (or on dismiss)
 * would be destructive by accident. And the two shapes of the same action have to READ
 * differently - reloading the current commit's history does not move the survey, while
 * stepping to an ancestor does - because that is the whole difference a user needs before
 * pressing it.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const invokeIpcMock = vi.hoisted(() => vi.fn());
vi.mock('../../utils/ipc', () => ({
  invokeIpc: invokeIpcMock,
  getErrorMessage: (e: unknown) => (e instanceof Error ? e.message : String(e)),
}));

import SpeleoUnwindDialog from './SpeleoUnwindDialog';
import { useSpeleoStore } from '../../store/speleoStore';
import { useProjectStore } from '../../store/projectStore';
import { useUIStore } from '../../store/uiStore';

const HEXSHA = 'abcdef0123456789';

let closeDialogMock: ReturnType<typeof vi.fn>;

const open = (isCurrent: boolean) => {
  useSpeleoStore.setState({ remoteProjectId: 'p1' });
  useProjectStore.setState({ project: { name: 'Cave A' } as never });
  useUIStore.setState({
    activeDialog: 'speleodb-unwind',
    dialogData: { hexsha: HEXSHA, isCurrent },
  });
};

describe('SpeleoUnwindDialog (#303)', () => {
  beforeEach(() => {
    invokeIpcMock.mockReset();
    invokeIpcMock.mockResolvedValue({ local_path: '/cache/p1.stalx', concurrent_session: false });
    // Stub the post-swap refresh the shared hook runs. Left real, it feeds the restore
    // RESULT to `get_project_state` and logs two failures per test - noise that would
    // hide a genuine one. What this file is about is the IPC payload and the copy.
    closeDialogMock = vi.fn(() => useUIStore.setState({ activeDialog: null }));
    useUIStore.setState({ closeDialog: closeDialogMock, showToast: vi.fn(), setView: vi.fn() });
    useProjectStore.setState({
      refreshProjectState: vi.fn(async () => {}),
      checkProjectIntegrity: vi.fn(async () => []),
    });
    useSpeleoStore.setState({ refreshLinkStatus: vi.fn(async () => {}) });
  });

  it('words the current-commit case as loading history, not moving the survey', () => {
    open(true);
    render(<SpeleoUnwindDialog />);
    const body = screen.getByTestId('speleodb-unwind-body').textContent ?? '';
    expect(body).toContain('Load the edit history');
    expect(body).toContain('does not change');
  });

  it('words the ancestor case as moving the survey back', () => {
    open(false);
    render(<SpeleoUnwindDialog />);
    const body = screen.getByTestId('speleodb-unwind-body').textContent ?? '';
    expect(body).toContain('Check the survey out to revision');
    // ...and says what a later push does, since SpeleoDB has no revert.
    expect(screen.getByText(/records the older survey as a new revision/)).toBeInTheDocument();
  });

  it('does nothing on cancel', async () => {
    open(true);
    render(<SpeleoUnwindDialog />);

    await userEvent.click(screen.getByTestId('speleodb-unwind-cancel'));

    expect(invokeIpcMock).not.toHaveBeenCalledWith(
      'speleodb_restore_revision',
      expect.anything(),
    );
    expect(useUIStore.getState().activeDialog).toBeNull();
  });

  it('confirms as a Restore that KEEPS the downloaded history', async () => {
    open(true);
    render(<SpeleoUnwindDialog />);

    await userEvent.click(screen.getByTestId('speleodb-unwind-confirm-btn'));

    await waitFor(() =>
      expect(invokeIpcMock).toHaveBeenCalledWith(
        'speleodb_restore_revision',
        expect.objectContaining({
          hexsha: HEXSHA,
          restore: true,
          keepUndoHistory: true,
          // The waiver: from the second step on, the copy is dirty because the PREVIOUS
          // step made it so. The backend only honours it when its chain pointer agrees.
          discardLocal: true,
        }),
      ),
    );
  });

  it('keeps the dialog open and shows the refusal when the backend says no', async () => {
    open(true);
    invokeIpcMock.mockRejectedValueOnce(new Error('undo the remaining steps first'));
    render(<SpeleoUnwindDialog />);

    await userEvent.click(screen.getByTestId('speleodb-unwind-confirm-btn'));

    await waitFor(() => expect(screen.getByTestId('speleodb-unwind-error')).toBeInTheDocument());
    // Still open, so the user can read what happened rather than watching it vanish.
    expect(screen.getByTestId('speleodb-unwind-dialog')).toBeInTheDocument();
  });
});
