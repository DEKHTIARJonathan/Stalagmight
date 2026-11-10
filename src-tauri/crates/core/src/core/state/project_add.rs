//! "Add .stalx to current project" (#674): append another project file's
//! survey into the OPEN project, as one undoable command.
//!
//! The copy itself is [`append_project`], the routine "Merge projects" uses.
//! What this file adds around it is what only an add needs: reading the source
//! without touching it, placing a georeferenced source by its datum, carrying
//! the source's dedup hashes and ignored warnings, refusing corruption without
//! a whole-project snapshot, and the receipt.

use std::collections::HashSet;
use std::path::Path;

use super::project_append::{append_project, AppendOutcome};
use super::project_io::same_file;
use super::AppState;
use crate::core::command::{sanitize_display_text, ImportReceipt, MAX_FILE_NAME_LEN};
use crate::core::{AddedContent, CarriedIgnore, CommandResult};
use crate::models::{
    gps_to_local, warning_is_ignorable, GpsCoordinates, Project, SectionId, SpeleoLink,
    FEATURE_ID_STRIDE, MAX_SECTIONS_IN_ID_SPACE, MAX_SECTION_ID,
};
use crate::persistence::{Database, ResolvedWarning};

/// The import-dedup entry an add records for its source, in
/// `Project::imported_file_hashes` beside the content hashes the importers
/// record there. Prefixed so it can never collide with a hex SHA-256.
///
/// Keyed on the source PROJECT's identity (`created_at`, stable across every
/// edit and save of that project), not on the file's bytes: a `.stalx` is
/// rewritten on every save - `modified_at`, the undo history - so a byte hash
/// would miss exactly the common case of adding the same project again after it
/// was opened and saved. A Save As copy keeps the identity, and holds the same
/// survey, so it warns too.
const STALX_IDENTITY_PREFIX: &str = "stalx-project:";

fn stalx_identity(project: &Project) -> String {
    format!("{STALX_IDENTITY_PREFIX}{}", project.created_at.to_rfc3339())
}

/// The source as the add reads it.
struct AddSource {
    project: Project,
    /// Its `resolved_warnings` rows; `None` when the table could not be read.
    ignores: Option<Vec<ResolvedWarning>>,
    link: Option<SpeleoLink>,
}

/// Read `path` WITHOUT touching it, normalized the way opening it would be.
///
/// Through a private copy: opening an older file migrates it in place, and the
/// source - possibly a SpeleoDB-managed cache copy whose bytes are compared
/// against its server commit - must stay exactly as it was. The source's undo
/// history is never read.
fn load_add_source(path: &Path, label: &str) -> Result<AddSource, String> {
    let dir = tempfile::tempdir()
        .map_err(|e| format!("Failed to prepare a private copy of '{label}': {e}"))?;
    let copy = dir.path().join("source.stalx");
    copy_regular_file(path, &copy, label)?;
    let db = Database::open_existing(&copy)
        .map_err(|e| format!("Failed to open project '{label}': {e}"))?;
    let mut project = db
        .load_project()
        .map_err(|e| format!("Failed to load project '{label}': {e}"))?;
    let ignores = db.load_resolved_warnings_verbatim().ok();
    // An unreadable link table on a file whose project DID load is treated as
    // no link: the copy carries survey data only either way, so the link only
    // ever decides one receipt line.
    let link = db.load_speleo_link().ok().flatten();
    drop(db);

    // What an open does to a freshly read project, in the same order
    // (`do_load_project_full`): every shot gets a uuid (the identity ignores
    // and cross-references are re-keyed onto), legacy closures get ids, and the
    // derived offsets are re-solved rather than trusted.
    project.ensure_shot_uuids();
    project.assign_closure_ids();
    project.redrive_offsets_after_load();
    Ok(AddSource {
        project,
        ignores,
        link,
    })
}

/// The largest `.stalx` an add reads: the ceiling a SpeleoDB download of a
/// project file is already held to. The read runs under `command_lock`, so an
/// unbounded one would stall every edit behind it (and fill the disk).
const MAX_ADD_SOURCE_BYTES: u64 = crate::speleodb::client::NATIVE_LIMIT;

