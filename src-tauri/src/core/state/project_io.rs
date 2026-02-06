use anyhow::Result;
use std::path::PathBuf;
use std::sync::Arc;

use crate::core::{CommandResult, UndoStack};
use crate::models::{Project, SectionId, StationRef};
use crate::persistence::Database;

use super::AppState;

impl AppState {
    /// Resolve the project file path from a name and optional directory.
    /// Sanitizes the name and ensures .stalx extension.
    ///
    /// # Arguments
    /// * `name` - Project name (will be sanitized for filesystem use)
    /// * `directory` - Optional directory to save in. If None, uses user's documents directory.
    ///
    /// # Returns
    /// The full path to the project file (e.g., `/path/to/dir/ProjectName.stalx`)
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

        // Build the full path with .stalx extension
        let filename = format!("{}.stalx", sanitized_name);
        let full_path = dir.join(filename);

        Ok(full_path)
    }

    pub(super) fn create_project(&self, name: String, location: Option<String>) -> CommandResult {
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

    pub(super) fn open_project(&self, path: PathBuf) -> CommandResult {
        // Verify file exists before trying to open
        if !path.exists() {
            return CommandResult::failure(format!("File not found: {}", path.display()));
        }

        // Use open_existing which validates the file is a valid Stalagmight project
        let db = match Database::open_existing(&path) {
            Ok(db) => db,
            Err(e) => return CommandResult::failure(format!("{}", e)),
        };

        let mut project = match db.load_project() {
            Ok(p) => p,
            Err(e) => return CommandResult::failure(format!("Failed to load project data: {}", e)),
        };

        project.file_path = Some(path.clone());

        // Assign IDs to any legacy closures that have id=0
        project.assign_closure_ids();

        if let Ok(mut proj) = self.project.lock() {
            *proj = Some(project);
        }

        // Load undo/redo stacks from database before replacing database reference
        let loaded_undo = db.load_undo_stack_with_timestamps().unwrap_or_default();
        let undo_entries: Vec<_> = loaded_undo
            .into_iter()
            .map(|(_, cmd, undo, ts)| (cmd, undo, ts))
            .collect();
        let loaded_redo = db.load_redo_stack_with_timestamps().unwrap_or_default();
        let redo_entries: Vec<_> = loaded_redo
            .into_iter()
            .map(|(_, cmd, undo, ts)| (cmd, undo, ts))
            .collect();

        if let Ok(mut database) = self.database.lock() {
            *database = Some(db);
        }

        // Clear display settings cache (settings will be loaded from DB by frontend)
        self.clear_display_settings_cache();

        // Restore persisted undo/redo stacks
        if let Ok(mut undo_stack) = self.undo_stack.lock() {
            if undo_entries.is_empty() && redo_entries.is_empty() {
                undo_stack.clear();
            } else {
                undo_stack.load_from_persisted_with_timestamps(undo_entries, redo_entries);
                tracing::info!(undo = undo_stack.len(), "Restored undo/redo stacks from database");
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

    pub(super) fn save_project(&self, path: Option<PathBuf>) -> CommandResult {
        let mut proj_guard = match self.project.lock() {
            Ok(g) => g,
            Err(_) => return CommandResult::failure("Failed to lock project".to_string()),
        };

        let project = match proj_guard.as_mut() {
            Some(p) => p,
            None => return CommandResult::failure("No project open".to_string()),
        };

        // Determine save path and ensure .stalx extension
        let save_path = path.or_else(|| project.file_path.clone());
        let save_path = match save_path {
            Some(p) => {
                // Ensure .stalx extension
                if p.extension().map_or(true, |ext| ext != "stalx") {
                    p.with_extension("stalx")
                } else {
                    p
                }
            }
            None => return CommandResult::failure("No save path specified".to_string()),
        };

        // Create a temporary file path in the same directory (for atomic rename)
        let temp_path = save_path.with_extension("stalx.tmp");
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

        // Persist undo/redo stacks to database (with timestamps)
        let persist_limit = self
            .config
            .lock()
            .map(|c| c.general.undo_persist_limit)
            .unwrap_or(20);

        if let Ok(undo_stack) = self.undo_stack.lock() {
            let undo_entries: Vec<_> = undo_stack
                .entries_to_persist(persist_limit)
                .filter_map(|e| UndoStack::serialize_entry_with_timestamp(e))
                .collect();

            if let Err(e) = db.save_undo_stack_with_timestamps(undo_entries) {
                tracing::warn!(error = %e, "Failed to persist undo stack (project was saved)");
            }

            let redo_entries: Vec<_> = undo_stack
                .redo_entries_to_persist(persist_limit)
                .filter_map(|e| UndoStack::serialize_entry_with_timestamp(e))
                .collect();

            if let Err(e) = db.save_redo_stack_with_timestamps(redo_entries) {
                tracing::warn!(error = %e, "Failed to persist redo stack (project was saved)");
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

    pub(super) fn close_project(&self) -> CommandResult {
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

    /// Merge multiple projects into a new project file
    /// This creates a NEW output file, appends all sections with renumbered IDs,
    /// keeps all zero datums, and optionally archives the original files.
    pub(super) fn merge_projects(
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
                        // Assign IDs to any legacy closures that have id=0
                        project.assign_closure_ids();
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

            // Copy station offsets with remapped section IDs
            for (old_station_ref, offset) in &source_project.station_offsets {
                if let Some(&new_section_id) = section_id_map.get(&(proj_idx, old_station_ref.section_id)) {
                    let new_station_ref = StationRef::new(new_section_id, old_station_ref.station_index);
                    merged_project.station_offsets.insert(new_station_ref, *offset);
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
                        id: 0, // Reset to 0; assign_closure_ids() will reassign unique IDs
                        station_a: new_station_a,
                        station_b: new_station_b,
                        path_length: closure.path_length,
                        misclosure_distance: closure.misclosure_distance,
                        error_percentage: closure.error_percentage,
                        horizontal_misclosure: closure.horizontal_misclosure,
                        vertical_misclosure: closure.vertical_misclosure,
                        strategy: closure.strategy,
                        is_aligned: closure.is_aligned,
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

        // Reassign closure IDs to ensure uniqueness across merged sources
        merged_project.assign_closure_ids();

        // Set the output file path
        merged_project.file_path = Some(output_path.clone());

        // Ensure .stalx extension
        let output_path = if output_path.extension().map_or(true, |ext| ext != "stalx") {
            output_path.with_extension("stalx")
        } else {
            output_path
        };

        // Save the merged project using safe save pattern (temp file + atomic rename)
        let temp_path = output_path.with_extension("stalx.tmp");

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
        // Create archive filename: original.stalx -> original.stalx.archived
        // If archived file exists, add timestamp: original.stalx.archived.20260117_123456
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

    /// Load a project with full progress reporting.
    /// This is the main implementation used by load_project_full command.
    ///
    /// All computation happens locally, then state is committed at the end.
    /// Cancellation is honored up to finalization; once finalization begins, it is
    /// non-cancellable to avoid partial AppState updates.
    pub fn do_load_project_full(
        &self,
        path: PathBuf,
    ) -> Result<crate::core::loading::LoadProjectFullResult, crate::core::loading::LoadError> {
        use crate::core::loading::{
            DisplaySettings, LoadError, LoadProjectFullResult, LoadingPhase, ProgressEmitter,
        };

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
        // Assign IDs to any legacy closures that have id=0
        project.assign_closure_ids();
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

        // === PHASE 7: Finalizing (10%) - NON-CANCELLABLE STATE COMMIT ===
        progress.start_phase(LoadingPhase::Finalizing);
        // Allow cancellation only before any state mutation occurs.
        check_cancelled!();

        // Load undo/redo stacks from database BEFORE storing db
        let loaded_undo = db.load_undo_stack_with_timestamps().unwrap_or_default();
        let undo_entries: Vec<_> = loaded_undo
            .into_iter()
            .map(|(_, cmd, undo, ts)| (cmd, undo, ts))
            .collect();
        let loaded_redo = db.load_redo_stack_with_timestamps().unwrap_or_default();
        let redo_entries: Vec<_> = loaded_redo
            .into_iter()
            .map(|(_, cmd, undo, ts)| (cmd, undo, ts))
            .collect();

        // Commit 1: Project state mutation
        *self.project.lock().unwrap() = Some(project.clone());

        // Commit 2: Database handle mutation
        *self.database.lock().unwrap() = Some(db);

        // Commit 3: Display settings cache clear
        self.clear_display_settings_cache();

        // Commit 4: Undo/redo stack restore
        if let Ok(mut undo_stack) = self.undo_stack.lock() {
            if undo_entries.is_empty() && redo_entries.is_empty() {
                undo_stack.clear();
            } else {
                undo_stack.load_from_persisted_with_timestamps(undo_entries, redo_entries);
                tracing::info!(undo = undo_stack.len(), "Restored undo/redo stacks from database");
            }
        }

        // Commit 5: Recent projects update
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
    ) -> Result<crate::core::loading::CreateProjectFullResult, crate::core::loading::LoadError> {
        use crate::core::loading::{
            CreateProjectFullResult, DisplaySettings, LoadError, LoadingPhase, ProgressEmitter,
        };

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

        // === FINALIZE: Store in AppState (NON-CANCELLABLE STATE COMMIT) ===
        // Allow cancellation only before any state mutation occurs.
        check_cancelled!();
        // Commit 1: Project state mutation
        *self.project.lock().unwrap() = Some(project.clone());

        // Commit 2: Database handle mutation
        *self.database.lock().unwrap() = Some(db);

        // Commit 3: Clear undo stack (new project)
        if let Ok(mut undo_stack) = self.undo_stack.lock() {
            undo_stack.clear();
        }

        // Commit 4: Display settings cache clear
        self.clear_display_settings_cache();

        // Commit 5: Add to recent projects
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
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn resolve_project_path_sanitizes_and_validates() {
        let state = AppState::new().unwrap();
        let temp_dir = TempDir::new().unwrap();

        let resolved = state
            .resolve_project_path("New/Project?Name", Some(&temp_dir.path().to_path_buf()))
            .expect("resolve path");
        assert_eq!(resolved.parent(), Some(temp_dir.path()));
        assert_eq!(
            resolved.extension().and_then(|ext| ext.to_str()),
            Some("stalx")
        );
        let filename = resolved.file_name().unwrap_or_default().to_string_lossy();
        assert!(
            filename.contains("New_Project_Name"),
            "expected sanitized filename, got {}",
            filename
        );

        let err = state
            .resolve_project_path("", Some(&temp_dir.path().to_path_buf()))
            .expect_err("empty name should fail");
        assert!(err.contains("Project name cannot be empty"));

        let file = tempfile::NamedTempFile::new().unwrap();
        let err = state
            .resolve_project_path("Valid", Some(&file.path().to_path_buf()))
            .expect_err("file path should be rejected");
        assert!(err.contains("Path is not a directory"));
    }
}
