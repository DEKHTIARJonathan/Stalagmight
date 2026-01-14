use anyhow::{Context, Result};
use std::path::PathBuf;
use std::sync::Mutex;

use crate::config::Config;
use crate::models::{
    ClosureStrategy, GpsCoordinates, Project, ProjectMetadata, SectionData, SectionId,
    SectionUpdates, ShotData, ShotId, ShotUpdates, StationRef,
};
use crate::persistence::Database;

use super::{Command, CommandResult, UndoStack, ValidationWarning, Validator};

/// Application state managed by Tauri
pub struct AppState {
    /// Current project (if any)
    project: Mutex<Option<Project>>,
    /// Database connection (if project is open)
    database: Mutex<Option<Database>>,
    /// Undo/redo stack
    undo_stack: Mutex<UndoStack>,
    /// Application configuration
    config: Mutex<Config>,
    /// Recent projects list
    recent_projects: Mutex<Vec<PathBuf>>,
}

impl AppState {
    /// Create a new application state
    pub fn new() -> Result<Self> {
        let config = Config::load().unwrap_or_default();

        Ok(Self {
            project: Mutex::new(None),
            database: Mutex::new(None),
            undo_stack: Mutex::new(UndoStack::new()),
            config: Mutex::new(config),
            recent_projects: Mutex::new(Vec::new()),
        })
    }

    /// Execute a command and return the result
    pub fn execute(&self, cmd: Command) -> CommandResult {
        tracing::info!(command = ?cmd.description(), "Executing command");

        let result = match &cmd {
            Command::CreateProject { name, location } => {
                self.create_project(name.clone(), location.clone())
            }
            Command::OpenProject { path } => self.open_project(path.clone()),
            Command::SaveProject { path } => self.save_project(path.clone()),
            Command::CloseProject => self.close_project(),
            Command::CreateSection {
                name,
                surveyor,
                date,
                color,
                shots,
            } => self.create_section(SectionData {
                name: name.clone(),
                surveyor: surveyor.clone(),
                date: *date,
                color: color.clone(),
                shots: shots.clone(),
            }),
            Command::DeleteSection { section_id } => self.delete_section(*section_id),
            Command::UpdateSectionMetadata {
                section_id,
                updates,
            } => self.update_section(*section_id, updates.clone()),
            Command::CreateShot {
                section_id,
                shot,
                after_shot_id,
            } => self.create_shot(*section_id, shot.clone(), *after_shot_id),
            Command::UpdateShot {
                section_id,
                shot_id,
                updates,
            } => self.update_shot(*section_id, *shot_id, updates.clone()),
            Command::DeleteShot {
                section_id,
                shot_id,
            } => self.delete_shot(*section_id, *shot_id),
            Command::SetShotVirtual {
                section_id,
                shot_id,
                is_virtual,
            } => self.set_shot_virtual(*section_id, *shot_id, *is_virtual),
            Command::MergeStations {
                station_a,
                station_b,
                closure_strategy,
            } => self.merge_stations(*station_a, *station_b, *closure_strategy),
            Command::UnmergeStations { station_ref } => self.unmerge_stations(*station_ref),
            Command::SetZeroDatum {
                station_ref,
                coordinates,
            } => self.set_zero_datum(*station_ref, *coordinates),
            Command::RemoveZeroDatum { station_ref } => self.remove_zero_datum(*station_ref),
            Command::Batch { commands } => self.execute_batch(commands.clone()),
        };

        // Push to undo stack if successful and not a read-only command
        if result.success && Self::is_undoable(&cmd) {
            if let Ok(mut undo_stack) = self.undo_stack.lock() {
                undo_stack.push(cmd.clone());
            }
        }

        // Auto-save if enabled
        if result.success && Self::is_modifying(&cmd) {
            if let Ok(config) = self.config.lock() {
                if config.general.auto_save {
                    let _ = self.save_project(None);
                }
            }
        }

        result
    }

    /// Check if a command should be pushed to undo stack
    fn is_undoable(cmd: &Command) -> bool {
        !matches!(
            cmd,
            Command::OpenProject { .. }
                | Command::SaveProject { .. }
                | Command::CloseProject
                | Command::CreateProject { .. }
        )
    }

    /// Check if a command modifies project state
    fn is_modifying(cmd: &Command) -> bool {
        !matches!(
            cmd,
            Command::OpenProject { .. } | Command::SaveProject { .. } | Command::CloseProject
        )
    }

    // === Project operations ===