/// Copy `path` to `dest`, refusing anything that is not a regular file of at
/// most [`MAX_ADD_SOURCE_BYTES`]: a FIFO or a device named `*.stalx` would
/// block or never end, and a directory cannot be a project.
///
/// The metadata check runs before the file is opened (opening a FIFO for
/// reading blocks), and the copy itself is bounded too, so a file that grows
/// or is swapped after the check still cannot exceed the ceiling.
fn copy_regular_file(path: &Path, dest: &Path, label: &str) -> Result<(), String> {
    let too_large = || {
        format!(
            "'{label}' is larger than {} MB, the largest project file that can be added",
            MAX_ADD_SOURCE_BYTES / (1024 * 1024)
        )
    };
    let metadata = match std::fs::metadata(path) {
        Ok(metadata) => metadata,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Err(format!("File not found: {label}"));
        }
        Err(e) => return Err(format!("Failed to read '{label}': {e}")),
    };
    if !metadata.is_file() {
        return Err(format!("'{label}' is not a project file"));
    }
    if metadata.len() > MAX_ADD_SOURCE_BYTES {
        return Err(too_large());
    }
    let source = std::fs::File::open(path).map_err(|e| format!("Failed to read '{label}': {e}"))?;
    let mut target =
        std::fs::File::create(dest).map_err(|e| format!("Failed to read '{label}': {e}"))?;
    let copied = std::io::copy(
        &mut std::io::Read::take(source, MAX_ADD_SOURCE_BYTES + 1),
        &mut target,
    )
    .map_err(|e| format!("Failed to read '{label}': {e}"))?;
    if copied > MAX_ADD_SOURCE_BYTES {
        return Err(too_large());
    }
    Ok(())
}

/// Translate the copied sections so a georeferenced source lands at its GPS
/// position: its first resolvable datum's station goes to that datum's local
/// position in the open project's frame, or to the origin when the open project
/// had no frame (the copied datum then BECOMES the frame).
///
/// The whole copy moves rigidly, unanchored components included, so the
/// source's own layout is preserved. Nothing pre-existing moves. A source with
/// no datum is left where it is - placing it is the orphan-placement dialog's
/// job, not a guess made here.
fn place_by_datum(
    project: &mut Project,
    new_ids: &[SectionId],
    frame_before: Option<GpsCoordinates>,
) {
    let new: HashSet<SectionId> = new_ids.iter().copied().collect();
    let Some((station, gps)) = project
        .zero_datums
        .iter()
        .filter(|zd| new.contains(&zd.station_ref.section_id))
        .find_map(|zd| project.resolve_key(&zd.station_ref).map(|sr| (sr, zd.gps)))
    else {
        return;
    };
    let Some(current) = project.compute_station_raw_coords(station) else {
        return;
    };
    let (target_x, target_y) = frame_before.map_or((0.0, 0.0), |frame| gps_to_local(&gps, &frame));
    let (dx, dy) = (target_x - current.x, target_y - current.y);
    if dx.abs() <= Project::OFFSET_DUST_M && dy.abs() <= Project::OFFSET_DUST_M {
        return;
    }
    for id in new_ids {
        project.adjust_section_offset(*id, dx, dy);
    }
}

/// Re-key the source's ignored warnings onto the copied sections, by shot uuid.
/// A legacy position-keyed row is resolved through the source shot at that
/// position. Rows an ignore can never honor (error severity) and rows whose
/// shot is gone are dropped.
fn remap_ignores(
    source: &Project,
    rows: &[ResolvedWarning],
    outcome: &AppendOutcome,
) -> Vec<CarriedIgnore> {
    let mut carried: Vec<CarriedIgnore> = Vec::new();
    for row in rows {
        if !warning_is_ignorable(&row.warning_code) {
            continue;
        }
        let Some(&section_id) = outcome.section_id_map.get(&row.section_id) else {
            continue;
        };
        let Some(section) = source.get_section(row.section_id) else {
            continue;
        };
        let shot = match row.shot_uuid.as_deref() {
            Some(uuid) => section
                .shots
                .iter()
                .find(|s| s.uuid.as_deref() == Some(uuid)),
            None => section.shots.iter().find(|s| s.id == row.shot_id),
        };
        let Some(shot_uuid) = shot.and_then(|s| s.uuid.clone()) else {
            continue;
        };
        let ignore = CarriedIgnore {
            section_id,
            shot_uuid,
            warning_code: row.warning_code.clone(),
            resolved_at: row.resolved_at,
            resolved_comment: row.resolved_comment.clone(),
        };
        if !carried.iter().any(|c| same_ignore(c, &ignore)) {
            carried.push(ignore);
        }
    }
    carried
}

fn same_ignore(a: &CarriedIgnore, b: &CarriedIgnore) -> bool {
    a.section_id == b.section_id && a.shot_uuid == b.shot_uuid && a.warning_code == b.warning_code
}

/// What happened during the append, for the receipt.
struct AppendReport {
    outcome: AppendOutcome,
    closures_created: u32,
    ignores: Vec<CarriedIgnore>,
    duplicate: Option<&'static str>,
}

