import { create } from 'zustand';
import type {
  DoneResult,
  Permission,
  PushResult,
  RemoteState,
  SpeleoErrorDto,
  SpeleoLinkStatus,
  SpeleoLoginResult,
  SpeleoProjectSummary,
  SpeleoSessionStatus,
  StartEditingResult,
  UpdateResult,
} from '../types/ipc.generated';
import { invokeIpc } from '../utils/ipc';
import { emailsMatch } from '../utils/email';
import { useProjectStore } from './projectStore';

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

/** Which hand-off verb hit a divergence that needs the reconcile prompt (#198).
    `reverify` is the lazy 20-min lock re-verify (#202) catching a lost lock /
    moved tip mid-edit-session. */
export type DivergenceOrigin = 'start' | 'update' | 'done' | 'push' | 'reverify';

/** A banner the shell surfaces above the toolbar (#200/#204). `push_unconfirmed`
    and `concurrent_session` are transient action feedback; `rendering_disabled`
    (server `exclude_geojson`) and `no_anchor` (no georeferenced zero datum on
    push/unlock) are the #200 non-blocking notices. */
export type SpeleoBanner =
  | { kind: 'push_unconfirmed' }
  | { kind: 'concurrent_session' }
  | { kind: 'rendering_disabled' }
  | { kind: 'no_anchor' };

/** A SpeleoDB project whose write lock the current user holds, surfaced by the
    login/app-open scan so the resume/release prompt can offer to release it (#201). */
