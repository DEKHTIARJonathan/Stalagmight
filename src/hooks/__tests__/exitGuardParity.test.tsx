// @vitest-environment jsdom
/**
 * [#270] The two exits must agree about which SpeleoDB state deserves a prompt.
 *
 * `guardQuit` was deliberately re-keyed onto the WORK AT RISK (`hasUnpushedEdits`)
 * because requiring `editState === 'editing'` disarmed it in exactly the states where
 * the work is most stranded - `notifyReverifyDivergence()` drops to read-only while
 * keeping the edits, and any `ReLogin` error runs `clearSession()`, which does too.
 * `useProject.handleCloseProject` was left on the old lock-only predicate, so closing
 * a saved-but-unpushed remote project after a token loss returned straight to the home
 * screen with no notice at all - while quitting the same project prompted.
 *
 * The matrix below is the contract. The ONE deliberate asymmetry is (lock held,
 * nothing unpushed): quit does not prompt, because the backend's exit-time release is
 * safe with nothing outstanding (aab5121d); close must, because the app keeps running
 * and the server mutex would be left stranded.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook } from '@testing-library/react';

vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({ close: vi.fn(async () => {}), destroy: vi.fn(async () => {}) }),
}));
vi.mock('../../utils/ipc', () => ({
  invokeIpc: vi.fn(),
  getErrorMessage: (_e: unknown, f?: string) => f ?? 'error',
}));

import { useProject } from '../useProject';
import { guardQuit, resetQuitConfirmationForTests } from '../../utils/quit';
import { useProjectStore } from '../../store/projectStore';
import { useSpeleoStore, type SpeleoLinkState } from '../../store/speleoStore';
import { useUIStore } from '../../store/uiStore';

const link = (o: Partial<SpeleoLinkState>): SpeleoLinkState => ({
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
  ...o,
});

let openDialog: ReturnType<typeof vi.fn>;
let closeProject: ReturnType<typeof vi.fn>;

beforeEach(() => {
  openDialog = vi.fn();
  closeProject = vi.fn(async () => ({ success: true }));
  resetQuitConfirmationForTests();
  // Saved to disk throughout: the disk-dirty guard is a separate condition and would
  // mask which SpeleoDB predicate fired.
  useProjectStore.setState({
    project: { name: 'Cave A', file_path: '/cache/p1.stalx' } as never,
    isDirty: false,
    closeProject,
  });
  useUIStore.setState({ openDialog: openDialog as never, activeDialog: null, dialogData: {} });
});

/** Did the close flow raise the SpeleoDB prompt (rather than closing)? */
const closePrompts = async (): Promise<boolean> => {
  const { result } = renderHook(() => useProject());
  await result.current.handleCloseProject();
  return openDialog.mock.calls.some((c) => c[0] === 'speleodb-close');
};

/** Did the quit flow raise the SpeleoDB prompt? */
const quitPrompts = (): boolean => {
  const guarded = guardQuit();
  return guarded && openDialog.mock.calls.some((c) => c[0] === 'speleodb-quit');
};

describe('close and quit agree on the SpeleoDB exit guard (#270)', () => {
  it('lock held + unpushed: BOTH prompt', async () => {
    useSpeleoStore.setState({ link: link({ editState: 'editing', hasUnpushedEdits: true }) });
    expect(quitPrompts()).toBe(true);
    openDialog.mockClear();
    expect(await closePrompts()).toBe(true);
    expect(closeProject).not.toHaveBeenCalled();
  });

  // The regression this file exists for. Read-only + unpushed is reached by a
  // re-verify divergence or a `clearSession()` after a dead token; the work is at its
  // most stranded there, and closing used to say nothing at all.
  it('no lock + unpushed: BOTH prompt', async () => {
    useSpeleoStore.setState({ link: link({ editState: 'read-only', hasUnpushedEdits: true }) });
    expect(quitPrompts()).toBe(true);
    openDialog.mockClear();
    expect(await closePrompts()).toBe(true);
    expect(closeProject).not.toHaveBeenCalled();
  });

  it('no lock + nothing unpushed: NEITHER prompts', async () => {
    useSpeleoStore.setState({ link: link({ editState: 'read-only', hasUnpushedEdits: false }) });
    expect(quitPrompts()).toBe(false);
    openDialog.mockClear();
    expect(await closePrompts()).toBe(false);
    // Nothing to protect, so the close actually happens.
    expect(closeProject).toHaveBeenCalled();
  });

  // The one deliberate asymmetry, pinned so it cannot be "fixed" by accident.
  it('lock held + nothing unpushed: only CLOSE prompts (the lock must be handed back)', async () => {
    useSpeleoStore.setState({ link: link({ editState: 'editing', hasUnpushedEdits: false }) });
    expect(quitPrompts()).toBe(false);
    openDialog.mockClear();
    expect(await closePrompts()).toBe(true);
    expect(closeProject).not.toHaveBeenCalled();
  });

  it('a force-edit session with unpushed edits prompts on both exits', async () => {
    // #213 force-editing holds NO lock, so `editState === 'editing'` alone is not
    // what catches this - the unpushed-work term is.
    useSpeleoStore.setState({
      link: link({ editState: 'editing', forceEditing: true, hasUnpushedEdits: true }),
    });
    expect(quitPrompts()).toBe(true);
    openDialog.mockClear();
    expect(await closePrompts()).toBe(true);
  });

  it('a local project is untouched by either SpeleoDB guard', async () => {
    useSpeleoStore.setState({ link: null });
    expect(quitPrompts()).toBe(false);
    openDialog.mockClear();
    expect(await closePrompts()).toBe(false);
    expect(closeProject).toHaveBeenCalled();
  });
});
