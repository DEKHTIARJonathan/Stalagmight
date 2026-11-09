/**
 * A SpeleoDB project card has no separate Open button: the card itself is the
 * Open action, by pointer and by keyboard, and it is gated while a pull runs.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import RemoteSystemCard from '../RemoteSystemCard';
import type { SpeleoProjectSummary } from '../../../types/ipc.generated';
import type { SpeleoLockInfo } from '../SpeleoLockBadge';

const SUMMARY: SpeleoProjectSummary = {
  id: 'p1', name: 'Synthetic remote cave', permission: 'READ_AND_WRITE',
  lock_holder: null, type_tag: 'stalx', latest_commit_sha: null,
};
const LOCK: SpeleoLockInfo = {
  isRemote: true, lockHolder: null, lockedByMe: false, speleoName: 'Synthetic remote cave', hasLocalEdits: false,
};

const renderCard = (busy = false) => {
  const onOpen = vi.fn();
  render(<RemoteSystemCard summary={SUMMARY} lock={LOCK} onOpen={onOpen} busy={busy} />);
  return { onOpen, card: screen.getByTestId('system-card-remote-p1') };
};

describe('RemoteSystemCard', () => {
  it('has no Open button; the focusable card is a button', () => {
    const { card } = renderCard();
    expect(screen.queryByTestId('system-card-remote-open-p1')).not.toBeInTheDocument();
    expect(screen.getAllByRole('button')).toEqual([card]);
    expect(card).toHaveAttribute('tabindex', '0');
  });

  it('opens on click, Enter and Space', async () => {
    const { onOpen, card } = renderCard();
    await userEvent.click(card);
    card.focus();
    await userEvent.keyboard('{Enter}');
    await userEvent.keyboard(' ');
    expect(onOpen).toHaveBeenCalledTimes(3);
    expect(onOpen).toHaveBeenCalledWith(SUMMARY);
  });

  it('does not open while busy', async () => {
    const { onOpen, card } = renderCard(true);
    expect(card).toHaveAttribute('aria-disabled', 'true');
    await userEvent.click(card);
    card.focus();
    await userEvent.keyboard('{Enter}');
    expect(onOpen).not.toHaveBeenCalled();
  });
});