    fn create_project(&self, name: String, location: Option<String>) -> CommandResult {
        let project = Project::new(name, location);

        if let Ok(mut proj) = self.project.lock() {
            *proj = Some(project);
        }

        if let Ok(mut undo_stack) = self.undo_stack.lock() {
            undo_stack.clear();
        }

        tracing::info!("Project created");
        CommandResult::success()
    }

    fn open_project(&self, path: PathBuf) -> CommandResult {
        let db = match Database::open(&path) {
            Ok(db) => db,
            Err(e) => return CommandResult::failure(format!("Failed to open database: {}", e)),
        };

        let mut project = match db.load_project() {
            Ok(p) => p,
            Err(e) => return CommandResult::failure(format!("Failed to load project: {}", e)),
        };

        project.file_path = Some(path.clone());

        if let Ok(mut proj) = self.project.lock() {
            *proj = Some(project);
        }

        if let Ok(mut database) = self.database.lock() {
            *database = Some(db);
        }

        if let Ok(mut undo_stack) = self.undo_stack.lock() {
            undo_stack.clear();
        }

        // Add to recent projects
        if let Ok(mut recent) = self.recent_projects.lock() {
            recent.retain(|p| p != &path);
            recent.insert(0, path);
            if let Ok(config) = self.config.lock() {
                recent.truncate(config.general.recent_projects_max);
            }
        }

        tracing::info!("Project opened");
        CommandResult::success()
    }

    fn save_project(&self, path: Option<PathBuf>) -> CommandResult {
        let mut proj_guard = match self.project.lock() {
            Ok(g) => g,
            Err(_) => return CommandResult::failure("Failed to lock project".to_string()),
        };

        let project = match proj_guard.as_mut() {
            Some(p) => p,
            None => return CommandResult::failure("No project open".to_string()),
        };

        // Determine save path
        let save_path = path.or_else(|| project.file_path.clone());
        let save_path = match save_path {
            Some(p) => p,
            None => return CommandResult::failure("No save path specified".to_string()),
        };

        // Update file path
        project.file_path = Some(save_path.clone());

        // Save to database
        let mut db = match Database::open(&save_path) {
            Ok(db) => db,
            Err(e) => return CommandResult::failure(format!("Failed to open database: {}", e)),
        };

        if let Err(e) = db.save_project(project) {
            return CommandResult::failure(format!("Failed to save project: {}", e));
        }

        // Update database handle
        drop(proj_guard);
        if let Ok(mut database) = self.database.lock() {
            *database = Some(db);
        }

        tracing::info!(path = ?save_path, "Project saved");
        CommandResult::success()
    }

    fn close_project(&self) -> CommandResult {
        if let Ok(mut proj) = self.project.lock() {
            *proj = None;
        }

        if let Ok(mut db) = self.database.lock() {
            *db = None;
        }

        if let Ok(mut undo_stack) = self.undo_stack.lock() {
            undo_stack.clear();
        }

        tracing::info!("Project closed");
        CommandResult::success()
    }

    // === Section operations ===

    fn create_section(&self, data: SectionData) -> CommandResult {
        let config = self.config.lock().ok();
        let mut warnings = Vec::new();

        // Validate shots
        for (i, shot) in data.shots.iter().enumerate() {
            if let Some(ref cfg) = config {
                warnings.extend(Validator::validate_shot(shot, &cfg.validation, i));
            }
        }

        let mut proj_guard = match self.project.lock() {
            Ok(g) => g,
            Err(_) => return CommandResult::failure("Failed to lock project".to_string()),
        };

        let project = match proj_guard.as_mut() {
            Some(p) => p,
            None => return CommandResult::failure("No project open".to_string()),
        };

        let section = project.add_section(data);
        tracing::info!(section_id = section.id, "Section created");

        CommandResult::success_with_warnings(warnings)
    }

    fn delete_section(&self, section_id: SectionId) -> CommandResult {
        let mut proj_guard = match self.project.lock() {
            Ok(g) => g,
            Err(_) => return CommandResult::failure("Failed to lock project".to_string()),
        };

        let project = match proj_guard.as_mut() {
            Some(p) => p,
            None => return CommandResult::failure("No project open".to_string()),
        };

        if project.remove_section(section_id).is_some() {
            tracing::info!(section_id, "Section deleted");
            CommandResult::success()
        } else {
            CommandResult::failure(format!("Section {} not found", section_id))
        }
    }

