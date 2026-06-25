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
    diver: Diver,
    cylinders: Vec<Cylinder>,
    gas_config: GasConfig,
) -> Result<Option<GasReachField>, String> {
    // Re-validate through the guarding constructors — a NaN/zero RMV or cylinder from the
    // frontend would otherwise reach the engine and poison the field.
    let diver = Diver::new(diver.rmv_l_per_min, diver.label)?;
    let cylinders = cylinders
        .into_iter()
        .map(|c| {
            Cylinder::new(
                c.water_volume_l,
                c.rated_pressure_bar,
                c.fill_bar,
                c.material,
                c.role,
                c.label,
            )
        })
        .collect::<Result<Vec<_>, _>>()?;
    let mut gas_config = gas_config;
    gas_config.normalize();

    let field = tauri::async_runtime::spawn_blocking(move || {
        let state = app_handle.state::<AppState>();
        state
            .inner()
            .gas_reach_field(origin.as_ref(), &diver, &cylinders, &gas_config)
    })
    .await
    .ok()
    .flatten();
    Ok(field)
}
