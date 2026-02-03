import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { invoke } from '@tauri-apps/api/core';
import { Toggle } from '../../common/Toggle';
import { Select } from '../../common/Select';
import { Button } from '../../common/Button';
import { SettingsSection } from './SettingsSection';
import { SettingRow } from './SettingRow';
import { getPanelId, getTabId } from '../SettingsSidebar';
import type { SettingsCategoryProps } from './types';
import { isFieldChanged } from './types';
import type { Config, TransitVerticalMode } from '../../../types/config';
import type { ClosureStrategy } from '../../../types/project';
import { useProjectStore } from '../../../store/projectStore';

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

  // Check closure adjustment settings
  if (oldConfig.closure_adjustment.base_sigma_length_m !== newConfig.closure_adjustment.base_sigma_length_m) {
    changes.push({
      path: 'closure_adjustment.base_sigma_length_m',
      oldValue: String(oldConfig.closure_adjustment.base_sigma_length_m),
      newValue: String(newConfig.closure_adjustment.base_sigma_length_m),
    });
  }
  if (oldConfig.closure_adjustment.base_sigma_azimuth_deg !== newConfig.closure_adjustment.base_sigma_azimuth_deg) {
    changes.push({
      path: 'closure_adjustment.base_sigma_azimuth_deg',
      oldValue: String(oldConfig.closure_adjustment.base_sigma_azimuth_deg),
      newValue: String(newConfig.closure_adjustment.base_sigma_azimuth_deg),
    });
  }
  if (oldConfig.closure_adjustment.base_sigma_depth_m !== newConfig.closure_adjustment.base_sigma_depth_m) {
    changes.push({
      path: 'closure_adjustment.base_sigma_depth_m',
      oldValue: String(oldConfig.closure_adjustment.base_sigma_depth_m),
      newValue: String(newConfig.closure_adjustment.base_sigma_depth_m),
    });
  }
  if (oldConfig.closure_adjustment.transit_vertical_mode !== newConfig.closure_adjustment.transit_vertical_mode) {
    changes.push({
      path: 'closure_adjustment.transit_vertical_mode',
      oldValue: String(oldConfig.closure_adjustment.transit_vertical_mode),
      newValue: String(newConfig.closure_adjustment.transit_vertical_mode),
    });
  }
  if (oldConfig.closure_adjustment.sequential_distribution_default !== newConfig.closure_adjustment.sequential_distribution_default) {
    changes.push({
      path: 'closure_adjustment.sequential_distribution_default',
      oldValue: String(oldConfig.closure_adjustment.sequential_distribution_default),
      newValue: String(newConfig.closure_adjustment.sequential_distribution_default),
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
  const { t } = useTranslation();
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
      errors.push(t('settings.advanced.validation.logSize'));
    }

    // Validate panel dimensions
    if (config.panels.sections_panel_width < 100 || config.panels.sections_panel_width > 800) {
      errors.push(t('settings.advanced.validation.sectionsPanel'));
    }
    if (config.panels.detail_panel_width < 150 || config.panels.detail_panel_width > 800) {
      errors.push(t('settings.advanced.validation.detailPanel'));
    }
    if (config.panels.data_table_height < 100 || config.panels.data_table_height > 600) {
      errors.push(t('settings.advanced.validation.dataTable'));
    }

    if (config.closure_adjustment.base_sigma_length_m <= 0) {
      errors.push(t('settings.advanced.validation.closureSigmaLength'));
    }
    if (config.closure_adjustment.base_sigma_azimuth_deg <= 0) {
      errors.push(t('settings.advanced.validation.closureSigmaAzimuth'));
    }
    if (config.closure_adjustment.base_sigma_depth_m <= 0) {
      errors.push(t('settings.advanced.validation.closureSigmaDepth'));
    }

    const hasError = errors.length > 0;
    if (hasError !== hasErrorRef.current) {
      hasErrorRef.current = hasError;
      onValidationError('advanced', hasError);
    }
  }, [config.logging, config.panels, config.closure_adjustment, onValidationError, t]);

  const logLevelOptions = useMemo(() => [
    { value: 'trace', label: t('settings.advanced.logging.level.options.trace') },
    { value: 'debug', label: t('settings.advanced.logging.level.options.debug') },
    { value: 'info', label: t('settings.advanced.logging.level.options.info') },
    { value: 'warn', label: t('settings.advanced.logging.level.options.warn') },
    { value: 'error', label: t('settings.advanced.logging.level.options.error') },
  ], [t]);

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

  const updateClosureAdjustment = useCallback((updates: Partial<Config['closure_adjustment']>) => {
    onChange({
      closure_adjustment: {
        ...config.closure_adjustment,
        ...updates,
      },
    });
  }, [config.closure_adjustment, onChange]);

  const handleSigmaLengthChange = (value: string) => {
    const num = parseFloat(value);
    if (!isNaN(num)) {
      updateClosureAdjustment({ base_sigma_length_m: num });
    }
  };

  const handleSigmaAzimuthChange = (value: string) => {
    const num = parseFloat(value);
    if (!isNaN(num)) {
      updateClosureAdjustment({ base_sigma_azimuth_deg: num });
    }
  };

  const handleSigmaDepthChange = (value: string) => {
    const num = parseFloat(value);
    if (!isNaN(num)) {
      updateClosureAdjustment({ base_sigma_depth_m: num });
    }
  };

  const handleTransitVerticalChange = (value: TransitVerticalMode) => {
    updateClosureAdjustment({ transit_vertical_mode: value });
  };

  const handleSequentialDistributionChange = (value: ClosureStrategy) => {
    updateClosureAdjustment({ sequential_distribution_default: value });
  };

  // Reload config from disk
  const handleReloadConfig = useCallback(async () => {
    setIsReloading(true);
    setReloadMessage(null);
    try {
      const newConfig = await invoke<Config>('reload_config');

      if (!mountedRef.current) return;

      const changes = computeConfigDiff(config, newConfig);

      // Update both the store and the local dialog state via onChange
      // This ensures the UI reflects the reloaded config and clears unsaved changes
      setConfig(newConfig);
      onChange(newConfig);

      if (changes.length > 0) {
        const changeList = changes
          .map((c) => `${c.path}: ${c.oldValue} -> ${c.newValue}`)
          .join('\n');
        setReloadMessage(t('settings.advanced.reload.success', { changes: changeList }));
      } else {
        setReloadMessage(t('settings.advanced.reload.noChanges'));
      }
    } catch (error) {
      console.error('[AdvancedSettings] Failed to reload config:', error);
      if (mountedRef.current) {
        setReloadMessage(t('settings.advanced.reload.error', { error: String(error) }));
      }
    } finally {
      if (mountedRef.current) {
        setIsReloading(false);
      }
    }
  }, [config, setConfig, onChange, t]);

  return (
    <div
      role="tabpanel"
      id={getPanelId(panelIdBase, 'advanced')}
      aria-labelledby={getTabId(panelIdBase, 'advanced')}
      data-testid="settings-panel-advanced"
    >
      <h2 className="text-lg font-medium mb-4">{t('settings.advanced.title')}</h2>

      <SettingsSection title={t('settings.advanced.sections.debug')} data-testid="section-debug">
        <SettingRow
          label={t('settings.advanced.debug.showHitboxes.label')}
          helpText={t('settings.advanced.debug.showHitboxes.help')}
          isChanged={isFieldChanged(changedFields, 'debug.map.show_hitboxes')}
          data-testid="setting-show-hitboxes"
        >
          <Toggle
            checked={config.debug.map.show_hitboxes}
            onChange={handleShowHitboxesChange}
            aria-label={t('settings.advanced.debug.showHitboxes.aria')}
            data-testid="toggle-show-hitboxes"
          />
        </SettingRow>

        <SettingRow
          label={t('settings.advanced.debug.logHitDetection.label')}
          helpText={t('settings.advanced.debug.logHitDetection.help')}
          isChanged={isFieldChanged(changedFields, 'debug.map.log_hit_detection')}
          data-testid="setting-log-hit-detection"
        >
          <Toggle
            checked={config.debug.map.log_hit_detection}
            onChange={handleLogHitDetectionChange}
            aria-label={t('settings.advanced.debug.logHitDetection.aria')}
            data-testid="toggle-log-hit-detection"
          />
        </SettingRow>
      </SettingsSection>

      <SettingsSection title={t('settings.advanced.sections.logging')} data-testid="section-logging">
        <SettingRow
          label={t('settings.advanced.logging.level.label')}
          helpText={t('settings.advanced.logging.level.help')}
          isChanged={isFieldChanged(changedFields, 'logging.level')}
          requiresRestart
          data-testid="setting-log-level"
        >
          <Select
            value={config.logging.level}
            onChange={handleLogLevelChange}
            options={logLevelOptions}
            className="w-48"
            aria-label={t('settings.advanced.logging.level.aria')}
            data-testid="select-log-level"
          />
        </SettingRow>

        <SettingRow
          label={t('settings.advanced.logging.maxSize.label')}
          helpText={t('settings.advanced.logging.maxSize.help')}
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
              aria-label={t('settings.advanced.logging.maxSize.aria')}
              data-testid="input-max-log-size"
            />
            <span className="text-text-secondary">{t('settings.advanced.logging.maxSize.unit')}</span>
          </div>
        </SettingRow>
      </SettingsSection>

      <SettingsSection title={t('settings.advanced.sections.closureAdjustment')} data-testid="section-closure-adjustment">
        <SettingRow
          label={t('settings.advanced.closureAdjustment.sigmaLength.label')}
          helpText={t('settings.advanced.closureAdjustment.sigmaLength.help')}
          isChanged={isFieldChanged(changedFields, 'closure_adjustment.base_sigma_length_m')}
          data-testid="setting-closure-sigma-length"
        >
          <input
            type="number"
            min={0.001}
            step={0.01}
            value={config.closure_adjustment.base_sigma_length_m}
            onChange={(e) => handleSigmaLengthChange(e.target.value)}
            className="w-24 px-2 py-1 bg-background border border-border rounded text-sm text-right"
            aria-label={t('settings.advanced.closureAdjustment.sigmaLength.aria')}
            data-testid="input-closure-sigma-length"
          />
        </SettingRow>

        <SettingRow
          label={t('settings.advanced.closureAdjustment.sigmaAzimuth.label')}
          helpText={t('settings.advanced.closureAdjustment.sigmaAzimuth.help')}
          isChanged={isFieldChanged(changedFields, 'closure_adjustment.base_sigma_azimuth_deg')}
          data-testid="setting-closure-sigma-azimuth"
        >
          <input
            type="number"
            min={0.01}
            step={0.1}
            value={config.closure_adjustment.base_sigma_azimuth_deg}
            onChange={(e) => handleSigmaAzimuthChange(e.target.value)}
            className="w-24 px-2 py-1 bg-background border border-border rounded text-sm text-right"
            aria-label={t('settings.advanced.closureAdjustment.sigmaAzimuth.aria')}
            data-testid="input-closure-sigma-azimuth"
          />
        </SettingRow>

        <SettingRow
          label={t('settings.advanced.closureAdjustment.sigmaDepth.label')}
          helpText={t('settings.advanced.closureAdjustment.sigmaDepth.help')}
          isChanged={isFieldChanged(changedFields, 'closure_adjustment.base_sigma_depth_m')}
          data-testid="setting-closure-sigma-depth"
        >
          <input
            type="number"
            min={0.001}
            step={0.01}
            value={config.closure_adjustment.base_sigma_depth_m}
            onChange={(e) => handleSigmaDepthChange(e.target.value)}
            className="w-24 px-2 py-1 bg-background border border-border rounded text-sm text-right"
            aria-label={t('settings.advanced.closureAdjustment.sigmaDepth.aria')}
            data-testid="input-closure-sigma-depth"
          />
        </SettingRow>

        <SettingRow
          label={t('settings.advanced.closureAdjustment.transitVertical.label')}
          helpText={t('settings.advanced.closureAdjustment.transitVertical.help')}
          isChanged={isFieldChanged(changedFields, 'closure_adjustment.transit_vertical_mode')}
          data-testid="setting-closure-transit-vertical"
        >
          <Select
            value={config.closure_adjustment.transit_vertical_mode}
            onChange={(v) => handleTransitVerticalChange(v as TransitVerticalMode)}
            options={[
              { value: 'ignore', label: t('settings.advanced.closureAdjustment.transitVertical.ignore') },
              { value: 'length_proportional', label: t('settings.advanced.closureAdjustment.transitVertical.length') },
              { value: 'equal', label: t('settings.advanced.closureAdjustment.transitVertical.equal') },
            ]}
            className="w-48"
            aria-label={t('settings.advanced.closureAdjustment.transitVertical.aria')}
            data-testid="select-closure-transit-vertical"
          />
        </SettingRow>

        <SettingRow
          label={t('settings.advanced.closureAdjustment.sequentialDistribution.label')}
          helpText={t('settings.advanced.closureAdjustment.sequentialDistribution.help')}
          isChanged={isFieldChanged(changedFields, 'closure_adjustment.sequential_distribution_default')}
          data-testid="setting-closure-sequential-distribution"
        >
          <Select
            value={config.closure_adjustment.sequential_distribution_default}
            onChange={(v) => handleSequentialDistributionChange(v as ClosureStrategy)}
            options={[
              { value: 'ProportionalByLength', label: t('settings.advanced.closureAdjustment.sequentialDistribution.proportional') },
              { value: 'EqualDistribution', label: t('settings.advanced.closureAdjustment.sequentialDistribution.equal') },
              { value: 'TransitRule', label: t('settings.advanced.closureAdjustment.sequentialDistribution.transit') },
            ]}
            className="w-48"
            aria-label={t('settings.advanced.closureAdjustment.sequentialDistribution.aria')}
            data-testid="select-closure-sequential-distribution"
          />
        </SettingRow>
      </SettingsSection>

      <SettingsSection title={t('settings.advanced.sections.panels')} data-testid="section-panels">
        <SettingRow
          label={t('settings.advanced.panels.sectionsWidth.label')}
          helpText={t('settings.advanced.panels.sectionsWidth.help')}
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
              aria-label={t('settings.advanced.panels.sectionsWidth.aria')}
              data-testid="input-sections-panel-width"
            />
            <span className="text-text-secondary">{t('settings.advanced.panels.sectionsWidth.unit')}</span>
          </div>
        </SettingRow>

        <SettingRow
          label={t('settings.advanced.panels.detailWidth.label')}
          helpText={t('settings.advanced.panels.detailWidth.help')}
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
              aria-label={t('settings.advanced.panels.detailWidth.aria')}
              data-testid="input-detail-panel-width"
            />
            <span className="text-text-secondary">{t('settings.advanced.panels.detailWidth.unit')}</span>
          </div>
        </SettingRow>

        <SettingRow
          label={t('settings.advanced.panels.dataTableHeight.label')}
          helpText={t('settings.advanced.panels.dataTableHeight.help')}
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
              aria-label={t('settings.advanced.panels.dataTableHeight.aria')}
              data-testid="input-data-table-height"
            />
            <span className="text-text-secondary">{t('settings.advanced.panels.dataTableHeight.unit')}</span>
          </div>
        </SettingRow>
      </SettingsSection>

      <SettingsSection title={t('settings.advanced.sections.configFile')} data-testid="section-config-file">
        <div className="space-y-3">
          <Button
            variant="secondary"
            onClick={handleReloadConfig}
            disabled={isReloading}
            data-testid="reload-config-button"
          >
            {isReloading ? t('settings.advanced.reload.loading') : t('settings.advanced.reload.button')}
          </Button>
          <p className="text-xs text-text-secondary">
            {t('settings.advanced.reload.help')}
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
