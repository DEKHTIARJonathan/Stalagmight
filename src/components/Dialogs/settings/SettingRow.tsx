import { useId, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

interface SettingRowProps {
  /** Label text for the setting */
  label: string;
  /** Optional help text shown below the label */
  helpText?: string;
  /** Whether this setting requires app restart to take effect */
  requiresRestart?: boolean;
  /** Whether the setting value has been changed from saved state */
  isChanged?: boolean;
  /** The control element (Toggle, Select, input, etc.) */
  children: ReactNode;
  /** Test ID for E2E tests */
  'data-testid'?: string;
  /** Callback to reset this setting to its default value */
  onReset?: () => void;
  /** Whether the setting is currently at its default value (disables reset button) */
  isDefault?: boolean;
}

/**
 * Consistent layout for a single setting row.
 * Provides label, help text, restart indicator, and control placement.
 */
export function SettingRow({
  label,
  helpText,
  requiresRestart = false,
  isChanged = false,
  children,
  'data-testid': dataTestId,
  onReset,
  isDefault = true,
}: SettingRowProps) {
  const { t } = useTranslation();
  const labelId = useId();

  return (
    <div
      className={`py-3 ${isChanged ? 'bg-accent-5 -mx-2 px-2 rounded' : ''}`}
      data-testid={dataTestId}
    >
      <div className="flex items-start justify-between gap-4">
        {/* Label and help text */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span id={labelId} className="text-sm font-medium text-text-primary">
              {label}
            </span>
            {requiresRestart && (
              <span
                className="text-xs px-1.5 py-0.5 bg-warning-20 text-warning rounded"
                title={t('settings.common.restartTitle')}
              >
                {t('settings.common.restartBadge')}
              </span>
            )}
          </div>
          {helpText && (
            <p className="text-xs text-text-secondary mt-0.5">{helpText}</p>
          )}
        </div>

        {/* Control + Reset button */}
        <div className="flex items-center gap-2 flex-shrink-0" aria-labelledby={labelId}>
          {children}
          {onReset && (
            <button
              type="button"
              onClick={onReset}
              disabled={isDefault}
              className={`p-1 rounded hover:bg-panel transition-colors ${
                !isDefault
                  ? 'text-text-secondary hover:text-text-primary'
                  : 'text-border cursor-not-allowed'
              }`}
              title={t('settings.common.resetToDefault')}
              data-testid={dataTestId ? `${dataTestId}-reset` : undefined}
            >
              <svg
                className="w-3.5 h-3.5"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
                />
              </svg>
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
