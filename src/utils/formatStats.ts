/**
 * Stats formatting utilities with unit conversion support.
 */

import type { LengthUnit } from '../types/config';
import { formatFixed } from '../i18n/format';

/** Conversion factor: meters to feet */
const FEET_PER_METER = 3.28084;

/** Default decimal precision */
const DEFAULT_PRECISION = 1;

/** Maximum decimal precision (matches Rust backend) */
const MAX_DECIMAL_PRECISION = 6;

/**
 * Check if a value is finite (not NaN, Infinity, or -Infinity).
 */
function isFiniteNumber(value: number | null | undefined): value is number {
  return value !== null && value !== undefined && Number.isFinite(value);
}

/**
 * Get unit suffix for display.
 */
function getUnitSuffix(unit: LengthUnit): string {
  return unit === 'feet' ? 'ft' : 'm';
}

/**
 * Convert meters to the target unit.
 */
function convertLength(meters: number, unit: LengthUnit): number {
  return unit === 'feet' ? meters * FEET_PER_METER : meters;
}

/**
 * Clamp precision to valid range for toFixed().
 */
function clampPrecision(precision: number): number {
  return Math.max(0, Math.min(MAX_DECIMAL_PRECISION, Math.floor(precision) || 0));
}

/**
 * Format a length value with unit conversion.
 *
 * @param meters - Length in meters
 * @param unit - Target unit ('meters' or 'feet')
 * @param precision - Decimal places (default: 1)
 * @returns Formatted string (e.g., "42.3m", "138.8ft") or "--" if non-finite
 */
export function formatLength(
  meters: number,
  unit: LengthUnit,
  precision: number = DEFAULT_PRECISION
): string {
  if (!isFiniteNumber(meters)) {
    return '--';
  }

  const value = convertLength(meters, unit);
  const clampedPrecision = clampPrecision(precision);
  const suffix = getUnitSuffix(unit);

  return `${formatFixed(value, undefined, clampedPrecision)}${suffix}`;
}

/**
 * Format a depth range with unit conversion.
 *
 * @param min - Minimum depth in meters (or null)
 * @param max - Maximum depth in meters (or null)
 * @param unit - Target unit ('meters' or 'feet')
 * @param precision - Decimal places (default: 1)
 * @returns Formatted range string (e.g., "2.1-15.4m") or "--" if any value is null/non-finite
 */
export function formatDepthRange(
  min: number | null,
  max: number | null,
  unit: LengthUnit,
  precision: number = DEFAULT_PRECISION
): string {
  if (!isFiniteNumber(min) || !isFiniteNumber(max)) {
    return '--';
  }

  const minValue = convertLength(min, unit);
  const maxValue = convertLength(max, unit);
  const clampedPrecision = clampPrecision(precision);
  const suffix = getUnitSuffix(unit);

  return `${formatFixed(minValue, undefined, clampedPrecision)}-${formatFixed(maxValue, undefined, clampedPrecision)}${suffix}`;
}
