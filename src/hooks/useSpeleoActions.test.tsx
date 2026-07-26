/**
 * Unit test - the SpeleoDB push/unlock verbs flush the survey to disk so the
 * projectStore's `isDirty` flag clears immediately.
 *
 * Regression guard: a confirmed push/unlock already persists the survey to disk
 * (the backend's speleodb_upload runs save_project before the upload), but the FE
 * `isDirty` flag is a separate concept. Left alone it only cleared on the 30s
 * autosave debounce, so exiting in that window fired a false "Unsaved Changes"
 * prompt for edits that were already on disk (and pushed to SpeleoDB). The verbs
 * now re-flush from the FE (saveProject) on the confirmed-success paths only.
 *
 * `.tsx` so this runs in the jsdom tier (renderHook).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

const invokeIpcMock = vi.hoisted(() => vi.fn());
vi.mock('../utils/ipc', () => ({
  invokeIpc: invokeIpcMock,
  // The one-arg call (humanizeSpeleoError) must still yield a string.
  getErrorMessage: (_e: unknown, f?: string) => f ?? 'mock error',
}));

import { useSpeleoActions } from './useSpeleoActions';
import { useProjectStore } from '../store/projectStore';
import { useSpeleoStore } from '../store/speleoStore';
import { useUIStore } from '../store/uiStore';

let saveProjectMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  invokeIpcMock.mockReset();
  saveProjectMock = vi.fn(async () => ({ success: true }));
  // A georeferenced zero datum keeps noteNoAnchorIfNeeded quiet on the push paths.
  useProjectStore.setState({
    project: { zero_datums: [{}] } as never,
    saveProject: saveProjectMock,
  });
  useSpeleoStore.setState({
    busy: false,
    setBusy: vi.fn(),
    applyDone: vi.fn(),
    applyPush: vi.fn(),
    bumpPoll: vi.fn(),
    clearSession: vi.fn(),
    raiseNoAnchorBanner: vi.fn(),
  });
  useUIStore.setState({ showToast: vi.fn() });
});

describe('useSpeleoActions - flush to disk after a confirmed push/unlock', () => {
  it('unlock (done → released) saves the project to disk (quiet autosave)', async () => {
    invokeIpcMock.mockResolvedValue({ kind: 'released' });
    const { result } = renderHook(() => useSpeleoActions());

    await act(async () => {
      await result.current.done();
    });

    expect(saveProjectMock).toHaveBeenCalledWith(undefined, true);
  });

  it('push (→ pushed) saves the project to disk (quiet autosave)', async () => {
    invokeIpcMock.mockResolvedValue({ kind: 'pushed' });
    const { result } = renderHook(() => useSpeleoActions());

    await act(async () => {
      await result.current.push();
    });

    expect(saveProjectMock).toHaveBeenCalledWith(undefined, true);
  });

  it('does NOT flush on an unconfirmed push (no false-clean local state)', async () => {
    invokeIpcMock.mockResolvedValue({ kind: 'push_unconfirmed' });
    const { result } = renderHook(() => useSpeleoActions());

    await act(async () => {
      await result.current.done();
    });

    expect(saveProjectMock).not.toHaveBeenCalled();
  });

  it('does NOT flush on a divergence result', async () => {
    invokeIpcMock.mockResolvedValue({ kind: 'divergence_needed' });
    const { result } = renderHook(() => useSpeleoActions());

    await act(async () => {
      await result.current.push();
    });

    expect(saveProjectMock).not.toHaveBeenCalled();
  });

  it('a failed flush does not surface as a push failure (best-effort, stays quiet)', async () => {
    invokeIpcMock.mockResolvedValue({ kind: 'released' });
    saveProjectMock.mockRejectedValue(new Error('disk full'));
    const showToast = vi.fn();
    useUIStore.setState({ showToast });
    const { result } = renderHook(() => useSpeleoActions());

    let outcome: unknown;
    await act(async () => {
      outcome = await result.current.done();
    });

    // The unlock still reports success and no error toast is raised - the flush
    // is best-effort and isDirty simply stays set (safe: the push already
    // persisted the same edits).
    expect(outcome).toEqual({ kind: 'released' });
    expect(showToast).not.toHaveBeenCalledWith(expect.anything(), 'speleodb-action-error', 'error');
  });
});

/**
 * #260 - a failed push/unlock keeps BOTH surfaces: the immediate error toast
 * (which auto-clears) and the durable `push_failed` banner carrying the same
 * humanized line plus the verb/message its Retry replays.
 */
