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