impl AppState {
    /// `Command::AddProjectFile`'s forward step (reached only through
    /// `execute`, so the read-only gate, the geometry epilogue and the undo push
    /// all apply). Refuses with nothing changed when no project is open, when
    /// `path` is the open project's own file, or when the file cannot be read.
    pub(super) fn add_project_file(&self, path: &Path) -> CommandResult {
        let label = path
            .file_name()
            .map(|n| sanitize_display_text(&n.to_string_lossy(), MAX_FILE_NAME_LEN))
            .unwrap_or_default();

        // The refusals that need no file read come first. The slot generation is
        // read under the same guard: a project load does not take
        // `command_lock`, so a different project can be committed while the
        // file is read below, and every slot commit bumps the generation (local
        // projects included - see `bump_speleodb_session` and the bump-site
        // tripwire in `speleodb_session`).
        let (open_path, slot_generation) = {
            let guard = self
                .project
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            let Some(project) = guard.as_ref() else {
                return CommandResult::failure("No project is open to add the file to".to_string());
            };
            (
                project.file_path.clone(),
                self.speleodb_session_generation(),
            )
        };
        if open_path
            .as_deref()
            .is_some_and(|open| same_file(open, path))
        {
            return CommandResult::failure(format!(
                "'{label}' is the open project itself, so it cannot be added to it"
            ));
        }

        let source = match load_add_source(path, &label) {
            Ok(source) => source,
            Err(e) => return CommandResult::failure(e),
        };
        between_locks(self);

        let mut guard = self
            .project
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let Some(project) = guard.as_mut() else {
            return CommandResult::failure("No project is open to add the file to".to_string());
        };
        // The project the add was started against left the slot during the read.
        // Appending into its successor would pair it with the undo baseline
        // `execute` captured from the first one, so that undo would delete the
        // successor's own sections. Nothing has been changed yet. (A SpeleoDB
        // sign-in or sign-out in the window bumps the generation too; refusing
        // then is conservative, and the user simply adds again.)
        if self.speleodb_session_generation() != slot_generation {
            return CommandResult::failure(format!(
                "The open project changed while '{label}' was being read, so it was not \
                 added. No changes were made."
            ));
        }
        let report = match Self::append_into_open(project, &source) {
            Ok(report) => report,
            Err(e) => return CommandResult::failure(e),
        };
        // Under the same project guard as the copy, so a save can never see the
        // sections without their ignores (the save reads both under it).
        self.add_pending_ignores(project, &report.ignores);
        let shot_count: u32 = report
            .outcome
            .new_section_ids
            .iter()
            .filter_map(|id| project.get_section(*id))
            .map(|s| s.shots.len() as u32)
            .sum();
        drop(guard);

        tracing::info!(
            sections = report.outcome.new_section_ids.len(),
            ignores = report.ignores.len(),
            purpose = "add a project file into the open project",
            "Added a .stalx file's survey to the open project"
        );
        let receipt = Self::add_receipt(&label, &source, &report, shot_count);
        CommandResult::success()
            .with_section_ids(report.outcome.new_section_ids)
            .with_import_receipt(receipt)
    }

