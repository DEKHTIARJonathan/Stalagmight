import { useState, useEffect, useRef, useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Toggle } from '../../common/Toggle';
import { Select } from '../../common/Select';
import { Button } from '../../common/Button';
import { SettingsSection } from './SettingsSection';
import { SettingRow } from './SettingRow';
import { getPanelId, getTabId } from '../SettingsSidebar';
import type { SettingsCategoryProps } from './types';
import { isFieldChanged } from './types';
import type { Config } from '../../../types/config';
import { useProjectStore } from '../../../store/projectStore';

const LOG_LEVEL_OPTIONS = [
  { value: 'trace', label: 'Trace (most verbose)' },
  { value: 'debug', label: 'Debug' },
  { value: 'info', label: 'Info (default)' },
  { value: 'warn', label: 'Warning' },
  { value: 'error', label: 'Error (least verbose)' },
];

/**
 * Compute differences between two config objects for reload display.
 */
function computeConfigDiff(
  oldConfig: Config,
  newConfig: Config
): Array<{ path: string; oldValue: string; newValue: string }> {
  const changes: Array<{ path: string; oldValue: string; newValue: string }> = [];

  // Check debug.map settings
  if (oldConfig.debug.map.show_hitboxes !== newConfig.debug.map.show_hitboxes) {
    changes.push({
      path: 'debug.map.show_hitboxes',
      oldValue: String(oldConfig.debug.map.show_hitboxes),
      newValue: String(newConfig.debug.map.show_hitboxes),
    });
  }
  if (oldConfig.debug.map.log_hit_detection !== newConfig.debug.map.log_hit_detection) {
    changes.push({
      path: 'debug.map.log_hit_detection',
      oldValue: String(oldConfig.debug.map.log_hit_detection),
      newValue: String(newConfig.debug.map.log_hit_detection),
    });
  }

  // Check logging settings
  if (oldConfig.logging.level !== newConfig.logging.level) {
    changes.push({
      path: 'logging.level',
      oldValue: oldConfig.logging.level,
      newValue: newConfig.logging.level,
    });
  }
  if (oldConfig.logging.max_directory_size_mb !== newConfig.logging.max_directory_size_mb) {
    changes.push({
      path: 'logging.max_directory_size_mb',
      oldValue: String(oldConfig.logging.max_directory_size_mb),
      newValue: String(newConfig.logging.max_directory_size_mb),
    });
  }

  // Check panel settings
  if (oldConfig.panels.sections_panel_width !== newConfig.panels.sections_panel_width) {
    changes.push({
      path: 'panels.sections_panel_width',
      oldValue: String(oldConfig.panels.sections_panel_width),
      newValue: String(newConfig.panels.sections_panel_width),
    });
  }
  if (oldConfig.panels.detail_panel_width !== newConfig.panels.detail_panel_width) {
    changes.push({
      path: 'panels.detail_panel_width',
      oldValue: String(oldConfig.panels.detail_panel_width),
      newValue: String(newConfig.panels.detail_panel_width),
    });
  }
  if (oldConfig.panels.data_table_height !== newConfig.panels.data_table_height) {
    changes.push({
      path: 'panels.data_table_height',
      oldValue: String(oldConfig.panels.data_table_height),
      newValue: String(newConfig.panels.data_table_height),
    });
  }

  return changes;
}

/**
 * Advanced settings category content.
 * Maps to config.debug + config.logging + config.panels, plus Reload Config button.
 */
