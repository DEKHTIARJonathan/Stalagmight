/**
 * Unit test — the SpeleoDB push/unlock verbs flush the survey to disk so the
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
  getErrorMessage: (_e: unknown, f: string) => f,
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

describe('useSpeleoActions — flush to disk after a confirmed push/unlock', () => {
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

    // The unlock still reports success and no error toast is raised — the flush
    // is best-effort and isDirty simply stays set (safe: the push already
    // persisted the same edits).
    expect(outcome).toEqual({ kind: 'released' });
    expect(showToast).not.toHaveBeenCalledWith(expect.anything(), 'speleodb-action-error');
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
