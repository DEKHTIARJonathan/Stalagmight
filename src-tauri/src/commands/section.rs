use chrono::NaiveDate;
use serde::{Deserialize, Serialize};
use tauri::State;
use ts_rs::TS;

use crate::core::{AppState, Command, CommandResult};
use crate::models::{ClosureStrategy, Coordinates, Section, SectionId, SectionRelationships, SectionUpdates, ShotData, StationRef, SurveyDirection};

/// Shot-line geometry for a single section within a segment.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct SegmentSectionGeometry {
    pub section_id: SectionId,
    pub color: String,
    /// Shot lines as pairs of [x, y] coords in meters, relative to the anchor section's station 0
    pub shot_lines: Vec<[[f64; 2]; 2]>,
}

/// Shot-line geometry for all sections in a segment, positioned relative to a given section.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct SegmentGeometry {
    pub sections: Vec<SegmentSectionGeometry>,
}

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

/// Move an entire segment (all connected sections) by an offset
#[tauri::command]
pub fn move_segment(
    state: State<AppState>,
    section_id: SectionId,
    offset: Coordinates,
) -> CommandResult {
    state.execute(Command::MoveSegment { section_id, offset })
}

/// Execute a batch of commands as a single undo/redo unit
#[tauri::command]
pub fn execute_batch(
    state: State<AppState>,
    commands: Vec<Command>,
) -> CommandResult {
    state.execute(Command::Batch { commands })
}

/// Get all section IDs connected to the given section through merges and closures
#[tauri::command]
pub fn get_connected_section_ids(
    state: State<AppState>,
    section_id: SectionId,
) -> Result<Vec<SectionId>, String> {
    state.get_connected_section_ids(section_id)
}

/// Get all section IDs connected through merges and aligned closures (rigid groups)
#[tauri::command]
pub fn get_rigid_connected_section_ids(
    state: State<AppState>,
    section_id: SectionId,
) -> Result<Vec<SectionId>, String> {
    state.get_rigid_connected_section_ids(section_id)
}

/// Get all section IDs belonging to segments that contain a zero datum
#[tauri::command]
pub fn get_anchored_section_ids(
    state: State<AppState>,
) -> Result<Vec<SectionId>, String> {
    state.get_anchored_section_ids()
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

/// Get relationships that reference a section (merges, closures, offsets, zero datums).
/// Used by the frontend to show affected relationships before section deletion.
#[tauri::command]
pub fn get_section_relationships(
    state: State<AppState>,
    section_id: SectionId,
) -> Result<SectionRelationships, String> {
    get_section_relationships_impl(state.inner(), section_id)
}

pub(crate) fn get_section_relationships_impl(
    state: &AppState,
    section_id: SectionId,
) -> Result<SectionRelationships, String> {
    let project = state.get_project_state().ok_or_else(|| "No project open".to_string())?;

    if project.get_section(section_id).is_none() {
        return Err(format!("Section {section_id} not found"));
    }

    Ok(project.get_section_relationships(section_id))
}

/// Get shot-line geometry for all sections in the segment containing the given section.
/// Coordinates are relative to the given section's station 0.
#[tauri::command]
pub fn get_segment_geometry(
    state: State<AppState>,
    section_id: SectionId,
) -> Result<SegmentGeometry, String> {
    get_segment_geometry_impl(state.inner(), section_id)
}

pub(crate) fn get_segment_geometry_impl(
    state: &AppState,
    section_id: SectionId,
) -> Result<SegmentGeometry, String> {
    state.get_segment_geometry(section_id)
}
