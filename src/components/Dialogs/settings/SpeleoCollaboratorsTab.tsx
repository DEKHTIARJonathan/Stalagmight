import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { SettingsSection } from './SettingsSection';
import { Button } from '../../common/Button';
import { SpeleoUserAutocomplete } from '../../common/SpeleoUserAutocomplete';
import { useUIStore } from '../../../store/uiStore';
import { useSpeleoStore } from '../../../store/speleoStore';
import { useSpeleoWebLink } from '../../../hooks/useSpeleoWebLink';
import { invokeIpc } from '../../../utils/ipc';
import { humanizeSpeleoError } from '../../../utils/speleoError';
import { permissionAtLeast, USER_LEVELS, TEAM_LEVELS } from '../../../utils/speleoPermission';
import type { Permission, SpeleoCollaborators, SpeleoTeamOption } from '../../../types/ipc.generated';

const inputClass =
  'w-full px-2 py-1 bg-background border border-border rounded text-sm disabled:opacity-60';

/**
 * [#215] The Collaborators tab of the SpeleoDB project dialog: individual users +
 * teams (incl. the WEB_VIEWER tier). Viewing the roster needs READ_ONLY+; every
 * mutation needs ADMIN (the server 401/403 is the real gate - the UI only mirrors
 * the level and surfaces the error).
 */
export function SpeleoCollaboratorsTab() {
  const { t } = useTranslation();
  const showToast = useUIStore((s) => s.showToast);
  const link = useSpeleoStore((s) => s.link);
  const web = useSpeleoWebLink('permissions/user');

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
        showToast(humanizeSpeleoError(e, t(failKey)), 'speleodb-collaborators', 'error');
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

  const levelLabel = (p: Permission) => t(`speleodb.collaborators.levels.${p}`);

  return (
    <div data-testid="speleodb-collaborators-tab">
      {loading ? (
        <p className="text-text-secondary text-sm" data-testid="speleodb-collaborators-loading">
          {t('speleodb.collaborators.loading')}
        </p>
      ) : loadError || !roster ? (
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
      ) : (
        <SettingsSection title={t('speleodb.collaborators.title')}>
          <div className="flex justify-end">
            <button
              type="button"
              disabled={web.url === null}
              title={web.url === null ? t('speleodb.web.unavailable') : undefined}
              onClick={web.open}
              className="text-xs text-accent hover:underline disabled:opacity-50 disabled:no-underline"
              data-testid="speleodb-web-collaborators"
            >
              {t('speleodb.web.openCollaborators')}
            </button>
          </div>

          {!canManage && (
            <div
              className="mb-3 inline-block text-xs px-1.5 py-0.5 bg-warning-20 text-warning rounded"
              data-testid="speleodb-collaborators-readonly-badge"
            >
              {t('speleodb.collaborators.readOnlyBadge')}
            </div>
          )}

          <p className="text-text-secondary text-xs mb-2" data-testid="speleodb-collaborators-changes-note">
            {t('speleodb.collaborators.changesInstantNote')}
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
                <SpeleoUserAutocomplete
                  value={newEmail}
                  onChange={setNewEmail}
                  disabled={busy}
                  enabled={canManage}
                  className={inputClass}
                  placeholder={t('speleodb.collaborators.emailPlaceholder')}
                  ariaLabel={t('speleodb.collaborators.addUser')}
                  inputTestId="speleodb-collaborators-add-email"
                  listTestId="speleodb-collaborators-suggestions"
                  suggestionTestIdPrefix="speleodb-collaborators-suggestion"
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
      )}
    </div>
  );
}
