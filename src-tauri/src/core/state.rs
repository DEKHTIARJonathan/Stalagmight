use anyhow::Result;
use std::path::PathBuf;
use std::sync::Mutex;

use crate::config::Config;
use crate::models::{
    ClosureStrategy, Coordinates, GpsCoordinates, Project, ProjectMetadata, Section, SectionData,
    SectionId, SectionUpdates, Shot, ShotData, ShotId, ShotUpdates, StationRef,
};
use crate::persistence::Database;

use super::{Command, CommandResult, UndoData, UndoEntry, UndoStack, Validator};

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

        // Generate undo data before executing the command
        let undo_data = if Self::is_undoable(&cmd) {
            self.generate_undo_data(&cmd)
        } else {
            UndoData::None
        };

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
            Command::MoveSection { section_id, offset } => {
                self.move_section(*section_id, *offset)
            }
            Command::MoveStation {
                station_ref,
                new_position,
            } => self.move_station(*station_ref, *new_position),
            Command::Batch { commands } => self.execute_batch(commands.clone()),
        };

        // Push to undo stack if successful and undoable
        if result.success && Self::is_undoable(&cmd) {
            // For CreateSection and CreateShot, we need to capture the new ID for the inverse command
            let final_undo_data = self.finalize_undo_data(&cmd, undo_data);

            if let Ok(mut undo_stack) = self.undo_stack.lock() {
                undo_stack.push_with_data(cmd.clone(), final_undo_data);
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

    /// Generate undo data before executing a command
    fn generate_undo_data(&self, cmd: &Command) -> UndoData {
        let proj_guard = match self.project.lock() {
            Ok(g) => g,
            Err(_) => return UndoData::None,
        };

        let project = match proj_guard.as_ref() {
            Some(p) => p,
            None => return UndoData::None,
        };

        match cmd {
            // For create commands, we'll fill in the ID after execution
            Command::CreateSection { .. } => UndoData::None, // Will be finalized after execution
            Command::CreateShot { section_id, .. } => {
                // Store section ID, shot ID will be filled in after execution
                UndoData::InverseCommand(Command::DeleteShot {
                    section_id: *section_id,
                    shot_id: 0, // Placeholder, will be updated
                })
            }

            // For delete commands, capture the full state
            Command::DeleteSection { section_id } => {
                if let Some(section) = project.get_section(*section_id) {
                    UndoData::SectionSnapshot {
                        section_id: *section_id,
                        section_data: section.to_section_data(),
                    }
                } else {
                    UndoData::None
                }
            }

            Command::DeleteShot {
                section_id,
                shot_id,
            } => {
                if let Some(section) = project.get_section(*section_id) {
                    if let Some((position, shot)) = section
                        .shots
                        .iter()
                        .enumerate()
                        .find(|(_, s)| s.id == *shot_id)
                    {
                        UndoData::ShotSnapshot {
                            section_id: *section_id,
                            shot_id: *shot_id,
                            shot_data: shot.to_shot_data(),
                            position,
                        }
                    } else {
                        UndoData::None
                    }
                } else {
                    UndoData::None
                }
            }

            // For update commands, capture previous values
            Command::UpdateShot {
                section_id,
                shot_id,
                updates,
            } => {
                if let Some(section) = project.get_section(*section_id) {
                    if let Some(shot) = section.get_shot(*shot_id) {
                        // Capture only the fields that are being updated
                        let prev_updates = ShotUpdates {
                            azimuth_in: updates.azimuth_in.map(|_| shot.azimuth_in),
                            azimuth_out: updates.azimuth_out.map(|_| shot.azimuth_out),
                            length: updates.length.map(|_| shot.length),
                            depth_in: updates.depth_in.map(|_| shot.depth_in),
                            depth_out: updates.depth_out.map(|_| shot.depth_out),
                            pitch_in: updates.pitch_in.as_ref().map(|_| shot.pitch_in),
                            pitch_out: updates.pitch_out.as_ref().map(|_| shot.pitch_out),
                            left: updates.left.as_ref().map(|_| shot.left),
                            right: updates.right.as_ref().map(|_| shot.right),
                            up: updates.up.as_ref().map(|_| shot.up),
                            down: updates.down.as_ref().map(|_| shot.down),
                            comment: updates.comment.as_ref().map(|_| shot.comment.clone()),
                            is_virtual: updates.is_virtual.map(|_| shot.is_virtual),
                            marker_index: updates.marker_index.as_ref().map(|_| shot.marker_index),
                            temperature: updates.temperature.as_ref().map(|_| shot.temperature),
                        };

                        if let Ok(json) = serde_json::to_string(&prev_updates) {
                            UndoData::PreviousValues {
                                section_id: *section_id,
                                shot_id: Some(*shot_id),
                                values_json: json,
                            }
                        } else {
                            UndoData::None
                        }
                    } else {
                        UndoData::None
                    }
                } else {
                    UndoData::None
                }
            }

            Command::UpdateSectionMetadata {
                section_id,
                updates,
            } => {
                if let Some(section) = project.get_section(*section_id) {
                    // Capture previous section metadata
                    let prev_updates = SectionUpdates {
                        name: updates.name.as_ref().map(|_| section.name.clone()),
                        surveyor: updates.surveyor.as_ref().map(|_| section.surveyor.clone()),
                        date: updates.date.as_ref().map(|_| section.date),
                        color: updates.color.as_ref().map(|_| section.color.clone()),
                    };

                    if let Ok(json) = serde_json::to_string(&prev_updates) {
                        UndoData::PreviousValues {
                            section_id: *section_id,
                            shot_id: None,
                            values_json: json,
                        }
                    } else {
                        UndoData::None
                    }
                } else {
                    UndoData::None
                }
            }

            // For virtual status toggle, inverse is toggling back
            Command::SetShotVirtual {
                section_id,
                shot_id,
                is_virtual,
            } => UndoData::InverseCommand(Command::SetShotVirtual {
                section_id: *section_id,
                shot_id: *shot_id,
                is_virtual: !*is_virtual,
            }),

            // For merge, store the info to unmerge
            Command::MergeStations {
                station_a,
                station_b,
                closure_strategy,
            } => UndoData::MergeInfo {
                station_a: *station_a,
                station_b: *station_b,
                strategy: *closure_strategy,
            },

            // For unmerge, we need to know which stations to re-merge
            Command::UnmergeStations { station_ref } => {
                // Find all merges involving this station
                let merges: Vec<_> = project
                    .station_merges
                    .iter()
                    .filter(|m| m.station_a == *station_ref || m.station_b == *station_ref)
                    .map(|m| (m.station_a, m.station_b))
                    .collect();

                if let Some((a, b)) = merges.first() {
                    // For simplicity, just store the first merge
                    UndoData::MergeInfo {
                        station_a: *a,
                        station_b: *b,
                        strategy: ClosureStrategy::ProportionalByLength, // Default strategy
                    }
                } else {
                    UndoData::None
                }
            }

            // For zero datum operations
            Command::SetZeroDatum { station_ref, .. } => {
                // Find if there was a previous datum for this station
                let previous_gps = project
                    .zero_datums
                    .iter()
                    .find(|zd| zd.station_ref == *station_ref)
                    .map(|zd| zd.gps);

                UndoData::ZeroDatumInfo {
                    station_ref: *station_ref,
                    previous_gps,
                }
            }

            Command::RemoveZeroDatum { station_ref } => {
                // Capture the current datum
                let previous_gps = project
                    .zero_datums
                    .iter()
                    .find(|zd| zd.station_ref == *station_ref)
                    .map(|zd| zd.gps);

                UndoData::ZeroDatumInfo {
                    station_ref: *station_ref,
                    previous_gps,
                }
            }

            // Move commands use inverse commands
            Command::MoveSection { section_id, offset } => {
                // Inverse is moving back by negative offset
                UndoData::InverseCommand(Command::MoveSection {
                    section_id: *section_id,
                    offset: Coordinates::new(-offset.x, -offset.y, -offset.z),
                })
            }

            Command::MoveStation {
                station_ref: _,
                new_position: _,
            } => {
                // For undo, we'd need to capture the original position
                // For now, use project snapshot since this is complex
                UndoData::ProjectSnapshot(
                    serde_json::to_string(project).unwrap_or_default(),
                )
            }

            // For batch, snapshot the entire project
            Command::Batch { .. } => {
                if let Ok(json) = serde_json::to_string(project) {
                    UndoData::ProjectSnapshot(json)
                } else {
                    UndoData::None
                }
            }

            // Non-undoable commands
            _ => UndoData::None,
        }
    }

    /// Finalize undo data after command execution (for commands that create new entities)
    fn finalize_undo_data(&self, cmd: &Command, undo_data: UndoData) -> UndoData {
        let proj_guard = match self.project.lock() {
            Ok(g) => g,
            Err(_) => return undo_data,
        };

        let project = match proj_guard.as_ref() {
            Some(p) => p,
            None => return undo_data,
        };

        match cmd {
            Command::CreateSection { .. } => {
                // Get the ID of the just-created section (it's the last one)
                if let Some(section) = project.sections.last() {
                    UndoData::InverseCommand(Command::DeleteSection {
                        section_id: section.id,
                    })
                } else {
                    undo_data
                }
            }

            Command::CreateShot { section_id, .. } => {
                // Get the ID of the just-created shot
                if let Some(section) = project.get_section(*section_id) {
                    if let Some(shot) = section.shots.last() {
                        UndoData::InverseCommand(Command::DeleteShot {
                            section_id: *section_id,
                            shot_id: shot.id,
                        })
                    } else {
                        undo_data
                    }
                } else {
                    undo_data
                }
            }

            _ => undo_data,
        }
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

    fn move_section(&self, section_id: SectionId, offset: Coordinates) -> CommandResult {
        let mut proj_guard = match self.project.lock() {
            Ok(g) => g,
            Err(_) => return CommandResult::failure("Failed to lock project".to_string()),
        };

        let project = match proj_guard.as_mut() {
            Some(p) => p,
            None => return CommandResult::failure("No project open".to_string()),
        };

        // Apply offset to section's placement
        if let Some(_section) = project.sections.iter_mut().find(|s| s.id == section_id) {
            // Store offset in section metadata (we'll use this during coordinate calculation)
            // For now, we just acknowledge the command was received
            // The actual offset application would require extending the Section model
            tracing::info!(?section_id, ?offset, "Section move requested");
            CommandResult::success()
        } else {
            CommandResult::failure("Section not found".to_string())
        }
    }

    fn move_station(&self, station_ref: StationRef, new_position: Coordinates) -> CommandResult {
        let mut proj_guard = match self.project.lock() {
            Ok(g) => g,
            Err(_) => return CommandResult::failure("Failed to lock project".to_string()),
        };

        let project = match proj_guard.as_mut() {
            Some(p) => p,
            None => return CommandResult::failure("No project open".to_string()),
        };

        // Find the section containing this station
        let section = project
            .sections
            .iter_mut()
            .find(|s| s.id == station_ref.section_id);

        let section = match section {
            Some(s) => s,
            None => return CommandResult::failure("Section not found".to_string()),
        };

        // Validate station index
        if station_ref.station_index > section.shots.len() as u32 {
            return CommandResult::failure("Invalid station index".to_string());
        }

        // Moving a station requires updating adjacent shots
        // For station N:
        // - Update shot N-1 (if exists) to point to new position
        // - Update shot N (if exists) to start from new position

        // For now, log the request - full implementation requires coordinate recalculation
        tracing::info!(?station_ref, ?new_position, "Station move requested");
        CommandResult::success()
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

    // === Undo/Redo operations ===

    /// Perform undo - restore previous state based on undo data
    pub fn undo(&self) -> CommandResult {
        // Pop from undo stack
        let entry = {
            let mut stack = match self.undo_stack.lock() {
                Ok(s) => s,
                Err(_) => return CommandResult::failure("Failed to lock undo stack".to_string()),
            };

            match stack.pop_undo() {
                Some(e) => e,
                None => return CommandResult::failure("Nothing to undo".to_string()),
            }
        };

        // Apply undo based on undo_data type
        let result = match &entry.undo_data {
            UndoData::InverseCommand(inverse_cmd) => {
                // Execute the inverse command (without pushing to undo stack)
                self.execute_without_undo(inverse_cmd.clone())
            }

            UndoData::PreviousValues {
                section_id,
                shot_id,
                values_json,
            } => {
                // Restore previous values
                if let Some(shot_id) = shot_id {
                    // Restore shot values
                    if let Ok(prev_updates) = serde_json::from_str::<ShotUpdates>(values_json) {
                        self.update_shot(*section_id, *shot_id, prev_updates)
                    } else {
                        CommandResult::failure("Failed to parse undo data".to_string())
                    }
                } else {
                    // Restore section values
                    if let Ok(prev_updates) = serde_json::from_str::<SectionUpdates>(values_json) {
                        self.update_section(*section_id, prev_updates)
                    } else {
                        CommandResult::failure("Failed to parse undo data".to_string())
                    }
                }
            }

            UndoData::SectionSnapshot {
                section_id,
                section_data,
            } => {
                // Restore deleted section
                self.restore_section(*section_id, section_data.clone())
            }

            UndoData::ShotSnapshot {
                section_id,
                shot_id: _,
                shot_data,
                position,
            } => {
                // Restore deleted shot at its original position
                self.restore_shot(*section_id, shot_data.clone(), *position)
            }

            UndoData::MergeInfo {
                station_a,
                station_b,
                ..
            } => {
                // Unmerge the stations
                let mut proj_guard = match self.project.lock() {
                    Ok(g) => g,
                    Err(_) => return CommandResult::failure("Failed to lock project".to_string()),
                };

                let project = match proj_guard.as_mut() {
                    Some(p) => p,
                    None => return CommandResult::failure("No project open".to_string()),
                };

                project.unmerge_stations(*station_a, *station_b);
                CommandResult::success()
            }

            UndoData::ZeroDatumInfo {
                station_ref,
                previous_gps,
            } => {
                // Restore previous datum state
                if let Some(gps) = previous_gps {
                    self.set_zero_datum(*station_ref, *gps)
                } else {
                    self.remove_zero_datum(*station_ref)
                }
            }

            UndoData::ProjectSnapshot(json) => {
                // Restore entire project
                if let Ok(project) = serde_json::from_str::<Project>(json) {
                    if let Ok(mut proj) = self.project.lock() {
                        *proj = Some(project);
                        CommandResult::success()
                    } else {
                        CommandResult::failure("Failed to lock project".to_string())
                    }
                } else {
                    CommandResult::failure("Failed to parse project snapshot".to_string())
                }
            }

            UndoData::None => {
                CommandResult::failure("This command cannot be undone".to_string())
            }
        };

        // Push to redo stack if successful
        if result.success {
            if let Ok(mut stack) = self.undo_stack.lock() {
                stack.push_redo(entry);
            }
            tracing::info!("Undo performed");
        }

        result
    }

    /// Perform redo - re-execute the command
    pub fn redo(&self) -> CommandResult {
        // Pop from redo stack
        let entry = {
            let mut stack = match self.undo_stack.lock() {
                Ok(s) => s,
                Err(_) => return CommandResult::failure("Failed to lock undo stack".to_string()),
            };

            match stack.pop_redo() {
                Some(e) => e,
                None => return CommandResult::failure("Nothing to redo".to_string()),
            }
        };

        // Re-execute the original command
        let result = self.execute_without_undo(entry.command.clone());

        // Push back to undo stack if successful
        if result.success {
            // Re-generate undo data for the command
            let undo_data = self.generate_undo_data(&entry.command);
            let final_undo_data = self.finalize_undo_data(&entry.command, undo_data);

            if let Ok(mut stack) = self.undo_stack.lock() {
                stack.push_undo(UndoEntry {
                    command: entry.command,
                    undo_data: final_undo_data,
                });
            }
            tracing::info!("Redo performed");
        }

        result
    }

    /// Execute a command without pushing to undo stack (used for undo operations)
    fn execute_without_undo(&self, cmd: Command) -> CommandResult {
        match &cmd {
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
            _ => CommandResult::failure("Command cannot be executed in undo context".to_string()),
        }
    }

    /// Restore a deleted section with its original ID
    fn restore_section(&self, original_id: SectionId, data: SectionData) -> CommandResult {
        let mut proj_guard = match self.project.lock() {
            Ok(g) => g,
            Err(_) => return CommandResult::failure("Failed to lock project".to_string()),
        };

        let project = match proj_guard.as_mut() {
            Some(p) => p,
            None => return CommandResult::failure("No project open".to_string()),
        };

        // Create section with original ID
        let section = Section::new_with_id(original_id, data);
        project.sections.push(section);
        project.touch();

        // Update next_section_id if needed
        if original_id >= project.next_section_id {
            project.next_section_id = original_id + 1;
        }

        tracing::info!(section_id = original_id, "Section restored");
        CommandResult::success()
    }

    /// Restore a deleted shot at its original position
    fn restore_shot(
        &self,
        section_id: SectionId,
        data: ShotData,
        position: usize,
    ) -> CommandResult {
        let mut proj_guard = match self.project.lock() {
            Ok(g) => g,
            Err(_) => return CommandResult::failure("Failed to lock project".to_string()),
        };

        let project = match proj_guard.as_mut() {
            Some(p) => p,
            None => return CommandResult::failure("No project open".to_string()),
        };

        let section = match project.get_section_mut(section_id) {
            Some(s) => s,
            None => return CommandResult::failure(format!("Section {} not found", section_id)),
        };

        // Create shot and insert at original position
        let shot = Shot::new(section.next_shot_id, data);
        section.next_shot_id += 1;

        if position <= section.shots.len() {
            section.shots.insert(position, shot);
        } else {
            section.shots.push(shot);
        }

        project.touch();

        tracing::info!(section_id, position, "Shot restored");
        CommandResult::success()
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
}
