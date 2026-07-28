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
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
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

/**
 * The mount gate App.tsx puts this dialog behind, mirrored because the property
 * under test IS the mount: a dismissal that lands mid-move takes the prompt off
 * screen, and rendering the component directly would hide exactly that. The
 * assertions below therefore read the DOM rather than `storageChoiceOpen`, so they
 * fail the way a user meets the bug - no prompt in front of them.
 */
function Host() {
  const open = useSpeleoStore((s) => s.storageChoiceOpen);
  return open ? <SpeleoStorageChoiceDialog /> : null;
}

const LOGGED_IN = {
  loggedIn: true,
  userEmail: 'u@x',
  endpoint: 'https://sdb.example',
  keychainBacked: false,
  storage: 'memory' as const,
  keychain: 'unavailable' as const,
};

/**
 * Hold `speleodb_set_token_storage` open so a dismissal can land while the move is
 * still in flight - the window the "stays open for retry" contract has to survive.
 * Everything else still resolves at once (the store chases a successful move with a
 * `get_config` reload; deferring that too would strand it before its own return).
 */
function deferStorageMove() {
  let settle: { resolve: (v: unknown) => void; reject: (e: unknown) => void } = {
    resolve: () => {},
    reject: () => {},
  };
  invokeIpcMock.mockImplementation((command: string) => {
    if (command === 'speleodb_set_token_storage') {
      return new Promise((resolve, reject) => {
        settle = { resolve, reject };
      });
    }
    return Promise.resolve(SESSION_ONLY);
  });
  return {
    fail: (e: unknown) => settle.reject(e),
    land: (status: unknown) => settle.resolve(status),
  };
}

const prompt = () => screen.queryByTestId('speleodb-storage-choice-dialog');

/**
 * The three routes that reach `DialogWrapper`'s `onClose`. None is gated on the
 * dialog's `busy`, unlike every visible button - which is the whole reason a
 * dismissal can land in the middle of a move.
 */
const dismissalRoutes: [string, () => Promise<void>][] = [
  [
    'Escape',
    async () => {
      // Dispatched at the dialog rather than through `userEvent.keyboard`, which
      // aims at `document.activeElement`: the button that was clicked is disabled
      // by the time this runs, and jsdom does not move focus off a disabled
      // element, so the keypress would land on a dead target and prove nothing.
      fireEvent.keyDown(screen.getByTestId('speleodb-storage-choice-dialog'), {
        key: 'Escape',
      });
    },
  ],
  [
    'the title-bar close control',
    async () => {
      await userEvent.click(screen.getByLabelText('Close dialog'));
    },
  ],
  [
    'the backdrop',
    async () => {
      // Needs the mousedown too: the wrapper only closes when the press STARTED on
      // the backdrop, so a bare click is ignored.
      const backdrop = document.querySelector('#dialog-root .bg-overlay');
      // Thrown rather than asserted-away: if the wrapper ever renames this element
      // the dismissal silently stops happening, and the test would then "pass" by
      // never exercising the route it is named for.
      if (!backdrop) throw new Error('no dialog backdrop to click');
      fireEvent.mouseDown(backdrop);
      fireEvent.click(backdrop);
    },
  ],
];

