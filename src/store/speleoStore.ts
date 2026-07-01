import { create } from 'zustand';
import type {
  DoneResult,
  Permission,
  PushResult,
  RemoteState,
  SpeleoErrorDto,
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
 * the hand-off verb results); it never contradicts the backend edit gate - the
 * `EDIT_DISABLED` mutation rejection (see `utils/editErrors.ts`) remains the hard
 * backstop. `link === null` means the open project is local (or none is open), so
 * the shell renders nothing.
 */

/** A remote project is either opened read-only or actively edited (lock held). */
export type SpeleoEditState = 'read-only' | 'editing';

/** Which hand-off verb hit a divergence that needs the reconcile prompt (#198). */
export type DivergenceOrigin = 'start' | 'update' | 'done' | 'push';

/** Transient banner the shell surfaces above the toolbar (#200 seam). */
export type SpeleoBanner = { kind: 'push_unconfirmed' } | { kind: 'concurrent_session' };

export interface SpeleoSession {
  loggedIn: boolean;
  userEmail: string | null;
  /** The server this session is authenticated against (a change to the config
      endpoint only affects future logins, so we show where we're actually signed in). */
  endpoint: string | null;
  /** False when the token is held in memory only (won't survive a restart). */
  keychainBacked: boolean;
}

export interface SpeleoLinkState {
  permission: Permission | null;
  editState: SpeleoEditState;
  /** Email of the current lock holder (may be us, or another user), if known. */
  lockHolder: string | null;
  /**
   * Someone ELSE holds the write lock. Derived once here rather than compared
   * against our email in every consumer: the backend enforces hold-lock ⟹
   * edit-enabled, so a read-only project with a holder is held by another - even
   * when that holder's email (or our own) couldn't be resolved.
   */
  lockedByOther: boolean;
  hasUnpushedEdits: boolean;
  /** The local copy's relationship to the server tip (drives the button, T2c). */
  remoteState: RemoteState;
  /**
   * The project is linked but the server refused this user access to it (a 403) -
   * e.g. a managed .stalx shared as a bare file. Drives the button's red-
   * exclamation "no permission" state, whose only action is offering to convert
   * the file to a plain unmanaged local .stalx (fix 10). Distinct from an offline
   * miss (which leaves this false), so we never nag a merely-offline user.
   */
  noAccess: boolean;
  /**
   * An UNEXPECTED server error hit while probing the link (a status that is not the
   * handled 401 dead-token / 403 access-denied, and not a transient offline miss -
   * e.g. a 404 for a deleted project, a 422, or a 5xx). Drives the button's yellow
   * "?" state, whose click opens a dialog with this detail. `null` on success /
   * offline / the handled auth cases (see backend `speleodb_link_status`).
   */
  serverError: SpeleoErrorDto | null;
}

/**
 * A staged login intent (A2): entered in the Settings account panel but applied
 * only when the dialog's Save is pressed. Credentials are transient - cleared on
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
  /**
   * Bumped after a hand-off verb to restart the status poll timer, so the next
   * poll is a full (≥30 s) interval away - a buffer that avoids re-reading a
   * server mutex that hasn't reflected our just-issued release yet (1b).
   */
  pollNonce: number;
  bumpPoll: () => void;
  /**
   * True while a hand-off verb (start/update/push/done) is in flight. Shared so
   * every entry point - the status button AND the hamburger submenu - gates on
   * the same lock and can't double-issue (fix 12).
   */
  busy: boolean;
  setBusy: (busy: boolean) => void;

  // --- session (Settings #205 / browser #203) ---
  setSession: (s: SpeleoSessionStatus) => void;
  setSessionFromLogin: (r: SpeleoLoginResult) => void;
  clearSession: () => void;
  /** Query `speleodb_session` and set it (best-effort; runs on project load so the
      action button knows who we are - e.g. to tell our own lock from another's). */
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
  clearDivergence: () => void;
  dismissBanner: () => void;
}