    /// The copy and everything that settles it. On any failure the project is
    /// returned to exactly what it was, by the same removal the undo runs.
    fn append_into_open(project: &mut Project, source: &AddSource) -> Result<AppendReport, String> {
        // Section-id budget (#555), before a single section is appended: shot
        // ids encode as `section_id * FEATURE_ID_STRIDE + position` in 32 bits,
        // and `Section::new` computes that unchecked.
        let incoming = source.project.sections.len();
        let spent = project.next_section_id as usize;
        if incoming.saturating_add(spent) > MAX_SECTIONS_IN_ID_SPACE {
            return Err(format!(
                "Add refused: the file holds {incoming} sections and this project has \
                 already used {spent} section ids, past the limit of \
                 {MAX_SECTIONS_IN_ID_SPACE} for one project. Shot ids encode as \
                 section_id * {FEATURE_ID_STRIDE} + position in 32 bits, so section ids \
                 past {MAX_SECTION_ID} cannot hold shots. No changes were made."
            ));
        }
        let identity = stalx_identity(&source.project);
        let duplicate = if identity == stalx_identity(project) {
            Some("is a copy of the open project")
        } else if project.imported_file_hashes.contains(&identity) {
            Some("was already added to this project")
        } else {
            None
        };
        let frame_before = project.frame_datum().map(|d| d.gps);
        let pre_critical = project.has_critical_integrity_violations();
        let closures_before = project.loop_closures.len();
        let baseline = AddedContent::stub(project);
        let roll_back = |project: &mut Project, baseline: AddedContent| {
            if let Some(added) = baseline.finalize(project, Vec::new()) {
                added.remove_from(project);
            }
        };

        let outcome = match append_project(project, &source.project) {
            Ok(outcome) => outcome,
            Err(e) => {
                roll_back(project, baseline);
                return Err(e);
            }
        };
        project.assign_closure_ids();
        // The append stores transitional positional keys; give them the stable
        // anchors an open would, before anything can renumber a station.
        project.reanchor_station_refs();
        place_by_datum(project, &outcome.new_section_ids, frame_before);

        // Carry the source's dedup state, so re-importing the Ariane/DMP file it
        // was built from is still caught here, plus its own identity.
        for hash in &source.project.imported_file_hashes {
            if !project.imported_file_hashes.contains(hash) {
                project.imported_file_hashes.push(hash.clone());
            }
        }
        for hash in &source.project.imported_section_hashes {
            if !project.imported_section_hashes.contains(hash) {
                project.imported_section_hashes.push(hash.clone());
            }
        }
        if !project.imported_file_hashes.contains(&identity) {
            project.imported_file_hashes.push(identity);
        }

        // Block corruption at the source without a whole-project snapshot: the
        // append only ever ADDS, so taking out what it added is an exact
        // rollback. An already-critical project (opened that way) is not
        // blocked, matching `execute`'s guard.
        if !pre_critical && project.has_critical_integrity_violations() {
            roll_back(project, baseline);
            return Err(
                "Blocked: the file's survey has integrity problems that would corrupt \
                        this project. Open it, repair it, and add it again. No changes were made."
                    .to_string(),
            );
        }

        let ignores = source
            .ignores
            .as_deref()
            .map(|rows| remap_ignores(&source.project, rows, &outcome))
            .unwrap_or_default();
        Ok(AppendReport {
            closures_created: project.loop_closures.len().saturating_sub(closures_before) as u32,
            outcome,
            ignores,
            duplicate,
        })
    }

    fn add_receipt(
        label: &str,
        source: &AddSource,
        report: &AppendReport,
        shot_count: u32,
    ) -> ImportReceipt {
        let mut warnings = Vec::new();
        if let Some(why) = report.duplicate {
            warnings.push(format!("'{label}' {why}; its sections were added again"));
        }
        if let Some(link) = &source.link {
            let name = sanitize_display_text(&link.project_name, MAX_FILE_NAME_LEN);
            warnings.push(format!(
                "'{label}' is linked to SpeleoDB project '{name}'; its data was copied, \
                 that project is unchanged"
            ));
        }
        if let Some((incoming, existing)) = report.outcome.elevation_conflict {
            warnings.push(format!(
                "'{label}' has an entrance elevation of {incoming:.2} m, which differs from \
                 this project's {existing:.2} m; kept {existing:.2} m"
            ));
        }
        if source.ignores.is_none() {
            warnings.push(format!(
                "The ignored warnings in '{label}' could not be read and were not carried over"
            ));
        }
        if source.project.sections.is_empty() {
            warnings.push(format!("'{label}' holds no survey sections"));
        }
        let mut receipt = ImportReceipt {
            source_format: "Stalagmight".to_string(),
            file_name: label.to_string(),
            sections_found: source.project.sections.len() as u32,
            sections_imported: report.outcome.new_section_ids.len() as u32,
            shot_count,
            closures_requested: source.project.loop_closures.len() as u32,
            closures_created: report.closures_created,
            unit_conversion: None,
            warnings,
            info: Vec::new(),
            zero_datum_created: None,
        };
        receipt.cap_warnings();
        receipt
    }

    // === Ignores carried by an add, until a save persists them ===
    //
    // `resolved_warnings` lives in the open file's database with a FOREIGN KEY
    // on `sections(id)`, and an added section is not in that table until the
    // next save - so an ignore carried in for it cannot be written there yet.
    // It waits here, is honored by `compute_project_warnings` meanwhile, and is
    // written by the save that writes its section. Lock order: `project`
    // outranks this one, and nothing is ever taken while holding it.

    /// The carried ignores not yet in the database.
    pub(super) fn pending_ignores(&self) -> Vec<ResolvedWarning> {
        self.pending_ignores
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone()
    }

    /// Forget every pending ignore: a save wrote them, or the project they
    /// belonged to left the slot.
    pub(super) fn clear_pending_ignores(&self) {
        self.pending_ignores
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clear();
    }