    fn update_section(&self, section_id: SectionId, updates: SectionUpdates) -> CommandResult {
        let mut proj_guard = match self.project.lock() {
            Ok(g) => g,
            Err(_) => return CommandResult::failure("Failed to lock project".to_string()),
        };

        let project = match proj_guard.as_mut() {
            Some(p) => p,
            None => return CommandResult::failure("No project open".to_string()),
        };

        if project.update_section(section_id, &updates).is_some() {
            tracing::info!(section_id, "Section updated");
            CommandResult::success()
        } else {
            CommandResult::failure(format!("Section {} not found", section_id))
        }
    }

    // === Shot operations ===

    fn create_shot(
        &self,
        section_id: SectionId,
        data: ShotData,
        after_shot_id: Option<ShotId>,
    ) -> CommandResult {
        let config = self.config.lock().ok();
        let mut warnings = Vec::new();

        if let Some(ref cfg) = config {
            warnings.extend(Validator::validate_shot(&data, &cfg.validation, 0));
        }

        let mut proj_guard = match self.project.lock() {
            Ok(g) => g,
            Err(_) => return CommandResult::failure("Failed to lock project".to_string()),
        };

        let project = match proj_guard.as_mut() {
            Some(p) => p,
            None => return CommandResult::failure("No project open".to_string()),
        };

        let shot = if let Some(after_id) = after_shot_id {
            project.insert_shot_after(section_id, after_id, data)
        } else {
            project.add_shot(section_id, data)
        };

        if shot.is_some() {
            tracing::info!(section_id, "Shot created");
            CommandResult::success_with_warnings(warnings)
        } else {
            CommandResult::failure("Failed to create shot".to_string())
        }
    }

    fn update_shot(
        &self,
        section_id: SectionId,
        shot_id: ShotId,
        updates: ShotUpdates,
    ) -> CommandResult {
        let mut proj_guard = match self.project.lock() {
            Ok(g) => g,
            Err(_) => return CommandResult::failure("Failed to lock project".to_string()),
        };

        let project = match proj_guard.as_mut() {
            Some(p) => p,
            None => return CommandResult::failure("No project open".to_string()),
        };

        if project.update_shot(section_id, shot_id, &updates).is_some() {
            tracing::info!(section_id, shot_id, "Shot updated");
            CommandResult::success()
        } else {
            CommandResult::failure(format!("Shot {}:{} not found", section_id, shot_id))
        }
    }

    fn delete_shot(&self, section_id: SectionId, shot_id: ShotId) -> CommandResult {
        let mut proj_guard = match self.project.lock() {
            Ok(g) => g,
            Err(_) => return CommandResult::failure("Failed to lock project".to_string()),
        };

        let project = match proj_guard.as_mut() {
            Some(p) => p,
            None => return CommandResult::failure("No project open".to_string()),
        };

        if project.remove_shot(section_id, shot_id).is_some() {
            tracing::info!(section_id, shot_id, "Shot deleted");
            CommandResult::success()
        } else {
            CommandResult::failure(format!("Shot {}:{} not found", section_id, shot_id))
        }
    }

    fn set_shot_virtual(
        &self,
        section_id: SectionId,
        shot_id: ShotId,
        is_virtual: bool,
    ) -> CommandResult {
        let mut proj_guard = match self.project.lock() {
            Ok(g) => g,
            Err(_) => return CommandResult::failure("Failed to lock project".to_string()),
        };

        let project = match proj_guard.as_mut() {
            Some(p) => p,
            None => return CommandResult::failure("No project open".to_string()),
        };

        if project
            .set_shot_virtual(section_id, shot_id, is_virtual)
            .is_some()
        {
            tracing::info!(section_id, shot_id, is_virtual, "Shot virtual status updated");
            CommandResult::success()
        } else {
            CommandResult::failure(format!("Shot {}:{} not found", section_id, shot_id))
        }
    }

    // === Station operations ===

    fn merge_stations(
        &self,
        station_a: StationRef,
        station_b: StationRef,
        strategy: ClosureStrategy,
    ) -> CommandResult {
        let mut proj_guard = match self.project.lock() {
            Ok(g) => g,
            Err(_) => return CommandResult::failure("Failed to lock project".to_string()),
        };

        let project = match proj_guard.as_mut() {
            Some(p) => p,
            None => return CommandResult::failure("No project open".to_string()),
        };

        if project.merge_stations(station_a, station_b, strategy) {
            tracing::info!(?station_a, ?station_b, "Stations merged");
            CommandResult::success()
        } else {
            CommandResult::failure("Failed to merge stations".to_string())
        }
    }

