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
    /// * `directory` - Optional directory to save in. If None, uses user's
    ///   documents `stalagmight` subdirectory.
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
            .map(|c| if c.is_ascii_alphanumeric() { c } else { '_' })
            .collect();

        // Remove leading/trailing whitespace and ensure not empty after sanitization
        let sanitized_name = sanitized_name.trim();
        if sanitized_name.is_empty() {
            return Err("Project name must contain at least one alphanumeric character".to_string());
        }

        // Determine the directory to use
        let dir = if let Some(d) = directory {
            // Validate the provided directory is a directory (or doesn't exist yet)
            if d.exists() && !d.is_dir() {
                return Err(format!("Path is not a directory: {}", d.display()));
            }
            d.clone()
        } else {
            // Default to user's documents/stalagmight directory, with fallbacks.
            // 1. app_dirs (Tauri path resolver — works on Android)
            // 2. directories crate (desktop pre-setup fallback)
            // 3. $HOME/Documents
            let documents_dir = crate::app_dirs::document_dir()
                .map(std::path::Path::to_path_buf)
                .or_else(|| {
                    directories::UserDirs::new()
                        .and_then(|ud| ud.document_dir().map(std::path::Path::to_path_buf))
                })
                .or_else(|| {
                    std::env::var("HOME")
                        .ok()
                        .map(|h| PathBuf::from(h).join("Documents"))
                })
                .ok_or_else(|| "Could not determine documents directory".to_string())?;

            let app_dir = documents_dir.join("stalagmight");

            // Ensure the app default directory exists.
            if !app_dir.exists() {
                std::fs::create_dir_all(&app_dir).map_err(|e| {
                    format!("Failed to create default project directory: {e}")
                })?;
            }

            app_dir
        };

        // Build the full path with .stalx extension
        let filename = format!("{sanitized_name}.stalx");
        let full_path = dir.join(filename);

        Ok(full_path)
    }

    /// Return an available project path by appending `_N` before the extension when needed.
    ///
    /// Examples:
    /// - `Cave.stalx` -> `Cave_1.stalx` (if `Cave.stalx` exists)
    /// - `Cave_1.stalx` -> `Cave_2.stalx` (if both previous files exist)
    fn next_available_project_path(path: &PathBuf) -> PathBuf {
        if !path.exists() {
            return path.clone();
        }
        // Treat 0-byte files as non-existent: Android's SAF (ACTION_CREATE_DOCUMENT)
        // creates an empty placeholder at the chosen path before returning.
        if path.metadata().is_ok_and(|m| m.len() == 0) {
            return path.clone();
        }

        let parent = path.parent().map(std::path::Path::to_path_buf);
        let stem = path
            .file_stem()
            .map(|s| s.to_string_lossy().to_string())
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| "project".to_string());
        let extension = path
            .extension()
            .map(|ext| ext.to_string_lossy().to_string())
            .filter(|ext| !ext.is_empty());

        let mut index: usize = 1;
        loop {
            let candidate_name = if let Some(ext) = &extension {
                format!("{stem}_{index}.{ext}")
            } else {
                format!("{stem}_{index}")
            };
            let candidate_path = if let Some(parent_dir) = &parent {
                parent_dir.join(&candidate_name)
            } else {
                PathBuf::from(&candidate_name)
            };

            if !candidate_path.exists() {
                return candidate_path;
            }

            index += 1;
        }
    }

    pub(super) fn create_project(&self, name: String, location: Option<String>) -> CommandResult {
        let project = Project::new(name, location);

        tracing::info!(
            project_name = %project.name,
            purpose = "start new project",
            "Project created in memory"
        );

        if let Ok(mut proj) = self.project.lock() {
            *proj = Some(project);
        }

        if let Ok(mut undo_stack) = self.undo_stack.lock() {
            undo_stack.clear();
        }

        // Clear display settings cache for new project
        self.clear_display_settings_cache();

        CommandResult::success()
    }

    pub(super) fn open_project(&self, path: PathBuf) -> CommandResult {
        tracing::info!(
            path = ?path,
            purpose = "resume editing",
            "Opening project file"
        );
        // Verify file exists before trying to open
        if !path.exists() {
            tracing::warn!(
                path = ?path,
                purpose = "resume editing",
                reason = "file not found",
                "Project open failed"
            );
            return CommandResult::failure(format!("File not found: {}", path.display()));
        }

        // Use open_existing which validates the file is a valid Stalagmight project
        let db = match Database::open_existing(&path) {
            Ok(db) => db,
            Err(e) => {
                tracing::error!(
                    path = ?path,
                    purpose = "resume editing",
                    reason = %e,
                    "Failed to open project database"
                );
                return CommandResult::failure(format!("{e}"));
            }
        };

        let mut project = match db.load_project() {
            Ok(p) => p,
            Err(e) => {
                tracing::error!(
                    path = ?path,
                    purpose = "resume editing",
                    reason = %e,
                    "Failed to load project data"
                );
                return CommandResult::failure(format!("Failed to load project data: {e}"));
            }
        };

        project.file_path = Some(path.clone());

        // Assign IDs to any legacy closures that have id=0
        project.assign_closure_ids();

        if let Ok(mut proj) = self.project.lock() {
            *proj = Some(project);
        }

        // Load undo/redo stacks from database before replacing database reference
        let undo_entries = match db.load_undo_stack_with_timestamps() {
            Ok(loaded) => loaded
                .into_iter()
                .map(|(_, cmd, undo, ts)| (cmd, undo, ts))
                .collect::<Vec<_>>(),
            Err(e) => {
                tracing::warn!(
                    error = %e,
                    purpose = "restore edit history",
                    "Failed to load undo stack from database; starting with empty history"
                );
                Vec::new()
            }
        };
        let redo_entries = match db.load_redo_stack_with_timestamps() {
            Ok(loaded) => loaded
                .into_iter()
                .map(|(_, cmd, undo, ts)| (cmd, undo, ts))
                .collect::<Vec<_>>(),
            Err(e) => {
                tracing::warn!(
                    error = %e,
                    purpose = "restore edit history",
                    "Failed to load redo stack from database; starting with empty redo history"
                );
                Vec::new()
            }
        };

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
                tracing::info!(
                    undo = undo_stack.len(),
                    purpose = "restore edit history",
                    "Restored undo/redo stacks from database"
                );
            }
        }

        // Add to recent projects and persist to config
        let path_display = format!("{}", path.display());
        if let Ok(mut recent) = self.recent_projects.lock() {
            recent.retain(|p| p != &path);
            recent.insert(0, path);
            if let Ok(mut config) = self.config.lock() {
                recent.truncate(config.general.recent_projects_max);
                // Update config with recent projects and save
                config.general.recent_projects.clone_from(&recent);
                if let Err(e) = config.save() {
                    tracing::warn!(
                        error = %e,
                        purpose = "persist recent projects list",
                        "Failed to save config with recent projects"
                    );
                }
            }
        }

        tracing::info!(
            path = %path_display,
            purpose = "resume editing",
            "Project opened"
        );
        CommandResult::success()
    }

    pub(super) fn save_project(&self, path: Option<PathBuf>, is_autosave: bool) -> CommandResult {
        let Ok(mut proj_guard) = self.project.lock() else {
            return CommandResult::failure("Failed to lock project".to_string());
        };

        let Some(project) = proj_guard.as_mut() else {
            return CommandResult::failure("No project open".to_string());
        };

        // Mint UUIDs for any shot still missing one (pre-v6 .stalx
        // files loaded today come back with NULL uuid columns).
        // Doing this BEFORE the SQLite write and BEFORE the sibling
        // .tml export guarantees both sides receive the same UUIDs —
        // without it, db.save_project's INSERT path would mint one set
        // of fresh UUIDs and `write_collab_sibling`'s export would mint
        // a different set, leaving the .stalx and the .tml disagreeing
        // about every shot's identity until the next reload.
        project.ensure_shot_uuids();

        // Don't let geometric corruption persist silently: a release-mode warning
        // when drifted merges are about to be written. (The frontend re-checks
        // after save and offers a repair via the integrity banner.)
        let misaligned = project.check_merge_alignment();
        if !misaligned.is_empty() {
            tracing::warn!(
                count = misaligned.len(),
                purpose = "flag misaligned merges before persisting",
                "Saving a project with drifted station merges"
            );
            for violation in &misaligned {
                tracing::warn!(category = %violation.category, "{}", violation.message);
            }
        }

        // Determine save path and ensure .stalx extension
        let is_implicit_save = path.is_none();
        let save_path = path.or_else(|| project.file_path.clone());
        let mut save_path = match save_path {
            Some(p) => {
                // Ensure .stalx extension
                if p.extension().is_none_or(|ext| ext != "stalx") {
                    p.with_extension("stalx")
                } else {
                    p
                }
            }
            None => return CommandResult::failure("No save path specified".to_string()),
        };

        // On the first implicit save (path omitted), avoid overwriting an existing file.
        // Deferred new projects can reserve a canonical path; if it now exists, auto-rename.
        let has_open_database = self
            .database
            .lock()
            .map(|db| db.is_some())
            .unwrap_or(false);
        if is_implicit_save && !has_open_database {
            let candidate_path = Self::next_available_project_path(&save_path);
            if candidate_path != save_path {
                tracing::warn!(
                    requested_path = ?save_path,
                    selected_path = ?candidate_path,
                    purpose = "avoid overwriting existing project on first implicit save",
                    "Implicit first save path already exists; using auto-renamed path"
                );
                save_path = candidate_path;
            }
        }

        // Create a temporary file path in the same directory (for atomic rename)
        let temp_path = save_path.with_extension("stalx.tmp");
        tracing::info!(
            final_path = ?save_path,
            temp_path = ?temp_path,
            purpose = "persist edits safely",
            "Starting safe save operation"
        );

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
                return CommandResult::failure(format!("Failed to create save file: {e}"));
            }
        };

        if let Err(e) = db.save_project(project) {
            // Clean up temp file on failure
            drop(db);
            let _ = std::fs::remove_file(&temp_path);
            tracing::error!(
                error = %e,
                purpose = "persist edits safely",
                "Save failed; temp file cleaned up"
            );
            return CommandResult::failure(format!("Failed to save project: {e}"));
        }

        // Copy display settings to the new database
        for (key, value) in &display_settings {
            if let Err(e) = db.save_display_setting(key, value) {
                tracing::warn!(
                    key = %key,
                    error = %e,
                    purpose = "preserve display settings on save",
                    "Failed to copy display setting"
                );
            }
        }

        // Close the database before renaming
        drop(db);

        // Atomically rename temp file to final destination
        // This is safe: if rename fails, original file is untouched
        if let Err(e) = std::fs::rename(&temp_path, &save_path) {
            let _ = std::fs::remove_file(&temp_path);
            tracing::error!(
                error = %e,
                purpose = "persist edits safely",
                "Failed to rename temp file to final destination"
            );
            return CommandResult::failure(format!("Failed to finalize save: {e}"));
        }

        // Reopen the database at the final path
        let db = match Database::open(&save_path) {
            Ok(db) => db,
            Err(e) => {
                tracing::error!(
                    error = %e,
                    purpose = "reopen saved project for continued editing",
                    "Failed to reopen saved database (file was saved successfully)"
                );
                // File was saved but can't be reopened — subsequent operations
                // (undo persistence, display settings) will fail. Clear the stale
                // database handle so callers don't use it.
                project.file_path = Some(save_path.clone());
                drop(proj_guard);
                if let Ok(mut database) = self.database.lock() {
                    *database = None;
                }
                return CommandResult::success()
                    .with_warning("File saved, but database could not be reopened. Some features may not work until the project is reopened.");
            }
        };

        // Persist undo/redo stacks (best-effort, synchronous to avoid race with readers)
        let persist_limit = self
            .config
            .lock()
            .map(|c| c.general.undo_persist_limit)
            .unwrap_or(20);

        if let Ok(undo_stack) = self.undo_stack.lock() {
            let undo_entries: Vec<_> = undo_stack
                .entries_to_persist(persist_limit)
                .filter_map(UndoStack::serialize_entry_with_timestamp)
                .collect();
            let redo_entries: Vec<_> = undo_stack
                .redo_entries_to_persist(persist_limit)
                .filter_map(UndoStack::serialize_entry_with_timestamp)
                .collect();

            if let Err(e) = db.save_undo_stack_with_timestamps(undo_entries) {
                tracing::warn!(
                    error = %e,
                    purpose = "preserve undo history",
                    "Failed to persist undo stack"
                );
            }
            if let Err(e) = db.save_redo_stack_with_timestamps(redo_entries) {
                tracing::warn!(
                    error = %e,
                    purpose = "preserve redo history",
                    "Failed to persist redo stack"
                );
            }
        }

        // Update file path after successful save
        project.file_path = Some(save_path.clone());

        // Collaboration mode: also write the sibling .tml and refresh the
        // baseline. Best-effort — never fail the .stalx save if this
        // fails.  Autosaves honour `CollabState.write_tml_on_autosave`
        // — when that flag is `false` we skip the .tml rewrite on
        // background saves so the file Ariane is editing doesn't churn
        // every 30 seconds; manual / explicit saves always rewrite.
        let collab_writes_tml = project.collab.as_ref().is_some_and(|c| {
            c.enabled && (!is_autosave || c.write_tml_on_autosave)
        });
        let mut collab_sibling_error: Option<String> = None;
        if collab_writes_tml {
            if let Err(e) = Self::write_collab_sibling(project, &save_path, &db) {
                tracing::warn!(
                    error = %e,
                    purpose = "write collaborator .tml on save",
                    "Saved .stalx but failed to write sibling .tml"
                );
                collab_sibling_error = Some(e.to_string());
            }
        }

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
                config.general.recent_projects.clone_from(&recent);
                if let Err(e) = config.save() {
                    tracing::warn!(
                        error = %e,
                        purpose = "persist recent projects list",
                        "Failed to save config with recent projects"
                    );
                }
            }
        }

        let save_path_str = save_path.display().to_string();
        tracing::info!(
            path = ?save_path,
            purpose = "persist edits safely",
            "Project saved successfully"
        );
        let mut result = CommandResult::success().with_path(save_path_str);
        // Surface a partial-save warning when the .stalx persisted but the
        // sibling .tml didn't.  Without this the UI shows a green checkmark
        // even though the collaborator's copy is now stale, so they keep
        // editing data the Stalagmight user already replaced.
        if let Some(err) = collab_sibling_error {
            result.warnings.push(crate::core::ValidationWarning {
                code: "COLLAB_SIBLING_WRITE_FAILED".to_string(),
                message: format!(
                    "Saved the .stalx but the companion .tml could not be written ({err}); the file Ariane is editing is now out of date.",
                ),
                severity: crate::core::WarningSeverity::Warning,
            });
        }
        result
    }

    /// Write the sibling `.tml` for collaboration mode and refresh the stored
    /// baseline + content hash on the (already-open) project database.
    fn write_collab_sibling(
        project: &mut Project,
        save_path: &std::path::Path,
        db: &Database,
    ) -> Result<()> {
        // Always derive the sibling name from the current .stalx stem so the
        // companion .tml tracks the project file even if collaboration was
        // enabled before the project had a path (or the file was renamed).
        let sibling_name = save_path
            .file_stem()
            .map(|s| format!("{}.tml", s.to_string_lossy()))
            .unwrap_or_else(|| "collaboration.tml".to_string());
        let sibling = match save_path.parent() {
            Some(dir) => dir.join(&sibling_name),
            None => PathBuf::from(&sibling_name),
        };

        let (baseline, sha, synthetic_section_names) =
            crate::export::tml::export_tml_with_baseline(project, &sibling)?;

        // One (section_name -> id) entry per project section.  Includes
        // sections with NO baseline shots (e.g. an empty root section that
        // only had a START before any real measurements) so that if a
        // collaborator adds the first shots to such a section in Ariane,
        // the returned shots' section_name still matches the existing
        // SectionId via the name-map fallback, and reconcile fills the
        // existing section instead of creating a duplicate.  The exporter's
        // section_name string (used in the baseline) follows the same
        // fallback so the empty-section entries here use a matching key.
        let mut section_name_map = Vec::new();
        for section in &project.sections {
            let name = section
                .name
                .clone()
                .unwrap_or_else(|| format!("Section {}", section.id));
            section_name_map.push((name, section.id));
        }

        if let Some(c) = project.collab.as_mut() {
            c.sibling_tml_relative = sibling_name;
            c.last_export_tml_sha256 = Some(sha);
            c.shot_baseline = baseline;
            c.section_name_map = section_name_map;
            c.synthetic_section_names = synthetic_section_names;
        }

        db.save_collab_state(project.collab.as_ref())?;
        Ok(())
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

        tracing::info!(
            purpose = "release project resources",
            "Project closed"
        );
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
        let mut merged_project = Project::new(output_name, None);

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
                } else {
                    tracing::warn!(
                        project = %source_project.name,
                        section_id = old_section_id,
                        purpose = "merge section offsets",
                        "Section offset references unknown section ID; skipping"
                    );
                }
            }

            // Copy station offsets with remapped section IDs
            for (old_station_ref, offset) in &source_project.station_offsets {
                if let Some(&new_section_id) = section_id_map.get(&(proj_idx, old_station_ref.section_id)) {
                    let new_station_ref = StationRef::new(new_section_id, old_station_ref.station_index);
                    merged_project.station_offsets.insert(new_station_ref, *offset);
                } else {
                    tracing::warn!(
                        project = %source_project.name,
                        section_id = old_station_ref.section_id,
                        purpose = "merge station offsets",
                        "Station offset references unknown section ID; skipping"
                    );
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
                } else {
                    tracing::warn!(
                        project = %source_project.name,
                        section_id = zd.station_ref.section_id,
                        purpose = "merge zero datums",
                        "Zero datum references unknown section ID; skipping"
                    );
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
                } else {
                    tracing::warn!(
                        project = %source_project.name,
                        station_a_section = merge.station_a.section_id,
                        station_b_section = merge.station_b.section_id,
                        purpose = "merge station merges",
                        "Station merge references unknown section ID; skipping"
                    );
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
                } else {
                    tracing::warn!(
                        project = %source_project.name,
                        station_a_section = closure.station_a.section_id,
                        station_b_section = closure.station_b.section_id,
                        purpose = "merge loop closures",
                        "Loop closure references unknown section ID; skipping"
                    );
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

        // Direct pushes to station_merges above (line ~685) bypassed
        // Project::record_station_merge, so the adjacency cache is
        // empty and out of step with the populated merges vec.
        // Rebuild now so the next get_merged_section_ids on the freshly
        // merged project takes the O(group) fast path.
        merged_project.rebuild_merge_adjacency();

        // Set the output file path
        merged_project.file_path = Some(output_path.clone());

        // Ensure .stalx extension
        let output_path = if output_path.extension().is_none_or(|ext| ext != "stalx") {
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
                return CommandResult::failure(format!("Failed to create output file: {e}"));
            }
        };

        if let Err(e) = db.save_project(&merged_project) {
            drop(db);
            let _ = std::fs::remove_file(&temp_path);
            return CommandResult::failure(format!("Failed to save merged project: {e}"));
        }

        // Close database before rename
        drop(db);

        // Atomically rename temp file to final destination
        if let Err(e) = std::fs::rename(&temp_path, &output_path) {
            let _ = std::fs::remove_file(&temp_path);
            return CommandResult::failure(format!("Failed to finalize save: {e}"));
        }

        tracing::info!(
            output = ?output_path,
            section_count = merged_project.sections.len(),
            purpose = "combine projects into single file",
            "Projects merged successfully"
        );

        // Archive original files if requested
        if archive_originals {
            for source_path in &source_paths {
                if let Err(e) = Self::archive_project_file(source_path) {
                    tracing::warn!(
                        path = ?source_path,
                        error = %e,
                        purpose = "archive source projects after merge",
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
            purpose = "archive source project after merge",
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

        tracing::info!(
            path = ?path,
            purpose = "load project for workspace",
            "Starting full project load"
        );

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
                let msg = e.to_string();
                // Detect corruption-specific errors and return CORRUPT code
                // so the frontend can offer recovery options
                if msg.contains("integrity check failed") || msg.contains("corrupted") {
                    early_return_err!(LoadError::corrupt(msg, &path.display().to_string()));
                }
                early_return_err!(LoadError::new("DATABASE", msg));
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
        // Pre-compute the expected station total so the UI can show a real
        // progress bar from the start of this phase. Otherwise the first
        // ~second of the phase (build_colocated_groups + station_depths)
        // shows an indeterminate spinner — the per-station callback only
        // fires once the main walk begins.
        let expected_station_total: u32 = project
            .sections
            .iter()
            .map(|s| s.shots.len() as u32 + 1)
            .sum();
        progress.update_phase(LoadingPhase::ComputingStations, 0, expected_station_total);
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

        // Surface corruption present on disk (older versions / external edits /
        // a missed offset cascade): both dangling references and drifted merges.
        // The frontend re-checks after load and offers a repair; here we just
        // record it. (#17, merge-misalignment)
        let mut integrity = project.check_structural_integrity();
        integrity.extend(project.check_merge_alignment());
        if !integrity.is_empty() {
            tracing::warn!(
                count = integrity.len(),
                purpose = "flag corruption on load",
                "Loaded project has integrity violations"
            );
            for violation in &integrity {
                tracing::warn!(category = %violation.category, "{}", violation.message);
            }
        }

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
        let undo_entries = match db.load_undo_stack_with_timestamps() {
            Ok(loaded) => loaded
                .into_iter()
                .map(|(_, cmd, undo, ts)| (cmd, undo, ts))
                .collect::<Vec<_>>(),
            Err(e) => {
                tracing::warn!(
                    error = %e,
                    purpose = "restore edit history",
                    "Failed to load undo stack from database; starting with empty history"
                );
                Vec::new()
            }
        };
        let redo_entries = match db.load_redo_stack_with_timestamps() {
            Ok(loaded) => loaded
                .into_iter()
                .map(|(_, cmd, undo, ts)| (cmd, undo, ts))
                .collect::<Vec<_>>(),
            Err(e) => {
                tracing::warn!(
                    error = %e,
                    purpose = "restore edit history",
                    "Failed to load redo stack from database; starting with empty redo history"
                );
                Vec::new()
            }
        };

        // All finalization commits use unwrap_or_else(PoisonError::into_inner) to ensure
        // data is written even if a previous panic poisoned a mutex. This is acceptable
        // during finalization because the alternative (silently skipping) leads to
        // inconsistent state that is harder to diagnose.

        // Commit 1: Project state mutation
        *self.project.lock().unwrap_or_else(std::sync::PoisonError::into_inner) = Some(project.clone());

        // Commit 2: Database handle mutation
        *self.database.lock().unwrap_or_else(std::sync::PoisonError::into_inner) = Some(db);

        // Commit 3: Display settings cache clear
        self.clear_display_settings_cache();

        // Commit 4: Undo/redo stack restore
        {
            let mut undo_stack = self.undo_stack.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
            if undo_entries.is_empty() && redo_entries.is_empty() {
                undo_stack.clear();
            } else {
                undo_stack.load_from_persisted_with_timestamps(undo_entries, redo_entries);
                tracing::info!(
                    undo = undo_stack.len(),
                    purpose = "restore edit history",
                    "Restored undo/redo stacks from database"
                );
            }
        }

        // Commit 5: Recent projects update
        {
            let mut recent = self.recent_projects.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
            recent.retain(|p| p != &path);
            recent.insert(0, path.clone());
            if let Ok(mut config) = self.config.lock() {
                recent.truncate(config.general.recent_projects_max);
                config.general.recent_projects.clone_from(&recent);
                if let Err(e) = config.save() {
                    tracing::warn!(
                        error = %e,
                        purpose = "persist recent projects list",
                        "Failed to save config with recent projects"
                    );
                }
            }
        }

        progress.complete_phase(LoadingPhase::Finalizing);

        // Get loading_id before clearing token
        let loading_id = progress.loading_id();

        // Clear active load AFTER all mutations and computations complete
        self.clear_active_load(&cancel_token);

        tracing::info!(
            path = ?path,
            purpose = "load project for workspace",
            "Project loaded via load_project_full"
        );

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
    /// 1. CreatingDatabase (40%) - Resolve/create SQLite file path
    /// 2. InitializingProject (40%) - Create project record
    /// 3. SavingSettings (20%) - Save default display settings
    ///
    /// All phases are indeterminate since creation is typically fast.
    ///
    /// # Arguments
    /// * `name` - Project name (used for filename and project metadata)
    /// * `project_location` - Optional cave location metadata (free text)
    /// * `save_directory` - Optional directory to save the project in.
    ///   If omitted (and `save_path` is omitted), uses user's documents
    ///   `stalagmight` subdirectory.
    /// * `save_path` - Optional full file path for the new project. If provided,
    ///   this takes precedence over `save_directory`.
    /// * `defer_initial_save` - When true, reserve `project.file_path` but do not
    ///   create/write the project file yet. First save/autosave will create it.
    pub fn do_create_project_full(
        &self,
        name: String,
        project_location: Option<String>,
        save_directory: Option<PathBuf>,
        save_path: Option<PathBuf>,
        defer_initial_save: bool,
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

        // Resolve database path from explicit save path or from project name + optional save directory.
        let mut db_path = if let Some(path) = save_path {
            if path.extension().is_none_or(|ext| ext != "stalx") {
                path.with_extension("stalx")
            } else {
                path
            }
        } else {
            match self.resolve_project_path(&name, save_directory.as_ref()) {
                Ok(path) => path,
                Err(e) => {
                    early_return_err!(LoadError::new("IO", e));
                }
            }
        };

        // Avoid collisions by selecting the next available path instead of overwriting.
        let available_db_path = Self::next_available_project_path(&db_path);
        if available_db_path != db_path {
            tracing::warn!(
                requested_path = ?db_path,
                selected_path = ?available_db_path,
                purpose = "avoid overwriting existing project on create",
                "Project path already exists; using auto-renamed path"
            );
            db_path = available_db_path;
        }

        // Create parent directories if they don't exist
        if let Some(parent) = db_path.parent() {
            if !parent.exists() {
                if let Err(e) = std::fs::create_dir_all(parent) {
                    early_return_err!(LoadError::new(
                        "IO",
                        format!("Failed to create directory: {e}")
                    ));
                }
            }
        }

        // Create the database only when immediate persistence is requested.
        let mut db = if defer_initial_save {
            None
        } else {
            match Database::open(&db_path) {
                Ok(db) => Some(db),
                Err(e) => {
                    early_return_err!(LoadError::new("DATABASE", format!("Failed to create database: {e}")));
                }
            }
        };
        check_cancelled!();
        progress.complete_phase(LoadingPhase::CreatingDatabase);

        // === PHASE 1: Initializing project (40%) ===
        progress.start_phase(LoadingPhase::InitializingProject);
        let mut project = Project::new(name.clone(), project_location);
        project.file_path = Some(db_path.clone());

        if let Some(ref mut database) = db {
            if let Err(e) = database.save_project(&project) {
                early_return_err!(LoadError::new("DATABASE", format!("Failed to save project: {e}")));
            }
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
            ("showReferenceShots", display_settings.show_reference_shots.to_string()),
            ("showZeroDatum", display_settings.show_zero_datum.to_string()),
            ("showGrid", display_settings.show_grid.to_string()),
            ("showScaleBar", display_settings.show_scale_bar.to_string()),
            ("showSatellite", display_settings.show_satellite.to_string()),
            ("showDepthGradient", display_settings.show_depth_gradient.to_string()),
            ("gridSpacing", display_settings.grid_spacing.to_string()),
        ];

        if let Some(ref mut database) = db {
            for (key, value) in &settings_map {
                if let Err(e) = database.save_display_setting(key, value) {
                    // Fail the command if display settings can't be saved - this indicates a real DB error
                    early_return_err!(LoadError::new(
                        "DATABASE",
                        format!("Failed to save display setting {key}: {e}")
                    ));
                }
            }
        }
        check_cancelled!();
        progress.complete_phase(LoadingPhase::SavingSettings);

        // === FINALIZE: Store in AppState (NON-CANCELLABLE STATE COMMIT) ===
        // Allow cancellation only before any state mutation occurs.
        check_cancelled!();
        // All finalization commits use unwrap_or_else(PoisonError::into_inner) to ensure
        // data is written even if a previous panic poisoned a mutex.

        // Commit 1: Project state mutation
        *self.project.lock().unwrap_or_else(std::sync::PoisonError::into_inner) = Some(project.clone());

        // Commit 2: Database handle mutation
        *self.database.lock().unwrap_or_else(std::sync::PoisonError::into_inner) = db;

        // Commit 3: Clear undo stack (new project)
        self.undo_stack.lock().unwrap_or_else(std::sync::PoisonError::into_inner).clear();

        // Commit 4: Display settings cache
        if defer_initial_save {
            let mut cache = self.display_settings_cache.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
            cache.clear();
            for (key, value) in &settings_map {
                cache.insert((*key).to_string(), value.clone());
            }
        } else {
            self.clear_display_settings_cache();
        }

        // Commit 5: Add to recent projects only after a real file exists.
        if !defer_initial_save {
            let mut recent = self.recent_projects.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
            recent.retain(|p| p != &db_path);
            recent.insert(0, db_path.clone());
            if let Ok(mut config) = self.config.lock() {
                recent.truncate(config.general.recent_projects_max);
                config.general.recent_projects.clone_from(&recent);
                if let Err(e) = config.save() {
                    tracing::warn!(
                        error = %e,
                        purpose = "persist recent projects list",
                        "Failed to save config with recent projects"
                    );
                }
            }
        }

        // Get loading_id before clearing token
        let loading_id = progress.loading_id();

        // Clear active load AFTER all mutations complete
        self.clear_active_load(&cancel_token);

        tracing::info!(
            path = ?db_path,
            name = %name,
            purpose = if defer_initial_save { "create new project in memory with reserved save path" } else { "create new project on disk" },
            "Project created via create_project_full"
        );

        Ok(CreateProjectFullResult {
            loading_id,
            project,
            display_settings,
        })
    }
}

#[cfg(test)]
#[expect(clippy::unwrap_used, clippy::expect_used)]
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
            "expected sanitized filename, got {filename}"
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

    #[test]
    fn resolve_project_path_whitespace_only_name() {
        let state = AppState::new().unwrap();
        let temp_dir = TempDir::new().unwrap();
        let err = state
            .resolve_project_path("   ", Some(&temp_dir.path().to_path_buf()))
            .expect_err("whitespace-only name should fail");
        assert!(err.contains("cannot be empty"), "got: {err}");
    }

    #[test]
    fn resolve_project_path_non_alphanumeric_only() {
        let state = AppState::new().unwrap();
        let temp_dir = TempDir::new().unwrap();
        // Non-alphanumeric chars get replaced with '_', but '_' passes sanitization.
        // The sanitizer only rejects empty-after-trim. Characters like '@' → '_' survive.
        let resolved = state
            .resolve_project_path("@#$%^&", Some(&temp_dir.path().to_path_buf()))
            .unwrap();
        let filename = resolved.file_name().unwrap().to_str().unwrap();
        assert_eq!(filename, "______.stalx", "special chars should be replaced with underscores");
    }

    #[test]
    fn resolve_project_path_default_directory() {
        let state = AppState::new().unwrap();
        let result = state.resolve_project_path("TestProject", None);
        assert!(result.is_ok(), "should resolve with default dir: {:?}", result.err());
        let path = result.unwrap();
        // Must be absolute: a relative default (e.g. "./stalagmight/...") breaks
        // saving. Regression guard for app_dirs::document_dir() returning "."
        // instead of None and short-circuiting the $HOME/Documents fallback.
        assert!(path.is_absolute(), "default project path must be absolute: {}", path.display());
        assert_eq!(path.file_name().unwrap().to_str().unwrap(), "TestProject.stalx");
        let parent = path.parent().expect("default path should have parent");
        assert_eq!(parent.file_name().unwrap().to_str().unwrap(), "stalagmight");
    }

    #[test]
    fn resolve_project_path_replaces_spaces_and_symbols_with_underscores() {
        let state = AppState::new().unwrap();
        let temp_dir = TempDir::new().unwrap();
        let resolved = state
            .resolve_project_path("My Cave-2024", Some(&temp_dir.path().to_path_buf()))
            .unwrap();
        let filename = resolved.file_name().unwrap().to_str().unwrap();
        assert_eq!(filename, "My_Cave_2024.stalx");
    }

    #[test]
    fn resolve_project_path_creates_nonexistent_default_dir() {
        let state = AppState::new().unwrap();
        // Use the default directory path (None) — should succeed even if
        // the app documents subdirectory needs to be created.
        let result = state.resolve_project_path("CreateDirTest", None).unwrap();
        let parent = result.parent().expect("default path should have parent");
        assert!(parent.exists(), "default app directory should exist");
        assert_eq!(parent.file_name().unwrap().to_str().unwrap(), "stalagmight");
    }

    #[test]
    fn next_available_project_path_adds_incrementing_suffix() {
        let temp_dir = TempDir::new().unwrap();
        let base_path = temp_dir.path().join("Collision.stalx");
        let first_suffix = temp_dir.path().join("Collision_1.stalx");

        std::fs::write(&base_path, b"base").unwrap();
        std::fs::write(&first_suffix, b"first").unwrap();

        let available = AppState::next_available_project_path(&base_path);
        assert_eq!(available, temp_dir.path().join("Collision_2.stalx"));
    }
}
