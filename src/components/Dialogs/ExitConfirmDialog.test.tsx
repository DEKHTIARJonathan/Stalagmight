import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

// The exit-path questions are in-app now; the native dialog must not be reached.
const nativeConfirm = vi.hoisted(() => vi.fn(async () => true));
vi.mock('@tauri-apps/plugin-dialog', () => ({ confirm: nativeConfirm }));

import ExitConfirmDialog from './ExitConfirmDialog';
import { askExitConfirm, useExitConfirm } from '../../utils/exitConfirm';
import { protectAccountTransition } from '../../utils/protectAccountTransition';
import { useProjectStore } from '../../store/projectStore';

const ask = () => askExitConfirm({
  title: 'Close Stalagmight?', message: 'Import is in progress.', confirmLabel: 'Discard and close', cancelLabel: 'Cancel',
});

beforeEach(() => {
  useExitConfirm.setState({ request: null });
  nativeConfirm.mockClear();
});

describe('ExitConfirmDialog', () => {
  it('asks in-app and answers yes', async () => {
    const answer = ask();
    render(<ExitConfirmDialog />);
    expect(screen.getByTestId('exit-confirm-message')).toHaveTextContent('Import is in progress.');
    await userEvent.click(screen.getByTestId('exit-confirm-ok'));
    expect(await answer).toBe(true);
    expect(nativeConfirm).not.toHaveBeenCalled();
  });

  it('Cancel and Escape answer no', async () => {
    const first = ask();
    const { rerender } = render(<ExitConfirmDialog />);
    await userEvent.click(screen.getByTestId('exit-confirm-cancel'));
    expect(await first).toBe(false);
    const second = ask();
    rerender(<ExitConfirmDialog />);
    await userEvent.keyboard('{Escape}');
    expect(await second).toBe(false);
  });

  it('a second question answers the first one "no" instead of stacking', async () => {
    const first = ask();
    void ask();
    expect(await first).toBe(false);
  });
});

describe('protectAccountTransition', () => {
  it('asks the in-app question, never the native one', async () => {
    useProjectStore.setState({ project: null, isDirty: true });
    const answer = protectAccountTransition();
    render(<ExitConfirmDialog />);
    expect(await screen.findByTestId('exit-confirm-dialog')).toBeVisible();
    await userEvent.click(screen.getByTestId('exit-confirm-cancel'));
    expect(await answer).toBe(false);
    expect(nativeConfirm).not.toHaveBeenCalled();
  });
});
