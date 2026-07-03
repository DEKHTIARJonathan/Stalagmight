/**
 * Component test (#213) - the optimistic force-edit confirm dialog.
 *
 * Covers the FE contract the Rust seam tests can't: the big-red confirm invokes
 * speleodb_force_edit (only on confirm, never on mount/cancel), then re-seeds the
 * link and closes; and it names the current lock holder when someone else holds it.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const invokeIpcMock = vi.hoisted(() => vi.fn());
vi.mock('../../utils/ipc', () => ({
  invokeIpc: invokeIpcMock,
  getErrorMessage: (_e: unknown, f?: string) => f ?? 'error',
}));

import SpeleoForceEditDialog from './SpeleoForceEditDialog';
import { useSpeleoStore, type SpeleoLinkState } from '../../store/speleoStore';
import { useUIStore } from '../../store/uiStore';

let refreshLinkStatusMock: ReturnType<typeof vi.fn>;
let closeDialogMock: ReturnType<typeof vi.fn>;
let showToastMock: ReturnType<typeof vi.fn>;

const LINK: SpeleoLinkState = {
  permission: 'READ_AND_WRITE',
  editState: 'read-only',
  lockHolder: null,
  lockedByOther: false,
  hasUnpushedEdits: false,
  forceEditing: false,
  forceEditAllowed: true,
  remoteState: 'up_to_date',
  noAccess: false,
  serverError: null,
};

const seedLink = (o: Partial<SpeleoLinkState> = {}) =>
  useSpeleoStore.setState({ link: { ...LINK, ...o } });

beforeEach(() => {
  invokeIpcMock.mockReset();
  invokeIpcMock.mockResolvedValue(null);
  refreshLinkStatusMock = vi.fn(async () => {});
  closeDialogMock = vi.fn();
  showToastMock = vi.fn();
  useSpeleoStore.setState({ link: null, refreshLinkStatus: refreshLinkStatusMock });
  useUIStore.setState({ closeDialog: closeDialogMock, showToast: showToastMock });
});

describe('SpeleoForceEditDialog (#213)', () => {
  it('does not force-edit on mount or cancel', async () => {
    seedLink();
    render(<SpeleoForceEditDialog />);

    expect(screen.getByTestId('speleodb-force-edit-warning')).toBeInTheDocument();
    expect(invokeIpcMock.mock.calls.some((c) => c[0] === 'speleodb_force_edit')).toBe(false);

    await userEvent.click(screen.getByTestId('speleodb-force-edit-cancel'));
    expect(invokeIpcMock.mock.calls.some((c) => c[0] === 'speleodb_force_edit')).toBe(false);
    expect(closeDialogMock).toHaveBeenCalled();
  });

  it('confirm invokes speleodb_force_edit, re-seeds the link, and closes', async () => {
    seedLink();
    render(<SpeleoForceEditDialog />);

    await userEvent.click(screen.getByTestId('speleodb-force-edit-confirm'));

    await waitFor(() =>
      expect(invokeIpcMock.mock.calls.some((c) => c[0] === 'speleodb_force_edit')).toBe(true),
    );
    await waitFor(() => expect(refreshLinkStatusMock).toHaveBeenCalled());
    await waitFor(() => expect(closeDialogMock).toHaveBeenCalled());
    expect(showToastMock).toHaveBeenCalledWith(expect.any(String), 'speleodb-force-edit');
  });

  it('names the lock holder when someone else holds it', () => {
    seedLink({ lockedByOther: true, lockHolder: 'holder@example.com' });
    render(<SpeleoForceEditDialog />);

    const note = screen.getByTestId('speleodb-force-edit-locked-by');
    expect(note.textContent).toContain('holder@example.com');
  });

  it('omits the locked-by note when the lock is free', () => {
    seedLink({ lockedByOther: false });
    render(<SpeleoForceEditDialog />);

    expect(screen.queryByTestId('speleodb-force-edit-locked-by')).not.toBeInTheDocument();
  });
});
