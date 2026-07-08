//! Dive-plan (`.plnx`) IPC commands (#244). Thin wrappers that run the SQLite I/O
//! off the UI thread via `spawn_blocking` and delegate to the `AppState` methods
//! (mirrors `commands::gas`). The snapshot is validated by serde on the way in; the
//! engine re-validates the diver/cylinders when the loaded plan is recomputed.

use tauri::Manager;

use crate::core::AppState;
use crate::models::{DivePlan, DivePlanMeta, DivePlanSnapshot};

/// List the dive plans stored next to the open project (newest first). Empty when
/// there is no saved project or no `.plnx` yet.
#[tauri::command]
pub async fn list_dive_plans(app_handle: tauri::AppHandle) -> Result<Vec<DivePlanMeta>, String> {
    match tauri::async_runtime::spawn_blocking(move || {
        app_handle.state::<AppState>().inner().list_dive_plans()
    })
    .await
    {
        Ok(res) => res,
        Err(e) => Err(format!("list dive plans failed: {e}")),
    }
}

/// Load one plan, degrading stale station refs against the live survey.
#[tauri::command]
pub async fn load_dive_plan(app_handle: tauri::AppHandle, id: i64) -> Result<DivePlan, String> {
    match tauri::async_runtime::spawn_blocking(move || {
        app_handle.state::<AppState>().inner().load_dive_plan(id)
    })
    .await
    {
        Ok(res) => res,
        Err(e) => Err(format!("load dive plan failed: {e}")),
    }
}

/// Save a plan next to the open project. `id` is `None` for a new plan (Save as),
/// `Some` to overwrite an existing one (Save).
#[tauri::command]
pub async fn save_dive_plan(
    app_handle: tauri::AppHandle,
    id: Option<i64>,
    name: String,
    snapshot: DivePlanSnapshot,
) -> Result<DivePlanMeta, String> {
    match tauri::async_runtime::spawn_blocking(move || {
        app_handle
            .state::<AppState>()
            .inner()
            .save_dive_plan(id, name, snapshot)
    })
    .await
    {
        Ok(res) => res,
        Err(e) => Err(format!("save dive plan failed: {e}")),
    }
}

/// Delete a plan next to the open project.
#[tauri::command]
pub async fn delete_dive_plan(app_handle: tauri::AppHandle, id: i64) -> Result<(), String> {
    match tauri::async_runtime::spawn_blocking(move || {
        app_handle.state::<AppState>().inner().delete_dive_plan(id)
    })
    .await
    {
        Ok(res) => res,
        Err(e) => Err(format!("delete dive plan failed: {e}")),
    }
}
