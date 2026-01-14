use tauri::State;

use crate::core::{AppState, Command, CommandResult};
use crate::models::{SectionId, ShotData, ShotId, ShotUpdates};

/// Create a new shot
#[tauri::command]
pub fn create_shot(
    state: State<AppState>,
    section_id: SectionId,
    shot: ShotData,
    after_shot_id: Option<ShotId>,
) -> CommandResult {
    state.execute(Command::CreateShot {
        section_id,
        shot,
        after_shot_id,
    })
}

/// Update a shot
#[tauri::command]
pub fn update_shot(
    state: State<AppState>,
    section_id: SectionId,
    shot_id: ShotId,
    updates: ShotUpdates,
) -> CommandResult {
    state.execute(Command::UpdateShot {
        section_id,
        shot_id,
        updates,
    })
}

/// Delete a shot
#[tauri::command]
pub fn delete_shot(
    state: State<AppState>,
    section_id: SectionId,
    shot_id: ShotId,
) -> CommandResult {
    state.execute(Command::DeleteShot {
        section_id,
        shot_id,
    })
}

/// Set shot virtual status
#[tauri::command]
pub fn set_shot_virtual(
    state: State<AppState>,
    section_id: SectionId,
    shot_id: ShotId,
    is_virtual: bool,
) -> CommandResult {
    state.execute(Command::SetShotVirtual {
        section_id,
        shot_id,
        is_virtual,
    })
}