describe('useSpeleoActions - a failed push/unlock raises the persistent banner (#260)', () => {
  beforeEach(() => {
    // Use the REAL banner reducers (the outer beforeEach only stubs the apply* verbs).
    useSpeleoStore.setState({ banner: null });
  });

  it('push failure raises push_failed with the push origin + message, and still toasts', async () => {
    const showToast = vi.fn();
    useUIStore.setState({ showToast });
    invokeIpcMock.mockRejectedValue(new Error('offline'));
    const { result } = renderHook(() => useSpeleoActions());

    await act(async () => {
      await result.current.push('my message');
    });

    expect(useSpeleoStore.getState().banner).toEqual({
      kind: 'push_failed',
      message: expect.any(String),
      origin: 'push',
      pushMessage: 'my message',
    });
    expect(showToast).toHaveBeenCalledWith(expect.any(String), 'speleodb-action-error', 'error');
  });

  it('done failure raises push_failed with the done origin', async () => {
    invokeIpcMock.mockRejectedValue(new Error('offline'));
    const { result } = renderHook(() => useSpeleoActions());

    await act(async () => {
      await result.current.done(null);
    });

    expect(useSpeleoStore.getState().banner).toMatchObject({
      kind: 'push_failed',
      origin: 'done',
      pushMessage: null,
    });
  });

  it('a transport failure reaches the banner humanized, not as a raw errno (#270)', async () => {
    // What the user actually hit: the host blackholed at the routing level, so the
    // backend surfaced EINVAL. The DTO's typed `transport` cause is what the
    // humanizer keys off; the raw text must not reach the user.
    useSpeleoStore.setState({
      session: {
        loggedIn: true,
        userEmail: 'me@example.com',
        endpoint: 'https://cave.example.internal:8443/',
        keychainBacked: true,
      },
    });
    invokeIpcMock.mockRejectedValue({
      message: 'Network error talking to SpeleoDB: Invalid argument',
      action: 'Retry',
      status: null,
      transport: 'Unknown',
    });
    const { result } = renderHook(() => useSpeleoActions());

    await act(async () => {
      await result.current.done('wrap up');
    });

    const banner = useSpeleoStore.getState().banner as { kind: string; message: string };
    expect(banner.kind).toBe('push_failed');
    expect(banner.message).not.toContain('Invalid argument');
    expect(banner.message).toContain('https://cave.example.internal:8443/');
  });

  it('a retry clears the stale failure banner before the new attempt lands', async () => {
    useSpeleoStore.setState({
      banner: { kind: 'push_failed', message: 'old', origin: 'push', pushMessage: null },
    });
    invokeIpcMock.mockResolvedValue({ kind: 'divergence_needed' });
    const { result } = renderHook(() => useSpeleoActions());

    await act(async () => {
      await result.current.push();
    });

    // Even on a non-success outcome that leaves the banner slot alone, the previous
    // failure must not linger (it described an attempt that has been superseded).
    expect(useSpeleoStore.getState().banner).toBeNull();
  });
});

/**
 * #260 - "Changes uploaded and lock released." used to fire even when nothing was
 * uploaded. The remote dirty bit (`link.hasUnpushedEdits`) captured BEFORE the call
 * picks the wording.
 */
