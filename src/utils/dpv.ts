import type { DpvRig, DpvUnit } from '../types/ipc.generated';

/** Mirrors `default_dpv_range_reserve_fraction()` in `src-tauri/src/config/gas.rs` (0.1). */
export const DEFAULT_DPV_RANGE_RESERVE_FRACTION = 0.1;

/**
 * Mirrors `MAX_DPV_RANGE_RESERVE_FRACTION` in `src-tauri/src/config/gas.rs` (0.9). Above this,
 * `GasConfig::normalize` clamps the fraction down to the cap rather than repairing it another
 * way (the cap would zero the whole usable range, which is useless but not unsafe, so it's
 * capped rather than reset like a negative fraction is).
 */
export const MAX_DPV_RANGE_RESERVE_FRACTION = 0.9;

/**
 * A sensible starting rig for the "enable" toggle. There is no backend default to seed from
 * (a rig is either fully specified or absent), so these are just plausible cave-DPV numbers -
 * immediately editable, and the "primary" and "backup" reset targets below.
 */
export function makeDefaultDpvRig(): DpvRig {
  return {
    primary: { speed_m_per_min: 45, burn_minutes: 60 },
    backup: { speed_m_per_min: 45, burn_minutes: 45 },
    range_reserve_fraction: DEFAULT_DPV_RANGE_RESERVE_FRACTION,
  };
}
export const DEFAULT_DPV_RIG = makeDefaultDpvRig();

/** A unit with no meaningful range (mirrors `dpv_unit_is_valid` in gas.rs). */
export function dpvUnitInvalid(unit: DpvUnit): boolean {
  return (
    !Number.isFinite(unit.speed_m_per_min) ||
    unit.speed_m_per_min <= 0 ||
    !Number.isFinite(unit.burn_minutes) ||
    unit.burn_minutes <= 0
  );
}

/**
 * Mirrors `GasConfig::normalize` in `src-tauri/src/config/gas.rs` EXACTLY - not a plain clamp to
 * `[0, MAX_DPV_RANGE_RESERVE_FRACTION]`. A non-finite or negative fraction RESETS to the default
 * (0.1), it does not clamp to 0; only a value ABOVE the cap clamps down to the cap. The two branches
 * disagree on purpose (Rust's own comment: the cap would zero the whole usable range, which is
 * useless but not unsafe, so it's capped rather than reset like a negative fraction is) - a plain
 * `Math.max(0, ...)` here would preview 100% of the weaker unit's range for a negative entry instead
 * of the 90% the backend would actually give it once normalized.
 */
export function normalizedReserveFraction(fraction: number): number {
  if (!Number.isFinite(fraction) || fraction < 0) return DEFAULT_DPV_RANGE_RESERVE_FRACTION;
  return Math.min(fraction, MAX_DPV_RANGE_RESERVE_FRACTION);
}

/**
 * Usable one-way range (metres): `min(primary.range, backup.range) x (1 - reserve)`, the weaker
 * unit by line covered (not by burn time), not halved (primary flies in, backup flies out).
 * Mirrors `DpvRig::usable_range_m` in `src-tauri/src/config/gas.rs` exactly - read it before
 * changing this.
 *
 * The reserve fraction is normalized into the backend's accepted domain before it is used, the same
 * way `GasConfig::normalize` normalizes it on save: this previews the LIVE (not-yet-saved) working
 * config - a value the diver is mid-typing must never preview a number the backend would not actually
 * honor once saved (a 0.95 entry previewing 5% of range while the backend would clamp to 0.9 and give
 * 10% is exactly that drift, the #233 gauge class). `PositiveNumberField` blocks a non-positive speed/
 * burn entry at the field itself, so an invalid rig is not constructible in the editor; there is no
 * separate Save-blocking validation for the rig fields the way there is for swim speed / jump multiplier.
 */
export function dpvUsableRangeM(rig: DpvRig): number {
  const weaker = Math.min(
    rig.primary.speed_m_per_min * rig.primary.burn_minutes,
    rig.backup.speed_m_per_min * rig.backup.burn_minutes
  );
  const reserve = normalizedReserveFraction(rig.range_reserve_fraction);
  return Math.max(weaker * (1 - reserve), 0);
}
