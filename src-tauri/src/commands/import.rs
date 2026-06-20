use std::fs;
use std::path::PathBuf;

use sha2::{Digest, Sha256};
use tauri::{AppHandle, State};

use crate::core::loading::{LoadingPhase, ProgressEmitter};
use crate::core::state::AppState;
use crate::core::CommandResult;
use crate::models::placement_suggest::{
    suggest_all_placements, suggest_placements, CrossSectionSuggestion, ExistingSection,
    ImportSectionForSuggestion, OrphanPlacementSuggestion, PlacementSuggestion,
};
use crate::models::ShotData;
use crate::parsers::compass::{CompassFile, CompassImportOptions};
use crate::parsers::gpx::{GpxFile, GpxSectionPlacement};
use crate::parsers::tml::TmlFile;
use crate::parsers::walls::{WallsFile, WallsImportOptions};
use crate::parsers::DmpFile;

/// Import a DMP file and return parsed data
#[tauri::command]
pub fn import_dmp(path: PathBuf) -> Result<DmpFile, String> {
    tracing::info!(
        path = ?path,
        purpose = "prepare import preview",
        "Parsing DMP file for import preview"
    );
    let result = crate::parsers::parse_dmp(&path);
    if let Err(ref e) = result {
        tracing::error!(
            path = ?path,
            purpose = "prepare import preview",
            reason = %e,
            "Failed to parse DMP file for import preview"
        );
    }
    result.map_err(|e| e.to_string())
}

/// Calculate SHA256 hash of a file
#[tauri::command]
pub fn calculate_file_hash(path: PathBuf) -> Result<String, String> {
    tracing::debug!(
        path = ?path,
        purpose = "detect duplicate imports",
        "Calculating file hash for import deduplication"
    );
    let contents = fs::read(&path).map_err(|e| {
        tracing::error!(
            path = ?path,
            purpose = "detect duplicate imports",
            reason = %e,
            "Failed to read file while calculating import hash"
        );
        format!("Failed to read file: {e}")
    })?;

    let mut hasher = Sha256::new();
    hasher.update(&contents);
    let result = hasher.finalize();

    let hash = format!("{result:x}");
    tracing::debug!(
        path = ?path,
        purpose = "detect duplicate imports",
        hash = %hash,
        "Calculated file hash for import deduplication"
    );
    Ok(hash)
}

/// Check if a file hash has already been imported to the project
#[tauri::command]
pub fn check_duplicate_import(state: State<'_, AppState>, hash: String) -> Result<bool, String> {
    check_duplicate_import_impl(state.inner(), hash)
}

pub(crate) fn check_duplicate_import_impl(state: &AppState, hash: String) -> Result<bool, String> {
    tracing::debug!(
        hash = %hash,
        purpose = "detect duplicate imports",
        "Checking whether file hash was previously imported"
    );
    state
        .check_duplicate_import(&hash)
        .map_err(|e| e.to_string())
}

/// Track an imported file hash in the project
#[tauri::command]
pub fn track_imported_file(state: State<'_, AppState>, hash: String) -> CommandResult {
    track_imported_file_impl(state.inner(), hash)
}

pub(crate) fn track_imported_file_impl(state: &AppState, hash: String) -> CommandResult {
    tracing::debug!(
        hash = %hash,
        purpose = "prevent duplicate imports",
        "Tracking imported file hash"
    );
    state.track_imported_file(hash)
}

/// Batch-check which section content hashes have already been imported.
/// Returns a parallel Vec<bool> (true = already imported).
#[tauri::command]
pub fn check_section_hashes(
    state: State<'_, AppState>,
    hashes: Vec<String>,
) -> Result<Vec<bool>, String> {
    tracing::debug!(
        count = hashes.len(),
        purpose = "detect duplicate section imports",
        "Checking section content hashes"
    );
    state
        .check_section_hashes(&hashes)
        .map_err(|e| e.to_string())
}

