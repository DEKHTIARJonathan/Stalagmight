/**
 * The revert composition (lock -> restore -> push & release). It has no backend verb
 * of its own, so the invariants that matter are all about WHAT IT LEAVES BEHIND when
 * a middle step fails: never take a lock we already know will be refused, hand a lock
 * back only while the copy is clean, and never auto-release over un-pushed work.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

const invokeIpcMock = vi.hoisted(() => vi.fn());
vi.mock('../../utils/ipc', () => ({
  invokeIpc: invokeIpcMock,
  getErrorMessage: (e: unknown, f?: string) =>
    (e as { message?: string })?.message ?? f ?? 'error',
}));

import { useRevertRevision, type RevertOutcome, type RevertRevisionArgs } from '../useRevertRevision';
import { useSpeleoStore, type SpeleoLinkState } from '../../store/speleoStore';
import { useProjectStore } from '../../store/projectStore';
import { useUIStore } from '../../store/uiStore';

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

const ARGS: RevertRevisionArgs = {
  projectId: 'p1',
  projectName: 'Cave A',
  hexsha: 'abcdef0123',
  shortSha: 'abcdef01',
  message: 'undo the bad survey',
};

const RESTORED = { local_path: '/cache/p1.stalx', concurrent_session: false };

const UNPUSHED_REFUSAL = {
  message: 'local edits never pushed',
  action: 'UnpushedLocalEdits',
  unpushed_local: {
    project_id: 'p1',
    local_path: '/cache/p1.stalx',
    last_edit_at: '2026-07-26T09:00:00Z',
  },
};

/** Route each command to a canned outcome; anything unlisted resolves to null. */
function ipc(routes: Record<string, () => unknown>): void {
  invokeIpcMock.mockImplementation(async (command: string) => routes[command]?.() ?? null);
}
const ok = (value: unknown) => () => value;
const rejects = (error: unknown) => () => {
  throw error;
};

/** The speleodb_* commands actually issued, in order. */
const issued = () =>
  invokeIpcMock.mock.calls.map((c) => c[0] as string).filter((c) => c.startsWith('speleodb_'));

const argsOf = (command: string) =>
  invokeIpcMock.mock.calls.find((c) => c[0] === command)?.[1] as Record<string, unknown> | undefined;

const run = async (over: Partial<RevertRevisionArgs> = {}): Promise<RevertOutcome> => {
  const { result } = renderHook(() => useRevertRevision());
  let outcome: RevertOutcome | undefined;
  await act(async () => {
    outcome = await result.current({ ...ARGS, ...over });
  });
  return outcome as RevertOutcome;
};

beforeEach(() => {
  invokeIpcMock.mockReset();
  useSpeleoStore.setState({
    link: { ...LINK },
    remoteProjectId: 'p1',
    divergence: null,
    banner: null,
    busy: false,
    refreshLinkStatus: vi.fn(async () => {}),
  });
  useProjectStore.setState({
    refreshProjectState: vi.fn(async () => {}),
    checkProjectIntegrity: vi.fn(async () => []),
    saveProject: vi.fn(async () => ({ success: true }) as never),
    isDirty: false,
  });
  useUIStore.setState({ showToast: vi.fn(), setView: vi.fn(), clearSelection: vi.fn() });
});

describe('useRevertRevision - the happy path', () => {
  it('locks, restores, then pushes & releases - in that order, with those arguments', async () => {
    ipc({
      speleodb_start_editing: ok({ kind: 'editing' }),
      speleodb_restore_revision: ok(RESTORED),
      speleodb_done: ok({ kind: 'released' }),
    });

    const outcome = await run();

    expect(outcome).toEqual({ kind: 'reverted' });
    expect(issued()).toEqual([
      'speleodb_start_editing',
      'speleodb_restore_revision',
      'speleodb_done',
    ]);
    expect(argsOf('speleodb_restore_revision')).toEqual({
      projectId: 'p1',
      projectName: 'Cave A',
      hexsha: 'abcdef0123',
      restore: true,
      // The first attempt never waives the un-pushed-edits guard.
      discardLocal: false,
    });
    expect(argsOf('speleodb_done')).toEqual({ message: 'undo the bad survey' });
  });

  it('reports each step as it starts', async () => {
    ipc({
      speleodb_start_editing: ok({ kind: 'editing' }),
      speleodb_restore_revision: ok(RESTORED),
      speleodb_done: ok({ kind: 'released' }),
    });
    const steps: string[] = [];

    await run({ onStep: (s) => steps.push(s) });

    expect(steps).toEqual(['locking', 'restoring', 'pushing']);
  });
});

