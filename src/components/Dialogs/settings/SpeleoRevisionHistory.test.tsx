/**
 * Component test (#218) - the Project Settings revision-history section. Fetches
 * speleodb_get_revisions on mount, marks the current HEAD (not restorable), and
 * gates the Restore button on holding the lock.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const invokeIpcMock = vi.hoisted(() => vi.fn());
vi.mock('../../../utils/ipc', () => ({
  invokeIpc: invokeIpcMock,
  getErrorMessage: (_e: unknown, f?: string) => f ?? 'error',
}));

import { SpeleoRevisionHistory } from './SpeleoRevisionHistory';
import { useSpeleoStore, type SpeleoLinkState } from '../../../store/speleoStore';
import { useProjectStore } from '../../../store/projectStore';
import { useUIStore } from '../../../store/uiStore';
import type { SpeleoRevision } from '../../../types/ipc.generated';

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

const REVISIONS: SpeleoRevision[] = [
  {
    id: 'aaaaaaaa1111',
    parent_ids: ['bbbbbbbb2222'],
    author_email: 'me@x',
    authored_date: '2026-07-03T10:00:00+00:00',
    message: 'second',
  },
  {
    id: 'bbbbbbbb2222',
    parent_ids: [],
    author_email: 'you@x',
    authored_date: null,
    message: 'root',
  },
];

let openDialogMock: ReturnType<typeof vi.fn>;
let showToastMock: ReturnType<typeof vi.fn>;

const seed = (editState: SpeleoLinkState['editState']) => {
  useSpeleoStore.setState({ remoteProjectId: 'p1', link: { ...LINK, editState } });
};

beforeEach(() => {
  invokeIpcMock.mockReset();
  invokeIpcMock.mockResolvedValue(REVISIONS);
  openDialogMock = vi.fn();
  showToastMock = vi.fn();
  useSpeleoStore.setState({
    remoteProjectId: null,
    link: null,
    refreshLinkStatus: vi.fn(async () => {}),
  });
  useProjectStore.setState({
    refreshProjectState: vi.fn(async () => {}),
    checkProjectIntegrity: vi.fn(async () => []),
  });
  useUIStore.setState({ openDialog: openDialogMock, showToast: showToastMock, setView: vi.fn() });
});

describe('SpeleoRevisionHistory (#218)', () => {
  it('fetches the chain, marks the current HEAD, and offers Restore on past revisions', async () => {
    seed('editing');
    render(<SpeleoRevisionHistory />);

    await waitFor(() => expect(screen.getByTestId('speleodb-revisions-list')).toBeInTheDocument());
    const call = invokeIpcMock.mock.calls.find((c) => c[0] === 'speleodb_get_revisions');
    expect(call?.[1]).toEqual({ projectId: 'p1' });

    // Newest-first: index 0 is the current server HEAD (marked, no Restore); the
    // older commit is restorable.
    expect(screen.getByTestId('speleodb-revision-current-aaaaaaaa1111')).toBeInTheDocument();
    expect(screen.queryByTestId('speleodb-revision-restore-aaaaaaaa1111')).not.toBeInTheDocument();
    expect(screen.getByTestId('speleodb-revision-restore-bbbbbbbb2222')).toBeEnabled();
    // While editing, the "lock first" note is not shown.
    expect(screen.queryByTestId('speleodb-revisions-lock-hint')).not.toBeInTheDocument();
  });

  it('offers View (not Restore) and shows the lock-first note when not editing', async () => {
    seed('read-only');
    render(<SpeleoRevisionHistory />);
    await waitFor(() => expect(screen.getByTestId('speleodb-revisions-list')).toBeInTheDocument());
    // Read-only: the past revision gets an enabled View, not a Restore.
    expect(screen.queryByTestId('speleodb-revision-restore-bbbbbbbb2222')).not.toBeInTheDocument();
    expect(screen.getByTestId('speleodb-revision-view-bbbbbbbb2222')).toBeEnabled();
    expect(screen.getByTestId('speleodb-revisions-lock-hint')).toBeInTheDocument();
  });

  it('View checks the revision out read-only (restore=false)', async () => {
    seed('read-only');
    render(<SpeleoRevisionHistory />);
    await waitFor(() => expect(screen.getByTestId('speleodb-revisions-list')).toBeInTheDocument());

    await userEvent.click(screen.getByTestId('speleodb-revision-view-bbbbbbbb2222'));
    await waitFor(() =>
      expect(
        invokeIpcMock.mock.calls.some((c) => c[0] === 'speleodb_restore_revision'),
      ).toBe(true),
    );
    const call = invokeIpcMock.mock.calls.find((c) => c[0] === 'speleodb_restore_revision');
    expect(call?.[1]).toMatchObject({ projectId: 'p1', hexsha: 'bbbbbbbb2222', restore: false });
  });

  it('opens the restore confirm with the chosen revision', async () => {
    seed('editing');
    render(<SpeleoRevisionHistory />);
    await waitFor(() => expect(screen.getByTestId('speleodb-revisions-list')).toBeInTheDocument());

    await userEvent.click(screen.getByTestId('speleodb-revision-restore-bbbbbbbb2222'));
    expect(openDialogMock).toHaveBeenCalledWith(
      'speleodb-restore',
      expect.objectContaining({ projectId: 'p1', hexsha: 'bbbbbbbb2222' }),
    );
  });

  it('renders nothing for a local project (no open remote)', () => {
    useSpeleoStore.setState({ remoteProjectId: null, link: null });
    const { container } = render(<SpeleoRevisionHistory />);
    expect(container).toBeEmptyDOMElement();
    expect(invokeIpcMock).not.toHaveBeenCalled();
  });

  it('shows the empty state when the project has no revisions', async () => {
    invokeIpcMock.mockResolvedValue([]);
    seed('read-only');
    render(<SpeleoRevisionHistory />);
    await waitFor(() =>
      expect(screen.getByTestId('speleodb-revisions-empty')).toBeInTheDocument(),
    );
    expect(screen.queryByTestId('speleodb-revisions-list')).not.toBeInTheDocument();
  });

  it('shows the error state when the fetch fails', async () => {
    invokeIpcMock.mockRejectedValue({ message: 'offline' });
    seed('read-only');
    render(<SpeleoRevisionHistory />);
    await waitFor(() =>
      expect(screen.getByTestId('speleodb-revisions-error')).toBeInTheDocument(),
    );
    expect(screen.queryByTestId('speleodb-revisions-list')).not.toBeInTheDocument();
  });

  it('marks a merge commit (more than one parent)', async () => {
    invokeIpcMock.mockResolvedValue([
      { id: 'aaaaaaaa1111', parent_ids: ['b', 'c'], author_email: 'me@x', authored_date: null, message: 'merge' },
      { id: 'bbbbbbbb2222', parent_ids: [], author_email: 'you@x', authored_date: null, message: 'root' },
    ] satisfies SpeleoRevision[]);
    seed('read-only');
    render(<SpeleoRevisionHistory />);
    await waitFor(() => expect(screen.getByTestId('speleodb-revisions-list')).toBeInTheDocument());
    expect(screen.getByTestId('speleodb-revision-merge-aaaaaaaa1111')).toBeInTheDocument();
  });

  it('offers Revert alongside View for a read-only project with write permission', async () => {
    seed('read-only');
    render(<SpeleoRevisionHistory />);
    await waitFor(() => expect(screen.getByTestId('speleodb-revisions-list')).toBeInTheDocument());
    expect(screen.getByTestId('speleodb-revision-revert-bbbbbbbb2222')).toBeEnabled();
    // Never on the current HEAD - reverting to where you already are is a no-op.
    expect(screen.queryByTestId('speleodb-revision-revert-aaaaaaaa1111')).not.toBeInTheDocument();
  });

  it('opens the revert confirm with the chosen revision and a way back', async () => {
    seed('read-only');
    render(<SpeleoRevisionHistory />);
    await waitFor(() => expect(screen.getByTestId('speleodb-revisions-list')).toBeInTheDocument());

    await userEvent.click(screen.getByTestId('speleodb-revision-revert-bbbbbbbb2222'));
    expect(openDialogMock).toHaveBeenCalledWith(
      'speleodb-revert',
      expect.objectContaining({
        projectId: 'p1',
        hexsha: 'bbbbbbbb2222',
        returnTo: 'speleodb-project',
      }),
    );
  });

  it('hides Revert for a known view-only permission', async () => {
    // A revert takes the write lock and uploads, so a WEB_VIEWER/READ_ONLY grant can
    // only be refused by the server - don't offer it.
    useSpeleoStore.setState({
      remoteProjectId: 'p1',
      link: { ...LINK, editState: 'read-only', permission: 'READ_ONLY' },
    });
    render(<SpeleoRevisionHistory />);
    await waitFor(() => expect(screen.getByTestId('speleodb-revisions-list')).toBeInTheDocument());
    expect(screen.queryByTestId('speleodb-revision-revert-bbbbbbbb2222')).not.toBeInTheDocument();
  });

  it('offers Revert for an UNKNOWN (null) permission', async () => {
    // Offline, so the grant is not known - treat it as potentially editable and let
    // the backend gate decide, the same way the status button does.
    useSpeleoStore.setState({
      remoteProjectId: 'p1',
      link: { ...LINK, editState: 'read-only', permission: null },
    });
    render(<SpeleoRevisionHistory />);
    await waitFor(() => expect(screen.getByTestId('speleodb-revisions-list')).toBeInTheDocument());
    expect(screen.getByTestId('speleodb-revision-revert-bbbbbbbb2222')).toBeEnabled();
  });

  it('offers Revert - and NOT View - when un-pushed edits block the read-only peek', async () => {
    // That state used to show no buttons at all. Revert is the route out of it: it
    // takes the lock for the user, with the armed discard as the explicit consent.
    useSpeleoStore.setState({
      remoteProjectId: 'p1',
      link: { ...LINK, editState: 'read-only', hasUnpushedEdits: true },
    });
    render(<SpeleoRevisionHistory />);
    await waitFor(() => expect(screen.getByTestId('speleodb-revisions-list')).toBeInTheDocument());
    expect(screen.getByTestId('speleodb-revisions-unpushed-hint')).toBeInTheDocument();
    expect(screen.queryByTestId('speleodb-revision-view-bbbbbbbb2222')).not.toBeInTheDocument();
    expect(screen.getByTestId('speleodb-revision-revert-bbbbbbbb2222')).toBeEnabled();
  });

  it('offers NEITHER View nor Restore nor Revert while force-editing (no lock), with a hint', async () => {
    // A force-editor holds unsaved, lock-less edits; swapping the tree would clobber
    // them, so the backend refuses both and the UI offers no action.
    useSpeleoStore.setState({
      remoteProjectId: 'p1',
      link: { ...LINK, editState: 'editing', forceEditing: true },
    });
    render(<SpeleoRevisionHistory />);
    await waitFor(() => expect(screen.getByTestId('speleodb-revisions-list')).toBeInTheDocument());
    expect(screen.queryByTestId('speleodb-revision-restore-bbbbbbbb2222')).not.toBeInTheDocument();
    expect(screen.queryByTestId('speleodb-revision-view-bbbbbbbb2222')).not.toBeInTheDocument();
    expect(screen.queryByTestId('speleodb-revision-revert-bbbbbbbb2222')).not.toBeInTheDocument();
    expect(screen.getByTestId('speleodb-revisions-forceedit-hint')).toBeInTheDocument();
    expect(screen.queryByTestId('speleodb-revisions-lock-hint')).not.toBeInTheDocument();
  });
});
