/**
 * The revert confirm. Two things are load-bearing here: the armed two-press discard
 * (with focus parked on Cancel, so keyboard repetition can never reach it), and
 * staying OPEN on a push failure - the revision is in the working copy and the lock
 * is still held, so closing would hide the one state the user has to act on.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const invokeIpcMock = vi.hoisted(() => vi.fn());
vi.mock('../../utils/ipc', () => ({
  invokeIpc: invokeIpcMock,
  getErrorMessage: (e: unknown, f?: string) =>
    (e as { message?: string })?.message ?? f ?? 'error',
}));

import SpeleoRevertDialog from './SpeleoRevertDialog';
import { useUIStore } from '../../store/uiStore';
import { useProjectStore } from '../../store/projectStore';
import { useSpeleoStore, type SpeleoLinkState } from '../../store/speleoStore';

const LINK: SpeleoLinkState = {
  permission: 'READ_AND_WRITE',
  editState: 'read-only',
  lockHolder: null,
  lockedByOther: false,
  hasUnpushedEdits: false,
  forceEditing: false,
  forceEditAllowed: false,
  remoteState: 'up_to_date',
  noAccess: false,
  serverError: null,
};

const RESTORED = { local_path: '/cache/p1.stalx', concurrent_session: false };

function ipc(routes: Record<string, () => unknown>): void {
  invokeIpcMock.mockImplementation(async (command: string) => routes[command]?.() ?? null);
}
const ok = (value: unknown) => () => value;
const rejects = (error: unknown) => () => {
  throw error;
};

const restoreCalls = () =>
  invokeIpcMock.mock.calls.filter((c) => c[0] === 'speleodb_restore_revision');

let closeDialogMock: ReturnType<typeof vi.fn>;
let openDialogMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  invokeIpcMock.mockReset();
  closeDialogMock = vi.fn();
  openDialogMock = vi.fn();
  useUIStore.setState({
    closeDialog: closeDialogMock,
    openDialog: openDialogMock,
    showToast: vi.fn(),
    setView: vi.fn(),
    clearSelection: vi.fn(),
    dialogData: {
      projectId: 'p1',
      projectName: 'Cave A',
      hexsha: 'abcdef0123',
      shortSha: 'abcdef01',
      message: 'the bad survey',
    },
  });
  useProjectStore.setState({
    refreshProjectState: vi.fn(async () => {}),
    checkProjectIntegrity: vi.fn(async () => []),
    saveProject: vi.fn(async () => ({ success: true }) as never),
    isDirty: false,
  });
  useSpeleoStore.setState({
    link: { ...LINK },
    remoteProjectId: 'p1',
    divergence: null,
    banner: null,
    busy: false,
    refreshLinkStatus: vi.fn(async () => {}),
  });
});

describe('SpeleoRevertDialog', () => {
  it('does not touch SpeleoDB on mount or cancel', async () => {
    ipc({});
    render(<SpeleoRevertDialog />);
    expect(screen.getByTestId('speleodb-revert-dialog')).toBeInTheDocument();
    await userEvent.click(screen.getByTestId('speleodb-revert-cancel'));
    expect(invokeIpcMock).not.toHaveBeenCalled();
    expect(closeDialogMock).toHaveBeenCalled();
  });

  it('prefills the commit message and sends the edited text to the push', async () => {
    ipc({
      speleodb_start_editing: ok({ kind: 'editing' }),
      speleodb_restore_revision: ok(RESTORED),
      speleodb_done: ok({ kind: 'released' }),
    });
    render(<SpeleoRevertDialog />);

    const box = screen.getByTestId('speleodb-revert-message') as HTMLTextAreaElement;
    expect(box.value).toContain('abcdef01');
    await userEvent.clear(box);
    await userEvent.type(box, 'roll back the bad merge');
    await userEvent.click(screen.getByTestId('speleodb-revert-confirm-btn'));

    await waitFor(() =>
      expect(invokeIpcMock.mock.calls.some((c) => c[0] === 'speleodb_done')).toBe(true),
    );
    const call = invokeIpcMock.mock.calls.find((c) => c[0] === 'speleodb_done');
    expect(call?.[1]).toEqual({ message: 'roll back the bad merge' });
    expect(closeDialogMock).toHaveBeenCalled();
  });

  it('returns to the dialog it was opened from when one is named', async () => {
    useUIStore.setState({
      dialogData: {
        projectId: 'p1',
        projectName: 'Cave A',
        hexsha: 'abcdef0123',
        shortSha: 'abcdef01',
        returnTo: 'speleodb-project',
      },
    });
    ipc({});
    render(<SpeleoRevertDialog />);

    await userEvent.click(screen.getByTestId('speleodb-revert-cancel'));

    expect(openDialogMock).toHaveBeenCalledWith('speleodb-project');
    expect(closeDialogMock).not.toHaveBeenCalled();
  });

  it('stays open and explains the held lock when the upload fails', async () => {
    ipc({
      speleodb_start_editing: ok({ kind: 'editing' }),
      speleodb_restore_revision: ok(RESTORED),
      speleodb_done: rejects({ message: 'offline' }),
    });
    render(<SpeleoRevertDialog />);

    await userEvent.click(screen.getByTestId('speleodb-revert-confirm-btn'));

    const error = await screen.findByTestId('speleodb-revert-error');
    // Names the state the user is now in: the revision is local, the lock is not back.
    expect(error.textContent).toMatch(/write lock/i);
    expect(closeDialogMock).not.toHaveBeenCalled();
    expect(screen.getByTestId('speleodb-revert-dialog')).toBeInTheDocument();
  });
});

describe('SpeleoRevertDialog - the armed discard', () => {
  beforeEach(() => {
    // An un-pushed copy: the pre-flight refuses without touching SpeleoDB at all.
    useSpeleoStore.setState({ link: { ...LINK, hasUnpushedEdits: true } });
  });

  it('offers the discard as a distinct, un-armed control', async () => {
    ipc({});
    render(<SpeleoRevertDialog />);

    await userEvent.click(screen.getByTestId('speleodb-revert-confirm-btn'));

    expect(await screen.findByTestId('speleodb-revert-discard-warning')).toBeInTheDocument();
    expect(screen.getByTestId('speleodb-revert-discard-offer-btn')).toBeInTheDocument();
    expect(screen.queryByTestId('speleodb-revert-discard-confirm-btn')).not.toBeInTheDocument();
    expect(screen.queryByTestId('speleodb-revert-confirm-btn')).not.toBeInTheDocument();
    // Refused before any IPC - no lock was taken to hand back.
    expect(invokeIpcMock).not.toHaveBeenCalled();
  });

  it('parks focus on Cancel the moment the destructive route appears', async () => {
    // React reconciles the discard control into the primary button's slot, so it would
    // otherwise inherit that button's focus and two more Enters would run the discard.
    ipc({});
    render(<SpeleoRevertDialog />);

    await userEvent.click(screen.getByTestId('speleodb-revert-confirm-btn'));
    await screen.findByTestId('speleodb-revert-discard-offer-btn');

    expect(screen.getByTestId('speleodb-revert-cancel')).toHaveFocus();
  });

  it('takes two further presses, and only then waives the guard', async () => {
    ipc({
      speleodb_start_editing: ok({ kind: 'editing' }),
      speleodb_restore_revision: ok(RESTORED),
      speleodb_done: ok({ kind: 'released' }),
    });
    render(<SpeleoRevertDialog />);

    await userEvent.click(screen.getByTestId('speleodb-revert-confirm-btn'));
    // Press 1 on the new control only arms it.
    await userEvent.click(await screen.findByTestId('speleodb-revert-discard-offer-btn'));
    expect(restoreCalls()).toHaveLength(0);
    // Press 2 performs it.
    await userEvent.click(await screen.findByTestId('speleodb-revert-discard-confirm-btn'));

    await waitFor(() => expect(restoreCalls()).toHaveLength(1));
    expect(restoreCalls()[0]?.[1]).toMatchObject({ restore: true, discardLocal: true });
    expect(closeDialogMock).toHaveBeenCalled();
  });

  it('a second Enter on the focused control after the refusal does NOT discard', async () => {
    ipc({
      speleodb_start_editing: ok({ kind: 'editing' }),
      speleodb_restore_revision: ok(RESTORED),
      speleodb_done: ok({ kind: 'released' }),
    });
    render(<SpeleoRevertDialog />);

    await userEvent.click(screen.getByTestId('speleodb-revert-confirm-btn'));
    await screen.findByTestId('speleodb-revert-discard-warning');

    await userEvent.keyboard('{Enter}');
    await userEvent.keyboard('{Enter}');

    expect(
      restoreCalls().some((c) => (c[1] as { discardLocal?: boolean }).discardLocal === true),
    ).toBe(false);
  });
});
