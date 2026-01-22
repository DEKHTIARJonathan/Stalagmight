import { useId, useMemo } from 'react';
import { getDepthColor } from '../../utils/colors';

interface DepthLegendProps {
  minDepth: number;
  maxDepth: number;
  shallowColor?: string;
  deepColor?: string;
  visible: boolean;
}

/**
 * Number of color stops to generate for the gradient.
 * More stops = smoother gradient that matches HSL interpolation.
 */
const GRADIENT_STOPS = 10;

/**
 * Shows a depth color gradient legend with min/max labels.
 * Positioned in the bottom-left corner of the map, above the scale bar.
 * Uses the same HSL color interpolation as the map display.
 */
export function DepthLegend({
  minDepth,
  maxDepth,
  shallowColor = '#00bfff',
  deepColor = '#ff4444',
  visible,
}: DepthLegendProps) {
  const gradientId = useId();

  // Generate gradient stops using the same getDepthColor function as the map
  const gradientStops = useMemo(() => {
    const isFlat = minDepth === maxDepth;
    if (isFlat) {
      return [{ offset: 0, color: shallowColor }, { offset: 100, color: shallowColor }];
    }

    const stops: { offset: number; color: string }[] = [];
    for (let i = 0; i <= GRADIENT_STOPS; i++) {
      const t = i / GRADIENT_STOPS;
      const depth = minDepth + t * (maxDepth - minDepth);
      const color = getDepthColor(depth, shallowColor, deepColor, minDepth, maxDepth) ?? shallowColor;
      stops.push({ offset: t * 100, color });
    }
    return stops;
  }, [minDepth, maxDepth, shallowColor, deepColor]);

  if (!visible) return null;

  const isFlat = minDepth === maxDepth;

  return (
    <div
      data-testid="depth-legend"
      className="depth-legend"
      style={{
        position: 'absolute',
        bottom: 50,
        left: 10,
        background: 'rgba(0, 0, 0, 0.7)',
        borderRadius: 4,
        padding: 8,
        zIndex: 1,
        display: 'flex',
        gap: 6,
      }}
    >
      <svg
        width="16"
        height="80"
        role="img"
        aria-label={`Depth scale: ${minDepth.toFixed(1)}m (shallow) to ${maxDepth.toFixed(1)}m (deep)`}
      >
        <defs>
          <linearGradient id={gradientId} x1="0%" y1="0%" x2="0%" y2="100%">
            {gradientStops.map((stop, i) => (
              <stop key={i} offset={`${stop.offset}%`} stopColor={stop.color} />
            ))}
          </linearGradient>
        </defs>
        <rect width="16" height="80" fill={`url(#${gradientId})`} rx="2" />
      </svg>
      <div
        className="legend-labels"
        style={{
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'space-between',
          fontSize: 11,
          color: 'white',
          textShadow: '0 1px 2px rgba(0,0,0,0.8)',
        }}
      >
        <span data-testid="depth-legend-min">{minDepth.toFixed(1)}m</span>
        {isFlat && (
          <span style={{ fontSize: 10, color: 'rgba(255,255,255,0.7)' }}>
            (Flat)
          </span>
        )}
        <span data-testid="depth-legend-max">{maxDepth.toFixed(1)}m</span>
      </div>
    </div>
  );
}
