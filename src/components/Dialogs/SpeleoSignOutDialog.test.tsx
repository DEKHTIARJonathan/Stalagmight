import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const doneMock = vi.hoisted(() => vi.fn());
const openRemoteMock = vi.hoisted(() => vi.fn());
const invokeIpcMock = vi.hoisted(() => vi.fn());
vi.mock('../../hooks/useSpeleoActions', () => ({ useSpeleoActions: () => ({ done: doneMock, busy: false }) }));
vi.mock('../../hooks/useOpenRemoteProject', () => ({ useOpenRemoteProject: () => ({ openRemote: openRemoteMock }) }));
vi.mock('../../utils/ipc', () => ({
  invokeIpc: invokeIpcMock,
  getErrorMessage: (e: unknown, f?: string) => (e as { message?: string })?.message ?? f ?? 'error',
}));

import SpeleoSignOutDialog from './SpeleoSignOutDialog';
import { useProjectStore } from '../../store/projectStore';
import { useSpeleoStore, type SpeleoLinkState } from '../../store/speleoStore';
import { useSpeleoSignOut, type SignOutProject, type SignOutSurvey } from '../../utils/speleoSignOut';
import type { SpeleoProjectSummary } from '../../types/ipc.generated';

const ME = 'diver@example.com';
const ok = { success: true, warnings: [], error: null, section_ids: [] };
const summary = (id: string): SpeleoProjectSummary => ({
  id, name: `Cave ${id}`, permission: 'READ_AND_WRITE', lock_holder: ME, type_tag: 'stalx', latest_commit_sha: null,
});
const entry = (id: string, holdsLock = true): SignOutProject => ({ summary: summary(id), holdsLock, lastEditAt: null });
const link = (o: Partial<SpeleoLinkState> = {}): SpeleoLinkState => ({
  permission: 'READ_AND_WRITE', editState: 'editing', lockHolder: ME, lockedByOther: false,
  hasUnpushedEdits: true, unwound: false, undoMode: 'full', remoteState: 'up_to_date',
  noAccess: false, serverError: null, ...o,
});

let closeProject: ReturnType<typeof vi.fn>;
let released: string[];

/** Open the dialog the way `guardSpeleoSignOut` does; resolves with its answer. */
function show(survey: SignOutSurvey | null, kind: 'signOut' | 'switch' = 'signOut'): Promise<boolean> {
  const answer = new Promise<boolean>((resolve) => {
    useSpeleoSignOut.setState({ request: { id: Math.random(), kind, survey, settle: (go) => {
      useSpeleoSignOut.setState({ request: null });
      resolve(go);
    } } });
  });
  render(<SpeleoSignOutDialog />);
  return answer;
}

beforeEach(() => {
  released = [];
  doneMock.mockReset().mockImplementation(async () => {
    useSpeleoStore.setState({ link: link({ editState: 'read-only', hasUnpushedEdits: false }) });
    return { kind: 'released' };
  });
  openRemoteMock.mockReset().mockResolvedValue({ status: 'opened' });
  invokeIpcMock.mockReset().mockImplementation(async (command: string, args: { projectId: string }) => {
    if (command === 'speleodb_release_lock') released.push(args.projectId);
    if (command === 'speleodb_discard_cached_copy') return ok;
    if (command === 'speleodb_list_projects') return [];
    if (command === 'speleodb_local_project_states') return {};
    return null;
  });
  closeProject = vi.fn(async () => { useProjectStore.setState({ project: null }); return ok; });
  useProjectStore.setState({
    project: { name: 'Cave open', file_path: '/c/open/project.stalx' } as never,
    isDirty: false, closeProject, loadRecentProjects: vi.fn(async () => {}),
  } as never);
  useSpeleoStore.setState({
    session: { loggedIn: true, userEmail: ME, endpoint: 'https://sdb.example' },
    link: link(), remoteProjectId: 'open', banner: null,
  });
  useSpeleoSignOut.setState({ request: null });
});

