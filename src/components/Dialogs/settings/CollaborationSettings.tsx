import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Toggle } from '../../common/Toggle';
import { SettingsSection } from './SettingsSection';
import { SettingRow } from './SettingRow';
import { getPanelId, getTabId } from '../SettingsSidebar';
import type { SettingsCategoryProps } from './types';
import { useProjectStore } from '../../../store/projectStore';
import { useUIStore } from '../../../store/uiStore';
import { extractFilename } from '../../../utils/path';

/**
 * Compute the default sibling .tml name from a project's .stalx path.
 * Mirrors the backend's `default_sibling_name` (stem + ".tml").
 */
function defaultSiblingName(filePath: string | null | undefined): string | null {
  if (!filePath) return null;
  const base = extractFilename(filePath);
  const dot = base.lastIndexOf('.');
  const stem = dot > 0 ? base.slice(0, dot) : base;
  return `${stem}.tml`;
}

/**
 * Collaboration settings category.
 *
 * Unlike the other settings categories, collaboration mode is **project-scoped**
 * state persisted in the `.stalx` (not the app config), so it is applied
 * immediately via the store rather than batched into the Settings "Save" button.
 */
export function CollaborationSettings({ panelIdBase }: SettingsCategoryProps) {
  const { t } = useTranslation();
  const project = useProjectStore((s) => s.project);
  const setCollabEnabled = useProjectStore((s) => s.setCollabEnabled);
  const showToast = useUIStore((s) => s.showToast);
  const [busy, setBusy] = useState(false);

  const hasFile = !!project?.file_path;
  const enabled = project?.collab?.enabled ?? false;
  const siblingName = project?.collab?.sibling_tml_relative ?? defaultSiblingName(project?.file_path);

  const handleToggle = useCallback(
    async (next: boolean) => {
      setBusy(true);
      try {
        const result = await setCollabEnabled(next);
        if (!result.success) {
          showToast(result.error ?? t('settings.collaboration.toggleFailed', 'Failed to change collaboration mode'), 'collab-toggle');
        }
      } catch (e) {
        showToast(String(e), 'collab-toggle');
      } finally {
        setBusy(false);
      }
    },
    [setCollabEnabled, showToast, t]
  );

  return (
    <div
      role="tabpanel"
      id={getPanelId(panelIdBase, 'collaboration')}
      aria-labelledby={getTabId(panelIdBase, 'collaboration')}
      data-testid="settings-panel-collaboration"
    >
      <h2 className="text-lg font-medium mb-4">
        {t('settings.collaboration.title', 'Collaboration')}
      </h2>

      <p className="text-sm text-text-secondary mb-4">
        {t(
          'settings.collaboration.intro',
          'Collaboration mode keeps an Ariane file (.tml) next to this project so collaborators who use Ariane can edit the survey. Stalagmight saves both files; when the Ariane file is changed externally, you are prompted on open to review and merge those changes back in.'
        )}
      </p>

      <SettingsSection
        title={t('settings.collaboration.sections.ariane', 'Ariane companion file')}
        data-testid="section-collaboration"
      >
        <SettingRow
          label={t('settings.collaboration.enable.label', 'Enable collaboration mode')}
          helpText={
            hasFile
              ? t('settings.collaboration.enable.help', 'Every save also writes the companion Ariane file shown below.')
              : t('settings.collaboration.enable.helpNoFile', 'The companion file is created next to the project the first time you save it.')
          }
          data-testid="setting-collaboration-enable"
        >
          <Toggle
            checked={enabled}
            onChange={handleToggle}
            disabled={busy}
            aria-label={t('settings.collaboration.enable.aria', 'Toggle collaboration mode')}
            data-testid="toggle-collaboration"
          />
        </SettingRow>

        {siblingName && (
          <div className="py-3" data-testid="collaboration-sibling-path">
            <div className="text-sm font-medium text-text-primary mb-1">
              {t('settings.collaboration.siblingFile.label', 'Companion file')}
            </div>
            <code className="text-xs text-text-secondary break-all">{siblingName}</code>
            <div className="text-xs text-text-tertiary mt-1">
              {t(
                'settings.collaboration.siblingFile.help',
                'Saved in the same folder as the project. Every save writes this file.'
              )}
            </div>
          </div>
        )}
      </SettingsSection>
    </div>
  );
}
