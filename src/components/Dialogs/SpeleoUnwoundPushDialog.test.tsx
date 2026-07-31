/**
 * [#303] The confirmation that stands between "I looked at an old version" and "I
 * published a revert".
 *
 * The bug it exists for was not subtle once seen: the close prompt read the dirty bit,
 * said "You have unpushed changes", and made "Push, release & close" its primary action -
 * so looking at history and closing the project recorded the older survey over the newer
 * one for everyone, in two clicks, under a reassurance that the work was safe.
 *
 * So what matters here is not that the dialog renders. It is that the SAFE action is the
 * default, the destructive one is named for what it does, and the push cannot happen
 * without the acknowledgement.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const invokeIpcMock = vi.hoisted(() => vi.fn());
vi.mock('../../utils/ipc', () => ({
  invokeIpc: invokeIpcMock,
  getErrorMessage: (e: unknown, f?: string) => (e as { message?: string })?.message ?? f ?? 'e',
}));

import SpeleoUnwoundPushDialog from './SpeleoUnwoundPushDialog';
import { useSpeleoStore } from '../../store/speleoStore';
import { useProjectStore } from '../../store/projectStore';
import { useUIStore } from '../../store/uiStore';

const open = () => {
  useUIStore.setState({
    activeDialog: 'speleodb-unwound-push',
    dialogData: { message: 'a commit message' },
  });
};

describe('SpeleoUnwoundPushDialog (#303)', () => {
  beforeEach(() => {
    invokeIpcMock.mockReset();
    invokeIpcMock.mockResolvedValue({ kind: 'editing' });
    useUIStore.setState({
      closeDialog: vi.fn(() => useUIStore.setState({ activeDialog: null })),
      openDialog: vi.fn(),
      showToast: vi.fn(),
    });
    useSpeleoStore.setState({ refreshLinkStatus: vi.fn(async () => {}) });
    useProjectStore.setState({ refreshProjectState: vi.fn(async () => {}) });
  });

  it('says the copy is older rather than calling it unsaved work', () => {
    open();
    render(<SpeleoUnwoundPushDialog />);

    expect(screen.getByTestId('speleodb-unwound-push-body')).toHaveTextContent(/older version/);
    // The consequence is about everyone else, which is what makes it worth a stop.
    expect(screen.getByTestId('speleodb-unwound-push-warning')).toHaveTextContent(
      /over the newer one/,
    );
  });

  it('makes discarding the primary action and pushing the marked one', () => {
    open();
    render(<SpeleoUnwoundPushDialog />);

    const discard = screen.getByTestId('speleodb-unwound-push-discard');
    const pushAnyway = screen.getByTestId('speleodb-unwound-push-push-anyway');
    // The safe way out is what the dialog defaults to - the inverse of the close prompt
    // that caused this.
    expect(discard).toHaveAttribute('data-primary-action');
    expect(pushAnyway).not.toHaveAttribute('data-primary-action');
    // ...and the destructive one says what it does, rather than "Push".
    expect(pushAnyway).toHaveTextContent(/older version/);
  });

  it('discards by returning to the tip WITH the lock, so work can continue', async () => {
    open();
    render(<SpeleoUnwoundPushDialog />);

    await userEvent.click(screen.getByTestId('speleodb-unwound-push-discard'));

    await waitFor(() => expect(invokeIpcMock).toHaveBeenCalledWith('speleodb_discard_changes', { keepLock: true }));
    // Never a push: that is the whole point of this branch.
    expect(invokeIpcMock).not.toHaveBeenCalledWith('speleodb_done', expect.anything());
  });

  it('carries the acknowledgement when the user insists, or it would loop', async () => {
    open();
    render(<SpeleoUnwoundPushDialog />);

    await userEvent.click(screen.getByTestId('speleodb-unwound-push-push-anyway'));

    // `useSpeleoActions.done` re-raises this dialog unless told the user was shown it,
    // so without the flag "Upload this older version" would do nothing but reopen.
    await waitFor(() =>
      expect(invokeIpcMock).toHaveBeenCalledWith(
        'speleodb_done',
        expect.objectContaining({ message: 'a commit message' }),
      ),
    );
  });

  it('offers both lock outcomes on the explicit Discard action', async () => {
    // Discarding the copy and deciding the lock are two questions. Someone resetting to
    // start again wants to keep editing; someone abandoning a session wants to hand the
    // project back. Folding them together forces the second user to discard, then go
    // hunting for Release.
    const { default: SpeleoDiscardChangesDialog } = await import('./SpeleoDiscardChangesDialog');
    useSpeleoStore.setState({
      link: { unwound: false, hasUnpushedEdits: true } as never,
      refreshLinkStatus: vi.fn(async () => {}),
    });
    useUIStore.setState({ activeDialog: 'speleodb-discard-changes', dialogData: {} });
    render(<SpeleoDiscardChangesDialog />);

    const keep = screen.getByTestId('speleodb-discard-changes-keep');
    expect(screen.getByTestId('speleodb-discard-changes-release')).toBeInTheDocument();
    // Keeping is primary: still holding the lock the user can release at any time,
    // whereas a released lock is a colleague's to take.
    expect(keep).toHaveAttribute('data-primary-action');

    await userEvent.click(screen.getByTestId('speleodb-discard-changes-release'));
    await waitFor(() =>
      expect(invokeIpcMock).toHaveBeenCalledWith('speleodb_discard_changes', { keepLock: false }),
    );
  });

  it('does nothing at all on cancel', async () => {
    open();
    render(<SpeleoUnwoundPushDialog />);

    await userEvent.click(screen.getByTestId('speleodb-unwound-push-cancel'));

    expect(invokeIpcMock).not.toHaveBeenCalled();
    expect(useUIStore.getState().activeDialog).toBeNull();
  });
});