describe('SpeleoStorageChoiceDialog - a dismissal cannot escape the retry', () => {
  beforeEach(() => {
    useSpeleoStore.setState({ session: LOGGED_IN, storageChoiceOpen: true });
  });

  it.each(dismissalRoutes)(
    'a dismissal via %s while the move is in flight still leaves a failure asking again',
    async (_label, dismiss) => {
      const move = deferStorageMove();
      render(<Host />);

      await userEvent.click(screen.getByTestId('speleodb-storage-choice-session'));
      await waitFor(() => expect(storageCalls()).toHaveLength(1));

      // The buttons are disabled for the length of the move; this route is not, so
      // the prompt really does leave the screen mid-flight.
      await dismiss();
      await waitFor(() => expect(prompt()).not.toBeInTheDocument());

      move.fail({ message: 'not signed in' });

      // The contract `choose` states in prose. Without it the user is left with one
      // toast that fades, a key still sitting wherever the failed login left it, and
      // nothing that asks again until the NEXT login - the storage choice silently
      // unsettled with no prompt in front of them.
      await waitFor(() => expect(prompt()).toBeInTheDocument());
      expect(showToastMock).toHaveBeenCalledWith(
        expect.any(String),
        'speleodb-storage-choice',
        'error',
      );
      // And it came back USABLE - a fresh mount, not one stuck in the busy it was
      // dismissed in, or the retry it exists for would be unclickable.
      expect(screen.getByTestId('speleodb-storage-choice-session')).toBeEnabled();
    },
  );

  it('honours the dismissal when the move actually lands', async () => {
    // The other half of the invariant: re-raising is for a choice that did NOT
    // settle. Popping the prompt back over a move that succeeded would ask a
    // question the user has already answered, and contradict its own toast.
    const move = deferStorageMove();
    render(<Host />);

    await userEvent.click(screen.getByTestId('speleodb-storage-choice-session'));
    await waitFor(() => expect(storageCalls()).toHaveLength(1));
    fireEvent.keyDown(screen.getByTestId('speleodb-storage-choice-dialog'), { key: 'Escape' });
    await waitFor(() => expect(prompt()).not.toBeInTheDocument());

    move.land(SESSION_ONLY);

    await waitFor(() => expect(showToastMock).toHaveBeenCalled());
    expect(prompt()).not.toBeInTheDocument();
    expect(useSpeleoStore.getState().storageChoiceOpen).toBe(false);
  });

  it('does not re-raise over a session that ended underneath it', async () => {
    // `clearSession` shuts this overlay deliberately when the session ends - and
    // that same ending is one of the things that makes the move fail, because the
    // backend refuses to place a key it is no longer holding. Re-raising there
    // would ask where to keep a key that no longer exists.
    const move = deferStorageMove();
    render(<Host />);

    await userEvent.click(screen.getByTestId('speleodb-storage-choice-session'));
    await waitFor(() => expect(storageCalls()).toHaveLength(1));
    useSpeleoStore.getState().clearSession();
    await waitFor(() => expect(prompt()).not.toBeInTheDocument());

    move.fail({ message: 'not signed in' });

    await waitFor(() => expect(showToastMock).toHaveBeenCalled());
    expect(prompt()).not.toBeInTheDocument();
    expect(useSpeleoStore.getState().storageChoiceOpen).toBe(false);
  });

  it('DO NOT REGRESS: the options stay disabled while a move is in flight', async () => {
    // The disabled buttons are what make an in-flight move visible at all. If they
    // stop being disabled the dismissal routes are no longer the only way to
    // interrupt one, and a second click would race the first.
    deferStorageMove();
    render(<Host />);

    await userEvent.click(screen.getByTestId('speleodb-storage-choice-session'));

    await waitFor(() =>
      expect(screen.getByTestId('speleodb-storage-choice-session')).toBeDisabled(),
    );
    expect(screen.getByTestId('speleodb-storage-choice-file')).toBeDisabled();
    expect(screen.getByTestId('speleodb-storage-choice-dismiss')).toBeDisabled();
  });

  it('DO NOT REGRESS: an undismissed failure leaves the prompt on screen', async () => {
    // The pre-existing contract, asserted against the DOM rather than the flag:
    // nothing about the re-raise may turn "never closed" into "closed and reopened".
    invokeIpcMock.mockRejectedValue({ message: 'not signed in' });
    render(<Host />);

    await userEvent.click(screen.getByTestId('speleodb-storage-choice-file'));

    await waitFor(() => expect(showToastMock).toHaveBeenCalled());
    expect(prompt()).toBeInTheDocument();
  });

  it('DO NOT REGRESS: an undismissed success closes the prompt', async () => {
    invokeIpcMock.mockResolvedValue({ ...SESSION_ONLY, storage: 'plaintext' });
    render(<Host />);

    await userEvent.click(screen.getByTestId('speleodb-storage-choice-file'));

    await waitFor(() => expect(prompt()).not.toBeInTheDocument());
    expect(useSpeleoStore.getState().storageChoiceOpen).toBe(false);
  });
});
