//! Read-only browsing of the raw sqlite tables in the current project
//! database (data table fullscreen mode). Values are stringified server-side;
//! see `Database::read_raw_table`.

use tauri::State;

use crate::core::AppState;
use crate::persistence::RawTableData;

/// List the raw sqlite table names in the current project database
#[tauri::command]
pub fn get_raw_table_names(state: State<AppState>) -> Result<Vec<String>, String> {
    get_raw_table_names_impl(state.inner())
}

pub(crate) fn get_raw_table_names_impl(state: &AppState) -> Result<Vec<String>, String> {
    state.list_raw_table_names().map_err(|e| e.to_string())
}

/// Read a page of stringified rows from a raw sqlite table
#[tauri::command]
pub fn get_raw_table(
    state: State<AppState>,
    table: String,
    limit: u32,
    offset: u32,
) -> Result<RawTableData, String> {
    get_raw_table_impl(state.inner(), table, limit, offset)
}

pub(crate) fn get_raw_table_impl(
    state: &AppState,
    table: String,
    limit: u32,
    offset: u32,
) -> Result<RawTableData, String> {
    state
        .read_raw_table(&table, limit, offset)
        .map_err(|e| e.to_string())
}
