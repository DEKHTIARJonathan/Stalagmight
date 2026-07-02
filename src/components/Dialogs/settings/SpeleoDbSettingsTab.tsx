import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { SettingsSection } from './SettingsSection';
import { SpeleoProjectAdmin } from './SpeleoProjectAdmin';
import { Button } from '../../common/Button';
import { useUIStore } from '../../../store/uiStore';
import { useProjectStore } from '../../../store/projectStore';
import { useSpeleoStore } from '../../../store/speleoStore';
import { invokeIpc } from '../../../utils/ipc';
import { humanizeSpeleoError } from '../../../utils/speleoError';
import { permissionAtLeast } from '../../../utils/speleoPermission';
import { validateCoordinates } from '../../../utils/gps';
import { COUNTRIES } from '../../../data/countries';
import type {
  SpeleoProjectMetadata,
  SpeleoProjectMetadataPatch,
  Visibility,
} from '../../../types/ipc.generated';

/** Editable copy of the server metadata that the form binds to. Lat/long are held
 *  as strings so an in-progress edit ("-" / "12.") doesn't fight the number input. */
interface FormState {
  name: string;
  description: string;
  country: string;
  visibility: Visibility;
  latitude: string;
  longitude: string;
}

/** Turn the server metadata into the string-backed form shape. */
function toForm(m: SpeleoProjectMetadata): FormState {
  return {
    name: m.name,
    description: m.description,
    country: m.country,
    visibility: m.visibility,
    latitude: m.latitude === null ? '' : String(m.latitude),
    longitude: m.longitude === null ? '' : String(m.longitude),
  };
}

const inputClass =
  'w-full px-2 py-1 bg-background border border-border rounded text-sm disabled:opacity-60';

/**
 * The "SpeleoDB" tab body of the Project Settings dialog (#206). Only rendered for
 * a remote project. Loads the open project's current server metadata on mount and
 * lets a user with READ_AND_WRITE (or higher) edit name / description / country /
 * visibility / coordinates and save a minimal PATCH back. Read-only users see the
 * fields disabled with a badge and no Save button.
 */
