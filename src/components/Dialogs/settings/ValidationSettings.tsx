import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { SettingsSection } from './SettingsSection';
import { SettingRow } from './SettingRow';
import { getPanelId, getTabId } from '../SettingsSidebar';
import type { SettingsCategoryProps } from './types';
import { isFieldChanged } from './types';
import { defaultConfig } from '../../../types/config';

/**
 * Validation settings category content.
 * Maps to config.validation: warn_shot_length_min/max, warn_depth_change_per_shot_max,
 * azimuth_diff_threshold, pitch_diff_threshold.
 */
export function ValidationSettings({
  config,
  onChange,
  changedFields,
  onValidationError,
  panelIdBase,
}: SettingsCategoryProps) {
  const { t } = useTranslation();
  // Validation state
  const hasErrorRef = useRef(false);

  // Validate on mount and when config changes
  useEffect(() => {
    const errors: string[] = [];

    // Validate shot length thresholds
    if (config.validation.warn_shot_length_min < 0) {
      errors.push(t('settings.validation.validation.minShotLength'));
    }
    if (config.validation.warn_shot_length_max <= config.validation.warn_shot_length_min) {
      errors.push(t('settings.validation.validation.maxShotLength'));
    }

    // Validate depth change threshold
    if (config.validation.warn_depth_change_per_shot_max <= 0) {
      errors.push(t('settings.validation.validation.depthChange'));
    }

    // Validate diff thresholds (0 means disabled)
    if (config.validation.azimuth_diff_threshold < 0 || config.validation.azimuth_diff_threshold > 180) {
      errors.push(t('settings.validation.validation.azimuthDiff'));
    }
    if (config.validation.pitch_diff_threshold < 0 || config.validation.pitch_diff_threshold > 90) {
      errors.push(t('settings.validation.validation.pitchDiff'));
    }

    const hasError = errors.length > 0;
    if (hasError !== hasErrorRef.current) {
      hasErrorRef.current = hasError;
      onValidationError('validation', hasError);
    }
  }, [config.validation, onValidationError, t]);

  const handleShotLengthMinChange = (value: string) => {
    const num = parseFloat(value);
    if (!isNaN(num)) {
      onChange({
        validation: {
          ...config.validation,
          warn_shot_length_min: num,
        },
      });
    }
  };

  const handleShotLengthMaxChange = (value: string) => {
    const num = parseFloat(value);
    if (!isNaN(num)) {
      onChange({
        validation: {
          ...config.validation,
          warn_shot_length_max: num,
        },
      });
    }
  };

  const handleDepthChangeMaxChange = (value: string) => {
    const num = parseFloat(value);
    if (!isNaN(num)) {
      onChange({
        validation: {
          ...config.validation,
          warn_depth_change_per_shot_max: num,
        },
      });
    }
  };

  const handleAzimuthDiffChange = (value: string) => {
    const num = parseFloat(value);
    if (!isNaN(num)) {
      onChange({
        validation: {
          ...config.validation,
          azimuth_diff_threshold: num,
        },
      });
    }
  };

  const handlePitchDiffChange = (value: string) => {
    const num = parseFloat(value);
    if (!isNaN(num)) {
      onChange({
        validation: {
          ...config.validation,
          pitch_diff_threshold: num,
        },
      });
    }
  };

  return (
    <div
      role="tabpanel"
      id={getPanelId(panelIdBase, 'validation')}
      aria-labelledby={getTabId(panelIdBase, 'validation')}
      data-testid="settings-panel-validation"
    >
      <h2 className="text-lg font-medium mb-4">{t('settings.validation.title')}</h2>

      <SettingsSection title={t('settings.validation.sections.shotLength')} data-testid="section-shot-length">
        <SettingRow
          label={t('settings.validation.shotLength.min.label')}
          helpText={t('settings.validation.shotLength.min.help')}
          isChanged={isFieldChanged(changedFields, 'validation.warn_shot_length_min')}
          onReset={() => onChange({ validation: { ...config.validation, warn_shot_length_min: defaultConfig.validation.warn_shot_length_min } })}
          isDefault={config.validation.warn_shot_length_min === defaultConfig.validation.warn_shot_length_min}
          data-testid="setting-shot-length-min"
        >
          <input
            type="number"
            step={0.1}
            min={0}
            value={config.validation.warn_shot_length_min}
            onChange={(e) => handleShotLengthMinChange(e.target.value)}
            className="w-20 px-2 py-1 bg-background border border-border rounded text-sm text-right"
            aria-label={t('settings.validation.shotLength.min.aria')}
            data-testid="input-shot-length-min"
          />
        </SettingRow>

        <SettingRow
          label={t('settings.validation.shotLength.max.label')}
          helpText={t('settings.validation.shotLength.max.help')}
          isChanged={isFieldChanged(changedFields, 'validation.warn_shot_length_max')}
          onReset={() => onChange({ validation: { ...config.validation, warn_shot_length_max: defaultConfig.validation.warn_shot_length_max } })}
          isDefault={config.validation.warn_shot_length_max === defaultConfig.validation.warn_shot_length_max}
          data-testid="setting-shot-length-max"
        >
          <input
            type="number"
            step={0.1}
            min={config.validation.warn_shot_length_min + 0.1}
            value={config.validation.warn_shot_length_max}
            onChange={(e) => handleShotLengthMaxChange(e.target.value)}
            className="w-20 px-2 py-1 bg-background border border-border rounded text-sm text-right"
            aria-label={t('settings.validation.shotLength.max.aria')}
            data-testid="input-shot-length-max"
          />
        </SettingRow>
      </SettingsSection>

      <SettingsSection title={t('settings.validation.sections.depth')} data-testid="section-depth-warnings">
        <SettingRow
          label={t('settings.validation.depth.max.label')}
          helpText={t('settings.validation.depth.max.help')}
          isChanged={isFieldChanged(changedFields, 'validation.warn_depth_change_per_shot_max')}
          onReset={() => onChange({ validation: { ...config.validation, warn_depth_change_per_shot_max: defaultConfig.validation.warn_depth_change_per_shot_max } })}
          isDefault={config.validation.warn_depth_change_per_shot_max === defaultConfig.validation.warn_depth_change_per_shot_max}
          data-testid="setting-depth-change-max"
        >
          <input
            type="number"
            step={0.1}
            min={0.1}
            value={config.validation.warn_depth_change_per_shot_max}
            onChange={(e) => handleDepthChangeMaxChange(e.target.value)}
            className="w-20 px-2 py-1 bg-background border border-border rounded text-sm text-right"
            aria-label={t('settings.validation.depth.max.aria')}
            data-testid="input-depth-change-max"
          />
        </SettingRow>
      </SettingsSection>

      <SettingsSection title={t('settings.validation.sections.diffThresholds')} data-testid="section-diff-thresholds">
        <SettingRow
          label={t('settings.validation.azimuthDiff.label')}
          helpText={t('settings.validation.azimuthDiff.help')}
          isChanged={isFieldChanged(changedFields, 'validation.azimuth_diff_threshold')}
          onReset={() => onChange({ validation: { ...config.validation, azimuth_diff_threshold: defaultConfig.validation.azimuth_diff_threshold } })}
          isDefault={config.validation.azimuth_diff_threshold === defaultConfig.validation.azimuth_diff_threshold}
          data-testid="setting-azimuth-diff"
        >
          <input
            type="number"
            step={1}
            min={0}
            max={180}
            value={config.validation.azimuth_diff_threshold}
            onChange={(e) => handleAzimuthDiffChange(e.target.value)}
            className="w-20 px-2 py-1 bg-background border border-border rounded text-sm text-right"
            aria-label={t('settings.validation.azimuthDiff.aria')}
            data-testid="input-azimuth-diff"
          />
        </SettingRow>

        <SettingRow
          label={t('settings.validation.pitchDiff.label')}
          helpText={t('settings.validation.pitchDiff.help')}
          isChanged={isFieldChanged(changedFields, 'validation.pitch_diff_threshold')}
          onReset={() => onChange({ validation: { ...config.validation, pitch_diff_threshold: defaultConfig.validation.pitch_diff_threshold } })}
          isDefault={config.validation.pitch_diff_threshold === defaultConfig.validation.pitch_diff_threshold}
          data-testid="setting-pitch-diff"
        >
          <input
            type="number"
            step={1}
            min={0}
            max={90}
            value={config.validation.pitch_diff_threshold}
            onChange={(e) => handlePitchDiffChange(e.target.value)}
            className="w-20 px-2 py-1 bg-background border border-border rounded text-sm text-right"
            aria-label={t('settings.validation.pitchDiff.aria')}
            data-testid="input-pitch-diff"
          />
        </SettingRow>
      </SettingsSection>
    </div>
  );
}
