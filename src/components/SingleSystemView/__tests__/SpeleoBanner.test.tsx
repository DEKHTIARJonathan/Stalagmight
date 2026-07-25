/**
 * Component test (#213 force-edit banner, #260 push-failure banner).
 *
 * The big-red banner appears whenever the link is force-editing (edit gate on, no
 * lock held), outranking the transient yellow notices; its Reconnect action runs the
 * existing acquire verb (speleodb_start_editing). It names the holder when locked.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const invokeIpcMock = vi.hoisted(() => vi.fn());
vi.mock('../../../utils/ipc', () => ({
  invokeIpc: invokeIpcMock,
  getErrorMessage: (_e: unknown, f?: string) => f ?? 'error',
}));

import { SpeleoBanner } from '../SpeleoBanner';
import { useSpeleoStore, type SpeleoLinkState } from '../../../store/speleoStore';

const LINK: SpeleoLinkState = {
  permission: 'READ_AND_WRITE',
  editState: 'editing',
  lockHolder: null,
  lockedByOther: false,
  hasUnpushedEdits: true,
  forceEditing: true,
  forceEditAllowed: true,
  remoteState: 'unknown',
  noAccess: false,
  serverError: null,
};

const seedLink = (o: Partial<SpeleoLinkState> = {}) =>
  useSpeleoStore.setState({ link: { ...LINK, ...o }, banner: null });

beforeEach(() => {
  invokeIpcMock.mockReset();
  invokeIpcMock.mockResolvedValue({ kind: 'editing' });
  useSpeleoStore.setState({ link: null, banner: null, busy: false });
});

describe('SpeleoBanner force-edit (#213)', () => {
  it('renders the persistent force-edit banner while force-editing', () => {
    seedLink();
    render(<SpeleoBanner />);
    const banner = screen.getByTestId('speleo-banner');
    expect(banner).toHaveAttribute('data-kind', 'force_edit_active');
    // No dismiss - it is backend-derived and re-raised every poll.
    expect(screen.queryByTestId('speleo-banner-dismiss')).not.toBeInTheDocument();
  });

  it('Reconnect runs the acquire verb (speleodb_start_editing)', async () => {
    seedLink();
    render(<SpeleoBanner />);
    await userEvent.click(screen.getByTestId('speleo-banner-reconnect'));
    await waitFor(() =>
      expect(invokeIpcMock.mock.calls.some((c) => c[0] === 'speleodb_start_editing')).toBe(true),
    );
  });

  it('names the lock holder in the banner when someone else holds it', () => {
    seedLink({ lockedByOther: true, lockHolder: 'holder@example.com' });
    render(<SpeleoBanner />);
    expect(screen.getByTestId('speleo-banner').textContent).toContain('holder@example.com');
  });

  it('does not render for a normal (non-force) editing session', () => {
    seedLink({ forceEditing: false });
    render(<SpeleoBanner />);
    expect(screen.queryByTestId('speleo-banner')).not.toBeInTheDocument();
  });
});

/**
 * #260 - the persistent push-failure banner. A failed push/unlock only raised a
 * toast, which auto-clears after 3 s, so the failure left no durable surface. The
 * banner keeps the humanized error on screen and its Retry replays the SAME verb
 * with the SAME commit message.
 */
describe('SpeleoBanner push failure (#260)', () => {
  const seedFailure = (origin: 'push' | 'done', pushMessage: string | null = null) => {
    seedLink({ forceEditing: false });
    useSpeleoStore.setState({
      banner: { kind: 'push_failed', message: 'Could not push changes: boom', origin, pushMessage },
    });
  };

  it('renders the failure message and a Retry action', () => {
    seedFailure('push');
    render(<SpeleoBanner />);
    const banner = screen.getByTestId('speleo-banner');
    expect(banner).toHaveAttribute('data-kind', 'push_failed');
    expect(banner.textContent).toContain('Could not push changes: boom');
    expect(screen.getByTestId('speleo-banner-retry-push')).toBeInTheDocument();
    // Transient action feedback stays dismissable.
    expect(screen.getByTestId('speleo-banner-dismiss')).toBeInTheDocument();
  });

  it('Retry re-issues the push verb with the original commit message', async () => {
    seedFailure('push', 'my message');
    invokeIpcMock.mockResolvedValue({ kind: 'pushed' });
    render(<SpeleoBanner />);

    await userEvent.click(screen.getByTestId('speleo-banner-retry-push'));

    await waitFor(() =>
      expect(
        invokeIpcMock.mock.calls.some(
          (c) => c[0] === 'speleodb_push' && (c[1] as { message?: string }).message === 'my message',
        ),
      ).toBe(true),
    );
    expect(invokeIpcMock.mock.calls.some((c) => c[0] === 'speleodb_done')).toBe(false);
  });

  it('Retry re-issues the unlock verb when the failure came from Done', async () => {
    seedFailure('done', 'wrap up');
    invokeIpcMock.mockResolvedValue({ kind: 'released' });
    render(<SpeleoBanner />);

    await userEvent.click(screen.getByTestId('speleo-banner-retry-push'));

    await waitFor(() =>
      expect(
        invokeIpcMock.mock.calls.some(
          (c) => c[0] === 'speleodb_done' && (c[1] as { message?: string }).message === 'wrap up',
        ),
      ).toBe(true),
    );
    expect(invokeIpcMock.mock.calls.some((c) => c[0] === 'speleodb_push')).toBe(false);
  });

  it('Retry is disabled while a verb is already in flight (no double-fire)', async () => {
    seedFailure('push');
    useSpeleoStore.setState({ busy: true });
    render(<SpeleoBanner />);

    const retry = screen.getByTestId('speleo-banner-retry-push');
    expect(retry).toBeDisabled();
    await userEvent.click(retry);
    expect(invokeIpcMock.mock.calls.some((c) => c[0] === 'speleodb_push')).toBe(false);
  });

  it('a landed push clears the banner (applyPush)', () => {
    seedFailure('push');
    useSpeleoStore.getState().applyPush({ kind: 'pushed' } as never);
    expect(useSpeleoStore.getState().banner).toBeNull();
  });

  it('a released lock clears the banner (applyDone)', () => {
    seedFailure('done');
    useSpeleoStore.getState().applyDone({ kind: 'released' } as never);
    expect(useSpeleoStore.getState().banner).toBeNull();
  });

  it('closing the project clears the banner (clearLink)', () => {
    seedFailure('push');
    useSpeleoStore.getState().clearLink();
    expect(useSpeleoStore.getState().banner).toBeNull();
  });

  it('clearPushFailedBanner leaves an unrelated banner alone', () => {
    seedLink({ forceEditing: false });
    useSpeleoStore.setState({ banner: { kind: 'no_anchor' } });
    useSpeleoStore.getState().clearPushFailedBanner();
    expect(useSpeleoStore.getState().banner).toEqual({ kind: 'no_anchor' });
  });
});
