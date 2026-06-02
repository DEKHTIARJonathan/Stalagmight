import { useTranslation } from 'react-i18next';
import { formatFixed } from '../../i18n/format';
import { useDecimalPrecision } from '../../hooks/useDecimalPrecision';

/**
 * Shared formatters for recent-project stats so the card grid and the compact
 * table render lengths identically (meters, switching to kilometers ≥ 1000m).
 */
export function useProjectStatFormatters() {
  const { t } = useTranslation();
  const precision = useDecimalPrecision();

  const formatLength = (meters: number): string => {
    if (meters >= 1000) {
      return `${formatFixed(meters / 1000, undefined, precision.length)} ${t('common.units.kilometers')}`;
    }
    return `${formatFixed(meters, undefined, precision.length)} ${t('common.units.meters')}`;
  };

  return { formatLength };
}