    fn unmerge_stations(&self, station_ref: StationRef) -> CommandResult {
        let mut proj_guard = match self.project.lock() {
            Ok(g) => g,
            Err(_) => return CommandResult::failure("Failed to lock project".to_string()),
        };

        let project = match proj_guard.as_mut() {
            Some(p) => p,
            None => return CommandResult::failure("No project open".to_string()),
        };

        // Find and unmerge all merges involving this station
        let merges_to_remove: Vec<_> = project
            .station_merges
            .iter()
            .filter(|m| m.station_a == station_ref || m.station_b == station_ref)
            .map(|m| (m.station_a, m.station_b))
            .collect();

        for (a, b) in merges_to_remove {
            project.unmerge_stations(a, b);
        }

        tracing::info!(?station_ref, "Station unmerged");
        CommandResult::success()
    }

    fn set_zero_datum(&self, station_ref: StationRef, gps: GpsCoordinates) -> CommandResult {
        let mut proj_guard = match self.project.lock() {
            Ok(g) => g,
            Err(_) => return CommandResult::failure("Failed to lock project".to_string()),
        };

        let project = match proj_guard.as_mut() {
            Some(p) => p,
            None => return CommandResult::failure("No project open".to_string()),
        };

        if project.set_zero_datum(station_ref, gps) {
            tracing::info!(?station_ref, "Zero datum set");
            CommandResult::success()
        } else {
            CommandResult::failure("Failed to set zero datum".to_string())
        }
    }

    fn remove_zero_datum(&self, station_ref: StationRef) -> CommandResult {
        let mut proj_guard = match self.project.lock() {
            Ok(g) => g,
            Err(_) => return CommandResult::failure("Failed to lock project".to_string()),
        };

        let project = match proj_guard.as_mut() {
            Some(p) => p,
            None => return CommandResult::failure("No project open".to_string()),
        };

        if project.remove_zero_datum(station_ref) {
            tracing::info!(?station_ref, "Zero datum removed");
            CommandResult::success()
        } else {
            CommandResult::failure("Station is not a zero datum".to_string())
        }
    }

    fn execute_batch(&self, commands: Vec<Command>) -> CommandResult {
        let mut all_warnings = Vec::new();

        for cmd in commands {
            let result = self.execute(cmd);
            if !result.success {
                return result;
            }
            all_warnings.extend(result.warnings);
        }

        CommandResult::success_with_warnings(all_warnings)
    }

    // === State queries ===

    /// Get the current project state for the frontend
    pub fn get_project_state(&self) -> Option<Project> {
        self.project.lock().ok().and_then(|p| p.clone())
    }

    /// Get recent projects list
    pub fn get_recent_projects(&self) -> Vec<ProjectMetadata> {
        let recent = match self.recent_projects.lock() {
            Ok(r) => r.clone(),
            Err(_) => return Vec::new(),
        };

        recent
            .iter()
            .filter_map(|path| {
                if let Ok(db) = Database::open(path) {
                    if let Ok(mut project) = db.load_project() {
                        project.file_path = Some(path.clone());
                        return project.metadata();
                    }
                }
                None
            })
            .collect()
    }

    /// Get config
    pub fn get_config(&self) -> Config {
        self.config.lock().ok().map(|c| c.clone()).unwrap_or_default()
    }

    /// Update config
    pub fn update_config(&self, config: Config) -> Result<()> {
        config.save()?;
        if let Ok(mut cfg) = self.config.lock() {
            *cfg = config;
        }
        Ok(())
    }

    /// Check if undo is available
    pub fn can_undo(&self) -> bool {
        self.undo_stack
            .lock()
            .map(|s| s.can_undo())
            .unwrap_or(false)
    }

    /// Check if redo is available
    pub fn can_redo(&self) -> bool {
        self.undo_stack
            .lock()
            .map(|s| s.can_redo())
            .unwrap_or(false)
    }

    /// Perform undo
    pub fn undo(&self) -> CommandResult {
        // TODO: Implement proper undo with state snapshots
        // For now, just pop from the stack
        if let Ok(mut stack) = self.undo_stack.lock() {
            if stack.undo() {
                tracing::info!("Undo performed");
                CommandResult::success()
            } else {
                CommandResult::failure("Nothing to undo".to_string())
            }
        } else {
            CommandResult::failure("Failed to lock undo stack".to_string())
        }
    }

    /// Perform redo
    pub fn redo(&self) -> CommandResult {
        // TODO: Implement proper redo with state snapshots
        if let Ok(mut stack) = self.undo_stack.lock() {
            if stack.redo() {
                tracing::info!("Redo performed");
                CommandResult::success()
            } else {
                CommandResult::failure("Nothing to redo".to_string())
            }
        } else {
            CommandResult::failure("Failed to lock undo stack".to_string())
        }
    }
}
