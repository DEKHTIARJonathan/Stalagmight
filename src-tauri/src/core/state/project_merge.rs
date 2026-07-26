use super::project_io::save_failure;
use super::AppState;
use crate::core::CommandResult;
use crate::models::{Project, SectionId, StationKey, StationRef};
use crate::persistence::Database;
use std::path::PathBuf;

impl AppState {
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
            return CommandResult::failure(
                "At least two projects are required for merge".to_string(),
            );
        }

        // Normalize the `.stalx` extension FIRST so the existence check below and
        // the stored `file_path` both refer to the actual on-disk file. An
        // extension-less `output_path` (e.g. `foo`) otherwise slips past an
        // existing `foo.stalx` and leaves `file_path` pointing at a path that
        // doesn't match what's written (#169).
        let output_path = if output_path.extension().is_none_or(|ext| ext != "stalx") {
            output_path.with_extension("stalx")
        } else {
            output_path
        };

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
                return CommandResult::failure(format!(
                    "Source file not found: {}",
                    path.display()
                ));
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

        // Create a new merged project; seed validation from the global config
        // (the "defaults for new projects", #57) rather than the hardcoded default.
        let mut merged_project = Project::new(output_name, None);
        merged_project.validation = self.get_config().validation;

        // Track section ID remapping: (old_project_idx, old_section_id) -> new_section_id
        let mut section_id_map: std::collections::HashMap<(usize, SectionId), SectionId> =
            std::collections::HashMap::new();

        // Shot UUIDs already placed in the merged project. Shots carry a stable
        // collaboration UUID that cross-references and Ariane matching anchor on;
        // preserve it across the merge instead of re-minting. Two source files can
        // legitimately share a UUID (one branched from the other), so dedup
        // globally - a colliding UUID keeps a fresh mint to stay unique.
        let mut seen_uuids: std::collections::HashSet<String> = std::collections::HashSet::new();

        // Bulk external ingest is the one path that can add sections faster than
        // the per-command cap in create_section: combining N individually valid
        // projects can exceed MAX_SECTION_ID even though none of them did. Past
        // that bound a section's shot-id band collides with another's, and shot
        // ids are immutable FKs for merges, closures and comments.
        let total_sections: usize = source_projects.iter().map(|p| p.sections.len()).sum();
        if total_sections > crate::models::MAX_SECTION_ID as usize + 1 {
            return CommandResult::failure(format!(
                "Merged project would exceed the maximum number of sections (limit = {}, requested = {total_sections})",
                crate::models::MAX_SECTION_ID as u64 + 1
            ));
        }

        // Append sections from all projects
        for (proj_idx, source_project) in source_projects.iter().enumerate() {
            for section in &source_project.sections {
                let old_section_id = section.id;
                let new_section_id = merged_project.next_section_id;

                // Clone section data and add to merged project. add_section mints
                // fresh UUIDs for every shot; restore each source shot's UUID (in
                // order) so identity survives the merge, deduping across all
                // sources to guarantee uniqueness within the merged project.
                let section_data = section.to_section_data();
                // Unreachable: the total-count preflight above runs before any
                // section is appended. Handled so a future change to that check
                // surfaces as a clean failure rather than a silent short merge.
                if let Err(e) = merged_project.add_section(section_data) {
                    return CommandResult::failure(e);
                }
                let source_uuids: Vec<Option<String>> =
                    section.shots.iter().map(|s| s.uuid.clone()).collect();
                if let Some(new_section) = merged_project.get_section_mut(new_section_id) {
                    for (new_shot, src_uuid) in new_section.shots.iter_mut().zip(source_uuids) {
                        let final_uuid = match src_uuid {
                            Some(u) if !seen_uuids.contains(&u) => Some(u),
                            Some(dup) => {
                                tracing::warn!(
                                    project = %source_project.name,
                                    uuid = %dup,
                                    purpose = "merge shot uuid dedup",
                                    "Duplicate shot UUID across merged projects; re-minting to keep identities unique"
                                );
                                new_shot.uuid.clone() // fresh mint from add_section
                            }
                            None => new_shot.uuid.clone(), // pre-v6 shot: keep fresh mint
                        };
                        if let Some(u) = &final_uuid {
                            seen_uuids.insert(u.clone());
                        }
                        new_shot.uuid = final_uuid;
                    }
                }

                // Record the mapping
                section_id_map.insert((proj_idx, old_section_id), new_section_id);
            }

            // Copy section offsets with remapped IDs
            for (old_section_id, offset) in &source_project.section_offsets {
                if let Some(&new_section_id) = section_id_map.get(&(proj_idx, *old_section_id)) {
                    merged_project
                        .section_offsets
                        .insert(new_section_id, *offset);
                } else {
                    tracing::warn!(
                        project = %source_project.name,
                        section_id = old_section_id,
                        purpose = "merge section offsets",
                        "Section offset references unknown section ID; skipping"
                    );
                }
            }

            // Copy station offsets with remapped section IDs. Resolve the source
            // key to a positional index against the source, then store as a
            // transitional Index anchor under the new section; redrive's
            // reanchor pass canonicalizes it once merged shots are present.
            for (old_key, offset) in &source_project.station_offsets {
                if let Some(&new_section_id) = section_id_map.get(&(proj_idx, old_key.section_id)) {
                    if let Some(src_sr) = source_project.resolve_key(old_key) {
                        let new_key = StationKey::positional(new_section_id, src_sr.station_index);
                        merged_project.station_offsets.insert(new_key, *offset);
                    }
                } else {
                    tracing::warn!(
                        project = %source_project.name,
                        section_id = old_key.section_id,
                        purpose = "merge station offsets",
                        "Station offset references unknown section ID; skipping"
                    );
                }
            }

            // Copy station comments with remapped section IDs. Same transitional
            // Index-anchor approach as station_offsets above: resolve the source
            // key to a positional index, then store under the new section; the
            // redrive reanchor pass canonicalizes it once the merged shots exist.
            // (Without this, every per-station comment was silently dropped on
            // merge while every sibling collection was copied.)
            for (old_key, comment) in &source_project.station_comments {
                if let Some(&new_section_id) = section_id_map.get(&(proj_idx, old_key.section_id)) {
                    if let Some(src_sr) = source_project.resolve_key(old_key) {
                        let new_key = StationKey::positional(new_section_id, src_sr.station_index);
                        merged_project
                            .station_comments
                            .insert(new_key, comment.clone());
                    }
                } else {
                    tracing::warn!(
                        project = %source_project.name,
                        section_id = old_key.section_id,
                        purpose = "merge station comments",
                        "Station comment references unknown section ID; skipping"
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
                    let Some(src_sr) = source_project.resolve_key(&zd.station_ref) else {
                        continue;
                    };
                    let new_station_ref = StationRef::new(new_section_id, src_sr.station_index);
                    // Use store-only helper to avoid triggering repositioning during merge
                    if let Err(e) = merged_project
                        .store_zero_datum_without_repositioning(new_station_ref, zd.gps)
                    {
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
                    let (Some(a_sr), Some(b_sr)) = (
                        source_project.resolve_key(&merge.station_a),
                        source_project.resolve_key(&merge.station_b),
                    ) else {
                        continue;
                    };
                    merged_project
                        .station_merges
                        .push(crate::models::StationMerge {
                            station_a: StationKey::positional(new_a_section, a_sr.station_index),
                            station_b: StationKey::positional(new_b_section, b_sr.station_index),
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
                    let (Some(a_sr), Some(b_sr)) = (
                        source_project.resolve_key(&closure.station_a),
                        source_project.resolve_key(&closure.station_b),
                    ) else {
                        continue;
                    };
                    merged_project
                        .loop_closures
                        .push(crate::models::LoopClosure {
                            id: 0, // Reset to 0; assign_closure_ids() will reassign unique IDs
                            station_a: StationKey::positional(new_a_section, a_sr.station_index),
                            station_b: StationKey::positional(new_b_section, b_sr.station_index),
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

        // Re-derive section offsets from the (now combined) merge/datum
        // constraints so the merged output is geometrically consistent and any
        // drift in a source isn't laundered into the new file.
        merged_project.redrive_offsets_after_load();

        // Set the output file path (already normalized to `.stalx` at the top).
        merged_project.file_path = Some(output_path.clone());

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
                return save_failure("Failed to create output file", &output_path, &e);
            }
        };

        if let Err(e) = db.save_project(&merged_project) {
            drop(db);
            let _ = std::fs::remove_file(&temp_path);
            return save_failure("Failed to save merged project", &output_path, &e);
        }

        // Resolved (ignored) warnings are intentionally NOT carried into the
        // merged output: it is a fresh artifact with re-derived offsets and
        // reassigned closure ids, so warnings are re-evaluated from scratch.

        // Close database before rename
        drop(db);

        // Atomically rename temp file to final destination
        if let Err(e) = std::fs::rename(&temp_path, &output_path) {
            let _ = std::fs::remove_file(&temp_path);
            let e = anyhow::Error::from(e);
            return save_failure("Failed to finalize save", &output_path, &e);
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
}
