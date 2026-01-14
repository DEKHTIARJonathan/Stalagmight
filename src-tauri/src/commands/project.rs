use std::path::PathBuf;
use tauri::State;

use crate::core::{AppState, Command, CommandResult};
use crate::models::{Project, ProjectMetadata, ProjectStats, Station};

/// Create a new project
#[tauri::command]
pub fn create_project(
    state: State<AppState>,
    name: String,
    location: Option<String>,
) -> CommandResult {
    state.execute(Command::CreateProject { name, location })
}

/// Open an existing project
#[tauri::command]
pub fn open_project(state: State<AppState>, path: PathBuf) -> CommandResult {
    state.execute(Command::OpenProject { path })
}

/// Save the current project
#[tauri::command]
pub fn save_project(state: State<AppState>, path: Option<PathBuf>) -> CommandResult {
    state.execute(Command::SaveProject { path })
}

/// Close the current project
#[tauri::command]
pub fn close_project(state: State<AppState>) -> CommandResult {
    state.execute(Command::CloseProject)
}

/// Get the full project state for the frontend
#[tauri::command]
pub fn get_project_state(state: State<AppState>) -> Option<ProjectState> {
    let project = state.get_project_state()?;
    let stations = project.compute_station_coordinates();
    let stats = project.stats();

    Some(ProjectState {
        project,
        stations,
        stats,
    })
}

/// Get list of recent projects
#[tauri::command]
pub fn list_recent_projects(state: State<AppState>) -> Vec<ProjectMetadata> {
    state.get_recent_projects()
}

/// Combined project state for frontend
#[derive(serde::Serialize)]
pub struct ProjectState {
    pub project: Project,
    pub stations: Vec<Station>,
    pub stats: ProjectStats,
}