/// #92: durably persist a newly-imported project. A project whose initial save is
/// still deferred (created with no save path, never written) has no `.stalx` and no
/// Recent Projects entry, so importing into it would otherwise be invisible and
/// lost on close — regardless of which import type or UI is used. Every import
/// command funnels its result through here, so resolving the deferred save once an
/// import lands guarantees the project becomes real on disk + in recents on its
/// first import. Already-persisted projects are left untouched, so their unrelated
/// pending edits are never force-committed.
///
/// A failed deferred save is surfaced as a partial success — the import keeps its
/// `success` (so the frontend still refreshes and marks the project dirty, keeping
/// the in-memory import under the close-guard) but carries a warning about the
/// failed save. Returning a hard failure here would make the UI treat the import as
/// failed, never mark dirty, and silently lose the imported data on exit.
fn finalize_deferred_import(state: &AppState, import_result: CommandResult) -> CommandResult {
    if !import_result.success || !state.initial_save_deferred() {
        return import_result;
    }
    let saved = crate::commands::project::save_project_impl(state, None, false);
    if !saved.success {
        tracing::warn!(
            error = ?saved.error,
            purpose = "persist new project after first import",
            "Deferred-save resolution failed after import"
        );
        let raw = saved.error.unwrap_or_else(|| "unknown error".to_string());
        // Don't leak the internal permission marker into the user-facing warning.
        let detail = if raw.starts_with(crate::core::loading::PERMISSION_DENIED_CODE) {
            "permission denied (check folder access in Privacy & Security)".to_string()
        } else {
            raw
        };
        return import_result.with_warning(&format!(
            "Imported, but could not save the new project to disk: {detail}. \
             Your changes are unsaved — please save manually."
        ));
    }
    import_result
}

/// Import multiple sections as a single atomic undo/redo unit.
/// Includes file hash tracking so undo also reverts the duplicate-detection state.
#[tauri::command]
pub fn import_sections(
    state: State<'_, AppState>,
    sections: Vec<crate::models::ImportSectionConfig>,
    file_hash: Option<String>,
    section_hashes: Option<Vec<String>>,
    existing_shot_updates: Option<Vec<crate::models::ExistingShotUpdate>>,
) -> CommandResult {
    let updates = existing_shot_updates.unwrap_or_default();
    tracing::info!(
        section_count = sections.len(),
        update_count = updates.len(),
        purpose = "batch import with overlap updates",
        "import_sections called",
    );
    let result = state.execute_import_sections(
        sections,
        Vec::new(),
        file_hash,
        section_hashes.unwrap_or_default(),
        updates,
    );
    finalize_deferred_import(state.inner(), result)
}

/// Parse a TML/TMLU file and return preview data for the import dialog.
#[tauri::command]
pub fn parse_tml(path: PathBuf) -> Result<TmlFile, String> {
    tracing::info!(
        path = ?path,
        purpose = "prepare TML import preview",
        "Parsing Ariane TML/TMLU file for import preview"
    );
    let result = crate::parsers::tml::parse_tml(&path);
    if let Err(ref e) = result {
        tracing::error!(
            path = ?path,
            purpose = "prepare TML import preview",
            reason = %e,
            "Failed to parse TML/TMLU file for import preview"
        );
    }
    result.map_err(|e| e.to_string())
}

