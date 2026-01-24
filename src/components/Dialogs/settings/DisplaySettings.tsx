import { useEffect, useRef } from 'react';
import { Toggle } from '../../common/Toggle';
import { Select } from '../../common/Select';
import { SettingsSection } from './SettingsSection';
import { SettingRow } from './SettingRow';
import { getPanelId, getTabId } from '../SettingsSidebar';
import type { SettingsCategoryProps } from './types';
import { isFieldChanged } from './types';

const GRID_SPACING_OPTIONS = [
  { value: '1', label: '1 meter' },
  { value: '5', label: '5 meters' },
  { value: '10', label: '10 meters' },
  { value: '25', label: '25 meters' },
  { value: '50', label: '50 meters' },
];

/**
 * Display settings category content.
 * Maps to config.display + config.section_colors: background, grid settings,
 * font settings, depth_gradient, palette.
 */
export function DisplaySettings({
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

    // Validate font_size
    if (config.display.font_size < 8 || config.display.font_size > 32) {
      errors.push('Font size must be between 8 and 32');
    }

    // Validate depth gradient depths
    if (config.display.depth_gradient.shallow_depth >= config.display.depth_gradient.deep_depth) {
      errors.push('Shallow depth must be less than deep depth');
    }

    const hasError = errors.length > 0;
    if (hasError !== hasErrorRef.current) {
      hasErrorRef.current = hasError;
      onValidationError('display', hasError);
    }
  }, [config.display, onValidationError]);

  const handleBackgroundChange = (value: string) => {
    onChange({
      display: {
        ...config.display,
        default_background: value,
      },
    });
  };

  const handleGridColorChange = (value: string) => {
    onChange({
      display: {
        ...config.display,
        grid_color: value,
      },
    });
  };

  const handleGridSpacingChange = (value: string) => {
    const num = parseInt(value, 10);
    if (!isNaN(num)) {
      onChange({
        display: {
          ...config.display,
          grid_spacing: num,
        },
      });
    }
  };

  const handleFontSizeChange = (value: string) => {
    const num = parseInt(value, 10);
    if (!isNaN(num)) {
      onChange({
        display: {
          ...config.display,
          font_size: num,
        },
      });
    }
  };

  const handleFontColorChange = (value: string) => {
    onChange({
      display: {
        ...config.display,
        font_color: value,
      },
    });
  };

  const handleDepthGradientEnabledChange = (checked: boolean) => {
    onChange({
      display: {
        ...config.display,
        depth_gradient: {
          ...config.display.depth_gradient,
          enabled: checked,
        },
      },
    });
  };

  const handleShallowColorChange = (value: string) => {
    onChange({
      display: {
        ...config.display,
        depth_gradient: {
          ...config.display.depth_gradient,
          shallow_color: value,
        },
      },
    });
  };

  const handleDeepColorChange = (value: string) => {
    onChange({
      display: {
        ...config.display,
        depth_gradient: {
          ...config.display.depth_gradient,
          deep_color: value,
        },
      },
    });
  };

  const handleShallowDepthChange = (value: string) => {
    const num = parseFloat(value);
    if (!isNaN(num)) {
      onChange({
        display: {
          ...config.display,
          depth_gradient: {
            ...config.display.depth_gradient,
            shallow_depth: num,
          },
        },
      });
    }
  };

  const handleDeepDepthChange = (value: string) => {
    const num = parseFloat(value);
    if (!isNaN(num)) {
      onChange({
        display: {
          ...config.display,
          depth_gradient: {
            ...config.display.depth_gradient,
            deep_depth: num,
          },
        },
      });
    }
  };

  return (
    <div
      role="tabpanel"
      id={getPanelId(panelIdBase, 'display')}
      aria-labelledby={getTabId(panelIdBase, 'display')}
      data-testid="settings-panel-display"
    >
      <h2 className="text-lg font-medium mb-4">Display</h2>

      <SettingsSection title="Background" data-testid="section-background">
        <SettingRow
          label="Background color"
          helpText="Default background color for the map view"
          isChanged={isFieldChanged(changedFields, 'display.default_background')}
          data-testid="setting-background-color"
        >
          <input
            type="color"
            value={config.display.default_background}
            onChange={(e) => handleBackgroundChange(e.target.value)}
            className="w-12 h-8 rounded border border-border cursor-pointer"
            aria-label="Background color"
            data-testid="input-background-color"
          />
        </SettingRow>
      </SettingsSection>

      <SettingsSection title="Grid" data-testid="section-grid">
        <SettingRow
          label="Grid color"
          helpText="Color of the grid lines overlay"
          isChanged={isFieldChanged(changedFields, 'display.grid_color')}
          data-testid="setting-grid-color"
        >
          <input
            type="color"
            value={config.display.grid_color}
            onChange={(e) => handleGridColorChange(e.target.value)}
            className="w-12 h-8 rounded border border-border cursor-pointer"
            aria-label="Grid color"
            data-testid="input-grid-color"
          />
        </SettingRow>

        <SettingRow
          label="Grid spacing"
          helpText="Distance between grid lines"
          isChanged={isFieldChanged(changedFields, 'display.grid_spacing')}
          data-testid="setting-grid-spacing"
        >
          <Select
            value={String(config.display.grid_spacing)}
            onChange={handleGridSpacingChange}
            options={GRID_SPACING_OPTIONS}
            className="w-32"
            aria-label="Grid spacing"
            data-testid="select-grid-spacing"
          />
        </SettingRow>
      </SettingsSection>

      <SettingsSection title="Font" data-testid="section-font">
        <SettingRow
          label="Font size"
          helpText="Size of labels and text (8-32 pixels)"
          isChanged={isFieldChanged(changedFields, 'display.font_size')}
          data-testid="setting-font-size"
        >
          <input
            type="number"
            min={8}
            max={32}
            value={config.display.font_size}
            onChange={(e) => handleFontSizeChange(e.target.value)}
            className="w-20 px-2 py-1 bg-background border border-border rounded text-sm text-right"
            aria-label="Font size"
            data-testid="input-font-size"
          />
        </SettingRow>

        <SettingRow
          label="Font color"
          helpText="Default color for labels and text"
          isChanged={isFieldChanged(changedFields, 'display.font_color')}
          data-testid="setting-font-color"
        >
          <input
            type="color"
            value={config.display.font_color}
            onChange={(e) => handleFontColorChange(e.target.value)}
            className="w-12 h-8 rounded border border-border cursor-pointer"
            aria-label="Font color"
            data-testid="input-font-color"
          />
        </SettingRow>
      </SettingsSection>

      <SettingsSection title="Depth Gradient" data-testid="section-depth-gradient">
        <SettingRow
          label="Enable depth gradient"
          helpText="Color shots based on their depth"
          isChanged={isFieldChanged(changedFields, 'display.depth_gradient.enabled')}
          data-testid="setting-depth-gradient-enabled"
        >
          <Toggle
            checked={config.display.depth_gradient.enabled}
            onChange={handleDepthGradientEnabledChange}
            aria-label="Enable depth gradient coloring"
            data-testid="toggle-depth-gradient"
          />
        </SettingRow>

        <SettingRow
          label="Shallow color"
          helpText="Color at the shallow depth threshold"
          isChanged={isFieldChanged(changedFields, 'display.depth_gradient.shallow_color')}
          data-testid="setting-shallow-color"
        >
          <input
            type="color"
            value={config.display.depth_gradient.shallow_color}
            onChange={(e) => handleShallowColorChange(e.target.value)}
            className="w-12 h-8 rounded border border-border cursor-pointer"
            aria-label="Shallow depth color"
            data-testid="input-shallow-color"
          />
        </SettingRow>

        <SettingRow
          label="Deep color"
          helpText="Color at the deep depth threshold"
          isChanged={isFieldChanged(changedFields, 'display.depth_gradient.deep_color')}
          data-testid="setting-deep-color"
        >
          <input
            type="color"
            value={config.display.depth_gradient.deep_color}
            onChange={(e) => handleDeepColorChange(e.target.value)}
            className="w-12 h-8 rounded border border-border cursor-pointer"
            aria-label="Deep depth color"
            data-testid="input-deep-color"
          />
        </SettingRow>

        <SettingRow
          label="Shallow depth"
          helpText="Depth value where gradient starts (in configured depth unit)"
          isChanged={isFieldChanged(changedFields, 'display.depth_gradient.shallow_depth')}
          data-testid="setting-shallow-depth"
        >
          <input
            type="number"
            step={0.1}
            value={config.display.depth_gradient.shallow_depth}
            onChange={(e) => handleShallowDepthChange(e.target.value)}
            className="w-20 px-2 py-1 bg-background border border-border rounded text-sm text-right"
            aria-label="Shallow depth threshold"
            data-testid="input-shallow-depth"
          />
        </SettingRow>

        <SettingRow
          label="Deep depth"
          helpText="Depth value where gradient ends (in configured depth unit)"
          isChanged={isFieldChanged(changedFields, 'display.depth_gradient.deep_depth')}
          data-testid="setting-deep-depth"
        >
          <input
            type="number"
            step={0.1}
            value={config.display.depth_gradient.deep_depth}
            onChange={(e) => handleDeepDepthChange(e.target.value)}
            className="w-20 px-2 py-1 bg-background border border-border rounded text-sm text-right"
            aria-label="Deep depth threshold"
            data-testid="input-deep-depth"
          />
        </SettingRow>
      </SettingsSection>

      <SettingsSection title="Section Colors" data-testid="section-colors-palette">
        <SettingRow
          label="Color palette"
          helpText="Colors assigned to new sections (click to change)"
          isChanged={isFieldChanged(changedFields, 'section_colors.palette')}
          data-testid="setting-color-palette"
        >
          <div className="flex gap-1">
            {config.section_colors.palette.map((color, index) => (
              <input
                key={index}
                type="color"
                value={color}
                onChange={(e) => {
                  const newPalette = [...config.section_colors.palette];
                  newPalette[index] = e.target.value;
                  onChange({
                    section_colors: {
                      palette: newPalette,
                    },
                  });
                }}
                className="w-6 h-6 rounded border border-border cursor-pointer"
                aria-label={`Section color ${index + 1}`}
                data-testid={`input-palette-color-${index}`}
              />
            ))}
          </div>
        </SettingRow>
      </SettingsSection>
    </div>
  );
}
