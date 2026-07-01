import { create } from 'zustand';
import type {
  DoneResult,
  Permission,
  PushResult,
  RemoteState,
  SpeleoLinkStatus,
  SpeleoLoginResult,
  SpeleoSessionStatus,
  StartEditingResult,
  UpdateResult,
} from '../types/ipc.generated';
import { invokeIpc } from '../utils/ipc';

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
  /** The local copy's relationship to the server tip (drives the button, T2c). */
  remoteState: RemoteState;
}

/**
 * A staged login intent (A2): entered in the Settings account panel but applied
 * only when the dialog's Save is pressed. Credentials are transient — cleared on
 * apply, cancel, or dialog close (never persisted).
 */
export interface PendingLogin {
  kind: 'login';
  email: string;
  password: string;
  token: string;
  useToken: boolean;
}

export type PendingAuth = PendingLogin | { kind: 'logout' } | null;

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
  /** Query `speleodb_session` and set it (best-effort; runs on project load so the
      action button knows who we are — e.g. to tell our own lock from another's). */
  refreshSession: () => Promise<void>;

  // --- staged account actions (Settings #205, A2/A3) ---
  /** The login/logout the user staged; applied on the dialog's Save. */
  pendingAuth: PendingAuth;
  /** Error from the last apply-on-save (already humanized), shown in the panel. */
  authError: string | null;
  setPendingAuth: (p: PendingAuth) => void;
  clearPendingAuth: () => void;
  setAuthError: (msg: string | null) => void;
  /** Apply the staged login/logout (A2). ok=false carries the raw error. */
  applyPendingAuth: (endpoint: string | null) => Promise<{ ok: boolean; error?: unknown }>;
  /** Immediate logout (A3 server-address change / dead token). */
  logout: () => Promise<void>;

  // --- link/edit (action shell #204) ---
  /** Query `speleodb_link_status` and seed the link (best-effort; runs post-load). */
  refreshLinkStatus: () => Promise<void>;
  /** Seed the link from the backend status command (authoritative; runs post-load). */
  seedFromStatus: (s: SpeleoLinkStatus) => void;
  /** Optimistic seed from the browser's summary before `loadProject` settles. */
  setLinkOnOpen: (a: { permission: Permission | null }) => void;
  clearLink: () => void;
  applyStartEditing: (r: StartEditingResult) => void;
  applyUpdate: (r: UpdateResult) => void;
  applyDone: (r: DoneResult) => void;
  /** Push-without-release (T2d): keeps the lock; clears the dirty bit on success. */
  applyPush: (r: PushResult) => void;
  /** First successful mutation while editing flips the dirty indicator on. */
  markDirty: () => void;

  // --- seams ---
  enterDivergence: (origin: DivergenceOrigin) => void;
  clearDivergence: () => void;
  setBanner: (banner: SpeleoBanner) => void;
  dismissBanner: () => void;
}

export const useSpeleoStore = create<SpeleoStore>((set, get) => ({
  session: null,
  link: null,
  divergence: null,
  banner: null,
  pendingAuth: null,
  authError: null,

  setPendingAuth: (pendingAuth) => set({ pendingAuth }),
  clearPendingAuth: () => set({ pendingAuth: null, authError: null }),
  setAuthError: (authError) => set({ authError }),

  applyPendingAuth: async (endpoint) => {
    const p = get().pendingAuth;
    if (!p) return { ok: true };
    try {
      if (p.kind === 'logout') {
        await invokeIpc<null>('speleodb_logout');
        set({ pendingAuth: null, authError: null });
        get().clearSession();
      } else {
        const r = await invokeIpc<SpeleoLoginResult>('speleodb_login', {
          endpoint: (endpoint ?? '').trim() || undefined,
          email: p.useToken ? undefined : p.email.trim() || undefined,
          password: p.useToken ? undefined : p.password || undefined,
          token: p.useToken ? p.token.trim() || undefined : undefined,
        });
        set({ pendingAuth: null, authError: null });
        get().setSessionFromLogin(r);
      }
      return { ok: true };
    } catch (error) {
      return { ok: false, error };
    }
  },

  logout: async () => {
    // Best-effort: the token is forgotten locally regardless of the server call.
    try {
      await invokeIpc<null>('speleodb_logout');
    } catch {
      /* ignore — clearSession still drops the local session */
    }
    set({ pendingAuth: null, authError: null });
    get().clearSession();
  },

  refreshLinkStatus: async () => {
    try {
      const status = await invokeIpc<SpeleoLinkStatus>('speleodb_link_status');
      get().seedFromStatus(status);
    } catch {
      // Best-effort — leave the prior link state (the backend gate is the
      // real enforcement; the shell just can't refresh its indicator).
    }
  },

  setSession: (s) =>
    set({
      session: {
        loggedIn: s.logged_in,
        userEmail: s.user_email ?? null,
        keychainBacked: s.keychain_backed,
      },
    }),

  refreshSession: async () => {
    try {
      const status = await invokeIpc<SpeleoSessionStatus>('speleodb_session');
      get().setSession(status);
    } catch {
      // Best-effort — leave whatever the store had.
    }
  },

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
          // The network fields degrade to null/unknown offline — keep the
          // last-known permission rather than blanking the gate on a transient miss.
          permission: s.permission ?? state.link?.permission ?? null,
          lockHolder: s.lock_holder,
          hasUnpushedEdits: s.has_unpushed_edits,
          remoteState: s.remote_state,
        },
      };
    }),

  setLinkOnOpen: ({ permission }) =>
    set({
      // A freshly pulled project always opens read-only + up-to-date;
      // `seedFromStatus` refines lock holder / dirty bit / remote state on load.
      link: {
        permission,
        editState: 'read-only',
        lockHolder: null,
        hasUnpushedEdits: false,
        remoteState: 'up_to_date',
      },
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

  applyPush: (r) =>
    set((state) => {
      if (!state.link) return {};
      switch (r.kind) {
        case 'pushed':
          // Lock retained (still editing); edits are now on the server.
          return { link: { ...state.link, hasUnpushedEdits: false } };
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
