/**
 * Component test (#207) - the Create-on-SpeleoDB Publish dialog.
 *
 * Covers the submit gating (name + country + valid coords), the `speleodb_publish`
 * payload, and the load-guard: a failed reopen must NOT claim success or close.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const invokeIpcMock = vi.hoisted(() => vi.fn());
vi.mock('../../utils/ipc', () => ({ invokeIpc: invokeIpcMock, getErrorMessage: (_e: unknown, f: string) => f }));

import PublishToSpeleoDbDialog from './PublishToSpeleoDbDialog';
import { useProjectStore } from '../../store/projectStore';
import { useSpeleoStore } from '../../store/speleoStore';
import { useUIStore } from '../../store/uiStore';

let loadProjectMock: ReturnType<typeof vi.fn>;
let closeDialogMock: ReturnType<typeof vi.fn>;
let showToastMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  invokeIpcMock.mockReset();
  loadProjectMock = vi.fn(async () => ({ success: true }));
  closeDialogMock = vi.fn();
  showToastMock = vi.fn();
  useProjectStore.setState({
    project: { name: 'My Cave', zero_datums: [] } as never,
    loadProject: loadProjectMock,
  });
  useSpeleoStore.setState({
    refreshLinkStatus: vi.fn(async () => {}),
    clearSession: vi.fn(),
  });
  useUIStore.setState({ closeDialog: closeDialogMock, showToast: showToastMock });
});

describe('PublishToSpeleoDbDialog', () => {
  it('gates Publish on a chosen country and publishes with the right params', async () => {
    invokeIpcMock.mockResolvedValue({
      project_id: 'p1',
      endpoint: 'https://x',
      local_path: '/cache/p1/project.stalx',
    });
    render(<PublishToSpeleoDbDialog />);

    // Name prefilled from the project; country still unchosen -> Publish disabled.
    expect(screen.getByTestId('publish-to-speleodb-dialog-name')).toHaveValue('My Cave');
    expect(screen.getByTestId('publish-to-speleodb-dialog-submit')).toBeDisabled();

    await userEvent.selectOptions(screen.getByTestId('publish-to-speleodb-dialog-country'), 'US');
    const submit = screen.getByTestId('publish-to-speleodb-dialog-submit');
    // Country chosen but description still empty -> stays disabled (server requires it).
    expect(submit).toBeDisabled();
    expect(screen.getByTestId('publish-to-speleodb-dialog-description-error')).toBeInTheDocument();

    fireEvent.change(screen.getByTestId('publish-to-speleodb-dialog-description'), { target: { value: 'Main line survey' } });
    expect(screen.queryByTestId('publish-to-speleodb-dialog-description-error')).toBeNull();
    await waitFor(() => expect(submit).toBeEnabled());
    await userEvent.click(submit);

    await waitFor(() => {
      const call = invokeIpcMock.mock.calls.find((c) => c[0] === 'speleodb_publish');
      expect(call).toBeTruthy();
      expect(call![1]).toEqual({
        params: {
          name: 'My Cave',
          description: 'Main line survey',
          country: 'US',
          visibility: 'PRIVATE',
          latitude: null,
          longitude: null,
        },
      });
    });
    // Reloaded the now-remote project and closed on success.
    await waitFor(() => expect(loadProjectMock).toHaveBeenCalledWith('/cache/p1/project.stalx'));
    await waitFor(() => expect(closeDialogMock).toHaveBeenCalled());
  });

  it('does NOT close or claim success when the reopen fails', async () => {
    invokeIpcMock.mockResolvedValue({
      project_id: 'p1',
      endpoint: 'https://x',
      local_path: '/cache/p1/project.stalx',
    });
    loadProjectMock.mockResolvedValue({ success: false });
    render(<PublishToSpeleoDbDialog />);

    await userEvent.selectOptions(screen.getByTestId('publish-to-speleodb-dialog-country'), 'US');
    fireEvent.change(screen.getByTestId('publish-to-speleodb-dialog-description'), { target: { value: 'desc' } });
    await userEvent.click(screen.getByTestId('publish-to-speleodb-dialog-submit'));

    await waitFor(() => expect(loadProjectMock).toHaveBeenCalled());
    expect(closeDialogMock).not.toHaveBeenCalled();
  });

  it('blocks submit on an out-of-range coordinate pair', async () => {
    render(<PublishToSpeleoDbDialog />);
    await userEvent.selectOptions(screen.getByTestId('publish-to-speleodb-dialog-country'), 'US');
    await userEvent.type(screen.getByTestId('publish-to-speleodb-dialog-latitude'), '999');
    await userEvent.type(screen.getByTestId('publish-to-speleodb-dialog-longitude'), '0');
    expect(screen.getByTestId('publish-to-speleodb-dialog-submit')).toBeDisabled();
    expect(screen.getByTestId('publish-to-speleodb-dialog-coords-error')).toBeInTheDocument();
  });

  it('prefills country and coordinates from the first georeferenced datum (#217)', async () => {
    // A Yucatan cenote datum should offline-resolve the required country to MX.
    useProjectStore.setState({
      project: {
        name: 'Cenote',
        zero_datums: [{ gps: { latitude: 20.21, longitude: -87.46 } }],
      } as never,
      loadProject: loadProjectMock,
    });
    render(<PublishToSpeleoDbDialog />);
    expect(screen.getByTestId('publish-to-speleodb-dialog-country')).toHaveValue('MX');
    expect(screen.getByTestId('publish-to-speleodb-dialog-latitude')).toHaveValue(20.21);
    expect(screen.getByTestId('publish-to-speleodb-dialog-longitude')).toHaveValue(-87.46);
    // Country + coords + name are prefilled, but a description is still required, so
    // Publish stays disabled until one is entered.
    expect(screen.getByTestId('publish-to-speleodb-dialog-submit')).toBeDisabled();
    fireEvent.change(screen.getByTestId('publish-to-speleodb-dialog-description'), { target: { value: 'Cenote line' } });
    await waitFor(() =>
      expect(screen.getByTestId('publish-to-speleodb-dialog-submit')).toBeEnabled(),
    );
  });

  it('leaves country empty when the datum resolves to no country (open ocean)', () => {
    useProjectStore.setState({
      project: {
        name: 'Blue Hole',
        zero_datums: [{ gps: { latitude: 30.0, longitude: -40.0 } }],
      } as never,
      loadProject: loadProjectMock,
    });
    render(<PublishToSpeleoDbDialog />);
    expect(screen.getByTestId('publish-to-speleodb-dialog-country')).toHaveValue('');
  });

  it('autocompletes a collaborator, then grants it after the project is published', async () => {
    invokeIpcMock.mockImplementation((cmd: string) => {
      if (cmd === 'speleodb_search_users') {
        return Promise.resolve([{ email: 'alice@x.com', label: 'Alice Diver <alice@x.com>' }]);
      }
      if (cmd === 'speleodb_publish') {
        return Promise.resolve({ project_id: 'p1', endpoint: 'https://x', local_path: '/cache/p1/project.stalx' });
      }
      // speleodb_add_collaborator -> the (unused-here) refreshed roster.
      return Promise.resolve({ users: [], teams: [] });
    });
    render(<PublishToSpeleoDbDialog />);
    await userEvent.selectOptions(screen.getByTestId('publish-to-speleodb-dialog-country'), 'US');
    fireEvent.change(screen.getByTestId('publish-to-speleodb-dialog-description'), { target: { value: 'desc' } });

    // Pick a suggestion from the debounced typeahead, choose a level, and queue it.
    await userEvent.type(screen.getByTestId('publish-to-speleodb-dialog-collab-email'), 'ali');
    await userEvent.click(await screen.findByTestId('publish-to-speleodb-dialog-collab-suggestion-alice@x.com'));
    expect(screen.getByTestId('publish-to-speleodb-dialog-collab-email')).toHaveValue('alice@x.com');
    await userEvent.selectOptions(
      screen.getByTestId('publish-to-speleodb-dialog-collab-add-level'),
      'READ_AND_WRITE',
    );
    await userEvent.click(screen.getByTestId('publish-to-speleodb-dialog-collab-add'));
    expect(screen.getByTestId('publish-to-speleodb-dialog-collab-alice@x.com')).toBeInTheDocument();

    await userEvent.click(screen.getByTestId('publish-to-speleodb-dialog-submit'));

    // The grant lands only after the create, with the queued email + level.
    await waitFor(() => {
      const call = invokeIpcMock.mock.calls.find((c) => c[0] === 'speleodb_add_collaborator');
      expect(call).toBeTruthy();
      expect(call![1]).toEqual({ email: 'alice@x.com', permission: 'READ_AND_WRITE' });
    });
    await waitFor(() => expect(closeDialogMock).toHaveBeenCalled());
  });

  it('still closes but warns when a queued collaborator cannot be granted', async () => {
    invokeIpcMock.mockImplementation((cmd: string) => {
      if (cmd === 'speleodb_publish') {
        return Promise.resolve({ project_id: 'p1', endpoint: 'https://x', local_path: '/cache/p1/project.stalx' });
      }
      if (cmd === 'speleodb_add_collaborator') return Promise.reject(new Error('403'));
      return Promise.resolve({ users: [], teams: [] });
    });
    render(<PublishToSpeleoDbDialog />);
    await userEvent.selectOptions(screen.getByTestId('publish-to-speleodb-dialog-country'), 'US');
    fireEvent.change(screen.getByTestId('publish-to-speleodb-dialog-description'), { target: { value: 'desc' } });
    await userEvent.type(screen.getByTestId('publish-to-speleodb-dialog-collab-email'), 'bob@x.com');
    await userEvent.click(screen.getByTestId('publish-to-speleodb-dialog-collab-add'));
    await userEvent.click(screen.getByTestId('publish-to-speleodb-dialog-submit'));

    await waitFor(() => expect(closeDialogMock).toHaveBeenCalled());
    // The failure surfaced as the partial-warning toast, not the plain success one.
    const toasts = showToastMock.mock.calls.map((c) => String(c[0]));
    expect(toasts.some((m) => m.includes('bob@x.com'))).toBe(true);
    expect(toasts).not.toContain('Project published to SpeleoDB.');
  });

  it('grants the FINAL queued level after changing a collaborator row in place', async () => {
    invokeIpcMock.mockImplementation((cmd: string) => {
      if (cmd === 'speleodb_publish') {
        return Promise.resolve({ project_id: 'p1', endpoint: 'https://x', local_path: '/cache/p1/project.stalx' });
      }
      // speleodb_search_users (unused - added by typing) + add_collaborator roster.
      return Promise.resolve({ users: [], teams: [] });
    });
    render(<PublishToSpeleoDbDialog />);
    await userEvent.selectOptions(screen.getByTestId('publish-to-speleodb-dialog-country'), 'US');
    fireEvent.change(screen.getByTestId('publish-to-speleodb-dialog-description'), { target: { value: 'desc' } });

    // Queue carol at the default level, then change the QUEUED row's level.
    fireEvent.change(screen.getByTestId('publish-to-speleodb-dialog-collab-email'), {
      target: { value: 'carol@x.com' },
    });
    await userEvent.click(screen.getByTestId('publish-to-speleodb-dialog-collab-add'));
    fireEvent.change(screen.getByTestId('publish-to-speleodb-dialog-collab-level-carol@x.com'), {
      target: { value: 'ADMIN' },
    });

    await userEvent.click(screen.getByTestId('publish-to-speleodb-dialog-submit'));

    await waitFor(() => {
      const call = invokeIpcMock.mock.calls.find((c) => c[0] === 'speleodb_add_collaborator');
      expect(call).toBeTruthy();
      expect(call![1]).toEqual({ email: 'carol@x.com', permission: 'ADMIN' });
    });
  });

  it('removes a queued collaborator so it is never granted', async () => {
    invokeIpcMock.mockImplementation((cmd: string) => {
      if (cmd === 'speleodb_publish') {
        return Promise.resolve({ project_id: 'p1', endpoint: 'https://x', local_path: '/cache/p1/project.stalx' });
      }
      return Promise.resolve({ users: [], teams: [] });
    });
    render(<PublishToSpeleoDbDialog />);
    await userEvent.selectOptions(screen.getByTestId('publish-to-speleodb-dialog-country'), 'US');
    fireEvent.change(screen.getByTestId('publish-to-speleodb-dialog-description'), { target: { value: 'desc' } });

    fireEvent.change(screen.getByTestId('publish-to-speleodb-dialog-collab-email'), {
      target: { value: 'dave@x.com' },
    });
    await userEvent.click(screen.getByTestId('publish-to-speleodb-dialog-collab-add'));
    expect(screen.getByTestId('publish-to-speleodb-dialog-collab-dave@x.com')).toBeInTheDocument();

    await userEvent.click(screen.getByTestId('publish-to-speleodb-dialog-collab-remove-dave@x.com'));
    expect(screen.queryByTestId('publish-to-speleodb-dialog-collab-dave@x.com')).toBeNull();

    await userEvent.click(screen.getByTestId('publish-to-speleodb-dialog-submit'));

    await waitFor(() => expect(closeDialogMock).toHaveBeenCalled());
    // Nothing queued -> no grant call, and the plain success toast (not the partial one).
    expect(invokeIpcMock.mock.calls.find((c) => c[0] === 'speleodb_add_collaborator')).toBeUndefined();
    const toasts = showToastMock.mock.calls.map((c) => String(c[0]));
    expect(toasts).toContain('Project published to SpeleoDB.');
  });
});
