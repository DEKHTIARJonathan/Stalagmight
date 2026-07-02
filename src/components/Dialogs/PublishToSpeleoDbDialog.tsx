import { useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { DialogWrapper } from './DialogWrapper';
import { Button } from '../common/Button';
import { useUIStore } from '../../store/uiStore';
import { useProjectStore } from '../../store/projectStore';
import { useSpeleoStore } from '../../store/speleoStore';
import { invokeIpc } from '../../utils/ipc';
import { humanizeSpeleoError, speleoErrorAction } from '../../utils/speleoError';
import { COUNTRIES } from '../../data/countries';
import type { SpeleoPublishParams, SpeleoPublishResult, Visibility } from '../../types/ipc.generated';

const inputClass = 'w-full px-2 py-1 bg-background border border-border rounded text-sm';

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
  const [country, setCountry] = useState('');
  const [visibility, setVisibility] = useState<Visibility>('PRIVATE');
  // Best-effort prefill from the first georeferenced zero datum, if any.
  const firstGps = useMemo(() => project?.zero_datums?.[0]?.gps ?? null, [project]);
  const [latitude, setLatitude] = useState(firstGps ? String(firstGps.latitude) : '');
  const [longitude, setLongitude] = useState(firstGps ? String(firstGps.longitude) : '');
  const [publishing, setPublishing] = useState(false);

  const latTrim = latitude.trim();
  const lonTrim = longitude.trim();
  const latNum = latTrim === '' ? null : Number(latTrim);
  const lonNum = lonTrim === '' ? null : Number(lonTrim);
  const latValid = latTrim === '' || Number.isFinite(latNum);
  const lonValid = lonTrim === '' || Number.isFinite(lonNum);
  const coordsPairValid = (latTrim === '') === (lonTrim === '');
  const coordsValid = latValid && lonValid && coordsPairValid;

  const canPublish = name.trim().length > 0 && country !== '' && coordsValid && !publishing;

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
      // Reload the now-remote project (re-seeds link status), then refresh for good measure.
      await useProjectStore.getState().loadProject(result.local_path);
      await useSpeleoStore.getState().refreshLinkStatus();
      showToast(t('speleodb.publish.success'), 'speleodb-publish');
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
    showToast,
    closeDialog,
    t,
  ]);

  const isDirty =
    name.trim() !== (project?.name ?? '').trim() ||
    description.trim() !== '' ||
    country !== '' ||
    visibility !== 'PRIVATE';

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
            {t('speleodb.projectSettings.fields.name')}
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
            {t('speleodb.projectSettings.fields.description')}
          </label>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={3}
            className={inputClass}
            aria-label={t('speleodb.projectSettings.fields.description')}
            data-testid="publish-to-speleodb-dialog-description"
          />
        </div>

        <div>
          <label className="block text-sm font-medium text-text-primary mb-1">
            {t('speleodb.publish.country')}
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
        {!coordsPairValid && (
          <p className="text-error text-xs">{t('speleodb.projectSettings.coordinatesHint')}</p>
        )}

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
