import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useUIStore } from '../store/uiStore';
import { useProjectStore } from '../store/projectStore';
import { useSpeleoStore } from '../store/speleoStore';
import { invokeIpc } from '../utils/ipc';
import { humanizeSpeleoError } from '../utils/speleoError';
import { permissionAtLeast } from '../utils/speleoPermission';
import { validateCoordinates } from '../utils/gps';
import type {
  SpeleoProjectMetadata,
  SpeleoProjectMetadataPatch,
  Visibility,
} from '../types/ipc.generated';

/** Editable copy of the server metadata that the form binds to. Lat/long are held
 *  as strings so an in-progress edit ("-" / "12.") doesn't fight the number input. */
export interface SpeleoMetadataForm {
  name: string;
  description: string;
  country: string;
  visibility: Visibility;
  latitude: string;
  longitude: string;
}

export interface SpeleoProjectMetadataState {
  loading: boolean;
  loadError: string | null;
  reload: () => Promise<void>;
  /** The last server truth we loaded / saved; also carries `exclude_geojson`. */
  baseline: SpeleoProjectMetadata | null;
  form: SpeleoMetadataForm | null;
  update: <K extends keyof SpeleoMetadataForm>(key: K, value: SpeleoMetadataForm[K]) => void;
  coordsValid: boolean;
  canEdit: boolean;
  canSave: boolean;
  saving: boolean;
  handleSave: () => Promise<void>;
  enablingRendering: boolean;
  handleEnableRendering: () => Promise<void>;
}

/** Turn the server metadata into the string-backed form shape. */
function toForm(m: SpeleoProjectMetadata): SpeleoMetadataForm {
  return {
    name: m.name,
    description: m.description,
    country: m.country,
    visibility: m.visibility,
    latitude: m.latitude === null ? '' : String(m.latitude),
    longitude: m.longitude === null ? '' : String(m.longitude),
  };
}

/**
 * The open remote project's server metadata: load, edit, and PATCH back only what
 * changed (#206). Editing needs READ_AND_WRITE or higher; a read-only user gets the
 * loaded values with `canEdit` false.
 *
 * This lives in a hook rather than in the tab body because the SpeleoDB project
 * dialog splits the two halves apart: the FOOTER owns Save (`canSave`/`saving`/
 * `handleSave`) while the General tab BODY owns the form, and both must read one
 * source of truth or the button would gate on a stale diff.
 */
export function useSpeleoProjectMetadata(): SpeleoProjectMetadataState {
  const { t } = useTranslation();
  const showToast = useUIStore((s) => s.showToast);
  // Select the two primitives rather than the link object: the status poll hands
  // out a fresh object on every tick, which would re-run the load effect below.
  const isLinked = useSpeleoStore((s) => s.link !== null);
  const permission = useSpeleoStore((s) => s.link?.permission ?? null);
  const refreshLinkStatus = useSpeleoStore((s) => s.refreshLinkStatus);

  const canEdit = permissionAtLeast(permission, 'READ_AND_WRITE');

  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  // The last server truth we loaded / saved - the baseline changed fields diff against.
  const [baseline, setBaseline] = useState<SpeleoProjectMetadata | null>(null);
  const [form, setForm] = useState<SpeleoMetadataForm | null>(null);
  const [saving, setSaving] = useState(false);
  const [enablingRendering, setEnablingRendering] = useState(false);

  const reload = useCallback(async () => {
    // A project with no link has no server metadata; the dialog shows its
    // not-linked message instead of the form, so skip the doomed round trip.
    if (!isLinked) {
      setLoading(false);
      return;
    }
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
  }, [isLinked, t]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const update = useCallback(
    <K extends keyof SpeleoMetadataForm>(key: K, value: SpeleoMetadataForm[K]) => {
      setForm((prev) => (prev ? { ...prev, [key]: value } : prev));
    },
    [],
  );

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
      showToast(t('speleodb.projectSettings.saved'), 'speleodb-project-settings', 'success');
    } catch (e) {
      showToast(
        humanizeSpeleoError(e, t('speleodb.projectSettings.saveFailed')),
        'speleodb-project-settings',
        'error',
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
      // hook's local baseline and toast. It throws on failure.
      await useSpeleoStore.getState().enableRendering();
      setBaseline((prev) => (prev ? { ...prev, exclude_geojson: false } : prev));
      showToast(t('speleodb.projectSettings.rendering.enabled'), 'speleodb-project-settings', 'success');
    } catch (e) {
      showToast(
        humanizeSpeleoError(e, t('speleodb.banner.enableRenderingFailed')),
        'speleodb-project-settings',
        'error',
      );
    } finally {
      setEnablingRendering(false);
    }
  }, [showToast, t]);

  return {
    loading,
    loadError,
    reload,
    baseline,
    form,
    update,
    coordsValid,
    canEdit,
    canSave,
    saving,
    handleSave,
    enablingRendering,
    handleEnableRendering,
  };
}