export interface HeldLock {
  projectId: string;
  projectName: string;
}

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
  /**
   * [#213] We are editing this remote project WITHOUT the write lock (force-edit):
   * `editState === 'editing'` but no lock is held, so the `.stalx` cannot be merged
   * until we reconnect and acquire the lock. Drives the persistent big-red banner
   * and routes the status button / lock menu to Reconnect (the existing
   * `startEditing`) instead of Done. Transient (backend-derived; resets on
   * open/close/reconnect).
   */
  forceEditing: boolean;
  /**
   * [#213] The `SpeleoDbConfig.allow_force_edit` opt-in (a global preference,
   * mirrored per-poll onto the link). Gates whether the read-only "Edit without
   * lock" affordance appears at all; false hides it and the backend also refuses.
   */
  forceEditAllowed: boolean;
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
  /**
   * [#218] The open remote project's SpeleoDB project id (from the poll'd status),
   * so the in-project menu can open its revision history. `null` for a local project
   * / none open / before the first status seed.
   */
  remoteProjectId: string | null;
  /** Set when a hand-off verb reported divergence; consumed by #198 (stub for now). */
  divergence: DivergenceOrigin | null;
  /** Transient banner (#200 seam). */
  banner: SpeleoBanner | null;
  /**
   * Lock holder per accessible SpeleoDB project (`project_id` → holder email, or
   * `null` = free), from the single login/app-open `list_projects` scan (#201).
   * Overlays lock badges onto the recents / GlobalView list; empty until the first
   * scan (logged out / offline).
   */
  remoteLocks: Record<string, string | null>;
  /**
   * SpeleoDB project NAME per accessible project (`project_id` → server-side name),
   * from the same login/app-open scan (#201). The recents list shows this
   * ("SpeleoDB: {name}") in place of the local path, since the server name can
   * differ from the local survey name. Empty until the first scan.
   */
  remoteProjects: Record<string, string>;
  /**
   * The full project summary per accessible project (`project_id` → summary), from
   * the same scan (#218). Retains permission / type_tag / latest_commit_sha so
   * GlobalView can list purely-remote projects (not in local recents) and Open them
   * without a second `list_projects` round trip. Superset of `remoteLocks` /
   * `remoteProjects`; empty until the first scan (logged out / offline).
   */
  remoteSummaries: Record<string, SpeleoProjectSummary>;
  /**
   * Locks the current user holds, found by the scan (#201). Populates the
   * resume/release prompt's list; a login/app-open scan that finds any also bumps
   * `heldLockPromptNonce` to raise the prompt.
   */
  heldLocks: HeldLock[] | null;
  /**
   * Visibility of the held-lock resume/release prompt. Set true only by a
   * PROMPT-worthy scan (login, or the first app-open scan) that finds held locks -
   * never by a routine badge refresh (returning to recents, the refresh button),
   * which is what stops it re-appearing on every visit. App renders the prompt as
   * an independent overlay keyed off this (NOT via the single `activeDialog` slot),
   * so it layers OVER an open dialog (e.g. Settings during an inline login) instead
   * of replacing it - the underlying dialog stays mounted and intact.
   */
  heldLockPromptOpen: boolean;
  /**
   * True until the first lock scan of the app session runs. Lets that first scan
   * count as PROMPT-worthy ("application first started") without a second GET,
   * then it stays false so later badge refreshes don't re-prompt.
   */
  heldLockPromptPending: boolean;
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

  // --- lock scan on login/app-open (#201, B1) ---
  /** One `list_projects` GET resolves lock state for ALL accessible projects:
      populates `remoteLocks` (badges) + `heldLocks` (the resume/release prompt).
      `prompt: true` (login) forces a prompt-worthy scan; the first app-open scan is
      prompt-worthy via `heldLockPromptPending`. Best-effort; a logged-out / offline
      scan clears the badges. */
  scanLocksOnOpen: (opts?: { prompt?: boolean }) => Promise<void>;
  /** Release EVERY lock this user holds (the prompt's "Release all"); on success
      clears `heldLocks`, re-scans, and refreshes the open project's link status. */
  releaseAllLocks: () => Promise<void>;
  /** Release ONE held lock by project id (the prompt's per-project "Release"); on
      success drops it from `heldLocks`, marks it free in `remoteLocks`, and refreshes
      the open project's link status. Throws on failure so the prompt can surface it. */
  releaseLock: (projectId: string) => Promise<void>;
  /** Dismiss the held-lock prompt without a server call (Do nothing / keep working). */
  clearHeldLocks: () => void;
  /** Hide the held-lock prompt overlay (its close paths use this, NOT the shared
      `closeDialog`, so it never closes the dialog it is layered over). */
  closeHeldLockPrompt: () => void;

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
  /**
   * #202: the lazy 20-min re-verify blocked an edit because the write lock was
   * lost or the server tip moved. Drop the shell to read-only + conflict (the
   * backend already dropped its edit gate) and raise the divergence prompt.
   */
  notifyReverifyDivergence: () => void;
  /** #200: after a push/unlock of a project with no georeferenced zero datum, note
      (non-blocking) that the server generated no new map GeoJSON. Only claims a free
      banner slot - never clobbers transient action feedback. */
  raiseNoAnchorBanner: () => void;
  /** #200 Enable-rendering: PATCH `exclude_geojson = false` so the server resumes
      web-viewer GeoJSON on the NEXT push (not retroactively). Clears the
      rendering-disabled banner and re-seeds link status. Throws on failure so the
      banner can surface it. */
  enableRendering: () => Promise<void>;
  dismissBanner: () => void;
}