describe('useSpeleoActions - the release toast reflects whether anything was uploaded (#260)', () => {
  const seedLink = (hasUnpushedEdits: boolean) =>
    useSpeleoStore.setState({
      link: {
        permission: 'READ_AND_WRITE',
        editState: 'editing',
        lockHolder: null,
        lockedByOther: false,
        hasUnpushedEdits,
        forceEditing: false,
        forceEditAllowed: false,
        remoteState: 'up_to_date',
        noAccess: false,
        serverError: null,
      },
    });

  it('says the changes were uploaded when there were unpushed edits', async () => {
    const showToast = vi.fn();
    useUIStore.setState({ showToast });
    seedLink(true);
    invokeIpcMock.mockResolvedValue({ kind: 'released' });
    const { result } = renderHook(() => useSpeleoActions());

    await act(async () => {
      await result.current.done();
    });

    expect(showToast).toHaveBeenCalledWith(
      'Changes uploaded and lock released.',
      'speleodb-released',
      'success',
    );
  });

  it('says nothing was uploaded when the session had no unpushed edits', async () => {
    const showToast = vi.fn();
    useUIStore.setState({ showToast });
    seedLink(false);
    invokeIpcMock.mockResolvedValue({ kind: 'released' });
    const { result } = renderHook(() => useSpeleoActions());

    await act(async () => {
      await result.current.done();
    });

    expect(showToast).toHaveBeenCalledWith(
      'Lock released. Nothing to upload.',
      'speleodb-released',
      'success',
    );
  });
});

/**
 * The toast KIND is the whole point of the accent rework: before it, a
 * successful push and a failed one rendered identically, so a landed upload gave
 * no perceptible confirmation. These pin the semantics at the source.
 */
describe('useSpeleoActions - toast kinds', () => {
  it('a landed push asks for a success toast', async () => {
    const showToast = vi.fn();
    useUIStore.setState({ showToast });
    invokeIpcMock.mockResolvedValue({ kind: 'pushed' });
    const { result } = renderHook(() => useSpeleoActions());

    await act(async () => {
      await result.current.push('m');
    });

    expect(showToast).toHaveBeenCalledWith(expect.any(String), 'speleodb-pushed', 'success');
  });

  it('a released lock asks for a success toast', async () => {
    const showToast = vi.fn();
    useUIStore.setState({ showToast });
    invokeIpcMock.mockResolvedValue({ kind: 'released' });
    const { result } = renderHook(() => useSpeleoActions());

    await act(async () => {
      await result.current.done();
    });

    expect(showToast).toHaveBeenCalledWith(expect.any(String), 'speleodb-released', 'success');
  });

  it('a failed unlock asks for an error toast (and still raises the #260 banner)', async () => {
    const showToast = vi.fn();
    useUIStore.setState({ showToast });
    invokeIpcMock.mockRejectedValue(new Error('offline'));
    const { result } = renderHook(() => useSpeleoActions());

    await act(async () => {
      await result.current.done();
    });

    expect(showToast).toHaveBeenCalledWith(expect.any(String), 'speleodb-action-error', 'error');
    expect(useSpeleoStore.getState().banner).toMatchObject({ kind: 'push_failed' });
  });
});

describe('useSpeleoActions - fast-forward resets the on-screen tree (#218)', () => {
  it('update (→ fast_forwarded) refreshes geometry + link state', async () => {
    // The backend FF reload reopens the SAME path, so loadProject short-circuits on
    // the "already open" guard; without the explicit refresh the old tree would stay
    // on screen (Update appearing not to reset to tip).
    const loadProject = vi.fn(async () => ({ success: true }));
    const refreshProjectState = vi.fn(async () => {});
    const refreshLinkStatus = vi.fn(async () => {});
    useProjectStore.setState({ loadProject, refreshProjectState, checkProjectIntegrity: vi.fn(async () => []) });
    useSpeleoStore.setState({ applyUpdate: vi.fn(), refreshLinkStatus });
    invokeIpcMock.mockResolvedValue({ kind: 'fast_forwarded', local_path: '/x.stalx' });
    const { result } = renderHook(() => useSpeleoActions());

    await act(async () => {
      await result.current.update();
    });

    expect(loadProject).toHaveBeenCalledWith('/x.stalx');
    expect(refreshProjectState).toHaveBeenCalled();
    expect(refreshLinkStatus).toHaveBeenCalled();
  });

  it('startEditing (→ fast_forwarded) refreshes geometry + link state', async () => {
    // The startEditing FF arm has the same in-place-reopen refresh as update; guard it
    // too (deleting its refresh calls would leave a stale tree after a Start-editing FF).
    const loadProject = vi.fn(async () => ({ success: true }));
    const refreshProjectState = vi.fn(async () => {});
    const refreshLinkStatus = vi.fn(async () => {});
    useProjectStore.setState({ loadProject, refreshProjectState, checkProjectIntegrity: vi.fn(async () => []) });
    useSpeleoStore.setState({ applyStartEditing: vi.fn(), refreshLinkStatus });
    invokeIpcMock.mockResolvedValue({ kind: 'fast_forwarded', local_path: '/y.stalx' });
    const { result } = renderHook(() => useSpeleoActions());

    await act(async () => {
      await result.current.startEditing();
    });

    expect(loadProject).toHaveBeenCalledWith('/y.stalx');
    expect(refreshProjectState).toHaveBeenCalled();
    expect(refreshLinkStatus).toHaveBeenCalled();
  });
});

