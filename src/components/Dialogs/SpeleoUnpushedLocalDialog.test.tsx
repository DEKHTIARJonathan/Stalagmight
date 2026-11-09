import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import SpeleoUnpushedLocalDialog from './SpeleoUnpushedLocalDialog';
import { useUIStore } from '../../store/uiStore';

const { takeRemote, openLocal } = vi.hoisted(() => ({ takeRemote: vi.fn(), openLocal: vi.fn() }));
vi.mock('../../hooks/useOpenRemoteProject', () => ({ useOpenRemoteProject: () => ({
  takeRemoteDiscardingLocal: takeRemote, openLocalCopy: openLocal,
}) }));

beforeEach(() => {
  takeRemote.mockReset().mockResolvedValue({ status: 'cancelled' });
  openLocal.mockReset().mockResolvedValue({ status: 'cancelled' });
  useUIStore.setState({ activeDialog: 'speleodb-unpushed-local', dialogData: {
    summary: { id: 'synthetic', name: 'Synthetic cave' },
    unpushedLocal: { local_path: '/synthetic/cave.stalx', last_edit_at: null },
  } });
});

it('restores retry and dismissal after a discarded-copy open is superseded', async () => {
  render(<SpeleoUnpushedLocalDialog />);
  const take = screen.getByTestId('speleodb-unpushed-local-take-remote');
  await userEvent.click(take); // Arm the destructive choice.
  await userEvent.click(take);
  await waitFor(() => expect(take).toBeEnabled());
  expect(takeRemote).toHaveBeenCalledOnce();
  expect(screen.queryByTestId('speleodb-unpushed-local-error')).not.toBeInTheDocument();
  await userEvent.click(take);
  expect(takeRemote).toHaveBeenCalledTimes(2);
  await userEvent.click(screen.getByTestId('speleodb-unpushed-local-cancel'));
  expect(useUIStore.getState().activeDialog).toBeNull();
});


it('a superseded handler cannot clear a replacement prompt operation', async () => {
  let cancelOld!: (outcome: unknown) => void;
  takeRemote.mockReturnValueOnce(new Promise((resolve) => { cancelOld = resolve; }))
    .mockReturnValueOnce(new Promise(() => {}));
  render(<SpeleoUnpushedLocalDialog />);
  const take = screen.getByTestId('speleodb-unpushed-local-take-remote');
  await userEvent.click(take);
  await userEvent.click(take);
  expect(take).toBeDisabled();
  act(() => useUIStore.setState((state) => ({ dialogData: { ...state.dialogData } })));
  await waitFor(() => expect(take).toBeEnabled());
  await userEvent.click(take);
  await userEvent.click(take);
  expect(take).toBeDisabled();
  await act(async () => { cancelOld({ status: 'cancelled' }); });
  expect(take).toBeDisabled();
  expect(screen.getByTestId('speleodb-unpushed-local-cancel')).toBeDisabled();
});

describe('unsynced work protection during a remote open', () => {
  it('cancel touches nothing', async () => {
    render(<SpeleoUnpushedLocalDialog />);
    await userEvent.click(screen.getByTestId('speleodb-unpushed-local-cancel'));
    expect(takeRemote).not.toHaveBeenCalled();
    expect(openLocal).not.toHaveBeenCalled();
    expect(useUIStore.getState().activeDialog).toBeNull();
  });

  // Users stranded by earlier builds (un-uploaded edits, lock already released) need
  // a way back to their work that does not throw either copy away.
  it('"Open my local copy" opens the copy on this computer, with no second confirmation', async () => {
    render(<SpeleoUnpushedLocalDialog />);
    const openButton = screen.getByTestId('speleodb-unpushed-local-open-local');
    expect(openButton).toHaveAttribute('data-primary-action', '');
    await userEvent.click(openButton);
    expect(openLocal).toHaveBeenCalledWith(
      { id: 'synthetic', name: 'Synthetic cave' },
      { local_path: '/synthetic/cave.stalx', last_edit_at: null },
    );
    expect(takeRemote).not.toHaveBeenCalled();
  });

  it('a failed local open stays on the prompt with the reason', async () => {
    openLocal.mockResolvedValue({ status: 'error', message: 'Synthetic load failure', reLogin: false });
    render(<SpeleoUnpushedLocalDialog />);
    await userEvent.click(screen.getByTestId('speleodb-unpushed-local-open-local'));
    expect(await screen.findByTestId('speleodb-unpushed-local-error')).toHaveTextContent('Synthetic load failure');
    expect(screen.getByTestId('speleodb-unpushed-local-open-local')).toBeEnabled();
  });
  it('requires an explicit second confirmation before replacing unsynced work', async () => {
    render(<SpeleoUnpushedLocalDialog />);
    await userEvent.click(screen.getByTestId('speleodb-unpushed-local-take-remote'));
    expect(takeRemote).not.toHaveBeenCalled();
    expect(screen.getByTestId('speleodb-unpushed-local-discard-warning')).toBeVisible();
    await userEvent.click(screen.getByTestId('speleodb-unpushed-local-take-remote'));
    expect(takeRemote).toHaveBeenCalledTimes(1);
  });
});
