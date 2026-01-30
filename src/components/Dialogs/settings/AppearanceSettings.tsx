import { useId } from 'react';
import { SettingsSection } from './SettingsSection';
import { SettingRow } from './SettingRow';
import { getPanelId, getTabId } from '../SettingsSidebar';
import type { SettingsCategoryProps } from './types';
import { isFieldChanged } from './types';
import type { ThemeMode } from '../../../types/config';

/**
 * Theme option descriptor for the radio group.
 */
interface ThemeOption {
  value: ThemeMode;
  label: string;
  description: string;
}

const THEME_OPTIONS: ThemeOption[] = [
  {
    value: 'dark',
    label: 'Dark',
    description: 'Dark backgrounds with light text, optimized for low-light environments',
  },
  {
    value: 'light',
    label: 'Light',
    description: 'Light backgrounds with dark text, optimized for bright environments',
  },
  {
    value: 'auto',
    label: 'Auto',
    description: 'Follows your operating system appearance preference',
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
      <h2 className="text-lg font-medium mb-4">Appearance</h2>

      <SettingsSection title="Theme" data-testid="section-theme">
        <SettingRow
          label="Application theme"
          helpText="Choose how CaveChef looks"
          isChanged={isFieldChanged(changedFields, 'appearance.theme')}
          data-testid="setting-theme"
        >
          <div
            role="radiogroup"
            aria-label="Application theme"
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
                    ${isSelected ? 'border-accent bg-accent/10' : 'border-transparent hover:bg-accent/5'}
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
                      {option.label}
                    </span>
                    <span className="text-xs text-text-secondary">
                      {option.description}
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
