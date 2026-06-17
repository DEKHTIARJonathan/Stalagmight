import { useCallback, useId, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useShallow } from 'zustand/react/shallow';
import { DialogWrapper } from './DialogWrapper';
import { ValidationSettings } from './settings/ValidationSettings';
import { SettingsSection } from './settings/SettingsSection';
import { SettingRow } from './settings/SettingRow';
import type { SettingsCategory } from './SettingsSidebar';
import { getPanelId, getTabId } from './SettingsSidebar';
import { Button } from '../common/Button';
import { useUIStore } from '../../store/uiStore';
import { useProjectStore } from '../../store/projectStore';
import { defaultConfig, type Config } from '../../types/config';

type ProjectSettingsTab = 'general' | 'validation';
const TABS: readonly ProjectSettingsTab[] = ['general', 'validation'];
const EMPTY_CHANGED: ReadonlySet<string> = new Set();

/** Mirrors the range checks in the global Settings dialog. Computed directly
 *  from the values so it holds even if the Validation tab was never mounted. */
function isValidationValid(v: Config['validation']): boolean {
  return (
    v.warn_shot_length_min >= 0 &&
    v.warn_shot_length_max > v.warn_shot_length_min &&
    v.warn_depth_change_per_shot_max > 0 &&
    v.azimuth_diff_threshold >= 0 &&
    v.azimuth_diff_threshold <= 180 &&
    v.pitch_diff_threshold >= 0 &&
    v.pitch_diff_threshold <= 90 &&
    v.inclination_depth_diff_threshold >= 0 &&
    v.inclination_depth_diff_threshold <= 90
  );
}

/**
 * Per-project settings (#57). Mirrors the global Settings dialog's structure
 * (sidebar tabs + sections) but edits the values stored in the .stalx that
 * travel with the project: General = project name, Validation = the same
 * thresholds as the global settings (which are the defaults for new projects).
 */
export function ProjectSettingsDialog() {
  const { t } = useTranslation();
  const closeDialog = useUIStore((s) => s.closeDialog);
  const showToast = useUIStore((s) => s.showToast);
  const { project, updateProjectSettings } = useProjectStore(
    useShallow((s) => ({ project: s.project, updateProjectSettings: s.updateProjectSettings })),
  );
  const panelIdBase = useId();

  const [tab, setTab] = useState<ProjectSettingsTab>('general');
  const [name, setName] = useState(project?.name ?? '');
  const [validation, setValidation] = useState<Config['validation']>(
    project?.validation ?? defaultConfig.validation,
  );
  const [hasValidationError, setHasValidationError] = useState(false);
  const [saving, setSaving] = useState(false);

  // ValidationSettings is built against a full Config; wrap the project's
  // validation in a synthetic config and funnel its onChange back into local
  // state. It only ever mutates `.validation`.
  const syntheticConfig = useMemo<Config>(() => ({ ...defaultConfig, validation }), [validation]);
  const handleConfigChange = useCallback((updates: Partial<Config>) => {
    if (updates.validation) setValidation(updates.validation);
  }, []);
  const handleValidationError = useCallback((_cat: SettingsCategory, hasError: boolean) => {
    setHasValidationError(hasError);
  }, []);

  const trimmedName = name.trim();
  // Gate on the values directly (robust even if the Validation tab was never
  // opened), plus the live component check while it is mounted.
  const validationValid = isValidationValid(validation);
  const canSave = !!project && trimmedName.length > 0 && validationValid && !hasValidationError && !saving;

  const handleSave = useCallback(async () => {
    if (trimmedName.length === 0 || !isValidationValid(validation) || hasValidationError || saving) return;
    setSaving(true);
    const result = await updateProjectSettings(trimmedName, validation);
    setSaving(false);
    if (result.success) {
      closeDialog();
    } else {
      showToast(result.error ?? t('dialogs.projectSettings.saveFailed'), 'project-settings');
    }
  }, [trimmedName, hasValidationError, saving, updateProjectSettings, validation, closeDialog, showToast, t]);

  return (
    <DialogWrapper
      title={t('dialogs.projectSettings.title')}
      onClose={closeDialog}
      size="2xl"
      closeOnBackdropClick={false}
      overflow="hidden"
      bodyClassName="flex flex-col"
      data-testid="project-settings-dialog"
    >
      {!project ? (
        <p className="text-text-secondary p-4">{t('dialogs.projectSettings.noProject')}</p>
      ) : (
        <>
          <div className="flex flex-1 min-h-0">
            {/* Sidebar tabs (mirrors the global Settings structure). */}
            <div className="w-44 shrink-0 border-r border-border p-2 space-y-1" role="tablist">
              {TABS.map((tk) => (
                <button
                  key={tk}
                  id={getTabId(panelIdBase, tk)}
                  role="tab"
                  aria-selected={tab === tk}
                  aria-controls={getPanelId(panelIdBase, tk)}
                  onClick={() => setTab(tk)}
                  className={`w-full text-left px-3 py-1.5 rounded text-sm ${tab === tk ? 'bg-accent-10 text-text-primary' : 'text-text-secondary hover:bg-background-50'}`}
                  data-testid={`project-settings-tab-${tk}`}
                >
                  {t(`dialogs.projectSettings.tabs.${tk}`)}
                </button>
              ))}
            </div>

            <div className="flex-1 min-w-0 overflow-auto p-4">
              {tab === 'general' ? (
                <div role="tabpanel" id={getPanelId(panelIdBase, 'general')} aria-labelledby={getTabId(panelIdBase, 'general')}>
                <SettingsSection title={t('dialogs.projectSettings.tabs.general')}>
                  <SettingRow
                    label={t('dialogs.projectSettings.name.label')}
                    helpText={t('dialogs.projectSettings.name.help')}
                    data-testid="project-settings-name-row"
                  >
                    <input
                      type="text"
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      className="w-64 px-2 py-1 bg-background border border-border rounded text-sm"
                      aria-label={t('dialogs.projectSettings.name.label')}
                      data-testid="project-settings-name"
                    />
                  </SettingRow>
                </SettingsSection>
                </div>
              ) : (
                <ValidationSettings
                  config={syntheticConfig}
                  onChange={handleConfigChange}
                  changedFields={EMPTY_CHANGED as Set<string>}
                  onValidationError={handleValidationError}
                  panelIdBase={panelIdBase}
                  scope="project"
                />
              )}
            </div>
          </div>

          <div className="border-t border-border p-3 flex justify-end gap-2 shrink-0">
            <Button variant="secondary" onClick={closeDialog} data-testid="project-settings-cancel">
              {t('common.actions.cancel')}
            </Button>
            <Button variant="primary" onClick={handleSave} disabled={!canSave} data-testid="project-settings-save">
              {t('common.actions.save')}
            </Button>
          </div>
        </>
      )}
    </DialogWrapper>
  );
}