describe('SpeleoSignOutDialog', () => {
  it('locks with nothing un-uploaded are listed as handed back, then released on Sign out', async () => {
    const answer = show({ openProject: null, releasable: [entry('a'), entry('b')], unuploaded: [] });
    expect(screen.getByTestId('speleodb-signout-releasable')).toHaveTextContent('Cave a');
    await userEvent.click(screen.getByTestId('speleodb-signout-go'));
    expect(await answer).toBe(true);
    expect(released).toEqual(['a', 'b']);
  });

  it('there is no "keep the lock" answer anywhere in a sign-out', () => {
    void show({ openProject: entry('open'), releasable: [], unuploaded: [entry('x')] });
    expect(screen.queryByText(/keep the lock/i)).toBeNull();
  });

  it('the open project must be uploaded or discarded before signing out; Upload runs the normal upload', async () => {
    const answer = show({ openProject: entry('open'), releasable: [entry('a')], unuploaded: [] });
    const go = screen.getByTestId('speleodb-signout-go');
    expect(go).toBeDisabled();
    await userEvent.click(screen.getByTestId('speleodb-signout-open-upload'));
    await userEvent.type(screen.getByTestId('speleodb-signout-message'), 'Surveyed the sump');
    await userEvent.click(screen.getByTestId('speleodb-signout-open-upload-confirm'));
    expect(await screen.findByTestId('speleodb-signout-open-uploaded')).toBeVisible();
    expect(doneMock).toHaveBeenCalledWith('Surveyed the sump', expect.anything());
    await waitFor(() => expect(go).toBeEnabled());
    await userEvent.click(go);
    expect(await answer).toBe(true);
    // The upload already handed the open project back; only the others are released.
    expect(released).toEqual(['a']);
  });

  it('a failed upload keeps the sign-out waiting, with the failure on screen', async () => {
    doneMock.mockImplementation(async () => {
      useSpeleoStore.getState().raisePushFailedBanner({ message: 'Synthetic offline', origin: 'done', pushMessage: 'm' });
      return null;
    });
    void show({ openProject: entry('open'), releasable: [], unuploaded: [] });
    await userEvent.click(screen.getByTestId('speleodb-signout-open-upload'));
    await userEvent.type(screen.getByTestId('speleodb-signout-message'), 'm');
    await userEvent.click(screen.getByTestId('speleodb-signout-open-upload-confirm'));
    expect(await screen.findByTestId('speleodb-push-failure-inline')).toHaveTextContent('Synthetic offline');
    expect(screen.getByTestId('speleodb-signout-go')).toBeDisabled();
  });

  it('discarding the open project takes a "lost forever" confirmation, then the discarding close', async () => {
    void show({ openProject: entry('open'), releasable: [], unuploaded: [] });
    await userEvent.click(screen.getByTestId('speleodb-signout-open-discard'));
    expect(closeProject).not.toHaveBeenCalled();
    expect(screen.getByTestId('speleodb-signout-open-discard-body')).toHaveTextContent('lost forever');
    await userEvent.click(screen.getByTestId('speleodb-signout-open-discard-confirm'));
    expect(await screen.findByTestId('speleodb-signout-open-discarded')).toBeVisible();
    expect(closeProject).toHaveBeenCalledWith({ discardLocal: true });
    expect(screen.getByTestId('speleodb-signout-go')).toBeEnabled();
  });

  it('another project with changes: Discard (confirmed) removes its copy, and its lock is released on sign-out', async () => {
    const answer = show({ openProject: null, releasable: [], unuploaded: [entry('x'), entry('y', false)] });
    const go = screen.getByTestId('speleodb-signout-go');
    expect(go).toBeDisabled();
    for (const id of ['x', 'y']) {
      await userEvent.click(screen.getByTestId(`speleodb-signout-row-${id}-discard`));
      await userEvent.click(screen.getByTestId(`speleodb-signout-row-${id}-discard-confirm`));
      expect(await screen.findByTestId(`speleodb-signout-row-${id}-discarded`)).toBeVisible();
    }
    expect(invokeIpcMock).toHaveBeenCalledWith('speleodb_discard_cached_copy', { projectId: 'x' }, expect.anything());
    expect(invokeIpcMock).toHaveBeenCalledWith('speleodb_discard_cached_copy', { projectId: 'y' }, expect.anything());
    await userEvent.click(go);
    expect(await answer).toBe(true);
    expect(released).toEqual(['x']);
  });

  it('"Open to upload" cancels the sign-out and opens that project', async () => {
    const answer = show({ openProject: null, releasable: [entry('a')], unuploaded: [entry('x')] });
    await userEvent.click(screen.getByTestId('speleodb-signout-row-x-open'));
    expect(await answer).toBe(false);
    expect(openRemoteMock).toHaveBeenCalledWith(summary('x'));
    expect(released).toEqual([]);
  });

  it('a release that fails is reported; Try again retries only what failed', async () => {
    let failB = true;
    invokeIpcMock.mockImplementation(async (command: string, args: { projectId: string }) => {
      if (command === 'speleodb_release_lock') {
        if (args.projectId === 'b' && failB) throw new Error('Synthetic offline');
        released.push(args.projectId);
      }
      return null;
    });
    const answer = show({ openProject: null, releasable: [entry('a'), entry('b')], unuploaded: [] });
    await userEvent.click(screen.getByTestId('speleodb-signout-go'));
    const failed = await screen.findByTestId('speleodb-signout-release-failed');
    expect(failed).toHaveTextContent('Cave b');
    expect(failed).not.toHaveTextContent('Cave a');
    expect(failed).toHaveTextContent('until you sign in again');
    failB = false;
    await userEvent.click(screen.getByTestId('speleodb-signout-retry'));
    expect(await answer).toBe(true);
    expect(released).toEqual(['a', 'b']);
  });

  it('"Sign out anyway" after a failed release goes ahead, and Cancel does not', async () => {
    invokeIpcMock.mockImplementation(async (command: string) => {
      if (command === 'speleodb_release_lock') throw new Error('Synthetic offline');
      return null;
    });
    const answer = show({ openProject: null, releasable: [entry('a')], unuploaded: [] });
    await userEvent.click(screen.getByTestId('speleodb-signout-go'));
    await screen.findByTestId('speleodb-signout-release-failed');
    await userEvent.click(screen.getByTestId('speleodb-signout-anyway'));
    expect(await answer).toBe(true);
  });

  it('when SpeleoDB could not be checked: Try again re-checks, and signs out if nothing is held', async () => {
    const answer = show(null);
    expect(screen.getByTestId('speleodb-signout-check-failed')).toBeVisible();
    await userEvent.click(screen.getByTestId('speleodb-signout-retry'));
    expect(await answer).toBe(true);
    expect(invokeIpcMock).toHaveBeenCalledWith('speleodb_list_projects', undefined, expect.anything());
  });

  it('Cancel aborts the sign-out and releases nothing', async () => {
    const answer = show({ openProject: null, releasable: [entry('a')], unuploaded: [] }, 'switch');
    expect(screen.getByTestId('speleodb-signout-go')).toHaveTextContent('Switch account');
    await userEvent.click(screen.getByTestId('speleodb-signout-cancel'));
    expect(await answer).toBe(false);
    expect(released).toEqual([]);
  });
});