export const useSpeleoStore = create<SpeleoStore>((set, get) => ({
  session: null,
  link: null,
  remoteProjectId: null,
  divergence: null,
  banner: null,
  remoteLocks: {},
  remoteProjects: {},
  remoteSummaries: {},
  heldLocks: null,
  heldLockPromptOpen: false,
  heldLockPromptPending: true,
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
        // #201: a fresh login is an "on login" scan point - surface any locks this
        // user left held (and prime the recents badges). `prompt: true` so it raises
        // the resume/release prompt even after the app-open scan already ran.
        void get().scanLocksOnOpen({ prompt: true });
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
    // Capture which project this poll/refresh is for BEFORE the await, and drop the
    // reply if the open project changed (switch / close / another load) while it was
    // in flight - so a stale status can't paint the previous project's lock holder /
    // remote-state / permission onto the newly-open one. Mirrors the load-time collab
    // detection + `checkProjectIntegrity` staleness guards. (fix S3)
    const requestedPath = useProjectStore.getState().project?.file_path ?? null;
    try {
      const status = await invokeIpc<SpeleoLinkStatus>('speleodb_link_status');
      if ((useProjectStore.getState().project?.file_path ?? null) !== requestedPath) return;
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

  scanLocksOnOpen: async (opts) => {
    // Ensure we know who we are before filtering held-by-me: on the app-open home
    // screen the frontend session may be cold even though the backend holds a
    // rehydrated token (which list_projects uses).
    if (!get().session) await get().refreshSession();
    const me = get().session?.userEmail?.toLowerCase();
    if (!get().session?.loggedIn || !me) {
      // Logged out: no badges, no prompt. Also force the overlay shut (not just its
      // pending flag) so a prompt open when the session ended can't linger. Consume
      // the app-open "pending" so a later return-to-recents (still using the pending
      // flag) can't retro-prompt; a subsequent login re-arms via its `prompt: true`.
      set({
        remoteLocks: {},
        remoteProjects: {},
        remoteSummaries: {},
        heldLocks: null,
        heldLockPromptPending: false,
        heldLockPromptOpen: false,
      });
      return;
    }
    try {
      const projects = await invokeIpc<SpeleoProjectSummary[]>('speleodb_list_projects');
      // Staleness guard: a logout / account switch can land while the list_projects
      // GET is in flight. Bail if the session moved so we never repaint the ended
      // session's badges or re-raise its prompt (mirrors refreshLinkStatus's guard).
      if (!get().session?.loggedIn || get().session?.userEmail?.toLowerCase() !== me) {
        return;
      }
      const remoteLocks: Record<string, string | null> = {};
      const remoteProjects: Record<string, string> = {};
      const remoteSummaries: Record<string, SpeleoProjectSummary> = {};
      const heldLocks: HeldLock[] = [];
      for (const p of projects) {
        remoteLocks[p.id] = p.lock_holder;
        remoteProjects[p.id] = p.name;
        remoteSummaries[p.id] = p;
        // Same ownership check the recents badge uses (emailsMatch), so the prompt's
        // held list and the badge's "locked by you" can't disagree.
        if (emailsMatch(p.lock_holder, me)) {
          heldLocks.push({ projectId: p.id, projectName: p.name });
        }
      }
      set((state) => {
        // Prompt on an explicit login/app-open scan (`prompt`), or on the FIRST scan
        // of the session (`heldLockPromptPending`) - never on a routine badge refresh
        // (returning to recents, the refresh button). That is what stops the prompt
        // re-appearing on every recents visit while still firing on login + app-start.
        const promptWorthy = opts?.prompt === true || state.heldLockPromptPending;
        return {
          remoteLocks,
          remoteProjects,
          remoteSummaries,
          heldLocks: heldLocks.length > 0 ? heldLocks : null,
          heldLockPromptPending: false,
          ...(promptWorthy && heldLocks.length > 0 ? { heldLockPromptOpen: true } : {}),
        };
      });
    } catch {
      // Best-effort: keep prior badges and never raise a prompt on a failed scan.
    }
  },

  releaseAllLocks: async () => {
    // Throws on failure so the dialog can keep itself open and surface the error;
    // heldLocks is cleared only on a confirmed release.
    await invokeIpc<null>('speleodb_release_all_locks');
    set({ heldLocks: null });
    await get().scanLocksOnOpen();
    await get().refreshLinkStatus();
  },

  releaseLock: async (projectId) => {
    // Throws on failure so the dialog keeps itself open and surfaces the error.
    await invokeIpc<null>('speleodb_release_lock', { projectId });
    // Optimistic local update (avoids a full re-scan per release when the user frees
    // several one by one): drop this lock from the prompt's list and mark the project
    // free in the badge map. `heldLocks` going empty is what auto-closes the dialog.
    set((state) => {
      const heldLocks = (state.heldLocks ?? []).filter((l) => l.projectId !== projectId);
      return {
        heldLocks: heldLocks.length > 0 ? heldLocks : null,
        remoteLocks: { ...state.remoteLocks, [projectId]: null },
      };
    });
    // If we just freed the OPEN project's own lock, re-seed its status indicator.
    await get().refreshLinkStatus();
  },

  clearHeldLocks: () => set({ heldLocks: null }),

  closeHeldLockPrompt: () => set({ heldLockPromptOpen: false }),

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
            // The backend drops the edit gate (and any force-edit) on a token loss,
            // so mirror that here or the shell would keep offering Reconnect.
            forceEditing: false,
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
      // The lock scan was for this now-ended session; drop its badges + prompt.
      remoteLocks: {},
      remoteProjects: {},
      remoteSummaries: {},
      heldLocks: null,
      heldLockPromptOpen: false,
    })),

  seedFromStatus: (s) =>
    set((state) => {
      if (!s.is_remote) return { link: null, remoteProjectId: null, divergence: null, banner: null };
      const editState = s.edit_enabled ? 'editing' : 'read-only';
      // #200: reflect the server's exclude_geojson as a persistent
      // rendering-disabled banner. It outranks the informational `no_anchor` notice
      // (rendering_disabled is actionable via Enable-rendering, and if both were true
      // no_anchor would otherwise mask the only way to reach that action), so claim
      // the slot when it is free OR held by no_anchor - but NEVER clobber transient
      // action feedback (push_unconfirmed / concurrent_session). Clear it only when
      // WE own the slot, so a routine poll never wipes another banner.
      const prior = state.banner;
      let banner = prior;
      if (s.exclude_geojson) {
        if (!prior || prior.kind === 'no_anchor') banner = { kind: 'rendering_disabled' };
      } else if (prior?.kind === 'rendering_disabled') {
        banner = null;
      }
      return {
        banner,
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
          // #213: force-edit (edit-enabled WITHOUT a held lock) is backend-authoritative
          // and reported every poll; a reconnect that acquires the lock clears it there.
          forceEditing: s.force_editing,
          forceEditAllowed: s.allow_force_edit,
          remoteState: s.remote_state,
          noAccess: s.access_denied,
          serverError: s.server_error,
        },
        // #218: the open remote project's id, for the in-project revision-history entry.
        remoteProjectId: s.project_id,
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
        // A fresh pull always opens without the lock and not force-editing;
        // `seedFromStatus` refines the opt-in + any force-edit on the first poll.
        forceEditing: false,
        forceEditAllowed: false,
        remoteState: 'up_to_date',
        noAccess: false,
        serverError: null,
      },
      divergence: null,
      banner: null,
    }),

  // Reset `busy` too: a hand-off verb in flight when the project closes/switches
  // would otherwise leave a freshly-opened project's status button disabled until
  // that verb's `finally` runs (its `apply*` no-op safely, guarded on `link`). (N2)
  clearLink: () => set({ link: null, remoteProjectId: null, divergence: null, banner: null, busy: false }),

  applyStartEditing: (r) =>
    set((state) => {
      if (!state.link) return {};
      switch (r.kind) {
        case 'editing':
        case 'fast_forwarded':
          // We now hold the lock: not locked-by-other, no remote-ahead/conflict,
          // no stale banner, and force-edit clears (Reconnect succeeded - #213).
          // (fast_forwarded also reloads + re-seeds.)
          return {
            link: {
              ...state.link,
              editState: 'editing',
              lockedByOther: false,
              forceEditing: false,
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
              // #213: a force-editor who tried to Reconnect and found the lock still
              // held keeps editing offline (the backend left its gate + force-edit on),
              // so preserve their editing state - only record the holder. A normal
              // read-only start downgrades to read-only as before.
              editState: state.link.forceEditing ? state.link.editState : 'read-only',
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

  notifyReverifyDivergence: () =>
    set((state) => ({
      divergence: 'reverify',
      link: state.link
        ? { ...state.link, editState: 'read-only', remoteState: 'conflict' }
        : state.link,
    })),

  raiseNoAnchorBanner: () =>
    set((state) => (state.banner ? {} : { banner: { kind: 'no_anchor' } })),

  enableRendering: async () => {
    // Throws on failure so the banner keeps itself open and shows the error.
    await invokeIpc<null>('speleodb_set_exclude_geojson', { exclude: false });
    // Drop the rendering-disabled banner (this resolved it) and re-seed from the
    // server so the flag reflects the change.
    set((state) => (state.banner?.kind === 'rendering_disabled' ? { banner: null } : {}));
    await get().refreshLinkStatus();
  },

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