describe('useRevertRevision - refusing before it takes anything', () => {
  it('needs a discard for an un-pushed copy WITHOUT acquiring the lock', async () => {
    // The whole point of the pre-flight: the restore would be refused anyway, so
    // acquiring first would block another user for the length of a call we already
    // know fails.
    useSpeleoStore.setState({ link: { ...LINK, hasUnpushedEdits: true } });
    ipc({});

    const outcome = await run();

    expect(outcome).toEqual({ kind: 'needs_discard', lockHeld: false });
    expect(issued()).toEqual([]);
  });

  it('reports the holder when someone else has the lock', async () => {
    ipc({ speleodb_start_editing: ok({ kind: 'locked_by', email: 'other@x' }) });

    const outcome = await run();

    expect(outcome).toEqual({ kind: 'locked_by', email: 'other@x' });
    expect(issued()).toEqual(['speleodb_start_editing']);
  });

  it('reports a divergence and unwinds nothing (the backend released its own lock)', async () => {
    ipc({ speleodb_start_editing: ok({ kind: 'divergence_needed' }) });

    const outcome = await run();

    expect(outcome).toEqual({ kind: 'diverged' });
    expect(issued()).toEqual(['speleodb_start_editing']);
  });

  it('reports a plain lock failure when nothing else explains it', async () => {
    ipc({ speleodb_start_editing: rejects({ message: 'offline' }) });

    const outcome = await run();

    expect(outcome).toEqual({ kind: 'lock_failed' });
  });
});

describe('useRevertRevision - unwinding a failed restore', () => {
  it('keeps the lock and uploads nothing when the restore is refused for local edits', async () => {
    // The refusal IS the backend saying its dirty bit is set, so releasing here
    // would PUBLISH the un-pushed work: `speleodb_done` pushes whenever the backend
    // link is dirty, and `message: null` only picks the commit message - it does not
    // suppress the upload. The old behaviour read the FRONTEND mirror, which the
    // pre-flight has already forced to false on this route, and so released - the
    // user's survey work went up as a revision with no message and no confirmation,
    // and only then were they offered the armed "this replaces your un-pushed
    // changes" button for work that was already published.
    ipc({
      speleodb_start_editing: ok({ kind: 'editing' }),
      speleodb_restore_revision: rejects(UNPUSHED_REFUSAL),
      speleodb_done: ok({ kind: 'released' }),
    });

    const outcome = await run();

    expect(outcome).toEqual({ kind: 'needs_discard', lockHeld: true });
    expect(issued()).not.toContain('speleodb_done');
  });

  it('releases and reports the failure for an ordinary restore error', async () => {
    ipc({
      speleodb_start_editing: ok({ kind: 'editing' }),
      speleodb_restore_revision: rejects({ message: 'offline' }),
      speleodb_done: ok({ kind: 'released' }),
    });

    const outcome = await run();

    expect(outcome).toMatchObject({ kind: 'restore_failed', lockHeld: false });
    expect(issued()).toContain('speleodb_done');
  });

  it('reports NO lock held when the release says the edit gate had already dropped', async () => {
    // `lockHeld` answers "am I now holding a lock I did not have?", and `not_editing`
    // is the backend saying the gate - and with it the lock - was already gone (a 401
    // auto-drop is the usual way in). Folding every non-`released` answer into
    // `lockHeld: true` made the dialog say "You still hold the write lock" about a
    // lock that demonstrably was not held.
    ipc({
      speleodb_start_editing: ok({ kind: 'editing' }),
      speleodb_restore_revision: rejects({ message: 'offline' }),
      speleodb_done: ok({ kind: 'not_editing' }),
    });

    const outcome = await run();

    expect(outcome).toMatchObject({ kind: 'restore_failed', lockHeld: false });
  });

  it('stays on the pessimistic answer when the release itself throws', async () => {
    // A thrown release leaves the lock genuinely unknown. Being sent to check a lock
    // we no longer hold costs a trip; being told nothing about one we DO hold strands
    // a server mutex, so "unknown" reports as held.
    ipc({
      speleodb_start_editing: ok({ kind: 'editing' }),
      speleodb_restore_revision: rejects({ message: 'offline' }),
      speleodb_done: rejects({ message: 'offline' }),
    });

    const outcome = await run();

    expect(outcome).toMatchObject({ kind: 'restore_failed', lockHeld: true });
  });

  it('KEEPS the lock when the copy is dirty - releasing would strand un-pushed work', async () => {
    // The armed-discard retry waives the pre-flight, so the flow reaches the backend
    // with un-pushed edits still present and fails there for its own reason. Releasing
    // now would leave that work on this computer with nothing protecting it, and a
    // done(message) would publish edits nobody asked to publish.
    useSpeleoStore.setState({ link: { ...LINK, hasUnpushedEdits: true } });
    ipc({
      speleodb_start_editing: ok({ kind: 'editing' }),
      speleodb_restore_revision: rejects({ message: 'offline' }),
    });

    const outcome = await run({ discardLocal: true });

    expect(outcome).toMatchObject({ kind: 'restore_failed', lockHeld: true });
    expect(issued()).not.toContain('speleodb_done');
  });
});

