use chrono::NaiveDate;
use tauri::State;

use crate::core::{AppState, Command, CommandResult};
use crate::models::{ClosureStrategy, Coordinates, Section, SectionId, SectionUpdates, ShotData, StationRef, SurveyDirection};

/// Create a new section
#[tauri::command]
pub fn create_section(
    state: State<AppState>,
    name: Option<String>,
    surveyor: Option<String>,
    date: Option<NaiveDate>,
    color: String,
    direction: Option<SurveyDirection>,
    shots: Vec<ShotData>,
) -> CommandResult {
    create_section_impl(state.inner(), name, surveyor, date, color, direction, shots)
}

pub(crate) fn create_section_impl(
    state: &AppState,
    name: Option<String>,
    surveyor: Option<String>,
    date: Option<NaiveDate>,
    color: String,
    direction: Option<SurveyDirection>,
    shots: Vec<ShotData>,
) -> CommandResult {
    state.execute(Command::CreateSection {
        name,
        surveyor,
        date,
        color,
        direction,
        shots,
    })
}

/// Update section metadata
#[tauri::command]
pub fn update_section(
    state: State<AppState>,
    section_id: SectionId,
    updates: SectionUpdates,
) -> CommandResult {
    update_section_impl(state.inner(), section_id, updates)
}

pub(crate) fn update_section_impl(
    state: &AppState,
    section_id: SectionId,
    updates: SectionUpdates,
) -> CommandResult {
    state.execute(Command::UpdateSectionMetadata {
        section_id,
        updates,
    })
}

/// Delete a section
#[tauri::command]
pub fn delete_section(state: State<AppState>, section_id: SectionId) -> CommandResult {
    delete_section_impl(state.inner(), section_id)
}

pub(crate) fn delete_section_impl(state: &AppState, section_id: SectionId) -> CommandResult {
    state.execute(Command::DeleteSection { section_id })
}

/// Get a section by ID
#[tauri::command]
pub fn get_section(state: State<AppState>, section_id: SectionId) -> Option<Section> {
    get_section_impl(state.inner(), section_id)
}

pub(crate) fn get_section_impl(state: &AppState, section_id: SectionId) -> Option<Section> {
    let project = state.get_project_state()?;
    project.get_section(section_id).cloned()
}

/// Move a section by an offset
#[tauri::command]
pub fn move_section(
    state: State<AppState>,
    section_id: SectionId,
    offset: Coordinates,
) -> CommandResult {
    move_section_impl(state.inner(), section_id, offset)
}

pub(crate) fn move_section_impl(
    state: &AppState,
    section_id: SectionId,
    offset: Coordinates,
) -> CommandResult {
    state.execute(Command::MoveSection { section_id, offset })
}

/// Create a new section and immediately merge one of its stations with an existing station.
/// This is executed as a single undo/redo operation using the internal batch mechanism.
///
/// The merge station's section_id is specified as 0 (placeholder) and replaced with the
/// actual created section ID during execution.
#[tauri::command]
pub fn create_section_and_merge(
    state: State<AppState>,
    name: Option<String>,
    surveyor: Option<String>,
    date: Option<NaiveDate>,
    color: String,
    direction: Option<SurveyDirection>,
    shots: Vec<ShotData>,
    import_station_index: u32,
    target_station: StationRef,
    closure_strategy: ClosureStrategy,
) -> CommandResult {
    create_section_and_merge_impl(
        state.inner(),
        name,
        surveyor,
        date,
        color,
        direction,
        shots,
        import_station_index,
        target_station,
        closure_strategy,
    )
}

pub(crate) fn create_section_and_merge_impl(
    state: &AppState,
    name: Option<String>,
    surveyor: Option<String>,
    date: Option<NaiveDate>,
    color: String,
    direction: Option<SurveyDirection>,
    shots: Vec<ShotData>,
    import_station_index: u32,
    target_station: StationRef,
    closure_strategy: ClosureStrategy,
) -> CommandResult {
    // Use a special internal execution that:
    // 1. Takes a project snapshot for undo
    // 2. Creates the section
    // 3. Merges with the actual section ID
    // 4. Returns as a single undo unit
    state.execute_create_and_merge(
        name,
        surveyor,
        date,
        color,
        direction,
        shots,
        import_station_index,
        target_station,
        closure_strategy,
    )
}
