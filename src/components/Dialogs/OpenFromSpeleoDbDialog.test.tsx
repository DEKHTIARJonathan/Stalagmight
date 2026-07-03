/**
 * Component test (#214) - the adopt-Ariane confirm flow in the Open-from-SpeleoDB
 * browser. When speleodb_open_project reports SpeleoDbAction::Adopt, the browser
 * must offer a confirm dialog (not an error toast); confirming must call
 * speleodb_adopt_ariane and then reload the adopted .stalx.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const invokeIpcMock = vi.hoisted(() => vi.fn());
vi.mock('../../utils/ipc', () => ({
  invokeIpc: invokeIpcMock,
  getErrorMessage: (_e: unknown, f?: string) => f ?? 'error',
}));

import OpenFromSpeleoDbDialog from './OpenFromSpeleoDbDialog';
import { useProjectStore } from '../../store/projectStore';
import { useSpeleoStore } from '../../store/speleoStore';
import { useUIStore } from '../../store/uiStore';

let loadProjectMock: ReturnType<typeof vi.fn>;
let closeDialogMock: ReturnType<typeof vi.fn>;
let showToastMock: ReturnType<typeof vi.fn>;

const ARIANE_PROJECT = {
  id: 'p1',
  name: 'Ariane Cave',
  permission: 'READ_AND_WRITE',
  type_tag: 'ariane',
  latest_commit_sha: 'abc123',
  lock_holder: null,
};

/** Default happy-path routing: logged in, one Ariane project, open -> Adopt. */
function mockRoutes(overrides: Record<string, () => Promise<unknown>> = {}) {
  invokeIpcMock.mockImplementation((cmd: string) => {
    const routes: Record<string, () => Promise<unknown>> = {
      speleodb_session: () => Promise.resolve({ logged_in: true }),
      speleodb_list_projects: () => Promise.resolve([ARIANE_PROJECT]),
      // The dump has no .stalx -> the backend returns the typed Adopt action.
      speleodb_open_project: () =>
        Promise.reject({ message: 'ariane project', action: 'Adopt', status: null }),
      speleodb_adopt_ariane: () =>
        Promise.resolve({
          local_path: '/cache/p1/project.stalx',
          type_flipped: true,
          concurrent_session: false,
        }),
      ...overrides,
    };
    return (routes[cmd] ?? (() => Promise.resolve(undefined)))();
  });
}

beforeEach(() => {
  invokeIpcMock.mockReset();
  loadProjectMock = vi.fn(async () => ({ success: true }));
  closeDialogMock = vi.fn();
  showToastMock = vi.fn();
  useProjectStore.setState({ loadProject: loadProjectMock });
  useSpeleoStore.setState({
    session: null,
    setSession: vi.fn(),
    clearSession: vi.fn(),
    setLinkOnOpen: vi.fn(),
    clearLink: vi.fn(),
  });
  useUIStore.setState({
    closeDialog: closeDialogMock,
    openDialog: vi.fn(),
    showToast: showToastMock,
  });
});

describe('OpenFromSpeleoDbDialog adopt flow (#214)', () => {
  it('offers the adopt confirm on an Ariane project instead of erroring', async () => {
    mockRoutes();
    render(<OpenFromSpeleoDbDialog />);

    const openBtn = await screen.findByTestId('open-from-speleodb-open-p1');
    await userEvent.click(openBtn);

    // The confirm dialog appears; no error banner is shown.
    await waitFor(() => expect(screen.getByTestId('speleodb-adopt-confirm')).toBeInTheDocument());
    expect(screen.queryByTestId('open-from-speleodb-error')).not.toBeInTheDocument();
    expect(invokeIpcMock.mock.calls.some((c) => c[0] === 'speleodb_open_project')).toBe(true);
    // Adoption has NOT run yet - it waits for the user to confirm.
    expect(invokeIpcMock.mock.calls.some((c) => c[0] === 'speleodb_adopt_ariane')).toBe(false);
  });

  it('adopts on confirm: calls speleodb_adopt_ariane, reloads, toasts', async () => {
    mockRoutes();
    render(<OpenFromSpeleoDbDialog />);

    await userEvent.click(await screen.findByTestId('open-from-speleodb-open-p1'));
    await userEvent.click(await screen.findByTestId('speleodb-adopt-confirm-btn'));

    await waitFor(() => {
      const call = invokeIpcMock.mock.calls.find((c) => c[0] === 'speleodb_adopt_ariane');
      expect(call).toBeTruthy();
      expect(call![1]).toEqual({
        projectId: 'p1',
        projectName: 'Ariane Cave',
        latestCommitSha: 'abc123',
      });
    });
    await waitFor(() =>
      expect(loadProjectMock).toHaveBeenCalledWith('/cache/p1/project.stalx'),
    );
    await waitFor(() => expect(closeDialogMock).toHaveBeenCalled());
    expect(showToastMock).toHaveBeenCalledWith(expect.any(String), 'speleodb-adopted');
  });

  it('cancel dismisses the confirm without adopting', async () => {
    mockRoutes();
    render(<OpenFromSpeleoDbDialog />);

    await userEvent.click(await screen.findByTestId('open-from-speleodb-open-p1'));
    await userEvent.click(await screen.findByTestId('speleodb-adopt-cancel'));

    await waitFor(() =>
      expect(screen.queryByTestId('speleodb-adopt-confirm')).not.toBeInTheDocument(),
    );
    expect(invokeIpcMock.mock.calls.some((c) => c[0] === 'speleodb_adopt_ariane')).toBe(false);
    expect(closeDialogMock).not.toHaveBeenCalled();
  });

  it('does not close or toast success when the adopted reload fails', async () => {
    mockRoutes();
    loadProjectMock.mockResolvedValue({ success: false });
    render(<OpenFromSpeleoDbDialog />);

    await userEvent.click(await screen.findByTestId('open-from-speleodb-open-p1'));
    await userEvent.click(await screen.findByTestId('speleodb-adopt-confirm-btn'));

    await waitFor(() => expect(loadProjectMock).toHaveBeenCalled());
    expect(showToastMock).not.toHaveBeenCalledWith(expect.any(String), 'speleodb-adopted');
  });
});
