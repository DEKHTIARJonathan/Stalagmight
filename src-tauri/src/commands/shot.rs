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
    before_shot_id: Option<ShotId>,
) -> CommandResult {
    create_shot_impl(state.inner(), section_id, shot, after_shot_id, before_shot_id)
}

pub(crate) fn create_shot_impl(
    state: &AppState,
    section_id: SectionId,
    shot: ShotData,
    after_shot_id: Option<ShotId>,
    before_shot_id: Option<ShotId>,
) -> CommandResult {
    state.execute(Command::CreateShot {
        section_id,
        shot,
        after_shot_id,
        before_shot_id,
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
    update_shot_impl(state.inner(), section_id, shot_id, updates)
}

pub(crate) fn update_shot_impl(
    state: &AppState,
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
    delete_shot_impl(state.inner(), section_id, shot_id)
}

pub(crate) fn delete_shot_impl(
    state: &AppState,
    section_id: SectionId,
    shot_id: ShotId,
) -> CommandResult {
    state.execute(Command::DeleteShot {
        section_id,
        shot_id,
    })
}

/// Delete a mid-section shot and split the section into two named sections
#[tauri::command]
pub fn delete_shot_and_split(
    state: State<AppState>,
    section_id: SectionId,
    shot_id: ShotId,
    name_a: String,
    name_b: String,
) -> CommandResult {
    delete_shot_and_split_impl(state.inner(), section_id, shot_id, name_a, name_b)
}

pub(crate) fn delete_shot_and_split_impl(
    state: &AppState,
    section_id: SectionId,
    shot_id: ShotId,
    name_a: String,
    name_b: String,
) -> CommandResult {
    state.execute_delete_shot_and_split(section_id, shot_id, name_a, name_b)
}

/// Delete the last remaining shot in a section and remove the section
#[tauri::command]
pub fn delete_last_shot_and_section(
    state: State<AppState>,
    section_id: SectionId,
    shot_id: ShotId,
) -> CommandResult {
    delete_last_shot_and_section_impl(state.inner(), section_id, shot_id)
}

pub(crate) fn delete_last_shot_and_section_impl(
    state: &AppState,
    section_id: SectionId,
    shot_id: ShotId,
) -> CommandResult {
    state.execute_delete_last_shot_and_section(section_id, shot_id)
}

/// Set shot virtual status
#[tauri::command]
pub fn set_shot_virtual(
    state: State<AppState>,
    section_id: SectionId,
    shot_id: ShotId,
    is_virtual: bool,
) -> CommandResult {
    set_shot_virtual_impl(state.inner(), section_id, shot_id, is_virtual)
}

pub(crate) fn set_shot_virtual_impl(
    state: &AppState,
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
