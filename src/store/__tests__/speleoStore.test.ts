import { describe, it, expect, beforeEach } from 'vitest';
import { useSpeleoStore } from '../speleoStore';
import type { SpeleoLinkStatus } from '../../types/ipc.generated';

const status = (o: Partial<SpeleoLinkStatus> = {}): SpeleoLinkStatus => ({
  is_remote: true,
  edit_enabled: false,
  has_unpushed_edits: false,
  permission: 'READ_AND_WRITE',
  lock_holder: null,
  remote_state: 'up_to_date',
  access_denied: false,
  ...o,
});

const reset = () =>
  useSpeleoStore.setState({ session: null, link: null, divergence: null, banner: null });

describe('speleoStore', () => {
  beforeEach(reset);

  describe('session', () => {
    it('setSession maps the backend status', () => {
      useSpeleoStore.getState().setSession({
        logged_in: true,
        user_email: 'u@x',
        keychain_backed: false,
      });
      expect(useSpeleoStore.getState().session).toEqual({
        loggedIn: true,
        userEmail: 'u@x',
        keychainBacked: false,
      });
    });

    it('clearSession degrades an active edit to read-only', () => {
      useSpeleoStore.getState().seedFromStatus(status({ edit_enabled: true }));
      useSpeleoStore.getState().setSessionFromLogin({ user_email: 'u@x', keychain_backed: true });
      useSpeleoStore.getState().clearSession();
      const s = useSpeleoStore.getState();
      expect(s.session).toBeNull();
      expect(s.link?.editState).toBe('read-only');
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

    it('carries the access_denied flag through as noAccess', () => {
      useSpeleoStore.getState().seedFromStatus(status({ permission: null, access_denied: true }));
      expect(useSpeleoStore.getState().link?.noAccess).toBe(true);
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
      useSpeleoStore.getState().setBanner({ kind: 'push_unconfirmed' });
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
      useSpeleoStore.getState().setBanner({ kind: 'push_unconfirmed' });
      useSpeleoStore.getState().applyPush({ kind: 'pushed' });
      const s = useSpeleoStore.getState();
      // Push behaves like push&release WITHOUT releasing the lock — still editing.
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
      useSpeleoStore.getState().enterDivergence('update');
      useSpeleoStore.getState().setBanner({ kind: 'concurrent_session' });
      useSpeleoStore.getState().clearLink();
      const s = useSpeleoStore.getState();
      expect(s.link).toBeNull();
      expect(s.divergence).toBeNull();
      expect(s.banner).toBeNull();
    });
  });
});
