import { useProjectStore } from '../store/projectStore';
import { defaultConfig } from '../types/config';
import type { DecimalPrecision } from '../types/config';

const defaultPrecision = defaultConfig.units.decimal_precision;

/**
 * Returns the per-category decimal precision settings from the project config,
 * falling back to defaults if config is not yet loaded.
 */
export function useDecimalPrecision(): DecimalPrecision {
  const config = useProjectStore((s) => s.config);
  return config?.units?.decimal_precision ?? defaultPrecision;
}
