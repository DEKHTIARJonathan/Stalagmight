/**
 * Component test (#213) - the persistent force-edit banner.
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
  useSpeleoStore.setState({ link: null, banner: null });
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
