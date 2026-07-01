import { create } from 'zustand';
import type {
  DoneResult,
  Permission,
  SpeleoLinkStatus,
  SpeleoLoginResult,
  SpeleoSessionStatus,
  StartEditingResult,
  UpdateResult,
} from '../types/ipc.generated';

/**
 * Shared SpeleoDB frontend state (#204/#203/#205). Holds the backend **session**
 * (logged-in identity, shared by the Settings tab + project browser) and the
 * open project's **link/edit** state (the action shell's read-only/editing
 * indicator + control gating).
 *
 * This store is UI-truth seeded from backend results (`speleodb_link_status`,
 * the hand-off verb results); it never contradicts the backend edit gate — the
 * `EDIT_DISABLED` mutation rejection (see `utils/editErrors.ts`) remains the hard
 * backstop. `link === null` means the open project is local (or none is open), so
 * the shell renders nothing.
 */

/** A remote project is either opened read-only or actively edited (lock held). */
export type SpeleoEditState = 'read-only' | 'editing';

/** Which hand-off verb hit a divergence that needs the reconcile prompt (#198). */
export type DivergenceOrigin = 'start' | 'update' | 'done';

/** Transient banner the shell surfaces above the toolbar (#200 seam). */
export type SpeleoBanner = { kind: 'push_unconfirmed' } | { kind: 'concurrent_session' };

export interface SpeleoSession {
  loggedIn: boolean;
  userEmail: string | null;
  /** False when the token is held in memory only (won't survive a restart). */
  keychainBacked: boolean;
}

export interface SpeleoLinkState {
  permission: Permission | null;
  editState: SpeleoEditState;
  /** Email of the current lock holder (may be us, or another user), if any. */
  lockHolder: string | null;
  hasUnpushedEdits: boolean;
}

interface SpeleoStore {
  /** Backend session, or `null` before the first `setSession`/`refreshSession`. */
  session: SpeleoSession | null;
  /** The open project's link/edit state, or `null` when it is local / none open. */
  link: SpeleoLinkState | null;
  /** Set when a hand-off verb reported divergence; consumed by #198 (stub for now). */
  divergence: DivergenceOrigin | null;
  /** Transient banner (#200 seam). */
  banner: SpeleoBanner | null;

  // --- session (Settings #205 / browser #203) ---
  setSession: (s: SpeleoSessionStatus) => void;
  setSessionFromLogin: (r: SpeleoLoginResult) => void;
  clearSession: () => void;

  // --- link/edit (action shell #204) ---
  /** Seed the link from the backend status command (authoritative; runs post-load). */
  seedFromStatus: (s: SpeleoLinkStatus) => void;
  /** Optimistic seed from the browser's summary before `loadProject` settles. */
  setLinkOnOpen: (a: { permission: Permission | null }) => void;
  clearLink: () => void;
  applyStartEditing: (r: StartEditingResult) => void;
  applyUpdate: (r: UpdateResult) => void;
  applyDone: (r: DoneResult) => void;
  /** First successful mutation while editing flips the dirty indicator on. */
  markDirty: () => void;

  // --- seams ---
  enterDivergence: (origin: DivergenceOrigin) => void;
  clearDivergence: () => void;
  setBanner: (banner: SpeleoBanner) => void;
  dismissBanner: () => void;
}

export const useSpeleoStore = create<SpeleoStore>((set) => ({
  session: null,
  link: null,
  divergence: null,
  banner: null,

  setSession: (s) =>
    set({
      session: {
        loggedIn: s.logged_in,
        userEmail: s.user_email ?? null,
        keychainBacked: s.keychain_backed,
      },
    }),

  setSessionFromLogin: (r) =>
    set({
      session: { loggedIn: true, userEmail: r.user_email, keychainBacked: r.keychain_backed },
    }),

  // A logout / dead-token drop can't push a remote edit anymore — the backend
  // drops its edit gate on the same event, so degrade any active edit to
  // read-only to match (the shell then offers Start editing again on re-login).
  clearSession: () =>
    set((state) => ({
      session: null,
      link:
        state.link && state.link.editState === 'editing'
          ? { ...state.link, editState: 'read-only' }
          : state.link,
    })),

  seedFromStatus: (s) =>
    set((state) => {
      if (!s.is_remote) return { link: null, divergence: null, banner: null };
      return {
        link: {
          editState: s.edit_enabled ? 'editing' : 'read-only',
          // The network fields degrade to null offline — keep the last-known
          // permission rather than blanking the gate on a transient miss.
          permission: s.permission ?? state.link?.permission ?? null,
          lockHolder: s.lock_holder,
          hasUnpushedEdits: s.has_unpushed_edits,
        },
      };
    }),

  setLinkOnOpen: ({ permission }) =>
    set({
      // A freshly pulled project always opens read-only; `seedFromStatus`
      // refines lock holder + dirty bit once the load settles.
      link: { permission, editState: 'read-only', lockHolder: null, hasUnpushedEdits: false },
      divergence: null,
      banner: null,
    }),

  clearLink: () => set({ link: null, divergence: null, banner: null }),

  applyStartEditing: (r) =>
    set((state) => {
      if (!state.link) return {};
      switch (r.kind) {
        case 'editing':
        case 'fast_forwarded':
          // On fast_forwarded the caller also reloads the project (which re-seeds
          // via seedFromStatus); set editing optimistically so the shell updates now.
          return { link: { ...state.link, editState: 'editing' }, divergence: null };
        case 'divergence_needed':
          return { divergence: 'start' };
        case 'locked_by':
          return {
            link: { ...state.link, editState: 'read-only', lockHolder: r.email ?? null },
          };
        default:
          return {};
      }
    }),

  applyUpdate: (r) =>
    set(() => {
      switch (r.kind) {
        case 'divergence_needed':
          return { divergence: 'update' };
        // up_to_date: nothing changes. fast_forwarded: the caller reloads +
        // re-seeds, so no state change is needed here.
        default:
          return {};
      }
    }),

  applyDone: (r) =>
    set((state) => {
      if (!state.link) return {};
      switch (r.kind) {
        case 'released':
          return {
            link: { ...state.link, editState: 'read-only', hasUnpushedEdits: false },
            divergence: null,
          };
        case 'divergence_needed':
          return { divergence: 'done' };
        case 'push_unconfirmed':
          return { banner: { kind: 'push_unconfirmed' } };
        default:
          return {};
      }
    }),

  markDirty: () =>
    set((state) =>
      state.link && !state.link.hasUnpushedEdits
        ? { link: { ...state.link, hasUnpushedEdits: true } }
        : {},
    ),

  enterDivergence: (origin) => set({ divergence: origin }),
  clearDivergence: () => set({ divergence: null }),
  setBanner: (banner) => set({ banner }),
  dismissBanner: () => set({ banner: null }),
}));
