import { useEffect, useState } from 'react';
import { useUIStore } from '../../store/uiStore';
import { useProjectStore } from '../../store/projectStore';
import { invokeIpc, getErrorMessage } from '../../utils/ipc';
import { Button } from '../common/Button';
import { DialogWrapper } from './DialogWrapper';
import type {
  DoneResult,
  SpeleoLoginResult,
  SpeleoOpenResult,
  SpeleoProjectSummary,
  SpeleoSessionStatus,
  StartEditingResult,
  UpdateResult,
} from '../../types/ipc.generated';

/**
 * Dev-only spike dialog (#183): log in to SpeleoDB, list projects, and pull +
 * open one (read-only). The production "Open from SpeleoDB" menu + project
 * browser (permission/lock/type badges, F3) is #203 — this is intentionally
 * minimal and gated to dev builds (see GlobalView). The token is exchanged and
 * stored entirely backend-side; it never reaches this component.
 */
export default function SpeleoDbSpikeDialog() {
  const closeDialog = useUIStore((s) => s.closeDialog);
  // loadProject (not the deprecated openProject) drives the LoadingState progress UI.
  const loadProject = useProjectStore((s) => s.loadProject);

  // Start in 'checking' (not 'login') so the session-rehydration probe below can
  // settle BEFORE the first real view paints. Defaulting to 'login' made React
  // paint the login form on first render, then flip to 'list' once the async
  // probe resolved — a visible login-screen flash on every reopen of an already
  // logged-in session.
  const [phase, setPhase] = useState<'checking' | 'login' | 'list'>('checking');
  const [endpoint, setEndpoint] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [token, setToken] = useState('');
  const [useToken, setUseToken] = useState(false);

  const [projects, setProjects] = useState<SpeleoProjectSummary[]>([]);
  const [userEmail, setUserEmail] = useState('');
  const [keychainBacked, setKeychainBacked] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Dev sync trigger (#194/#197): the JSON outcome of the last sync action, shown
  // so the backend hand-off can be driven + verified by hand. Throwaway (#204).
  const [syncResult, setSyncResult] = useState<string | null>(null);

  const refreshProjects = async (isCancelled: () => boolean = () => false) => {
    const list = await invokeIpc<SpeleoProjectSummary[]>('speleodb_list_projects');
    // Skip the state write if the dialog was torn down while this was in flight
    // (Escape/backdrop close aren't gated by `busy`).
    if (!isCancelled()) setProjects(list);
  };

  // The backend token lives in AppState for the whole app run, but this dialog's
  // state resets every time it remounts (it's unmounted on close). On open, ask
  // whether a session already exists and jump straight to the project list so the
  // user isn't forced to re-log-in after opening a project. (#183)
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const status = await invokeIpc<SpeleoSessionStatus>('speleodb_session');
        if (cancelled) return;
        if (!status.logged_in) {
          // No live session → drop the 'checking' spinner and show the login form.
          setPhase('login');
          return;
        }
        setUserEmail(status.user_email ?? '');
        setKeychainBacked(status.keychain_backed);
        await refreshProjects(() => cancelled);
        if (!cancelled) setPhase('list');
      } catch {
        // Probe failed → fall back to the login form (never stay stuck on the
        // spinner).
        if (!cancelled) setPhase('login');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const handleLogin = async () => {
    // With a pasted token the email is derived from the API, so it isn't required
    // (or sent) here; password login still needs it as the login identity.
    if (!useToken && !email.trim()) {
      setError('Email is required');
      return;
    }
    if (useToken ? !token.trim() : !password) {
      setError(useToken ? 'Token is required' : 'Password is required');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const result = await invokeIpc<SpeleoLoginResult>('speleodb_login', {
        endpoint: endpoint.trim() || undefined,
        email: useToken ? undefined : email.trim(),
        password: useToken ? undefined : password,
        token: useToken ? token.trim() : undefined,
      });
      setUserEmail(result.user_email);
      setKeychainBacked(result.keychain_backed);
      await refreshProjects();
      setPhase('list');
    } catch (e) {
      setError(getErrorMessage(e, 'Login failed'));
    } finally {
      setBusy(false);
    }
  };

  const handleOpen = async (project: SpeleoProjectSummary) => {
    setBusy(true);
    setError(null);
    let localPath: string;
    try {
      const result = await invokeIpc<SpeleoOpenResult>('speleodb_open_project', {
        // [Track B] (#189) pass name + latest commit SHA so the backend stamps
        // the speleo_link row (is_remote) on the pulled .stalx.
        projectId: project.id,
        projectName: project.name,
        latestCommitSha: project.latest_commit_sha ?? null,
      });
      localPath = result.local_path;
    } catch (e) {
      // The pull failed while the dialog is still mounted — surface it here.
      setError(getErrorMessage(e, 'Open failed'));
      setBusy(false);
      return;
    }
    // Pull succeeded: close the spike dialog so loadProject's own LoadingState
    // progress UI is visible, then hand off. loadProject surfaces its own load
    // errors (it resolves with { success: false } rather than throwing), so there
    // is no setState-after-unmount path here.
    closeDialog();
    await loadProject(localPath);
  };

  const handleRefresh = async () => {
    setBusy(true);
    setError(null);
    try {
      await refreshProjects();
    } catch (e) {
      // A server-side-revoked token first surfaces here (status isn't re-validated
      // against the server), so a rejected list must be shown, not swallowed.
      setError(getErrorMessage(e, 'Could not refresh projects'));
    } finally {
      setBusy(false);
    }
  };

  const handleLogout = async () => {
    setBusy(true);
    setError(null);
    try {
      await invokeIpc<null>('speleodb_logout');
      setProjects([]);
      setPassword('');
      setToken('');
      setPhase('login');
    } catch (e) {
      setError(getErrorMessage(e, 'Logout failed'));
    } finally {
      setBusy(false);
    }
  };

  // --- Dev sync trigger (#194/#197): act on the currently-open project ---
  // These drive the single-writer hand-off by hand. Open a remote project first
  // (the Open button closes this dialog), then reopen it to use these.
  const runSync = async (label: string, op: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    setSyncResult(null);
    try {
      setSyncResult(`${label}: ${JSON.stringify(await op())}`);
    } catch (e) {
      setError(getErrorMessage(e, `${label} failed`));
    } finally {
      setBusy(false);
    }
  };

  const handleStartEditing = () =>
    runSync('start_editing', () => invokeIpc<StartEditingResult>('speleodb_start_editing'));
  const handleDone = () =>
    runSync('done', () => invokeIpc<DoneResult>('speleodb_done', { message: null }));
  const handleUpdate = () =>
    runSync('update', () => invokeIpc<UpdateResult>('speleodb_update'));

  return (
    <DialogWrapper
      title="Open from SpeleoDB (spike)"
      onClose={closeDialog}
      size="lg"
      data-testid="speleodb-spike-dialog"
    >
      <div className="space-y-4">
        {error && (
          <div className="p-3 bg-error-10 border border-error-20 rounded text-error text-sm" data-testid="speleodb-error">
            {error}
          </div>
        )}

        {phase === 'checking' ? (
          <div
            data-testid="speleodb-checking"
            className="flex flex-col items-center justify-center gap-2 py-10"
          >
            <div className="w-6 h-6 border-2 border-accent border-t-transparent rounded-full animate-spin" />
            <span className="text-xs text-text-secondary">Checking session…</span>
          </div>
        ) : phase === 'login' ? (
          <>
            <p className="text-sm text-text-secondary">
              Dev spike (#183). Leave the endpoint blank to use <code>DEV_SPELEODB_URL</code>.
            </p>
            <div>
              <label className="block text-sm text-text-secondary mb-1">Endpoint (optional)</label>
              <input
                type="text"
                value={endpoint}
                onChange={(e) => setEndpoint(e.target.value)}
                className="w-full"
                placeholder="http://10.10.0.220:8000/"
                data-testid="speleodb-endpoint-input"
              />
            </div>
            {!useToken && (
              <div>
                <label className="block text-sm text-text-secondary mb-1">Email *</label>
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="w-full"
                  data-testid="speleodb-email-input"
                />
              </div>
            )}
            <div className="flex items-center gap-2">
              <input
                type="checkbox"
                id="speleodb-use-token"
                checked={useToken}
                onChange={(e) => setUseToken(e.target.checked)}
                className="rounded"
                data-testid="speleodb-use-token"
              />
              <label htmlFor="speleodb-use-token" className="text-sm">
                Paste an existing token instead of a password
              </label>
            </div>
            {useToken ? (
              <div>
                <label className="block text-sm text-text-secondary mb-1">Token *</label>
                <input
                  type="password"
                  value={token}
                  onChange={(e) => setToken(e.target.value)}
                  className="w-full"
                  data-testid="speleodb-token-input"
                />
                <p className="mt-1 text-xs text-text-secondary">
                  Your account is identified from the token — no email needed.
                </p>
              </div>
            ) : (
              <div>
                <label className="block text-sm text-text-secondary mb-1">Password *</label>
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="w-full"
                  data-testid="speleodb-password-input"
                />
              </div>
            )}
            <div className="flex justify-end gap-2 pt-4 border-t border-border">
              <Button onClick={closeDialog} disabled={busy} data-testid="speleodb-cancel-button">
                Cancel
              </Button>
              <Button
                variant="primary"
                onClick={handleLogin}
                disabled={busy || (useToken ? !token.trim() : !email.trim())}
                data-testid="speleodb-login-button"
              >
                {busy ? 'Connecting…' : 'Log in'}
              </Button>
            </div>
          </>
        ) : (
          <>
            <div className="flex items-center justify-between gap-3">
              <p className="text-sm text-text-secondary truncate">
                Signed in as {userEmail}
                {keychainBacked ? '' : ' · token kept in memory only (no keychain)'}
              </p>
              <Button onClick={handleLogout} disabled={busy} data-testid="speleodb-logout-button">
                Log out
              </Button>
            </div>

            {projects.length === 0 ? (
              <p className="text-sm text-text-secondary">No projects visible to this account.</p>
            ) : (
              <ul className="divide-y divide-border border border-border rounded" data-testid="speleodb-project-list">
                {projects.map((p) => (
                  <li key={p.id} className="flex items-center justify-between gap-3 p-3">
                    <div className="min-w-0">
                      <div className="truncate text-sm text-text-primary">{p.name}</div>
                      <div className="text-xs text-text-secondary truncate">
                        {p.permission ?? 'NO ACCESS'} · {p.type_tag}
                        {p.lock_holder ? ` · locked by ${p.lock_holder}` : ''}
                      </div>
                    </div>
                    <Button
                      variant="primary"
                      onClick={() => void handleOpen(p)}
                      disabled={busy}
                      data-testid={`speleodb-open-${p.id}`}
                    >
                      Open
                    </Button>
                  </li>
                ))}
              </ul>
            )}

            <div
              className="space-y-2 pt-4 border-t border-border"
              data-testid="speleodb-sync-actions"
            >
              <p className="text-xs text-text-secondary">
                Sync (dev) — acts on the currently-open project. Open a project (this
                dialog closes), then reopen it and use these.
              </p>
              <div className="flex gap-2">
                <Button
                  onClick={() => void handleStartEditing()}
                  disabled={busy}
                  data-testid="speleodb-start-editing-button"
                >
                  Start editing
                </Button>
                <Button
                  onClick={() => void handleDone()}
                  disabled={busy}
                  data-testid="speleodb-done-button"
                >
                  Done
                </Button>
                <Button
                  onClick={() => void handleUpdate()}
                  disabled={busy}
                  data-testid="speleodb-update-button"
                >
                  Update
                </Button>
              </div>
              {syncResult && (
                <pre
                  className="text-xs text-text-secondary whitespace-pre-wrap break-all"
                  data-testid="speleodb-sync-result"
                >
                  {syncResult}
                </pre>
              )}
            </div>

            <div className="flex justify-end gap-2 pt-4 border-t border-border">
              <Button onClick={() => void handleRefresh()} disabled={busy}>
                Refresh
              </Button>
              <Button onClick={closeDialog} disabled={busy}>
                Close
              </Button>
            </div>
          </>
        )}
      </div>
    </DialogWrapper>
  );
}
