import { useTranslation } from 'react-i18next';
import { SettingsSection } from './SettingsSection';
import { Button } from '../../common/Button';
import { COUNTRIES } from '../../../data/countries';
import type { SpeleoProjectMetadataState } from '../../../hooks/useSpeleoProjectMetadata';
import type { Visibility } from '../../../types/ipc.generated';

const inputClass =
  'w-full px-2 py-1 bg-background border border-border rounded text-sm disabled:opacity-60';

/**
 * The General tab of the SpeleoDB project dialog (#206): the open project's
 * server-side details - name, description, country, visibility, coordinates - plus
 * the web-map rendering switch. Read-only users see the fields disabled with a badge.
 *
 * Pure presentation over {@link useSpeleoProjectMetadata}, which the DIALOG owns so
 * its footer Save reads the same diff this form writes.
 */
export function SpeleoDbGeneralTab({ metadata }: { metadata: SpeleoProjectMetadataState }) {
  const { t } = useTranslation();
  const {
    loading,
    loadError,
    reload,
    baseline,
    form,
    update,
    coordsValid,
    canEdit,
    enablingRendering,
    handleEnableRendering,
  } = metadata;

  if (loading) {
    return (
      <p className="text-text-secondary text-sm" data-testid="speleodb-settings-loading">
        {t('speleodb.projectSettings.loading')}
      </p>
    );
  }

  if (loadError || !form || !baseline) {
    return (
      <div className="space-y-3" data-testid="speleodb-settings-error">
        <p className="text-error text-sm">{loadError ?? t('speleodb.projectSettings.loadFailed')}</p>
        <Button variant="secondary" onClick={() => void reload()} data-testid="speleodb-settings-retry">
          {t('speleodb.projectSettings.retry')}
        </Button>
      </div>
    );
  }

  return (
    <div data-testid="speleodb-settings-tab">
      <SettingsSection title={t('speleodb.projectSettings.title')}>
        {!canEdit && (
          <div
            className="mb-3 inline-block text-xs px-1.5 py-0.5 bg-warning-20 text-warning rounded"
            data-testid="speleodb-settings-readonly-badge"
          >
            {t('speleodb.projectSettings.readOnlyBadge')}
          </div>
        )}

        <div className="py-2">
          <label className="block text-sm font-medium text-text-primary mb-1">
            {t('speleodb.projectSettings.fields.name')}
          </label>
          <input
            type="text"
            value={form.name}
            disabled={!canEdit}
            onChange={(e) => update('name', e.target.value)}
            className={inputClass}
            aria-label={t('speleodb.projectSettings.fields.name')}
            data-testid="speleodb-settings-name"
          />
        </div>

        <div className="py-2">
          <label className="block text-sm font-medium text-text-primary mb-1">
            {t('speleodb.projectSettings.fields.description')}
          </label>
          <textarea
            value={form.description}
            disabled={!canEdit}
            onChange={(e) => update('description', e.target.value)}
            rows={3}
            className={inputClass}
            aria-label={t('speleodb.projectSettings.fields.description')}
            data-testid="speleodb-settings-description"
          />
        </div>

        <div className="py-2">
          <label className="block text-sm font-medium text-text-primary mb-1">
            {t('speleodb.projectSettings.fields.country')}
          </label>
          <select
            value={form.country}
            disabled={!canEdit}
            onChange={(e) => update('country', e.target.value)}
            className={inputClass}
            aria-label={t('speleodb.projectSettings.fields.country')}
            data-testid="speleodb-settings-country"
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

        <div className="py-2">
          <label className="block text-sm font-medium text-text-primary mb-1">
            {t('speleodb.projectSettings.fields.visibility')}
          </label>
          <select
            value={form.visibility}
            disabled={!canEdit}
            onChange={(e) => update('visibility', e.target.value as Visibility)}
            className={inputClass}
            aria-label={t('speleodb.projectSettings.fields.visibility')}
            data-testid="speleodb-settings-visibility"
          >
            <option value="PRIVATE">{t('speleodb.projectSettings.visibilityOptions.private')}</option>
            <option value="PUBLIC">{t('speleodb.projectSettings.visibilityOptions.public')}</option>
          </select>
        </div>

        <div className="py-2 grid grid-cols-2 gap-3">
          <div>
            <label className="block text-sm font-medium text-text-primary mb-1">
              {t('speleodb.projectSettings.fields.latitude')}
            </label>
            <input
              type="number"
              value={form.latitude}
              disabled={!canEdit}
              onChange={(e) => update('latitude', e.target.value)}
              className={inputClass}
              aria-label={t('speleodb.projectSettings.fields.latitude')}
              data-testid="speleodb-settings-latitude"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-text-primary mb-1">
              {t('speleodb.projectSettings.fields.longitude')}
            </label>
            <input
              type="number"
              value={form.longitude}
              disabled={!canEdit}
              onChange={(e) => update('longitude', e.target.value)}
              className={inputClass}
              aria-label={t('speleodb.projectSettings.fields.longitude')}
              data-testid="speleodb-settings-longitude"
            />
          </div>
        </div>
        {!coordsValid && (
          <p className="text-error text-xs pb-2" data-testid="speleodb-settings-coords-error">
            {t('speleodb.projectSettings.coordinatesHint')}
          </p>
        )}

        <div className="py-2 border-t border-border">
          <span className="block text-sm font-medium text-text-primary mb-1">
            {t('speleodb.projectSettings.rendering.label')}
          </span>
          {baseline.exclude_geojson ? (
            <Button
              variant="secondary"
              disabled={!canEdit || enablingRendering}
              onClick={() => void handleEnableRendering()}
              data-testid="speleodb-settings-enable-rendering"
            >
              {enablingRendering
                ? t('speleodb.banner.enableRenderingBusy')
                : t('speleodb.projectSettings.rendering.enableButton')}
            </Button>
          ) : (
            <p className="text-text-secondary text-xs" data-testid="speleodb-settings-rendering-note">
              {t('speleodb.projectSettings.rendering.enabledNote')}
            </p>
          )}
        </div>
      </SettingsSection>
    </div>
  );
}
