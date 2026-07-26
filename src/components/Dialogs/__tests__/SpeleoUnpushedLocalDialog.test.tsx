// @vitest-environment jsdom
/**
 * [#270] The refused-open prompt: `speleodb_open_project` refuses to overwrite a
 * cached .stalx that still holds edits SpeleoDB has never seen, and the user gets a
 * binary choice instead of a generic error.
 *
 * The load-bearing assertions here are the NEGATIVE ones: keeping the local copy
 * must issue NO SpeleoDB command at all, and the destructive branch must not run
 * until it has been confirmed twice.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const invokeIpcMock = vi.hoisted(() => vi.fn());
vi.mock('../../../utils/ipc', () => ({
  invokeIpc: invokeIpcMock,
  getErrorMessage: (_e: unknown, f?: string) => f ?? 'error',
}));

import SpeleoUnpushedLocalDialog from '../SpeleoUnpushedLocalDialog';
import { useProjectStore } from '../../../store/projectStore';
import { useSpeleoStore } from '../../../store/speleoStore';
import { useUIStore } from '../../../store/uiStore';

const SUMMARY = {
  id: 'p1',
  name: 'Cenote Azul',
  permission: 'READ_AND_WRITE',
  lock_holder: null,
  type_tag: 'stalx',
  latest_commit_sha: 'abc123',
};

const UNPUSHED = {
  project_id: 'p1',
  local_path: '/cache/p1/project.stalx',
  last_edit_at: '2026-07-20T10:30:00Z',
};

let loadProjectMock: ReturnType<typeof vi.fn>;
let closeDialogMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  invokeIpcMock.mockReset();
  invokeIpcMock.mockResolvedValue(undefined);
  loadProjectMock = vi.fn(async () => ({ success: true }));
  closeDialogMock = vi.fn();
  useProjectStore.setState({ loadProject: loadProjectMock });
  useSpeleoStore.setState({ setLinkOnOpen: vi.fn(), clearLink: vi.fn() });
  useUIStore.setState({
    closeDialog: closeDialogMock,
    openDialog: vi.fn(),
    showToast: vi.fn(),
    dialogData: { summary: SUMMARY, unpushedLocal: UNPUSHED },
  });
});

/** Every SpeleoDB command the app could have issued from this prompt. */
const speleoCalls = () =>
  invokeIpcMock.mock.calls.filter((c) => String(c[0]).startsWith('speleodb_'));

describe('SpeleoUnpushedLocalDialog (#270)', () => {
  it('names the project and when the local copy was last edited', () => {
    render(<SpeleoUnpushedLocalDialog />);
    expect(screen.getByTestId('speleodb-unpushed-local-dialog')).toBeInTheDocument();
    expect(screen.getByText(/Cenote Azul/)).toBeInTheDocument();
    expect(screen.getByTestId('speleodb-unpushed-local-last-edited').textContent).toContain(
      new Date(UNPUSHED.last_edit_at).toLocaleString(),
    );
  });

  it('keeps the local copy: opens local_path and issues NO SpeleoDB command', async () => {
    render(<SpeleoUnpushedLocalDialog />);
    await userEvent.click(screen.getByTestId('speleodb-unpushed-local-keep'));

    await waitFor(() => expect(loadProjectMock).toHaveBeenCalledWith('/cache/p1/project.stalx'));
    expect(speleoCalls()).toEqual([]);
  });

  it('makes keeping the local copy the primary (default-focus) action', () => {
    render(<SpeleoUnpushedLocalDialog />);
    const keep = screen.getByTestId('speleodb-unpushed-local-keep');
    const takeRemote = screen.getByTestId('speleodb-unpushed-local-take-remote');
    expect(keep).toHaveAttribute('data-primary-action');
    expect(takeRemote).not.toHaveAttribute('data-primary-action');
  });

  it('arms the destructive action first: one click discards nothing', async () => {
    render(<SpeleoUnpushedLocalDialog />);
    await userEvent.click(screen.getByTestId('speleodb-unpushed-local-take-remote'));

    expect(speleoCalls()).toEqual([]);
    expect(loadProjectMock).not.toHaveBeenCalled();
    expect(
      screen.getByTestId('speleodb-unpushed-local-discard-warning').textContent,
    ).toContain('Cenote Azul');
  });

  it('takes the server copy on the second click, with the refused open arguments', async () => {
    invokeIpcMock.mockImplementation((cmd: string) =>
      cmd === 'speleodb_open_project_discarding_local'
        ? Promise.resolve({ local_path: '/cache/p1/project.stalx', concurrent_session: false })
        : Promise.resolve(undefined),
    );
    render(<SpeleoUnpushedLocalDialog />);
    await userEvent.click(screen.getByTestId('speleodb-unpushed-local-take-remote'));
    await userEvent.click(screen.getByTestId('speleodb-unpushed-local-take-remote'));

    await waitFor(() => {
      const call = invokeIpcMock.mock.calls.find(
        (c) => c[0] === 'speleodb_open_project_discarding_local',
      );
      expect(call?.[1]).toEqual({
        projectId: 'p1',
        projectName: 'Cenote Azul',
        latestCommitSha: 'abc123',
      });
    });
    await waitFor(() => expect(loadProjectMock).toHaveBeenCalledWith('/cache/p1/project.stalx'));
  });

  it('keeps the prompt open and shows why when the discarding open fails', async () => {
    invokeIpcMock.mockImplementation((cmd: string) =>
      cmd === 'speleodb_open_project_discarding_local'
        ? Promise.reject({ message: 'server exploded', action: 'None', status: 500 })
        : Promise.resolve(undefined),
    );
    render(<SpeleoUnpushedLocalDialog />);
    await userEvent.click(screen.getByTestId('speleodb-unpushed-local-take-remote'));
    await userEvent.click(screen.getByTestId('speleodb-unpushed-local-take-remote'));

    await waitFor(() =>
      expect(screen.getByTestId('speleodb-unpushed-local-error')).toBeInTheDocument(),
    );
    // Still on screen, nothing loaded, and the prompt was never closed.
    expect(screen.getByTestId('speleodb-unpushed-local-dialog')).toBeInTheDocument();
    expect(loadProjectMock).not.toHaveBeenCalled();
    expect(closeDialogMock).not.toHaveBeenCalled();
    // The button stays armed, so it is a retry rather than a fresh arm.
    expect(screen.getByTestId('speleodb-unpushed-local-take-remote')).not.toBeDisabled();
  });
});