    /// Hold `ignores` until the next save, keyed by the live shot's id.
    pub(super) fn add_pending_ignores(&self, project: &Project, ignores: &[CarriedIgnore]) {
        let mut pending = self
            .pending_ignores
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        for ignore in ignores {
            let Some(shot_id) = project
                .get_section(ignore.section_id)
                .and_then(|s| {
                    s.shots
                        .iter()
                        .find(|shot| shot.uuid.as_deref() == Some(ignore.shot_uuid.as_str()))
                })
                .map(|shot| shot.id)
            else {
                continue;
            };
            let already = pending.iter().any(|row| {
                row.section_id == ignore.section_id
                    && row.warning_code == ignore.warning_code
                    && row.shot_uuid.as_deref() == Some(ignore.shot_uuid.as_str())
            });
            if !already {
                pending.push(ResolvedWarning {
                    section_id: ignore.section_id,
                    shot_id,
                    warning_code: ignore.warning_code.clone(),
                    resolved_at: ignore.resolved_at,
                    resolved_comment: ignore.resolved_comment.clone(),
                    shot_uuid: Some(ignore.shot_uuid.clone()),
                });
            }
        }
    }

    /// Drop the pending ignores of `sections` (the undo of an add). Rows a save
    /// already wrote stay in the database: they name sections the undo just
    /// removed, so they match nothing, and the next save drops them - while a
    /// close WITHOUT saving keeps the file and its ignores consistent.
    pub(super) fn remove_pending_ignores(&self, sections: &HashSet<SectionId>) {
        self.pending_ignores
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .retain(|row| !sections.contains(&row.section_id));
    }

    /// Un-ignore (#57) of a pending row; true when one was removed.
    pub(super) fn forget_pending_ignore(
        &self,
        section_id: SectionId,
        shot_id: u32,
        warning_code: &str,
        shot_uuid: Option<&str>,
    ) -> bool {
        let mut pending = self
            .pending_ignores
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let before = pending.len();
        pending.retain(|row| {
            // Every pending row is uuid-keyed; the in-session id is only the
            // address a caller with no uuid has.
            let same_shot = match shot_uuid {
                Some(uuid) => row.shot_uuid.as_deref() == Some(uuid),
                None => row.shot_id == shot_id,
            };
            !(row.section_id == section_id && row.warning_code == warning_code && same_shot)
        });
        pending.len() != before
    }

    /// Every uuid-keyed ignore currently in force on `sections` - pending or
    /// already saved - as an add's undo records them, so the redo puts back the
    /// ignores the undo found rather than the ones the add first brought.
    pub(super) fn ignores_on_sections(&self, sections: &HashSet<SectionId>) -> Vec<CarriedIgnore> {
        let saved = {
            let db = self
                .database
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            db.as_ref()
                .and_then(|db| db.load_resolved_warnings_verbatim().ok())
                .unwrap_or_default()
        };
        let mut found: Vec<CarriedIgnore> = Vec::new();
        for row in self.pending_ignores().iter().chain(saved.iter()) {
            let Some(uuid) = row.shot_uuid.clone() else {
                continue;
            };
            if !sections.contains(&row.section_id) {
                continue;
            }
            let ignore = CarriedIgnore {
                section_id: row.section_id,
                shot_uuid: uuid,
                warning_code: row.warning_code.clone(),
                resolved_at: row.resolved_at,
                resolved_comment: row.resolved_comment.clone(),
            };
            if !found.iter().any(|c| same_ignore(c, &ignore)) {
                found.push(ignore);
            }
        }
        found
    }
}

/// The window between the add's two `project` locks, where the source file is
/// read. A no-op outside tests.
#[cfg(not(test))]
fn between_locks(_state: &AppState) {}

/// Test-only: run the hook a test installed with [`set_between_locks`], once.
/// Per thread, so it reaches no other test. Defined below every production
/// item on purpose: the slot-commit tripwire in `speleodb_session` reads each
/// file only up to its first test gate.
#[cfg(test)]
fn between_locks(state: &AppState) {
    let hook = BETWEEN_LOCKS.with(|slot| slot.borrow_mut().take());
    if let Some(hook) = hook {
        hook(state);
    }
}

#[cfg(test)]
type BetweenLocksHook = Box<dyn FnOnce(&AppState)>;

#[cfg(test)]
thread_local! {
    static BETWEEN_LOCKS: std::cell::RefCell<Option<BetweenLocksHook>> =
        const { std::cell::RefCell::new(None) };
}

/// Test-only: run `hook` inside the next add's file-read window on this thread.
#[cfg(test)]
pub(super) fn set_between_locks(hook: impl FnOnce(&AppState) + 'static) {
    BETWEEN_LOCKS.with(|slot| *slot.borrow_mut() = Some(Box::new(hook)));
}