/// Parse a TML/TMLU file, convert to import configs, and execute the import.
#[tauri::command]
pub fn execute_tml_import(
    app: AppHandle,
    state: State<'_, AppState>,
    path: PathBuf,
    file_hash: Option<String>,
    include_excluded: bool,
    comments_on_stations: bool,
) -> CommandResult {
    tracing::info!(
        path = ?path,
        purpose = "import Ariane TML/TMLU",
        "Executing TML import"
    );

    let mut emitter = ProgressEmitter::new_for_import(app);

    emitter.start_phase(LoadingPhase::ImportParsing);
    let tml = match crate::parsers::tml::parse_tml(&path) {
        Ok(tml) => tml,
        Err(e) => {
            tracing::error!(
                path = ?path,
                purpose = "import Ariane TML/TMLU",
                reason = %e,
                "Failed to parse TML/TMLU file for import"
            );
            return CommandResult::failure(format!("Failed to parse TML file: {e}"));
        }
    };
    emitter.complete_phase(LoadingPhase::ImportParsing);

    emitter.start_phase(LoadingPhase::ImportConverting);
    let (sections, closures) = match crate::parsers::tml::convert_tml_to_import_configs(
        &tml,
        include_excluded,
        comments_on_stations,
    ) {
        Ok(result) => result,
        Err(e) => {
            tracing::error!(
                path = ?path,
                purpose = "import Ariane TML/TMLU",
                reason = %e,
                "Failed to convert TML data to import configs"
            );
            return CommandResult::failure(format!("Failed to convert TML data: {e}"));
        }
    };
    emitter.complete_phase(LoadingPhase::ImportConverting);

    tracing::info!(
        path = ?path,
        section_count = sections.len(),
        closure_count = closures.len(),
        purpose = "import Ariane TML/TMLU",
        "Converted TML to import configs, executing import"
    );

    emitter.start_phase(LoadingPhase::ImportApplyingChanges);
    let result =
        state.execute_import_sections(sections, closures, file_hash, Vec::new(), Vec::new());
    emitter.complete_phase(LoadingPhase::ImportApplyingChanges);

    emitter.start_phase(LoadingPhase::ImportFinalizing);
    emitter.complete_phase(LoadingPhase::ImportFinalizing);

    finalize_deferred_import(state.inner(), result)
}

/// Parse a Compass `.DAT`/`.MAK` file and return preview data for the import dialog.
#[tauri::command]
pub fn parse_compass(path: PathBuf) -> Result<CompassFile, String> {
    tracing::info!(
        path = ?path,
        purpose = "prepare Compass import preview",
        "Parsing Compass .DAT/.MAK file for import preview"
    );
    let parsed = crate::parsers::compass::parse_compass(&path).map_err(|e| {
        tracing::error!(
            path = ?path,
            purpose = "prepare Compass import preview",
            reason = %e,
            "Failed to parse Compass file for import preview"
        );
        e.to_string()
    })?;
    Ok(crate::parsers::compass::build_preview(&parsed))
}

/// Parse a Compass file, convert to import configs, and execute the import.
#[tauri::command]
pub fn execute_compass_import(
    app: AppHandle,
    state: State<'_, AppState>,
    path: PathBuf,
    file_hash: Option<String>,
    include_excluded: bool,
    apply_corrections: bool,
    comments_on_stations: bool,
) -> CommandResult {
    tracing::info!(
        path = ?path,
        purpose = "import Compass",
        "Executing Compass import"
    );

    let mut emitter = ProgressEmitter::new_for_import(app);

    emitter.start_phase(LoadingPhase::ImportParsing);
    let parsed = match crate::parsers::compass::parse_compass(&path) {
        Ok(parsed) => parsed,
        Err(e) => {
            tracing::error!(
                path = ?path,
                purpose = "import Compass",
                reason = %e,
                "Failed to parse Compass file for import"
            );
            return CommandResult::failure(format!("Failed to parse Compass file: {e}"));
        }
    };
    emitter.complete_phase(LoadingPhase::ImportParsing);

    emitter.start_phase(LoadingPhase::ImportConverting);
    let opts = CompassImportOptions {
        include_excluded,
        apply_corrections,
        comments_on_stations,
    };
    let (sections, closures, warnings) =
        match crate::parsers::compass::convert_compass_to_import_configs(&parsed, &opts) {
            Ok(result) => result,
            Err(e) => {
                tracing::error!(
                    path = ?path,
                    purpose = "import Compass",
                    reason = %e,
                    "Failed to convert Compass data to import configs"
                );
                return CommandResult::failure(format!("Failed to convert Compass data: {e}"));
            }
        };
    emitter.complete_phase(LoadingPhase::ImportConverting);

    for warning in &warnings {
        tracing::warn!(purpose = "import Compass", "{warning}");
    }

    tracing::info!(
        path = ?path,
        section_count = sections.len(),
        closure_count = closures.len(),
        warning_count = warnings.len(),
        purpose = "import Compass",
        "Converted Compass to import configs, executing import"
    );

    emitter.start_phase(LoadingPhase::ImportApplyingChanges);
    let result =
        state.execute_import_sections(sections, closures, file_hash, Vec::new(), Vec::new());
    emitter.complete_phase(LoadingPhase::ImportApplyingChanges);

    emitter.start_phase(LoadingPhase::ImportFinalizing);
    emitter.complete_phase(LoadingPhase::ImportFinalizing);

    finalize_deferred_import(state.inner(), result)
}

