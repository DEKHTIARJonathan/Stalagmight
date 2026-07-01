import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useUIStore } from '../../store/uiStore';
import { useProjectStore } from '../../store/projectStore';
import { useSpeleoStore } from '../../store/speleoStore';
import { invokeIpc, getErrorMessage } from '../../utils/ipc';
import { speleoErrorAction } from '../../utils/speleoError';
import { Button } from '../common/Button';
import { DialogWrapper } from './DialogWrapper';
import type {
  SpeleoOpenResult,
  SpeleoProjectSummary,
  SpeleoSessionStatus,
} from '../../types/ipc.generated';

/**
 * Production "Open from SpeleoDB" browser (#203). Lists the remote projects
 * visible to the logged-in account with permission / lock / type badges, filters
 * by name, and pulls + opens one read-only (the backend edit gate keeps it
 * read-only until Start editing — #204). Replaces the dev spike's list half;
 * login now lives in Settings (#205), so this dialog only browses + opens.
 */
export default function OpenFromSpeleoDbDialog() {
  const { t } = useTranslation();
  const closeDialog = useUIStore((s) => s.closeDialog);
  const openDialog = useUIStore((s) => s.openDialog);
  const showToast = useUIStore((s) => s.showToast);
  // loadProject (not openProject) drives the LoadingState progress UI.
  const loadProject = useProjectStore((s) => s.loadProject);
  const session = useSpeleoStore((s) => s.session);
  const setSession = useSpeleoStore((s) => s.setSession);
  const clearSession = useSpeleoStore((s) => s.clearSession);
  const setLinkOnOpen = useSpeleoStore((s) => s.setLinkOnOpen);

  // Start in 'checking' so the session probe settles before the first paint
  // (avoids a logged-out flash for an already-authenticated session).
  const [phase, setPhase] = useState<'checking' | 'logged-out' | 'list'>('checking');
  const [projects, setProjects] = useState<SpeleoProjectSummary[]>([]);
  const [filter, setFilter] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refreshProjects = async (isCancelled: () => boolean = () => false) => {
    const list = await invokeIpc<SpeleoProjectSummary[]>('speleodb_list_projects');
    if (!isCancelled()) setProjects(list);
  };

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const status = await invokeIpc<SpeleoSessionStatus>('speleodb_session');
        if (cancelled) return;
        setSession(status);
        if (!status.logged_in) {
          setPhase('logged-out');
          return;
        }
        await refreshProjects(() => cancelled);
        if (!cancelled) setPhase('list');
      } catch (e) {
        if (cancelled) return;
        // A dead token surfaces here — drop the session and prompt a re-login.
        if (speleoErrorAction(e) === 'ReLogin') clearSession();
        setError(getErrorMessage(e, t('speleodb.browser.listFailed')));
        setPhase('logged-out');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [setSession, clearSession, t]);

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return projects;
    return projects.filter((p) => p.name.toLowerCase().includes(q));
  }, [projects, filter]);

  const handleRefresh = async () => {
    setBusy(true);
    setError(null);
    try {
      await refreshProjects();
    } catch (e) {
      if (speleoErrorAction(e) === 'ReLogin') {
        clearSession();
        setPhase('logged-out');
      }
      setError(getErrorMessage(e, t('speleodb.browser.listFailed')));
    } finally {
      setBusy(false);
    }
  };

  const handleOpen = async (project: SpeleoProjectSummary) => {
    setBusy(true);
    setError(null);
    let result: SpeleoOpenResult;
    try {
      result = await invokeIpc<SpeleoOpenResult>('speleodb_open_project', {
        // [Track B] (#189) pass name + latest SHA so the backend stamps the
        // speleo_link row (is_remote) on the pulled .stalx.
        projectId: project.id,
        projectName: project.name,
        latestCommitSha: project.latest_commit_sha ?? null,
      });
    } catch (e) {
      setError(getErrorMessage(e, t('speleodb.browser.openFailed')));
      if (speleoErrorAction(e) === 'ReLogin') {
        clearSession();
        setPhase('logged-out');
      }
      setBusy(false);
      return;
    }
    // #193 b8: a lock held by THIS account at open time = a second same-account
    // session; warn (keyed so repeat opens don't stack duplicate toasts).
    if (result.concurrent_session) {
      showToast(t('speleodb.browser.concurrentSession'), 'speleodb-concurrent-session');
    }
    // Seed the action shell (#204) with the permission we already know from the
    // summary, so it can gate Start editing before the async status settles.
    setLinkOnOpen({ permission: project.permission });
    // Close so loadProject's own LoadingState progress is visible, then hand off.
    closeDialog();
    await loadProject(result.local_path);
  };

  const goToLogin = () => openDialog('settings', { initialCategory: 'speleodb' });

  return (
    <DialogWrapper
      title={t('speleodb.browser.title')}
      onClose={closeDialog}
      size="lg"
      data-testid="open-from-speleodb-dialog"
    >
      <div className="space-y-4">
        {error && (
          <div
            className="p-3 bg-error-10 border border-error-20 rounded text-error text-sm"
            data-testid="open-from-speleodb-error"
          >
            {error}
          </div>
        )}

        {phase === 'checking' ? (
          <div
            data-testid="open-from-speleodb-checking"
            className="flex flex-col items-center justify-center gap-2 py-10"
          >
            <div className="w-6 h-6 border-2 border-accent border-t-transparent rounded-full animate-spin" />
            <span className="text-xs text-text-secondary">{t('speleodb.browser.checking')}</span>
          </div>
        ) : phase === 'logged-out' ? (
          <div className="space-y-3 py-6 text-center" data-testid="open-from-speleodb-logged-out">
            <p className="text-sm text-text-secondary">{t('speleodb.browser.loginPrompt')}</p>
            <Button variant="primary" onClick={goToLogin} data-testid="open-from-speleodb-go-login">
              {t('speleodb.browser.goToSettings')}
            </Button>
          </div>
        ) : (
          <>
            <input
              type="text"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              className="w-full px-2 py-1 bg-background border border-border rounded text-sm"
              placeholder={t('speleodb.browser.filterPlaceholder')}
              aria-label={t('speleodb.browser.filterPlaceholder')}
              data-testid="open-from-speleodb-filter"
            />

            {filtered.length === 0 ? (
              <p className="text-sm text-text-secondary" data-testid="open-from-speleodb-empty">
                {projects.length === 0
                  ? t('speleodb.browser.noProjects')
                  : t('speleodb.browser.noMatches')}
              </p>
            ) : (
              <ul
                className="divide-y divide-border border border-border rounded max-h-80 overflow-auto"
                data-testid="open-from-speleodb-list"
              >
                {filtered.map((p) => (
                  <li key={p.id} className="flex items-center justify-between gap-3 p-3">
                    <div className="min-w-0">
                      <div className="truncate text-sm text-text-primary">{p.name}</div>
                      <div className="mt-1 flex flex-wrap items-center gap-1.5">
                        <span
                          className={`px-1.5 py-0.5 rounded text-xs ${
                            p.permission ? 'bg-accent-10 text-accent' : 'bg-error-10 text-error'
                          }`}
                        >
                          {p.permission ?? t('speleodb.browser.noAccess')}
                        </span>
                        <span className="px-1.5 py-0.5 rounded text-xs bg-panel border border-border text-text-secondary">
                          {p.type_tag}
                        </span>
                        {p.lock_holder && (
                          <span className="px-1.5 py-0.5 rounded text-xs bg-warning-20 text-warning">
                            {t('speleodb.browser.lockedBy', { email: p.lock_holder })}
                          </span>
                        )}
                      </div>
                    </div>
                    <Button
                      variant="primary"
                      onClick={() => void handleOpen(p)}
                      disabled={busy}
                      data-testid={`open-from-speleodb-open-${p.id}`}
                    >
                      {t('speleodb.browser.open')}
                    </Button>
                  </li>
                ))}
              </ul>
            )}

            <div className="flex items-center justify-between gap-3 pt-2">
              <span className="text-xs text-text-secondary truncate">
                {session?.userEmail
                  ? t('speleodb.browser.signedInAs', { email: session.userEmail })
                  : ''}
              </span>
              <div className="flex gap-2">
                <Button onClick={() => void handleRefresh()} disabled={busy}>
                  {t('speleodb.browser.refresh')}
                </Button>
                <Button onClick={closeDialog} disabled={busy}>
                  {t('common.actions.close')}
                </Button>
              </div>
            </div>
          </>
        )}
      </div>
    </DialogWrapper>
  );
}
