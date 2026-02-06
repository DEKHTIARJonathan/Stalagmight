import { useEffect, useRef, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Toggle } from '../../common/Toggle';
import { Select } from '../../common/Select';
import { SettingsSection } from './SettingsSection';
import { SettingRow } from './SettingRow';
import { getPanelId, getTabId } from '../SettingsSidebar';
import type { SettingsCategoryProps } from './types';
import { isFieldChanged } from './types';
import { getThemedDisplayDefaults, getThemedSectionColorDefaults } from '../../../types/config';
import { useUIStore } from '../../../store/uiStore';

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
  const { t } = useTranslation();
  const resolvedTheme = useUIStore((s) => s.resolvedTheme);
  const displayDefaults = getThemedDisplayDefaults(resolvedTheme);
  const sectionColorDefaults = getThemedSectionColorDefaults(resolvedTheme);
  // Validation state
  const hasErrorRef = useRef(false);

  // Validate on mount and when config changes
  useEffect(() => {
    const errors: string[] = [];

    // Validate font_size
    if (config.display.font_size < 8 || config.display.font_size > 32) {
      errors.push(t('settings.display.validation.fontSize'));
    }

    // Validate depth gradient depths
    if (config.display.depth_gradient.shallow_depth >= config.display.depth_gradient.deep_depth) {
      errors.push(t('settings.display.validation.depthRange'));
    }

    const hasError = errors.length > 0;
    if (hasError !== hasErrorRef.current) {
      hasErrorRef.current = hasError;
      onValidationError('display', hasError);
    }
  }, [config.display, onValidationError, t]);

  const gridSpacingOptions = useMemo(() => [
    { value: '1', label: t('settings.display.grid.spacingOptionOne', { value: 1 }) },
    { value: '5', label: t('settings.display.grid.spacingOptionOther', { value: 5 }) },
    { value: '10', label: t('settings.display.grid.spacingOptionOther', { value: 10 }) },
    { value: '25', label: t('settings.display.grid.spacingOptionOther', { value: 25 }) },
    { value: '50', label: t('settings.display.grid.spacingOptionOther', { value: 50 }) },
  ], [t]);

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
      <h2 className="text-lg font-medium mb-4">{t('settings.display.title')}</h2>

      <SettingsSection title={t('settings.display.sections.background')} data-testid="section-background">
        <SettingRow
          label={t('settings.display.background.label')}
          helpText={t('settings.display.background.help')}
          isChanged={isFieldChanged(changedFields, 'display.default_background')}
          data-testid="setting-background-color"
          onReset={() => onChange({ display: { ...config.display, default_background: displayDefaults.default_background } })}
          isDefault={config.display.default_background === displayDefaults.default_background}
        >
          <input
            type="color"
            value={config.display.default_background}
            onChange={(e) => handleBackgroundChange(e.target.value)}
            className="w-12 h-8 rounded border border-border cursor-pointer"
            aria-label={t('settings.display.background.aria')}
            data-testid="input-background-color"
          />
        </SettingRow>
      </SettingsSection>

      <SettingsSection title={t('settings.display.sections.grid')} data-testid="section-grid">
        <SettingRow
          label={t('settings.display.grid.color.label')}
          helpText={t('settings.display.grid.color.help')}
          isChanged={isFieldChanged(changedFields, 'display.grid_color')}
          data-testid="setting-grid-color"
          onReset={() => onChange({ display: { ...config.display, grid_color: displayDefaults.grid_color } })}
          isDefault={config.display.grid_color === displayDefaults.grid_color}
        >
          <input
            type="color"
            value={config.display.grid_color}
            onChange={(e) => handleGridColorChange(e.target.value)}
            className="w-12 h-8 rounded border border-border cursor-pointer"
            aria-label={t('settings.display.grid.color.aria')}
            data-testid="input-grid-color"
          />
        </SettingRow>

        <SettingRow
          label={t('settings.display.grid.spacing.label')}
          helpText={t('settings.display.grid.spacing.help')}
          isChanged={isFieldChanged(changedFields, 'display.grid_spacing')}
          data-testid="setting-grid-spacing"
          onReset={() => onChange({ display: { ...config.display, grid_spacing: displayDefaults.grid_spacing } })}
          isDefault={config.display.grid_spacing === displayDefaults.grid_spacing}
        >
          <Select
            value={String(config.display.grid_spacing)}
            onChange={handleGridSpacingChange}
            options={gridSpacingOptions}
            className="w-32"
            aria-label={t('settings.display.grid.spacing.aria')}
            data-testid="select-grid-spacing"
          />
        </SettingRow>
      </SettingsSection>

      <SettingsSection title={t('settings.display.sections.font')} data-testid="section-font">
        <SettingRow
          label={t('settings.display.font.size.label')}
          helpText={t('settings.display.font.size.help')}
          isChanged={isFieldChanged(changedFields, 'display.font_size')}
          data-testid="setting-font-size"
          onReset={() => onChange({ display: { ...config.display, font_size: displayDefaults.font_size } })}
          isDefault={config.display.font_size === displayDefaults.font_size}
        >
          <input
            type="number"
            min={8}
            max={32}
            value={config.display.font_size}
            onChange={(e) => handleFontSizeChange(e.target.value)}
            className="w-20 px-2 py-1 bg-background border border-border rounded text-sm text-right"
            aria-label={t('settings.display.font.size.aria')}
            data-testid="input-font-size"
          />
        </SettingRow>

        <SettingRow
          label={t('settings.display.font.color.label')}
          helpText={t('settings.display.font.color.help')}
          isChanged={isFieldChanged(changedFields, 'display.font_color')}
          data-testid="setting-font-color"
          onReset={() => onChange({ display: { ...config.display, font_color: displayDefaults.font_color } })}
          isDefault={config.display.font_color === displayDefaults.font_color}
        >
          <input
            type="color"
            value={config.display.font_color}
            onChange={(e) => handleFontColorChange(e.target.value)}
            className="w-12 h-8 rounded border border-border cursor-pointer"
            aria-label={t('settings.display.font.color.aria')}
            data-testid="input-font-color"
          />
        </SettingRow>
      </SettingsSection>

      <SettingsSection title={t('settings.display.sections.depthGradient')} data-testid="section-depth-gradient">
        <SettingRow
          label={t('settings.display.depthGradient.enabled.label')}
          helpText={t('settings.display.depthGradient.enabled.help')}
          isChanged={isFieldChanged(changedFields, 'display.depth_gradient.enabled')}
          data-testid="setting-depth-gradient-enabled"
          onReset={() => onChange({ display: { ...config.display, depth_gradient: { ...config.display.depth_gradient, enabled: displayDefaults.depth_gradient.enabled } } })}
          isDefault={config.display.depth_gradient.enabled === displayDefaults.depth_gradient.enabled}
        >
          <Toggle
            checked={config.display.depth_gradient.enabled}
            onChange={handleDepthGradientEnabledChange}
            aria-label={t('settings.display.depthGradient.enabled.aria')}
            data-testid="toggle-depth-gradient"
          />
        </SettingRow>

        <SettingRow
          label={t('settings.display.depthGradient.shallowColor.label')}
          helpText={t('settings.display.depthGradient.shallowColor.help')}
          isChanged={isFieldChanged(changedFields, 'display.depth_gradient.shallow_color')}
          data-testid="setting-shallow-color"
          onReset={() => onChange({ display: { ...config.display, depth_gradient: { ...config.display.depth_gradient, shallow_color: displayDefaults.depth_gradient.shallow_color } } })}
          isDefault={config.display.depth_gradient.shallow_color === displayDefaults.depth_gradient.shallow_color}
        >
          <input
            type="color"
            value={config.display.depth_gradient.shallow_color}
            onChange={(e) => handleShallowColorChange(e.target.value)}
            className="w-12 h-8 rounded border border-border cursor-pointer"
            aria-label={t('settings.display.depthGradient.shallowColor.aria')}
            data-testid="input-shallow-color"
          />
        </SettingRow>

        <SettingRow
          label={t('settings.display.depthGradient.deepColor.label')}
          helpText={t('settings.display.depthGradient.deepColor.help')}
          isChanged={isFieldChanged(changedFields, 'display.depth_gradient.deep_color')}
          data-testid="setting-deep-color"
          onReset={() => onChange({ display: { ...config.display, depth_gradient: { ...config.display.depth_gradient, deep_color: displayDefaults.depth_gradient.deep_color } } })}
          isDefault={config.display.depth_gradient.deep_color === displayDefaults.depth_gradient.deep_color}
        >
          <input
            type="color"
            value={config.display.depth_gradient.deep_color}
            onChange={(e) => handleDeepColorChange(e.target.value)}
            className="w-12 h-8 rounded border border-border cursor-pointer"
            aria-label={t('settings.display.depthGradient.deepColor.aria')}
            data-testid="input-deep-color"
          />
        </SettingRow>

        <SettingRow
          label={t('settings.display.depthGradient.shallowDepth.label')}
          helpText={t('settings.display.depthGradient.shallowDepth.help')}
          isChanged={isFieldChanged(changedFields, 'display.depth_gradient.shallow_depth')}
          data-testid="setting-shallow-depth"
          onReset={() => onChange({ display: { ...config.display, depth_gradient: { ...config.display.depth_gradient, shallow_depth: displayDefaults.depth_gradient.shallow_depth } } })}
          isDefault={config.display.depth_gradient.shallow_depth === displayDefaults.depth_gradient.shallow_depth}
        >
          <input
            type="number"
            step={0.1}
            value={config.display.depth_gradient.shallow_depth}
            onChange={(e) => handleShallowDepthChange(e.target.value)}
            className="w-20 px-2 py-1 bg-background border border-border rounded text-sm text-right"
            aria-label={t('settings.display.depthGradient.shallowDepth.aria')}
            data-testid="input-shallow-depth"
          />
        </SettingRow>

        <SettingRow
          label={t('settings.display.depthGradient.deepDepth.label')}
          helpText={t('settings.display.depthGradient.deepDepth.help')}
          isChanged={isFieldChanged(changedFields, 'display.depth_gradient.deep_depth')}
          data-testid="setting-deep-depth"
          onReset={() => onChange({ display: { ...config.display, depth_gradient: { ...config.display.depth_gradient, deep_depth: displayDefaults.depth_gradient.deep_depth } } })}
          isDefault={config.display.depth_gradient.deep_depth === displayDefaults.depth_gradient.deep_depth}
        >
          <input
            type="number"
            step={0.1}
            value={config.display.depth_gradient.deep_depth}
            onChange={(e) => handleDeepDepthChange(e.target.value)}
            className="w-20 px-2 py-1 bg-background border border-border rounded text-sm text-right"
            aria-label={t('settings.display.depthGradient.deepDepth.aria')}
            data-testid="input-deep-depth"
          />
        </SettingRow>
      </SettingsSection>

      <SettingsSection title={t('settings.display.sections.sectionColors')} data-testid="section-colors-palette">
        <SettingRow
          label={t('settings.display.sectionColors.label')}
          helpText={t('settings.display.sectionColors.help')}
          isChanged={isFieldChanged(changedFields, 'section_colors.palette')}
          data-testid="setting-color-palette"
          onReset={() => onChange({ section_colors: { palette: [...sectionColorDefaults.palette] } })}
          isDefault={JSON.stringify(config.section_colors.palette) === JSON.stringify(sectionColorDefaults.palette)}
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
                aria-label={t('settings.display.sectionColors.aria', { index: index + 1 })}
                data-testid={`input-palette-color-${index}`}
              />
            ))}
          </div>
        </SettingRow>
      </SettingsSection>
    </div>
  );
}