/// Parse a GPX file and return preview data for the import dialog.
#[tauri::command]
pub fn parse_gpx(path: PathBuf) -> Result<GpxFile, String> {
    tracing::info!(
        path = ?path,
        purpose = "prepare GPX import preview",
        "Parsing GPX file for import preview"
    );
    let result = crate::parsers::gpx::parse_gpx(&path);
    if let Err(ref e) = result {
        tracing::error!(
            path = ?path,
            purpose = "prepare GPX import preview",
            reason = %e,
            "Failed to parse GPX file for import preview"
        );
    }
    result.map_err(|e| e.to_string())
}

/// Parse a GPX file, convert to import configs, and execute the import.
#[tauri::command]
pub fn execute_gpx_import(
    state: State<'_, AppState>,
    path: PathBuf,
    file_hash: Option<String>,
    import_waypoints: bool,
    import_tracks: bool,
    import_routes: bool,
    section_placements: Vec<GpxSectionPlacement>,
    depth_inverted: bool,
) -> CommandResult {
    tracing::info!(
        path = ?path,
        purpose = "import GPX",
        import_waypoints,
        import_tracks,
        import_routes,
        "Executing GPX import"
    );

    let gpx = match crate::parsers::gpx::parse_gpx(&path) {
        Ok(gpx) => gpx,
        Err(e) => {
            tracing::error!(
                path = ?path,
                purpose = "import GPX",
                reason = %e,
                "Failed to parse GPX file for import"
            );
            return CommandResult::failure(format!("Failed to parse GPX file: {e}"));
        }
    };

    let sections = match crate::parsers::gpx::convert_gpx_to_import_configs(
        &gpx,
        import_waypoints,
        import_tracks,
        import_routes,
        &section_placements,
        depth_inverted,
    ) {
        Ok(s) => s,
        Err(e) => {
            tracing::error!(
                path = ?path,
                purpose = "import GPX",
                reason = %e,
                "Failed to convert GPX data to import configs"
            );
            return CommandResult::failure(format!("Failed to convert GPX data: {e}"));
        }
    };

    tracing::info!(
        path = ?path,
        section_count = sections.len(),
        purpose = "import GPX",
        "Converted GPX to import configs, executing import"
    );

    finalize_deferred_import(
        state.inner(),
        state.execute_import_sections(sections, Vec::new(), file_hash, Vec::new(), Vec::new()),
    )
}

/// Suggest placement positions for an import section by detecting reference shot overlap.
#[tauri::command]
pub fn suggest_import_placement(
    state: State<'_, AppState>,
    shots: Vec<ShotData>,
) -> Result<Vec<PlacementSuggestion>, String> {
    let project = state.get_project_state().ok_or("No project open")?;

    let existing_sections: Vec<ExistingSection> = project
        .sections
        .iter()
        .map(|s| ExistingSection {
            id: s.id,
            name: s
                .name
                .clone()
                .unwrap_or_else(|| format!("Section {}", s.id)),
            shots: s.shots.clone(),
        })
        .collect();

    let config = state.get_config();
    Ok(suggest_placements(
        &shots,
        &existing_sections,
        &config.placement_suggestion,
    ))
}

/// Suggest placements for ALL import sections against BOTH existing project
/// sections AND each other (import-to-import). Returns a flat list sorted by score.
#[tauri::command]
pub fn suggest_all_import_placements(
    state: State<'_, AppState>,
    import_sections: Vec<ImportSectionForSuggestion>,
) -> Result<Vec<CrossSectionSuggestion>, String> {
    let existing_sections: Vec<ExistingSection> = match state.get_project_state() {
        Some(project) => project
            .sections
            .iter()
            .map(|s| ExistingSection {
                id: s.id,
                name: s
                    .name
                    .clone()
                    .unwrap_or_else(|| format!("Section {}", s.id)),
                shots: s.shots.clone(),
            })
            .collect(),
        None => Vec::new(),
    };

    let config = state.get_config();
    Ok(suggest_all_placements(
        &import_sections,
        &existing_sections,
        &config.placement_suggestion,
    ))
}

