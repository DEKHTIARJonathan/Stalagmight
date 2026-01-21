use tauri::State;

use crate::core::{AppState, Command, CommandResult};
use crate::models::{ClosureStrategy, Coordinates, GpsCoordinates, StationRef};

/// Merge two stations
#[tauri::command]
pub fn merge_stations(
    state: State<AppState>,
    station_a: StationRef,
    station_b: StationRef,
    closure_strategy: ClosureStrategy,
) -> CommandResult {
    merge_stations_impl(state.inner(), station_a, station_b, closure_strategy)
}

pub(crate) fn merge_stations_impl(
    state: &AppState,
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
    unmerge_stations_impl(state.inner(), station_ref)
}

pub(crate) fn unmerge_stations_impl(state: &AppState, station_ref: StationRef) -> CommandResult {
    state.execute(Command::UnmergeStations { station_ref })
}

/// Set zero datum for a station
#[tauri::command]
pub fn set_zero_datum(
    state: State<AppState>,
    station_ref: StationRef,
    coordinates: GpsCoordinates,
) -> CommandResult {
    set_zero_datum_impl(state.inner(), station_ref, coordinates)
}

pub(crate) fn set_zero_datum_impl(
    state: &AppState,
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
    remove_zero_datum_impl(state.inner(), station_ref)
}

pub(crate) fn remove_zero_datum_impl(state: &AppState, station_ref: StationRef) -> CommandResult {
    state.execute(Command::RemoveZeroDatum { station_ref })
}

/// Move a station to a new position
#[tauri::command]
pub fn move_station(
    state: State<AppState>,
    station_ref: StationRef,
    new_position: Coordinates,
) -> CommandResult {
    move_station_impl(state.inner(), station_ref, new_position)
}

pub(crate) fn move_station_impl(
    state: &AppState,
    station_ref: StationRef,
    new_position: Coordinates,
) -> CommandResult {
    state.execute(Command::MoveStation {
        station_ref,
        new_position,
    })
}
