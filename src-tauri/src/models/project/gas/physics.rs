//! Pure gas-planning physics — no graph, no config, no I/O. Golden-tested in
//! `super::tests`. Canonical SI throughout: depth in metres (positive-down), RMV in
//! L/min, pressure in bar, gas volume in litres. These are plain `f64` functions; the
//! finite/positive guards live in the `model` constructors (RMV, cylinders) and in
//! `GasConfig::normalize` (speeds/multipliers), so callers pass validated inputs (mirrors the
//! `Coordinates::new` / `new_checked` split).

/// Ambient pressure in atmospheres-absolute at depth `depth_m` metres (positive-down).
/// 10 msw ≈ 1 bar, so `ata = 1 + max(depth, 0)/10`; above the surface clamps to 1 ATA.
pub(crate) fn ata(depth_m: f64) -> f64 {
    1.0 + depth_m.max(0.0) / 10.0
}

/// Gas-consumption rate (L/min) at depth: the surface RMV scaled by ambient pressure.
pub(crate) fn gas_rate(rmv_l_per_min: f64, depth_m: f64) -> f64 {
    rmv_l_per_min * ata(depth_m)
}

/// Mean depth (m) of a straight leg between two stations. Trapezoidal mean of the
/// endpoints — exact for a leg whose depth varies linearly along its length.
pub(crate) fn avg_depth(z_from: f64, z_to: f64) -> f64 {
    0.5 * (z_from + z_to)
}

/// Gas (litres) consumed traversing one straight leg of `length_m` at `speed_m_per_min`,
/// breathing `rmv_l_per_min`, the leg running from depth `z_from` to `z_to` metres.
/// `gas = rate(avg_depth) × time = gas_rate(rmv, avg_depth) × (length / speed)`.
///
/// Precondition: `speed_m_per_min > 0` — guaranteed for config-sourced speeds by
/// `GasConfig::normalize`; any other caller must validate before calling.
pub(crate) fn edge_gas(
    rmv_l_per_min: f64,
    speed_m_per_min: f64,
    length_m: f64,
    z_from: f64,
    z_to: f64,
) -> f64 {
    let rate = gas_rate(rmv_l_per_min, avg_depth(z_from, z_to));
    rate * (length_m / speed_m_per_min)
}

/// Convert a SAC (surface air consumption, bar/min measured against a reference
/// cylinder) to a volumetric RMV (L/min): `rmv = sac × reference_water_volume`.
/// SAC is a constructor concern only — never stored (see `model::Diver::from_sac`).
pub(crate) fn sac_to_rmv(sac_bar_per_min: f64, ref_cyl_water_volume_l: f64) -> f64 {
    sac_bar_per_min * ref_cyl_water_volume_l
}

/// Ideal free-gas volume (litres) a cylinder holds at `fill_bar`: `fill × water_volume`.
/// Ideal-gas relation — at high fill (230+ bar) real compressibility (Z) over-states this
/// by ~5–8% (the unsafe direction); callers apply the conservative "call-it-an-80" derate
/// or a Z correction (see the PRD §5.3 real-gas note).
pub(crate) fn cylinder_gas_volume(fill_bar: f64, water_volume_l: f64) -> f64 {
    fill_bar * water_volume_l
}