export const useSpeleoStore = create<SpeleoStore>((set, get) => ({
  session: null,
  link: null,
  divergence: null,
  banner: null,
  pollNonce: 0,
  busy: false,
  pendingAuth: null,
  authError: null,

  bumpPoll: () => set((state) => ({ pollNonce: state.pollNonce + 1 })),
  setBusy: (busy) => set({ busy }),

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
      /* ignore - clearSession still drops the local session */
    }
    set({ pendingAuth: null, authError: null });
    get().clearSession();
  },

  refreshLinkStatus: async () => {
    try {
      const status = await invokeIpc<SpeleoLinkStatus>('speleodb_link_status');
      get().seedFromStatus(status);
    } catch {
      // Best-effort - leave the prior link state (the backend gate is the
      // real enforcement; the shell just can't refresh its indicator).
    }
  },

  setSession: (s) =>
    set({
      session: {
        loggedIn: s.logged_in,
        userEmail: s.user_email ?? null,
        endpoint: s.endpoint ?? null,
        keychainBacked: s.keychain_backed,
      },
    }),

  refreshSession: async () => {
    try {
      const status = await invokeIpc<SpeleoSessionStatus>('speleodb_session');
      get().setSession(status);
    } catch {
      // Best-effort - leave whatever the store had.
    }
  },

  setSessionFromLogin: (r) =>
    set({
      session: {
        loggedIn: true,
        userEmail: r.user_email,
        endpoint: r.endpoint,
        keychainBacked: r.keychain_backed,
      },
    }),

  // A logout / dead-token drop can't act on the remote project anymore - the
  // backend drops its edit gate AND releases the lock on the same event - so fully
  // reset the link to a clean read-only state (keeping only the last-known
  // permission tier so the view-only glyph stays right). Leaving stale lockHolder /
  // dirty / lockedByOther / remoteState / noAccess / serverError behind would render
  // a self-contradictory button (e.g. yellow "click to edit" while still claiming we
  // hold the lock and have un-pushed edits). The shell offers Start editing again on
  // re-login, and the next poll re-seeds. (fix 4)
  clearSession: () =>
    set((state) => ({
      session: null,
      link: state.link
        ? {
            ...state.link,
            editState: 'read-only',
            lockHolder: null,
            lockedByOther: false,
            hasUnpushedEdits: false,
            // We can no longer verify the server relationship without a token, so
            // report Unknown (what a token-less backend poll returns) rather than
            // claiming up-to-date; the next poll re-resolves it.
            remoteState: 'unknown',
            noAccess: false,
            serverError: null,
          }
        : null,
      divergence: null,
      banner: null,
    })),

  seedFromStatus: (s) =>
    set((state) => {
      if (!s.is_remote) return { link: null, divergence: null, banner: null };
      const editState = s.edit_enabled ? 'editing' : 'read-only';
      return {
        link: {
          editState,
          // The network fields degrade to null/unknown offline - keep the
          // last-known permission rather than blanking the gate on a transient miss.
          permission: s.permission ?? state.link?.permission ?? null,
          lockHolder: s.lock_holder,
          // Read-only + a resolved holder ⟹ someone else holds it (the backend
          // gives us the gate when the lock is ours). Derived PURELY from this
          // poll's (editState, lockHolder), with NO "preserve prior" carry: once the
          // other holder releases (a later poll resolves no holder) the button stops
          // reading "locked by other" instead of sticking orange until a poll both
          // reaches the server AND happens to resolve a holder (fix 7). A transient
          // offline poll may briefly drop it to read-only; the next poll re-resolves,
          // and the backend gate stays the real enforcement.
          lockedByOther: editState !== 'editing' && !!s.lock_holder,
          hasUnpushedEdits: s.has_unpushed_edits,
          remoteState: s.remote_state,
          noAccess: s.access_denied,
          serverError: s.server_error,
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
        lockedByOther: false,
        hasUnpushedEdits: false,
        remoteState: 'up_to_date',
        noAccess: false,
        serverError: null,
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
          // We now hold the lock: not locked-by-other, no remote-ahead/conflict,
          // no stale banner. (fast_forwarded also reloads + re-seeds.)
          return {
            link: {
              ...state.link,
              editState: 'editing',
              lockedByOther: false,
              remoteState: 'up_to_date',
              serverError: null,
            },
            divergence: null,
            banner: null,
          };
        case 'divergence_needed':
          return { divergence: 'start' };
        case 'locked_by':
          // Someone else holds it - mark locked even when the holder email is
          // unknown (keep the last-known email rather than nulling it).
          return {
            link: {
              ...state.link,
              editState: 'read-only',
              lockHolder: r.email ?? state.link.lockHolder,
              lockedByOther: true,
            },
          };
        default:
          return {};
      }
    }),

  applyUpdate: (r) =>
    set((state) => {
      if (!state.link) return {};
      switch (r.kind) {
        case 'up_to_date':
          // Nothing to pull - clear any stale remote-ahead/conflict indicator so
          // the button doesn't keep showing "pull available" after a no-op refresh.
          return {
            link: { ...state.link, remoteState: 'up_to_date', serverError: null },
            divergence: null,
          };
        case 'divergence_needed':
          return { divergence: 'update' };
        // fast_forwarded: the caller reloads + re-seeds.
        default:
          return {};
      }
    }),

  applyDone: (r) =>
    set((state) => {
      if (!state.link) return {};
      switch (r.kind) {
        case 'released':
          // Lock released and edits are on the server - clear the holder (or we'd
          // read as still holding it), drop the dirty bit + any push-unconfirmed
          // banner, and reset the remote state.
          return {
            link: {
              ...state.link,
              editState: 'read-only',
              hasUnpushedEdits: false,
              lockHolder: null,
              lockedByOther: false,
              remoteState: 'up_to_date',
              serverError: null,
            },
            divergence: null,
            banner: null,
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
          // Lock retained (still editing); edits are now on the server. Clear a
          // prior push-unconfirmed banner since this push landed.
          return {
            link: {
              ...state.link,
              hasUnpushedEdits: false,
              remoteState: 'up_to_date',
              serverError: null,
            },
            banner: null,
          };
        case 'divergence_needed':
          return { divergence: 'push' };
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

  clearDivergence: () => set({ divergence: null }),
  dismissBanner: () => set({ banner: null }),
}));

/**
 * A remote SpeleoDB project opened without the write lock is read-only. Shared so
 * the toolbar, map read-only badge, and context menu all derive "read-only"
 * identically (the backend edit gate is the real enforcement; this is the visual
 * parity). Local projects (`link === null`) are never read-only via this path.
 */
export const selectSpeleoReadOnly = (s: SpeleoStore): boolean =>
  s.link ? s.link.editState !== 'editing' : false;
