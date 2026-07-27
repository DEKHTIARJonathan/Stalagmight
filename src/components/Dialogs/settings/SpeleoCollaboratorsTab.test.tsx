/**
 * Component test (#215) - the Collaborators tab of the SpeleoDB project dialog.
 *
 * Covers the ADMIN-vs-READ_ONLY gating, the exact IPC payloads the CRUD controls
 * send, the self-row lockout, and the load-error retry.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const invokeIpcMock = vi.hoisted(() => vi.fn());
vi.mock('../../../utils/ipc', () => ({
  invokeIpc: invokeIpcMock,
  getErrorMessage: (e: unknown) => (e instanceof Error ? e.message : String(e)),
}));

import { SpeleoCollaboratorsTab } from './SpeleoCollaboratorsTab';
import { useSpeleoStore } from '../../../store/speleoStore';
import { useUIStore } from '../../../store/uiStore';
import type { Permission, SpeleoCollaborators } from '../../../types/ipc.generated';

const ROSTER: SpeleoCollaborators = {
  users: [
    { email: 'me@x.com', permission: 'ADMIN', is_self: true },
    { email: 'bob@x.com', permission: 'READ_ONLY', is_self: false },
  ],
  teams: [{ team_id: 't1', team_name: 'Divers', permission: 'READ_AND_WRITE' }],
};

let showToast: ReturnType<typeof vi.fn>;

const seed = (permission: Permission) => {
  useSpeleoStore.setState({
    link: {
      permission,
      editState: 'read-only',
      lockHolder: null,
      lockedByOther: false,
      hasUnpushedEdits: false,
      remoteState: 'up_to_date',
      noAccess: false,
      serverError: null,
    } as never,
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
  showToast = vi.fn();
  useUIStore.setState({ showToast });
  useSpeleoStore.setState({ session: null, remoteProjectId: null });
  defaultMock();
});

describe('SpeleoCollaboratorsTab', () => {
  it('renders the user + team roster and the instant-changes note', async () => {
    seed('ADMIN');
    render(<SpeleoCollaboratorsTab />);
    expect(await screen.findByTestId('speleodb-collab-user-bob@x.com')).toBeInTheDocument();
    expect(screen.getByTestId('speleodb-collab-team-t1')).toHaveTextContent('Divers');
    expect(screen.getByTestId('speleodb-collaborators-changes-note')).toBeInTheDocument();
  });

  it('does not offer mutation controls to a non-admin', async () => {
    seed('READ_ONLY');
    render(<SpeleoCollaboratorsTab />);
    expect(await screen.findByTestId('speleodb-collaborators-readonly-badge')).toBeInTheDocument();
    expect(screen.queryByTestId('speleodb-collaborators-add-user')).toBeNull();
    expect(screen.queryByTestId('speleodb-collab-user-remove-bob@x.com')).toBeNull();
  });

  it('disables its own row (no self grant/remove)', async () => {
    seed('ADMIN');
    render(<SpeleoCollaboratorsTab />);
    await screen.findByTestId('speleodb-collab-user-me@x.com');
    expect(screen.queryByTestId('speleodb-collab-user-remove-me@x.com')).toBeNull();
    expect(screen.queryByTestId('speleodb-collab-user-level-me@x.com')).toBeNull();
    // But another user's row IS editable.
    expect(screen.getByTestId('speleodb-collab-user-remove-bob@x.com')).toBeInTheDocument();
  });

  it('adds a collaborator with the chosen email + level', async () => {
    seed('ADMIN');
    render(<SpeleoCollaboratorsTab />);
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
    render(<SpeleoCollaboratorsTab />);
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
    render(<SpeleoCollaboratorsTab />);
    const input = await screen.findByTestId('speleodb-collaborators-add-email');
    await userEvent.type(input, 'al');
    // Give the debounce window time to (not) fire.
    await new Promise((r) => window.setTimeout(r, 350));
    expect(invokeIpcMock.mock.calls.some((c) => c[0] === 'speleodb_search_users')).toBe(false);
  });

  it('changes and removes another user with the right payloads', async () => {
    seed('ADMIN');
    render(<SpeleoCollaboratorsTab />);
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
    render(<SpeleoCollaboratorsTab />);
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

  it('changes and removes a team with the right payloads', async () => {
    seed('ADMIN');
    render(<SpeleoCollaboratorsTab />);
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
    render(<SpeleoCollaboratorsTab />);
    await userEvent.selectOptions(
      await screen.findByTestId('speleodb-collab-user-level-bob@x.com'),
      'READ_AND_WRITE',
    );
    // Error surfaced, and the row is still there (roster not blanked on failure).
    await waitFor(() => expect(showToast).toHaveBeenCalled());
    expect(screen.getByTestId('speleodb-collab-user-bob@x.com')).toBeInTheDocument();
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
    render(<SpeleoCollaboratorsTab />);
    const retry = await screen.findByTestId('speleodb-collaborators-retry');
    await userEvent.click(retry);
    expect(await screen.findByTestId('speleodb-collab-user-bob@x.com')).toBeInTheDocument();
  });

  it('disables the web link when there is no signed-in endpoint to open', async () => {
    seed('ADMIN');
    render(<SpeleoCollaboratorsTab />);
    expect(await screen.findByTestId('speleodb-web-collaborators')).toBeDisabled();

    useSpeleoStore.setState({
      session: { loggedIn: true, userEmail: 'me@x.com', endpoint: 'https://x.test', keychainBacked: true, storage: 'keychain', keychain: 'available' },
      remoteProjectId: 'p1',
    });
    await waitFor(() =>
      expect(screen.getByTestId('speleodb-web-collaborators')).toBeEnabled(),
    );
  });
});
