import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useSpeleoStore } from '../speleoStore';
import type { SpeleoLinkStatus } from '../../types/ipc.generated';

const invokeIpcMock = vi.hoisted(() => vi.fn());
vi.mock('../../utils/ipc', () => ({ invokeIpc: invokeIpcMock }));

/** A logged-in session so `scanLocksOnOpen` skips the `refreshSession` prelude. */
const loggedInAs = (email: string) =>
  useSpeleoStore.setState({
    session: { loggedIn: true, userEmail: email, endpoint: 'https://x/', keychainBacked: true },
  });

const status = (o: Partial<SpeleoLinkStatus> = {}): SpeleoLinkStatus => ({
  is_remote: true,
  edit_enabled: false,
  has_unpushed_edits: false,
  permission: 'READ_AND_WRITE',
  lock_holder: null,
  remote_state: 'up_to_date',
  access_denied: false,
  server_error: null,
  exclude_geojson: false,
  ...o,
});

const reset = () => {
  invokeIpcMock.mockReset();
  useSpeleoStore.setState({
    session: null,
    link: null,
    divergence: null,
    banner: null,
    remoteLocks: {},
    heldLocks: null,
    heldLockPromptNonce: 0,
    heldLockPromptPending: true,
  });
};

describe('speleoStore', () => {
  beforeEach(reset);

  describe('session', () => {
    it('setSession maps the backend status', () => {
      useSpeleoStore.getState().setSession({
        logged_in: true,
        user_email: 'u@x',
        endpoint: 'https://x/',
        keychain_backed: false,
      });
      expect(useSpeleoStore.getState().session).toEqual({
        loggedIn: true,
        userEmail: 'u@x',
        endpoint: 'https://x/',
        keychainBacked: false,
      });
    });

    it('clearSession degrades an active edit to read-only', () => {
      useSpeleoStore.getState().seedFromStatus(status({ edit_enabled: true }));
      useSpeleoStore
        .getState()
        .setSessionFromLogin({ user_email: 'u@x', endpoint: 'https://x/', keychain_backed: true });
      useSpeleoStore.getState().clearSession();
      const s = useSpeleoStore.getState();
      expect(s.session).toBeNull();
      expect(s.link?.editState).toBe('read-only');
    });

    it('clearSession fully resets stale link fields, keeping the permission tier (fix 4)', () => {
      // Mid-edit with a held lock, un-pushed edits, a raised banner and divergence:
      // a logout must clear ALL of it (not just editState) so the button can't render
      // a self-contradictory state for a session that no longer exists.
      useSpeleoStore
        .getState()
        .seedFromStatus(
          status({ edit_enabled: true, has_unpushed_edits: true, lock_holder: 'me@x' }),
        );
      useSpeleoStore.setState({ divergence: 'push', banner: { kind: 'push_unconfirmed' } });
      useSpeleoStore.getState().clearSession();
      const s = useSpeleoStore.getState();
      expect(s.link?.editState).toBe('read-only');
      expect(s.link?.lockHolder).toBeNull();
      expect(s.link?.lockedByOther).toBe(false);
      expect(s.link?.hasUnpushedEdits).toBe(false);
      expect(s.link?.remoteState).toBe('unknown');
      expect(s.link?.noAccess).toBe(false);
      expect(s.link?.serverError).toBeNull();
      expect(s.link?.permission).toBe('READ_AND_WRITE');
      expect(s.divergence).toBeNull();
      expect(s.banner).toBeNull();
    });
  });

  describe('seedFromStatus', () => {
    it('clears the link for a local (non-remote) project', () => {
      useSpeleoStore.getState().setLinkOnOpen({ permission: 'ADMIN' });
      useSpeleoStore.getState().seedFromStatus(status({ is_remote: false }));
      expect(useSpeleoStore.getState().link).toBeNull();
    });

    it('maps the edit gate to read-only / editing', () => {
      useSpeleoStore.getState().seedFromStatus(status({ edit_enabled: false }));
      expect(useSpeleoStore.getState().link?.editState).toBe('read-only');
      useSpeleoStore.getState().seedFromStatus(status({ edit_enabled: true }));
      expect(useSpeleoStore.getState().link?.editState).toBe('editing');
    });

    it('keeps the last-known permission when the network field is null (offline)', () => {
      useSpeleoStore.getState().seedFromStatus(status({ permission: 'READ_AND_WRITE' }));
      useSpeleoStore.getState().seedFromStatus(status({ permission: null }));
      expect(useSpeleoStore.getState().link?.permission).toBe('READ_AND_WRITE');
    });

    it('carries lock holder and dirty bit through', () => {
      useSpeleoStore
        .getState()
        .seedFromStatus(status({ lock_holder: 'a@b', has_unpushed_edits: true }));
      const link = useSpeleoStore.getState().link;
      expect(link?.lockHolder).toBe('a@b');
      expect(link?.hasUnpushedEdits).toBe(true);
    });

    it('read-only + a holder ⟹ lockedByOther; editing ⟹ not', () => {
      useSpeleoStore.getState().seedFromStatus(status({ edit_enabled: false, lock_holder: 'a@b' }));
      expect(useSpeleoStore.getState().link?.lockedByOther).toBe(true);
      useSpeleoStore.getState().seedFromStatus(status({ edit_enabled: true, lock_holder: 'me@x' }));
      expect(useSpeleoStore.getState().link?.lockedByOther).toBe(false);
    });

    it('clears a prior lockedByOther once a later poll resolves no holder (fix 7)', () => {
      // Someone else held it, then released: the next poll reports no holder, and the
      // flag must drop (no "preserve prior" carry keeping the button stuck orange).
      useSpeleoStore.getState().seedFromStatus(status({ edit_enabled: false, lock_holder: 'a@b' }));
      expect(useSpeleoStore.getState().link?.lockedByOther).toBe(true);
      useSpeleoStore.getState().seedFromStatus(status({ edit_enabled: false, lock_holder: null }));
      expect(useSpeleoStore.getState().link?.lockedByOther).toBe(false);
    });

    it('carries the access_denied flag through as noAccess', () => {
      useSpeleoStore.getState().seedFromStatus(status({ permission: null, access_denied: true }));
      expect(useSpeleoStore.getState().link?.noAccess).toBe(true);
    });

    it('surfaces an unexpected server_error, and clears it on the next clean poll (fix 12)', () => {
      const err = { message: 'No Project matches the given query.', action: 'Fatal' as const, status: 404 };
      useSpeleoStore.getState().seedFromStatus(status({ server_error: err }));
      expect(useSpeleoStore.getState().link?.serverError).toEqual(err);
      useSpeleoStore.getState().seedFromStatus(status({ server_error: null }));
      expect(useSpeleoStore.getState().link?.serverError).toBeNull();
    });
  });

  describe('setLinkOnOpen', () => {
    it('seeds a read-only link with the summary permission', () => {
      useSpeleoStore.getState().setLinkOnOpen({ permission: 'READ_ONLY' });
      expect(useSpeleoStore.getState().link).toEqual({
        permission: 'READ_ONLY',
        editState: 'read-only',
        lockHolder: null,
        lockedByOther: false,
        hasUnpushedEdits: false,
        remoteState: 'up_to_date',
        noAccess: false,
        serverError: null,
      });
    });
  });

  describe('applyStartEditing', () => {
    beforeEach(() => useSpeleoStore.getState().seedFromStatus(status({ edit_enabled: false })));

    it('editing → editing', () => {
      useSpeleoStore.getState().applyStartEditing({ kind: 'editing' });
      expect(useSpeleoStore.getState().link?.editState).toBe('editing');
    });

    it('fast_forwarded → editing (optimistic; reload re-seeds)', () => {
      useSpeleoStore.getState().applyStartEditing({ kind: 'fast_forwarded', local_path: '/x' });
      expect(useSpeleoStore.getState().link?.editState).toBe('editing');
    });

    it('locked_by → read-only + lock holder + lockedByOther', () => {
      useSpeleoStore.getState().applyStartEditing({ kind: 'locked_by', email: 'a@b' });
      const s = useSpeleoStore.getState();
      expect(s.link?.editState).toBe('read-only');
      expect(s.link?.lockHolder).toBe('a@b');
      expect(s.link?.lockedByOther).toBe(true);
    });

    it('locked_by with a null email still marks lockedByOther (not free/unlocked)', () => {
      useSpeleoStore.getState().applyStartEditing({ kind: 'locked_by', email: null });
      expect(useSpeleoStore.getState().link?.lockedByOther).toBe(true);
    });

    it('divergence_needed → divergence origin start', () => {
      useSpeleoStore.getState().applyStartEditing({ kind: 'divergence_needed' });
      expect(useSpeleoStore.getState().divergence).toBe('start');
      // Stays read-only (not enabled on divergence).
      expect(useSpeleoStore.getState().link?.editState).toBe('read-only');
    });
  });

  describe('applyUpdate', () => {
    beforeEach(() => useSpeleoStore.getState().seedFromStatus(status({ edit_enabled: false })));

    it('divergence_needed → divergence origin update', () => {
      useSpeleoStore.getState().applyUpdate({ kind: 'divergence_needed' });
      expect(useSpeleoStore.getState().divergence).toBe('update');
    });

    it('up_to_date clears a stale remote_ahead indicator', () => {
      useSpeleoStore.getState().seedFromStatus(status({ remote_state: 'remote_ahead' }));
      expect(useSpeleoStore.getState().link?.remoteState).toBe('remote_ahead');
      useSpeleoStore.getState().applyUpdate({ kind: 'up_to_date' });
      expect(useSpeleoStore.getState().link?.remoteState).toBe('up_to_date');
      expect(useSpeleoStore.getState().divergence).toBeNull();
    });
  });

  describe('applyDone', () => {
    beforeEach(() =>
      useSpeleoStore
        .getState()
        .seedFromStatus(
          status({ edit_enabled: true, has_unpushed_edits: true, lock_holder: 'me@x' }),
        ),
    );

    it('released → read-only, dirty + lock holder cleared, divergence cleared', () => {
      useSpeleoStore.getState().applyDone({ kind: 'released' });
      const s = useSpeleoStore.getState();
      expect(s.link?.editState).toBe('read-only');
      expect(s.link?.hasUnpushedEdits).toBe(false);
      // Regression: a released lock must not still read as held (button stayed green).
      expect(s.link?.lockHolder).toBeNull();
      expect(s.link?.lockedByOther).toBe(false);
      expect(s.divergence).toBeNull();
    });

    it('released clears a lingering push-unconfirmed banner', () => {
      useSpeleoStore.setState({ banner: { kind: 'push_unconfirmed' } });
      useSpeleoStore.getState().applyDone({ kind: 'released' });
      expect(useSpeleoStore.getState().banner).toBeNull();
    });

    it('push_unconfirmed → raises the banner, stays editing', () => {
      useSpeleoStore.getState().applyDone({ kind: 'push_unconfirmed' });
      const s = useSpeleoStore.getState();
      expect(s.banner).toEqual({ kind: 'push_unconfirmed' });
      expect(s.link?.editState).toBe('editing');
    });

    it('divergence_needed → divergence origin done, stays editing', () => {
      useSpeleoStore.getState().applyDone({ kind: 'divergence_needed' });
      const s = useSpeleoStore.getState();
      expect(s.divergence).toBe('done');
      expect(s.link?.editState).toBe('editing');
    });
  });

  describe('applyPush', () => {
    beforeEach(() =>
      useSpeleoStore
        .getState()
        .seedFromStatus(
          status({ edit_enabled: true, has_unpushed_edits: true, lock_holder: 'me@x' }),
        ),
    );

    it('pushed → keeps the lock, clears dirty + banner, resets remote state', () => {
      useSpeleoStore.setState({ banner: { kind: 'push_unconfirmed' } });
      useSpeleoStore.getState().applyPush({ kind: 'pushed' });
      const s = useSpeleoStore.getState();
      // Push behaves like push&release WITHOUT releasing the lock - still editing.
      expect(s.link?.editState).toBe('editing');
      expect(s.link?.hasUnpushedEdits).toBe(false);
      expect(s.link?.remoteState).toBe('up_to_date');
      expect(s.banner).toBeNull();
    });

    it('divergence_needed → divergence origin push, stays editing', () => {
      useSpeleoStore.getState().applyPush({ kind: 'divergence_needed' });
      const s = useSpeleoStore.getState();
      expect(s.divergence).toBe('push');
      expect(s.link?.editState).toBe('editing');
    });

    it('push_unconfirmed → raises the banner, stays editing', () => {
      useSpeleoStore.getState().applyPush({ kind: 'push_unconfirmed' });
      const s = useSpeleoStore.getState();
      expect(s.banner).toEqual({ kind: 'push_unconfirmed' });
      expect(s.link?.editState).toBe('editing');
    });
  });

  describe('markDirty', () => {
    it('flips the dirty bit on for an editing link', () => {
      useSpeleoStore.getState().seedFromStatus(status({ edit_enabled: true }));
      useSpeleoStore.getState().markDirty();
      expect(useSpeleoStore.getState().link?.hasUnpushedEdits).toBe(true);
    });

    it('is a no-op with no link', () => {
      useSpeleoStore.getState().markDirty();
      expect(useSpeleoStore.getState().link).toBeNull();
    });
  });

  describe('clearLink', () => {
    it('drops link, divergence and banner', () => {
      useSpeleoStore.getState().seedFromStatus(status({ edit_enabled: true }));
      useSpeleoStore.setState({ divergence: 'update', banner: { kind: 'concurrent_session' } });
      useSpeleoStore.getState().clearLink();
      const s = useSpeleoStore.getState();
      expect(s.link).toBeNull();
      expect(s.divergence).toBeNull();
      expect(s.banner).toBeNull();
    });
  });

  describe('notifyReverifyDivergence (#202)', () => {
    it('drops an active edit to read-only + conflict and raises the divergence prompt', () => {
      // Mid-edit (lock held), then the lazy 20-min re-verify finds a lost lock /
      // moved tip: the shell must go read-only + conflict and open the prompt.
      useSpeleoStore.getState().seedFromStatus(status({ edit_enabled: true }));
      expect(useSpeleoStore.getState().link?.editState).toBe('editing');
      useSpeleoStore.getState().notifyReverifyDivergence();
      const s = useSpeleoStore.getState();
      expect(s.divergence).toBe('reverify');
      expect(s.link?.editState).toBe('read-only');
      expect(s.link?.remoteState).toBe('conflict');
    });

    it('is a safe no-op on link state when no project is linked', () => {
      useSpeleoStore.getState().notifyReverifyDivergence();
      const s = useSpeleoStore.getState();
      expect(s.divergence).toBe('reverify');
      expect(s.link).toBeNull();
    });
  });

  describe('#200 banners', () => {
    it('seedFromStatus raises the rendering-disabled banner when exclude_geojson is set', () => {
      useSpeleoStore.getState().seedFromStatus(status({ exclude_geojson: true }));
      expect(useSpeleoStore.getState().banner).toEqual({ kind: 'rendering_disabled' });
    });

    it('seedFromStatus clears its own rendering-disabled banner once the flag is off', () => {
      useSpeleoStore.getState().seedFromStatus(status({ exclude_geojson: true }));
      useSpeleoStore.getState().seedFromStatus(status({ exclude_geojson: false }));
      expect(useSpeleoStore.getState().banner).toBeNull();
    });

    it('a rendering-disabled poll never clobbers transient push_unconfirmed feedback', () => {
      useSpeleoStore.setState({ banner: { kind: 'push_unconfirmed' } });
      useSpeleoStore.getState().seedFromStatus(status({ exclude_geojson: true }));
      expect(useSpeleoStore.getState().banner).toEqual({ kind: 'push_unconfirmed' });
    });

    it('raiseNoAnchorBanner only claims a free banner slot', () => {
      useSpeleoStore.getState().raiseNoAnchorBanner();
      expect(useSpeleoStore.getState().banner).toEqual({ kind: 'no_anchor' });
      // With a transient banner already up, it must not overwrite it.
      useSpeleoStore.setState({ banner: { kind: 'push_unconfirmed' } });
      useSpeleoStore.getState().raiseNoAnchorBanner();
      expect(useSpeleoStore.getState().banner).toEqual({ kind: 'push_unconfirmed' });
    });
  });

  // #201 refinements: the resume/release prompt fires only on login + app-open (not
  // every recents visit), and individual locks can be released one at a time.
  describe('held-lock scan + release (#201)', () => {
    it('the first app-open scan is prompt-worthy: it bumps the nonce when a lock is held', async () => {
      loggedInAs('me@x');
      invokeIpcMock.mockResolvedValue([{ id: 'p1', name: 'Held', lock_holder: 'me@x' }]);
      await useSpeleoStore.getState().scanLocksOnOpen();
      const s = useSpeleoStore.getState();
      expect(s.heldLocks).toEqual([{ projectId: 'p1', projectName: 'Held' }]);
      expect(s.remoteLocks).toEqual({ p1: 'me@x' });
      expect(s.heldLockPromptNonce).toBe(1);
      // Consumed, so a later routine scan won't retro-prompt.
      expect(s.heldLockPromptPending).toBe(false);
    });

    it('a routine badge refresh keeps the badges but does NOT re-open the prompt', async () => {
      loggedInAs('me@x');
      useSpeleoStore.setState({ heldLockPromptPending: false, heldLockPromptNonce: 1 });
      invokeIpcMock.mockResolvedValue([{ id: 'p1', name: 'Held', lock_holder: 'me@x' }]);
      await useSpeleoStore.getState().scanLocksOnOpen();
      const s = useSpeleoStore.getState();
      expect(s.heldLocks).toEqual([{ projectId: 'p1', projectName: 'Held' }]); // badges still fresh
      expect(s.heldLockPromptNonce).toBe(1); // but no new prompt
    });

    it('an explicit prompt scan (login) re-opens the prompt even after the pending flag is gone', async () => {
      loggedInAs('me@x');
      useSpeleoStore.setState({ heldLockPromptPending: false, heldLockPromptNonce: 1 });
      invokeIpcMock.mockResolvedValue([{ id: 'p1', name: 'Held', lock_holder: 'me@x' }]);
      await useSpeleoStore.getState().scanLocksOnOpen({ prompt: true });
      expect(useSpeleoStore.getState().heldLockPromptNonce).toBe(2);
    });

    it('a scan that finds no lock held by us never bumps the nonce (case-insensitive match)', async () => {
      loggedInAs('Me@X');
      invokeIpcMock.mockResolvedValue([
        { id: 'p2', name: 'Other', lock_holder: 'someone@x' },
        { id: 'p3', name: 'Free', lock_holder: null },
      ]);
      await useSpeleoStore.getState().scanLocksOnOpen({ prompt: true });
      const s = useSpeleoStore.getState();
      expect(s.heldLocks).toBeNull();
      expect(s.heldLockPromptNonce).toBe(0);
      expect(s.remoteLocks).toEqual({ p2: 'someone@x', p3: null });
    });

    it('a logged-out scan clears the badges and consumes the app-open pending without prompting', async () => {
      useSpeleoStore.setState({
        session: { loggedIn: false, userEmail: null, endpoint: null, keychainBacked: false },
        remoteLocks: { p1: 'x' },
      });
      await useSpeleoStore.getState().scanLocksOnOpen();
      const s = useSpeleoStore.getState();
      expect(s.remoteLocks).toEqual({});
      expect(s.heldLocks).toBeNull();
      expect(s.heldLockPromptPending).toBe(false);
      expect(s.heldLockPromptNonce).toBe(0);
      expect(invokeIpcMock).not.toHaveBeenCalledWith('speleodb_list_projects');
    });

    it('releaseLock drops one lock and frees it in the badge map, emptying to null on the last', async () => {
      loggedInAs('me@x');
      useSpeleoStore.setState({
        heldLocks: [
          { projectId: 'p1', projectName: 'A' },
          { projectId: 'p2', projectName: 'B' },
        ],
        remoteLocks: { p1: 'me@x', p2: 'me@x' },
      });
      // release_lock returns null; the follow-up refreshLinkStatus reads link_status.
      invokeIpcMock.mockImplementation(async (cmd: string) =>
        cmd === 'speleodb_link_status' ? status() : null,
      );

      await useSpeleoStore.getState().releaseLock('p1');
      let s = useSpeleoStore.getState();
      expect(s.heldLocks).toEqual([{ projectId: 'p2', projectName: 'B' }]);
      expect(s.remoteLocks.p1).toBeNull();
      expect(invokeIpcMock).toHaveBeenCalledWith('speleodb_release_lock', { projectId: 'p1' });

      await useSpeleoStore.getState().releaseLock('p2');
      s = useSpeleoStore.getState();
      expect(s.heldLocks).toBeNull(); // empty → the dialog's effect auto-closes it
      expect(s.remoteLocks.p2).toBeNull();
    });
  });
});
