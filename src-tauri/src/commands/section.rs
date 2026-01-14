use chrono::NaiveDate;
use tauri::State;

use crate::core::{AppState, Command, CommandResult};
use crate::models::{Coordinates, Section, SectionId, SectionUpdates, ShotData};

/// Create a new section
#[tauri::command]
pub fn create_section(
    state: State<AppState>,
    name: Option<String>,
    surveyor: Option<String>,
    date: Option<NaiveDate>,
    color: String,
    shots: Vec<ShotData>,
) -> CommandResult {
    state.execute(Command::CreateSection {
        name,
        surveyor,
        date,
        color,
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
    state.execute(Command::UpdateSectionMetadata {
        section_id,
        updates,
    })
}

/// Delete a section
#[tauri::command]
pub fn delete_section(state: State<AppState>, section_id: SectionId) -> CommandResult {
    state.execute(Command::DeleteSection { section_id })
}

/// Get a section by ID
#[tauri::command]
pub fn get_section(state: State<AppState>, section_id: SectionId) -> Option<Section> {
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
    state.execute(Command::MoveSection { section_id, offset })
}
