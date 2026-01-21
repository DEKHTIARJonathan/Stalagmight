import { useId } from 'react';

interface DepthLegendProps {
  minDepth: number;
  maxDepth: number;
  shallowColor?: string;
  deepColor?: string;
  visible: boolean;
}

/**
 * Shows a depth color gradient legend with min/max labels.
 * Positioned in the bottom-left corner of the map, above the scale bar.
 */
export function DepthLegend({
  minDepth,
  maxDepth,
  shallowColor = '#00bfff',
  deepColor = '#ff4444',
  visible,
}: DepthLegendProps) {
  const gradientId = useId();

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
            <stop offset="0%" stopColor={shallowColor} />
            <stop offset="100%" stopColor={isFlat ? shallowColor : deepColor} />
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
