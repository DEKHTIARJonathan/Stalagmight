/**
 * Component test - the SpeleoDB project dialog shell: which tabs exist, which panel
 * a click swaps in, and the footer Save that the General tab's body no longer owns.
 *
 * The Save gate is the interesting part: it lives in the FOOTER but reads the tab
 * body's diff, so it must appear only on General, only for a user who may write, and
 * only once something actually changed.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const invokeIpcMock = vi.hoisted(() => vi.fn());
vi.mock('../../utils/ipc', () => ({
  invokeIpc: invokeIpcMock,
  getErrorMessage: (e: unknown) => (e instanceof Error ? e.message : String(e)),
}));

import { SpeleoDbProjectDialog } from './SpeleoDbProjectDialog';
import { useSpeleoStore, type SpeleoLinkState } from '../../store/speleoStore';
import { useProjectStore } from '../../store/projectStore';
import { useUIStore } from '../../store/uiStore';
import type { Permission, SpeleoProjectMetadata } from '../../types/ipc.generated';

const META: SpeleoProjectMetadata = {
  name: 'Cave A',
  description: 'desc',
  country: 'US',
  visibility: 'PRIVATE',
  latitude: null,
  longitude: null,
  exclude_geojson: false,
};

const LINK: SpeleoLinkState = {
  permission: 'READ_AND_WRITE',
  editState: 'read-only',
  lockHolder: null,
  lockedByOther: false,
  hasUnpushedEdits: false,
  forceEditing: false,
  forceEditAllowed: false,
  remoteState: 'up_to_date',
  noAccess: false,
  serverError: null,
};

let closeDialog: ReturnType<typeof vi.fn>;

const seed = (permission: Permission = 'READ_AND_WRITE') =>
  useSpeleoStore.setState({
    link: { ...LINK, permission },
    remoteProjectId: 'p1',
    refreshLinkStatus: vi.fn(async () => {}),
  });

beforeEach(() => {
  invokeIpcMock.mockReset();
  invokeIpcMock.mockImplementation((cmd: string) => {
    if (cmd === 'speleodb_get_project_metadata') return Promise.resolve(META);
    if (cmd === 'speleodb_list_collaborators') return Promise.resolve({ users: [], teams: [] });
    if (cmd === 'speleodb_list_teams') return Promise.resolve([]);
    if (cmd === 'speleodb_get_revisions') return Promise.resolve([]);
    return Promise.resolve(null);
  });
  closeDialog = vi.fn();
  useSpeleoStore.setState({ link: null, remoteProjectId: null, session: null });
  useProjectStore.setState({ project: { name: 'Cave A' } as never });
  useUIStore.setState({
    activeDialog: 'speleodb-project',
    dialogData: {},
    closeDialog,
    openDialog: vi.fn(),
    showToast: vi.fn(),
  });
});

describe('SpeleoDbProjectDialog', () => {
  it('renders all four tabs for a remote project, starting on General', async () => {
    seed();
    render(<SpeleoDbProjectDialog />);
    for (const tk of ['general', 'collaborators', 'history', 'admin']) {
      expect(screen.getByTestId(`speleodb-project-tab-${tk}`)).toBeInTheDocument();
    }
    expect(screen.getByTestId('speleodb-project-tab-general')).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(await screen.findByTestId('speleodb-settings-tab')).toBeInTheDocument();
  });

  it('swaps the panel when another tab is clicked', async () => {
    seed('ADMIN');
    render(<SpeleoDbProjectDialog />);
    await screen.findByTestId('speleodb-settings-tab');

    await userEvent.click(screen.getByTestId('speleodb-project-tab-collaborators'));
    expect(await screen.findByTestId('speleodb-collaborators-tab')).toBeInTheDocument();
    expect(screen.queryByTestId('speleodb-settings-tab')).toBeNull();

    await userEvent.click(screen.getByTestId('speleodb-project-tab-admin'));
    expect(screen.getByTestId('speleodb-admin-tab')).toBeInTheDocument();
    expect(screen.queryByTestId('speleodb-collaborators-tab')).toBeNull();

    await userEvent.click(screen.getByTestId('speleodb-project-tab-history'));
    expect(await screen.findByTestId('speleodb-revisions')).toBeInTheDocument();
  });

  it('seeds the initial tab from dialogData', async () => {
    seed('ADMIN');
    useUIStore.setState({ dialogData: { tab: 'admin' } });
    render(<SpeleoDbProjectDialog />);
    expect(await screen.findByTestId('speleodb-admin-tab')).toBeInTheDocument();
    expect(screen.getByTestId('speleodb-project-tab-admin')).toHaveAttribute(
      'aria-selected',
      'true',
    );
  });

  it('falls back to General for an unknown dialogData tab', async () => {
    seed();
    useUIStore.setState({ dialogData: { tab: 'nope' } });
    render(<SpeleoDbProjectDialog />);
    expect(await screen.findByTestId('speleodb-settings-tab')).toBeInTheDocument();
  });

  it('shows Save only on General, and only once the form differs', async () => {
    seed();
    render(<SpeleoDbProjectDialog />);
    const name = await screen.findByTestId('speleodb-settings-name');
    // Nothing changed yet: the footer button exists but is inert.
    expect(screen.getByTestId('speleodb-settings-save')).toBeDisabled();
    await userEvent.type(name, 'B');
    expect(screen.getByTestId('speleodb-settings-save')).toBeEnabled();

    // Every other tab writes to the server on click - no staged Save to offer.
    await userEvent.click(screen.getByTestId('speleodb-project-tab-collaborators'));
    expect(screen.queryByTestId('speleodb-settings-save')).toBeNull();
    // The Close button is on every tab so the footer does not jump.
    expect(screen.getByTestId('speleodb-project-close')).toBeInTheDocument();
  });

  it('omits Save entirely for a read-only user', async () => {
    seed('READ_ONLY');
    render(<SpeleoDbProjectDialog />);
    expect(await screen.findByTestId('speleodb-settings-readonly-badge')).toBeInTheDocument();
    expect(screen.queryByTestId('speleodb-settings-save')).toBeNull();
    expect(screen.getByTestId('speleodb-project-close')).toBeInTheDocument();
  });

  it('closes from the footer', async () => {
    seed();
    render(<SpeleoDbProjectDialog />);
    await userEvent.click(screen.getByTestId('speleodb-project-close'));
    expect(closeDialog).toHaveBeenCalled();
  });

  /**
   * `closeOnBackdropClick={false}` signals "do not dismiss this by accident", but it
   * only ever covered the backdrop: Escape and the X ran straight through and threw
   * away staged General-tab metadata edits with no notice. DialogWrapper has the
   * confirm overlay built in; the dialog just never told it it was dirty.
   */
  it('asks before discarding staged metadata edits on Escape', async () => {
    seed();
    render(<SpeleoDbProjectDialog />);
    await userEvent.type(await screen.findByTestId('speleodb-settings-name'), 'B');

    await userEvent.keyboard('{Escape}');

    expect(screen.getByText('Unsaved Changes')).toBeInTheDocument();
    expect(closeDialog).not.toHaveBeenCalled();
  });

  it('does not ask when nothing was staged', async () => {
    seed();
    render(<SpeleoDbProjectDialog />);
    await screen.findByTestId('speleodb-settings-name');

    await userEvent.keyboard('{Escape}');

    expect(closeDialog).toHaveBeenCalled();
  });

  it('says so - and asks the server nothing - when the project is not linked', async () => {
    render(<SpeleoDbProjectDialog />);
    expect(screen.getByTestId('speleodb-project-not-remote')).toBeInTheDocument();
    expect(screen.queryByTestId('speleodb-project-tab-general')).toBeNull();
    // The footer still renders so the dialog has a way out.
    expect(screen.getByTestId('speleodb-project-close')).toBeInTheDocument();
    await waitFor(() => expect(invokeIpcMock).not.toHaveBeenCalled());
  });
});
