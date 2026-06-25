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
 * @param precision - Decimal places (default 0 — gauges read as whole numbers)
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
