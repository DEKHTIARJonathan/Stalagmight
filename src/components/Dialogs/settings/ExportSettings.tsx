import { useEffect, useRef } from 'react';
import { Toggle } from '../../common/Toggle';
import { Select } from '../../common/Select';
import { SettingsSection } from './SettingsSection';
import { SettingRow } from './SettingRow';
import { getPanelId, getTabId } from '../SettingsSidebar';
import type { SettingsCategoryProps } from './types';
import { isFieldChanged } from './types';

const IMAGE_FORMAT_OPTIONS = [
  { value: 'png', label: 'PNG' },
  { value: 'jpg', label: 'JPEG' },
  { value: 'webp', label: 'WebP' },
  { value: 'svg', label: 'SVG' },
];

const DPI_OPTIONS = [
  { value: '72', label: '72 DPI (Screen)' },
  { value: '150', label: '150 DPI (Low Print)' },
  { value: '300', label: '300 DPI (Standard Print)' },
  { value: '600', label: '600 DPI (High Quality)' },
];

/**
 * Export settings category content.
 * Maps to config.export: default_image_format, default_dpi,
 * default_include_satellite/grid/labels.
 */
export function ExportSettings({
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

    // Validate DPI
    if (config.export.default_dpi < 72 || config.export.default_dpi > 1200) {
      errors.push('DPI must be between 72 and 1200');
    }

    const hasError = errors.length > 0;
    if (hasError !== hasErrorRef.current) {
      hasErrorRef.current = hasError;
      onValidationError('export', hasError);
    }
  }, [config.export, onValidationError]);

  const handleFormatChange = (value: string) => {
    onChange({
      export: {
        ...config.export,
        default_image_format: value,
      },
    });
  };

  const handleDpiChange = (value: string) => {
    const num = parseInt(value, 10);
    if (!isNaN(num)) {
      onChange({
        export: {
          ...config.export,
          default_dpi: num,
        },
      });
    }
  };

  const handleIncludeSatelliteChange = (checked: boolean) => {
    onChange({
      export: {
        ...config.export,
        default_include_satellite: checked,
      },
    });
  };

  const handleIncludeGridChange = (checked: boolean) => {
    onChange({
      export: {
        ...config.export,
        default_include_grid: checked,
      },
    });
  };

  const handleIncludeLabelsChange = (checked: boolean) => {
    onChange({
      export: {
        ...config.export,
        default_include_labels: checked,
      },
    });
  };

  return (
    <div
      role="tabpanel"
      id={getPanelId(panelIdBase, 'export')}
      aria-labelledby={getTabId(panelIdBase, 'export')}
      data-testid="settings-panel-export"
    >
      <h2 className="text-lg font-medium mb-4">Export</h2>

      <SettingsSection title="Image Format" data-testid="section-image-format">
        <SettingRow
          label="Default format"
          helpText="File format for exported images"
          isChanged={isFieldChanged(changedFields, 'export.default_image_format')}
          data-testid="setting-image-format"
        >
          <Select
            value={config.export.default_image_format}
            onChange={handleFormatChange}
            options={IMAGE_FORMAT_OPTIONS}
            className="w-32"
            aria-label="Default image format"
            data-testid="select-image-format"
          />
        </SettingRow>

        <SettingRow
          label="Default DPI"
          helpText="Resolution for exported images"
          isChanged={isFieldChanged(changedFields, 'export.default_dpi')}
          data-testid="setting-dpi"
        >
          <Select
            value={String(config.export.default_dpi)}
            onChange={handleDpiChange}
            options={DPI_OPTIONS}
            className="w-48"
            aria-label="Default DPI"
            data-testid="select-dpi"
          />
        </SettingRow>
      </SettingsSection>

      <SettingsSection title="Default Layers" data-testid="section-default-layers">
        <SettingRow
          label="Include satellite"
          helpText="Include satellite imagery layer by default"
          isChanged={isFieldChanged(changedFields, 'export.default_include_satellite')}
          data-testid="setting-include-satellite"
        >
          <Toggle
            checked={config.export.default_include_satellite}
            onChange={handleIncludeSatelliteChange}
            aria-label="Include satellite imagery"
            data-testid="toggle-include-satellite"
          />
        </SettingRow>

        <SettingRow
          label="Include grid"
          helpText="Include grid overlay by default"
          isChanged={isFieldChanged(changedFields, 'export.default_include_grid')}
          data-testid="setting-include-grid"
        >
          <Toggle
            checked={config.export.default_include_grid}
            onChange={handleIncludeGridChange}
            aria-label="Include grid overlay"
            data-testid="toggle-include-grid"
          />
        </SettingRow>

        <SettingRow
          label="Include labels"
          helpText="Include station/shot labels by default"
          isChanged={isFieldChanged(changedFields, 'export.default_include_labels')}
          data-testid="setting-include-labels"
        >
          <Toggle
            checked={config.export.default_include_labels}
            onChange={handleIncludeLabelsChange}
            aria-label="Include labels"
            data-testid="toggle-include-labels"
          />
        </SettingRow>
      </SettingsSection>
    </div>
  );
}
