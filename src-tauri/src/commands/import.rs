use std::fs;
use std::path::PathBuf;

use sha2::{Digest, Sha256};
use tauri::{AppHandle, State};

use crate::core::loading::{LoadingPhase, ProgressEmitter};
use crate::core::state::{AppState, VirtualShotMode};
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

/// Fill in the importer-specific fields of the base `ImportReceipt` that
/// `execute_import_sections` already attached (source/section counts, unit
/// conversion), and extend its warnings with the converter-phase warnings
/// collected while turning the parsed file into `ImportSectionConfig`s.
///
/// No-op when `result` carries no receipt (e.g. the `sections.is_empty()`
/// early return in `execute_import_sections`), so a call site never has to
/// special-case that path.
fn decorate_receipt(
    result: &mut CommandResult,
    source_format: &str,
    path: &std::path::Path,
    sections_found: u32,
    unit_conversion: Option<String>,
    converter_warnings: Vec<String>,
) {
    let Some(receipt) = result.import_receipt.as_mut() else {
        return;
    };
    receipt.source_format = source_format.to_string();
    receipt.file_name = path
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();
    receipt.sections_found = sections_found;
    receipt.unit_conversion = unit_conversion;
    // Converter warnings go FIRST, ahead of the execute-phase ones. They are
    // whole-file statements - an unrecognized unit, a section dropped entirely -
    // and there is a handful of them at most, while the execute phase can emit
    // one per shot. Appending them meant `cap_warnings`' 50-entry limit dropped
    // the highest-signal warning first on exactly the noisy file that needs it.
    // Every importer routes through here, so the ordering is the same for
    // Ariane, Compass, Walls, GPX and DMP.
    if !converter_warnings.is_empty() {
        let execute_warnings = std::mem::replace(&mut receipt.warnings, converter_warnings);
        receipt.warnings.extend(execute_warnings);
    }
    receipt.cap_warnings();
}

/// The import receipt's unit-conversion note for a Compass file, derived from
/// `CompassFile::length_unit` (`build_preview`'s "feet"/"meters"/"mixed" label -
/// see its doc comment for how a multi-survey file collapses to one label).
fn compass_unit_conversion_note(length_unit: Option<&str>) -> Option<String> {
    match length_unit {
        Some("feet") => Some("Lengths converted from feet to meters".to_string()),
        Some("mixed") => Some("Some surveys measured in feet; converted to meters".to_string()),
        _ => None,
    }
}

/// The import receipt's unit-conversion note for a Walls project. Walls has no
/// single project-wide unit label the way Compass does (`#Units` can flip
/// per-survey or mid-file), so this is derived from `WallsFile::any_feet_units`
/// - true when ANY shot anywhere in the project was measured in feet.
fn walls_unit_conversion_note(any_feet_units: bool) -> Option<String> {
    any_feet_units.then(|| "Some surveys measured in feet; converted to meters".to_string())
}

/// #92: durably persist a newly-imported project. A project whose initial save is
/// still deferred (created with no save path, never written) has no `.stalx` and no
/// Recent Projects entry, so importing into it would otherwise be invisible and
/// lost on close - regardless of which import type or UI is used. Every import
/// command funnels its result through here, so resolving the deferred save once an
/// import lands guarantees the project becomes real on disk + in recents on its
/// first import. Already-persisted projects are left untouched, so their unrelated
/// pending edits are never force-committed.
///
/// A failed deferred save is surfaced as a partial success - the import keeps its
/// `success` (so the frontend still refreshes and marks the project dirty, keeping
/// the in-memory import under the close-guard) but carries a warning about the
/// failed save. Returning a hard failure here would make the UI treat the import as
/// failed, never mark dirty, and silently lose the imported data on exit.
fn finalize_deferred_import(state: &AppState, import_result: CommandResult) -> CommandResult {
    if !import_result.success || !state.initial_save_deferred() {
        return import_result;
    }
    let saved = crate::commands::project::save_project_impl(state, None);
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
             Your changes are unsaved - please save manually."
        ));
    }
    import_result
}

