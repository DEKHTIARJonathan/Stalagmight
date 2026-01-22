import { useEffect, useRef } from 'react';
import { Toggle } from '../../common/Toggle';
import { Select } from '../../common/Select';
import { SettingsSection } from './SettingsSection';
import { SettingRow } from './SettingRow';
import { getPanelId, getTabId } from '../SettingsSidebar';
import type { SettingsCategoryProps } from './types';
import { isFieldChanged } from './types';
import type { ShortcutFeedback } from '../../../types/config';

/**
 * General settings category content.
 * Maps to config.general: auto_save, auto_save_interval_seconds, recent_projects_max,
 * undo_history_limit, undo_persist_limit, shortcut_feedback.
 */
export function GeneralSettings({
  config,
  onChange,
  changedFields,
  onValidationError,
  panelIdBase,
}: SettingsCategoryProps) {
  // Validation state
  const hasErrorRef = useRef(false);

  // Validate on mount and when config changes
  useEffect(() => {
    const errors: string[] = [];

    // Validate auto_save_interval_seconds
    if (
      config.general.auto_save_interval_seconds < 10 ||
      config.general.auto_save_interval_seconds > 3600
    ) {
      errors.push('Auto-save interval must be between 10 and 3600 seconds');
    }

    // Validate recent_projects_max
    if (config.general.recent_projects_max < 1 || config.general.recent_projects_max > 50) {
      errors.push('Recent projects limit must be between 1 and 50');
    }

    // Validate undo_history_limit
    if (config.general.undo_history_limit < 10 || config.general.undo_history_limit > 1000) {
      errors.push('Undo history limit must be between 10 and 1000');
    }

    // Validate undo_persist_limit
    if (
      config.general.undo_persist_limit < 0 ||
      config.general.undo_persist_limit > config.general.undo_history_limit
    ) {
      errors.push('Undo persist limit must be between 0 and undo history limit');
    }

    const hasError = errors.length > 0;
    if (hasError !== hasErrorRef.current) {
      hasErrorRef.current = hasError;
      onValidationError('general', hasError);
    }
  }, [config.general, onValidationError]);

  const handleAutoSaveToggle = (checked: boolean) => {
    onChange({
      general: {
        ...config.general,
        auto_save: checked,
      },
    });
  };

  const handleAutoSaveIntervalChange = (value: string) => {
    const num = parseInt(value, 10);
    if (!isNaN(num)) {
      onChange({
        general: {
          ...config.general,
          auto_save_interval_seconds: num,
        },
      });
    }
  };

  const handleRecentProjectsChange = (value: string) => {
    const num = parseInt(value, 10);
    if (!isNaN(num)) {
      onChange({
        general: {
          ...config.general,
          recent_projects_max: num,
        },
      });
    }
  };

  const handleUndoHistoryChange = (value: string) => {
    const num = parseInt(value, 10);
    if (!isNaN(num)) {
      onChange({
        general: {
          ...config.general,
          undo_history_limit: num,
        },
      });
    }
  };

  const handleUndoPersistChange = (value: string) => {
    const num = parseInt(value, 10);
    if (!isNaN(num)) {
      onChange({
        general: {
          ...config.general,
          undo_persist_limit: num,
        },
      });
    }
  };

  const handleShortcutFeedbackChange = (value: string) => {
    onChange({
      general: {
        ...config.general,
        shortcut_feedback: value as ShortcutFeedback,
      },
    });
  };

  return (
    <div
      role="tabpanel"
      id={getPanelId(panelIdBase, 'general')}
      aria-labelledby={getTabId(panelIdBase, 'general')}
      data-testid="settings-panel-general"
    >
      <h2 className="text-lg font-medium mb-4">General</h2>

      <SettingsSection title="Saving" data-testid="section-saving">
        <SettingRow
          label="Auto-save"
          helpText="Automatically save changes at regular intervals"
          isChanged={isFieldChanged(changedFields, 'general.auto_save')}
          data-testid="setting-auto-save"
        >
          <Toggle
            checked={config.general.auto_save}
            onChange={handleAutoSaveToggle}
            aria-label="Enable auto-save"
            data-testid="toggle-auto-save"
          />
        </SettingRow>

        <SettingRow
          label="Auto-save interval"
          helpText="How often to auto-save (in seconds, 10-3600)"
          isChanged={isFieldChanged(changedFields, 'general.auto_save_interval_seconds')}
          data-testid="setting-auto-save-interval"
        >
          <input
            type="number"
            min={10}
            max={3600}
            value={config.general.auto_save_interval_seconds}
            onChange={(e) => handleAutoSaveIntervalChange(e.target.value)}
            className="w-20 px-2 py-1 bg-background border border-border rounded text-sm text-right"
            aria-label="Auto-save interval in seconds"
            data-testid="input-auto-save-interval"
          />
        </SettingRow>
      </SettingsSection>

      <SettingsSection title="Recent Projects" data-testid="section-recent">
        <SettingRow
          label="Maximum recent projects"
          helpText="Number of recent projects to remember (1-50)"
          isChanged={isFieldChanged(changedFields, 'general.recent_projects_max')}
          data-testid="setting-recent-max"
        >
          <input
            type="number"
            min={1}
            max={50}
            value={config.general.recent_projects_max}
            onChange={(e) => handleRecentProjectsChange(e.target.value)}
            className="w-20 px-2 py-1 bg-background border border-border rounded text-sm text-right"
            aria-label="Maximum recent projects"
            data-testid="input-recent-max"
          />
        </SettingRow>
      </SettingsSection>

      <SettingsSection title="Undo History" data-testid="section-undo">
        <SettingRow
          label="History limit"
          helpText="Maximum number of undo steps in memory (10-1000)"
          isChanged={isFieldChanged(changedFields, 'general.undo_history_limit')}
          data-testid="setting-undo-limit"
        >
          <input
            type="number"
            min={10}
            max={1000}
            value={config.general.undo_history_limit}
            onChange={(e) => handleUndoHistoryChange(e.target.value)}
            className="w-20 px-2 py-1 bg-background border border-border rounded text-sm text-right"
            aria-label="Undo history limit"
            data-testid="input-undo-limit"
          />
        </SettingRow>

        <SettingRow
          label="Persist limit"
          helpText="Number of undo steps to save with project (0 = none)"
          isChanged={isFieldChanged(changedFields, 'general.undo_persist_limit')}
          data-testid="setting-undo-persist"
        >
          <input
            type="number"
            min={0}
            max={config.general.undo_history_limit}
            value={config.general.undo_persist_limit}
            onChange={(e) => handleUndoPersistChange(e.target.value)}
            className="w-20 px-2 py-1 bg-background border border-border rounded text-sm text-right"
            aria-label="Undo persist limit"
            data-testid="input-undo-persist"
          />
        </SettingRow>
      </SettingsSection>

      <SettingsSection title="Feedback" data-testid="section-feedback">
        <SettingRow
          label="Shortcut feedback"
          helpText="Show toast notifications when keyboard shortcuts are activated"
          isChanged={isFieldChanged(changedFields, 'general.shortcut_feedback')}
          data-testid="setting-shortcut-feedback"
        >
          <Select
            value={config.general.shortcut_feedback}
            onChange={handleShortcutFeedbackChange}
            options={[
              { value: 'none', label: 'None' },
              { value: 'non_obvious', label: 'Non-obvious only' },
              { value: 'all', label: 'All' },
            ]}
            className="w-40"
            aria-label="Shortcut feedback preference"
            data-testid="select-shortcut-feedback"
          />
        </SettingRow>
      </SettingsSection>
    </div>
  );
}
