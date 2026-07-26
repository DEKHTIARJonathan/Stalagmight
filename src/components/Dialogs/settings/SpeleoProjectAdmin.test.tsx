/**
 * Component test (#215) - the admin half of the SpeleoDB Project Settings tab:
 * collaborator management (users + teams), lock release, and project delete.
 *
 * Covers the ADMIN-vs-READ_ONLY gating, the exact IPC payloads the CRUD controls
 * send, the self-row lockout, the lock-release flow, and the type-to-confirm delete
 * (which unlinks + closes on success).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const invokeIpcMock = vi.hoisted(() => vi.fn());
vi.mock('../../../utils/ipc', () => ({
  invokeIpc: invokeIpcMock,
  getErrorMessage: (e: unknown) => (e instanceof Error ? e.message : String(e)),
}));

import { SpeleoProjectAdmin } from './SpeleoProjectAdmin';
import { useSpeleoStore } from '../../../store/speleoStore';
import { useProjectStore } from '../../../store/projectStore';
import { useUIStore } from '../../../store/uiStore';
import type { Permission, SpeleoCollaborators } from '../../../types/ipc.generated';

const ROSTER: SpeleoCollaborators = {
  users: [
    { email: 'me@x.com', permission: 'ADMIN', is_self: true },
    { email: 'bob@x.com', permission: 'READ_ONLY', is_self: false },
  ],
  teams: [{ team_id: 't1', team_name: 'Divers', permission: 'READ_AND_WRITE' }],
};

let refreshLinkStatus: ReturnType<typeof vi.fn>;
let syncProjectLink: ReturnType<typeof vi.fn>;
let closeDialog: ReturnType<typeof vi.fn>;
let showToast: ReturnType<typeof vi.fn>;

const seed = (permission: Permission, lockHolder: string | null = null, editState = 'read-only') => {
  useSpeleoStore.setState({
    link: {
      permission,
      editState,
      lockHolder,
      lockedByOther: lockHolder != null && editState !== 'editing',
      hasUnpushedEdits: false,
      remoteState: 'up_to_date',
      noAccess: false,
      serverError: null,
    } as never,
    refreshLinkStatus,
    syncProjectLink,
  });
};

const defaultMock = () =>
  invokeIpcMock.mockImplementation((cmd: string) => {
    if (cmd === 'speleodb_list_collaborators') return Promise.resolve(ROSTER);
    if (cmd === 'speleodb_list_teams')
      return Promise.resolve([
        { id: 't1', name: 'Divers' },
        { id: 't2', name: 'Surveyors' },
      ]);
    // add/set/remove all return the (unchanged, for the test) refreshed roster.
    return Promise.resolve(ROSTER);
  });

beforeEach(() => {
  invokeIpcMock.mockReset();
  refreshLinkStatus = vi.fn(async () => {});
  syncProjectLink = vi.fn();
  closeDialog = vi.fn();
  showToast = vi.fn();
  useUIStore.setState({ showToast, closeDialog });
  useProjectStore.setState({ project: { name: 'My Cave' } as never });
  defaultMock();
});

describe('SpeleoProjectAdmin', () => {
  it('renders the user + team roster and the instant-changes note', async () => {
    seed('ADMIN');
    render(<SpeleoProjectAdmin />);
    expect(await screen.findByTestId('speleodb-collab-user-bob@x.com')).toBeInTheDocument();
    expect(screen.getByTestId('speleodb-collab-team-t1')).toHaveTextContent('Divers');
    expect(screen.getByTestId('speleodb-collaborators-changes-note')).toBeInTheDocument();
  });

  it('does not offer mutation controls to a non-admin', async () => {
    seed('READ_ONLY');
    render(<SpeleoProjectAdmin />);
    expect(await screen.findByTestId('speleodb-collaborators-readonly-badge')).toBeInTheDocument();
    expect(screen.queryByTestId('speleodb-collaborators-add-user')).toBeNull();
    expect(screen.queryByTestId('speleodb-collab-user-remove-bob@x.com')).toBeNull();
    // No delete danger zone for a non-admin.
    expect(screen.queryByTestId('speleodb-delete-button')).toBeNull();
  });

  it('disables its own row (no self grant/remove)', async () => {
    seed('ADMIN');
    render(<SpeleoProjectAdmin />);
    await screen.findByTestId('speleodb-collab-user-me@x.com');
    expect(screen.queryByTestId('speleodb-collab-user-remove-me@x.com')).toBeNull();
    expect(screen.queryByTestId('speleodb-collab-user-level-me@x.com')).toBeNull();
    // But another user's row IS editable.
    expect(screen.getByTestId('speleodb-collab-user-remove-bob@x.com')).toBeInTheDocument();
  });

  it('adds a collaborator with the chosen email + level', async () => {
    seed('ADMIN');
    render(<SpeleoProjectAdmin />);
    await userEvent.type(await screen.findByTestId('speleodb-collaborators-add-email'), 'new@x.com');
    await userEvent.selectOptions(
      screen.getByTestId('speleodb-collaborators-add-level'),
      'READ_AND_WRITE',
    );
    await userEvent.click(screen.getByTestId('speleodb-collaborators-add-user'));
    await waitFor(() => {
      const call = invokeIpcMock.mock.calls.find((c) => c[0] === 'speleodb_add_collaborator');
      expect(call).toBeTruthy();
      expect(call![1]).toEqual({ email: 'new@x.com', permission: 'READ_AND_WRITE' });
    });
  });

  it('autocompletes the collaborator email and fills it on pick', async () => {
    seed('ADMIN');
    invokeIpcMock.mockImplementation((cmd: string, args?: { query?: string }) => {
      if (cmd === 'speleodb_list_collaborators') return Promise.resolve(ROSTER);
      if (cmd === 'speleodb_list_teams') return Promise.resolve([]);
      if (cmd === 'speleodb_search_users') {
        // The debounce means only the settled 3-char query reaches the server.
        expect(args?.query).toBe('ali');
        return Promise.resolve([{ email: 'alice@x.com', label: 'Alice Diver <alice@x.com>' }]);
      }
      return Promise.resolve(ROSTER);
    });
    render(<SpeleoProjectAdmin />);
    const input = await screen.findByTestId('speleodb-collaborators-add-email');
    await userEvent.type(input, 'ali');
    const suggestion = await screen.findByTestId('speleodb-collaborators-suggestion-alice@x.com');
    expect(suggestion).toHaveTextContent('Alice Diver <alice@x.com>');
    await userEvent.click(suggestion);
    expect(input).toHaveValue('alice@x.com');
    // Picking closes the dropdown (and does not re-open it for the filled value).
    expect(screen.queryByTestId('speleodb-collaborators-suggestions')).toBeNull();
  });

  it('does not query autocomplete below the 3-char minimum', async () => {
    seed('ADMIN');
    render(<SpeleoProjectAdmin />);
    const input = await screen.findByTestId('speleodb-collaborators-add-email');
    await userEvent.type(input, 'al');
    // Give the debounce window time to (not) fire.
    await new Promise((r) => window.setTimeout(r, 350));
    expect(invokeIpcMock.mock.calls.some((c) => c[0] === 'speleodb_search_users')).toBe(false);
  });

  it('changes and removes another user with the right payloads', async () => {
    seed('ADMIN');
    render(<SpeleoProjectAdmin />);
    await userEvent.selectOptions(
      await screen.findByTestId('speleodb-collab-user-level-bob@x.com'),
      'READ_AND_WRITE',
    );
    await waitFor(() => {
      const call = invokeIpcMock.mock.calls.find((c) => c[0] === 'speleodb_set_collaborator');
      expect(call![1]).toEqual({ email: 'bob@x.com', permission: 'READ_AND_WRITE' });
    });
    await userEvent.click(screen.getByTestId('speleodb-collab-user-remove-bob@x.com'));
    await waitFor(() => {
      const call = invokeIpcMock.mock.calls.find((c) => c[0] === 'speleodb_remove_collaborator');
      expect(call![1]).toEqual({ email: 'bob@x.com' });
    });
  });

  it('adds a team via the picker (no ADMIN option offered)', async () => {
    seed('ADMIN');
    render(<SpeleoProjectAdmin />);
    const picker = await screen.findByTestId('speleodb-collaborators-add-team-id');
    // Teams cannot be ADMIN: the level select offers only the three non-admin tiers.
    const levelSelect = screen.getByTestId('speleodb-collaborators-add-team-level');
    expect(levelSelect.querySelectorAll('option')).toHaveLength(3);
    await userEvent.selectOptions(picker, 't2');
    await userEvent.click(screen.getByTestId('speleodb-collaborators-add-team'));
    await waitFor(() => {
      const call = invokeIpcMock.mock.calls.find((c) => c[0] === 'speleodb_add_team');
      expect(call![1]).toEqual({ teamId: 't2', permission: 'READ_ONLY' });
    });
  });

  it('releases a held lock and refreshes status', async () => {
    seed('ADMIN', 'bob@x.com');
    render(<SpeleoProjectAdmin />);
    const btn = await screen.findByTestId('speleodb-lock-release');
    expect(screen.getByTestId('speleodb-lock-holder')).toHaveTextContent('bob@x.com');
    await userEvent.click(btn);
    await waitFor(() =>
      expect(invokeIpcMock.mock.calls.some((c) => c[0] === 'speleodb_release_current_lock')).toBe(
        true,
      ),
    );
    await waitFor(() => expect(refreshLinkStatus).toHaveBeenCalled());
  });

  it('changes and removes a team with the right payloads', async () => {
    seed('ADMIN');
    render(<SpeleoProjectAdmin />);
    await userEvent.selectOptions(
      await screen.findByTestId('speleodb-collab-team-level-t1'),
      'READ_ONLY',
    );
    await waitFor(() => {
      const call = invokeIpcMock.mock.calls.find((c) => c[0] === 'speleodb_set_team');
      expect(call![1]).toEqual({ teamId: 't1', permission: 'READ_ONLY' });
    });
    await userEvent.click(screen.getByTestId('speleodb-collab-team-remove-t1'));
    await waitFor(() => {
      const call = invokeIpcMock.mock.calls.find((c) => c[0] === 'speleodb_remove_team');
      expect(call![1]).toEqual({ teamId: 't1' });
    });
  });

  it('surfaces a mutation failure as a toast and leaves the roster intact', async () => {
    seed('ADMIN');
    // The change call rejects; everything else (incl. the roster reload) stays fine.
    invokeIpcMock.mockImplementation((cmd: string) => {
      if (cmd === 'speleodb_list_collaborators') return Promise.resolve(ROSTER);
      if (cmd === 'speleodb_list_teams') return Promise.resolve([{ id: 't1', name: 'Divers' }]);
      if (cmd === 'speleodb_set_collaborator') return Promise.reject(new Error('boom'));
      return Promise.resolve(ROSTER);
    });
    render(<SpeleoProjectAdmin />);
    await userEvent.selectOptions(
      await screen.findByTestId('speleodb-collab-user-level-bob@x.com'),
      'READ_AND_WRITE',
    );
    // Error surfaced, and the row is still there (roster not blanked on failure).
    await waitFor(() => expect(showToast).toHaveBeenCalled());
    expect(screen.getByTestId('speleodb-collab-user-bob@x.com')).toBeInTheDocument();
  });

  it('a FAILED delete does NOT unlink or close (no false success)', async () => {
    seed('ADMIN');
    invokeIpcMock.mockImplementation((cmd: string) => {
      if (cmd === 'speleodb_list_collaborators') return Promise.resolve(ROSTER);
      if (cmd === 'speleodb_list_teams') return Promise.resolve([]);
      if (cmd === 'speleodb_delete_project') return Promise.reject(new Error('server 500'));
      return Promise.resolve(ROSTER);
    });
    render(<SpeleoProjectAdmin />);
    await userEvent.type(await screen.findByTestId('speleodb-delete-confirm-input'), 'My Cave');
    const del = screen.getByTestId('speleodb-delete-button');
    await userEvent.click(del);
    await waitFor(() => expect(showToast).toHaveBeenCalled());
    expect(syncProjectLink).not.toHaveBeenCalled();
    expect(closeDialog).not.toHaveBeenCalled();
    // The button re-enables so the user can retry / cancel.
    await waitFor(() => expect(del).toBeEnabled());
  });

  it('shows the load-error state and retries', async () => {
    seed('ADMIN');
    let attempt = 0;
    invokeIpcMock.mockImplementation((cmd: string) => {
      if (cmd === 'speleodb_list_collaborators') {
        attempt += 1;
        return attempt === 1 ? Promise.reject(new Error('offline')) : Promise.resolve(ROSTER);
      }
      if (cmd === 'speleodb_list_teams') return Promise.resolve([]);
      return Promise.resolve(ROSTER);
    });
    render(<SpeleoProjectAdmin />);
    const retry = await screen.findByTestId('speleodb-collaborators-retry');
    await userEvent.click(retry);
    expect(await screen.findByTestId('speleodb-collab-user-bob@x.com')).toBeInTheDocument();
  });

  it('warns and offers release when the caller holds the lock (holder still null)', async () => {
    // The stuck-lock recovery case: after acquiring a lock the fast path flips
    // editState to 'editing' but leaves lockHolder null. The Lock section must still
    // show "held by you" + a release button, not a dead-end "no lock held".
    seed('ADMIN', null, 'editing');
    render(<SpeleoProjectAdmin />);
    expect(await screen.findByTestId('speleodb-lock-self-warning')).toBeInTheDocument();
    expect(screen.getByTestId('speleodb-lock-release')).toBeInTheDocument();
    expect(screen.queryByTestId('speleodb-lock-none')).toBeNull();
  });

  it('gates delete on typing the project name, then unlinks + closes', async () => {
    seed('ADMIN');
    render(<SpeleoProjectAdmin />);
    const del = await screen.findByTestId('speleodb-delete-button');
    expect(del).toBeDisabled();
    await userEvent.type(screen.getByTestId('speleodb-delete-confirm-input'), 'My Cave');
    expect(del).toBeEnabled();
    await userEvent.click(del);
    await waitFor(() =>
      expect(invokeIpcMock.mock.calls.some((c) => c[0] === 'speleodb_delete_project')).toBe(true),
    );
    // Confirmed LOCAL, not merely unlinked: `clearLink()` would leave
    // `projectLinkKind: 'unknown'`, which `selectSpeleoReadOnly` reads as
    // read-only, stranding the still-open (now plain local) project uneditable
    // with no poll left to re-resolve it.
    await waitFor(() => expect(syncProjectLink).toHaveBeenCalledWith(false));
    await waitFor(() => expect(closeDialog).toHaveBeenCalled());
  });
});
