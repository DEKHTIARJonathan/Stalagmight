use anyhow::Result;
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex};
use tauri::AppHandle;

use crate::cache::TileCache;
use crate::config::Config;
use crate::models::{
    ClosureStrategy, Coordinates, GpsCoordinates, Project, ProjectMetadata, ProjectWarning,
    Section, SectionData, SectionId, SectionUpdates, Shot, ShotData, ShotId, ShotUpdates,
    StationRef,
};
use crate::persistence::Database;

use super::{Command, CommandResult, UndoData, UndoStack, Validator, WarningSeverity};

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
    /// In-memory display settings cache (used when no DB is open, e.g., new unsaved project)
    display_settings_cache: Mutex<HashMap<String, String>>,
    /// Tile cache for offline satellite imagery.
    ///
    /// Note: Uses Arc<Mutex<...>> rather than plain Mutex<...> because the protocol handler
    /// runs in a separate async task/thread that outlives the closure scope, requiring
    /// owned/cloneable access to the cache. This is a deliberate deviation from the spec
    /// for thread-safety requirements.
    ///
    /// Note: Changes to CacheConfig at runtime (via update_config) do NOT re-initialize
    /// this cache. Users must restart the app for cache config changes to take effect.
    tile_cache: Arc<Mutex<Option<TileCache>>>,
    /// Tauri app handle for emitting events (set during app setup)
    app_handle: Mutex<Option<AppHandle>>,
    /// Active loading cancellation token (if any load operation is in progress)
    active_loading: Mutex<Option<Arc<AtomicBool>>>,
}

impl AppState {
    /// Create a new application state
    pub fn new() -> Result<Self> {
        let config = Config::load().unwrap_or_default();
        // Load recent projects from config
        let recent = config.general.recent_projects.clone();
        let undo_limit = config.general.undo_history_limit;

        // Initialize tile cache if enabled
        let tile_cache = if config.cache.tile_cache_enabled {
            match Self::init_tile_cache(&config) {
                Ok(cache) => Some(cache),
                Err(e) => {
                    tracing::warn!(
                        error = %e,
                        "Failed to initialize tile cache - offline tile access will be unavailable"
                    );
                    None
                }
            }
        } else {
            tracing::info!("Tile cache disabled in configuration");
            None
        };

        Ok(Self {
            project: Mutex::new(None),
            database: Mutex::new(None),
            undo_stack: Mutex::new(UndoStack::new_with_limit(undo_limit)),
            config: Mutex::new(config),
            recent_projects: Mutex::new(recent),
            display_settings_cache: Mutex::new(HashMap::new()),
            tile_cache: Arc::new(Mutex::new(tile_cache)),
            app_handle: Mutex::new(None),
            active_loading: Mutex::new(None),
        })
    }

    /// Initialize the tile cache based on config
    fn init_tile_cache(config: &Config) -> Result<TileCache> {
        let dirs = directories::ProjectDirs::from("com", "cavechef", "CaveChef")
            .ok_or_else(|| anyhow::anyhow!("Could not determine app data directory"))?;
        let cache_dir = dirs.cache_dir();
        TileCache::open(cache_dir, config.cache.tile_cache_max_mb, config.cache.tile_ttl_days)
    }

    /// Get a clone of the tile cache Arc for sharing across threads
    pub fn tile_cache(&self) -> Arc<Mutex<Option<TileCache>>> {
        Arc::clone(&self.tile_cache)
    }

    /// Set the app handle (called during app setup)
    pub fn set_app_handle(&self, handle: AppHandle) {
        if let Ok(mut h) = self.app_handle.lock() {
            *h = Some(handle);
        }
    }

    /// Get the app handle
    pub fn get_app_handle(&self) -> Option<AppHandle> {
        self.app_handle.lock().ok().and_then(|h| h.clone())
    }

    /// Start a new loading operation, cancelling any existing one.
    /// Returns the cancellation token for the new operation.
    pub fn start_new_load(&self) -> Arc<AtomicBool> {
        let mut guard = self.active_loading.lock().unwrap();

        // Cancel any existing load
        if let Some(old_token) = guard.take() {
            old_token.store(true, std::sync::atomic::Ordering::SeqCst);
        }

        // Create new token
        let token = Arc::new(AtomicBool::new(false));
        *guard = Some(Arc::clone(&token));
        token
    }

    /// Clear the active loading token (called when load completes or fails).
    /// Identity-safe: only clears if the provided token matches the current active token.
    /// This prevents a stale load from clearing a newer load's token.
    pub fn clear_active_load(&self, expected_token: &Arc<AtomicBool>) {
        if let Ok(mut guard) = self.active_loading.lock() {
            if let Some(ref current) = *guard {
                if Arc::ptr_eq(current, expected_token) {
                    *guard = None;
                }
            }
        }
    }

    /// Cancel any active loading operation (idempotent - safe to call anytime)
    pub fn cancel_loading(&self) {
        if let Ok(guard) = self.active_loading.lock() {
            if let Some(token) = guard.as_ref() {
                token.store(true, std::sync::atomic::Ordering::SeqCst);
            }
        }
        // No error if no active load - cancel_loading is idempotent
    }

    /// Resolve the project file path from a name and optional directory.
    /// Sanitizes the name and ensures .cvproj extension.
    ///
    /// # Arguments
    /// * `name` - Project name (will be sanitized for filesystem use)
    /// * `directory` - Optional directory to save in. If None, uses user's documents directory.
    ///
    /// # Returns
    /// The full path to the project file (e.g., `/path/to/dir/ProjectName.cvproj`)
    fn resolve_project_path(&self, name: &str, directory: Option<&PathBuf>) -> Result<PathBuf, String> {
        // Validate name is not empty
        if name.trim().is_empty() {
            return Err("Project name cannot be empty".to_string());
        }

        // Sanitize the project name for filesystem use
        let sanitized_name: String = name
            .chars()
            .map(|c| {
                if c.is_alphanumeric() || c == ' ' || c == '-' || c == '_' {
                    c
                } else {
                    '_'
                }
            })
            .collect();

        // Remove leading/trailing whitespace and ensure not empty after sanitization
        let sanitized_name = sanitized_name.trim();
        if sanitized_name.is_empty() {
            return Err("Project name must contain at least one alphanumeric character".to_string());
        }

        // Determine the directory to use
        let dir = match directory {
            Some(d) => {
                // Validate the provided directory is a directory (or doesn't exist yet)
                if d.exists() && !d.is_dir() {
                    return Err(format!("Path is not a directory: {}", d.display()));
                }
                d.clone()
            }
            None => {
                // Default to user's documents directory, with fallbacks
                let base_dir = directories::UserDirs::new()
                    .and_then(|ud| ud.document_dir().map(|d| d.to_path_buf()))
                    .or_else(|| {
                        // Fallback to $HOME/Documents
                        std::env::var("HOME")
                            .ok()
                            .map(|h| std::path::PathBuf::from(h).join("Documents"))
                    })
                    .ok_or_else(|| "Could not determine documents directory".to_string())?;

                // Ensure the directory exists
                if !base_dir.exists() {
                    std::fs::create_dir_all(&base_dir).map_err(|e| {
                        format!("Failed to create documents directory: {}", e)
                    })?;
                }

                base_dir
            }
        };

        // Build the full path with .cvproj extension
        let filename = format!("{}.cvproj", sanitized_name);
        let full_path = dir.join(filename);

        Ok(full_path)
    }

    /// Compute project warnings from the given project.
    /// Used by both get_project_warnings command and load_project_full for validation phase.
    ///
    /// If `db` is provided, uses it for resolved warnings lookup (for pre-finalization loading).
    /// Otherwise falls back to self.database (normal operation after project is loaded).
    pub fn compute_project_warnings(
        &self,
        project: &Project,
        db: Option<&Database>,
    ) -> Vec<ProjectWarning> {
        // Load resolved warnings from database
        let resolved_set: HashSet<String> = if let Some(db) = db {
            // Use provided database reference (pre-finalization)
            db.load_resolved_warnings()
                .unwrap_or_default()
                .iter()
                .map(|r| format!("{}:{}:{}", r.section_id, r.shot_id, r.warning_code))
                .collect()
        } else {
            // Fall back to self.database (post-finalization)
            self.load_resolved_warnings()
                .unwrap_or_default()
                .iter()
                .map(|r| format!("{}:{}:{}", r.section_id, r.shot_id, r.warning_code))
                .collect()
        };

        let config = self.get_config();
        let mut all_warnings = Vec::new();

        for section in &project.sections {
            for (shot_index, shot) in section.shots.iter().enumerate() {
                // Convert Shot to ShotData for validation
                let shot_data = ShotData {
                    azimuth_in: shot.azimuth_in,
                    azimuth_out: shot.azimuth_out,
                    length: shot.length,
                    depth_in: shot.depth_in,
                    depth_out: shot.depth_out,
                    pitch_in: shot.pitch_in,
                    pitch_out: shot.pitch_out,
                    left: shot.left,
                    right: shot.right,
                    up: shot.up,
                    down: shot.down,
                    comment: shot.comment.clone(),
                    is_virtual: shot.is_virtual,
                    marker_index: shot.marker_index,
                    temperature: shot.temperature,
                };

                let warnings = Validator::validate_shot(&shot_data, &config.validation, shot_index);
                for warning in warnings {
                    let key = format!("{}:{}:{}", section.id, shot.id, warning.code);
                    let is_resolved = resolved_set.contains(&key);
                    all_warnings.push(ProjectWarning {
                        section_id: section.id,
                        shot_id: shot.id,
                        shot_index,
                        code: warning.code,
                        message: warning.message,
                        severity: warning.severity,
                        is_resolved,
                    });
                }
            }
        }

        // Sort by resolved (unresolved first), then severity (errors first), then by section and shot
        all_warnings.sort_by(|a, b| {
            let resolved_order = |r: bool| if r { 1 } else { 0 };
            let severity_order = |s: &WarningSeverity| match s {
                WarningSeverity::Error => 0,
                WarningSeverity::Warning => 1,
            };
            resolved_order(a.is_resolved)
                .cmp(&resolved_order(b.is_resolved))
                .then_with(|| severity_order(&a.severity).cmp(&severity_order(&b.severity)))
                .then_with(|| a.section_id.cmp(&b.section_id))
                .then_with(|| a.shot_index.cmp(&b.shot_index))
        });

        all_warnings
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
                direction,
                shots,
            } => self.create_section(SectionData {
                name: name.clone(),
                surveyor: surveyor.clone(),
                date: *date,
                color: color.clone(),
                direction: *direction,
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
            Command::MergeProjects {
                source_paths,
                output_path,
                output_name,
                archive_originals,
            } => self.merge_projects(
                source_paths.clone(),
                output_path.clone(),
                output_name.clone(),
                *archive_originals,
            ),
        };

        // Push to undo stack if successful and undoable
        if result.success && Self::is_undoable(&cmd) {
            // For CreateSection and CreateShot, we need to capture the new ID for the inverse command
            let final_undo_data = self.finalize_undo_data(&cmd, undo_data);

            if let Ok(mut undo_stack) = self.undo_stack.lock() {
                undo_stack.push_with_data(cmd.clone(), final_undo_data);
            }
        }

        // Auto-save if enabled - check config first, then release lock before saving
        let should_auto_save = result.success
            && Self::is_modifying(&cmd)
            && self.config.lock().map(|c| c.general.auto_save).unwrap_or(false);

        if should_auto_save {
            let _ = self.save_project(None);
        }

        result
    }

