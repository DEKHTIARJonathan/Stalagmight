import type { Config } from '../../../types/config';
import type { SettingsCategory } from '../SettingsSidebar';

/**
 * Common props for all settings category content components.
 */
export interface SettingsCategoryProps {
  /** Current config values (local state) */
  config: Config;
  /** Callback to update config values */
  onChange: (updates: Partial<Config>) => void;
  /** Set of changed field paths (e.g., 'general.auto_save') for highlighting */
  changedFields: Set<string>;
  /** Report validation error state for this category */
  onValidationError: (category: SettingsCategory, hasError: boolean) => void;
  /** Base ID for aria-labelledby association with sidebar tab */
  panelIdBase: string;
}

/**
 * Helper to check if a field path has been changed.
 */
export function isFieldChanged(changedFields: Set<string>, ...paths: string[]): boolean {
  return paths.some((path) => changedFields.has(path));
}

/**
 * Helper to update a nested config value.
 */
export function updateNestedConfig<T extends Config>(
  config: T,
  path: string,
  value: unknown
): Partial<T> {
  const parts = path.split('.');
  if (parts.length === 0) return config;

  const result: Record<string, unknown> = {};
  let current = result;

  // Build nested object structure
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i];
    if (!part) continue;
    current[part] = { ...((config as Record<string, unknown>)[part] as Record<string, unknown>) };
    current = current[part] as Record<string, unknown>;
  }

  // Set the final value
  const lastPart = parts[parts.length - 1];
  if (lastPart) {
    current[lastPart] = value;
  }

  return result as Partial<T>;
}
