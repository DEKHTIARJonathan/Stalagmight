use tauri::Manager;

use crate::config::GasConfig;
use crate::core::AppState;
use crate::models::{Cylinder, Diver, GasReachField, StationRef};

/// Single-diver open-circuit gas reachability field (#38, Phase 1 headline).
///
/// Validates the diver + cylinders (serde deserialization builds the structs directly,
/// bypassing the model guards) and normalizes the gas config, then computes the reachable
/// frontier off the UI thread via `spawn_blocking` (mirrors `get_station_distances_from`; the
/// engine reads the instant MEASURED coords, never the slow closure-adjusted solve). Returns
/// `Ok(None)` when no project is open; `Err(msg)` on invalid input.
#[tauri::command]
pub async fn compute_gas_reach_field(
    app_handle: tauri::AppHandle,
    origin: Option<StationRef>,
    endpoint: Option<StationRef>,
    diver: Diver,
    cylinders: Vec<Cylinder>,
    gas_config: GasConfig,
    // Per-stage drop overrides (#246), aligned 1:1 with the field's `stage_drop_refs`: the station
    // the diver dragged each ▼ marker to (`None` = keep the strategy default). The frontend always
    // sends it (empty when nothing is dragged); the engine clamps each pinned drop before it can
    // move the budget, so a stray ref can only fall through to the default.
    stage_drop_overrides: Vec<Option<StationRef>>,
) -> Result<Option<GasReachField>, String> {
    // Re-validate through the guarding constructors - a NaN/zero RMV or cylinder from the
    // frontend would otherwise reach the engine and poison the field.
    let diver = Diver::new(diver.rmv_l_per_min, diver.label)?;
    let cylinders = cylinders
        .into_iter()
        .map(|c| {
            // `new` re-validates the numerics and resets the non-constructor fields, so carry
            // the frontend's `enabled` + `usable_gas_bar` across (serde already defaulted any
            // missing ones). `usable_gas_bar` is otherwise unbounded here - the engine clamps it
            // to `[0, basis]` (the conservative-capped fill) per cylinder before budgeting AND
            // before display, so a stray value can't over-state reach or the readout.
            let (enabled, usable_gas_bar) = (c.enabled, c.usable_gas_bar);
            Cylinder::new(
                c.water_volume_l,
                c.rated_pressure_bar,
                c.fill_bar,
                c.material,
                c.role,
                c.label,
            )
            .map(|mut cyl| {
                cyl.enabled = enabled;
                cyl.usable_gas_bar = usable_gas_bar;
                cyl
            })
        })
        .collect::<Result<Vec<_>, _>>()?;
    let mut gas_config = gas_config;
    gas_config.normalize();

    let field = tauri::async_runtime::spawn_blocking(move || {
        let state = app_handle.state::<AppState>();
        state.inner().gas_reach_field(
            origin.as_ref(),
            endpoint.as_ref(),
            &diver,
            &cylinders,
            &gas_config,
            &stage_drop_overrides,
        )
    })
    .await
    // A JoinError (engine panic / cancellation) is a real backend bug, so surface it as
    // Err rather than collapsing it to Ok(None) - which is reserved for "no project open".
    .map_err(|e| format!("gas reach computation failed: {e}"))?;
    Ok(field)
}
