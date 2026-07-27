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
        // The ordinary open -> adopt route confirms no discard, so the backend's
        // un-pushed-edits guard stays armed. Only the refused-open prompt's
        // "take the server copy" branch waives it, having asked first.
        discardLocal: false,
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

  it('does not close or toast success when the adopted reload fails (#214)', async () => {
    mockRoutes();
    loadProjectMock.mockResolvedValue({ success: false });
    render(<OpenFromSpeleoDbDialog />);

    await userEvent.click(await screen.findByTestId('open-from-speleodb-open-p1'));
    await userEvent.click(await screen.findByTestId('speleodb-adopt-confirm-btn'));

    await waitFor(() => expect(loadProjectMock).toHaveBeenCalled());
    expect(showToastMock).not.toHaveBeenCalledWith(expect.any(String), 'speleodb-adopted');
  });
});

/**
 * #270 (P1) - a TRANSIENT project-list failure must not log an authenticated user
 * out of the browser. The mount effect used to wrap the session probe and the list
 * fetch in one try, so any list hiccup fell into a catch that unconditionally showed
 * the login prompt. Auth failures still route to logged-out; list failures keep the
 * authenticated list phase with the inline error + Refresh.
 */
describe('OpenFromSpeleoDbDialog list-failure resilience (#270)', () => {
  const clearSession = () => useSpeleoStore.getState().clearSession as ReturnType<typeof vi.fn>;

  it('a flaky list fetch keeps the authenticated list phase (no login prompt)', async () => {
    mockRoutes({
      speleodb_list_projects: () => Promise.reject({ message: 'boom', action: 'Retry', status: 503 }),
    });
    render(<OpenFromSpeleoDbDialog />);

    await waitFor(() => expect(screen.getByTestId('open-from-speleodb-error')).toBeInTheDocument());
    expect(screen.queryByTestId('open-from-speleodb-logged-out')).not.toBeInTheDocument();
    // Still the authenticated surface: the filter + Refresh are reachable.
    expect(screen.getByTestId('open-from-speleodb-filter')).toBeInTheDocument();
    expect(clearSession()).not.toHaveBeenCalled();
  });

  it('the empty state says the list could not load, not that there are no projects', async () => {
    mockRoutes({
      speleodb_list_projects: () => Promise.reject({ message: 'boom', action: 'Retry', status: 503 }),
    });
    render(<OpenFromSpeleoDbDialog />);

    const empty = await screen.findByTestId('open-from-speleodb-empty');
    expect(empty.textContent).toContain('could not be loaded');
  });

  it('Refresh recovers into the list once the fetch succeeds', async () => {
    let fail = true;
    mockRoutes({
      speleodb_list_projects: () =>
        fail
          ? Promise.reject({ message: 'boom', action: 'Retry', status: 503 })
          : Promise.resolve([ARIANE_PROJECT]),
    });
    render(<OpenFromSpeleoDbDialog />);

    await screen.findByTestId('open-from-speleodb-empty');
    fail = false;
    await userEvent.click(screen.getByText('Refresh'));

    expect(await screen.findByTestId('open-from-speleodb-open-p1')).toBeInTheDocument();
    expect(screen.queryByTestId('open-from-speleodb-error')).not.toBeInTheDocument();
  });

  it('a dead token surfacing from the list call DOES drop the session', async () => {
    mockRoutes({
      speleodb_list_projects: () =>
        Promise.reject({ message: 'token expired', action: 'ReLogin', status: 401 }),
    });
    render(<OpenFromSpeleoDbDialog />);

    await waitFor(() =>
      expect(screen.getByTestId('open-from-speleodb-logged-out')).toBeInTheDocument(),
    );
    expect(clearSession()).toHaveBeenCalled();
  });

  it('a failing session probe still routes to the login prompt', async () => {
    mockRoutes({
      speleodb_session: () => Promise.reject({ message: 'no token', action: 'ReLogin', status: 401 }),
    });
    render(<OpenFromSpeleoDbDialog />);

    await waitFor(() =>
      expect(screen.getByTestId('open-from-speleodb-logged-out')).toBeInTheDocument(),
    );
    expect(clearSession()).toHaveBeenCalled();
  });

  it('a logged-out session still routes to the login prompt', async () => {
    mockRoutes({ speleodb_session: () => Promise.resolve({ logged_in: false }) });
    render(<OpenFromSpeleoDbDialog />);

    await waitFor(() =>
      expect(screen.getByTestId('open-from-speleodb-logged-out')).toBeInTheDocument(),
    );
    expect(invokeIpcMock.mock.calls.some((c) => c[0] === 'speleodb_list_projects')).toBe(false);
  });
});

/**
 * #270 - the browser is one of the two entry points into `useOpenRemoteProject`
 * (GlobalView's remote rows are the other). When the backend refuses the open
 * because the cached .stalx still holds un-pushed edits, the browser must hand off
 * to the keep-local / take-remote prompt instead of painting its generic error
 * banner, and must not stay stuck behind its busy flag.
 */
describe('OpenFromSpeleoDbDialog refused open with unpushed local edits (#270)', () => {
  const REFUSAL = {
    message: 'local copy has unpushed edits',
    action: 'UnpushedLocalEdits',
    status: null,
    unpushed_local: {
      project_id: 'p1',
      local_path: '/cache/p1/project.stalx',
      last_edit_at: '2026-07-20T10:30:00Z',
    },
  };

  it('raises the prompt instead of a generic error, and tells it the way back here', async () => {
    const openDialogMock = vi.fn();
    useUIStore.setState({ openDialog: openDialogMock });
    mockRoutes({ speleodb_open_project: () => Promise.reject(REFUSAL) });
    render(<OpenFromSpeleoDbDialog />);

    await userEvent.click(await screen.findByTestId('open-from-speleodb-open-p1'));

    await waitFor(() =>
      expect(openDialogMock).toHaveBeenCalledWith('speleodb-unpushed-local', {
        summary: expect.objectContaining({ id: 'p1' }),
        unpushedLocal: REFUSAL.unpushed_local,
        // #270: the prompt replaces this browser in the single dialog slot, so it
        // carries the route back. Without it, cancelling the prompt left nothing
        // open and nothing opened - a dead end.
        cancelReturnsTo: 'open-from-speleodb',
      }),
    );
    expect(screen.queryByTestId('open-from-speleodb-error')).not.toBeInTheDocument();
    // Nothing was downloaded or opened.
    expect(loadProjectMock).not.toHaveBeenCalled();
  });
});
