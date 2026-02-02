import { useEffect, useRef } from 'react';
import { SettingsSection } from './SettingsSection';
import { SettingRow } from './SettingRow';
import { getPanelId, getTabId } from '../SettingsSidebar';
import type { SettingsCategoryProps } from './types';
import { isFieldChanged } from './types';

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
  // Validation state
  const hasErrorRef = useRef(false);

  // Validate on mount and when config changes
  useEffect(() => {
    const errors: string[] = [];

    // Validate shot length thresholds
    if (config.validation.warn_shot_length_min < 0) {
      errors.push('Minimum shot length warning must be >= 0');
    }
    if (config.validation.warn_shot_length_max <= config.validation.warn_shot_length_min) {
      errors.push('Maximum shot length warning must be greater than minimum');
    }

    // Validate depth change threshold
    if (config.validation.warn_depth_change_per_shot_max <= 0) {
      errors.push('Depth change warning threshold must be positive');
    }

    // Validate diff thresholds (0 means disabled)
    if (config.validation.azimuth_diff_threshold < 0 || config.validation.azimuth_diff_threshold > 180) {
      errors.push('Azimuth difference threshold must be between 0 and 180');
    }
    if (config.validation.pitch_diff_threshold < 0 || config.validation.pitch_diff_threshold > 90) {
      errors.push('Pitch difference threshold must be between 0 and 90');
    }

    const hasError = errors.length > 0;
    if (hasError !== hasErrorRef.current) {
      hasErrorRef.current = hasError;
      onValidationError('validation', hasError);
    }
  }, [config.validation, onValidationError]);

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
      <h2 className="text-lg font-medium mb-4">Validation</h2>

      <SettingsSection title="Shot Length Warnings" data-testid="section-shot-length">
        <SettingRow
          label="Minimum shot length"
          helpText="Warn when shot length is below this value (in length units)"
          isChanged={isFieldChanged(changedFields, 'validation.warn_shot_length_min')}
          data-testid="setting-shot-length-min"
        >
          <input
            type="number"
            step={0.1}
            min={0}
            value={config.validation.warn_shot_length_min}
            onChange={(e) => handleShotLengthMinChange(e.target.value)}
            className="w-20 px-2 py-1 bg-background border border-border rounded text-sm text-right"
            aria-label="Minimum shot length warning"
            data-testid="input-shot-length-min"
          />
        </SettingRow>

        <SettingRow
          label="Maximum shot length"
          helpText="Warn when shot length exceeds this value (in length units)"
          isChanged={isFieldChanged(changedFields, 'validation.warn_shot_length_max')}
          data-testid="setting-shot-length-max"
        >
          <input
            type="number"
            step={0.1}
            min={config.validation.warn_shot_length_min + 0.1}
            value={config.validation.warn_shot_length_max}
            onChange={(e) => handleShotLengthMaxChange(e.target.value)}
            className="w-20 px-2 py-1 bg-background border border-border rounded text-sm text-right"
            aria-label="Maximum shot length warning"
            data-testid="input-shot-length-max"
          />
        </SettingRow>
      </SettingsSection>

      <SettingsSection title="Depth Warnings" data-testid="section-depth-warnings">
        <SettingRow
          label="Max depth change per shot"
          helpText="Warn when depth changes more than this in a single shot (in depth units)"
          isChanged={isFieldChanged(changedFields, 'validation.warn_depth_change_per_shot_max')}
          data-testid="setting-depth-change-max"
        >
          <input
            type="number"
            step={0.1}
            min={0.1}
            value={config.validation.warn_depth_change_per_shot_max}
            onChange={(e) => handleDepthChangeMaxChange(e.target.value)}
            className="w-20 px-2 py-1 bg-background border border-border rounded text-sm text-right"
            aria-label="Maximum depth change per shot"
            data-testid="input-depth-change-max"
          />
        </SettingRow>
      </SettingsSection>

      <SettingsSection title="In/Out Difference Thresholds" data-testid="section-diff-thresholds">
        <SettingRow
          label="Azimuth in/out difference"
          helpText="Warn when azimuth in and out readings differ by more than this (0-180 degrees)"
          isChanged={isFieldChanged(changedFields, 'validation.azimuth_diff_threshold')}
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
            aria-label="Azimuth in/out difference threshold"
            data-testid="input-azimuth-diff"
          />
        </SettingRow>

        <SettingRow
          label="Pitch in/out difference"
          helpText="Warn when forward/back pitch differs by more than this (0-90 degrees)"
          isChanged={isFieldChanged(changedFields, 'validation.pitch_diff_threshold')}
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
            aria-label="Pitch in/out difference threshold"
            data-testid="input-pitch-diff"
          />
        </SettingRow>
      </SettingsSection>
    </div>
  );
}
