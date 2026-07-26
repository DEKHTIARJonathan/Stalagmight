import type { ShotData } from '../types/project';
import type { EditableShot } from '../components/common/ShotTableEditor';

/**
 * Convert an EditableShot to a ShotData for the backend.
 */
export function editableShotToShotData(shot: EditableShot): ShotData {
  return {
    azimuth_in: shot.azimuth_in,
    azimuth_out: shot.azimuth_out,
    length: shot.length,
    depth_in: shot.depth_in,
    depth_out: shot.depth_out,
    pitch_in: shot.pitch_in,
    pitch_out: shot.pitch_out,
    left: shot.left,
    right: shot.right,
    up: shot.up,
    down: shot.down,
    comment: shot.comment,
    kind: shot.kind ?? 'Normal',
    marker_index: null,
    temperature: null,
  };
}

/**
 * Calculate station positions for a section based on shots.
 * Returns positions in local coordinates (station 0 at origin).
 */
export function calculateStationPositions(shots: EditableShot[]): Array<{ x: number; y: number }> {
  const positions: Array<{ x: number; y: number }> = [{ x: 0, y: 0 }];

  let x = 0;
  let y = 0;

  for (const shot of shots) {
    // Calculate heading from azimuth_in and azimuth_out average
    const heading = (shot.azimuth_in + shot.azimuth_out) / 2;
    // Convert heading to radians (heading is in degrees, 0 = north)
    const radians = ((90 - heading) * Math.PI) / 180;
    // Calculate dx, dy
    const dx = shot.length * Math.cos(radians);
    const dy = shot.length * Math.sin(radians);
    x += dx;
    y += dy;
    positions.push({ x, y });
  }

  return positions;
}