export function SpeleoDbSettingsTab() {
  const { t } = useTranslation();
  const showToast = useUIStore((s) => s.showToast);
  const link = useSpeleoStore((s) => s.link);
  const refreshLinkStatus = useSpeleoStore((s) => s.refreshLinkStatus);

  const canEdit = permissionAtLeast(link?.permission, 'READ_AND_WRITE');

  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  // The last server truth we loaded / saved - the baseline changed fields diff against.
  const [baseline, setBaseline] = useState<SpeleoProjectMetadata | null>(null);
  const [form, setForm] = useState<FormState | null>(null);
  const [saving, setSaving] = useState(false);
  const [enablingRendering, setEnablingRendering] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const meta = await invokeIpc<SpeleoProjectMetadata>('speleodb_get_project_metadata');
      setBaseline(meta);
      setForm(toForm(meta));
    } catch (e) {
      setLoadError(humanizeSpeleoError(e, t('speleodb.projectSettings.loadFailed')));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  const update = useCallback(<K extends keyof FormState>(key: K, value: FormState[K]) => {
    setForm((prev) => (prev ? { ...prev, [key]: value } : prev));
  }, []);

  // Both-or-neither coordinate validity: OK when both blank or both filled with a
  // finite number. A single filled field is the only invalid state.
  const latTrim = form?.latitude.trim() ?? '';
  const lonTrim = form?.longitude.trim() ?? '';
  const latNum = latTrim === '' ? null : Number(latTrim);
  const lonNum = lonTrim === '' ? null : Number(lonTrim);
  const coordsPairValid = (latTrim === '') === (lonTrim === '');
  // When both are set they must be finite AND in range - reuse the shared validator
  // (finiteness alone would let an out-of-range latitude reach the server).
  const bothProvided = latTrim !== '' && lonTrim !== '';
  const coordsRangeValid =
    !bothProvided || (latNum !== null && lonNum !== null && validateCoordinates(latNum, lonNum).valid);
  const coordsValid = coordsPairValid && coordsRangeValid;

  // Which fields differ from the loaded baseline (drives the minimal PATCH + Save gate).
  const nameChanged = !!baseline && !!form && form.name !== baseline.name;
  const descriptionChanged = !!baseline && !!form && form.description !== baseline.description;
  const countryChanged = !!baseline && !!form && form.country !== baseline.country;
  const visibilityChanged = !!baseline && !!form && form.visibility !== baseline.visibility;
  const baselineLat = baseline?.latitude ?? null;
  const baselineLon = baseline?.longitude ?? null;
  const coordinatesChanged =
    !!baseline && !!form && coordsValid && (latNum !== baselineLat || lonNum !== baselineLon);

  const anyChanged =
    nameChanged || descriptionChanged || countryChanged || visibilityChanged || coordinatesChanged;
  const nameEmpty = (form?.name.trim() ?? '') === '';
  const canSave = canEdit && !!form && anyChanged && coordsValid && !nameEmpty && !saving;

  const handleSave = useCallback(async () => {
    if (!form || !baseline || !canSave) return;
    setSaving(true);
    const patch: SpeleoProjectMetadataPatch = {
      name: nameChanged ? form.name.trim() : null,
      description: descriptionChanged ? form.description : null,
      country: countryChanged ? form.country : null,
      visibility: visibilityChanged ? form.visibility : null,
      coordinates_edited: coordinatesChanged,
      latitude: coordinatesChanged ? latNum : null,
      longitude: coordinatesChanged ? lonNum : null,
    };
    try {
      const updated = await invokeIpc<SpeleoProjectMetadata>('speleodb_patch_project', { patch });
      setBaseline(updated);
      setForm(toForm(updated));
      // The backend folds a name change into the local .stalx; mirror it in the UI.
      // A lightweight in-memory set (not set_project_name_for_path) avoids marking the
      // project dirty for a rename that is already persisted server- and file-side.
      if (nameChanged) {
        const project = useProjectStore.getState().project;
        if (project) {
          useProjectStore.setState({ project: { ...project, name: updated.name } });
        }
      }
      // Re-seed the link so any server-side follow-on (e.g. permission) stays fresh.
      void refreshLinkStatus();
      showToast(t('speleodb.projectSettings.saved'), 'speleodb-project-settings');
    } catch (e) {
      showToast(
        humanizeSpeleoError(e, t('speleodb.projectSettings.saveFailed')),
        'speleodb-project-settings',
      );
    } finally {
      setSaving(false);
    }
  }, [
    form,
    baseline,
    canSave,
    nameChanged,
    descriptionChanged,
    countryChanged,
    visibilityChanged,
    coordinatesChanged,
    latNum,
    lonNum,
    refreshLinkStatus,
    showToast,
    t,
  ]);

  const handleEnableRendering = useCallback(async () => {
    setEnablingRendering(true);
    try {
      // Reuse the shared store action (single source of truth for the IPC + the
      // rendering-disabled banner drop + link re-seed), then mirror the flag into this
      // tab's local baseline and toast. It throws on failure.
      await useSpeleoStore.getState().enableRendering();
      setBaseline((prev) => (prev ? { ...prev, exclude_geojson: false } : prev));
      showToast(t('speleodb.projectSettings.rendering.enabled'), 'speleodb-project-settings');
    } catch (e) {
      showToast(
        humanizeSpeleoError(e, t('speleodb.banner.enableRenderingFailed')),
        'speleodb-project-settings',
      );
    } finally {
      setEnablingRendering(false);
    }
  }, [showToast, t]);

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
        <Button variant="secondary" onClick={() => void load()} data-testid="speleodb-settings-retry">
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

      {canEdit && (
        <div className="flex justify-end">
          <Button
            variant="primary"
            disabled={!canSave}
            onClick={() => void handleSave()}
            data-testid="speleodb-settings-save"
          >
            {saving ? t('speleodb.projectSettings.saving') : t('speleodb.projectSettings.saveButton')}
          </Button>
        </div>
      )}

      {/* [#215] Collaborators (users + teams), lock release, and project delete. */}
      <SpeleoProjectAdmin />
    </div>
  );
}
