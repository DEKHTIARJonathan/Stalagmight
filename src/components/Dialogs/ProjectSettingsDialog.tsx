import { useCallback, useId, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useShallow } from 'zustand/react/shallow';
import { DialogWrapper } from './DialogWrapper';
import { ValidationSettings } from './settings/ValidationSettings';
import { CollaborationSection } from './settings/CollaborationSettings';
import { SettingsSection } from './settings/SettingsSection';
import { SettingRow } from './settings/SettingRow';
import { SpeleoDbSettingsTab } from './settings/SpeleoDbSettingsTab';
import type { SettingsCategory } from './SettingsSidebar';
import { Button } from '../common/Button';
import { useUIStore } from '../../store/uiStore';
import { useProjectStore } from '../../store/projectStore';
import { useSpeleoStore } from '../../store/speleoStore';
import { defaultConfig, type Config } from '../../types/config';
import { isValidationConfigValid } from '../../utils/validation';

type ProjectSettingsTab = 'general' | 'validation' | 'experimental' | 'speleodb';
// The local (always-shown) tabs; the remote-only 'speleodb' tab is appended below.
const TABS: readonly ProjectSettingsTab[] = ['general', 'validation', 'experimental'];
const EMPTY_CHANGED: ReadonlySet<string> = new Set();

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
  // The SpeleoDB tab is only meaningful for a remote (linked) project.
  const isRemote = useSpeleoStore((s) => s.link) != null;
  const { project, globalConfig, updateProjectSettings, setCollabEnabled } = useProjectStore(
    useShallow((s) => ({
      project: s.project,
      globalConfig: s.config,
      updateProjectSettings: s.updateProjectSettings,
      setCollabEnabled: s.setCollabEnabled,
    })),
  );
  const panelIdBase = useId();
  // Same id format as SettingsSidebar's getTabId/getPanelId, but accepting the
  // project-only 'experimental' tab. The validation tab's ids therefore still
  // match what ValidationSettings emits for its aria-labelledby/panel id.
  const tabId = (tk: ProjectSettingsTab) => `${panelIdBase}-tab-${tk}`;
  const panelId = (tk: ProjectSettingsTab) => `${panelIdBase}-panel-${tk}`;

  const [tab, setTab] = useState<ProjectSettingsTab>('general');
  const renderedTabs = useMemo<readonly ProjectSettingsTab[]>(
    () => (isRemote ? [...TABS, 'speleodb'] : TABS),
    [isRemote],
  );
  const [name, setName] = useState(project?.name ?? '');
  const [validation, setValidation] = useState<Config['validation']>(
    project?.validation ?? defaultConfig.validation,
  );
  const [hasValidationError, setHasValidationError] = useState(false);
  const [saving, setSaving] = useState(false);
  // Stage the collab flag in dialog state so the toggle honors Save/Cancel like
  // the rest of the dialog; persisted only in handleSave (#57).
  const [collabEnabled, setCollabEnabledState] = useState(project?.collab?.enabled ?? false);

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
  const validationValid = isValidationConfigValid(validation);
  const canSave = !!project && trimmedName.length > 0 && validationValid && !hasValidationError && !saving;

  const handleSave = useCallback(async () => {
    if (!project || trimmedName.length === 0 || !isValidationConfigValid(validation) || hasValidationError || saving) return;
    setSaving(true);
    // Skip the settings command when neither the name nor the validation changed:
    // it routes through executeCommand, which marks every success dirty, so even
    // the backend's no-op early-return would otherwise leave an unsaved-changes
    // prompt and a misleading history item for a Save that changed nothing (Codex).
    const currentValidation = project.validation ?? defaultConfig.validation;
    const settingsChanged =
      trimmedName !== (project.name ?? '') ||
      JSON.stringify(validation) !== JSON.stringify(currentValidation);
    if (settingsChanged) {
      const result = await updateProjectSettings(trimmedName, validation);
      if (!result.success) {
        setSaving(false);
        showToast(result.error ?? t('dialogs.projectSettings.saveFailed'), 'project-settings');
        return;
      }
    }
    // Commit the staged collab flag only when it actually changed. setCollabEnabled
    // (set_collab_enabled) sets the in-memory flag + project.touch() in one IPC;
    // the sibling .tml is written by the normal save pipeline as before.
    const currentCollab = project.collab?.enabled ?? false;
    if (collabEnabled !== currentCollab) {
      const collabResult = await setCollabEnabled(collabEnabled);
      if (!collabResult.success) {
        setSaving(false);
        showToast(collabResult.error ?? t('detailPanel.collaboration.toggleFailed'), 'project-settings');
        return;
      }
    }
    setSaving(false);
    closeDialog();
  }, [
    trimmedName,
    hasValidationError,
    saving,
    updateProjectSettings,
    validation,
    closeDialog,
    showToast,
    t,
    collabEnabled,
    setCollabEnabled,
    project,
  ]);

  return (
    <DialogWrapper
      title={t('dialogs.projectSettings.title')}
      onClose={closeDialog}
      // Fixed height (like the global Settings dialog) so the content pane
      // scrolls within the dialog instead of overflowing the screen.
      fixedSize={{ width: 'min(720px, 95vw)', height: 'clamp(420px, 75vh, 760px)' }}
      closeOnBackdropClick={false}
      overflow="hidden"
      bodyClassName="flex flex-col flex-1 min-h-0"
      data-testid="project-settings-dialog"
    >
      {!project ? (
        <p className="text-text-secondary p-4">{t('dialogs.projectSettings.noProject')}</p>
      ) : (
        <>
          <div className="flex flex-1 min-h-0">
            {/* Sidebar tabs (mirrors the global Settings structure). */}
            <div className="w-44 shrink-0 border-r border-border p-2 space-y-1" role="tablist">
              {renderedTabs.map((tk) => (
                <button
                  key={tk}
                  id={tabId(tk)}
                  role="tab"
                  aria-selected={tab === tk}
                  aria-controls={panelId(tk)}
                  onClick={() => setTab(tk)}
                  className={`w-full text-left px-3 py-1.5 rounded text-sm ${tab === tk ? 'bg-accent-10 text-text-primary' : 'text-text-secondary hover:bg-background-50'}`}
                  data-testid={`project-settings-tab-${tk}`}
                >
                  {t(`dialogs.projectSettings.tabs.${tk}`)}
                </button>
              ))}
            </div>

            <div className="flex-1 min-w-0 overflow-auto p-4">
              {tab === 'general' && (
                <div role="tabpanel" id={panelId('general')} aria-labelledby={tabId('general')}>
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
              )}
              {tab === 'validation' && (
                <ValidationSettings
                  config={syntheticConfig}
                  onChange={handleConfigChange}
                  changedFields={EMPTY_CHANGED as Set<string>}
                  onValidationError={handleValidationError}
                  panelIdBase={panelIdBase}
                  scope="project"
                  defaults={globalConfig?.validation ?? defaultConfig.validation}
                />
              )}
              {tab === 'experimental' && (
                <div role="tabpanel" id={panelId('experimental')} aria-labelledby={tabId('experimental')}>
                  <SettingsSection title={t('dialogs.projectSettings.tabs.experimental')}>
                    <CollaborationSection project={project} enabled={collabEnabled} onChange={setCollabEnabledState} />
                  </SettingsSection>
                </div>
              )}
              {tab === 'speleodb' && isRemote && (
                <div role="tabpanel" id={panelId('speleodb')} aria-labelledby={tabId('speleodb')}>
                  <SpeleoDbSettingsTab />
                </div>
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