/// Suggest placements for orphaned sections' leaf ends against newly imported sections.
/// Orphaned sections are those in connected components (via merges) with no zero datum.
#[tauri::command]
pub fn suggest_orphan_placements(
    state: State<'_, AppState>,
    newly_imported_section_ids: Vec<u32>,
) -> Result<Vec<OrphanPlacementSuggestion>, String> {
    let project = state.get_project_state().ok_or("No project open")?;
    let config = state.get_config();
    Ok(
        project
            .suggest_orphan_placements(&newly_imported_section_ids, &config.placement_suggestion),
    )
}

/// Parse a Walls `.WPJ`/`.SRV` file and return preview data for the import dialog.
#[tauri::command]
pub fn parse_walls(path: PathBuf) -> Result<WallsFile, String> {
    tracing::info!(
        path = ?path,
        purpose = "prepare Walls import preview",
        "Parsing Walls .WPJ/.SRV file for import preview"
    );
    let parsed = crate::parsers::walls::parse_walls(&path).map_err(|e| {
        tracing::error!(
            path = ?path,
            purpose = "prepare Walls import preview",
            reason = %e,
            "Failed to parse Walls file for import preview"
        );
        e.to_string()
    })?;
    Ok(crate::parsers::walls::build_preview(&parsed))
}

/// Parse a Walls file, convert to import configs, and execute the import.
#[tauri::command]
pub fn execute_walls_import(
    app: AppHandle,
    state: State<'_, AppState>,
    path: PathBuf,
    file_hash: Option<String>,
    comments_on_stations: bool,
    include_splays: bool,
) -> CommandResult {
    tracing::info!(
        path = ?path,
        purpose = "import Walls",
        "Executing Walls import"
    );

    let mut emitter = ProgressEmitter::new_for_import(app);

    emitter.start_phase(LoadingPhase::ImportParsing);
    let parsed = match crate::parsers::walls::parse_walls(&path) {
        Ok(parsed) => parsed,
        Err(e) => {
            tracing::error!(
                path = ?path,
                purpose = "import Walls",
                reason = %e,
                "Failed to parse Walls file for import"
            );
            return CommandResult::failure(format!("Failed to parse Walls file: {e}"));
        }
    };
    emitter.complete_phase(LoadingPhase::ImportParsing);

    emitter.start_phase(LoadingPhase::ImportConverting);
    let opts = WallsImportOptions {
        comments_on_stations,
        include_splays,
    };
    let (sections, closures, warnings) =
        match crate::parsers::walls::convert_walls_to_import_configs(&parsed, &opts) {
            Ok(result) => result,
            Err(e) => {
                tracing::error!(
                    path = ?path,
                    purpose = "import Walls",
                    reason = %e,
                    "Failed to convert Walls data to import configs"
                );
                return CommandResult::failure(format!("Failed to convert Walls data: {e}"));
            }
        };
    emitter.complete_phase(LoadingPhase::ImportConverting);

    for warning in &warnings {
        tracing::warn!(purpose = "import Walls", "{warning}");
    }

    tracing::info!(
        path = ?path,
        section_count = sections.len(),
        closure_count = closures.len(),
        warning_count = warnings.len(),
        purpose = "import Walls",
        "Converted Walls to import configs, executing import"
    );

    emitter.start_phase(LoadingPhase::ImportApplyingChanges);
    let result =
        state.execute_import_sections(sections, closures, file_hash, Vec::new(), Vec::new());
    emitter.complete_phase(LoadingPhase::ImportApplyingChanges);

    emitter.start_phase(LoadingPhase::ImportFinalizing);
    emitter.complete_phase(LoadingPhase::ImportFinalizing);

    finalize_deferred_import(state.inner(), result)
}