/// Import multiple sections as a single atomic undo/redo unit.
/// Includes file hash tracking so undo also reverts the duplicate-detection state.
///
/// `source_label` / `source_file_name` / `sections_found` are additive
/// provenance for the import receipt - today only the mNemo DMP wizard passes
/// them (a later shard). All three are optional and `serde`-defaulted, so
/// existing callers (and the Playwright IPC mock) are unaffected, and the
/// base receipt `execute_import_sections` already attached is left at its
/// defaults when none are provided.
#[tauri::command]
pub fn import_sections(
    state: State<'_, AppState>,
    sections: Vec<crate::models::ImportSectionConfig>,
    file_hash: Option<String>,
    section_hashes: Option<Vec<String>>,
    existing_shot_updates: Option<Vec<crate::models::ExistingShotUpdate>>,
    virtual_shot_mode: Option<VirtualShotMode>,
    source_label: Option<String>,
    source_file_name: Option<String>,
    sections_found: Option<u32>,
) -> CommandResult {
    let updates = existing_shot_updates.unwrap_or_default();
    tracing::info!(
        section_count = sections.len(),
        update_count = updates.len(),
        purpose = "batch import with overlap updates",
        "import_sections called",
    );
    let mut result = state.execute_import_sections(
        sections,
        Vec::new(),
        file_hash,
        section_hashes.unwrap_or_default(),
        updates,
        virtual_shot_mode.unwrap_or_default(),
    );

    if source_label.is_some() || source_file_name.is_some() || sections_found.is_some() {
        if let Some(receipt) = result.import_receipt.as_mut() {
            receipt.source_format = source_label.unwrap_or_else(|| "mNemo DMP".to_string());
            receipt.file_name = source_file_name.unwrap_or_default();
            receipt.sections_found = sections_found.unwrap_or(0);
        }
    }

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
    virtual_shot_mode: Option<VirtualShotMode>,
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
    let (sections, closures, converter_warnings) =
        match crate::parsers::tml::convert_tml_to_import_configs(
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

    let sections_found = tml.sections.len() as u32;
    let unit_conversion = match tml.unit {
        crate::parsers::tml::TmlUnit::Imperial => {
            Some("Lengths converted from feet to meters".to_string())
        }
        crate::parsers::tml::TmlUnit::Metric => None,
    };

    emitter.start_phase(LoadingPhase::ImportApplyingChanges);
    let mut result = state.execute_import_sections(
        sections,
        closures,
        file_hash,
        Vec::new(),
        Vec::new(),
        virtual_shot_mode.unwrap_or_default(),
    );
    emitter.complete_phase(LoadingPhase::ImportApplyingChanges);

    decorate_receipt(
        &mut result,
        "Ariane TML",
        &path,
        sections_found,
        unit_conversion,
        converter_warnings,
    );

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

    let preview = crate::parsers::compass::build_preview(&parsed);
    let sections_found = preview.survey_count;
    let unit_conversion = compass_unit_conversion_note(preview.length_unit.as_deref());

    emitter.start_phase(LoadingPhase::ImportApplyingChanges);
    let mut result = state.execute_import_sections(
        sections,
        closures,
        file_hash,
        Vec::new(),
        Vec::new(),
        // Auto: no dialog on this path carries a per-file override, so the chain
        // rule decides. An Option parameter here was unreachable - no frontend
        // caller ever populated it - which read as "the override works" while
        // silently always meaning Auto.
        VirtualShotMode::Auto,
    );
    emitter.complete_phase(LoadingPhase::ImportApplyingChanges);

    decorate_receipt(
        &mut result,
        "Compass",
        &path,
        sections_found,
        unit_conversion,
        warnings,
    );

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

    let sections_found = sections.len() as u32;

    // Auto, not a per-file override: the GPX dialog has no mode control, so
    // there is nothing to pass through - but the chain rule still has to run.
    // `parsers::gpx` seeds every leg as Reference on the promise that the
    // classifier can promote it, and skipping the pass here (this path used
    // to call `finalize_deferred_import` directly) left a GPS surface track
    // tying two sumps together permanently excluded from the survey graph.
    let mut result = state.execute_import_sections(
        sections,
        Vec::new(),
        file_hash,
        Vec::new(),
        Vec::new(),
        VirtualShotMode::Auto,
    );

    decorate_receipt(&mut result, "GPX", &path, sections_found, None, Vec::new());

    finalize_deferred_import(state.inner(), result)
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
    selected_surveys: Option<Vec<u32>>,
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
        // `None` ⇒ import every survey; `Some(list)` ⇒ only the chosen survey
        // indices (into the preview's `WallsFile::surveys`, which is 1:1 with
        // the parser's survey order).
        selected_surveys: selected_surveys.map(|v| v.into_iter().collect()),
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

    let preview = crate::parsers::walls::build_preview(&parsed);
    let sections_found = preview.survey_count;
    let unit_conversion = walls_unit_conversion_note(preview.any_feet_units);

    emitter.start_phase(LoadingPhase::ImportApplyingChanges);
    let mut result = state.execute_import_sections(
        sections,
        closures,
        file_hash,
        Vec::new(),
        Vec::new(),
        // Auto: no dialog on this path carries a per-file override, so the chain
        // rule decides. An Option parameter here was unreachable - no frontend
        // caller ever populated it - which read as "the override works" while
        // silently always meaning Auto.
        VirtualShotMode::Auto,
    );
    emitter.complete_phase(LoadingPhase::ImportApplyingChanges);

    decorate_receipt(
        &mut result,
        "Walls",
        &path,
        sections_found,
        unit_conversion,
        warnings,
    );

    emitter.start_phase(LoadingPhase::ImportFinalizing);
    emitter.complete_phase(LoadingPhase::ImportFinalizing);

    finalize_deferred_import(state.inner(), result)
}

#[cfg(test)]
#[expect(
    clippy::expect_used,
    reason = "unit test fixtures fail loudly on setup errors"
)]
mod receipt_tests {
    use super::*;
    use crate::core::command::ImportReceipt;
    use std::path::Path;

