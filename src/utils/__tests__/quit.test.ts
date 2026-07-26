/**
 * [#270] The exit guards.
 *
 * Two independent "you would lose work" conditions meet at quit time:
 *  - `projectStore.isDirty`            - unsaved to DISK;
 *  - `link.hasUnpushedEdits` + lock    - local edits NOT on the SpeleoDB server,
 *                                        which survive a save and a restart.
 * Before this, `quitApp` looked only at the first, so a saved-but-unpushed
 * project quit silently. These lock the guard, its ordering (SpeleoDB first, so
 * the prompt that can handle BOTH runs first and neither swallows the other) and
 * the one-shot confirmation that keeps the composed flow from looping.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const closeMock = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({ close: closeMock, destroy: vi.fn(async () => {}) }),
}));
vi.mock('../ipc', () => ({ invokeIpc: vi.fn(), getErrorMessage: (_e: unknown, f?: string) => f }));

import {
  quitApp,
  guardQuit,
  performQuit,
  consumeQuitConfirmation,
  resetQuitConfirmationForTests,
} from '../quit';
import { useProjectStore } from '../../store/projectStore';
import { useSpeleoStore, type SpeleoLinkState } from '../../store/speleoStore';
import { useUIStore } from '../../store/uiStore';

const link = (o: Partial<SpeleoLinkState> = {}): SpeleoLinkState => ({
  permission: 'READ_AND_WRITE',
  editState: 'editing',
  lockHolder: null,
  lockedByOther: false,
  hasUnpushedEdits: true,
  forceEditing: false,
  forceEditAllowed: false,
  remoteState: 'up_to_date',
  noAccess: false,
  serverError: null,
  ...o,
});

const openDialog = vi.fn();

beforeEach(() => {
  closeMock.mockReset();
  closeMock.mockResolvedValue(undefined);
  openDialog.mockReset();
  resetQuitConfirmationForTests();
  useProjectStore.setState({ project: { name: 'p' } as never, isDirty: false });
  useSpeleoStore.setState({ link: null });
  useUIStore.setState({ openDialog: openDialog as never, activeDialog: null, dialogData: {} });
});

describe('guardQuit', () => {
  it('lets a clean project quit immediately', () => {
    expect(guardQuit()).toBe(false);
    quitApp();
    expect(openDialog).not.toHaveBeenCalled();
    expect(closeMock).toHaveBeenCalledTimes(1);
  });

  it('quits immediately with no project open at all', () => {
    useProjectStore.setState({ project: null, isDirty: true });
    useSpeleoStore.setState({ link: link() });
    quitApp();
    expect(openDialog).not.toHaveBeenCalled();
    expect(closeMock).toHaveBeenCalledTimes(1);
  });

  it('blocks on unsaved-to-disk changes', () => {
    useProjectStore.setState({ isDirty: true });
    quitApp();
    expect(openDialog).toHaveBeenCalledWith('unsaved-changes', { pendingQuit: true });
    expect(closeMock).not.toHaveBeenCalled();
  });

  // The regression this file exists for: saved to disk, so the old guard passed.
  it('blocks on unpushed SpeleoDB edits even when the project is saved to disk', () => {
    useSpeleoStore.setState({ link: link() });
    quitApp();
    expect(openDialog).toHaveBeenCalledWith('speleodb-quit');
    expect(closeMock).not.toHaveBeenCalled();
  });

  it('does NOT block while holding the lock with nothing unpushed', () => {
    useSpeleoStore.setState({ link: link({ hasUnpushedEdits: false }) });
    quitApp();
    expect(openDialog).not.toHaveBeenCalled();
    expect(closeMock).toHaveBeenCalledTimes(1);
  });

  // The guard keys off the WORK AT RISK, not the lock: edits the server has never
  // seen are what quitting can strand, and whether we still hold the write lock
  // only changes which choices the dialog offers (it adapts to a lock-less state).
  it('blocks a force-edit session with unpushed edits - they are the most stranded of all', () => {
    // A force-editor edits WITHOUT the lock (#213), so there is nothing to
    // push/keep/release - which is exactly why walking away silently is wrong: the
    // edits cannot reach the server until a reconnect.
    useSpeleoStore.setState({ link: link({ forceEditing: true }) });
    quitApp();
    expect(openDialog).toHaveBeenCalledWith('speleodb-quit');
    expect(closeMock).not.toHaveBeenCalled();
  });

  it('blocks a read-only remote project that still has unpushed edits', () => {
    // How this is reached: `notifyReverifyDivergence()` drops to read-only while
    // KEEPING the unpushed edits, and any ReLogin error runs `clearSession()`,
    // which also drops to read-only. Requiring editState === 'editing' disarmed
    // the guard in precisely those states.
    useSpeleoStore.setState({ link: link({ editState: 'read-only' }) });
    quitApp();
    expect(openDialog).toHaveBeenCalledWith('speleodb-quit');
    expect(closeMock).not.toHaveBeenCalled();
  });

  it('does NOT block a read-only remote project with nothing unpushed', () => {
    useSpeleoStore.setState({
      link: link({ editState: 'read-only', hasUnpushedEdits: false }),
    });
    quitApp();
    expect(openDialog).not.toHaveBeenCalled();
    expect(closeMock).toHaveBeenCalledTimes(1);
  });

  it('uses the SpeleoDB prompt (not the disk one) when a force-edit session is also disk-dirty', () => {
    // The SpeleoDB prompt subsumes the disk one - it carries its own "save
    // locally" checkbox - so it must be the one that runs, or "Discard & Quit"
    // would walk straight past the unpushed edits.
    useProjectStore.setState({ isDirty: true });
    useSpeleoStore.setState({ link: link({ forceEditing: true }) });
    quitApp();
    expect(openDialog).toHaveBeenCalledWith('speleodb-quit');
    expect(closeMock).not.toHaveBeenCalled();
  });

  // Composition: BOTH dirty. The SpeleoDB prompt runs first because it is the only
  // one that also handles the disk side (its "Save changes locally" checkbox); the
  // reverse order would let "Discard & Quit" walk straight past the unpushed edits.
  it('runs the SpeleoDB prompt first when the project is both disk-dirty and unpushed', () => {
    useProjectStore.setState({ isDirty: true });
    useSpeleoStore.setState({ link: link() });
    quitApp();
    expect(openDialog).toHaveBeenCalledTimes(1);
    expect(openDialog).toHaveBeenCalledWith('speleodb-quit');
    expect(closeMock).not.toHaveBeenCalled();
  });
});

describe('the one-shot quit confirmation', () => {
  it('is armed by performQuit and consumed exactly once', () => {
    expect(consumeQuitConfirmation()).toBe(false);
    performQuit();
    expect(consumeQuitConfirmation()).toBe(true);
    expect(consumeQuitConfirmation()).toBe(false);
  });

  it('is NOT armed by a guarded quit that never reached performQuit', () => {
    useProjectStore.setState({ isDirty: true });
    quitApp();
    expect(consumeQuitConfirmation()).toBe(false);
  });

  // Terminates: the dialog's own action calls performQuit while the store is still
  // dirty/unpushed, and the close listener must NOT re-guard it into a loop.
  it('lets a dialog quit past a still-dirty store', async () => {
    useProjectStore.setState({ isDirty: true });
    useSpeleoStore.setState({ link: link() });
    performQuit();
    expect(closeMock).toHaveBeenCalledTimes(1);
    expect(consumeQuitConfirmation()).toBe(true);
  });

  it('un-arms itself when the window close is rejected, so the next X is guarded again', async () => {
    closeMock.mockRejectedValueOnce(new Error('capability denied'));
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    performQuit();
    await Promise.resolve();
    await Promise.resolve();
    expect(consumeQuitConfirmation()).toBe(false);
    err.mockRestore();
  });
});
