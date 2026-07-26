/**
 * Component test - [#270] the close-flow guard, and the lock-less state it newly has
 * to survive.
 *
 * `useProject.handleCloseProject` used to gate this dialog on `editState === 'editing'`
 * alone. That is the same defect `guardQuit` was fixed for: a re-verify divergence, or
 * a `clearSession()` after a dead token, drops to read-only while KEEPING the unpushed
 * edits - so closing a saved-but-unpushed remote project returned straight to the home
 * screen with no notice. The guard now also fires on the unpushed work alone, which
 * means this dialog can be reached with NO lock - where every verb it used to offer
 * ("Push, release & close", "Close & keep the lock") could only fail.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const invokeIpcMock = vi.hoisted(() => vi.fn());
vi.mock('../../utils/ipc', () => ({
  invokeIpc: invokeIpcMock,
  getErrorMessage: (_e: unknown, f?: string) => f ?? 'the server said no',
}));

import SpeleoCloseDialog from './SpeleoCloseDialog';
import { useSpeleoStore, type SpeleoLinkState } from '../../store/speleoStore';
import { useProjectStore } from '../../store/projectStore';
import { useUIStore } from '../../store/uiStore';

const LINK: SpeleoLinkState = {
  permission: 'READ_AND_WRITE',
  editState: 'editing',
  lockHolder: null,
  lockedByOther: false,
  hasUnpushedEdits: true,
  forceEditing: false,
  forceEditAllowed: false,
  remoteState: 'up_to_date',
  noAccess: false,
  serverError: null,
};

const seedLink = (o: Partial<SpeleoLinkState> = {}) =>
  useSpeleoStore.setState({ link: { ...LINK, ...o }, banner: null, busy: false });

let closeProject: ReturnType<typeof vi.fn>;
let saveProject: ReturnType<typeof vi.fn>;
let closeDialog: ReturnType<typeof vi.fn>;

beforeEach(() => {
  invokeIpcMock.mockReset();
  invokeIpcMock.mockResolvedValue({ kind: 'released' });
  closeProject = vi.fn(async () => ({ success: true }));
  saveProject = vi.fn(async () => ({ success: true }));
  closeDialog = vi.fn();
  useProjectStore.setState({
    // A georeferenced zero datum keeps the unrelated no-anchor notice quiet.
    project: { zero_datums: [{}] } as never,
    isDirty: false,
    closeProject: closeProject as never,
    saveProject: saveProject as never,
  });
  seedLink();
  useUIStore.setState({
    activeDialog: 'speleodb-close',
    dialogData: {},
    closeDialog,
    openDialog: vi.fn(),
    showToast: vi.fn(),
  });
});

describe('SpeleoCloseDialog while we hold the lock', () => {
  it('offers both lock verbs and pushes + releases through `done`', async () => {
    render(<SpeleoCloseDialog />);
    expect(screen.getByTestId('speleodb-close-keep-lock')).toBeInTheDocument();
    expect(screen.queryByTestId('speleodb-close-anyway')).not.toBeInTheDocument();

    await userEvent.click(screen.getByTestId('speleodb-close-push-release'));

    await waitFor(() => expect(closeProject).toHaveBeenCalled());
    expect(invokeIpcMock.mock.calls.some((c) => c[0] === 'speleodb_done')).toBe(true);
  });
});

describe('SpeleoCloseDialog with no lock (#270)', () => {
  const noLock = () => seedLink({ editState: 'read-only', hasUnpushedEdits: true });

  it('offers no lock verb at all - only the honest "close anyway"', () => {
    noLock();
    render(<SpeleoCloseDialog />);
    expect(screen.queryByTestId('speleodb-close-push-release')).not.toBeInTheDocument();
    expect(screen.queryByTestId('speleodb-close-keep-lock')).not.toBeInTheDocument();
    expect(screen.getByTestId('speleodb-close-anyway')).toBeInTheDocument();
  });

  it('closes without issuing any push or release IPC', async () => {
    noLock();
    render(<SpeleoCloseDialog />);

    await userEvent.click(screen.getByTestId('speleodb-close-anyway'));

    await waitFor(() => expect(closeProject).toHaveBeenCalledWith({ releaseLock: false }));
    expect(
      invokeIpcMock.mock.calls.filter((c) => String(c[0]).startsWith('speleodb_')),
    ).toEqual([]);
  });

  it('still flushes the .stalx first when the project is disk-dirty', async () => {
    // The work is only on this computer, so the one thing that can still protect it
    // is the local save - and the close must abort if that save fails.
    noLock();
    useProjectStore.setState({ isDirty: true });
    render(<SpeleoCloseDialog />);

    await userEvent.click(screen.getByTestId('speleodb-close-anyway'));

    await waitFor(() => expect(saveProject).toHaveBeenCalled());
    expect(closeProject).toHaveBeenCalled();
  });

  it('does NOT close when that save fails', async () => {
    noLock();
    useProjectStore.setState({
      isDirty: true,
      saveProject: vi.fn(async () => ({ success: false, error: 'disk full' })) as never,
    });
    render(<SpeleoCloseDialog />);

    await userEvent.click(screen.getByTestId('speleodb-close-anyway'));

    await waitFor(() => expect(screen.getByTestId('speleodb-close-dialog')).toBeInTheDocument());
    expect(closeProject).not.toHaveBeenCalled();
  });

  it('treats a force-edit session as lock-less - there is nothing to push or release', () => {
    // #213 force-editing has the edit gate open WITHOUT a lock.
    seedLink({ editState: 'editing', forceEditing: true, hasUnpushedEdits: true });
    render(<SpeleoCloseDialog />);
    expect(screen.getByTestId('speleodb-close-anyway')).toBeInTheDocument();
    expect(screen.queryByTestId('speleodb-close-push-release')).not.toBeInTheDocument();
  });
});
