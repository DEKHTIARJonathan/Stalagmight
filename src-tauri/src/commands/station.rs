use tauri::State;

use crate::core::{AppState, Command, CommandResult};
use crate::models::{ClosureStrategy, GpsCoordinates, StationRef};

/// Merge two stations
#[tauri::command]
pub fn merge_stations(
    state: State<AppState>,
    station_a: StationRef,
    station_b: StationRef,
    closure_strategy: ClosureStrategy,
) -> CommandResult {
    state.execute(Command::MergeStations {
        station_a,
        station_b,
        closure_strategy,
    })
}

/// Unmerge a station
#[tauri::command]
pub fn unmerge_stations(state: State<AppState>, station_ref: StationRef) -> CommandResult {
    state.execute(Command::UnmergeStations { station_ref })
}

/// Set zero datum for a station
#[tauri::command]
pub fn set_zero_datum(
    state: State<AppState>,
    station_ref: StationRef,
    coordinates: GpsCoordinates,
) -> CommandResult {
    state.execute(Command::SetZeroDatum {
        station_ref,
        coordinates,
    })
}

/// Remove zero datum from a station
#[tauri::command]
pub fn remove_zero_datum(state: State<AppState>, station_ref: StationRef) -> CommandResult {
    state.execute(Command::RemoveZeroDatum { station_ref })
}