// #270: `speleodb_push_only` / `speleodb_done` answer `not_editing` when the edit
// gate was already closed - nothing was uploaded and nothing was released. Reported
// as Pushed/Released, that produced a green "Changes pushed to SpeleoDB." toast, a
// disk flush and a cleared dirty bit for work that never left this computer. It is
// reachable in normal use: a 401 auto-drop closes the gate but keeps the dirty bit,
// and the push-failure banner's Retry re-issues the verb from exactly that state.
describe('useSpeleoActions - a no-op push/release is reported honestly (#270)', () => {
  it('push (→ not_editing) warns instead of claiming success, and does not flush', async () => {
    const showToast = vi.fn();
    useUIStore.setState({ showToast });
    invokeIpcMock.mockResolvedValue({ kind: 'not_editing' });
    const { result } = renderHook(() => useSpeleoActions());

    await act(async () => {
      await result.current.push('m');
    });

    expect(showToast).toHaveBeenCalledWith(expect.any(String), 'speleodb-not-editing', 'warning');
    expect(showToast).not.toHaveBeenCalledWith(expect.any(String), 'speleodb-pushed', 'success');
    // The flush exists to clear `isDirty` after a CONFIRMED upload; nothing was
    // uploaded, so a false-clean local state must not be manufactured.
    expect(saveProjectMock).not.toHaveBeenCalled();
  });

  it('done (→ not_editing) warns, and the caller sees a kind that is not "released"', async () => {
    const showToast = vi.fn();
    useUIStore.setState({ showToast });
    invokeIpcMock.mockResolvedValue({ kind: 'not_editing' });
    const { result } = renderHook(() => useSpeleoActions());

    let resolved: { kind: string } | null = null;
    await act(async () => {
      resolved = (await result.current.done()) as { kind: string } | null;
    });

    expect(showToast).toHaveBeenCalledWith(expect.any(String), 'speleodb-not-editing', 'warning');
    expect(showToast).not.toHaveBeenCalledWith(expect.any(String), 'speleodb-released', 'success');
    // The close/quit dialogs only leave on `released`, so they correctly stay open.
    expect(resolved).toEqual({ kind: 'not_editing' });
    expect(saveProjectMock).not.toHaveBeenCalled();
  });
});

// #270: `startEditing(): Promise<boolean>` had all four known variants handled but no
// exhaustiveness guard, so a fifth backend variant fell through to `return true` -
// "we hold the lock". `HeldLockResumeDialog` acts on that by calling
// `clearHeldLocks()`, discarding every remaining lock with no way to re-raise the
// prompt until the next login scan.
describe('useSpeleoActions - startEditing falls to the REFUSING answer (#270)', () => {
  it('answers false for a variant it does not recognise', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    useSpeleoStore.setState({ applyStartEditing: vi.fn() });
    invokeIpcMock.mockResolvedValue({ kind: 'something_new' });
    const { result } = renderHook(() => useSpeleoActions());

    let held: boolean | undefined;
    await act(async () => {
      held = await result.current.startEditing();
    });

    expect(held).toBe(false);
    warn.mockRestore();
  });

  it('still answers true when we really do hold the lock', async () => {
    useSpeleoStore.setState({ applyStartEditing: vi.fn() });
    invokeIpcMock.mockResolvedValue({ kind: 'editing' });
    const { result } = renderHook(() => useSpeleoActions());

    let held: boolean | undefined;
    await act(async () => {
      held = await result.current.startEditing();
    });

    expect(held).toBe(true);
  });
});
