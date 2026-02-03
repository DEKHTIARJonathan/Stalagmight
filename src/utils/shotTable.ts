import { circularMeanDegrees, normalizeAngle } from './angles';

export function getAzimuthAverage(azimuthIn: number, azimuthOut: number): number {
  const inVal = Number.isFinite(azimuthIn) ? azimuthIn : 0;
  const outVal = Number.isFinite(azimuthOut) ? azimuthOut : 0;
  return circularMeanDegrees(inVal, outVal);
}

export function applyAzimuthEdit(
  value: number | string,
  options: { normalize?: boolean } = {}
): { azimuth_in: number; azimuth_out: number } {
  const rawValue = typeof value === 'number' ? value : parseFloat(value);
  const shouldNormalize = options.normalize !== false;
  const nextValue = Number.isFinite(rawValue)
    ? (shouldNormalize ? normalizeAngle(rawValue) : rawValue)
    : 0;
  return { azimuth_in: nextValue, azimuth_out: nextValue };
}
