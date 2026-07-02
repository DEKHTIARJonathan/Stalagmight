import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { SettingsSection } from './SettingsSection';
import { Button } from '../../common/Button';
import { useUIStore } from '../../../store/uiStore';
import { useSpeleoStore } from '../../../store/speleoStore';
import { useProjectStore } from '../../../store/projectStore';
import { invokeIpc } from '../../../utils/ipc';
import { humanizeSpeleoError } from '../../../utils/speleoError';
import { permissionAtLeast } from '../../../utils/speleoPermission';
import type {
  Permission,
  SpeleoCollaborators,
  SpeleoTeamOption,
} from '../../../types/ipc.generated';

// Levels a USER collaborator can be granted. Teams may never hold ADMIN (the
// server rejects it), so the team picker omits it.
const USER_LEVELS: readonly Permission[] = ['WEB_VIEWER', 'READ_ONLY', 'READ_AND_WRITE', 'ADMIN'];
const TEAM_LEVELS: readonly Permission[] = ['WEB_VIEWER', 'READ_ONLY', 'READ_AND_WRITE'];

const inputClass =
  'w-full px-2 py-1 bg-background border border-border rounded text-sm disabled:opacity-60';

/**
 * [#215] The admin half of the Project Settings SpeleoDB tab: collaborator
 * management (individual users + teams, incl. the WEB_VIEWER tier), in-app lock
 * release, and project delete. Only mounted for a remote project. Viewing the
 * roster needs READ_ONLY+; every mutation needs ADMIN (the server 401/403 is the
 * real gate - the UI only mirrors the level and surfaces the error).
 */
