/**
 * #270 - the `ALREADY_OPEN` short circuit renders a project, so it owes the same
 * duty every other rendered-project path pays: RESOLVE the SpeleoDB edit gate.
 *
 * The success path does that synchronously (`syncProjectLink(result.isRemote, path)`),
 * and so does `createProject`. This branch did neither - it flipped the view, reset
 * loading, refreshed undo, and reported success with whatever link the caller had
 * seeded on the way in.
 *
 * That is reachable, not latent: "Open from SpeleoDB" sits in the IN-PROJECT
 * hamburger whenever signed in, so re-opening the currently-open project is an
 * ordinary mis-step. The backend refuses it over the unpushed local edits, the user
 * picks "Keep the local copy", and the old code then overwrote the live link with a
 * pessimistic read-only seed which this branch preserved verbatim - a read-only
 * survey UI for a project we hold the lock on, plus a disarmed quit guard, healing
 * only on the next status poll (Survey mode only, 30 s to a configurable 24 h).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useProjectStore } from '../projectStore';
import { useUIStore } from '../uiStore';
import { useSpeleoStore, type SpeleoLinkState } from '../speleoStore';

const invokeIpcMock = vi.hoisted(() => vi.fn());
const loadBinaryMock = vi.hoisted(() => vi.fn());

vi.mock('../../utils/ipc', () => ({ invokeIpc: invokeIpcMock }));
vi.mock('../../utils/loadProjectBinary', () => ({ loadProjectFullBinary: loadBinaryMock }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn().mockResolvedValue(undefined) }));

/** An editing link for a project we hold the lock on, with work not yet pushed. */
const EDITING_LINK: SpeleoLinkState = {
  permission: 'READ_AND_WRITE',
  editState: 'editing',
  lockHolder: 'me@example.com',
  lockedByOther: false,
  hasUnpushedEdits: true,
  forceEditing: false,
  forceEditAllowed: false,
  remoteState: 'up_to_date',
  noAccess: false,
  serverError: null,
};

let refreshLinkStatusMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  // The backend's "this project is already open" refusal, in the shape
  // `parseLoadError` reads (`code`).
  loadBinaryMock.mockRejectedValue({ code: 'ALREADY_OPEN', message: 'project already open' });
  invokeIpcMock.mockImplementation(async (command: string) => {
    if (command === 'list_recent_projects') return [];
    return undefined;
  });

  refreshLinkStatusMock = vi.fn(async () => {});
  useSpeleoStore.setState({
    link: { ...EDITING_LINK },
    linkPath: '/cache/p1.stalx',
    projectLinkKind: 'remote',
    refreshLinkStatus: refreshLinkStatusMock,
  });
  useUIStore.setState({ appMode: 'survey' });
  useProjectStore.setState({
    project: null,
    isDirty: false,
    loading: { loadingId: 0n, clientOpId: 0, isLoading: false, overallProgress: 0 },
    refreshUndoState: vi.fn(async () => {}),
  });
});

describe('loadProject ALREADY_OPEN re-resolves the SpeleoDB gate (#270)', () => {
  it('reports success, shows the project, and asks the backend to re-resolve the link', async () => {
    const result = await useProjectStore.getState().loadProject('/cache/p1.stalx');

    expect(result.success).toBe(true);
    expect(useUIStore.getState().view).toBe('single');
    // The whole point: this branch no longer renders a project with an unexamined
    // edit gate. Unawaited (the status call does blocking HTTP), so only the call
    // itself is pinned here.
    expect(refreshLinkStatusMock).toHaveBeenCalled();
  });

  it('does not silently downgrade a lock we hold while the status call is pending', async () => {
    // The refinement must not itself be a regression: nothing in this branch may
    // touch the live link, so the survey UI stays editable and the quit guard stays
    // armed even if the status call never answers (offline).
    refreshLinkStatusMock.mockImplementation(() => new Promise<void>(() => {}));

    await useProjectStore.getState().loadProject('/cache/p1.stalx');

    const link = useSpeleoStore.getState().link;
    expect(link?.editState).toBe('editing');
    expect(link?.hasUnpushedEdits).toBe(true);
  });
});
