import { useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { DialogWrapper } from './DialogWrapper';
import { Button } from '../common/Button';
import { SpeleoUserAutocomplete } from '../common/SpeleoUserAutocomplete';
import { useUIStore } from '../../store/uiStore';
import { useProjectStore } from '../../store/projectStore';
import { useSpeleoStore } from '../../store/speleoStore';
import { invokeIpc } from '../../utils/ipc';
import { humanizeSpeleoError, speleoErrorAction } from '../../utils/speleoError';
import { USER_LEVELS } from '../../utils/speleoPermission';
import { validateCoordinates } from '../../utils/gps';
import { reverseGeocodeCountry } from '../../utils/reverseGeocodeCountry';
import { COUNTRIES } from '../../data/countries';
import type {
  Permission,
  SpeleoCollaborators,
  SpeleoPublishParams,
  SpeleoPublishResult,
  Visibility,
} from '../../types/ipc.generated';

const inputClass = 'w-full px-2 py-1 bg-background border border-border rounded text-sm';

/** A collaborator queued in the dialog, granted only after the project is created. */
interface PendingCollaborator {
  email: string;
  permission: Permission;
}

/**
 * Publish the OPEN local project to SpeleoDB (#207). Collects the required metadata
 * (name + country) plus optional description / visibility / coordinates, calls
 * `speleodb_publish`, then reloads the now-remote project so the link status
 * re-seeds. Reachable from the project menu and from New Project's follow-up
 * checkbox.
 */
export default function PublishToSpeleoDbDialog() {
  const { t } = useTranslation();
  const closeDialog = useUIStore((s) => s.closeDialog);
  const showToast = useUIStore((s) => s.showToast);
  const project = useProjectStore((s) => s.project);

  const [name, setName] = useState(project?.name ?? '');
  const [description, setDescription] = useState('');
  // Best-effort prefill from the first georeferenced zero datum, if any.
  const firstGps = useMemo(() => project?.zero_datums?.[0]?.gps ?? null, [project]);
  // Offline reverse-geocode the required country from that datum (#217). Lazy
  // initializer so it runs once at mount; empty when there is no GPS or the point
  // resolves to no country. Always user-editable via the <select> below.
  const [country, setCountry] = useState(() => {
    const gps = project?.zero_datums?.[0]?.gps ?? null;
    return gps ? (reverseGeocodeCountry(gps.latitude, gps.longitude) ?? '') : '';
  });
  const [visibility, setVisibility] = useState<Visibility>('PRIVATE');
  const [latitude, setLatitude] = useState(firstGps ? String(firstGps.latitude) : '');
  const [longitude, setLongitude] = useState(firstGps ? String(firstGps.longitude) : '');
  const [publishing, setPublishing] = useState(false);

  // Collaborators to grant AFTER the create succeeds - the project does not exist on
  // the server yet, so we queue (email, level) pairs here and add them once it is
  // linked. The email typeahead is session-backed, so it works before publish.
  const [collaborators, setCollaborators] = useState<PendingCollaborator[]>([]);
  const [collabEmail, setCollabEmail] = useState('');
  const [collabLevel, setCollabLevel] = useState<Permission>('READ_ONLY');

  const addCollaborator = useCallback(() => {
    const email = collabEmail.trim();
    if (!email) return;
    setCollaborators((prev) => {
      // De-dupe on a case-insensitive email; a re-add just updates the level.
      const lower = email.toLowerCase();
      const rest = prev.filter((c) => c.email.toLowerCase() !== lower);
      return [...rest, { email, permission: collabLevel }];
    });
    setCollabEmail('');
  }, [collabEmail, collabLevel]);

  const removeCollaborator = useCallback((email: string) => {
    setCollaborators((prev) => prev.filter((c) => c.email !== email));
  }, []);

  const setCollaboratorLevel = useCallback((email: string, permission: Permission) => {
    setCollaborators((prev) => prev.map((c) => (c.email === email ? { ...c, permission } : c)));
  }, []);

  const latTrim = latitude.trim();
  const lonTrim = longitude.trim();
  const latNum = latTrim === '' ? null : Number(latTrim);
  const lonNum = lonTrim === '' ? null : Number(lonTrim);
  const coordsPairValid = (latTrim === '') === (lonTrim === '');
  // When both are provided they must be finite AND in range - reuse the shared
  // validator (finiteness alone would let latitude 999 through to the server).
  const bothProvided = latTrim !== '' && lonTrim !== '';
  const coordsRangeValid =
    !bothProvided || (latNum !== null && lonNum !== null && validateCoordinates(latNum, lonNum).valid);
  const coordsValid = coordsPairValid && coordsRangeValid;

  // SpeleoDB's Project model requires a non-blank description (`blank=False,
  // null=False`), so an empty one 400s the create before anything is written. Gate
  // it here as required rather than let Publish silently fail after the click.
  const canPublish =
    name.trim().length > 0 &&
    description.trim().length > 0 &&
    country !== '' &&
    coordsValid &&
    !publishing;

  const handlePublish = useCallback(async () => {
    if (!canPublish) return;
    setPublishing(true);
    // Both-or-neither: only send numbers when both are present and valid.
    const bothCoords = latTrim !== '' && lonTrim !== '';
    const params: SpeleoPublishParams = {
      name: name.trim(),
      description,
      country,
      visibility,
      latitude: bothCoords ? latNum : null,
      longitude: bothCoords ? lonNum : null,
    };
    try {
      const result = await invokeIpc<SpeleoPublishResult>('speleodb_publish', { params });
      // The project now EXISTS on the server and is linked. Reload its cache copy so the
      // app converges on the now-remote project. loadProject reports failure via
      // {success:false} (it never throws - it may have opened a recovery dialog), so a
      // failed reload must NOT claim success or close over a stale/local view.
      const { success } = await useProjectStore.getState().loadProject(result.local_path);
      if (!success) {
        // Published, but the cache copy could not be reopened. Grants target the OPEN
        // link, which we no longer have, so any queued collaborators were NOT added -
        // say so rather than dropping them silently.
        showToast(
          collaborators.length > 0
            ? t('speleodb.publish.reloadFailedWithCollaborators')
            : t('speleodb.publish.reloadFailed'),
          'speleodb-publish',
        );
        return;
      }
      // UI-convergence only: a failure refreshing the link status must NOT flip a
      // succeeded publish into the error path (the link is already stamped on the
      // reloaded project), so swallow it.
      try {
        await useSpeleoStore.getState().refreshLinkStatus();
      } catch {
        // non-fatal; leave the status to the next refresh.
      }

      // The project is now linked, so `speleodb_add_collaborator` (which targets the
      // open link) can grant each queued collaborator. Sequential + best-effort: a
      // failed grant must NOT undo a successful publish, so we collect the failures
      // and warn, leaving the rest to be finished from Project Settings.
      const failed: string[] = [];
      for (const c of collaborators) {
        try {
          await invokeIpc<SpeleoCollaborators>('speleodb_add_collaborator', {
            email: c.email,
            permission: c.permission,
          });
        } catch {
          failed.push(c.email);
        }
      }
      if (failed.length > 0) {
        showToast(
          t('speleodb.publish.collaboratorsPartial', { emails: failed.join(', ') }),
          'speleodb-publish',
        );
      } else {
        showToast(t('speleodb.publish.success'), 'speleodb-publish');
      }
      closeDialog();
    } catch (e) {
      showToast(humanizeSpeleoError(e, t('speleodb.publish.failed')), 'speleodb-publish');
      if (speleoErrorAction(e) === 'ReLogin') {
        useSpeleoStore.getState().clearSession();
      }
    } finally {
      setPublishing(false);
    }
  }, [
    canPublish,
    name,
    description,
    country,
    visibility,
    latTrim,
    lonTrim,
    latNum,
    lonNum,
    collaborators,
    showToast,
    closeDialog,
    t,
  ]);

  const isDirty =
    name.trim() !== (project?.name ?? '').trim() ||
    description.trim() !== '' ||
    country !== '' ||
    visibility !== 'PRIVATE' ||
    collaborators.length > 0 ||
    // Include the coordinate pins so entering ONLY a location still prompts on close.
    latTrim !== '' ||
    lonTrim !== '';

  return (
    <DialogWrapper
      title={t('speleodb.publish.title')}
      onClose={closeDialog}
      size="md"
      isDirty={isDirty}
      data-testid="publish-to-speleodb-dialog"
    >
      <div className="space-y-4">
        <p className="text-text-secondary text-sm">{t('speleodb.publish.description')}</p>

        <div>
          <label className="block text-sm font-medium text-text-primary mb-1">
            {t('speleodb.projectSettings.fields.name')} <span className="text-error">*</span>
          </label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className={inputClass}
            aria-label={t('speleodb.projectSettings.fields.name')}
            data-testid="publish-to-speleodb-dialog-name"
          />
        </div>

        <div>
          <label className="block text-sm font-medium text-text-primary mb-1">
            {t('speleodb.projectSettings.fields.description')} <span className="text-error">*</span>
          </label>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={3}
            className={inputClass}
            aria-label={t('speleodb.projectSettings.fields.description')}
            data-testid="publish-to-speleodb-dialog-description"
          />
          {description.trim() === '' && (
            <p className="text-error text-xs mt-1" data-testid="publish-to-speleodb-dialog-description-error">
              {t('speleodb.publish.descriptionRequired')}
            </p>
          )}
        </div>

        <div>
          <label className="block text-sm font-medium text-text-primary mb-1">
            {t('speleodb.publish.country')} <span className="text-error">*</span>
          </label>
          <select
            value={country}
            onChange={(e) => setCountry(e.target.value)}
            className={inputClass}
            aria-label={t('speleodb.publish.country')}
            data-testid="publish-to-speleodb-dialog-country"
          >
            <option value="" disabled>
              {t('speleodb.publish.countryPlaceholder')}
            </option>
            {COUNTRIES.map((c) => (
              <option key={c.code} value={c.code}>
                {c.name}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label className="block text-sm font-medium text-text-primary mb-1">
            {t('speleodb.publish.visibility')}
          </label>
          <select
            value={visibility}
            onChange={(e) => setVisibility(e.target.value as Visibility)}
            className={inputClass}
            aria-label={t('speleodb.publish.visibility')}
            data-testid="publish-to-speleodb-dialog-visibility"
          >
            <option value="PRIVATE">{t('speleodb.projectSettings.visibilityOptions.private')}</option>
            <option value="PUBLIC">{t('speleodb.projectSettings.visibilityOptions.public')}</option>
          </select>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-sm font-medium text-text-primary mb-1">
              {t('speleodb.publish.latitude')}
            </label>
            <input
              type="number"
              value={latitude}
              onChange={(e) => setLatitude(e.target.value)}
              className={inputClass}
              aria-label={t('speleodb.publish.latitude')}
              data-testid="publish-to-speleodb-dialog-latitude"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-text-primary mb-1">
              {t('speleodb.publish.longitude')}
            </label>
            <input
              type="number"
              value={longitude}
              onChange={(e) => setLongitude(e.target.value)}
              className={inputClass}
              aria-label={t('speleodb.publish.longitude')}
              data-testid="publish-to-speleodb-dialog-longitude"
            />
          </div>
        </div>
        {!coordsValid && (
          <p className="text-error text-xs" data-testid="publish-to-speleodb-dialog-coords-error">
            {t('speleodb.projectSettings.coordinatesHint')}
          </p>
        )}

        <div className="pt-2 border-t border-border">
          <label className="block text-sm font-medium text-text-primary mb-1">
            {t('speleodb.publish.collaborators')}
          </label>
          <p className="text-text-secondary text-xs mb-2">
            {t('speleodb.publish.collaboratorsHint')}
          </p>

          {collaborators.length > 0 && (
            <ul className="space-y-1 mb-2" data-testid="publish-to-speleodb-dialog-collaborators">
              {collaborators.map((c) => (
                <li
                  key={c.email}
                  className="flex items-center gap-2"
                  data-testid={`publish-to-speleodb-dialog-collab-${c.email}`}
                >
                  <span className="flex-1 min-w-0 truncate text-sm">{c.email}</span>
                  <select
                    value={c.permission}
                    disabled={publishing}
                    onChange={(e) => setCollaboratorLevel(c.email, e.target.value as Permission)}
                    className="px-1 py-0.5 bg-background border border-border rounded text-xs"
                    aria-label={t('speleodb.collaborators.levelFor', { name: c.email })}
                    data-testid={`publish-to-speleodb-dialog-collab-level-${c.email}`}
                  >
                    {USER_LEVELS.map((p) => (
                      <option key={p} value={p}>
                        {t(`speleodb.collaborators.levels.${p}`)}
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    disabled={publishing}
                    onClick={() => removeCollaborator(c.email)}
                    className="text-error text-xs hover:underline disabled:opacity-60"
                    data-testid={`publish-to-speleodb-dialog-collab-remove-${c.email}`}
                  >
                    {t('speleodb.collaborators.remove')}
                  </button>
                </li>
              ))}
            </ul>
          )}

          <div className="flex items-center gap-2">
            <SpeleoUserAutocomplete
              value={collabEmail}
              onChange={setCollabEmail}
              disabled={publishing}
              enabled={!publishing}
              className={inputClass}
              placeholder={t('speleodb.collaborators.emailPlaceholder')}
              ariaLabel={t('speleodb.collaborators.addUser')}
              inputTestId="publish-to-speleodb-dialog-collab-email"
              listTestId="publish-to-speleodb-dialog-collab-suggestions"
              suggestionTestIdPrefix="publish-to-speleodb-dialog-collab-suggestion"
            />
            <select
              value={collabLevel}
              disabled={publishing}
              onChange={(e) => setCollabLevel(e.target.value as Permission)}
              className="px-1 py-1 bg-background border border-border rounded text-sm"
              aria-label={t('speleodb.collaborators.addLevel')}
              data-testid="publish-to-speleodb-dialog-collab-add-level"
            >
              {USER_LEVELS.map((p) => (
                <option key={p} value={p}>
                  {t(`speleodb.collaborators.levels.${p}`)}
                </option>
              ))}
            </select>
            <Button
              variant="secondary"
              disabled={publishing || collabEmail.trim() === ''}
              onClick={addCollaborator}
              data-testid="publish-to-speleodb-dialog-collab-add"
            >
              {t('speleodb.collaborators.add')}
            </Button>
          </div>
        </div>

        <div className="flex justify-end gap-2 pt-4 border-t border-border">
          <Button onClick={closeDialog} disabled={publishing} data-testid="publish-to-speleodb-dialog-cancel">
            {t('common.actions.cancel')}
          </Button>
          <Button
            variant="primary"
            onClick={() => void handlePublish()}
            disabled={!canPublish}
            data-testid="publish-to-speleodb-dialog-submit"
          >
            {publishing ? t('speleodb.publish.submitting') : t('speleodb.publish.submit')}
          </Button>
        </div>
      </div>
    </DialogWrapper>
  );
}