export function AdvancedSettings({
  config,
  onChange,
  changedFields,
  onValidationError,
  panelIdBase,
}: SettingsCategoryProps) {
  const { setConfig } = useProjectStore();
  const [isReloading, setIsReloading] = useState(false);
  const [reloadMessage, setReloadMessage] = useState<string | null>(null);
  const mountedRef = useRef(true);

  // Validation state
  const hasErrorRef = useRef(false);

  // Validate on mount and when config changes
  useEffect(() => {
    const errors: string[] = [];

    // Validate logging max directory size
    if (config.logging.max_directory_size_mb < 1 || config.logging.max_directory_size_mb > 10000) {
      errors.push('Log directory size must be between 1 and 10000 MB');
    }

    // Validate panel dimensions
    if (config.panels.sections_panel_width < 100 || config.panels.sections_panel_width > 800) {
      errors.push('Sections panel width must be between 100 and 800');
    }
    if (config.panels.detail_panel_width < 150 || config.panels.detail_panel_width > 800) {
      errors.push('Detail panel width must be between 150 and 800');
    }
    if (config.panels.data_table_height < 100 || config.panels.data_table_height > 600) {
      errors.push('Data table height must be between 100 and 600');
    }

    const hasError = errors.length > 0;
    if (hasError !== hasErrorRef.current) {
      hasErrorRef.current = hasError;
      onValidationError('advanced', hasError);
    }
  }, [config.logging, config.panels, onValidationError]);

  // Cleanup on unmount
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Debug settings
  const handleShowHitboxesChange = (checked: boolean) => {
    onChange({
      debug: {
        ...config.debug,
        map: {
          ...config.debug.map,
          show_hitboxes: checked,
        },
      },
    });
  };

  const handleLogHitDetectionChange = (checked: boolean) => {
    onChange({
      debug: {
        ...config.debug,
        map: {
          ...config.debug.map,
          log_hit_detection: checked,
        },
      },
    });
  };

  // Logging settings
  const handleLogLevelChange = (value: string) => {
    onChange({
      logging: {
        ...config.logging,
        level: value,
      },
    });
  };

  const handleMaxLogSizeChange = (value: string) => {
    const num = parseInt(value, 10);
    if (!isNaN(num)) {
      onChange({
        logging: {
          ...config.logging,
          max_directory_size_mb: num,
        },
      });
    }
  };

  // Panel settings
  const handleSectionsPanelWidthChange = (value: string) => {
    const num = parseInt(value, 10);
    if (!isNaN(num)) {
      onChange({
        panels: {
          ...config.panels,
          sections_panel_width: num,
        },
      });
    }
  };

  const handleDetailPanelWidthChange = (value: string) => {
    const num = parseInt(value, 10);
    if (!isNaN(num)) {
      onChange({
        panels: {
          ...config.panels,
          detail_panel_width: num,
        },
      });
    }
  };

  const handleDataTableHeightChange = (value: string) => {
    const num = parseInt(value, 10);
    if (!isNaN(num)) {
      onChange({
        panels: {
          ...config.panels,
          data_table_height: num,
        },
      });
    }
  };

  // Reload config from disk
  const handleReloadConfig = useCallback(async () => {
    setIsReloading(true);
    setReloadMessage(null);
    try {
      const newConfig = await invoke<Config>('reload_config');

      if (!mountedRef.current) return;

      const changes = computeConfigDiff(config, newConfig);
      setConfig(newConfig);

      if (changes.length > 0) {
        const changeList = changes
          .map((c) => `${c.path}: ${c.oldValue} -> ${c.newValue}`)
          .join('\n');
        setReloadMessage(`Config reloaded:\n${changeList}`);
      } else {
        setReloadMessage('Config reloaded (no changes detected in advanced settings)');
      }
    } catch (error) {
      console.error('[AdvancedSettings] Failed to reload config:', error);
      if (mountedRef.current) {
        setReloadMessage(`Failed to reload config: ${error}`);
      }
    } finally {
      if (mountedRef.current) {
        setIsReloading(false);
      }
    }
  }, [config, setConfig]);

  return (
    <div
      role="tabpanel"
      id={getPanelId(panelIdBase, 'advanced')}
      aria-labelledby={getTabId(panelIdBase, 'advanced')}
      data-testid="settings-panel-advanced"
    >
      <h2 className="text-lg font-medium mb-4">Advanced</h2>

      <SettingsSection title="Debug" data-testid="section-debug">
        <SettingRow
          label="Show hitboxes"
          helpText="Visualize clickable areas for stations and shots"
          isChanged={isFieldChanged(changedFields, 'debug.map.show_hitboxes')}
          data-testid="setting-show-hitboxes"
        >
          <Toggle
            checked={config.debug.map.show_hitboxes}
            onChange={handleShowHitboxesChange}
            aria-label="Show hitboxes"
            data-testid="toggle-show-hitboxes"
          />
        </SettingRow>

        <SettingRow
          label="Log hit detection"
          helpText="Log click/hover detection events to console"
          isChanged={isFieldChanged(changedFields, 'debug.map.log_hit_detection')}
          data-testid="setting-log-hit-detection"
        >
          <Toggle
            checked={config.debug.map.log_hit_detection}
            onChange={handleLogHitDetectionChange}
            aria-label="Log hit detection"
            data-testid="toggle-log-hit-detection"
          />
        </SettingRow>
      </SettingsSection>

      <SettingsSection title="Logging" data-testid="section-logging">
        <SettingRow
          label="Log level"
          helpText="Minimum severity level for log messages"
          isChanged={isFieldChanged(changedFields, 'logging.level')}
          requiresRestart
          data-testid="setting-log-level"
        >
          <Select
            value={config.logging.level}
            onChange={handleLogLevelChange}
            options={LOG_LEVEL_OPTIONS}
            className="w-48"
            aria-label="Log level"
            data-testid="select-log-level"
          />
        </SettingRow>

        <SettingRow
          label="Max log directory size"
          helpText="Maximum total size for log files (1-10000 MB)"
          isChanged={isFieldChanged(changedFields, 'logging.max_directory_size_mb')}
          data-testid="setting-max-log-size"
        >
          <div className="flex items-center gap-2">
            <input
              type="number"
              min={1}
              max={10000}
              value={config.logging.max_directory_size_mb}
              onChange={(e) => handleMaxLogSizeChange(e.target.value)}
              className="w-24 px-2 py-1 bg-background border border-border rounded text-sm text-right"
              aria-label="Max log directory size in MB"
              data-testid="input-max-log-size"
            />
            <span className="text-text-secondary">MB</span>
          </div>
        </SettingRow>
      </SettingsSection>

      <SettingsSection title="Panel Dimensions" data-testid="section-panels">
        <SettingRow
          label="Sections panel width"
          helpText="Default width of the sections panel (100-800 px)"
          isChanged={isFieldChanged(changedFields, 'panels.sections_panel_width')}
          data-testid="setting-sections-panel-width"
        >
          <div className="flex items-center gap-2">
            <input
              type="number"
              min={100}
              max={800}
              value={config.panels.sections_panel_width}
              onChange={(e) => handleSectionsPanelWidthChange(e.target.value)}
              className="w-20 px-2 py-1 bg-background border border-border rounded text-sm text-right"
              aria-label="Sections panel width"
              data-testid="input-sections-panel-width"
            />
            <span className="text-text-secondary">px</span>
          </div>
        </SettingRow>

        <SettingRow
          label="Detail panel width"
          helpText="Default width of the detail panel (150-800 px)"
          isChanged={isFieldChanged(changedFields, 'panels.detail_panel_width')}
          data-testid="setting-detail-panel-width"
        >
          <div className="flex items-center gap-2">
            <input
              type="number"
              min={150}
              max={800}
              value={config.panels.detail_panel_width}
              onChange={(e) => handleDetailPanelWidthChange(e.target.value)}
              className="w-20 px-2 py-1 bg-background border border-border rounded text-sm text-right"
              aria-label="Detail panel width"
              data-testid="input-detail-panel-width"
            />
            <span className="text-text-secondary">px</span>
          </div>
        </SettingRow>

        <SettingRow
          label="Data table height"
          helpText="Default height of the data table (100-600 px)"
          isChanged={isFieldChanged(changedFields, 'panels.data_table_height')}
          data-testid="setting-data-table-height"
        >
          <div className="flex items-center gap-2">
            <input
              type="number"
              min={100}
              max={600}
              value={config.panels.data_table_height}
              onChange={(e) => handleDataTableHeightChange(e.target.value)}
              className="w-20 px-2 py-1 bg-background border border-border rounded text-sm text-right"
              aria-label="Data table height"
              data-testid="input-data-table-height"
            />
            <span className="text-text-secondary">px</span>
          </div>
        </SettingRow>
      </SettingsSection>

      <SettingsSection title="Configuration File" data-testid="section-config-file">
        <div className="space-y-3">
          <Button
            variant="secondary"
            onClick={handleReloadConfig}
            disabled={isReloading}
            data-testid="reload-config-button"
          >
            {isReloading ? 'Reloading...' : 'Reload Config from Disk'}
          </Button>
          <p className="text-xs text-text-secondary">
            Reload configuration from the config file, discarding any unsaved changes.
          </p>
          {reloadMessage && (
            <pre className="text-xs p-2 bg-background rounded border border-border whitespace-pre-wrap">
              {reloadMessage}
            </pre>
          )}
        </div>
      </SettingsSection>
    </div>
  );
}
