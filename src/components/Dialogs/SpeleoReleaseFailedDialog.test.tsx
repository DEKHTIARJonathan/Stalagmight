/**
 * "Couldn't hand back the lock": a clean close, project switch or quit whose
 * SpeleoDB lock release failed or is uncertain never leaves silently. The dialog
 * offers Retry (stays up with the new reason while the release keeps failing),
 * Close and keep the lock, and Cancel (stay in the project, read-only).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('../../utils/ipc', () => ({ invokeIpc: vi.fn(), getErrorMessage: (e: unknown) => String(e) }));

import SpeleoReleaseFailedDialog from './SpeleoReleaseFailedDialog';
import { useProjectStore } from '../../store/projectStore';
import {
  askReleaseFailure,
  resetReleaseFailurePromptForTests,
  useReleaseFailurePrompt,
  type ReleaseFailureReason,
  type ReleaseRetryOutcome,
} from '../../utils/speleoReleaseFailure';

beforeEach(() => {
  resetReleaseFailurePromptForTests();
  useProjectStore.setState({ project: { name: 'Synthetic cave', file_path: '/synthetic/p.stalx' } as never });
});

function raise(reason: ReleaseFailureReason, retry: () => Promise<ReleaseRetryOutcome> = async () => ({ ok: true })) {
  const answer = askReleaseFailure(reason, 'Synthetic: SpeleoDB returned HTTP 503', retry);
  render(<SpeleoReleaseFailedDialog />);
  return answer;
}

describe('SpeleoReleaseFailedDialog', () => {
  it.each([
    ['close', 'you close the project'],
    ['switch', 'you open another project'],
    ['quit', 'Stalagmight closes'],
  ] as const)('names the project, what the user is doing (%s) and why the release failed', (reason, action) => {
    void raise(reason);
    expect(screen.getByTestId('speleodb-release-failed-dialog')).toBeVisible();
    expect(screen.getByText("Couldn't hand back the lock")).toBeVisible();
    const body = screen.getByTestId('speleodb-release-failed-body');
    expect(body).toHaveTextContent('Synthetic cave');
    expect(body).toHaveTextContent(action);
    expect(screen.getByTestId('speleodb-release-failed-reason')).toHaveTextContent('HTTP 503');
    expect(screen.getByTestId('speleodb-release-failed-retry')).toHaveAttribute('data-primary-action', '');
    expect(screen.getByTestId('speleodb-release-failed-keep')).toHaveTextContent('Close and keep the lock');
    expect(screen.getByTestId('speleodb-release-failed-cancel')).toBeEnabled();
  });

  it('Retry that settles the release resolves "settled" and closes the dialog', async () => {
    const retry = vi.fn(async (): Promise<ReleaseRetryOutcome> => ({ ok: true }));
    const answer = raise('close', retry);
    await userEvent.click(screen.getByTestId('speleodb-release-failed-retry'));
    await expect(answer).resolves.toBe('settled');
    expect(retry).toHaveBeenCalledOnce();
    expect(useReleaseFailurePrompt.getState().request).toBeNull();
  });

  it('a Retry that fails again stays up with the new reason, and can be retried again', async () => {
    const retry = vi.fn<() => Promise<ReleaseRetryOutcome>>()
      .mockResolvedValueOnce({ ok: false, detail: 'Synthetic: still unreachable' })
      .mockResolvedValueOnce({ ok: true });
    const answer = raise('switch', retry);
    await userEvent.click(screen.getByTestId('speleodb-release-failed-retry'));
    await waitFor(() => expect(screen.getByTestId('speleodb-release-failed-reason')).toHaveTextContent('still unreachable'));
    expect(screen.getByTestId('speleodb-release-failed-dialog')).toBeVisible();
    await userEvent.click(screen.getByTestId('speleodb-release-failed-retry'));
    await expect(answer).resolves.toBe('settled');
    expect(retry).toHaveBeenCalledTimes(2);
  });

  it('nothing else can be pressed while a retry is in flight, and a quit waits for it', async () => {
    let finish!: (outcome: ReleaseRetryOutcome) => void;
    const answer = raise('quit', () => new Promise((resolve) => { finish = resolve; }));
    await userEvent.click(screen.getByTestId('speleodb-release-failed-retry'));
    expect(screen.getByTestId('speleodb-release-failed-retry')).toHaveTextContent('Retrying...');
    expect(screen.getByTestId('speleodb-release-failed-keep')).toBeDisabled();
    expect(screen.getByTestId('speleodb-release-failed-cancel')).toBeDisabled();
    expect(useReleaseFailurePrompt.getState().working).toBe(true);
    // A second request while the retry runs is refused rather than replacing it.
    await expect(askReleaseFailure('close', 'other', async () => ({ ok: true }))).resolves.toBe('cancel');
    await act(async () => finish({ ok: true }));
    await expect(answer).resolves.toBe('settled');
    expect(useReleaseFailurePrompt.getState().working).toBe(false);
  });

  it('Close and keep the lock resolves "keep"', async () => {
    const answer = raise('quit');
    await userEvent.click(screen.getByTestId('speleodb-release-failed-keep'));
    await expect(answer).resolves.toBe('keep');
  });

  it.each(['button', 'escape'] as const)('Cancel (%s) resolves "cancel": the user stays', async (how) => {
    const retry = vi.fn(async (): Promise<ReleaseRetryOutcome> => ({ ok: true }));
    const answer = raise('close', retry);
    if (how === 'button') await userEvent.click(screen.getByTestId('speleodb-release-failed-cancel'));
    else await userEvent.keyboard('{Escape}');
    await expect(answer).resolves.toBe('cancel');
    expect(retry).not.toHaveBeenCalled();
  });

  it('a newer request replaces an open one, whose caller gets Cancel', async () => {
    const first = askReleaseFailure('close', 'first', async () => ({ ok: true }));
    const second = askReleaseFailure('quit', 'second', async () => ({ ok: true }));
    await expect(first).resolves.toBe('cancel');
    expect(useReleaseFailurePrompt.getState().request?.reason).toBe('quit');
    useReleaseFailurePrompt.getState().request?.settle('keep');
    await expect(second).resolves.toBe('keep');
  });
});