    fn base_result() -> CommandResult {
        CommandResult::success().with_import_receipt(ImportReceipt {
            source_format: String::new(),
            file_name: String::new(),
            sections_found: 0,
            sections_imported: 3,
            shot_count: 12,
            closures_requested: 1,
            closures_created: 1,
            unit_conversion: None,
            warnings: Vec::new(),
        })
    }

    #[test]
    fn decorate_receipt_fills_placeholder_fields_and_extends_warnings() {
        let mut result = base_result();
        decorate_receipt(
            &mut result,
            "Ariane TML",
            Path::new("/tmp/cave.tml"),
            5,
            Some("Lengths converted from feet to meters".to_string()),
            vec!["1 section had no shots after filtering and was dropped".to_string()],
        );
        let receipt = result
            .import_receipt
            .expect("receipt must survive decoration");
        assert_eq!(receipt.source_format, "Ariane TML");
        assert_eq!(receipt.file_name, "cave.tml");
        assert_eq!(receipt.sections_found, 5);
        assert_eq!(
            receipt.unit_conversion.as_deref(),
            Some("Lengths converted from feet to meters")
        );
        // Base counts from execute_import_sections are untouched.
        assert_eq!(receipt.sections_imported, 3);
        assert_eq!(receipt.shot_count, 12);
        assert_eq!(receipt.warnings.len(), 1);
    }

    /// The cap keeps the FIRST 50 warnings, and a per-shot execute phase can
    /// blow past 50 on its own. A converter warning appended behind them - the
    /// unrecognized unit, which says the whole survey may be mis-scaled - was
    /// then the first thing dropped, on exactly the file that needs it most.
    #[test]
    fn a_converter_warning_survives_a_flood_of_execute_warnings() {
        let mut result = base_result();
        if let Some(receipt) = result.import_receipt.as_mut() {
            receipt.warnings = (0..60).map(|i| format!("shot {i} looks odd")).collect();
        }

        decorate_receipt(
            &mut result,
            "Ariane TML",
            Path::new("/tmp/cave.tml"),
            5,
            None,
            vec![
                "The file declares an unrecognized unit \"furlongs\"; all measurements were read as meters"
                    .to_string(),
            ],
        );

        let receipt = result
            .import_receipt
            .expect("receipt must survive decoration");
        assert!(
            receipt.warnings.iter().any(|w| w.contains("furlongs")),
            "the unit warning must outrank per-shot noise, got {:?}",
            receipt.warnings.first()
        );
        // And the flood is still capped, summary entry included.
        assert_eq!(receipt.warnings.len(), 51);
    }

    #[test]
    fn decorate_receipt_is_a_no_op_without_a_receipt() {
        let mut result = CommandResult::success();
        decorate_receipt(
            &mut result,
            "Compass",
            Path::new("/tmp/cave.dat"),
            1,
            None,
            vec!["should be dropped".to_string()],
        );
        assert!(result.import_receipt.is_none());
    }

    #[test]
    fn compass_unit_conversion_note_covers_feet_mixed_and_metric() {
        assert_eq!(
            compass_unit_conversion_note(Some("feet")).as_deref(),
            Some("Lengths converted from feet to meters")
        );
        assert_eq!(
            compass_unit_conversion_note(Some("mixed")).as_deref(),
            Some("Some surveys measured in feet; converted to meters")
        );
        assert_eq!(compass_unit_conversion_note(Some("meters")), None);
        assert_eq!(compass_unit_conversion_note(None), None);
    }

    #[test]
    fn walls_unit_conversion_note_covers_feet_and_metric() {
        assert_eq!(
            walls_unit_conversion_note(true).as_deref(),
            Some("Some surveys measured in feet; converted to meters")
        );
        assert_eq!(walls_unit_conversion_note(false), None);
    }
}
