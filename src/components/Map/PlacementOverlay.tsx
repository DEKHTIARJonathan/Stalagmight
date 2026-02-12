import { useMemo } from 'react';
import type { SectionData, Coordinates, ShotData } from '../../types/project';
import { getThemeColor } from '../../utils/themeColors';
import { useUIStore, type AdditionalPlacementSection } from '../../store/uiStore';

interface PlacementOverlayProps {
  /** Section data to preview */
  sectionData: SectionData;
  /** Which station index aligns to cursor (0 = first, N = last) */
  alignStationIndex: number;
  /** Current cursor position in screen pixels */
  cursorPosition: { x: number; y: number } | null;
  /** Whether snapped to an existing station */
  isSnapped: boolean;
  /** Pixels per meter at current map zoom (for to-scale rendering) */
  pixelsPerMeter: number;
  /** Additional sections to render alongside primary (for segment placement) */
  additionalSections?: AdditionalPlacementSection[] | undefined;
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
 * during manual placement mode. The preview is rendered to-scale with the map.
 */
export default function PlacementOverlay({
  sectionData,
  alignStationIndex,
  cursorPosition,
  isSnapped,
  pixelsPerMeter,
  additionalSections,
}: PlacementOverlayProps) {
  // Calculate station positions relative to first station
  const stationPositions = useMemo(
    () => calculateStationPositions(sectionData.shots),
    [sectionData.shots]
  );

  // Clamp align station index to valid range
  const anchorIndex = Math.max(0, Math.min(alignStationIndex, stationPositions.length - 1));
  const anchorStation = stationPositions[anchorIndex];

  if (!cursorPosition || !anchorStation) {
    return null;
  }

  // Use the map's actual scale (pixels per meter) for to-scale rendering
  const scale = pixelsPerMeter;

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

  // Subscribe to theme for reactive color updates (value triggers re-render)
  useUIStore((s) => s.resolvedTheme);
  const snapColor = getThemeColor('--cc-snap-color');
  const crosshairColor = getThemeColor('--cc-compass-color');
  const stationStrokeColor = getThemeColor('--cc-stroke-color');

  // Color for preview (use section color with transparency)
  const strokeColor = sectionData.color;
  const fillColor = isSnapped ? snapColor : sectionData.color;

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
            stroke={isSnapped && isAnchor ? snapColor : stationStrokeColor}
            strokeWidth={isAnchor ? 2 : 1}
          />
        );
      })}

      {/* Additional sections (segment context) */}
      {additionalSections?.map((addSection, secIdx) => {
        const addPositions = calculateStationPositions(addSection.sectionData.shots);
        // Transform with offset relative to primary section's anchor station
        const toScreenAdd = (station: Coordinates): { x: number; y: number } => {
          const relX = (station.x + addSection.offsetX - anchorStation.x) * scale;
          const relY = -(station.y + addSection.offsetY - anchorStation.y) * scale;
          return {
            x: cursorPosition.x + relX,
            y: cursorPosition.y + relY,
          };
        };

        const addPathData = addPositions
          .map((station, i) => {
            const screen = toScreenAdd(station);
            return i === 0 ? `M ${screen.x} ${screen.y}` : `L ${screen.x} ${screen.y}`;
          })
          .join(' ');

        return (
          <g key={secIdx}>
            <path
              d={addPathData}
              fill="none"
              stroke={addSection.color}
              strokeWidth={1.5}
              strokeOpacity={0.6}
              strokeDasharray="4 2"
            />
            {addPositions.map((station, i) => {
              const screen = toScreenAdd(station);
              return (
                <circle
                  key={i}
                  cx={screen.x}
                  cy={screen.y}
                  r={3}
                  fill={addSection.color}
                  fillOpacity={0.6}
                  stroke={stationStrokeColor}
                  strokeWidth={0.5}
                />
              );
            })}
          </g>
        );
      })}

      {/* Anchor indicator (crosshair) */}
      <g>
        <line
          x1={cursorPosition.x - 12}
          y1={cursorPosition.y}
          x2={cursorPosition.x - 5}
          y2={cursorPosition.y}
          stroke={isSnapped ? snapColor : crosshairColor}
          strokeWidth={2}
        />
        <line
          x1={cursorPosition.x + 5}
          y1={cursorPosition.y}
          x2={cursorPosition.x + 12}
          y2={cursorPosition.y}
          stroke={isSnapped ? snapColor : crosshairColor}
          strokeWidth={2}
        />
        <line
          x1={cursorPosition.x}
          y1={cursorPosition.y - 12}
          x2={cursorPosition.x}
          y2={cursorPosition.y - 5}
          stroke={isSnapped ? snapColor : crosshairColor}
          strokeWidth={2}
        />
        <line
          x1={cursorPosition.x}
          y1={cursorPosition.y + 5}
          x2={cursorPosition.x}
          y2={cursorPosition.y + 12}
          stroke={isSnapped ? snapColor : crosshairColor}
          strokeWidth={2}
        />
      </g>
    </svg>
  );
}