export function SpeleoProjectAdmin() {
  const { t } = useTranslation();
  const showToast = useUIStore((s) => s.showToast);
  const closeDialog = useUIStore((s) => s.closeDialog);
  const link = useSpeleoStore((s) => s.link);
  const refreshLinkStatus = useSpeleoStore((s) => s.refreshLinkStatus);
  const clearLink = useSpeleoStore((s) => s.clearLink);
  const projectName = useProjectStore((s) => s.project?.name ?? '');

  const canManage = permissionAtLeast(link?.permission, 'ADMIN');

  const [roster, setRoster] = useState<SpeleoCollaborators | null>(null);
  const [teams, setTeams] = useState<SpeleoTeamOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [newEmail, setNewEmail] = useState('');
  const [newLevel, setNewLevel] = useState<Permission>('READ_ONLY');
  const [newTeamId, setNewTeamId] = useState('');
  const [newTeamLevel, setNewTeamLevel] = useState<Permission>('READ_ONLY');

  const [releasing, setReleasing] = useState(false);
  const [confirmName, setConfirmName] = useState('');
  const [deleting, setDeleting] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const list = await invokeIpc<SpeleoCollaborators>('speleodb_list_collaborators');
      setRoster(list);
      // Only an admin can add, so only an admin needs the team picker.
      if (permissionAtLeast(link?.permission, 'ADMIN')) {
        setTeams(await invokeIpc<SpeleoTeamOption[]>('speleodb_list_teams'));
      }
    } catch (e) {
      setLoadError(humanizeSpeleoError(e, t('speleodb.collaborators.loadFailed')));
    } finally {
      setLoading(false);
    }
  }, [link?.permission, t]);

  useEffect(() => {
    void load();
  }, [load]);

  // Run a roster mutation, folding the returned server-truth roster back in. All
  // errors surface as a toast; the roster is left untouched on failure.
  const mutate = useCallback(
    async (op: () => Promise<SpeleoCollaborators>, failKey: string) => {
      setBusy(true);
      try {
        setRoster(await op());
      } catch (e) {
        showToast(humanizeSpeleoError(e, t(failKey)), 'speleodb-collaborators');
      } finally {
        setBusy(false);
      }
    },
    [showToast, t],
  );

  const addUser = useCallback(() => {
    const email = newEmail.trim();
    if (!email) return;
    void mutate(
      () =>
        invokeIpc<SpeleoCollaborators>('speleodb_add_collaborator', {
          email,
          permission: newLevel,
        }).then((r) => {
          setNewEmail('');
          return r;
        }),
      'speleodb.collaborators.addFailed',
    );
  }, [mutate, newEmail, newLevel]);

  const addTeam = useCallback(() => {
    if (!newTeamId) return;
    void mutate(
      () =>
        invokeIpc<SpeleoCollaborators>('speleodb_add_team', {
          teamId: newTeamId,
          permission: newTeamLevel,
        }).then((r) => {
          setNewTeamId('');
          return r;
        }),
      'speleodb.collaborators.addTeamFailed',
    );
  }, [mutate, newTeamId, newTeamLevel]);

  const handleRelease = useCallback(async () => {
    setReleasing(true);
    try {
      await invokeIpc('speleodb_release_current_lock');
      await refreshLinkStatus();
      showToast(t('speleodb.lock.released'), 'speleodb-lock');
    } catch (e) {
      showToast(humanizeSpeleoError(e, t('speleodb.lock.releaseFailed')), 'speleodb-lock');
    } finally {
      setReleasing(false);
    }
  }, [refreshLinkStatus, showToast, t]);

  const handleDelete = useCallback(async () => {
    setDeleting(true);
    try {
      await invokeIpc('speleodb_delete_project');
      // The server soft-deleted it and the backend already unlinked locally; drop
      // the FE link so the tab collapses to a plain local project, then close.
      clearLink();
      showToast(t('speleodb.delete.deleted'), 'speleodb-delete');
      closeDialog();
    } catch (e) {
      showToast(humanizeSpeleoError(e, t('speleodb.delete.deleteFailed')), 'speleodb-delete');
      setDeleting(false);
    }
  }, [clearLink, closeDialog, showToast, t]);

  const levelLabel = (p: Permission) => t(`speleodb.collaborators.levels.${p}`);

  if (loading) {
    return (
      <p className="text-text-secondary text-sm" data-testid="speleodb-collaborators-loading">
        {t('speleodb.collaborators.loading')}
      </p>
    );
  }

  if (loadError || !roster) {
    return (
      <div className="space-y-3" data-testid="speleodb-collaborators-error">
        <p className="text-error text-sm">{loadError ?? t('speleodb.collaborators.loadFailed')}</p>
        <Button
          variant="secondary"
          onClick={() => void load()}
          data-testid="speleodb-collaborators-retry"
        >
          {t('speleodb.collaborators.retry')}
        </Button>
      </div>
    );
  }

  const holder = link?.lockHolder ?? null;
  const iHoldLock = link?.editState === 'editing';

  return (
    <div data-testid="speleodb-project-admin">
      {/* Collaborators (users + teams) */}
      <SettingsSection title={t('speleodb.collaborators.title')}>
        {!canManage && (
          <div
            className="mb-3 inline-block text-xs px-1.5 py-0.5 bg-warning-20 text-warning rounded"
            data-testid="speleodb-collaborators-readonly-badge"
          >
            {t('speleodb.collaborators.readOnlyBadge')}
          </div>
        )}

        <p className="text-text-secondary text-xs mb-2" data-testid="speleodb-collaborators-webviewer-note">
          {t('speleodb.collaborators.webViewerNote')}
        </p>

        <ul className="space-y-1" data-testid="speleodb-collaborators-users">
          {roster.users.map((u) => (
            <li key={u.email} className="flex items-center gap-2" data-testid={`speleodb-collab-user-${u.email}`}>
              <span className="flex-1 min-w-0 truncate text-sm">
                {u.email}
                {u.is_self && (
                  <span className="text-text-secondary text-xs"> {t('speleodb.collaborators.you')}</span>
                )}
              </span>
              {canManage && !u.is_self ? (
                <>
                  <select
                    value={u.permission}
                    disabled={busy}
                    onChange={(e) =>
                      void mutate(
                        () =>
                          invokeIpc<SpeleoCollaborators>('speleodb_set_collaborator', {
                            email: u.email,
                            permission: e.target.value as Permission,
                          }),
                        'speleodb.collaborators.changeFailed',
                      )
                    }
                    className="px-1 py-0.5 bg-background border border-border rounded text-xs"
                    aria-label={t('speleodb.collaborators.levelFor', { name: u.email })}
                    data-testid={`speleodb-collab-user-level-${u.email}`}
                  >
                    {USER_LEVELS.map((p) => (
                      <option key={p} value={p}>
                        {levelLabel(p)}
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() =>
                      void mutate(
                        () =>
                          invokeIpc<SpeleoCollaborators>('speleodb_remove_collaborator', {
                            email: u.email,
                          }),
                        'speleodb.collaborators.removeFailed',
                      )
                    }
                    className="text-error text-xs hover:underline disabled:opacity-60"
                    data-testid={`speleodb-collab-user-remove-${u.email}`}
                  >
                    {t('speleodb.collaborators.remove')}
                  </button>
                </>
              ) : (
                <span className="text-text-secondary text-xs">{levelLabel(u.permission)}</span>
              )}
            </li>
          ))}
        </ul>

        {roster.teams.length > 0 && (
          <ul className="space-y-1 mt-2 pt-2 border-t border-border" data-testid="speleodb-collaborators-teams">
            {roster.teams.map((g) => (
              <li key={g.team_id} className="flex items-center gap-2" data-testid={`speleodb-collab-team-${g.team_id}`}>
                <span className="flex-1 min-w-0 truncate text-sm">
                  {g.team_name}
                  <span className="text-text-secondary text-xs"> {t('speleodb.collaborators.teamTag')}</span>
                </span>
                {canManage ? (
                  <>
                    <select
                      value={g.permission}
                      disabled={busy}
                      onChange={(e) =>
                        void mutate(
                          () =>
                            invokeIpc<SpeleoCollaborators>('speleodb_set_team', {
                              teamId: g.team_id,
                              permission: e.target.value as Permission,
                            }),
                          'speleodb.collaborators.changeFailed',
                        )
                      }
                      className="px-1 py-0.5 bg-background border border-border rounded text-xs"
                      aria-label={t('speleodb.collaborators.levelFor', { name: g.team_name })}
                      data-testid={`speleodb-collab-team-level-${g.team_id}`}
                    >
                      {TEAM_LEVELS.map((p) => (
                        <option key={p} value={p}>
                          {levelLabel(p)}
                        </option>
                      ))}
                    </select>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() =>
                        void mutate(
                          () =>
                            invokeIpc<SpeleoCollaborators>('speleodb_remove_team', {
                              teamId: g.team_id,
                            }),
                          'speleodb.collaborators.removeFailed',
                        )
                      }
                      className="text-error text-xs hover:underline disabled:opacity-60"
                      data-testid={`speleodb-collab-team-remove-${g.team_id}`}
                    >
                      {t('speleodb.collaborators.remove')}
                    </button>
                  </>
                ) : (
                  <span className="text-text-secondary text-xs">{levelLabel(g.permission)}</span>
                )}
              </li>
            ))}
          </ul>
        )}

        {canManage && (
          <div className="mt-3 pt-3 border-t border-border space-y-2">
            <div className="flex items-center gap-2">
              <input
                type="email"
                value={newEmail}
                disabled={busy}
                placeholder={t('speleodb.collaborators.emailPlaceholder')}
                onChange={(e) => setNewEmail(e.target.value)}
                className={inputClass}
                aria-label={t('speleodb.collaborators.addUser')}
                data-testid="speleodb-collaborators-add-email"
              />
              <select
                value={newLevel}
                disabled={busy}
                onChange={(e) => setNewLevel(e.target.value as Permission)}
                className="px-1 py-1 bg-background border border-border rounded text-sm"
                aria-label={t('speleodb.collaborators.addLevel')}
                data-testid="speleodb-collaborators-add-level"
              >
                {USER_LEVELS.map((p) => (
                  <option key={p} value={p}>
                    {levelLabel(p)}
                  </option>
                ))}
              </select>
              <Button
                variant="secondary"
                disabled={busy || newEmail.trim() === ''}
                onClick={addUser}
                data-testid="speleodb-collaborators-add-user"
              >
                {t('speleodb.collaborators.add')}
              </Button>
            </div>

            {teams.length > 0 && (
              <div className="flex items-center gap-2">
                <select
                  value={newTeamId}
                  disabled={busy}
                  onChange={(e) => setNewTeamId(e.target.value)}
                  className={inputClass}
                  aria-label={t('speleodb.collaborators.addTeam')}
                  data-testid="speleodb-collaborators-add-team-id"
                >
                  <option value="" disabled>
                    {t('speleodb.collaborators.teamPlaceholder')}
                  </option>
                  {teams.map((tm) => (
                    <option key={tm.id} value={tm.id}>
                      {tm.name}
                    </option>
                  ))}
                </select>
                <select
                  value={newTeamLevel}
                  disabled={busy}
                  onChange={(e) => setNewTeamLevel(e.target.value as Permission)}
                  className="px-1 py-1 bg-background border border-border rounded text-sm"
                  aria-label={t('speleodb.collaborators.addTeamLevel')}
                  data-testid="speleodb-collaborators-add-team-level"
                >
                  {TEAM_LEVELS.map((p) => (
                    <option key={p} value={p}>
                      {levelLabel(p)}
                    </option>
                  ))}
                </select>
                <Button
                  variant="secondary"
                  disabled={busy || newTeamId === ''}
                  onClick={addTeam}
                  data-testid="speleodb-collaborators-add-team"
                >
                  {t('speleodb.collaborators.add')}
                </Button>
              </div>
            )}
          </div>
        )}
      </SettingsSection>

      {/* Lock */}
      <SettingsSection title={t('speleodb.lock.title')}>
        {holder ? (
          <>
            <p className="text-sm mb-2" data-testid="speleodb-lock-holder">
              {iHoldLock
                ? t('speleodb.lock.heldByYou')
                : t('speleodb.lock.heldBy', { email: holder })}
            </p>
            {iHoldLock && (
              <p className="text-warning text-xs mb-2" data-testid="speleodb-lock-self-warning">
                {t('speleodb.lock.selfWarning')}
              </p>
            )}
            <Button
              variant="secondary"
              disabled={releasing}
              onClick={() => void handleRelease()}
              data-testid="speleodb-lock-release"
            >
              {releasing ? t('speleodb.lock.releasing') : t('speleodb.lock.releaseButton')}
            </Button>
          </>
        ) : (
          <p className="text-text-secondary text-sm" data-testid="speleodb-lock-none">
            {t('speleodb.lock.none')}
          </p>
        )}
      </SettingsSection>

      {/* Danger zone: delete */}
      {canManage && (
        <SettingsSection title={t('speleodb.delete.title')}>
          <p className="text-text-secondary text-xs mb-2" data-testid="speleodb-delete-warning">
            {t('speleodb.delete.warning')}
          </p>
          <label className="block text-sm mb-1" htmlFor="speleodb-delete-confirm">
            {t('speleodb.delete.confirmLabel', { name: projectName })}
          </label>
          <input
            id="speleodb-delete-confirm"
            type="text"
            value={confirmName}
            disabled={deleting}
            onChange={(e) => setConfirmName(e.target.value)}
            className={inputClass}
            data-testid="speleodb-delete-confirm-input"
          />
          <div className="mt-2">
            <Button
              variant="danger"
              disabled={deleting || confirmName.trim() !== projectName.trim() || projectName === ''}
              onClick={() => void handleDelete()}
              data-testid="speleodb-delete-button"
            >
              {deleting ? t('speleodb.delete.deleting') : t('speleodb.delete.deleteButton')}
            </Button>
          </div>
        </SettingsSection>
      )}
    </div>
  );
}
