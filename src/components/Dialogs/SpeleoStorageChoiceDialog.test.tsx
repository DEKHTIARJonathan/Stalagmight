/**
 * Component test - the login-time "where should your API key go?" prompt.
 *
 * The three properties worth pinning are the ones a user would be harmed by if
 * they broke: each option sends the mode it advertises, dismissing persists
 * NOTHING (so the question can be asked again rather than being silently settled
 * against the user), and the copy says out loud that only the API key is stored.
 * That last one is not decoration - without it "this session only" reads as "you
 * will have to re-enter your password", and people pick the less safe option to
 * dodge a cost that does not exist.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const invokeIpcMock = vi.hoisted(() => vi.fn());
vi.mock('../../utils/ipc', () => ({
  invokeIpc: invokeIpcMock,
  getErrorMessage: (_e: unknown, f?: string) => f ?? 'error',
}));

// Real copy, so the assertions below are about what the user actually reads.
import '../../i18n';
import SpeleoStorageChoiceDialog from './SpeleoStorageChoiceDialog';
import { useSpeleoStore } from '../../store/speleoStore';
import { useUIStore } from '../../store/uiStore';

const SESSION_ONLY = {
  logged_in: true,
  user_email: 'u@x',
  endpoint: 'https://sdb.example',
  keychain_backed: false,
  storage: 'memory',
  keychain: 'declined',
};

let showToastMock: ReturnType<typeof vi.fn>;
let closeDialogMock: ReturnType<typeof vi.fn>;

const storageCalls = () =>
  invokeIpcMock.mock.calls.filter((c) => c[0] === 'speleodb_set_token_storage');

beforeEach(() => {
  invokeIpcMock.mockReset();
  invokeIpcMock.mockResolvedValue(SESSION_ONLY);
  showToastMock = vi.fn();
  closeDialogMock = vi.fn();
  useSpeleoStore.setState({ session: null, storageChoiceOpen: true });
  useUIStore.setState({ showToast: showToastMock, closeDialog: closeDialogMock });
});

describe('SpeleoStorageChoiceDialog', () => {
  it('offers both tiers and says only the API key is stored', () => {
    render(<SpeleoStorageChoiceDialog />);

    expect(screen.getByTestId('speleodb-storage-choice-session')).toBeInTheDocument();
    expect(screen.getByTestId('speleodb-storage-choice-file')).toBeInTheDocument();
    // The whole point of the sentence: no password is kept, so "session only"
    // costs a sign-in, not a re-typed password.
    const note = screen.getByTestId('speleodb-storage-choice-key-only').textContent ?? '';
    expect(note).toContain('never your password');
  });

  it('the session-only option asks the backend for that tier and seeds the session', async () => {
    render(<SpeleoStorageChoiceDialog />);
    await userEvent.click(screen.getByTestId('speleodb-storage-choice-session'));

    await waitFor(() => expect(storageCalls()).toHaveLength(1));
    expect(storageCalls()[0]?.[1]).toEqual({ mode: 'session_only' });
    // Seeded from the ANSWER, so the panel reports where the key actually landed.
    expect(useSpeleoStore.getState().session?.storage).toBe('memory');
    expect(useSpeleoStore.getState().storageChoiceOpen).toBe(false);
  });

  it('the file option asks the backend for the plaintext tier', async () => {
    invokeIpcMock.mockResolvedValue({ ...SESSION_ONLY, storage: 'plaintext' });
    render(<SpeleoStorageChoiceDialog />);
    await userEvent.click(screen.getByTestId('speleodb-storage-choice-file'));

    await waitFor(() => expect(storageCalls()).toHaveLength(1));
    expect(storageCalls()[0]?.[1]).toEqual({ mode: 'plaintext' });
    expect(useSpeleoStore.getState().session?.storage).toBe('plaintext');
  });

  it('does not claim a file when the key actually fell back to memory', async () => {
    // The backend deliberately falls back to session-only when the plaintext write
    // fails (a full or read-only filesystem) and reports that truthfully. The toast
    // was keyed on the button that was pressed, so it said the key had been saved to
    // a file - and the user was signed out on the next launch with no explanation.
    invokeIpcMock.mockResolvedValue(SESSION_ONLY);
    render(<SpeleoStorageChoiceDialog />);
    await userEvent.click(screen.getByTestId('speleodb-storage-choice-file'));

    await waitFor(() => expect(showToastMock).toHaveBeenCalled());
    const [message, , kind] = showToastMock.mock.calls[0] ?? [];
    expect(message).not.toContain('is saved to a file');
    expect(message).toContain('could not be written to a file');
    expect(kind).toBe('warning');
  });

  it('says the file was written when the file is what took the key', async () => {
    invokeIpcMock.mockResolvedValue({ ...SESSION_ONLY, storage: 'plaintext' });
    render(<SpeleoStorageChoiceDialog />);
    await userEvent.click(screen.getByTestId('speleodb-storage-choice-file'));

    await waitFor(() => expect(showToastMock).toHaveBeenCalled());
    const [message, , kind] = showToastMock.mock.calls[0] ?? [];
    expect(message).toContain('saved to a file');
    expect(kind).toBe('success');
  });

  it('dismissing persists nothing and leaves the session alone', async () => {
    render(<SpeleoStorageChoiceDialog />);
    await userEvent.click(screen.getByTestId('speleodb-storage-choice-dismiss'));

    // No IPC AT ALL: recording a refusal for someone who escaped out of the
    // prompt would settle a question they never answered, and the persisted
    // refusal is exactly what stops the keychain being tried again.
    expect(invokeIpcMock).not.toHaveBeenCalled();
    expect(useSpeleoStore.getState().storageChoiceOpen).toBe(false);
    // And it closes only ITSELF - the Settings dialog this is usually layered
    // over must survive with its other staged edits intact.
    expect(closeDialogMock).not.toHaveBeenCalled();
  });

  it('keeps the prompt open when the backend refuses the choice', async () => {
    invokeIpcMock.mockRejectedValue({ message: 'not signed in' });
    render(<SpeleoStorageChoiceDialog />);
    await userEvent.click(screen.getByTestId('speleodb-storage-choice-file'));

    await waitFor(() => expect(storageCalls()).toHaveLength(1));
    // Closing here would look like the choice landed, while the key stays
    // wherever the failed login left it.
    expect(useSpeleoStore.getState().storageChoiceOpen).toBe(true);
    expect(showToastMock).toHaveBeenCalledWith(
      expect.any(String),
      'speleodb-storage-choice',
      'error',
    );
  });
});
