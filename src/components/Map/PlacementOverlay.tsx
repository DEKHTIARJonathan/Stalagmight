import { useMemo } from 'react';
import type { SectionData, Coordinates, ShotData } from '../../types/project';

interface PlacementOverlayProps {
  /** Section data to preview */
  sectionData: SectionData;
  /** Which station aligns to cursor ('first' or 'last') */
  alignStation: 'first' | 'last';
  /** Current cursor position in screen pixels */
  cursorPosition: { x: number; y: number } | null;
  /** Whether snapped to an existing station */
  isSnapped: boolean;
}

/**
 * Calculate relative station positions from shot data.
 * Returns coordinates for each station (0 to shots.length inclusive).
 */
function calculateStationPositions(shots: ShotData[]): Coordinates[] {
  const stations: Coordinates[] = [{ x: 0, y: 0, z: 0 }];

  for (const shot of shots) {
    const prev = stations[stations.length - 1];
    if (!prev) continue;

    // Calculate direction from azimuth (degrees to radians, math convention)
    const azimuthRad = ((90 - shot.azimuth_in) * Math.PI) / 180;
    const length = shot.length;

    // Calculate depth change
    const depthChange = shot.depth_out - shot.depth_in;

    stations.push({
      x: prev.x + Math.cos(azimuthRad) * length,
      y: prev.y + Math.sin(azimuthRad) * length,
      z: prev.z + depthChange,
    });
  }

  return stations;
}

/**
 * Overlay component that renders a section preview following the cursor
 * during manual placement mode.
 */
export default function PlacementOverlay({
  sectionData,
  alignStation,
  cursorPosition,
  isSnapped,
}: PlacementOverlayProps) {
  // Calculate station positions relative to first station
  const stationPositions = useMemo(
    () => calculateStationPositions(sectionData.shots),
    [sectionData.shots]
  );

  // Get the anchor station (the one that follows the cursor)
  const anchorIndex = alignStation === 'first' ? 0 : stationPositions.length - 1;
  const anchorStation = stationPositions[anchorIndex];

  // Calculate bounds for scaling
  const bounds = useMemo(() => {
    let minX = Infinity,
      maxX = -Infinity,
      minY = Infinity,
      maxY = -Infinity;
    for (const station of stationPositions) {
      minX = Math.min(minX, station.x);
      maxX = Math.max(maxX, station.x);
      minY = Math.min(minY, station.y);
      maxY = Math.max(maxY, station.y);
    }
    return { minX, maxX, minY, maxY };
  }, [stationPositions]);

  // Calculate scale to fit preview in reasonable size (max 300px)
  const previewSize = 300;
  const margin = 20;
  const width = bounds.maxX - bounds.minX;
  const height = bounds.maxY - bounds.minY;
  const maxDimension = Math.max(width, height, 1);
  const scale = (previewSize - margin * 2) / maxDimension;

  if (!cursorPosition || !anchorStation) {
    return null;
  }

  // Transform station to screen coordinates, centered on cursor
  const toScreen = (station: Coordinates): { x: number; y: number } => {
    const relX = (station.x - anchorStation.x) * scale;
    const relY = -(station.y - anchorStation.y) * scale; // Flip Y for screen coordinates
    return {
      x: cursorPosition.x + relX,
      y: cursorPosition.y + relY,
    };
  };

  // Build SVG path for shots
  const pathData = stationPositions
    .map((station, i) => {
      const screen = toScreen(station);
      return i === 0 ? `M ${screen.x} ${screen.y}` : `L ${screen.x} ${screen.y}`;
    })
    .join(' ');

  // Color for preview (use section color with transparency)
  const strokeColor = sectionData.color;
  const fillColor = isSnapped ? '#00ffcc' : sectionData.color;

  return (
    <svg
      className="absolute inset-0 pointer-events-none"
      style={{ width: '100%', height: '100%', overflow: 'visible' }}
      data-testid="placement-preview"
    >
      {/* Shot lines */}
      <path
        d={pathData}
        fill="none"
        stroke={strokeColor}
        strokeWidth={2}
        strokeOpacity={0.8}
        strokeDasharray="4 2"
      />

      {/* Station markers */}
      {stationPositions.map((station, i) => {
        const screen = toScreen(station);
        const isAnchor = i === anchorIndex;
        return (
          <circle
            key={i}
            cx={screen.x}
            cy={screen.y}
            r={isAnchor ? 8 : 4}
            fill={isAnchor ? fillColor : strokeColor}
            fillOpacity={0.8}
            stroke={isSnapped && isAnchor ? '#00ffcc' : '#000'}
            strokeWidth={isAnchor ? 2 : 1}
          />
        );
      })}

      {/* Anchor indicator (crosshair) */}
      <g>
        <line
          x1={cursorPosition.x - 12}
          y1={cursorPosition.y}
          x2={cursorPosition.x - 5}
          y2={cursorPosition.y}
          stroke={isSnapped ? '#00ffcc' : '#fff'}
          strokeWidth={2}
        />
        <line
          x1={cursorPosition.x + 5}
          y1={cursorPosition.y}
          x2={cursorPosition.x + 12}
          y2={cursorPosition.y}
          stroke={isSnapped ? '#00ffcc' : '#fff'}
          strokeWidth={2}
        />
        <line
          x1={cursorPosition.x}
          y1={cursorPosition.y - 12}
          x2={cursorPosition.x}
          y2={cursorPosition.y - 5}
          stroke={isSnapped ? '#00ffcc' : '#fff'}
          strokeWidth={2}
        />
        <line
          x1={cursorPosition.x}
          y1={cursorPosition.y + 5}
          x2={cursorPosition.x}
          y2={cursorPosition.y + 12}
          stroke={isSnapped ? '#00ffcc' : '#fff'}
          strokeWidth={2}
        />
      </g>
    </svg>
  );
}