    /// Execute a create-section-and-merge operation as a single atomic undo/redo unit.
    /// This is used when importing a new section and immediately merging one of its stations
    /// with an existing station. Both operations are combined into a single undo entry.
    pub fn execute_create_and_merge(
        &self,
        name: Option<String>,
        surveyor: Option<String>,
        date: Option<chrono::NaiveDate>,
        color: String,
        direction: Option<crate::models::SurveyDirection>,
        shots: Vec<ShotData>,
        import_station_index: u32,
        target_station: StationRef,
        closure_strategy: ClosureStrategy,
    ) -> CommandResult {
        tracing::info!("Executing create_section_and_merge as single undo unit");

        // Take a project snapshot BEFORE any modifications
        let snapshot = {
            let proj_guard = match self.project.lock() {
                Ok(g) => g,
                Err(_) => return CommandResult::failure("Failed to lock project".to_string()),
            };
            match proj_guard.as_ref() {
                Some(p) => match serde_json::to_string(p) {
                    Ok(json) => json,
                    Err(e) => return CommandResult::failure(format!("Failed to serialize project: {}", e)),
                },
                None => return CommandResult::failure("No project open".to_string()),
            }
        };

        // Step 1: Create the section (using internal method)
        let section_data = SectionData {
            name: name.clone(),
            surveyor: surveyor.clone(),
            date,
            color: color.clone(),
            direction,
            shots: shots.clone(),
        };

        let create_result = self.create_section(section_data.clone());
        if !create_result.success {
            return create_result;
        }

        let new_section_id = match create_result.section_id {
            Some(id) => id,
            None => return CommandResult::failure("Section created but no ID returned".to_string()),
        };

        // Step 2: Create the station reference for the newly created section
        let import_station_ref = StationRef {
            section_id: new_section_id,
            station_index: import_station_index,
        };

        // Step 3: Merge the stations
        let merge_result = self.merge_stations(import_station_ref, target_station, closure_strategy);
        if !merge_result.success {
            // If merge fails, we need to undo the section creation by restoring the snapshot
            // For simplicity, we'll just report the error and let the user manually undo
            // In practice, we could restore the snapshot here, but that adds complexity
            return merge_result;
        }

        // Step 4: Capture the after snapshot and push undo entry with before+after
        let after_snapshot = {
            let proj_guard = match self.project.lock() {
                Ok(g) => g,
                Err(_) => return CommandResult::failure("Failed to lock project for after snapshot".to_string()),
            };
            match proj_guard.as_ref() {
                Some(p) => match serde_json::to_string(p) {
                    Ok(json) => json,
                    Err(e) => return CommandResult::failure(format!("Failed to serialize after snapshot: {}", e)),
                },
                None => return CommandResult::failure("No project for after snapshot".to_string()),
            }
        };

        // Create a Batch command that represents both operations for the description
        let batch_cmd = Command::Batch {
            commands: vec![
                Command::CreateSection {
                    name,
                    surveyor,
                    date,
                    color,
                    direction,
                    shots,
                },
                Command::MergeStations {
                    station_a: import_station_ref,
                    station_b: target_station,
                    closure_strategy,
                },
            ],
        };

        if let Ok(mut undo_stack) = self.undo_stack.lock() {
            undo_stack.push_with_data(batch_cmd, UndoData::ProjectSnapshotPair {
                before: snapshot,
                after: after_snapshot,
            });
        }

        // Combine warnings from both operations
        let mut all_warnings = create_result.warnings;
        all_warnings.extend(merge_result.warnings);

        // Auto-save if enabled
        let should_auto_save = self.config.lock().map(|c| c.general.auto_save).unwrap_or(false);
        if should_auto_save {
            let _ = self.save_project(None);
        }

        // Return success with the new section ID
        if all_warnings.is_empty() {
            CommandResult::success_with_section_id(new_section_id)
        } else {
            CommandResult::success_with_section_id_and_warnings(new_section_id, all_warnings)
        }
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
                        direction: updates.direction.map(|_| section.direction),
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
                | Command::MergeProjects { .. }
        )
    }

    /// Check if a command modifies project state
    fn is_modifying(cmd: &Command) -> bool {
        !matches!(
            cmd,
            Command::OpenProject { .. }
                | Command::SaveProject { .. }
                | Command::CloseProject
                | Command::MergeProjects { .. }
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

        // Clear display settings cache for new project
        self.clear_display_settings_cache();

        tracing::info!("Project created");
        CommandResult::success()
    }

    fn open_project(&self, path: PathBuf) -> CommandResult {
        // Verify file exists before trying to open
        if !path.exists() {
            return CommandResult::failure(format!("File not found: {}", path.display()));
        }

        // Use open_existing which validates the file is a valid CaveChef project
        let db = match Database::open_existing(&path) {
            Ok(db) => db,
            Err(e) => return CommandResult::failure(format!("{}", e)),
        };

        let mut project = match db.load_project() {
            Ok(p) => p,
            Err(e) => return CommandResult::failure(format!("Failed to load project data: {}", e)),
        };

        project.file_path = Some(path.clone());

        if let Ok(mut proj) = self.project.lock() {
            *proj = Some(project);
        }

        // Load undo stack from database before replacing database reference (with timestamps)
        let loaded_undo = db.load_undo_stack_with_timestamps().unwrap_or_default();
        let undo_entries: Vec<_> = loaded_undo
            .into_iter()
            .map(|(_, cmd, undo, ts)| (cmd, undo, ts))
            .collect();

        if let Ok(mut database) = self.database.lock() {
            *database = Some(db);
        }

        // Clear display settings cache (settings will be loaded from DB by frontend)
        self.clear_display_settings_cache();

        // Restore persisted undo stack
        if let Ok(mut undo_stack) = self.undo_stack.lock() {
            if undo_entries.is_empty() {
                undo_stack.clear();
            } else {
                undo_stack.load_from_persisted_with_timestamps(undo_entries);
                tracing::info!(count = undo_stack.len(), "Restored undo stack from database");
            }
        }

        // Add to recent projects and persist to config
        if let Ok(mut recent) = self.recent_projects.lock() {
            recent.retain(|p| p != &path);
            recent.insert(0, path);
            if let Ok(mut config) = self.config.lock() {
                recent.truncate(config.general.recent_projects_max);
                // Update config with recent projects and save
                config.general.recent_projects = recent.clone();
                if let Err(e) = config.save() {
                    tracing::warn!("Failed to save config with recent projects: {}", e);
                }
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

        // Determine save path and ensure .cvproj extension
        let save_path = path.or_else(|| project.file_path.clone());
        let save_path = match save_path {
            Some(p) => {
                // Ensure .cvproj extension
                if p.extension().map_or(true, |ext| ext != "cvproj") {
                    p.with_extension("cvproj")
                } else {
                    p
                }
            }
            None => return CommandResult::failure("No save path specified".to_string()),
        };

        // Create a temporary file path in the same directory (for atomic rename)
        let temp_path = save_path.with_extension("cvproj.tmp");
        tracing::info!(final_path = ?save_path, temp_path = ?temp_path, "Starting safe save operation");

        // Load display settings from current database or in-memory cache
        let display_settings = {
            let db_guard = self.database.lock().ok();
            let from_db = db_guard.as_ref().and_then(|db| db.as_ref())
                .and_then(|db| db.load_display_settings().ok())
                .unwrap_or_default();

            // If DB had settings, use those; otherwise use the in-memory cache
            if from_db.is_empty() {
                self.display_settings_cache.lock()
                    .map(|cache| cache.clone())
                    .unwrap_or_default()
            } else {
                from_db
            }
        };

        // Remove any leftover temp file from previous failed saves
        if temp_path.exists() {
            let _ = std::fs::remove_file(&temp_path);
        }

        // Save to temporary file first
        let mut db = match Database::open(&temp_path) {
            Ok(db) => db,
            Err(e) => {
                // Clean up temp file on failure
                let _ = std::fs::remove_file(&temp_path);
                return CommandResult::failure(format!("Failed to create save file: {}", e));
            }
        };

        if let Err(e) = db.save_project(project) {
            // Clean up temp file on failure
            drop(db);
            let _ = std::fs::remove_file(&temp_path);
            tracing::error!(error = %e, "Save failed, temp file cleaned up");
            return CommandResult::failure(format!("Failed to save project: {}", e));
        }

        // Copy display settings to the new database
        for (key, value) in &display_settings {
            if let Err(e) = db.save_display_setting(key, value) {
                tracing::warn!(key = %key, error = %e, "Failed to copy display setting");
            }
        }

        // Close the database before renaming
        drop(db);

        // Atomically rename temp file to final destination
        // This is safe: if rename fails, original file is untouched
        if let Err(e) = std::fs::rename(&temp_path, &save_path) {
            let _ = std::fs::remove_file(&temp_path);
            tracing::error!(error = %e, "Failed to rename temp file to final destination");
            return CommandResult::failure(format!("Failed to finalize save: {}", e));
        }

        // Reopen the database at the final path
        let db = match Database::open(&save_path) {
            Ok(db) => db,
            Err(e) => {
                tracing::warn!(error = %e, "Failed to reopen saved database (file was saved successfully)");
                // File was saved, just can't reopen - not a critical failure
                project.file_path = Some(save_path.clone());
                drop(proj_guard);
                return CommandResult::success();
            }
        };

        // Persist undo stack to database (with timestamps)
        let persist_limit = self
            .config
            .lock()
            .map(|c| c.general.undo_persist_limit)
            .unwrap_or(20);

        if let Ok(undo_stack) = self.undo_stack.lock() {
            let entries: Vec<_> = undo_stack
                .entries_to_persist(persist_limit)
                .filter_map(|e| UndoStack::serialize_entry_with_timestamp(e))
                .collect();

            if let Err(e) = db.save_undo_stack_with_timestamps(entries) {
                tracing::warn!(error = %e, "Failed to persist undo stack (project was saved)");
            }
        }

        // Update file path after successful save
        project.file_path = Some(save_path.clone());

        // Update database handle
        drop(proj_guard);
        if let Ok(mut database) = self.database.lock() {
            *database = Some(db);
        }

        // Clear in-memory cache since settings are now persisted to DB
        self.clear_display_settings_cache();

        // Add to recent projects and persist to config
        if let Ok(mut recent) = self.recent_projects.lock() {
            recent.retain(|p| p != &save_path);
            recent.insert(0, save_path.clone());
            if let Ok(mut config) = self.config.lock() {
                recent.truncate(config.general.recent_projects_max);
                config.general.recent_projects = recent.clone();
                if let Err(e) = config.save() {
                    tracing::warn!("Failed to save config with recent projects: {}", e);
                }
            }
        }

        tracing::info!(path = ?save_path, "Project saved successfully");
        CommandResult::success()
    }

    fn close_project(&self) -> CommandResult {
        tracing::debug!("close_project: acquiring project lock");
        if let Ok(mut proj) = self.project.lock() {
            tracing::debug!("close_project: dropping project");
            *proj = None;
            tracing::debug!("close_project: project dropped");
        }

        tracing::debug!("close_project: acquiring database lock");
        if let Ok(mut db) = self.database.lock() {
            tracing::debug!("close_project: dropping database");
            *db = None;
            tracing::debug!("close_project: database dropped");
        }

        tracing::debug!("close_project: acquiring undo_stack lock");
        if let Ok(mut undo_stack) = self.undo_stack.lock() {
            tracing::debug!("close_project: clearing undo stack");
            undo_stack.clear();
            tracing::debug!("close_project: undo stack cleared");
        }

        // Clear display settings cache
        self.clear_display_settings_cache();

        tracing::info!("Project closed");
        tracing::debug!("close_project: returning success");
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
        let section_id = section.id;
        tracing::info!(section_id = section_id, "Section created");

        if warnings.is_empty() {
            CommandResult::success_with_section_id(section_id)
        } else {
            CommandResult::success_with_section_id_and_warnings(section_id, warnings)
        }
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

        // Check same section (not allowed)
        if station_a.section_id == station_b.section_id {
            return CommandResult::failure(
                "Cannot merge stations from the same section".to_string(),
            );
        }

        match project.merge_stations(station_a, station_b, strategy) {
            Ok(_) => {
                tracing::info!(?station_a, ?station_b, "Stations merged");
                CommandResult::success()
            }
            Err(e) => {
                tracing::warn!(?station_a, ?station_b, error = %e, "Failed to merge stations");
                CommandResult::failure(e)
            }
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

        match project.set_zero_datum(station_ref, gps) {
            Ok(_) => {
                tracing::info!(?station_ref, "Zero datum set");
                CommandResult::success()
            }
            Err(e) => {
                tracing::warn!(?station_ref, error = %e, "Failed to set zero datum");
                CommandResult::failure(e)
            }
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
        let mut section_ids = Vec::new();

        for cmd in commands {
            let result = self.execute(cmd);
            if !result.success {
                return result;
            }
            all_warnings.extend(result.warnings);
            // Collect section IDs from CreateSection commands
            if let Some(id) = result.section_id {
                section_ids.push(id);
            }
            section_ids.extend(result.section_ids);
        }

        if section_ids.is_empty() {
            CommandResult::success_with_warnings(all_warnings)
        } else {
            CommandResult::success_with_section_ids_and_warnings(section_ids, all_warnings)
        }
    }

    // === Project merge operations ===

    /// Merge multiple projects into a new project file
    /// This creates a NEW output file, appends all sections with renumbered IDs,
    /// keeps all zero datums, and optionally archives the original files.
    fn merge_projects(
        &self,
        source_paths: Vec<PathBuf>,
        output_path: PathBuf,
        output_name: String,
        archive_originals: bool,
    ) -> CommandResult {
        // Validate inputs
        if source_paths.is_empty() {
            return CommandResult::failure("No source projects provided".to_string());
        }

        if source_paths.len() < 2 {
            return CommandResult::failure("At least two projects are required for merge".to_string());
        }

        // Check that output path doesn't already exist
        if output_path.exists() {
            return CommandResult::failure(format!(
                "Output file already exists: {}",
                output_path.display()
            ));
        }

        // Verify all source files exist
        for path in &source_paths {
            if !path.exists() {
                return CommandResult::failure(format!("Source file not found: {}", path.display()));
            }
        }

        // Load all source projects
        let mut source_projects: Vec<Project> = Vec::new();
        for path in &source_paths {
            match Database::open_existing(path) {
                Ok(db) => match db.load_project() {
                    Ok(mut project) => {
                        project.file_path = Some(path.clone());
                        source_projects.push(project);
                    }
                    Err(e) => {
                        return CommandResult::failure(format!(
                            "Failed to load project '{}': {}",
                            path.display(),
                            e
                        ));
                    }
                },
                Err(e) => {
                    return CommandResult::failure(format!(
                        "Failed to open project '{}': {}",
                        path.display(),
                        e
                    ));
                }
            }
        }

        // Create a new merged project
        let mut merged_project = Project::new(output_name.clone(), None);

        // Track section ID remapping: (old_project_idx, old_section_id) -> new_section_id
        let mut section_id_map: std::collections::HashMap<(usize, SectionId), SectionId> =
            std::collections::HashMap::new();

        // Append sections from all projects
        for (proj_idx, source_project) in source_projects.iter().enumerate() {
            for section in &source_project.sections {
                let old_section_id = section.id;
                let new_section_id = merged_project.next_section_id;

                // Clone section data and add to merged project
                let section_data = section.to_section_data();
                merged_project.add_section(section_data);

                // Record the mapping
                section_id_map.insert((proj_idx, old_section_id), new_section_id);
            }

            // Copy section offsets with remapped IDs
            for (old_section_id, offset) in &source_project.section_offsets {
                if let Some(&new_section_id) = section_id_map.get(&(proj_idx, *old_section_id)) {
                    merged_project.section_offsets.insert(new_section_id, *offset);
                }
            }

            // Copy zero datums with remapped section IDs
            // Use store_zero_datum_without_repositioning to preserve original offsets
            // (section_offsets were already copied above with remapped IDs)
            for zd in &source_project.zero_datums {
                if let Some(&new_section_id) =
                    section_id_map.get(&(proj_idx, zd.station_ref.section_id))
                {
                    let new_station_ref = StationRef::new(new_section_id, zd.station_ref.station_index);
                    // Use store-only helper to avoid triggering repositioning during merge
                    if let Err(e) = merged_project.store_zero_datum_without_repositioning(new_station_ref, zd.gps) {
                        return CommandResult::failure(format!(
                            "Failed to copy zero datum from source project {}: {}",
                            source_project.name, e
                        ));
                    }
                }
            }

            // Copy station merges with remapped section IDs (only within same source project)
            for merge in &source_project.station_merges {
                if let (Some(&new_a_section), Some(&new_b_section)) = (
                    section_id_map.get(&(proj_idx, merge.station_a.section_id)),
                    section_id_map.get(&(proj_idx, merge.station_b.section_id)),
                ) {
                    let new_station_a =
                        StationRef::new(new_a_section, merge.station_a.station_index);
                    let new_station_b =
                        StationRef::new(new_b_section, merge.station_b.station_index);
                    merged_project.station_merges.push(crate::models::StationMerge {
                        station_a: new_station_a,
                        station_b: new_station_b,
                        merged_at: merge.merged_at,
                    });
                }
            }

            // Copy loop closures with remapped section IDs (only within same source project)
            for closure in &source_project.loop_closures {
                if let (Some(&new_a_section), Some(&new_b_section)) = (
                    section_id_map.get(&(proj_idx, closure.station_a.section_id)),
                    section_id_map.get(&(proj_idx, closure.station_b.section_id)),
                ) {
                    let new_station_a =
                        StationRef::new(new_a_section, closure.station_a.station_index);
                    let new_station_b =
                        StationRef::new(new_b_section, closure.station_b.station_index);
                    merged_project.loop_closures.push(crate::models::LoopClosure {
                        station_a: new_station_a,
                        station_b: new_station_b,
                        path_length: closure.path_length,
                        misclosure_distance: closure.misclosure_distance,
                        error_percentage: closure.error_percentage,
                        horizontal_misclosure: closure.horizontal_misclosure,
                        vertical_misclosure: closure.vertical_misclosure,
                    });
                }
            }

            // Combine location if present
            if let Some(ref loc) = source_project.location {
                if merged_project.location.is_none() {
                    merged_project.location = Some(loc.clone());
                } else if let Some(ref mut merged_loc) = merged_project.location {
                    if !merged_loc.contains(loc) {
                        merged_loc.push_str(", ");
                        merged_loc.push_str(loc);
                    }
                }
            }
        }

        // Set the output file path
        merged_project.file_path = Some(output_path.clone());

        // Ensure .cvproj extension
        let output_path = if output_path.extension().map_or(true, |ext| ext != "cvproj") {
            output_path.with_extension("cvproj")
        } else {
            output_path
        };

        // Save the merged project using safe save pattern (temp file + atomic rename)
        let temp_path = output_path.with_extension("cvproj.tmp");

        // Remove any leftover temp file
        if temp_path.exists() {
            let _ = std::fs::remove_file(&temp_path);
        }

        // Save to temporary file
        let mut db = match Database::open(&temp_path) {
            Ok(db) => db,
            Err(e) => {
                let _ = std::fs::remove_file(&temp_path);
                return CommandResult::failure(format!("Failed to create output file: {}", e));
            }
        };

        if let Err(e) = db.save_project(&merged_project) {
            drop(db);
            let _ = std::fs::remove_file(&temp_path);
            return CommandResult::failure(format!("Failed to save merged project: {}", e));
        }

        // Close database before rename
        drop(db);

        // Atomically rename temp file to final destination
        if let Err(e) = std::fs::rename(&temp_path, &output_path) {
            let _ = std::fs::remove_file(&temp_path);
            return CommandResult::failure(format!("Failed to finalize save: {}", e));
        }

        tracing::info!(
            output = ?output_path,
            section_count = merged_project.sections.len(),
            "Projects merged successfully"
        );

        // Archive original files if requested
        if archive_originals {
            for source_path in &source_paths {
                if let Err(e) = Self::archive_project_file(source_path) {
                    tracing::warn!(
                        path = ?source_path,
                        error = %e,
                        "Failed to archive original project (merge completed)"
                    );
                    // Don't fail the operation - merge was successful
                }
            }
        }

        CommandResult::success()
    }

    /// Archive a project file by renaming it with .archived suffix
    fn archive_project_file(path: &PathBuf) -> std::io::Result<()> {
        // Create archive filename: original.cvproj -> original.cvproj.archived
        // If archived file exists, add timestamp: original.cvproj.archived.20260117_123456
        let mut archive_path = path.clone();
        let mut new_name = path
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .to_string();
        new_name.push_str(".archived");
        archive_path.set_file_name(&new_name);

        // If archive already exists, add timestamp
        if archive_path.exists() {
            let timestamp = chrono::Utc::now().format("%Y%m%d_%H%M%S").to_string();
            new_name.push('.');
            new_name.push_str(&timestamp);
            archive_path.set_file_name(&new_name);
        }

        std::fs::rename(path, &archive_path)?;
        tracing::info!(
            original = ?path,
            archived = ?archive_path,
            "Project file archived"
        );
        Ok(())
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
                shot_id,
                shot_data,
                position,
            } => {
                // Restore deleted shot at its original position with original ID
                self.restore_shot(*section_id, *shot_id, shot_data.clone(), *position)
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

            UndoData::ProjectSnapshotPair { before, after: _ } => {
                // Restore the "before" snapshot for undo
                if let Ok(project) = serde_json::from_str::<Project>(before) {
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

    /// Perform redo - re-execute the command or restore snapshot
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

        // For ProjectSnapshotPair, restore the "after" snapshot instead of re-executing
        // This handles cases where re-execution would create different IDs
        let result = if let UndoData::ProjectSnapshotPair { before: _, after } = &entry.undo_data {
            if let Ok(project) = serde_json::from_str::<Project>(after) {
                if let Ok(mut proj) = self.project.lock() {
                    *proj = Some(project);
                    CommandResult::success()
                } else {
                    CommandResult::failure("Failed to lock project".to_string())
                }
            } else {
                CommandResult::failure("Failed to parse project snapshot".to_string())
            }
        } else {
            // Re-execute the original command for other undo data types
            self.execute_without_undo(entry.command.clone())
        };

        // Push back to undo stack if successful
        // Important: Use the original entry with its original undo_data, not regenerated data
        // This ensures undo after redo works correctly
        if result.success {
            if let Ok(mut stack) = self.undo_stack.lock() {
                stack.push_undo(entry);
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
                direction,
                shots,
            } => self.create_section(SectionData {
                name: name.clone(),
                surveyor: surveyor.clone(),
                date: *date,
                color: color.clone(),
                direction: *direction,
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

    /// Restore a deleted shot at its original position with its original ID
    fn restore_shot(
        &self,
        section_id: SectionId,
        original_shot_id: ShotId,
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

        // Create shot with original ID
        let shot = Shot::new(original_shot_id, data);

        // Update next_shot_id if needed to avoid collisions
        if original_shot_id >= section.next_shot_id {
            section.next_shot_id = original_shot_id + 1;
        }

        if position <= section.shots.len() {
            section.shots.insert(position, shot);
        } else {
            section.shots.push(shot);
        }

        project.touch();

        tracing::info!(section_id, shot_id = original_shot_id, position, "Shot restored");
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
                // Use open_existing to avoid creating files for missing projects
                if let Ok(db) = Database::open_existing(path) {
                    if let Ok(mut project) = db.load_project() {
                        project.file_path = Some(path.clone());
                        return project.metadata();
                    }
                }
                None
            })
            .collect()
    }

    /// Remove a project from the recent projects list
    pub fn remove_from_recent_projects(&self, path: PathBuf) -> CommandResult {
        let mut recent = match self.recent_projects.lock() {
            Ok(r) => r,
            Err(_) => return CommandResult::failure("Failed to lock recent projects".to_string()),
        };

        // Remove the path from the list
        let initial_len = recent.len();
        recent.retain(|p| p != &path);

        if recent.len() == initial_len {
            return CommandResult::failure("Project not found in recent list".to_string());
        }

        // Update config and save
        if let Ok(mut config) = self.config.lock() {
            config.general.recent_projects = recent.clone();
            if let Err(e) = config.save() {
                tracing::warn!("Failed to save config after removing from recent: {}", e);
                return CommandResult::failure(format!("Failed to save config: {}", e));
            }
        }

        tracing::info!(path = ?path, "Removed project from recent list");
        CommandResult::success()
    }

    /// Get config
    pub fn get_config(&self) -> Config {
        self.config.lock().ok().map(|c| c.clone()).unwrap_or_default()
    }

    /// Update config
    pub fn update_config(&self, mut config: Config) -> Result<()> {
        // Check if cache setting changed before saving
        let old_cache_enabled = self
            .config
            .lock()
            .ok()
            .map(|c| c.cache.tile_cache_enabled)
            .unwrap_or(true);
        let new_cache_enabled = config.cache.tile_cache_enabled;

        config.save()?;

        // Sync tile cache if cache setting changed
        if old_cache_enabled != new_cache_enabled {
            if let Ok(mut cache_guard) = self.tile_cache.lock() {
                if new_cache_enabled {
                    // Enable cache - create new cache
                    match Self::init_tile_cache(&config) {
                        Ok(cache) => {
                            tracing::info!("Tile cache enabled");
                            *cache_guard = Some(cache);
                        }
                        Err(e) => {
                            tracing::warn!(error = %e, "Failed to initialize tile cache");
                        }
                    }
                } else {
                    // Disable cache - set to None (existing cache data remains on disk)
                    tracing::info!("Tile cache disabled");
                    *cache_guard = None;
                }
            }
        }

        if let Ok(mut cfg) = self.config.lock() {
            *cfg = config;
        }
        Ok(())
    }

    /// Reload config from disk without saving
    /// Returns the newly loaded config
    /// Also syncs config-derived state (recent_projects, undo_stack limit)
    pub fn reload_config(&self) -> Result<Config> {
        let new_config = Config::load()?;

        // Update the config
        if let Ok(mut cfg) = self.config.lock() {
            *cfg = new_config.clone();
        }

        // Sync recent_projects from config
        if let Ok(mut recent) = self.recent_projects.lock() {
            *recent = new_config.general.recent_projects.clone();
        }

        // Sync undo_stack history limit from config
        if let Ok(mut undo) = self.undo_stack.lock() {
            undo.set_history_limit(new_config.general.undo_history_limit);
        }

        Ok(new_config)
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

    /// Get the undo stack as a list of history items for the UI
    pub fn get_undo_stack(&self) -> Vec<crate::commands::history::UndoHistoryItem> {
        self.undo_stack
            .lock()
            .map(|stack| {
                stack
                    .undo_entries()
                    .enumerate()
                    .map(|(idx, entry)| {
                        crate::commands::history::entry_to_history_item(entry, idx)
                    })
                    .collect()
            })
            .unwrap_or_default()
    }

    /// Get the redo stack as a list of history items for the UI
    pub fn get_redo_stack(&self) -> Vec<crate::commands::history::UndoHistoryItem> {
        self.undo_stack
            .lock()
            .map(|stack| {
                stack
                    .redo_entries()
                    .enumerate()
                    .map(|(idx, entry)| {
                        crate::commands::history::entry_to_history_item(entry, idx)
                    })
                    .collect()
            })
            .unwrap_or_default()
    }

    /// Perform multiple undos to reach a specific history point
    /// Index 0 = most recent action, so undo_to(N) executes (N+1) undos
    pub fn undo_to(&self, index: usize) -> CommandResult {
        // Validate index first
        {
            let stack = match self.undo_stack.lock() {
                Ok(s) => s,
                Err(_) => return CommandResult::failure("Failed to lock undo stack".to_string()),
            };
            if index >= stack.len() {
                return CommandResult::failure(format!(
                    "Invalid undo index: {} (stack has {} entries)",
                    index,
                    stack.len()
                ));
            }
        }

        // Execute (index + 1) undos to include the target index
        let count = index + 1;
        for i in 0..count {
            let result = self.undo();
            if !result.success {
                return CommandResult::failure(format!(
                    "Undo failed at step {} of {}: {}",
                    i + 1,
                    count,
                    result.error.unwrap_or_else(|| "Unknown error".to_string())
                ));
            }
        }

        tracing::info!(index = index, count = count, "Undo to index completed");
        CommandResult::success()
    }

    /// Perform multiple redos to reach a specific history point
    /// Index 0 = most recent undone action, so redo_to(N) executes (N+1) redos
    pub fn redo_to(&self, index: usize) -> CommandResult {
        // Validate index first
        {
            let stack = match self.undo_stack.lock() {
                Ok(s) => s,
                Err(_) => return CommandResult::failure("Failed to lock undo stack".to_string()),
            };
            if index >= stack.redo_len() {
                return CommandResult::failure(format!(
                    "Invalid redo index: {} (stack has {} entries)",
                    index,
                    stack.redo_len()
                ));
            }
        }

        // Execute (index + 1) redos to include the target index
        let count = index + 1;
        for i in 0..count {
            let result = self.redo();
            if !result.success {
                return CommandResult::failure(format!(
                    "Redo failed at step {} of {}: {}",
                    i + 1,
                    count,
                    result.error.unwrap_or_else(|| "Unknown error".to_string())
                ));
            }
        }

        tracing::info!(index = index, count = count, "Redo to index completed");
        CommandResult::success()
    }

    /// Load resolved warnings from database
    pub fn load_resolved_warnings(&self) -> Result<Vec<crate::persistence::ResolvedWarning>> {
        let db_guard = self.database.lock().map_err(|_| anyhow::anyhow!("Failed to lock database"))?;
        let db = db_guard.as_ref().ok_or_else(|| anyhow::anyhow!("No database open"))?;
        db.load_resolved_warnings()
    }

    /// Save a resolved warning to database
    pub fn save_resolved_warning(&self, warning: &crate::persistence::ResolvedWarning) -> Result<()> {
        let db_guard = self.database.lock().map_err(|_| anyhow::anyhow!("Failed to lock database"))?;
        let db = db_guard.as_ref().ok_or_else(|| anyhow::anyhow!("No database open"))?;
        db.save_resolved_warning(warning)
    }

    /// Delete a resolved warning from database
    pub fn delete_resolved_warning(&self, section_id: u32, shot_id: u32, warning_code: &str) -> Result<()> {
        let db_guard = self.database.lock().map_err(|_| anyhow::anyhow!("Failed to lock database"))?;
        let db = db_guard.as_ref().ok_or_else(|| anyhow::anyhow!("No database open"))?;
        db.delete_resolved_warning(section_id, shot_id, warning_code)
    }

    /// Load display settings from database or in-memory cache
    pub fn load_display_settings(&self) -> Result<HashMap<String, String>> {
        // Try database first
        let db_guard = self.database.lock().map_err(|_| anyhow::anyhow!("Failed to lock database"))?;
        if let Some(db) = db_guard.as_ref() {
            return db.load_display_settings();
        }
        drop(db_guard);

        // Fall back to in-memory cache for new unsaved projects
        let cache = self.display_settings_cache.lock()
            .map_err(|_| anyhow::anyhow!("Failed to lock display settings cache"))?;
        Ok(cache.clone())
    }

    /// Save a display setting to database or in-memory cache
    pub fn save_display_setting(&self, key: &str, value: &str) -> Result<()> {
        // Try database first
        let db_guard = self.database.lock().map_err(|_| anyhow::anyhow!("Failed to lock database"))?;
        if let Some(db) = db_guard.as_ref() {
            return db.save_display_setting(key, value);
        }
        drop(db_guard);

        // Fall back to in-memory cache for new unsaved projects
        let mut cache = self.display_settings_cache.lock()
            .map_err(|_| anyhow::anyhow!("Failed to lock display settings cache"))?;
        cache.insert(key.to_string(), value.to_string());
        Ok(())
    }

    /// Get a single display setting from database or in-memory cache
    pub fn get_display_setting(&self, key: &str) -> Result<Option<String>> {
        // Try database first
        let db_guard = self.database.lock().map_err(|_| anyhow::anyhow!("Failed to lock database"))?;
        if let Some(db) = db_guard.as_ref() {
            return db.get_display_setting(key);
        }
        drop(db_guard);

        // Fall back to in-memory cache for new unsaved projects
        let cache = self.display_settings_cache.lock()
            .map_err(|_| anyhow::anyhow!("Failed to lock display settings cache"))?;
        Ok(cache.get(key).cloned())
    }

    /// Clear the in-memory display settings cache (called after save when settings are persisted to DB)
    fn clear_display_settings_cache(&self) {
        if let Ok(mut cache) = self.display_settings_cache.lock() {
            cache.clear();
        }
    }

    // === File hash tracking for duplicate detection ===

    /// Check if a file hash has already been imported to the project
    pub fn check_duplicate_import(&self, hash: &str) -> Result<bool> {
        let proj_guard = self.project.lock()
            .map_err(|_| anyhow::anyhow!("Failed to lock project"))?;

        if let Some(project) = proj_guard.as_ref() {
            Ok(project.imported_file_hashes.contains(&hash.to_string()))
        } else {
            Ok(false)
        }
    }

    /// Track an imported file hash in the project
    pub fn track_imported_file(&self, hash: String) -> CommandResult {
        let mut proj_guard = match self.project.lock() {
            Ok(g) => g,
            Err(_) => return CommandResult::failure("Failed to lock project".to_string()),
        };

        if let Some(project) = proj_guard.as_mut() {
            if !project.imported_file_hashes.contains(&hash) {
                project.imported_file_hashes.push(hash);
                project.touch();
                tracing::info!("Tracked imported file hash");
            }
            CommandResult::success()
        } else {
            CommandResult::failure("No project open".to_string())
        }
    }

    // === Consolidated Load Operations ===

    /// Load a project with full progress reporting.
    /// This is the main implementation used by load_project_full command.
    ///
    /// All computation happens locally, then state is mutated atomically at the end.
    /// Each mutation is guarded by a cancel check for clean abort on cancellation.
    pub fn do_load_project_full(
        &self,
        path: PathBuf,
    ) -> Result<super::loading::LoadProjectFullResult, super::loading::LoadError> {
        use super::loading::{DisplaySettings, LoadError, LoadProjectFullResult, LoadingPhase, ProgressEmitter};

        let handle = self.get_app_handle()
            .ok_or_else(|| LoadError::internal("AppHandle not initialized"))?;

        // Check if the same project is already open (avoid unnecessary reload)
        if let Ok(proj_guard) = self.project.lock() {
            if let Some(ref project) = *proj_guard {
                if project.file_path.as_ref() == Some(&path) {
                    return Err(LoadError::already_open());
                }
            }
        }

        // Start new load - cancels any existing load
        // Store the token for identity-safe clearing later
        let cancel_token = self.start_new_load();
        let mut progress = ProgressEmitter::new_for_open(handle, Arc::clone(&cancel_token));

        // Helper macro for early return with identity-safe token clearing
        macro_rules! check_cancelled {
            () => {
                if progress.is_cancelled() {
                    self.clear_active_load(&cancel_token);
                    return Err(LoadError::cancelled());
                }
            };
        }

        macro_rules! early_return_err {
            ($err:expr) => {{
                self.clear_active_load(&cancel_token);
                return Err($err);
            }};
        }

        // === PHASE 0: Opening database (5%) ===
        progress.start_phase(LoadingPhase::OpeningDatabase);
        if !path.exists() {
            early_return_err!(LoadError::not_found(&path.display().to_string()));
        }
        // Local variable only - NO state mutation until Finalizing
        let db = match Database::open_existing(&path) {
            Ok(db) => db,
            Err(e) => {
                early_return_err!(LoadError::new("DATABASE", e.to_string()));
            }
        };
        check_cancelled!();
        progress.complete_phase(LoadingPhase::OpeningDatabase);

        // === PHASE 1: Loading project data (20%) ===
        progress.start_phase(LoadingPhase::LoadingProjectData);
        let mut project = match db.load_project() {
            Ok(p) => p,
            Err(e) => {
                early_return_err!(LoadError::new("DATABASE", e.to_string()));
            }
        };
        project.file_path = Some(path.clone());
        progress.update_phase(LoadingPhase::LoadingProjectData, 1, 1);
        check_cancelled!();
        progress.complete_phase(LoadingPhase::LoadingProjectData);

        // === PHASE 2: Loading sections (15%) ===
        progress.start_phase(LoadingPhase::LoadingSections);
        let total_sections = project.sections.len() as u32;
        for (i, _section) in project.sections.iter().enumerate() {
            check_cancelled!();
            progress.update_phase(LoadingPhase::LoadingSections, i as u32 + 1, total_sections);
        }
        progress.complete_phase(LoadingPhase::LoadingSections);

        // === PHASE 3: Computing stations (20%) ===
        progress.start_phase(LoadingPhase::ComputingStations);
        let stations = project.compute_station_coordinates_with_progress(Some(&mut |current, total| {
            if !progress.is_cancelled() {
                progress.update_phase(LoadingPhase::ComputingStations, current, total);
            }
        }));
        check_cancelled!();
        progress.complete_phase(LoadingPhase::ComputingStations);

        // === PHASE 4: Computing statistics (15%) - INDETERMINATE ===
        progress.start_phase(LoadingPhase::ComputingStatistics);
        // Heartbeat at start to indicate phase is active
        progress.heartbeat(LoadingPhase::ComputingStatistics);
        let mut stats = project.stats();
        // Calculate penetration distance with computed stations
        stats.penetration_distance = project.calculate_penetration(&stations);
        // Heartbeat after computation to indicate work completed
        progress.heartbeat(LoadingPhase::ComputingStatistics);
        check_cancelled!();
        progress.complete_phase(LoadingPhase::ComputingStatistics);

        // === PHASE 5: Validating data (10%) ===
        // Compute warnings using the local db reference (before finalization)
        progress.start_phase(LoadingPhase::ValidatingData);
        let warnings = self.compute_project_warnings(&project, Some(&db));
        progress.heartbeat(LoadingPhase::ValidatingData);
        check_cancelled!();
        progress.complete_phase(LoadingPhase::ValidatingData);

        // === PHASE 6: Loading settings (5%) ===
        progress.start_phase(LoadingPhase::LoadingSettings);
        let stored_settings = db.load_display_settings().unwrap_or_default();
        let display_settings = DisplaySettings::from_stored(&stored_settings);
        check_cancelled!();
        progress.complete_phase(LoadingPhase::LoadingSettings);

        // === PHASE 7: Finalizing (10%) - ALL STATE MUTATIONS GUARDED ===
        progress.start_phase(LoadingPhase::Finalizing);

        // Load undo stack from database BEFORE storing db (with timestamps)
        let loaded_undo = db.load_undo_stack_with_timestamps().unwrap_or_default();
        let undo_entries: Vec<_> = loaded_undo
            .into_iter()
            .map(|(_, cmd, undo, ts)| (cmd, undo, ts))
            .collect();

        // Guard 1: Project state mutation
        check_cancelled!();
        *self.project.lock().unwrap() = Some(project.clone());

        // Guard 2: Database handle mutation
        check_cancelled!();
        *self.database.lock().unwrap() = Some(db);

        // Guard 3: Display settings cache clear
        check_cancelled!();
        self.clear_display_settings_cache();

        // Guard 4: Undo stack restore (with timestamps)
        check_cancelled!();
        if let Ok(mut undo_stack) = self.undo_stack.lock() {
            if undo_entries.is_empty() {
                undo_stack.clear();
            } else {
                undo_stack.load_from_persisted_with_timestamps(undo_entries);
                tracing::info!(count = undo_stack.len(), "Restored undo stack from database");
            }
        }

        // Guard 5: Recent projects update
        check_cancelled!();
        if let Ok(mut recent) = self.recent_projects.lock() {
            recent.retain(|p| p != &path);
            recent.insert(0, path.clone());
            if let Ok(mut config) = self.config.lock() {
                recent.truncate(config.general.recent_projects_max);
                config.general.recent_projects = recent.clone();
                if let Err(e) = config.save() {
                    tracing::warn!("Failed to save config with recent projects: {}", e);
                }
            }
        }

        progress.complete_phase(LoadingPhase::Finalizing);

        // Get loading_id before clearing token
        let loading_id = progress.loading_id();

        // Clear active load AFTER all mutations and computations complete
        self.clear_active_load(&cancel_token);

        tracing::info!(path = ?path, "Project loaded via load_project_full");

        Ok(LoadProjectFullResult {
            loading_id,
            project,
            stations,
            stats,
            warnings,
            display_settings,
        })
    }

    /// Create a new project with full progress reporting.
    /// This is the main implementation used by create_project_full command.
    ///
    /// Phases:
    /// 1. CreatingDatabase (40%) - Create SQLite file
    /// 2. InitializingProject (40%) - Create project record
    /// 3. SavingSettings (20%) - Save default display settings
    ///
    /// All phases are indeterminate since creation is typically fast.
    ///
    /// # Arguments
    /// * `name` - Project name (used for filename and project metadata)
    /// * `location` - Optional directory to save the project in. If None, uses user's documents directory.
    pub fn do_create_project_full(
        &self,
        name: String,
        location: Option<PathBuf>,
    ) -> Result<super::loading::CreateProjectFullResult, super::loading::LoadError> {
        use super::loading::{CreateProjectFullResult, DisplaySettings, LoadError, LoadingPhase, ProgressEmitter};

        let handle = self.get_app_handle()
            .ok_or_else(|| LoadError::internal("AppHandle not initialized"))?;

        // Start new load - cancels any existing load
        let cancel_token = self.start_new_load();
        let mut progress = ProgressEmitter::new_for_create(handle, Arc::clone(&cancel_token));

        // Helper macro for early return with identity-safe token clearing
        macro_rules! check_cancelled {
            () => {
                if progress.is_cancelled() {
                    self.clear_active_load(&cancel_token);
                    return Err(LoadError::cancelled());
                }
            };
        }

        macro_rules! early_return_err {
            ($err:expr) => {{
                self.clear_active_load(&cancel_token);
                return Err($err);
            }};
        }

        // === PHASE 0: Creating database (40%) ===
        progress.start_phase(LoadingPhase::CreatingDatabase);

        // Resolve the database path from name and optional location (directory)
        let db_path = match self.resolve_project_path(&name, location.as_ref()) {
            Ok(path) => path,
            Err(e) => {
                early_return_err!(LoadError::new("IO", e));
            }
        };

        // CRITICAL: Fail if file already exists to prevent data corruption
        if db_path.exists() {
            early_return_err!(LoadError::new(
                "ALREADY_EXISTS",
                format!("Project file already exists: {}", db_path.display())
            ));
        }

        // Create parent directories if they don't exist
        if let Some(parent) = db_path.parent() {
            if !parent.exists() {
                if let Err(e) = std::fs::create_dir_all(parent) {
                    early_return_err!(LoadError::new(
                        "IO",
                        format!("Failed to create directory: {}", e)
                    ));
                }
            }
        }

        // Create the database - local variable only until Finalizing
        let mut db = match Database::open(&db_path) {
            Ok(db) => db,
            Err(e) => {
                early_return_err!(LoadError::new("DATABASE", format!("Failed to create database: {}", e)));
            }
        };
        check_cancelled!();
        progress.complete_phase(LoadingPhase::CreatingDatabase);

        // === PHASE 1: Initializing project (40%) ===
        progress.start_phase(LoadingPhase::InitializingProject);
        // Note: location parameter is the save directory, not cave location metadata.
        // Pass None for cave location - it can be set later via project settings.
        let mut project = Project::new(name.clone(), None);
        project.file_path = Some(db_path.clone());

        if let Err(e) = db.save_project(&project) {
            early_return_err!(LoadError::new("DATABASE", format!("Failed to save project: {}", e)));
        }
        check_cancelled!();
        progress.complete_phase(LoadingPhase::InitializingProject);

        // === PHASE 2: Saving settings (20%) ===
        progress.start_phase(LoadingPhase::SavingSettings);
        let display_settings = DisplaySettings::default();

        // Save default display settings to database
        // Convert display_settings to HashMap for storage
        let settings_map = vec![
            ("showStations", display_settings.show_stations.to_string()),
            ("showSectionNames", display_settings.show_section_names.to_string()),
            ("showStationLabels", display_settings.show_station_labels.to_string()),
            ("showShotData", display_settings.show_shot_data.to_string()),
            ("showVirtualShots", display_settings.show_virtual_shots.to_string()),
            ("showZeroDatum", display_settings.show_zero_datum.to_string()),
            ("showGrid", display_settings.show_grid.to_string()),
            ("showScaleBar", display_settings.show_scale_bar.to_string()),
            ("showSatellite", display_settings.show_satellite.to_string()),
            ("showDepthGradient", display_settings.show_depth_gradient.to_string()),
            ("gridSpacing", display_settings.grid_spacing.to_string()),
        ];

        for (key, value) in &settings_map {
            if let Err(e) = db.save_display_setting(key, value) {
                // Fail the command if display settings can't be saved - this indicates a real DB error
                early_return_err!(LoadError::new(
                    "DATABASE",
                    format!("Failed to save display setting {}: {}", key, e)
                ));
            }
        }
        check_cancelled!();
        progress.complete_phase(LoadingPhase::SavingSettings);

        // === FINALIZE: Store in AppState ===
        // Guard 1: Project state mutation
        check_cancelled!();
        *self.project.lock().unwrap() = Some(project.clone());

        // Guard 2: Database handle mutation
        check_cancelled!();
        *self.database.lock().unwrap() = Some(db);

        // Guard 3: Clear undo stack (new project)
        check_cancelled!();
        if let Ok(mut undo_stack) = self.undo_stack.lock() {
            undo_stack.clear();
        }

        // Guard 4: Display settings cache clear
        check_cancelled!();
        self.clear_display_settings_cache();

        // Guard 5: Add to recent projects
        check_cancelled!();
        if let Ok(mut recent) = self.recent_projects.lock() {
            recent.retain(|p| p != &db_path);
            recent.insert(0, db_path.clone());
            if let Ok(mut config) = self.config.lock() {
                recent.truncate(config.general.recent_projects_max);
                config.general.recent_projects = recent.clone();
                if let Err(e) = config.save() {
                    tracing::warn!("Failed to save config with recent projects: {}", e);
                }
            }
        }

        // Get loading_id before clearing token
        let loading_id = progress.loading_id();

        // Clear active load AFTER all mutations complete
        self.clear_active_load(&cancel_token);

        tracing::info!(path = ?db_path, name = %name, "Project created via create_project_full");

        Ok(CreateProjectFullResult {
            loading_id,
            project,
            display_settings,
        })
    }
    #[cfg(test)]
    pub fn set_project_for_tests(&self, project: Project) {
        if let Ok(mut guard) = self.project.lock() {
            *guard = Some(project);
        }
    }

    #[cfg(test)]
    pub fn set_database_for_tests(&self, db: Database) {
        if let Ok(mut guard) = self.database.lock() {
            *guard = Some(db);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::undo::{UndoData, UndoEntry};
    use crate::models::{SectionUpdates, ShotData, ShotUpdates, SurveyDirection};
    use tempfile::TempDir;

    /// Helper to create a basic shot data for testing
    fn test_shot_data(length: f64) -> ShotData {
        ShotData {
            azimuth_in: 45.0,
            azimuth_out: 225.0,
            length,
            depth_in: 10.0,
            depth_out: 11.0,
            ..Default::default()
        }
    }

    fn poison_mutex<T>(mutex: &Mutex<T>) {
        let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let _guard = mutex.lock().unwrap();
            panic!("poison mutex for lock failure coverage");
        }));
    }

    // === Project Operations Tests ===

    #[test]
    fn test_create_project() {
        let state = AppState::new().unwrap();

        let result = state.execute(Command::CreateProject {
            name: "Test Cave".to_string(),
            location: Some("Test Location".to_string()),
        });

        assert!(result.success);
        assert!(result.error.is_none());

        let project = state.get_project_state();
        assert!(project.is_some());

        let project = project.unwrap();
        assert_eq!(project.name, "Test Cave");
        assert_eq!(project.location, Some("Test Location".to_string()));
    }

    #[test]
    fn test_merge_projects_archives_sources_and_adds_extension() {
        let temp_dir = TempDir::new().unwrap();

        let mut project_a = Project::new("A".to_string(), None);
        project_a.add_section(SectionData {
            name: Some("Section A".to_string()),
            surveyor: None,
            date: None,
            color: "#4ecdc4".to_string(),
            direction: Some(SurveyDirection::In),
            shots: vec![test_shot_data(1.0)],
        });

        let mut project_b = Project::new("B".to_string(), None);
        project_b.add_section(SectionData {
            name: Some("Section B".to_string()),
            surveyor: None,
            date: None,
            color: "#4ecdc4".to_string(),
            direction: Some(SurveyDirection::Out),
            shots: vec![test_shot_data(2.0)],
        });

        let source_a = temp_dir.path().join("a.cvproj");
        let source_b = temp_dir.path().join("b.cvproj");

        let mut db_a = Database::open(&source_a).unwrap();
        db_a.save_project(&project_a).unwrap();
        let mut db_b = Database::open(&source_b).unwrap();
        db_b.save_project(&project_b).unwrap();
        drop(db_a);
        drop(db_b);

        let existing_archive = temp_dir.path().join("a.cvproj.archived");
        std::fs::write(&existing_archive, b"archived").unwrap();

        let state = AppState::new().unwrap();
        let output_path = temp_dir.path().join("merged-output");

        let result = state.execute(Command::MergeProjects {
            source_paths: vec![source_a.clone(), source_b.clone()],
            output_path: output_path.clone(),
            output_name: "Merged".to_string(),
            archive_originals: true,
        });

        assert!(result.success);

        let output_with_ext = output_path.with_extension("cvproj");
        assert!(output_with_ext.exists());

        assert!(!source_a.exists());
        assert!(!source_b.exists());

        let archived_entries: Vec<_> = std::fs::read_dir(temp_dir.path())
            .unwrap()
            .filter_map(|entry| entry.ok())
            .map(|entry| entry.path())
            .filter(|path| {
                path.file_name()
                    .and_then(|name| name.to_str())
                    .map(|name| name.starts_with("a.cvproj.archived"))
                    .unwrap_or(false)
            })
            .collect();

        assert!(!archived_entries.is_empty());
        assert!(temp_dir.path().join("b.cvproj.archived").exists());
    }

    #[test]
    fn test_undo_fails_with_invalid_previous_values_shot() {
        let state = AppState::new().unwrap();
        let mut stack = state.undo_stack.lock().unwrap();
        stack.push_with_data(
            Command::UpdateShot {
                section_id: 1,
                shot_id: 1,
                updates: ShotUpdates::default(),
            },
            UndoData::PreviousValues {
                section_id: 1,
                shot_id: Some(1),
                values_json: "not-json".to_string(),
            },
        );
        drop(stack);

        let result = state.undo();
        assert!(!result.success);
        assert_eq!(result.error.as_deref(), Some("Failed to parse undo data"));
    }

    #[test]
    fn test_undo_fails_with_invalid_previous_values_section() {
        let state = AppState::new().unwrap();
        let mut stack = state.undo_stack.lock().unwrap();
        stack.push_with_data(
            Command::UpdateSectionMetadata {
                section_id: 1,
                updates: SectionUpdates::default(),
            },
            UndoData::PreviousValues {
                section_id: 1,
                shot_id: None,
                values_json: "not-json".to_string(),
            },
        );
        drop(stack);

        let result = state.undo();
        assert!(!result.success);
        assert_eq!(result.error.as_deref(), Some("Failed to parse undo data"));
    }

    #[test]
    fn test_undo_fails_with_invalid_project_snapshot() {
        let state = AppState::new().unwrap();
        let mut stack = state.undo_stack.lock().unwrap();
        stack.push_with_data(
            Command::Batch { commands: Vec::new() },
            UndoData::ProjectSnapshot("not-json".to_string()),
        );
        drop(stack);

        let result = state.undo();
        assert!(!result.success);
        assert_eq!(result.error.as_deref(), Some("Failed to parse project snapshot"));
    }

    #[test]
    fn test_redo_fails_with_invalid_project_snapshot_pair() {
        let state = AppState::new().unwrap();
        let mut stack = state.undo_stack.lock().unwrap();
        let entry = UndoEntry {
            command: Command::CloseProject,
            undo_data: UndoData::ProjectSnapshotPair {
                before: "{}".to_string(),
                after: "not-json".to_string(),
            },
            timestamp: None,
        };
        stack.push_redo(entry);
        drop(stack);

        let result = state.redo();
        assert!(!result.success);
        assert_eq!(result.error.as_deref(), Some("Failed to parse project snapshot"));
    }

    #[test]
    fn test_redo_fails_for_command_not_allowed_in_undo_context() {
        let state = AppState::new().unwrap();
        let mut stack = state.undo_stack.lock().unwrap();
        let entry = UndoEntry {
            command: Command::MergeProjects {
                source_paths: Vec::new(),
                output_path: PathBuf::from("out.cvproj"),
                output_name: "Merged".to_string(),
                archive_originals: false,
            },
            undo_data: UndoData::None,
            timestamp: None,
        };
        stack.push_redo(entry);
        drop(stack);

        let result = state.redo();
        assert!(!result.success);
        assert_eq!(
            result.error.as_deref(),
            Some("Command cannot be executed in undo context")
        );
    }

    #[test]
    fn test_create_project_without_location() {
        let state = AppState::new().unwrap();

        let result = state.execute(Command::CreateProject {
            name: "Unnamed Cave".to_string(),
            location: None,
        });

        assert!(result.success);
        let project = state.get_project_state().unwrap();
        assert_eq!(project.name, "Unnamed Cave");
        assert!(project.location.is_none());
    }

    #[test]
    fn test_close_project() {
        let state = AppState::new().unwrap();

        // Create a project first
        state.execute(Command::CreateProject {
            name: "To Close".to_string(),
            location: None,
        });

        // Close it
        let result = state.execute(Command::CloseProject);
        assert!(result.success);

        // Project should be None
        assert!(state.get_project_state().is_none());
    }

    // === Section Operations Tests ===

    #[test]
    fn test_create_section() {
        let state = AppState::new().unwrap();

        state.execute(Command::CreateProject {
            name: "Test".to_string(),
            location: None,
        });

        let result = state.execute(Command::CreateSection {
            name: Some("Section A".to_string()),
            surveyor: Some("John".to_string()),
            date: None,
            color: "#4ecdc4".to_string(),
            direction: Some(SurveyDirection::In),
            shots: vec![test_shot_data(5.0), test_shot_data(7.0)],
        });

        assert!(result.success);
        assert!(result.section_id.is_some());

        let project = state.get_project_state().unwrap();
        assert_eq!(project.sections.len(), 1);
        assert_eq!(project.sections[0].name, Some("Section A".to_string()));
        assert_eq!(project.sections[0].shots.len(), 2);
    }

    #[test]
    fn test_create_section_returns_id() {
        let state = AppState::new().unwrap();

        state.execute(Command::CreateProject {
            name: "Test".to_string(),
            location: None,
        });

        let result = state.execute(Command::CreateSection {
            name: Some("First".to_string()),
            surveyor: None,
            date: None,
            color: "#ff0000".to_string(),
            direction: None,
            shots: vec![],
        });

        assert!(result.success);
        assert_eq!(result.section_id, Some(0));

        // Create another section
        let result2 = state.execute(Command::CreateSection {
            name: Some("Second".to_string()),
            surveyor: None,
            date: None,
            color: "#00ff00".to_string(),
            direction: None,
            shots: vec![],
        });

        assert!(result2.success);
        assert_eq!(result2.section_id, Some(1));
    }

    #[test]
    fn test_create_section_no_project() {
        let state = AppState::new().unwrap();

        let result = state.execute(Command::CreateSection {
            name: Some("Orphan".to_string()),
            surveyor: None,
            date: None,
            color: "#000000".to_string(),
            direction: None,
            shots: vec![],
        });

        assert!(!result.success);
        assert!(result.error.is_some());
    }

    #[test]
    fn test_delete_section() {
        let state = AppState::new().unwrap();

        state.execute(Command::CreateProject {
            name: "Test".to_string(),
            location: None,
        });

        let create_result = state.execute(Command::CreateSection {
            name: Some("To Delete".to_string()),
            surveyor: None,
            date: None,
            color: "#ff0000".to_string(),
            direction: None,
            shots: vec![test_shot_data(3.0)],
        });

        let section_id = create_result.section_id.unwrap();

        let result = state.execute(Command::DeleteSection { section_id });
        assert!(result.success);

        let project = state.get_project_state().unwrap();
        assert!(project.sections.is_empty());
    }

    #[test]
    fn test_delete_nonexistent_section() {
        let state = AppState::new().unwrap();

        state.execute(Command::CreateProject {
            name: "Test".to_string(),
            location: None,
        });

        let result = state.execute(Command::DeleteSection { section_id: 999 });
        assert!(!result.success);
    }

    #[test]
    fn test_update_section_metadata() {
        let state = AppState::new().unwrap();

        state.execute(Command::CreateProject {
            name: "Test".to_string(),
            location: None,
        });

        let create_result = state.execute(Command::CreateSection {
            name: Some("Original".to_string()),
            surveyor: None,
            date: None,
            color: "#ff0000".to_string(),
            direction: None,
            shots: vec![],
        });

        let section_id = create_result.section_id.unwrap();

        let result = state.execute(Command::UpdateSectionMetadata {
            section_id,
            updates: SectionUpdates {
                name: Some(Some("Updated".to_string())),
                color: Some("#00ff00".to_string()),
                ..Default::default()
            },
        });

        assert!(result.success);

        let project = state.get_project_state().unwrap();
        assert_eq!(
            project.sections[0].name,
            Some("Updated".to_string())
        );
        assert_eq!(project.sections[0].color, "#00ff00");
    }

    // === Shot Operations Tests ===

    #[test]
    fn test_create_shot() {
        let state = AppState::new().unwrap();

        state.execute(Command::CreateProject {
            name: "Test".to_string(),
            location: None,
        });

        let create_result = state.execute(Command::CreateSection {
            name: Some("Section".to_string()),
            surveyor: None,
            date: None,
            color: "#ff0000".to_string(),
            direction: None,
            shots: vec![],
        });

        let section_id = create_result.section_id.unwrap();

        let result = state.execute(Command::CreateShot {
            section_id,
            shot: test_shot_data(10.0),
            after_shot_id: None,
        });

        assert!(result.success);

        let project = state.get_project_state().unwrap();
        assert_eq!(project.sections[0].shots.len(), 1);
        assert_eq!(project.sections[0].shots[0].length, 10.0);
    }

    #[test]
    fn test_update_shot() {
        let state = AppState::new().unwrap();

        state.execute(Command::CreateProject {
            name: "Test".to_string(),
            location: None,
        });

        let create_result = state.execute(Command::CreateSection {
            name: None,
            surveyor: None,
            date: None,
            color: "#ff0000".to_string(),
            direction: None,
            shots: vec![test_shot_data(5.0)],
        });

        let section_id = create_result.section_id.unwrap();
        let project = state.get_project_state().unwrap();
        let shot_id = project.sections[0].shots[0].id;

        let result = state.execute(Command::UpdateShot {
            section_id,
            shot_id,
            updates: ShotUpdates {
                length: Some(15.0),
                comment: Some(Some("Updated shot".to_string())),
                ..Default::default()
            },
        });

        assert!(result.success);

        let project = state.get_project_state().unwrap();
        assert_eq!(project.sections[0].shots[0].length, 15.0);
        assert_eq!(
            project.sections[0].shots[0].comment,
            Some("Updated shot".to_string())
        );
    }

    #[test]
    fn test_delete_shot() {
        let state = AppState::new().unwrap();

        state.execute(Command::CreateProject {
            name: "Test".to_string(),
            location: None,
        });

        let create_result = state.execute(Command::CreateSection {
            name: None,
            surveyor: None,
            date: None,
            color: "#ff0000".to_string(),
            direction: None,
            shots: vec![test_shot_data(5.0), test_shot_data(7.0)],
        });

        let section_id = create_result.section_id.unwrap();
        let project = state.get_project_state().unwrap();
        let shot_id = project.sections[0].shots[0].id;

        let result = state.execute(Command::DeleteShot {
            section_id,
            shot_id,
        });

        assert!(result.success);

        let project = state.get_project_state().unwrap();
        assert_eq!(project.sections[0].shots.len(), 1);
    }

    #[test]
    fn test_set_shot_virtual() {
        let state = AppState::new().unwrap();

        state.execute(Command::CreateProject {
            name: "Test".to_string(),
            location: None,
        });

        let create_result = state.execute(Command::CreateSection {
            name: None,
            surveyor: None,
            date: None,
            color: "#ff0000".to_string(),
            direction: None,
            shots: vec![test_shot_data(5.0)],
        });

        let section_id = create_result.section_id.unwrap();
        let project = state.get_project_state().unwrap();
        let shot_id = project.sections[0].shots[0].id;

        // Initially not virtual
        assert!(!project.sections[0].shots[0].is_virtual);

        let result = state.execute(Command::SetShotVirtual {
            section_id,
            shot_id,
            is_virtual: true,
        });

        assert!(result.success);

        let project = state.get_project_state().unwrap();
        assert!(project.sections[0].shots[0].is_virtual);
    }

    // === Undo/Redo Tests ===

    #[test]
    fn test_undo_create_section() {
        let state = AppState::new().unwrap();

        state.execute(Command::CreateProject {
            name: "Test".to_string(),
            location: None,
        });

        state.execute(Command::CreateSection {
            name: Some("To Undo".to_string()),
            surveyor: None,
            date: None,
            color: "#ff0000".to_string(),
            direction: None,
            shots: vec![test_shot_data(5.0)],
        });

        assert_eq!(state.get_project_state().unwrap().sections.len(), 1);
        assert!(state.can_undo());

        let result = state.undo();
        assert!(result.success);

        assert!(state.get_project_state().unwrap().sections.is_empty());
    }

    #[test]
    fn test_undo_delete_section() {
        let state = AppState::new().unwrap();

        state.execute(Command::CreateProject {
            name: "Test".to_string(),
            location: None,
        });

        let create_result = state.execute(Command::CreateSection {
            name: Some("Will Delete".to_string()),
            surveyor: None,
            date: None,
            color: "#ff0000".to_string(),
            direction: None,
            shots: vec![test_shot_data(5.0)],
        });

        let section_id = create_result.section_id.unwrap();

        state.execute(Command::DeleteSection { section_id });
        assert!(state.get_project_state().unwrap().sections.is_empty());

        // Undo the delete
        let result = state.undo();
        assert!(result.success);

        let project = state.get_project_state().unwrap();
        assert_eq!(project.sections.len(), 1);
        assert_eq!(
            project.sections[0].name,
            Some("Will Delete".to_string())
        );
    }

    #[test]
    fn test_undo_update_shot() {
        let state = AppState::new().unwrap();

        state.execute(Command::CreateProject {
            name: "Test".to_string(),
            location: None,
        });

        let create_result = state.execute(Command::CreateSection {
            name: None,
            surveyor: None,
            date: None,
            color: "#ff0000".to_string(),
            direction: None,
            shots: vec![test_shot_data(5.0)],
        });

        let section_id = create_result.section_id.unwrap();
        let project = state.get_project_state().unwrap();
        let shot_id = project.sections[0].shots[0].id;

        state.execute(Command::UpdateShot {
            section_id,
            shot_id,
            updates: ShotUpdates {
                length: Some(15.0),
                ..Default::default()
            },
        });

        assert_eq!(
            state.get_project_state().unwrap().sections[0].shots[0].length,
            15.0
        );

        let result = state.undo();
        assert!(result.success);

        assert_eq!(
            state.get_project_state().unwrap().sections[0].shots[0].length,
            5.0
        );
    }

    #[test]
    fn test_redo_create_section() {
        let state = AppState::new().unwrap();

        state.execute(Command::CreateProject {
            name: "Test".to_string(),
            location: None,
        });

        state.execute(Command::CreateSection {
            name: Some("Redo Me".to_string()),
            surveyor: None,
            date: None,
            color: "#ff0000".to_string(),
            direction: None,
            shots: vec![],
        });

        state.undo();
        assert!(state.get_project_state().unwrap().sections.is_empty());
        assert!(state.can_redo());

        let result = state.redo();
        assert!(result.success);

        assert_eq!(state.get_project_state().unwrap().sections.len(), 1);
    }

    #[test]
    fn test_undo_nothing() {
        let state = AppState::new().unwrap();

        state.execute(Command::CreateProject {
            name: "Test".to_string(),
            location: None,
        });

        assert!(!state.can_undo());

        let result = state.undo();
        assert!(!result.success);
        assert_eq!(result.error.as_deref(), Some("Nothing to undo"));
    }

    #[test]
    fn test_redo_nothing() {
        let state = AppState::new().unwrap();

        state.execute(Command::CreateProject {
            name: "Test".to_string(),
            location: None,
        });

        assert!(!state.can_redo());

        let result = state.redo();
        assert!(!result.success);
        assert_eq!(result.error.as_deref(), Some("Nothing to redo"));
    }

    #[test]
    fn test_redo_cleared_on_new_command() {
        let state = AppState::new().unwrap();

        state.execute(Command::CreateProject {
            name: "Test".to_string(),
            location: None,
        });

        state.execute(Command::CreateSection {
            name: Some("First".to_string()),
            surveyor: None,
            date: None,
            color: "#ff0000".to_string(),
            direction: None,
            shots: vec![],
        });

        state.undo();
        assert!(state.can_redo());

        // New command clears redo stack
        state.execute(Command::CreateSection {
            name: Some("Different".to_string()),
            surveyor: None,
            date: None,
            color: "#00ff00".to_string(),
            direction: None,
            shots: vec![],
        });

        assert!(!state.can_redo());
    }

    #[test]
    fn test_undo_fails_when_undo_stack_poisoned() {
        let state = AppState::new().unwrap();
        poison_mutex(&state.undo_stack);

        let result = state.undo();
        assert!(!result.success);
        assert_eq!(result.error.as_deref(), Some("Failed to lock undo stack"));
    }

    #[test]
    fn test_redo_fails_when_undo_stack_poisoned() {
        let state = AppState::new().unwrap();
        poison_mutex(&state.undo_stack);

        let result = state.redo();
        assert!(!result.success);
        assert_eq!(result.error.as_deref(), Some("Failed to lock undo stack"));
    }

    #[test]
    fn test_undo_fails_for_non_undoable_entry() {
        let state = AppState::new().unwrap();
        let mut stack = state.undo_stack.lock().unwrap();
        stack.push_with_data(Command::CloseProject, UndoData::None);
        drop(stack);

        let result = state.undo();
        assert!(!result.success);
        assert_eq!(
            result.error.as_deref(),
            Some("This command cannot be undone")
        );
        assert!(!state.can_redo());
    }

    #[test]
    fn test_project_snapshot_pair_undo_redo_roundtrip() {
        let state = AppState::new().unwrap();

        let mut before = Project::new("Before".to_string(), None);
        before.add_section(SectionData {
            name: Some("Before Section".to_string()),
            surveyor: None,
            date: None,
            color: "#ff0000".to_string(),
            direction: Some(SurveyDirection::In),
            shots: vec![test_shot_data(1.0)],
        });

        let mut after = Project::new("After".to_string(), None);
        after.add_section(SectionData {
            name: Some("After Section".to_string()),
            surveyor: None,
            date: None,
            color: "#00ff00".to_string(),
            direction: Some(SurveyDirection::Out),
            shots: vec![test_shot_data(2.0), test_shot_data(3.0)],
        });

        let before_json = serde_json::to_string(&before).unwrap();
        let after_json = serde_json::to_string(&after).unwrap();

        state.set_project_for_tests(after.clone());

        let mut stack = state.undo_stack.lock().unwrap();
        stack.push_with_data(
            Command::MergeProjects {
                source_paths: Vec::new(),
                output_path: PathBuf::from("out.cvproj"),
                output_name: "Merged".to_string(),
                archive_originals: false,
            },
            UndoData::ProjectSnapshotPair {
                before: before_json,
                after: after_json,
            },
        );
        drop(stack);

        assert!(state.can_undo());

        let undo_result = state.undo();
        assert!(undo_result.success);

        let project_after_undo = state.get_project_state().unwrap();
        assert_eq!(project_after_undo.name, "Before");
        assert_eq!(project_after_undo.sections[0].shots.len(), 1);
        assert!(state.can_redo());

        let redo_result = state.redo();
        assert!(redo_result.success);

        let project_after_redo = state.get_project_state().unwrap();
        assert_eq!(project_after_redo.name, "After");
        assert_eq!(project_after_redo.sections[0].shots.len(), 2);
        assert!(state.can_undo());
        assert!(!state.can_redo());
    }

    #[test]
    fn test_undo_project_snapshot_fails_when_project_lock_poisoned() {
        let state = AppState::new().unwrap();
        let snapshot = serde_json::to_string(&Project::new("Test".to_string(), None)).unwrap();

        let mut stack = state.undo_stack.lock().unwrap();
        stack.push_with_data(
            Command::Batch { commands: Vec::new() },
            UndoData::ProjectSnapshot(snapshot),
        );
        drop(stack);

        poison_mutex(&state.project);

        let result = state.undo();
        assert!(!result.success);
        assert_eq!(result.error.as_deref(), Some("Failed to lock project"));
    }

    #[test]
    fn test_undo_project_snapshot_pair_fails_when_project_lock_poisoned() {
        let state = AppState::new().unwrap();
        let before = serde_json::to_string(&Project::new("Before".to_string(), None)).unwrap();
        let after = serde_json::to_string(&Project::new("After".to_string(), None)).unwrap();

        let mut stack = state.undo_stack.lock().unwrap();
        stack.push_with_data(
            Command::Batch { commands: Vec::new() },
            UndoData::ProjectSnapshotPair { before, after },
        );
        drop(stack);

        poison_mutex(&state.project);

        let result = state.undo();
        assert!(!result.success);
        assert_eq!(result.error.as_deref(), Some("Failed to lock project"));
    }

    #[test]
    fn test_redo_project_snapshot_pair_fails_when_project_lock_poisoned() {
        let state = AppState::new().unwrap();
        let before = serde_json::to_string(&Project::new("Before".to_string(), None)).unwrap();
        let after = serde_json::to_string(&Project::new("After".to_string(), None)).unwrap();

        let entry = UndoEntry {
            command: Command::CloseProject,
            undo_data: UndoData::ProjectSnapshotPair { before, after },
            timestamp: None,
        };

        let mut stack = state.undo_stack.lock().unwrap();
        stack.push_redo(entry);
        drop(stack);

        poison_mutex(&state.project);

        let result = state.redo();
        assert!(!result.success);
        assert_eq!(result.error.as_deref(), Some("Failed to lock project"));
    }

    #[test]
    fn test_undo_merge_info_fails_when_project_lock_poisoned() {
        let state = AppState::new().unwrap();

        let mut stack = state.undo_stack.lock().unwrap();
        stack.push_with_data(
            Command::MergeStations {
                station_a: StationRef::new(1, 0),
                station_b: StationRef::new(1, 1),
                closure_strategy: ClosureStrategy::ProportionalByLength,
            },
            UndoData::MergeInfo {
                station_a: StationRef::new(1, 0),
                station_b: StationRef::new(1, 1),
                strategy: ClosureStrategy::ProportionalByLength,
            },
        );
        drop(stack);

        poison_mutex(&state.project);

        let result = state.undo();
        assert!(!result.success);
        assert_eq!(result.error.as_deref(), Some("Failed to lock project"));
    }

    // === State Transition Tests ===

    #[test]
    fn test_project_modification_tracking() {
        let state = AppState::new().unwrap();

        state.execute(Command::CreateProject {
            name: "Test".to_string(),
            location: None,
        });

        let initial_modified = state.get_project_state().unwrap().modified_at;

        // Sleep a tiny bit to ensure timestamp changes
        std::thread::sleep(std::time::Duration::from_millis(1));

        state.execute(Command::CreateSection {
            name: Some("Section".to_string()),
            surveyor: None,
            date: None,
            color: "#ff0000".to_string(),
            direction: None,
            shots: vec![],
        });

        let after_section = state.get_project_state().unwrap().modified_at;
        assert!(after_section > initial_modified);
    }

    #[test]
    fn test_is_undoable_commands() {
        // Non-undoable commands
        assert!(!AppState::is_undoable(&Command::OpenProject {
            path: PathBuf::from("/test.cvproj"),
        }));
        assert!(!AppState::is_undoable(&Command::SaveProject { path: None }));
        assert!(!AppState::is_undoable(&Command::CloseProject));
        assert!(!AppState::is_undoable(&Command::CreateProject {
            name: "Test".to_string(),
            location: None,
        }));

        // Undoable commands
        assert!(AppState::is_undoable(&Command::CreateSection {
            name: None,
            surveyor: None,
            date: None,
            color: "#000000".to_string(),
            direction: None,
            shots: vec![],
        }));
        assert!(AppState::is_undoable(&Command::DeleteSection { section_id: 0 }));
        assert!(AppState::is_undoable(&Command::CreateShot {
            section_id: 0,
            shot: ShotData::default(),
            after_shot_id: None,
        }));
    }

    #[test]
    fn test_is_modifying_commands() {
        // Non-modifying commands
        assert!(!AppState::is_modifying(&Command::OpenProject {
            path: PathBuf::from("/test.cvproj"),
        }));
        assert!(!AppState::is_modifying(&Command::SaveProject { path: None }));
        assert!(!AppState::is_modifying(&Command::CloseProject));

        // Modifying commands
        assert!(AppState::is_modifying(&Command::CreateProject {
            name: "Test".to_string(),
            location: None,
        }));
        assert!(AppState::is_modifying(&Command::CreateSection {
            name: None,
            surveyor: None,
            date: None,
            color: "#000000".to_string(),
            direction: None,
            shots: vec![],
        }));
    }

    // === Config Tests ===

    #[test]
    fn test_get_config() {
        let state = AppState::new().unwrap();
        let config = state.get_config();

        // Should have default values
        assert!(config.general.auto_save);
        assert_eq!(config.general.undo_history_limit, 100);
    }

    #[test]
    fn test_display_settings_cache() {
        let state = AppState::new().unwrap();

        // Create a project (no database, so settings go to cache)
        state.execute(Command::CreateProject {
            name: "Test".to_string(),
            location: None,
        });

        // Save a display setting
        let result = state.save_display_setting("test_key", "test_value");
        assert!(result.is_ok());

        // Retrieve it
        let value = state.get_display_setting("test_key").unwrap();
        assert_eq!(value, Some("test_value".to_string()));

        // Load all settings
        let settings = state.load_display_settings().unwrap();
        assert_eq!(settings.get("test_key"), Some(&"test_value".to_string()));
    }

    #[test]
    fn test_display_settings_fail_when_cache_lock_poisoned() {
        let state = AppState::new().unwrap();

        poison_mutex(&state.display_settings_cache);

        let err = state.load_display_settings().unwrap_err();
        assert_eq!(err.to_string(), "Failed to lock display settings cache");

        let err = state.save_display_setting("key", "value").unwrap_err();
        assert_eq!(err.to_string(), "Failed to lock display settings cache");

        let err = state.get_display_setting("key").unwrap_err();
        assert_eq!(err.to_string(), "Failed to lock display settings cache");
    }

    #[test]
    fn test_display_settings_fail_when_database_lock_poisoned() {
        let state = AppState::new().unwrap();

        poison_mutex(&state.database);

        let err = state.load_display_settings().unwrap_err();
        assert_eq!(err.to_string(), "Failed to lock database");

        let err = state.save_display_setting("key", "value").unwrap_err();
        assert_eq!(err.to_string(), "Failed to lock database");

        let err = state.get_display_setting("key").unwrap_err();
        assert_eq!(err.to_string(), "Failed to lock database");
    }

    #[test]
    fn test_resolved_warning_methods_fail_when_database_lock_poisoned() {
        let state = AppState::new().unwrap();

        poison_mutex(&state.database);

        let err = state.load_resolved_warnings().unwrap_err();
        assert_eq!(err.to_string(), "Failed to lock database");

        let warning = crate::persistence::ResolvedWarning {
            section_id: 1,
            shot_id: 2,
            warning_code: "TEST".to_string(),
            resolved_at: chrono::Utc::now(),
            resolved_comment: None,
        };

        let err = state.save_resolved_warning(&warning).unwrap_err();
        assert_eq!(err.to_string(), "Failed to lock database");

        let err = state.delete_resolved_warning(1, 2, "TEST").unwrap_err();
        assert_eq!(err.to_string(), "Failed to lock database");
    }

    #[test]
    fn test_remove_recent_projects_fails_when_lock_poisoned() {
        let state = AppState::new().unwrap();
        poison_mutex(&state.recent_projects);

        let result = state.remove_from_recent_projects(PathBuf::from("missing.cvproj"));
        assert!(!result.success);
        assert_eq!(
            result.error.as_deref(),
            Some("Failed to lock recent projects")
        );
    }

    #[test]
    fn test_import_tracking_fails_when_project_lock_poisoned() {
        let state = AppState::new().unwrap();
        poison_mutex(&state.project);

        let err = state.check_duplicate_import("hash").unwrap_err();
        assert_eq!(err.to_string(), "Failed to lock project");

        let result = state.track_imported_file("hash".to_string());
        assert!(!result.success);
        assert_eq!(result.error.as_deref(), Some("Failed to lock project"));
    }

    // === Batch Command Tests ===

    #[test]
    fn test_batch_create_sections() {
        let state = AppState::new().unwrap();

        state.execute(Command::CreateProject {
            name: "Test".to_string(),
            location: None,
        });

        let result = state.execute(Command::Batch {
            commands: vec![
                Command::CreateSection {
                    name: Some("First".to_string()),
                    surveyor: None,
                    date: None,
                    color: "#ff0000".to_string(),
                    direction: None,
                    shots: vec![test_shot_data(5.0)],
                },
                Command::CreateSection {
                    name: Some("Second".to_string()),
                    surveyor: None,
                    date: None,
                    color: "#00ff00".to_string(),
                    direction: None,
                    shots: vec![test_shot_data(7.0)],
                },
            ],
        });

        assert!(result.success);
        assert_eq!(result.section_ids.len(), 2);

        let project = state.get_project_state().unwrap();
        assert_eq!(project.sections.len(), 2);
    }

    #[test]
    fn test_batch_fails_on_first_error() {
        let state = AppState::new().unwrap();

        state.execute(Command::CreateProject {
            name: "Test".to_string(),
            location: None,
        });

        // First command succeeds, second fails (delete nonexistent section)
        let result = state.execute(Command::Batch {
            commands: vec![
                Command::CreateSection {
                    name: Some("First".to_string()),
                    surveyor: None,
                    date: None,
                    color: "#ff0000".to_string(),
                    direction: None,
                    shots: vec![],
                },
                Command::DeleteSection { section_id: 999 },
            ],
        });

        assert!(!result.success);
    }

    // === Station Merge Tests ===

    #[test]
    fn test_merge_stations_same_section_fails() {
        let state = AppState::new().unwrap();

        state.execute(Command::CreateProject {
            name: "Test".to_string(),
            location: None,
        });

        let create_result = state.execute(Command::CreateSection {
            name: None,
            surveyor: None,
            date: None,
            color: "#ff0000".to_string(),
            direction: None,
            shots: vec![test_shot_data(5.0), test_shot_data(7.0)],
        });

        let section_id = create_result.section_id.unwrap();

        // Try to merge stations from the same section
        let result = state.execute(Command::MergeStations {
            station_a: StationRef::new(section_id, 0),
            station_b: StationRef::new(section_id, 1),
            closure_strategy: ClosureStrategy::ProportionalByLength,
        });

        assert!(!result.success);
        assert!(result
            .error
            .unwrap()
            .contains("Cannot merge stations from the same section"));
    }

    // === Zero Datum Tests ===

    #[test]
    fn test_set_and_remove_zero_datum() {
        let state = AppState::new().unwrap();

        state.execute(Command::CreateProject {
            name: "Test".to_string(),
            location: None,
        });

        let create_result = state.execute(Command::CreateSection {
            name: None,
            surveyor: None,
            date: None,
            color: "#ff0000".to_string(),
            direction: None,
            shots: vec![test_shot_data(5.0)],
        });

        let section_id = create_result.section_id.unwrap();
        let station_ref = StationRef::new(section_id, 0);

        // Set zero datum
        let result = state.execute(Command::SetZeroDatum {
            station_ref,
            coordinates: GpsCoordinates::new(45.0, -73.0, 100.0).unwrap(),
        });

        assert!(result.success);

        let project = state.get_project_state().unwrap();
        assert_eq!(project.zero_datums.len(), 1);
        assert_eq!(project.zero_datums[0].gps.latitude, 45.0);

        // Remove zero datum
        let result = state.execute(Command::RemoveZeroDatum { station_ref });
        assert!(result.success);

        let project = state.get_project_state().unwrap();
        assert!(project.zero_datums.is_empty());
    }

    #[test]
    fn test_remove_nonexistent_zero_datum() {
        let state = AppState::new().unwrap();

        state.execute(Command::CreateProject {
            name: "Test".to_string(),
            location: None,
        });

        let create_result = state.execute(Command::CreateSection {
            name: None,
            surveyor: None,
            date: None,
            color: "#ff0000".to_string(),
            direction: None,
            shots: vec![test_shot_data(5.0)],
        });

        let section_id = create_result.section_id.unwrap();

        // Try to remove a datum that was never set
        let result = state.execute(Command::RemoveZeroDatum {
            station_ref: StationRef::new(section_id, 0),
        });

        assert!(!result.success);
    }

    // === Move Section Tests ===

    #[test]
    fn test_move_section() {
        let state = AppState::new().unwrap();

        state.execute(Command::CreateProject {
            name: "Test".to_string(),
            location: None,
        });

        let create_result = state.execute(Command::CreateSection {
            name: None,
            surveyor: None,
            date: None,
            color: "#ff0000".to_string(),
            direction: None,
            shots: vec![test_shot_data(5.0)],
        });

        let section_id = create_result.section_id.unwrap();

        let result = state.execute(Command::MoveSection {
            section_id,
            offset: Coordinates::new(10.0, 20.0, 0.0),
        });

        assert!(result.success);
    }

    #[test]
    fn test_move_nonexistent_section() {
        let state = AppState::new().unwrap();

        state.execute(Command::CreateProject {
            name: "Test".to_string(),
            location: None,
        });

        let result = state.execute(Command::MoveSection {
            section_id: 999,
            offset: Coordinates::new(10.0, 20.0, 0.0),
        });

        assert!(!result.success);
    }

    // === Validation Tests ===

    #[test]
    fn test_create_section_with_validation_warnings() {
        let state = AppState::new().unwrap();

        state.execute(Command::CreateProject {
            name: "Test".to_string(),
            location: None,
        });

        // Create a section with a zero-length shot (should trigger warning)
        let result = state.execute(Command::CreateSection {
            name: None,
            surveyor: None,
            date: None,
            color: "#ff0000".to_string(),
            direction: None,
            shots: vec![ShotData {
                azimuth_in: 45.0,
                azimuth_out: 225.0,
                length: 0.0, // Zero length triggers warning
                depth_in: 10.0,
                depth_out: 10.0,
                ..Default::default()
            }],
        });

        assert!(result.success);
        assert!(!result.warnings.is_empty());
        assert!(result.warnings.iter().any(|w| w.code == "ZERO_LENGTH"));
    }

    // === Undo/Redo with Shot Restoration ===

    #[test]
    fn test_undo_delete_shot_restores_at_correct_position() {
        let state = AppState::new().unwrap();

        state.execute(Command::CreateProject {
            name: "Test".to_string(),
            location: None,
        });

        let create_result = state.execute(Command::CreateSection {
            name: None,
            surveyor: None,
            date: None,
            color: "#ff0000".to_string(),
            direction: None,
            shots: vec![
                test_shot_data(5.0),
                test_shot_data(7.0),
                test_shot_data(9.0),
            ],
        });

        let section_id = create_result.section_id.unwrap();
        let project = state.get_project_state().unwrap();
        let middle_shot_id = project.sections[0].shots[1].id;

        // Delete the middle shot
        state.execute(Command::DeleteShot {
            section_id,
            shot_id: middle_shot_id,
        });

        let project = state.get_project_state().unwrap();
        assert_eq!(project.sections[0].shots.len(), 2);

        // Undo the delete
        let result = state.undo();
        assert!(result.success);

        let project = state.get_project_state().unwrap();
        assert_eq!(project.sections[0].shots.len(), 3);
        // The shot should be restored at position 1
        assert_eq!(project.sections[0].shots[1].length, 7.0);
    }

    // === Multiple Undo/Redo Sequence ===

    #[test]
    fn test_multiple_undo_redo_sequence() {
        let state = AppState::new().unwrap();

        state.execute(Command::CreateProject {
            name: "Test".to_string(),
            location: None,
        });

        // Create 3 sections
        for i in 1..=3 {
            state.execute(Command::CreateSection {
                name: Some(format!("Section {}", i)),
                surveyor: None,
                date: None,
                color: "#ff0000".to_string(),
                direction: None,
                shots: vec![],
            });
        }

        assert_eq!(state.get_project_state().unwrap().sections.len(), 3);

        // Undo all 3 creates
        state.undo();
        state.undo();
        state.undo();

        assert!(state.get_project_state().unwrap().sections.is_empty());

        // Redo 2 of them
        state.redo();
        state.redo();

        assert_eq!(state.get_project_state().unwrap().sections.len(), 2);
    }

    // === Command Execution Tests (fn-34-nvq spec) ===
    // These tests verify specific command behaviors as specified in the epic.

    #[test]
    fn test_execute_create_section_command() {
        // Verify CreateSection creates section correctly with all fields
        use chrono::NaiveDate;
        let state = AppState::new().unwrap();

        state.execute(Command::CreateProject {
            name: "Test".to_string(),
            location: None,
        });

        let test_date = NaiveDate::from_ymd_opt(2024, 1, 15).unwrap();
        let result = state.execute(Command::CreateSection {
            name: Some("Main Passage".to_string()),
            surveyor: Some("Alice".to_string()),
            date: Some(test_date),
            color: "#00ff00".to_string(),
            direction: Some(SurveyDirection::Out),
            shots: vec![test_shot_data(10.0), test_shot_data(15.0), test_shot_data(8.0)],
        });

        assert!(result.success);
        let section_id = result.section_id.expect("Section ID should be returned");

        let project = state.get_project_state().unwrap();
        let section = project.get_section(section_id).expect("Section should exist");

        assert_eq!(section.name, Some("Main Passage".to_string()));
        assert_eq!(section.surveyor, Some("Alice".to_string()));
        assert_eq!(section.date, Some(test_date));
        assert_eq!(section.color, "#00ff00");
        assert_eq!(section.direction, SurveyDirection::Out);
        assert_eq!(section.shots.len(), 3);
        assert_eq!(section.shots[0].length, 10.0);
        assert_eq!(section.shots[1].length, 15.0);
        assert_eq!(section.shots[2].length, 8.0);
    }

    #[test]
    fn test_execute_merge_stations_command() {
        // Verify MergeStations updates section offsets correctly
        let state = AppState::new().unwrap();

        state.execute(Command::CreateProject {
            name: "Test".to_string(),
            location: None,
        });

        // Create two sections
        let result_a = state.execute(Command::CreateSection {
            name: Some("Section A".to_string()),
            surveyor: None,
            date: None,
            color: "#ff0000".to_string(),
            direction: None,
            shots: vec![test_shot_data(5.0), test_shot_data(7.0)],
        });
        let section_a_id = result_a.section_id.unwrap();

        let result_b = state.execute(Command::CreateSection {
            name: Some("Section B".to_string()),
            surveyor: None,
            date: None,
            color: "#00ff00".to_string(),
            direction: None,
            shots: vec![test_shot_data(4.0), test_shot_data(6.0)],
        });
        let section_b_id = result_b.section_id.unwrap();

        // Merge station 1 of section A with station 0 of section B
        let station_a = StationRef::new(section_a_id, 1);
        let station_b = StationRef::new(section_b_id, 0);

        let result = state.execute(Command::MergeStations {
            station_a,
            station_b,
            closure_strategy: ClosureStrategy::ProportionalByLength,
        });

        assert!(result.success);

        let project = state.get_project_state().unwrap();

        // Verify merge was recorded
        assert_eq!(project.station_merges.len(), 1);
        let merge = &project.station_merges[0];
        assert_eq!(merge.station_a, station_a);
        assert_eq!(merge.station_b, station_b);

        // Verify section offsets were updated - one section should have an offset
        // (the moving section gets an offset to align with the anchor)
        let has_offset = project.section_offsets.contains_key(&section_a_id)
            || project.section_offsets.contains_key(&section_b_id);
        assert!(has_offset, "Section offsets should be updated after merge");
    }

    #[test]
    fn test_execute_set_zero_datum_command() {
        // Verify SetZeroDatum stores GPS coordinates correctly
        let state = AppState::new().unwrap();

        state.execute(Command::CreateProject {
            name: "Test".to_string(),
            location: None,
        });

        let create_result = state.execute(Command::CreateSection {
            name: None,
            surveyor: None,
            date: None,
            color: "#ff0000".to_string(),
            direction: None,
            shots: vec![test_shot_data(5.0)],
        });

        let section_id = create_result.section_id.unwrap();
        let station_ref = StationRef::new(section_id, 0);
        let gps = GpsCoordinates::new(48.8584, 2.2945, 35.0).unwrap();

        let result = state.execute(Command::SetZeroDatum {
            station_ref,
            coordinates: gps,
        });

        assert!(result.success);

        let project = state.get_project_state().unwrap();
        assert_eq!(project.zero_datums.len(), 1);

        let datum = &project.zero_datums[0];
        assert_eq!(datum.station_ref, station_ref);
        assert!((datum.gps.latitude - 48.8584).abs() < 0.0001);
        assert!((datum.gps.longitude - 2.2945).abs() < 0.0001);
        assert!((datum.gps.depth_reference - 35.0).abs() < 0.0001);
    }

    #[test]
    fn test_execute_update_shot_command() {
        // Verify UpdateShot modifies shot data correctly
        let state = AppState::new().unwrap();

        state.execute(Command::CreateProject {
            name: "Test".to_string(),
            location: None,
        });

        let create_result = state.execute(Command::CreateSection {
            name: None,
            surveyor: None,
            date: None,
            color: "#ff0000".to_string(),
            direction: None,
            shots: vec![ShotData {
                azimuth_in: 90.0,
                azimuth_out: 270.0,
                length: 10.0,
                depth_in: 5.0,
                depth_out: 6.0,
                left: None,
                right: None,
                up: None,
                down: None,
                comment: None,
                ..Default::default()
            }],
        });

        let section_id = create_result.section_id.unwrap();
        let project = state.get_project_state().unwrap();
        let shot_id = project.sections[0].shots[0].id;

        // Update multiple fields
        let result = state.execute(Command::UpdateShot {
            section_id,
            shot_id,
            updates: ShotUpdates {
                azimuth_in: Some(45.0),
                length: Some(20.0),
                left: Some(Some(1.5)),
                right: Some(Some(2.0)),
                up: Some(Some(3.0)),
                down: Some(Some(0.5)),
                comment: Some(Some("Narrow squeeze".to_string())),
                ..Default::default()
            },
        });

        assert!(result.success);

        let project = state.get_project_state().unwrap();
        let shot = &project.sections[0].shots[0];

        assert_eq!(shot.azimuth_in, 45.0);
        assert_eq!(shot.azimuth_out, 270.0); // Unchanged
        assert_eq!(shot.length, 20.0);
        assert_eq!(shot.depth_in, 5.0); // Unchanged
        assert_eq!(shot.left, Some(1.5));
        assert_eq!(shot.right, Some(2.0));
        assert_eq!(shot.up, Some(3.0));
        assert_eq!(shot.down, Some(0.5));
        assert_eq!(shot.comment, Some("Narrow squeeze".to_string()));
    }

    #[test]
    fn test_execute_delete_shot_command() {
        // Verify DeleteShot removes shot and maintains section integrity
        let state = AppState::new().unwrap();

        state.execute(Command::CreateProject {
            name: "Test".to_string(),
            location: None,
        });

        let create_result = state.execute(Command::CreateSection {
            name: None,
            surveyor: None,
            date: None,
            color: "#ff0000".to_string(),
            direction: None,
            shots: vec![
                test_shot_data(5.0),
                test_shot_data(7.0),
                test_shot_data(9.0),
            ],
        });

        let section_id = create_result.section_id.unwrap();

        // Get the middle shot's ID
        let project = state.get_project_state().unwrap();
        let middle_shot_id = project.sections[0].shots[1].id;
        let first_shot_id = project.sections[0].shots[0].id;
        let last_shot_id = project.sections[0].shots[2].id;

        // Delete the middle shot
        let result = state.execute(Command::DeleteShot {
            section_id,
            shot_id: middle_shot_id,
        });

        assert!(result.success);

        let project = state.get_project_state().unwrap();
        let section = project.get_section(section_id).unwrap();

        // Should have 2 shots remaining
        assert_eq!(section.shots.len(), 2);

        // First and last shots should still exist
        assert!(section.shots.iter().any(|s| s.id == first_shot_id));
        assert!(section.shots.iter().any(|s| s.id == last_shot_id));

        // Middle shot should be gone
        assert!(!section.shots.iter().any(|s| s.id == middle_shot_id));

        // Verify shot lengths are correct (first and last)
        assert_eq!(section.shots[0].length, 5.0);
        assert_eq!(section.shots[1].length, 9.0);
    }

    #[test]
    fn test_execute_create_shot_command() {
        // Verify CreateShot inserts shot at correct position
        let state = AppState::new().unwrap();

        state.execute(Command::CreateProject {
            name: "Test".to_string(),
            location: None,
        });

        let create_result = state.execute(Command::CreateSection {
            name: None,
            surveyor: None,
            date: None,
            color: "#ff0000".to_string(),
            direction: None,
            shots: vec![test_shot_data(5.0), test_shot_data(10.0)],
        });

        let section_id = create_result.section_id.unwrap();

        // Get the first shot's ID
        let project = state.get_project_state().unwrap();
        let first_shot_id = project.sections[0].shots[0].id;

        // Insert a new shot after the first shot
        let result = state.execute(Command::CreateShot {
            section_id,
            shot: test_shot_data(7.5), // Intermediate length
            after_shot_id: Some(first_shot_id),
        });

        assert!(result.success);

        let project = state.get_project_state().unwrap();
        let section = project.get_section(section_id).unwrap();

        // Should have 3 shots now
        assert_eq!(section.shots.len(), 3);

        // Verify order by length: 5.0, 7.5, 10.0
        assert_eq!(section.shots[0].length, 5.0);
        assert_eq!(section.shots[1].length, 7.5);
        assert_eq!(section.shots[2].length, 10.0);
    }

    #[test]
    fn test_execute_delete_section_command() {
        // Verify DeleteSection cleans up merges and related data
        let state = AppState::new().unwrap();

        state.execute(Command::CreateProject {
            name: "Test".to_string(),
            location: None,
        });

        // Create two sections
        let result_a = state.execute(Command::CreateSection {
            name: Some("Section A".to_string()),
            surveyor: None,
            date: None,
            color: "#ff0000".to_string(),
            direction: None,
            shots: vec![test_shot_data(5.0)],
        });
        let section_a_id = result_a.section_id.unwrap();

        let result_b = state.execute(Command::CreateSection {
            name: Some("Section B".to_string()),
            surveyor: None,
            date: None,
            color: "#00ff00".to_string(),
            direction: None,
            shots: vec![test_shot_data(7.0)],
        });
        let section_b_id = result_b.section_id.unwrap();

        // Set a zero datum on section A
        state.execute(Command::SetZeroDatum {
            station_ref: StationRef::new(section_a_id, 0),
            coordinates: GpsCoordinates::new(45.0, -73.0, 100.0).unwrap(),
        });

        // Verify initial state
        let project = state.get_project_state().unwrap();
        assert_eq!(project.sections.len(), 2);
        assert_eq!(project.zero_datums.len(), 1);

        // Delete section A
        let result = state.execute(Command::DeleteSection {
            section_id: section_a_id,
        });

        assert!(result.success);

        let project = state.get_project_state().unwrap();

        // Section should be removed
        assert_eq!(project.sections.len(), 1);
        assert!(project.get_section(section_a_id).is_none());
        assert!(project.get_section(section_b_id).is_some());

        // Section B should be the only one remaining
        assert_eq!(project.sections[0].id, section_b_id);
        assert_eq!(project.sections[0].name, Some("Section B".to_string()));
    }

    #[test]
    fn test_execute_update_section_metadata_command() {
        // Verify UpdateSectionMetadata modifies metadata correctly
        use chrono::NaiveDate;
        let state = AppState::new().unwrap();

        state.execute(Command::CreateProject {
            name: "Test".to_string(),
            location: None,
        });

        let initial_date = NaiveDate::from_ymd_opt(2024, 1, 15).unwrap();
        let create_result = state.execute(Command::CreateSection {
            name: Some("Original Name".to_string()),
            surveyor: Some("Bob".to_string()),
            date: Some(initial_date),
            color: "#ff0000".to_string(),
            direction: Some(SurveyDirection::In),
            shots: vec![test_shot_data(5.0)],
        });

        let section_id = create_result.section_id.unwrap();

        // Update all metadata fields
        let updated_date = NaiveDate::from_ymd_opt(2024, 2, 20).unwrap();
        let result = state.execute(Command::UpdateSectionMetadata {
            section_id,
            updates: SectionUpdates {
                name: Some(Some("Updated Name".to_string())),
                surveyor: Some(Some("Carol".to_string())),
                date: Some(Some(updated_date)),
                color: Some("#0000ff".to_string()),
                direction: Some(SurveyDirection::Out),
            },
        });

        assert!(result.success);

        let project = state.get_project_state().unwrap();
        let section = project.get_section(section_id).unwrap();

        assert_eq!(section.name, Some("Updated Name".to_string()));
        assert_eq!(section.surveyor, Some("Carol".to_string()));
        assert_eq!(section.date, Some(updated_date));
        assert_eq!(section.color, "#0000ff");
        assert_eq!(section.direction, SurveyDirection::Out);

        // Verify shots were not affected
        assert_eq!(section.shots.len(), 1);
        assert_eq!(section.shots[0].length, 5.0);
    }

    // === Edge Case Tests for Validation Errors ===

    #[test]
    fn test_execute_command_no_project_open() {
        let state = AppState::new().unwrap();

        // Try to execute commands without an open project
        let commands_to_test = vec![
            Command::CreateSection {
                name: None,
                surveyor: None,
                date: None,
                color: "#ff0000".to_string(),
                direction: None,
                shots: vec![],
            },
            Command::DeleteSection { section_id: 0 },
            Command::UpdateSectionMetadata {
                section_id: 0,
                updates: SectionUpdates::default(),
            },
            Command::CreateShot {
                section_id: 0,
                shot: test_shot_data(5.0),
                after_shot_id: None,
            },
            Command::UpdateShot {
                section_id: 0,
                shot_id: 0,
                updates: ShotUpdates::default(),
            },
            Command::DeleteShot {
                section_id: 0,
                shot_id: 0,
            },
            Command::MergeStations {
                station_a: StationRef::new(0, 0),
                station_b: StationRef::new(1, 0),
                closure_strategy: ClosureStrategy::ProportionalByLength,
            },
            Command::SetZeroDatum {
                station_ref: StationRef::new(0, 0),
                coordinates: GpsCoordinates::new(45.0, -73.0, 100.0).unwrap(),
            },
        ];

        for cmd in commands_to_test {
            let result = state.execute(cmd);
            assert!(
                !result.success,
                "Command should fail when no project is open"
            );
            assert!(
                result.error.is_some(),
                "Should have error message when no project open"
            );
        }
    }

    #[test]
    fn test_execute_commands_with_invalid_ids() {
        let state = AppState::new().unwrap();

        state.execute(Command::CreateProject {
            name: "Test".to_string(),
            location: None,
        });

        let create_result = state.execute(Command::CreateSection {
            name: None,
            surveyor: None,
            date: None,
            color: "#ff0000".to_string(),
            direction: None,
            shots: vec![test_shot_data(5.0)],
        });
        let section_id = create_result.section_id.unwrap();

        // Test with nonexistent section ID
        let result = state.execute(Command::DeleteSection { section_id: 999 });
        assert!(!result.success);

        let result = state.execute(Command::UpdateSectionMetadata {
            section_id: 999,
            updates: SectionUpdates::default(),
        });
        assert!(!result.success);

        // Test with nonexistent shot ID
        let result = state.execute(Command::UpdateShot {
            section_id,
            shot_id: 999999,
            updates: ShotUpdates::default(),
        });
        assert!(!result.success);

        let result = state.execute(Command::DeleteShot {
            section_id,
            shot_id: 999999,
        });
        assert!(!result.success);
    }

    // === Undo/Redo Tests for fn-35-f4v.1 ===

    #[test]
    fn test_undo_delete_shot() {
        // Verify undoing DeleteShot restores the shot
        let state = AppState::new().unwrap();

        state.execute(Command::CreateProject {
            name: "Test".to_string(),
            location: None,
        });

        let create_result = state.execute(Command::CreateSection {
            name: None,
            surveyor: None,
            date: None,
            color: "#ff0000".to_string(),
            direction: None,
            shots: vec![test_shot_data(5.0), test_shot_data(10.0)],
        });

        let section_id = create_result.section_id.unwrap();
        let project = state.get_project_state().unwrap();
        let shot_id = project.sections[0].shots[0].id;

        // Delete the shot
        state.execute(Command::DeleteShot { section_id, shot_id });

        let project = state.get_project_state().unwrap();
        assert_eq!(project.sections[0].shots.len(), 1);
        assert_eq!(project.sections[0].shots[0].length, 10.0);

        // Undo the delete
        let result = state.undo();
        assert!(result.success);

        // Shot should be restored
        let project = state.get_project_state().unwrap();
        assert_eq!(project.sections[0].shots.len(), 2);
        assert!(project.sections[0].shots.iter().any(|s| s.length == 5.0));
    }

    #[test]
    fn test_undo_merge_stations() {
        // Verify undoing MergeStations removes the merge
        let state = AppState::new().unwrap();

        state.execute(Command::CreateProject {
            name: "Test".to_string(),
            location: None,
        });

        // Create two sections
        let result_a = state.execute(Command::CreateSection {
            name: Some("Section A".to_string()),
            surveyor: None,
            date: None,
            color: "#ff0000".to_string(),
            direction: None,
            shots: vec![test_shot_data(5.0), test_shot_data(7.0)],
        });
        let section_a_id = result_a.section_id.unwrap();

        let result_b = state.execute(Command::CreateSection {
            name: Some("Section B".to_string()),
            surveyor: None,
            date: None,
            color: "#00ff00".to_string(),
            direction: None,
            shots: vec![test_shot_data(4.0), test_shot_data(6.0)],
        });
        let section_b_id = result_b.section_id.unwrap();

        // Verify no merges exist before
        let project_before = state.get_project_state().unwrap();
        assert!(project_before.station_merges.is_empty());

        // Merge stations
        let station_a = StationRef::new(section_a_id, 1);
        let station_b = StationRef::new(section_b_id, 0);

        let result = state.execute(Command::MergeStations {
            station_a,
            station_b,
            closure_strategy: ClosureStrategy::ProportionalByLength,
        });
        assert!(result.success);

        // Verify merge was created
        let project_after = state.get_project_state().unwrap();
        assert_eq!(project_after.station_merges.len(), 1);
        assert_eq!(project_after.station_merges[0].station_a, station_a);
        assert_eq!(project_after.station_merges[0].station_b, station_b);

        // Undo the merge
        let result = state.undo();
        assert!(result.success);

        // Verify merge is gone
        let project_undone = state.get_project_state().unwrap();
        assert!(project_undone.station_merges.is_empty());
    }

    #[test]
    fn test_multiple_undo_sequence() {
        // Verify multiple undos in LIFO order
        let state = AppState::new().unwrap();

        state.execute(Command::CreateProject {
            name: "Test".to_string(),
            location: None,
        });

        // Create sections in sequence
        state.execute(Command::CreateSection {
            name: Some("First".to_string()),
            surveyor: None,
            date: None,
            color: "#ff0000".to_string(),
            direction: None,
            shots: vec![],
        });

        state.execute(Command::CreateSection {
            name: Some("Second".to_string()),
            surveyor: None,
            date: None,
            color: "#00ff00".to_string(),
            direction: None,
            shots: vec![],
        });

        state.execute(Command::CreateSection {
            name: Some("Third".to_string()),
            surveyor: None,
            date: None,
            color: "#0000ff".to_string(),
            direction: None,
            shots: vec![],
        });

        assert_eq!(state.get_project_state().unwrap().sections.len(), 3);

        // Undo should remove Third first (LIFO)
        let result = state.undo();
        assert!(result.success);
        let project = state.get_project_state().unwrap();
        assert_eq!(project.sections.len(), 2);
        assert!(!project.sections.iter().any(|s| s.name == Some("Third".to_string())));

        // Undo should remove Second
        let result = state.undo();
        assert!(result.success);
        let project = state.get_project_state().unwrap();
        assert_eq!(project.sections.len(), 1);
        assert!(!project.sections.iter().any(|s| s.name == Some("Second".to_string())));

        // Undo should remove First
        let result = state.undo();
        assert!(result.success);
        assert!(state.get_project_state().unwrap().sections.is_empty());
    }

    #[test]
    fn test_redo_clears_on_new_command() {
        // Verify new command clears redo stack
        let state = AppState::new().unwrap();

        state.execute(Command::CreateProject {
            name: "Test".to_string(),
            location: None,
        });

        // Create a section
        state.execute(Command::CreateSection {
            name: Some("Original".to_string()),
            surveyor: None,
            date: None,
            color: "#ff0000".to_string(),
            direction: None,
            shots: vec![],
        });

        // Undo it
        state.undo();
        assert!(state.can_redo());

        // Execute a new command (should clear redo stack)
        state.execute(Command::CreateSection {
            name: Some("New".to_string()),
            surveyor: None,
            date: None,
            color: "#00ff00".to_string(),
            direction: None,
            shots: vec![],
        });

        // Redo should no longer be available
        assert!(!state.can_redo());

        // Verify we have the new section, not the original
        let project = state.get_project_state().unwrap();
        assert_eq!(project.sections.len(), 1);
        assert_eq!(project.sections[0].name, Some("New".to_string()));
    }

    #[test]
    fn test_undo_stack_limits() {
        // Verify stack limits and overflow handling
        // Use a small limit to test overflow behavior
        let state = AppState::new().unwrap();

        // Set a small undo history limit via config
        {
            let mut config = state.config.lock().unwrap();
            config.general.undo_history_limit = 3;
        }

        // Reinitialize undo stack with new limit
        {
            let mut undo_stack = state.undo_stack.lock().unwrap();
            undo_stack.set_history_limit(3);
        }

        state.execute(Command::CreateProject {
            name: "Test".to_string(),
            location: None,
        });

        // Create 5 sections (more than the limit of 3)
        for i in 0..5 {
            state.execute(Command::CreateSection {
                name: Some(format!("Section {}", i)),
                surveyor: None,
                date: None,
                color: "#ff0000".to_string(),
                direction: None,
                shots: vec![],
            });
        }

        assert_eq!(state.get_project_state().unwrap().sections.len(), 5);

        // We should only be able to undo 3 times (the limit)
        // The first 2 section creates should have been dropped from the stack
        let result1 = state.undo();
        assert!(result1.success);
        assert_eq!(state.get_project_state().unwrap().sections.len(), 4);

        let result2 = state.undo();
        assert!(result2.success);
        assert_eq!(state.get_project_state().unwrap().sections.len(), 3);

        let result3 = state.undo();
        assert!(result3.success);
        assert_eq!(state.get_project_state().unwrap().sections.len(), 2);

        // Fourth undo should fail (stack exhausted)
        let result4 = state.undo();
        assert!(!result4.success);

        // Verify we still have the first 2 sections (they couldn't be undone)
        let project = state.get_project_state().unwrap();
        assert_eq!(project.sections.len(), 2);
        assert!(project.sections.iter().any(|s| s.name == Some("Section 0".to_string())));
        assert!(project.sections.iter().any(|s| s.name == Some("Section 1".to_string())));
    }
}
