import { useId } from 'react';
import { useTranslation } from 'react-i18next';
import { SettingsSection } from './SettingsSection';
import { SettingRow } from './SettingRow';
import { getPanelId, getTabId } from '../SettingsSidebar';
import type { SettingsCategoryProps } from './types';
import { isFieldChanged } from './types';
import { defaultConfig } from '../../../types/config';
import type { ThemeMode } from '../../../types/config';

/**
 * Theme option descriptor for the radio group.
 */
interface ThemeOption {
  value: ThemeMode;
  labelKey: string;
  descriptionKey: string;
}

const THEME_OPTIONS: ThemeOption[] = [
  {
    value: 'dark',
    labelKey: 'settings.appearance.theme.options.dark.label',
    descriptionKey: 'settings.appearance.theme.options.dark.description',
  },
  {
    value: 'light',
    labelKey: 'settings.appearance.theme.options.light.label',
    descriptionKey: 'settings.appearance.theme.options.light.description',
  },
  {
    value: 'auto',
    labelKey: 'settings.appearance.theme.options.auto.label',
    descriptionKey: 'settings.appearance.theme.options.auto.description',
  },
];

/**
 * Appearance settings category content.
 * Maps to config.appearance: theme.
 */
export function AppearanceSettings({
  config,
  onChange,
  changedFields,
  onValidationError: _onValidationError,
  panelIdBase,
}: SettingsCategoryProps) {
  const { t } = useTranslation();
  const radioGroupId = useId();

  const handleThemeChange = (value: ThemeMode) => {
    onChange({
      appearance: {
        ...config.appearance,
        theme: value,
      },
    });
  };

  return (
    <div
      role="tabpanel"
      id={getPanelId(panelIdBase, 'appearance')}
      aria-labelledby={getTabId(panelIdBase, 'appearance')}
      data-testid="settings-panel-appearance"
    >
      <h2 className="text-lg font-medium mb-4">{t('settings.appearance.title')}</h2>

      <SettingsSection title={t('settings.appearance.theme.title')} data-testid="section-theme">
        <SettingRow
          label={t('settings.appearance.theme.label')}
          helpText={t('settings.appearance.theme.help')}
          isChanged={isFieldChanged(changedFields, 'appearance.theme')}
          onReset={() => onChange({ appearance: { ...config.appearance, theme: defaultConfig.appearance.theme } })}
          isDefault={config.appearance.theme === defaultConfig.appearance.theme}
          data-testid="setting-theme"
        >
          <div
            role="radiogroup"
            aria-label={t('settings.appearance.theme.aria')}
            className="flex flex-col gap-2"
            id={radioGroupId}
          >
            {THEME_OPTIONS.map((option) => {
              const optionId = `${radioGroupId}-${option.value}`;
              const isSelected = config.appearance.theme === option.value;

              return (
                <label
                  key={option.value}
                  htmlFor={optionId}
                  className={`
                    flex items-start gap-3 p-2 rounded cursor-pointer
                    border transition-colors
                    ${isSelected ? 'border-accent bg-accent-10' : 'border-transparent hover:bg-accent-5'}
                  `}
                  data-testid={`theme-option-${option.value}`}
                >
                  <input
                    type="radio"
                    id={optionId}
                    name={radioGroupId}
                    value={option.value}
                    checked={isSelected}
                    onChange={() => handleThemeChange(option.value)}
                    className="mt-0.5 accent-accent"
                    data-testid={`theme-radio-${option.value}`}
                  />
                  <div className="flex flex-col">
                    <span className="text-sm font-medium text-text-primary">
                      {t(option.labelKey)}
                    </span>
                    <span className="text-xs text-text-secondary">
                      {t(option.descriptionKey)}
                    </span>
                  </div>
                </label>
              );
            })}
          </div>
        </SettingRow>
      </SettingsSection>
    </div>
  );
}
