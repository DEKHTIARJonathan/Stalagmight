import type { Cylinder, CylRole, TankMaterial } from '../types/ipc.generated';

/**
 * Representative cave-cylinder presets (#38, PRD §5.3 — specs supplied by Nico,
 * 2026-06-24). `water_volume_l` is the canonical property (the "80/100/120" name
 * is just nominal cuft at rating). These are GENERAL/representative — confirm per
 * actual cylinder; NOT a comprehensive third-party DB. `fill_bar` defaults to the
 * rated pressure when added; the user overfills LP steels in-panel (fill is an
 * input, never clamped to rated — PRD §5.3).
 */
export interface TankPreset {
  id: string;
  label: string;
  water_volume_l: number;
  rated_pressure_bar: number;
  material: TankMaterial;
  /** Default role when added — the user can change it in the panel. */
  role: CylRole;
}

export const TANK_PRESETS: readonly TankPreset[] = [
  { id: 'al80', label: 'AL80', water_volume_l: 11.1, rated_pressure_bar: 207, material: 'aluminium', role: 'back_gas' },
  { id: 'lp50', label: 'LP50', water_volume_l: 7.4, rated_pressure_bar: 179, material: 'steel', role: 'back_gas' },
  { id: 'lp72', label: 'LP72', water_volume_l: 9.9, rated_pressure_bar: 179, material: 'steel', role: 'back_gas' },
  { id: 'lp85', label: 'LP85', water_volume_l: 12.0, rated_pressure_bar: 179, material: 'steel', role: 'back_gas' },
  { id: 'lp104', label: 'LP104', water_volume_l: 14.5, rated_pressure_bar: 179, material: 'steel', role: 'back_gas' },
  { id: 'lp120', label: 'LP120', water_volume_l: 17.0, rated_pressure_bar: 179, material: 'steel', role: 'back_gas' },
  { id: 'hp100', label: 'HP100', water_volume_l: 12.9, rated_pressure_bar: 237, material: 'steel', role: 'back_gas' },
  { id: 'hp120', label: 'HP120', water_volume_l: 15.4, rated_pressure_bar: 237, material: 'steel', role: 'back_gas' },
  { id: 'hp130', label: 'HP130', water_volume_l: 16.7, rated_pressure_bar: 237, material: 'steel', role: 'back_gas' },
  // AL40 is a deco-only bottle — its gas is never penetration gas (role 'deco' is
  // excluded from the OC budget). Listed so the preset exists for the deco phase.
  { id: 'al40', label: 'AL40', water_volume_l: 5.7, rated_pressure_bar: 207, material: 'aluminium', role: 'deco' },
  // CCR diluent / small bailout bottles (named by water-volume L).
  { id: 'al13', label: 'AL13', water_volume_l: 2.0, rated_pressure_bar: 207, material: 'aluminium', role: 'dil_out' },
  { id: 'al19', label: 'AL19', water_volume_l: 3.0, rated_pressure_bar: 207, material: 'aluminium', role: 'dil_out' },
  { id: 'al20', label: 'AL20', water_volume_l: 3.0, rated_pressure_bar: 207, material: 'aluminium', role: 'dil_out' },
  { id: 's15', label: 'S15', water_volume_l: 2.0, rated_pressure_bar: 237, material: 'steel', role: 'dil_out' },
  { id: 's23', label: 'S23', water_volume_l: 3.0, rated_pressure_bar: 237, material: 'steel', role: 'dil_out' },
  { id: 's27', label: 'S27', water_volume_l: 4.0, rated_pressure_bar: 182, material: 'steel', role: 'dil_out' },
];

/** Build a Cylinder from a preset (fill defaults to rated; the user overfills in-panel). */
export function cylinderFromPreset(p: TankPreset): Cylinder {
  return {
    water_volume_l: p.water_volume_l,
    rated_pressure_bar: p.rated_pressure_bar,
    fill_bar: p.rated_pressure_bar,
    material: p.material,
    role: p.role,
    label: p.label,
  };
}
