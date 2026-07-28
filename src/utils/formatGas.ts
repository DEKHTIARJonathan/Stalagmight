/**
 * Gas-planning formatting utilities with metric/imperial conversion (PRD §7.2).
 *
 * Canonical SI in, display units out: metric = bar / litres / (L/min); imperial =
 * psi / cuft / (cuft/min). Mirrors formatStats.ts; the unit is driven by the master
 * metric/imperial toggle (GasConfig.units). Non-finite inputs render "--".
 */

import type { GasUnits } from '../types/ipc.generated';
import { formatFixed } from '../i18n/format';
import { clamp } from './clamp';

/** Conversion factor: bar → psi. */
const PSI_PER_BAR = 14.5037738;
/** Conversion factor: litres → cubic feet. */
const CUFT_PER_LITRE = 0.0353146667;
/** Conversion factor: metres → feet. */
const FEET_PER_METRE = 3.2808399;

/** Maximum decimal precision (matches the Rust/back-end formatters). */
const MAX_DECIMAL_PRECISION = 6;

function isFiniteNumber(value: number | null | undefined): value is number {
  return value !== null && value !== undefined && Number.isFinite(value);
}

function clampPrecision(precision: number): number {
  return clamp(Math.floor(precision) || 0, 0, MAX_DECIMAL_PRECISION);
}

/**
 * Format a pressure given in bar (canonical) as bar or psi.
 *
 * @param bar - Pressure in bar
 * @param units - 'metric' (bar) or 'imperial' (psi)
 * @param precision - Decimal places (default 0 - gauges read as whole numbers)
 */
export function formatPressure(bar: number, units: GasUnits, precision: number = 0): string {
  if (!isFiniteNumber(bar)) {
    return '--';
  }
  const imperial = units === 'imperial';
  const value = imperial ? bar * PSI_PER_BAR : bar;
  const suffix = imperial ? 'psi' : 'bar';
  return `${formatFixed(value, undefined, clampPrecision(precision))} ${suffix}`;
}

/**
 * Format a gas volume given in litres (canonical) as L or cuft.
 *
 * @param litres - Volume in litres
 * @param units - 'metric' (L) or 'imperial' (cuft)
 * @param precision - Decimal places (default 0)
 */
export function formatVolume(litres: number, units: GasUnits, precision: number = 0): string {
  if (!isFiniteNumber(litres)) {
    return '--';
  }
  const imperial = units === 'imperial';
  const value = imperial ? litres * CUFT_PER_LITRE : litres;
  const suffix = imperial ? 'cuft' : 'L';
  return `${formatFixed(value, undefined, clampPrecision(precision))} ${suffix}`;
}

/**
 * Format a length given in metres (canonical) as m or ft - used for route distance and depth in
 * the Plan readout, so they follow the same metric/imperial toggle (and "value unit" spacing) as
 * the gas figures. Distinct from `formatStats.formatLength` (which takes a `LengthUnit` and renders
 * without a space, e.g. "42.3m") - this one is the GasUnits-keyed, spaced sibling of formatPressure
 * / formatVolume, kept here so the Plan readouts stay visually consistent.
 *
 * @param metres - Length in metres
 * @param units - 'metric' (m) or 'imperial' (ft)
 * @param precision - Decimal places (default 0)
 */
export function formatGasLength(metres: number, units: GasUnits, precision: number = 0): string {
  if (!isFiniteNumber(metres)) {
    return '--';
  }
  const imperial = units === 'imperial';
  const value = imperial ? metres * FEET_PER_METRE : metres;
  const suffix = imperial ? 'ft' : 'm';
  return `${formatFixed(value, undefined, clampPrecision(precision))} ${suffix}`;
}

/**
 * Format an RMV given in L/min (canonical) as L/min or cuft/min. Imperial RMVs are
 * fractional, so the default precision is higher there (2 vs 1).
 *
 * @param lPerMin - RMV in L/min
 * @param units - 'metric' (L/min) or 'imperial' (cuft/min)
 * @param precision - Decimal places (default: imperial 2, metric 1)
 */
export function formatRmv(lPerMin: number, units: GasUnits, precision?: number): string {
  if (!isFiniteNumber(lPerMin)) {
    return '--';
  }
  const imperial = units === 'imperial';
  const value = imperial ? lPerMin * CUFT_PER_LITRE : lPerMin;
  const suffix = imperial ? 'cuft/min' : 'L/min';
  const resolved = precision ?? (imperial ? 2 : 1);
  return `${formatFixed(value, undefined, clampPrecision(resolved))} ${suffix}`;
}

/** Canonical RMV (L/min) → the number shown in the selected unit (L/min or cuft/min). */
export function rmvToDisplay(lPerMin: number, units: GasUnits): number {
  return units === 'imperial' ? lPerMin * CUFT_PER_LITRE : lPerMin;
}

/** An RMV typed in the selected unit (L/min or cuft/min) → canonical L/min for the store. */
export function rmvFromDisplay(value: number, units: GasUnits): number {
  return units === 'imperial' ? value / CUFT_PER_LITRE : value;
}

/**
 * Canonical length (m) → the number shown in the selected unit (m or ft). The numeric sibling of
 * `formatGasLength`, for callers that need the display VALUE rather than a formatted string -
 * profile axis ticks are chosen at round numbers in the diver's own unit (every 50 ft, not every
 * 15.24 m) and then mapped back to metres to be positioned.
 */
export function lengthToDisplay(metres: number, units: GasUnits): number {
  return units === 'imperial' ? metres * FEET_PER_METRE : metres;
}

/** A length in the selected unit (m or ft) → canonical metres. */
export function lengthFromDisplay(value: number, units: GasUnits): number {
  return units === 'imperial' ? value / FEET_PER_METRE : value;
}

/** Canonical speed (m/min) → the number shown in the selected unit (m/min or ft/min). */
export function speedToDisplay(mPerMin: number, units: GasUnits): number {
  return units === 'imperial' ? mPerMin * FEET_PER_METRE : mPerMin;
}

/** A speed typed in the selected unit (m/min or ft/min) → canonical m/min for the store. */
export function speedFromDisplay(value: number, units: GasUnits): number {
  return units === 'imperial' ? value / FEET_PER_METRE : value;
}

/** Canonical pressure (bar) → the number shown in the selected unit (bar or psi). */
export function pressureToDisplay(bar: number, units: GasUnits): number {
  return units === 'imperial' ? bar * PSI_PER_BAR : bar;
}

/** A pressure typed in the selected unit (bar or psi) → canonical bar for the store. */
export function pressureFromDisplay(value: number, units: GasUnits): number {
  return units === 'imperial' ? value / PSI_PER_BAR : value;
}
