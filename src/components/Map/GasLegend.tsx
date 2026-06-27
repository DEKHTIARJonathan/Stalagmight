import { useId } from 'react';
import { useTranslation } from 'react-i18next';
import { formatStationId } from '../../utils/formatters';
import { getThemeColor } from '../../utils/themeColors';
import { useUIStore } from '../../store/uiStore';
import { useGasPlanStore } from '../../store/gasPlanStore';
import { formatVolume } from '../../utils/formatGas';
import { GAS_NEAR, GAS_FAR } from '../../utils/gasReach';
import type { GasReachField, GasUnits } from '../../types/ipc.generated';

interface GasLegendProps {
  /** The reachability field — its `budget_litres` is the far (purple) end of the scale. */
  field: GasReachField;
  units: GasUnits;
  visible: boolean;
}

/**
 * Gas reachable-frontier legend (#38): a gold→purple scale (0 → the turn budget),
 * bottom-left while the gas sub-mode is active. Doubles as the color key and the
 * cue for which overlay you're in. Shows the current origin (entrance default or a
 * picked station). Mirrors {@link ./DistanceLegend}.
 */
export function GasLegend({ field, units, visible }: GasLegendProps) {
  const gradientId = useId();
  const { t } = useTranslation();
  // Re-render on theme change so text colors stay correct.
  useUIStore((s) => s.resolvedTheme);
  const origin = useGasPlanStore((s) => s.origin);
  const textColor = getThemeColor('--cc-depth-text');
  const textHaloAlt = getThemeColor('--cc-text-halo-alt');

  if (!visible) return null;

  const minLabel = formatVolume(0, units);
  const maxLabel = formatVolume(field.budget_litres, units);
  const originLabel = origin
    ? t('map.gasLegend.fromStation', {
        id: formatStationId(origin.section_id, origin.station_index),
      })
    : t('map.gasLegend.fromEntrance');

  return (
    <div
      data-testid="gas-legend"
      className="gas-legend"
      style={{
        position: 'absolute',
        bottom: 50,
        left: 10,
        background: textHaloAlt,
        borderRadius: 4,
        padding: 8,
        zIndex: 1,
        display: 'flex',
        flexDirection: 'column',
        gap: 4,
      }}
    >
      <span style={{ fontSize: 11, fontWeight: 600, color: textColor }}>
        {t('map.gasLegend.title')}
      </span>
      <span
        data-testid="gas-legend-origin"
        style={{ fontSize: 10, opacity: 0.8, color: textColor }}
      >
        {originLabel}
      </span>
      <div style={{ display: 'flex', gap: 6 }}>
        <svg
          width="16"
          height="80"
          role="img"
          aria-label={t('map.gasLegend.aria', { min: minLabel, max: maxLabel })}
        >
          <defs>
            <linearGradient id={gradientId} x1="0%" y1="0%" x2="0%" y2="100%">
              <stop offset="0%" stopColor={GAS_NEAR} />
              <stop offset="100%" stopColor={GAS_FAR} />
            </linearGradient>
          </defs>
          <rect width="16" height="80" fill={`url(#${gradientId})`} rx="2" />
        </svg>
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            justifyContent: 'space-between',
            fontSize: 11,
            color: textColor,
            textShadow: `0 1px 2px ${textHaloAlt}`,
          }}
        >
          <span data-testid="gas-legend-min">{minLabel}</span>
          <span data-testid="gas-legend-max">{maxLabel}</span>
        </div>
      </div>
    </div>
  );
}
