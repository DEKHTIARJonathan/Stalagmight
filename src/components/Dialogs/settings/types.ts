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
 * Read a nested value from an object by dot-separated path.
 * e.g. getByPath(config, 'general.auto_save') => config.general.auto_save
 */
export function getByPath(obj: unknown, path: string): unknown {
  let current = obj;
  for (const key of path.split('.')) {
    if (current == null || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}
