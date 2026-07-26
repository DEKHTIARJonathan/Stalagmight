/**
 * Component test (#270): the held-lock prompt joining LOCAL state onto the
 * server-only lock scan.
 *
 * The scan (`list_projects`) knows only who holds which lock, so every row used to
 * offer the same bare "Release" - including rows whose lock sits on top of work that
 * never reached SpeleoDB. `speleodb_local_project_states` supplies the missing half;
 * a row with un-pushed edits offers "Continue editing" (open + keep the lock) and
 * does not offer Release at all, and the bulk release stops being a silent
 * work-discarder.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const invokeIpcMock = vi.hoisted(() => vi.fn());
vi.mock('../../../utils/ipc', () => ({
  invokeIpc: invokeIpcMock,
  getErrorMessage: (_e: unknown, f?: string) => f ?? 'error',
}));

import HeldLockResumeDialog from '../HeldLockResumeDialog';
import { useSpeleoStore } from '../../../store/speleoStore';
import { useProjectStore } from '../../../store/projectStore';
import { useUIStore } from '../../../store/uiStore';

const DIRTY = 'aaaaaaaa-1111-1111-1111-111111111111';
const CLEAN = 'bbbbbbbb-2222-2222-2222-222222222222';

const local = (opts: { unpushed: boolean; open?: boolean }) => ({
  has_local_copy: true,
  has_unpushed_edits: opts.unpushed,
  last_edit_at: opts.unpushed ? '2026-07-26T00:00:00Z' : null,
  is_open: opts.open ?? false,
});

/** Route the mock by command; `localStates` is the reply (or a thrown failure). */
const wireIpc = (localStates: Record<string, unknown> | Error) => {
  invokeIpcMock.mockImplementation((command: string) => {
    if (command === 'speleodb_local_project_states') {
      return localStates instanceof Error
        ? Promise.reject(localStates)
        : Promise.resolve(localStates);
    }
    if (command === 'speleodb_start_editing') return Promise.resolve({ kind: 'editing' });
    if (command === 'speleodb_link_status') return Promise.resolve(null);
    return Promise.resolve(null);
  });
};

const loadProjectMock = vi.fn(async () => ({ success: true }));

beforeEach(() => {
  invokeIpcMock.mockReset();
  loadProjectMock.mockClear();
  loadProjectMock.mockResolvedValue({ success: true });
  useSpeleoStore.setState({
    link: null,
    heldLocks: [
      { projectId: DIRTY, projectName: 'Dirty Cave' },
      { projectId: CLEAN, projectName: 'Clean Cave' },
    ],
    heldLockPromptOpen: true,
    session: { loggedIn: true, userEmail: 'me@example.com', endpoint: null, keychainBacked: true },
  });
  useProjectStore.setState({
    loadProject: loadProjectMock,
    recentProjects: [
      {
        name: 'Dirty Cave',
        location: null,
        file_path: '/cache/dirty.stalx',
        modified_at: '2026-07-26T00:00:00Z',
        section_count: 1,
        total_length: 10,
        station_count: 2,
        gps_center: null,
        gps_bounds: null,
        collab_enabled: false,
        is_remote: true,
        speleodb_project_id: DIRTY,
      },
    ],
  });
  useUIStore.setState({ activeDialog: null, dialogData: {} });
});

const row = (id: string) => screen.getByTestId(`speleodb-held-lock-${id}`);

describe('HeldLockResumeDialog local-edit join (#270)', () => {
  it('offers Continue editing (and no Release) for a project with local changes', async () => {
    wireIpc({ [DIRTY]: local({ unpushed: true }), [CLEAN]: local({ unpushed: false }) });
    render(<HeldLockResumeDialog />);

    await screen.findByTestId(`speleodb-held-lock-continue-${DIRTY}`);
    expect(row(DIRTY)).toHaveAttribute('data-local-edits', 'true');
    // Release is the one action that would strand the work - it must be gone.
    expect(screen.queryByTestId(`speleodb-held-lock-release-${DIRTY}`)).not.toBeInTheDocument();
  });

  it('keeps plain Release for a project with nothing outstanding', async () => {
    wireIpc({ [DIRTY]: local({ unpushed: true }), [CLEAN]: local({ unpushed: false }) });
    render(<HeldLockResumeDialog />);

    await screen.findByTestId(`speleodb-held-lock-release-${CLEAN}`);
    expect(row(CLEAN)).toHaveAttribute('data-local-edits', 'false');
    expect(screen.queryByTestId(`speleodb-held-lock-continue-${CLEAN}`)).not.toBeInTheDocument();
  });

  it('Continue editing opens the local copy and re-acquires, keeping the lock', async () => {
    wireIpc({ [DIRTY]: local({ unpushed: true }), [CLEAN]: local({ unpushed: false }) });
    render(<HeldLockResumeDialog />);

    await userEvent.click(await screen.findByTestId(`speleodb-held-lock-continue-${DIRTY}`));

    await waitFor(() => expect(loadProjectMock).toHaveBeenCalledWith('/cache/dirty.stalx'));
    await waitFor(() =>
      expect(invokeIpcMock.mock.calls.some((c) => c[0] === 'speleodb_start_editing')).toBe(true),
    );
    // No release of any kind: the lock is deliberately retained.
    expect(invokeIpcMock.mock.calls.some((c) => c[0] === 'speleodb_release_lock')).toBe(false);
    expect(invokeIpcMock.mock.calls.some((c) => c[0] === 'speleodb_release_all_locks')).toBe(false);
    await waitFor(() => expect(useSpeleoStore.getState().heldLockPromptOpen).toBe(false));
  });

  it('skips the reload when that project is already the open one', async () => {
    wireIpc({
      [DIRTY]: local({ unpushed: true, open: true }),
      [CLEAN]: local({ unpushed: false }),
    });
    render(<HeldLockResumeDialog />);

    await userEvent.click(await screen.findByTestId(`speleodb-held-lock-continue-${DIRTY}`));

    await waitFor(() =>
      expect(invokeIpcMock.mock.calls.some((c) => c[0] === 'speleodb_start_editing')).toBe(true),
    );
    expect(loadProjectMock).not.toHaveBeenCalled();
  });

  it('offers no bulk release at all', async () => {
    // Removed deliberately, not overlooked. The server verb is all-or-nothing and
    // this prompt is exactly where locks sitting over un-pushed work surface, so a
    // single button freeing every lock is the one action most able to strand the
    // work the per-row rules exist to protect.
    wireIpc({ [DIRTY]: local({ unpushed: true }), [CLEAN]: local({ unpushed: false }) });
    render(<HeldLockResumeDialog />);
    await screen.findByTestId(`speleodb-held-lock-continue-${DIRTY}`);

    expect(screen.queryByTestId('speleodb-held-lock-release-all')).not.toBeInTheDocument();
    expect(invokeIpcMock).not.toHaveBeenCalledWith(
      'speleodb_release_all_locks',
      expect.anything(),
    );
    expect(invokeIpcMock).not.toHaveBeenCalledWith('speleodb_release_all_locks');
  });

  it('falls back to Release when the local-state call fails, and says it does not know', async () => {
    wireIpc(new Error('backend down'));
    render(<HeldLockResumeDialog />);

    await screen.findByTestId('speleodb-held-lock-local-unknown');
    // Today's behaviour for every row - the dialog stays usable...
    expect(screen.getByTestId(`speleodb-held-lock-release-${DIRTY}`)).toBeInTheDocument();
    expect(screen.getByTestId(`speleodb-held-lock-release-${CLEAN}`)).toBeInTheDocument();
  });

});