describe('useRevertRevision - a restore that landed but a push that did not', () => {
  it('reports push_failed and does NOT try to release', async () => {
    // Auto-releasing here would leave the reverted tree as un-pushed edits with no
    // lock over them - the exact state the #260 banner's Retry exists to resolve.
    ipc({
      speleodb_start_editing: ok({ kind: 'editing' }),
      speleodb_restore_revision: ok(RESTORED),
      speleodb_done: rejects({ message: 'offline' }),
    });

    const outcome = await run();

    expect(outcome).toEqual({ kind: 'push_failed' });
    expect(issued().filter((c) => c === 'speleodb_done')).toHaveLength(1);
  });

  it('separates a dropped session from a failed push, because the advice differs', async () => {
    // `not_editing` means the edit gate went away mid-flight (a 401 auto-drop is the
    // usual way in): nothing uploaded, nothing released, and NO lock held. It reaches
    // the same dead end as push_failed, but that outcome's copy tells the user they
    // are holding the write lock and can Retry from the banner - which here would
    // send them at a button that cannot work.
    ipc({
      speleodb_start_editing: ok({ kind: 'editing' }),
      speleodb_restore_revision: ok(RESTORED),
      speleodb_done: ok({ kind: 'not_editing' }),
    });

    const outcome = await run();

    expect(outcome).toEqual({ kind: 'not_editing' });
    // Still no release attempt: there is nothing to release.
    expect(issued().filter((c) => c === 'speleodb_done')).toHaveLength(1);
  });

  it('reports push_unconfirmed rather than claiming the lock came back', async () => {
    ipc({
      speleodb_start_editing: ok({ kind: 'editing' }),
      speleodb_restore_revision: ok(RESTORED),
      speleodb_done: ok({ kind: 'push_unconfirmed' }),
    });

    const outcome = await run();

    expect(outcome).toEqual({ kind: 'push_unconfirmed' });
  });
});

/**
 * `resumeAtPush` exists for the state a failed (or unconfirmed) upload leaves behind:
 * the revision IS in the working copy and the lock IS still held, so the upload is the
 * only step outstanding. Re-running the composite there re-downloads and re-swaps a
 * tree that is already correct, and - on the attempt whose upload really landed -
 * routes the retry through the acquire's reconcile, which has no authorship recovery
 * and so calls our own commit a divergence and releases the lock to prompt about it.
 */
describe('useRevertRevision - resuming at the push', () => {
  beforeEach(() => {
    // The state the resume is for, as the restore leaves it: lock held, dirty bit set.
    useSpeleoStore.setState({ link: { ...LINK, editState: 'editing', hasUnpushedEdits: true } });
  });

  it('issues ONLY the push - no second acquire, no second restore', async () => {
    // Every verb is routed, so anything the resume issues shows up in `issued()`.
    ipc({
      speleodb_start_editing: ok({ kind: 'editing' }),
      speleodb_restore_revision: ok(RESTORED),
      speleodb_done: ok({ kind: 'released' }),
    });

    const outcome = await run({ resumeAtPush: true });

    expect(outcome).toEqual({ kind: 'reverted' });
    expect(issued()).toEqual(['speleodb_done']);
    expect(issued()).not.toContain('speleodb_start_editing');
    expect(issued()).not.toContain('speleodb_restore_revision');
    // And with the SAME message: a resume publishes the revert the user confirmed.
    expect(argsOf('speleodb_done')).toEqual({ message: 'undo the bad survey' });
  });

  it('runs past the pre-flight guard the restore itself tripped', async () => {
    // `hasUnpushedEdits` is set by the restore, so the ordinary route would refuse
    // this retry outright - offering to "replace my changes" over the user's own
    // revert. The resume must not consult that guard at all.
    ipc({ speleodb_done: ok({ kind: 'released' }) });

    const outcome = await run({ resumeAtPush: true });

    expect(outcome).toEqual({ kind: 'reverted' });
    expect(issued()).toEqual(['speleodb_done']);
  });

  it('reports the pushing step and no other', async () => {
    ipc({ speleodb_done: ok({ kind: 'released' }) });
    const steps: string[] = [];

    await run({ resumeAtPush: true, onStep: (s) => steps.push(s) });

    expect(steps).toEqual(['pushing']);
  });

  it('maps a still-failing resume through the same tail as the first attempt', async () => {
    // One copy of the done-result -> outcome mapping: a resume that fails again has
    // to describe itself exactly as the first failure did, or the dialog would offer
    // a different way out of the same state.
    ipc({ speleodb_done: rejects({ message: 'still offline' }) });

    const outcome = await run({ resumeAtPush: true });

    expect(outcome).toEqual({ kind: 'push_failed' });
    expect(issued()).toEqual(['speleodb_done']);
  });

  it('maps an unconfirmed resume through that tail too', async () => {
    ipc({ speleodb_done: ok({ kind: 'push_unconfirmed' }) });

    const outcome = await run({ resumeAtPush: true });

    expect(outcome).toEqual({ kind: 'push_unconfirmed' });
    expect(issued()).toEqual(['speleodb_done']);
  });
});
