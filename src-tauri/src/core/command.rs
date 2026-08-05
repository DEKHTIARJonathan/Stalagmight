use chrono::NaiveDate;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use ts_rs::TS;

use crate::models::{
    shot_display_position, ClosureStrategy, Coordinates, GpsCoordinates, SectionId, SectionUpdates,
    ShotData, ShotId, ShotKind, ShotUpdates, StationRef, SurveyDirection,
};

/// Identifies either a station or a shot as a comment holder
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum CommentHolder {
    Station {
        station_ref: StationRef,
    },
    Shot {
        section_id: SectionId,
        shot_id: ShotId,
    },
}

impl std::fmt::Display for CommentHolder {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            CommentHolder::Station { station_ref } => write!(f, "station {station_ref}"),
            CommentHolder::Shot {
                section_id,
                shot_id,
            } => {
                let pos = shot_display_position(*shot_id, *section_id);
                write!(f, "shot {section_id}:{pos}")
            }
        }
    }
}

/// All persistent commands that modify project state
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Command {
    // Project commands
    CreateProject {
        name: String,
        location: Option<String>,
    },
    OpenProject {
        path: PathBuf,
    },
    SaveProject {
        path: Option<PathBuf>,
    },
    CloseProject,

    // Section commands
    CreateSection {
        name: Option<String>,
        surveyor: Option<String>,
        date: Option<NaiveDate>,
        color: String,
        #[serde(default)]
        direction: Option<SurveyDirection>,
        shots: Vec<ShotData>,
    },
    DeleteSection {
        section_id: SectionId,
    },
    UpdateSectionMetadata {
        section_id: SectionId,
        updates: SectionUpdates,
    },
    /// Reverse a section end-to-end so the far end becomes station 0, keeping
    /// every station's world coordinate (see [`crate::models::Project::reverse_section`]).
    /// `swap_left_right` also mirrors the `left`/`right` passage dimensions; it
    /// is opt-in because whether LRUD was recorded facing along travel is a
    /// survey convention we cannot infer.
    ReverseSection {
        section_id: SectionId,
        #[serde(default)]
        swap_left_right: bool,
    },

    // Shot commands
    CreateShot {
        section_id: SectionId,
        shot: ShotData,
        after_shot_id: Option<ShotId>,
        #[serde(default)]
        before_shot_id: Option<ShotId>,
    },
    UpdateShot {
        section_id: SectionId,
        shot_id: ShotId,
        updates: ShotUpdates,
    },
    DeleteShot {
        section_id: SectionId,
        shot_id: ShotId,
    },
    /// Set a shot's [`ShotKind`] (#27). Replaces the old boolean
    /// `SetShotReference`.
    ///
    /// Reads pre-#27 persisted undo history **losslessly** rather than forcing
    /// it to be discarded: the variant aliases the old `set_shot_reference` /
    /// `set_shot_virtual` tags, and the `kind` field aliases the old
    /// `is_reference` bool through `models::shot::de_shot_kind`, which
    /// maps `true` to [`ShotKind::Jump`] per q2. An old entry's inverse
    /// (`SetShotReference { is_reference: !x }`) therefore still round-trips, so
    /// upgrading does not cost the user their undo stack.
    #[serde(alias = "set_shot_virtual", alias = "set_shot_reference")]
    SetShotKind {
        section_id: SectionId,
        shot_id: ShotId,
        #[serde(
            default,
            alias = "is_reference",
            alias = "is_virtual",
            deserialize_with = "crate::models::shot::de_shot_kind"
        )]
        kind: ShotKind,
    },

    // Station commands
    MergeStations {
        station_a: StationRef,
        station_b: StationRef,
    },
    UnmergeStations {
        station_ref: StationRef,
    },
    UnmergeStationPair {
        station_a: StationRef,
        station_b: StationRef,
    },
    CreateLoopClosure {
        station_a: StationRef,
        station_b: StationRef,
        closure_strategy: ClosureStrategy,
    },
    RemoveLoopClosure {
        closure_id: u64,
    },
    SetZeroDatum {
        station_ref: StationRef,
        coordinates: GpsCoordinates,
    },
    RemoveZeroDatum {
        station_ref: StationRef,
    },

    // Station comment commands
    SetStationComment {
        station_ref: StationRef,
        comment: Option<String>,
    },

    // Move commands
    MoveSection {
        section_id: SectionId,
        offset: Coordinates,
    },
    MoveSegment {
        section_id: SectionId,
        offset: Coordinates,
    },
    MoveStation {
        station_ref: StationRef,
        offset: Coordinates,
    },

    // Comment move commands
    MoveComment {
        source: CommentHolder,
        target: CommentHolder,
        swap: bool,
    },

    // Batch commands
    Batch {
        commands: Vec<Command>,
    },

    // Project merge command
    MergeProjects {
        /// Paths to the source projects to merge
        source_paths: Vec<PathBuf>,
        /// Path for the merged output project
        output_path: PathBuf,
        /// Name for the merged project
        output_name: String,
        /// Whether to archive (rename) the original files
        archive_originals: bool,
    },
    /// Repair the open project's structural integrity (drop dangling refs, re-mint
    /// duplicate UUIDs, re-cascade offsets). Applied directly via the
    /// `repair_project_integrity` IPC command, which records its own snapshot-pair
    /// undo entry; this variant exists only to LABEL that entry in the undo
    /// history and is never run through `execute()`.
    RepairIntegrity,
    /// Per-project settings change (name + validation thresholds, #57). Like
    /// RepairIntegrity, applied via `update_project_settings` which records its
    /// own snapshot-pair undo entry; this variant only LABELS that entry and is
    /// never run through `execute()`.
    UpdateProjectSettings,
}

/// Coded-failure prefix for a mutation rejected because the open project is a
/// remote SpeleoDB project opened without a write lock (#191, D-B7). Mirrors the
/// `loading::PERMISSION_DENIED_CODE` string-prefix idiom: `CommandResult` has no
/// `code` field, so the code is prefixed onto the `error` string and the FE
/// (#204) pattern-matches `err.starts_with(EDIT_DISABLED_CODE)` to suppress the
/// toast. Deliberately NO `edit_enabled` query command here (that IPC is
/// #204/#209).
pub(crate) const EDIT_DISABLED_CODE: &str = "EDIT_DISABLED";

/// Coded-failure prefix for a mutation blocked by the lazy 20-min lock re-verify
/// (#202) because a definitive server answer showed the write lock is no longer
/// held by us. Same string-prefix idiom as [`EDIT_DISABLED_CODE`],
/// but distinct so the FE routes it to the divergence prompt (reconcile) instead of
/// the plain read-only notice. NOT a correctness guard - the release-time fence + a
/// 403 on push are - so a transient re-verify failure never emits this (it lets the
/// edit through and the fence catches any real conflict).
pub(crate) const EDIT_REVERIFY_DIVERGED_CODE: &str = "EDIT_REVERIFY_DIVERGED";

/// One section whose station numbering an operation reversed, together with the
/// shot count `N` that was IN FORCE at that reverse - the divisor the mirror
/// `i -> N - i` needs.
///
/// The count travels with the entry rather than being read off the refreshed
/// project because a multi-step `undo_to` can walk past a `CreateShot`: the
/// post-range count is then not the count the earlier steps mirrored against, and
/// a consumer that divided by it would land one station out.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct ReversedSection {
    pub section_id: u32,
    pub shot_count: u32,
}

/// Backend-authoritative summary of what an import command actually did, so the
/// frontend can show a receipt without re-deriving counts the backend already
/// computed (and, for the converter-level warnings below, cannot derive at all).
///
/// These warnings are DISTINCT from [`CommandResult::warnings`] and must never be
/// pushed through [`CommandResult::with_warning`]: that path stamps `code:
/// "SYSTEM"`, which the frontend's deferred-save-failure handling
/// (`saveFeedback.ts`) keys on exactly - mixing receipt warnings into it would
/// make an unrelated import-quality note look like the deferred-save failure the
/// #92/#104 contract exists to surface.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct ImportReceipt {
    pub source_format: String,
    pub file_name: String,
    pub sections_found: u32,
    pub sections_imported: u32,
    pub shot_count: u32,
    pub closures_requested: u32,
    pub closures_created: u32,
    pub unit_conversion: Option<String>,
    pub warnings: Vec<String>,
}

impl ImportReceipt {
    /// The receipt for an import that landed NOTHING: zero sections, zero
    /// shots, no closures. Every text field is a placeholder the importer's
    /// `decorate_receipt` fills in, including the warnings that say why the
    /// file produced nothing - which is the entire reason an empty import
    /// still carries a receipt.
    pub fn empty() -> Self {
        Self {
            source_format: String::new(),
            file_name: String::new(),
            sections_found: 0,
            sections_imported: 0,
            shot_count: 0,
            closures_requested: 0,
            closures_created: 0,
            unit_conversion: None,
            warnings: Vec::new(),
        }
    }

    /// Keep at most this many individual warnings before folding the rest
    /// into a single summary entry.
    const MAX_WARNINGS: usize = 50;
    /// Clamp each warning string to this many characters.
    const MAX_WARNING_LEN: usize = 300;

    /// Cap and clamp `warnings` so a hostile or malformed import file (this
    /// app is open-source, so an untrusted file is a real input, not a
    /// hypothetical) can't inflate the receipt into an unbounded allocation
    /// shipped back over IPC: at most [`Self::MAX_WARNINGS`] entries (the rest
    /// folded into one "... and N more warnings" summary), each clamped to
    /// [`Self::MAX_WARNING_LEN`] chars on a char boundary (never a raw byte
    /// slice - a warning can embed arbitrary user-controlled text).
    pub fn cap_warnings(&mut self) {
        if self.warnings.len() > Self::MAX_WARNINGS {
            let overflow = self.warnings.len() - Self::MAX_WARNINGS;
            self.warnings.truncate(Self::MAX_WARNINGS);
            self.warnings.push(format!(
                "... and {overflow} more warning{}",
                if overflow == 1 { "" } else { "s" }
            ));
        }
        for warning in &mut self.warnings {
            if let Some((cut, _)) = warning.char_indices().nth(Self::MAX_WARNING_LEN) {
                warning.truncate(cut);
            }
        }
    }
}

/// Result of command execution
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct CommandResult {
    pub success: bool,
    pub warnings: Vec<ValidationWarning>,
    pub error: Option<String>,
    /// ID of the created section (for CreateSection command)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub section_id: Option<u32>,
    /// IDs of created sections (for Batch commands containing CreateSection)
    #[serde(skip_serializing_if = "Vec::is_empty", default)]
    pub section_ids: Vec<u32>,
    /// ID of the created shot (for CreateShot command)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub shot_id: Option<u32>,
    /// Path the project was saved to (for SaveProject command)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub saved_path: Option<String>,
    /// Set when this command TORE DOWN the open project's session - today only
    /// `delete_project`, and only when the `.stalx` it deleted was the file backing
    /// the open project (matched with `same_file`).
    ///
    /// The frontend has to be TOLD, because neither half of the obvious prediction
    /// holds:
    ///
    /// * `success` is not a precondition. The backend closes BEFORE handing the
    ///   file to the OS trash, and it must: SQLite holds the file open without
    ///   `FILE_SHARE_DELETE`, so on Windows the trash is denied while that handle
    ///   lives and a close-afterwards would never be reached. A trash that then
    ///   fails for an unrelated reason (no write access to the parent directory)
    ///   therefore returns FAILURE with the session already gone.
    /// * the deleted path is not what the backend matched. `same_file`
    ///   canonicalizes, so a symlink, a `..` segment or a Windows case/short-name
    ///   variant of the open project's path tears the session down while a `===` on
    ///   the raw strings says it did not.
    ///
    /// Reporting it here also replaces what the frontend used to do instead - call
    /// `get_project_state` afterwards and test it for null. That answers the same
    /// yes/no question by cloning the whole project and recomputing station
    /// coordinates, stats, penetration and frozen shots, which on the 75k-shot
    /// projects this app is built for made every delete-while-open needlessly slow.
    ///
    /// `Option<bool>`, only ever `Some(true)`, for the same wire contract as
    /// `section_id` / `shot_id` / `saved_path` above: `skip_serializing_if` keeps
    /// the key absent for every command that closed nothing, and the `Option` is
    /// what makes ts-rs emit `session_closed?: boolean` rather than a required
    /// field that would break every existing `CommandResult` literal on the
    /// frontend (see `reversed_sections` for the same reasoning).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_closed: Option<bool>,
    /// Set when this save wrote a DETACHED COPY instead of saving the project:
    /// an explicit Save-As destination on a SpeleoDB-managed project writes the
    /// `.stalx` without its `speleo_link` row and leaves the session on the
    /// managed file (see `save_project`). The frontend must be TOLD, because
    /// the two things it normally does on a successful save are both wrong
    /// here: `saved_path` would re-point `project.file_path` at a file this
    /// session does not have open, and clearing `isDirty` would claim the open
    /// project had been persisted when it was not. `saved_path` is deliberately
    /// left `None` for exactly that reason. Same wire contract as the optional
    /// fields above (`skip_serializing_if`, so ts-rs emits `unlinked_copy_path?:`
    /// and the key stays absent for every ordinary save).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub unlinked_copy_path: Option<String>,
    /// The sections whose station NUMBERING this operation reversed (station `i`
    /// became station `N - i`), each carrying the shot count `N` in force at that
    /// reverse - for `ReverseSection`, for a `Batch` of them, and for an undo/redo
    /// of either (undoing a reverse re-reverses the numbering, so it reports the
    /// same sections).
    ///
    /// Every station keeps its world position, so this is not a geometry change
    /// the frontend can see by diffing coordinates: it exists so a positional
    /// station reference held on the frontend (a selection, a pinned plan point)
    /// can be mirrored EXACTLY rather than inferred by comparing station
    /// positions across the operation - an inference that misses a section which
    /// was reversed and moved in the same action.
    ///
    /// TWO SHAPES, and a consumer must not treat them alike:
    ///
    /// * From ONE command (`ReverseSection` or a `Batch`), this is a
    ///   PARITY-REDUCED set: [`Command::reversed_section_ids`] drops a section the
    ///   batch reversed an even number of times, because such a batch leaves the
    ///   numbering exactly as it found it and there is nothing to mirror. At most
    ///   one entry per section, and `shot_count` is unambiguous because a batch
    ///   cannot change it (`is_batch_allowed` admits no shot create/delete).
    /// * From `undo_to` / `redo_to`, this is an ORDERED PER-STEP LOG: one entry
    ///   per reversing step, in the order the steps ran, repeats intact. It is
    ///   deliberately NOT parity-reduced, because `shot_count` can differ between
    ///   steps (a `CreateShot` undone between two reverses of one section). The
    ///   consumer must COMPOSE the entries into a single transform and apply that
    ///   once; replaying the mirror per entry is wrong.
    ///
    /// Composition is required because the FRONTEND's mirror is not an involution: it is
    /// `i -> N - i` CLAMPED into range (`utils/reverseAftermath`), and a clamp is lossy, so
    /// replaying it per entry does not undo itself. The counts can also differ between entries
    /// - a `CreateShot` undone between two reverses of one section changes `N` - which is
    /// exactly the case neither "cancel the repeat" nor "replay the mirror twice" gets right.
    ///
    /// The sibling `.plnx` needs none of this: its plans name a station by the shots it sits
    /// BETWEEN, so a reverse does not move them at all (see `state::dive_plan`).
    ///
    /// Same wire contract as `section_ids` above - `skip_serializing_if` + `default`, so
    /// the key is simply absent for every command that reversed nothing and an older
    /// frontend is unaffected - but typed `Option` rather than `Vec` so ts-rs emits it as
    /// `reversed_sections?:` instead of a required array. That absence IS the wire
    /// truth (`section_ids` is typed required despite the same serde attributes, which is
    /// why its consumers already need `?? []`), and a required field would break every
    /// existing `CommandResult` literal on the frontend.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub reversed_sections: Option<Vec<ReversedSection>>,
    /// Backend-authoritative summary of an import command's outcome (see
    /// [`ImportReceipt`]'s doc comment for why its warnings must stay separate
    /// from the field above). Same wire contract as `reversed_sections`:
    /// `skip_serializing_if` + `default` keeps the key absent for every
    /// non-import command.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub import_receipt: Option<ImportReceipt>,
}

/// Result of an explicit "repair project integrity" action. `fixed` and
/// `remaining` are the drop in the FULL violation set (structural + merge/
/// closure alignment + orphan closures) measured before vs after the repair, so
/// they stay consistent with the integrity banner's count - unlike summing
/// per-operation counters that mix different units. `remaining` is whatever the
/// repair could not auto-fix (detect-only: a drifted aligned loop closure to
/// recompute/remove, or non-finite shot geometry to correct by hand).
///
/// `changed` is true when the repair actually mutated the project (an undo entry
/// was recorded). It is a STRICTLY broader signal than `fixed > 0`: the repair
/// always re-solves offsets, which heals sub-reporting-tolerance drift that never
/// counted as a violation - so `fixed` can be 0 while the project genuinely
/// changed. The frontend dirties the project on `changed` (not `fixed`) so that
/// silent sub-tolerance fixes are still auto-saved / prompted on close.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct IntegrityRepairResult {
    pub fixed: u32,
    pub remaining: u32,
    pub changed: bool,
}

/// Result of a structural-integrity check. `messages` is the human-readable
/// violation list (critical first; empty = sound). `save_blocked` is true when
/// the project currently has unresolvable cross-references - the exact condition
/// that refuses a save (manual AND auto-save). The frontend uses it to keep the
/// integrity banner non-dismissable while saving is blocked (so the Repair entry
/// point can't be hidden on a project that can't be saved), while still allowing
/// dismissal of detect-only issues that don't block saving.
#[derive(Debug, Clone, Default, Serialize, Deserialize, TS)]
pub struct IntegrityCheckResult {
    pub messages: Vec<String>,
    pub save_blocked: bool,
}

/// Validation warning from command execution
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct ValidationWarning {
    pub code: String,
    pub message: String,
    pub severity: WarningSeverity,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, TS)]
#[serde(rename_all = "lowercase")]
#[ts(rename_all = "lowercase")]
pub enum WarningSeverity {
    Warning,
    Error,
}

impl CommandResult {
    pub fn success() -> Self {
        Self {
            success: true,
            warnings: Vec::new(),
            error: None,
            section_id: None,
            section_ids: Vec::new(),
            shot_id: None,
            saved_path: None,
            session_closed: None,
            unlinked_copy_path: None,
            reversed_sections: None,
            import_receipt: None,
        }
    }

    pub fn failure(error: String) -> Self {
        Self {
            success: false,
            warnings: Vec::new(),
            error: Some(error),
            section_id: None,
            section_ids: Vec::new(),
            shot_id: None,
            saved_path: None,
            session_closed: None,
            unlinked_copy_path: None,
            reversed_sections: None,
            import_receipt: None,
        }
    }

    /// Attach validation warnings to this result.
    pub fn with_warnings(mut self, warnings: Vec<ValidationWarning>) -> Self {
        self.warnings = warnings;
        self
    }

    /// Attach a created section ID to this result.
    pub fn with_section_id(mut self, section_id: u32) -> Self {
        self.section_id = Some(section_id);
        self
    }

    /// Attach multiple section IDs to this result (for batch operations).
    pub fn with_section_ids(mut self, section_ids: Vec<u32>) -> Self {
        self.section_ids = section_ids;
        self
    }

    /// Attach a created shot ID to this result.
    pub fn with_shot_id(mut self, shot_id: u32) -> Self {
        self.shot_id = Some(shot_id);
        self
    }

    /// Attach the saved file path to this result.
    pub fn with_path(mut self, path: String) -> Self {
        self.saved_path = Some(path);
        self
    }

    /// Record whether this command tore the open project's session down.
    ///
    /// Takes the verdict rather than asserting it so both of `delete_project`'s
    /// return paths - the success one AND the early failure after a denied trash,
    /// which is the one the frontend most needs the bit on - can carry it from the
    /// same variable and neither can forget it. A `false` deliberately leaves the
    /// field `None` so the key stays off the wire for every command that closed
    /// nothing (see the field's doc comment); `Some(false)` is never produced.
    pub fn with_session_closed(mut self, closed: bool) -> Self {
        if closed {
            self.session_closed = Some(true);
        }
        self
    }

    /// Record that this save wrote a detached (unlinked) copy at `path` rather
    /// than saving the open project (see the field's doc comment).
    pub fn with_unlinked_copy_path(mut self, path: String) -> Self {
        self.unlinked_copy_path = Some(path);
        self
    }

    /// Attach the sections whose station numbering this operation reversed.
    pub fn with_reversed_sections(mut self, sections: Vec<ReversedSection>) -> Self {
        self.reversed_sections = Some(sections);
        self
    }

    /// Attach an import receipt to this result.
    pub fn with_import_receipt(mut self, receipt: ImportReceipt) -> Self {
        self.import_receipt = Some(receipt);
        self
    }

    /// Attach a single warning message to this result.
    pub fn with_warning(mut self, message: &str) -> Self {
        self.warnings.push(ValidationWarning {
            code: "SYSTEM".to_string(),
            message: message.to_string(),
            severity: WarningSeverity::Warning,
        });
        self
    }
}

impl Command {
    /// Whether this command can change measured survey geometry.
    ///
    /// This classification belongs to the command rather than to any one executor:
    /// geometry reconciliation, cache invalidation, and other consumers must agree on
    /// the same exhaustive answer. `UpdateShot` is instance-aware because the variant
    /// carries both measurements and metadata, and a batch inherits the union of its
    /// members.
    #[must_use]
    pub fn affects_geometry(&self) -> bool {
        match self {
            Command::CreateProject { .. }
            | Command::OpenProject { .. }
            | Command::SaveProject { .. }
            | Command::CloseProject
            | Command::UpdateSectionMetadata { .. }
            | Command::SetShotKind { .. }
            | Command::SetStationComment { .. }
            | Command::MoveComment { .. }
            | Command::RepairIntegrity
            | Command::UpdateProjectSettings => false,
            Command::UpdateShot { updates, .. } => updates.touches_geometry(),
            Command::Batch { commands } => commands.iter().any(Command::affects_geometry),
            Command::CreateSection { .. }
            | Command::DeleteSection { .. }
            | Command::ReverseSection { .. }
            | Command::CreateShot { .. }
            | Command::DeleteShot { .. }
            | Command::MergeStations { .. }
            | Command::UnmergeStations { .. }
            | Command::UnmergeStationPair { .. }
            | Command::CreateLoopClosure { .. }
            | Command::RemoveLoopClosure { .. }
            | Command::SetZeroDatum { .. }
            | Command::RemoveZeroDatum { .. }
            | Command::MoveSection { .. }
            | Command::MoveSegment { .. }
            | Command::MoveStation { .. }
            | Command::MergeProjects { .. } => true,
        }
    }

    /// Reduce a reverse log to its NET effect: keep an id only when it occurs an
    /// ODD number of times, in first-occurrence order.
    ///
    /// Parity is associative and commutative, so reducing sub-lists and then the
    /// concatenation gives the same answer as reducing once - nested batches are
    /// safe. Within a batch the shot count `N` cannot change (`is_batch_allowed`
    /// admits no `CreateShot`/`DeleteShot`/`DeleteSection`; `merge_stations` only
    /// records relations and `move_segment` only offsets), so a section reversed
    /// twice is not renumbered AT ALL: it must be neither reported nor fixed up.
    /// Reporting it would be actively wrong, because the two fix-ups
    /// `settle_reversed_sections` runs are applied once per list entry against one
    /// final project state, and neither is an involution there - a repeated id
    /// walks every saved `.plnx` key two stations along a numbering that never
    /// moved.
    fn net_reversed(ids: Vec<SectionId>) -> Vec<SectionId> {
        let mut counts: HashMap<SectionId, usize> = HashMap::new();
        for id in &ids {
            *counts.entry(*id).or_insert(0) += 1;
        }
        let mut net: Vec<SectionId> = Vec::new();
        for id in ids {
            if counts.get(&id).is_some_and(|n| n % 2 == 1) && !net.contains(&id) {
                net.push(id);
            }
        }
        net
    }

    /// The sections whose station numbering this command reverses, in command
    /// order, `Batch` included (reversing a multi-selection is one batched user
    /// action) and PARITY-REDUCED there via [`Self::net_reversed`].
    ///
    /// Read declaratively off the command rather than inferred afterwards from
    /// moved stations: a reverse keeps every station's world position, so there
    /// is nothing in the geometry to diff, and a section that was reversed AND
    /// moved in the same action defeats a position-based heuristic outright.
    /// Undo/redo of a snapshot pair reuses this on the stored command - undoing a
    /// reverse re-reverses the numbering, so the same sections apply.
    ///
    /// The reduction belongs HERE, at the producer, and not in `undo_to`/`redo_to`:
    /// those aggregate ACROSS commands, where the shot count can differ between
    /// steps, so their per-step entries must stay intact.
    pub fn reversed_section_ids(&self) -> Vec<SectionId> {
        match self {
            Command::ReverseSection { section_id, .. } => vec![*section_id],
            Command::Batch { commands } => Self::net_reversed(
                commands
                    .iter()
                    .flat_map(Command::reversed_section_ids)
                    .collect(),
            ),
            _ => Vec::new(),
        }
    }

    /// Get a human-readable description of this command
    pub fn description(&self) -> String {
        match self {
            Command::CreateProject { name, .. } => format!("Create project '{name}'"),
            Command::OpenProject { path } => {
                format!("Open project '{}'", path.display())
            }
            Command::SaveProject { path } => match path {
                Some(p) => format!("Save project to '{}'", p.display()),
                None => "Save project".to_string(),
            },
            Command::CloseProject => "Close project".to_string(),
            Command::CreateSection { name, .. } => {
                format!("Create section '{}'", name.as_deref().unwrap_or("unnamed"))
            }
            Command::DeleteSection { section_id } => {
                format!("Delete section {section_id}")
            }
            Command::UpdateSectionMetadata { section_id, .. } => {
                format!("Update section {section_id} metadata")
            }
            Command::ReverseSection { section_id, .. } => {
                format!("Reverse section {section_id}")
            }
            Command::CreateShot { section_id, .. } => {
                format!("Create shot in section {section_id}")
            }
            Command::UpdateShot {
                section_id,
                shot_id,
                ..
            } => format!(
                "Update shot {}:{}",
                section_id,
                shot_display_position(*shot_id, *section_id)
            ),
            Command::DeleteShot {
                section_id,
                shot_id,
            } => format!(
                "Delete shot {}:{}",
                section_id,
                shot_display_position(*shot_id, *section_id)
            ),
            Command::SetShotKind {
                section_id,
                shot_id,
                kind,
            } => {
                let pos = shot_display_position(*shot_id, *section_id);
                match kind {
                    ShotKind::Normal => format!("Mark shot {section_id}:{pos} as permanent"),
                    ShotKind::Jump => format!("Mark shot {section_id}:{pos} as jump"),
                    ShotKind::Reference => format!("Mark shot {section_id}:{pos} as reference"),
                }
            }
            Command::MergeStations {
                station_a,
                station_b,
                ..
            } => format!("Merge stations {station_a} and {station_b}"),
            Command::UnmergeStations { station_ref } => {
                format!("Unmerge station {station_ref}")
            }
            Command::UnmergeStationPair {
                station_a,
                station_b,
            } => {
                format!("Unmerge station pair {station_a} and {station_b}")
            }
            Command::CreateLoopClosure {
                station_a,
                station_b,
                ..
            } => format!("Create loop closure between {station_a} and {station_b}"),
            Command::RemoveLoopClosure { closure_id } => {
                format!("Remove loop closure #{closure_id}")
            }
            Command::SetZeroDatum { station_ref, .. } => {
                format!("Set zero datum at {station_ref}")
            }
            Command::RemoveZeroDatum { station_ref } => {
                format!("Remove zero datum from {station_ref}")
            }
            Command::SetStationComment {
                station_ref,
                comment,
            } => {
                if comment.is_some() {
                    format!("Set comment on station {station_ref}")
                } else {
                    format!("Remove comment from station {station_ref}")
                }
            }
            Command::MoveSection { section_id, .. } => {
                format!("Move section {section_id}")
            }
            Command::MoveSegment { section_id, .. } => {
                format!("Move segment (section {section_id})")
            }
            Command::MoveStation { station_ref, .. } => {
                format!("Move station {station_ref}")
            }
            Command::MoveComment {
                source,
                target,
                swap,
            } => {
                if *swap {
                    format!("Swap comments between {source} and {target}")
                } else {
                    format!("Move comment from {source} to {target}")
                }
            }
            Command::Batch { commands } => {
                format!("Batch of {} commands", commands.len())
            }
            Command::MergeProjects {
                source_paths,
                output_name,
                ..
            } => {
                format!(
                    "Merge {} projects into '{}'",
                    source_paths.len(),
                    output_name
                )
            }
            Command::RepairIntegrity => "Repair integrity".to_string(),
            Command::UpdateProjectSettings => "Update project settings".to_string(),
        }
    }
}

#[cfg(test)]
#[expect(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod tests {
    use super::*;
    use crate::models::{
        ClosureStrategy, Coordinates, GpsCoordinates, SectionUpdates, ShotData, ShotUpdates,
        StationRef,
    };
    use chrono::NaiveDate;

    /// Pins the `Command` variant SET, so removing one cannot pass silently.
    ///
    /// `Command` is `#[serde(tag = "type")]` with no catch-all, so a persisted
    /// undo entry naming a deleted variant stops deserializing - and
    /// `UndoStack::load_from_persisted_with_timestamps` SKIPS a bad entry rather
    /// than truncating, keeping the entries on BOTH sides. The stack then loads
    /// with a HOLE, and undoing past it replays older entries against a tree they
    /// no longer describe. `ApplyCollabChanges` is the worked example: schema v15
    /// has to call `drop_legacy_undo_history` for exactly that reason, as v11->v12
    /// and v12->v13 did before it.
    ///
    /// Its sibling `legacy_set_shot_reference_undo_entries_still_deserialize`
    /// covers the other half of this hazard - a RENAMED tag, which can be kept
    /// loadable with `#[serde(alias = ...)]`. A removal cannot.
    ///
    /// If this fires because you removed a variant: either keep its tag
    /// deserializable, or bump `SCHEMA_VERSION` and drop the persisted history in
    /// the new migration step. If you added one, just update the count.
    #[test]
    fn command_variant_set_is_pinned_so_a_removal_cannot_pass_silently() {
        let manifest_dir = env!("CARGO_MANIFEST_DIR");
        let path = format!("{manifest_dir}/src/core/command.rs");
        let src =
            std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("Failed to read {path}: {e}"));

        let start = src
            .find("pub enum Command {")
            .expect("pub enum Command not found");
        let end = src[start..]
            .find("\n}\n")
            .expect("end of `enum Command` not found");

        // Variants sit at exactly four-space indent. Fields and attributes are
        // deeper, and doc comments start with `/`, so an uppercase first char at
        // that indent identifies a variant.
        let variants: Vec<&str> = src[start..start + end]
            .lines()
            .filter_map(|line| {
                let rest = line.strip_prefix("    ")?;
                if rest.starts_with(' ') || !rest.starts_with(char::is_uppercase) {
                    return None;
                }
                rest.split(|c: char| !c.is_alphanumeric()).next()
            })
            .filter(|v| !v.is_empty())
            .collect();

        assert_eq!(
            variants.len(),
            28,
            "Command's variant set changed. A removal leaves persisted undo \
             history unloadable at that entry and holed either side of it - keep \
             the tag deserializable, or bump SCHEMA_VERSION and call \
             drop_legacy_undo_history in the new migration step. Saw: {variants:?}"
        );
    }

    #[test]
    fn geometry_classification_enumerates_every_command_variant() {
        let station_a = StationRef::new(1, 0);
        let station_b = StationRef::new(1, 1);
        let geometry_update = ShotUpdates {
            length: Some(4.0),
            ..Default::default()
        };
        let cases = vec![
            (
                Command::CreateProject {
                    name: String::new(),
                    location: None,
                },
                false,
            ),
            (
                Command::OpenProject {
                    path: PathBuf::new(),
                },
                false,
            ),
            (Command::SaveProject { path: None }, false),
            (Command::CloseProject, false),
            (
                Command::CreateSection {
                    name: None,
                    surveyor: None,
                    date: None,
                    color: String::new(),
                    direction: None,
                    shots: Vec::new(),
                },
                true,
            ),
            (Command::DeleteSection { section_id: 1 }, true),
            (
                Command::UpdateSectionMetadata {
                    section_id: 1,
                    updates: SectionUpdates::default(),
                },
                false,
            ),
            (
                Command::ReverseSection {
                    section_id: 1,
                    swap_left_right: false,
                },
                true,
            ),
            (
                Command::CreateShot {
                    section_id: 1,
                    shot: ShotData::default(),
                    after_shot_id: None,
                    before_shot_id: None,
                },
                true,
            ),
            (
                Command::UpdateShot {
                    section_id: 1,
                    shot_id: 1,
                    updates: geometry_update,
                },
                true,
            ),
            (
                Command::DeleteShot {
                    section_id: 1,
                    shot_id: 1,
                },
                true,
            ),
            (
                Command::SetShotKind {
                    section_id: 1,
                    shot_id: 1,
                    kind: ShotKind::Jump,
                },
                false,
            ),
            (
                Command::MergeStations {
                    station_a,
                    station_b,
                },
                true,
            ),
            (
                Command::UnmergeStations {
                    station_ref: station_a,
                },
                true,
            ),
            (
                Command::UnmergeStationPair {
                    station_a,
                    station_b,
                },
                true,
            ),
            (
                Command::CreateLoopClosure {
                    station_a,
                    station_b,
                    closure_strategy: ClosureStrategy::ProportionalByLength,
                },
                true,
            ),
            (Command::RemoveLoopClosure { closure_id: 1 }, true),
            (
                Command::SetZeroDatum {
                    station_ref: station_a,
                    coordinates: GpsCoordinates::new(1.0, 2.0, 3.0).unwrap(),
                },
                true,
            ),
            (
                Command::RemoveZeroDatum {
                    station_ref: station_a,
                },
                true,
            ),
            (
                Command::SetStationComment {
                    station_ref: station_a,
                    comment: None,
                },
                false,
            ),
            (
                Command::MoveSection {
                    section_id: 1,
                    offset: Coordinates::default(),
                },
                true,
            ),
            (
                Command::MoveSegment {
                    section_id: 1,
                    offset: Coordinates::default(),
                },
                true,
            ),
            (
                Command::MoveStation {
                    station_ref: station_a,
                    offset: Coordinates::default(),
                },
                true,
            ),
            (
                Command::MoveComment {
                    source: CommentHolder::Station {
                        station_ref: station_a,
                    },
                    target: CommentHolder::Station {
                        station_ref: station_b,
                    },
                    swap: false,
                },
                false,
            ),
            (
                Command::Batch {
                    commands: vec![Command::CloseProject],
                },
                false,
            ),
            (
                Command::MergeProjects {
                    source_paths: Vec::new(),
                    output_path: PathBuf::new(),
                    output_name: String::new(),
                    archive_originals: false,
                },
                true,
            ),
            (Command::RepairIntegrity, false),
            (Command::UpdateProjectSettings, false),
        ];

        assert_eq!(
            cases.len(),
            28,
            "add every new Command variant to this table"
        );
        for (command, expected) in cases {
            assert_eq!(command.affects_geometry(), expected, "{command:?}");
        }

        let metadata_update = Command::UpdateShot {
            section_id: 1,
            shot_id: 1,
            updates: ShotUpdates {
                comment: Some(Some("metadata".to_owned())),
                ..Default::default()
            },
        };
        assert!(!metadata_update.affects_geometry());
        assert!(Command::Batch {
            commands: vec![metadata_update, Command::DeleteSection { section_id: 1 }],
        }
        .affects_geometry());
    }

    #[test]
    fn legacy_set_shot_reference_undo_entries_still_deserialize() {
        // Pre-#27 persisted undo history is JSON-tagged `set_shot_reference`
        // with an `is_reference` bool. It must still load, otherwise upgrading
        // would silently throw away the user's undo stack.
        let legacy =
            r#"{"type":"set_shot_reference","section_id":1,"shot_id":2,"is_reference":true}"#;
        let parsed: Command = serde_json::from_str(legacy).unwrap();
        // q2: a legacy virtual shot reads as a Jump, and the ids survive.
        assert!(
            matches!(
                parsed,
                Command::SetShotKind {
                    section_id: 1,
                    shot_id: 2,
                    kind: ShotKind::Jump,
                }
            ),
            "legacy set_shot_reference must map onto SetShotKind: {parsed:?}"
        );

        // The false case, which is what an old inverse command carried.
        let legacy_false =
            r#"{"type":"set_shot_reference","section_id":1,"shot_id":2,"is_reference":false}"#;
        let parsed: Command = serde_json::from_str(legacy_false).unwrap();
        assert!(matches!(
            parsed,
            Command::SetShotKind {
                kind: ShotKind::Normal,
                ..
            }
        ));

        // And the even older `set_shot_virtual` tag.
        let ancient = r#"{"type":"set_shot_virtual","section_id":1,"shot_id":2,"is_virtual":true}"#;
        let parsed: Command = serde_json::from_str(ancient).unwrap();
        assert!(matches!(
            parsed,
            Command::SetShotKind {
                kind: ShotKind::Jump,
                ..
            }
        ));
    }
    use std::path::PathBuf;

    // Re-import CommentHolder so tests can use it without qualification
    use super::CommentHolder;

    #[test]
    fn command_result_builder_sets_fields() {
        let warning = ValidationWarning {
            code: "test".to_string(),
            message: "warn".to_string(),
            severity: WarningSeverity::Warning,
        };

        let success = CommandResult::success();
        assert!(success.success);
        assert!(success.warnings.is_empty());
        assert!(success.error.is_none());
        assert!(success.section_id.is_none());
        assert!(success.section_ids.is_empty());
        assert!(success.shot_id.is_none());
        assert!(success.saved_path.is_none());
        assert!(success.unlinked_copy_path.is_none());

        let with_path = CommandResult::success().with_path("/tmp/test.stalx".to_string());
        assert!(with_path.success);
        assert_eq!(with_path.saved_path.as_deref(), Some("/tmp/test.stalx"));

        let with_copy =
            CommandResult::success().with_unlinked_copy_path("/tmp/copy.stalx".to_string());
        assert!(with_copy.success);
        assert_eq!(
            with_copy.unlinked_copy_path.as_deref(),
            Some("/tmp/copy.stalx")
        );
        assert!(
            with_copy.saved_path.is_none(),
            "a copy save must never also claim saved_path (the frontend re-points on it)"
        );

        let with_warnings = CommandResult::success().with_warnings(vec![warning.clone()]);
        assert!(with_warnings.success);
        assert_eq!(with_warnings.warnings.len(), 1);
        assert!(with_warnings.error.is_none());
        assert!(with_warnings.section_id.is_none());
        assert!(with_warnings.section_ids.is_empty());
        assert!(with_warnings.shot_id.is_none());

        let with_section = CommandResult::success().with_section_id(7);
        assert!(with_section.success);
        assert_eq!(with_section.section_id, Some(7));
        assert!(with_section.section_ids.is_empty());
        assert!(with_section.shot_id.is_none());

        let with_section_and_warnings = CommandResult::success()
            .with_section_id(8)
            .with_warnings(vec![warning.clone()]);
        assert!(with_section_and_warnings.success);
        assert_eq!(with_section_and_warnings.section_id, Some(8));
        assert_eq!(with_section_and_warnings.warnings.len(), 1);
        assert!(with_section_and_warnings.shot_id.is_none());

        let with_sections = CommandResult::success().with_section_ids(vec![1, 2, 3]);
        assert!(with_sections.success);
        assert!(with_sections.section_id.is_none());
        assert_eq!(with_sections.section_ids, vec![1, 2, 3]);
        assert!(with_sections.shot_id.is_none());

        let with_sections_and_warnings = CommandResult::success()
            .with_section_ids(vec![4, 5])
            .with_warnings(vec![warning.clone()]);
        assert!(with_sections_and_warnings.success);
        assert_eq!(with_sections_and_warnings.section_ids, vec![4, 5]);
        assert_eq!(with_sections_and_warnings.warnings.len(), 1);
        assert!(with_sections_and_warnings.shot_id.is_none());

        let with_shot = CommandResult::success().with_shot_id(42);
        assert!(with_shot.success);
        assert_eq!(with_shot.shot_id, Some(42));
        assert!(with_shot.section_id.is_none());
        assert!(with_shot.section_ids.is_empty());

        let with_shot_and_warnings = CommandResult::success()
            .with_shot_id(99)
            .with_warnings(vec![warning]);
        assert!(with_shot_and_warnings.success);
        assert_eq!(with_shot_and_warnings.shot_id, Some(99));
        assert_eq!(with_shot_and_warnings.warnings.len(), 1);

        let failure = CommandResult::failure("boom".to_string());
        assert!(!failure.success);
        assert!(failure.warnings.is_empty());
        assert_eq!(failure.error.as_deref(), Some("boom"));
        assert!(failure.section_id.is_none());
        assert!(failure.section_ids.is_empty());
        assert!(failure.shot_id.is_none());
    }

    #[test]
    fn command_description_covers_all_variants() {
        let shot_data = ShotData {
            azimuth_in: 10.0,
            azimuth_out: 20.0,
            length: 3.0,
            depth_in: 1.0,
            depth_out: 2.0,
            ..Default::default()
        };
        let section_updates = SectionUpdates {
            name: Some(Some("Updated".to_string())),
            ..Default::default()
        };
        let shot_updates = ShotUpdates {
            length: Some(4.0),
            ..Default::default()
        };
        let station_a = StationRef::new(1, 0);
        let station_b = StationRef::new(1, 1);
        let gps = GpsCoordinates::new(10.0, 20.0, 5.0).unwrap();

        let cases = vec![
            (
                Command::CreateProject {
                    name: "Alpha".to_string(),
                    location: None,
                },
                "Create project 'Alpha'",
            ),
            (
                Command::OpenProject {
                    path: PathBuf::from("alpha.stalx"),
                },
                "Open project 'alpha.stalx'",
            ),
            (Command::SaveProject { path: None }, "Save project"),
            (
                Command::SaveProject {
                    path: Some(PathBuf::from("alpha.stalx")),
                },
                "Save project to 'alpha.stalx'",
            ),
            (Command::CloseProject, "Close project"),
            (
                Command::CreateSection {
                    name: Some("Main".to_string()),
                    surveyor: None,
                    date: Some(NaiveDate::from_ymd_opt(2025, 1, 1).unwrap()),
                    color: "#fff".to_string(),
                    direction: Some(SurveyDirection::In),
                    shots: vec![shot_data.clone()],
                },
                "Create section 'Main'",
            ),
            (Command::DeleteSection { section_id: 3 }, "Delete section 3"),
            (
                Command::UpdateSectionMetadata {
                    section_id: 3,
                    updates: section_updates,
                },
                "Update section 3 metadata",
            ),
            (
                Command::CreateShot {
                    section_id: 4,
                    shot: shot_data,
                    after_shot_id: None,
                    before_shot_id: None,
                },
                "Create shot in section 4",
            ),
            (
                Command::UpdateShot {
                    section_id: 4,
                    shot_id: 2,
                    updates: shot_updates,
                },
                "Update shot 4:3",
            ),
            (
                Command::DeleteShot {
                    section_id: 4,
                    shot_id: 2,
                },
                "Delete shot 4:3",
            ),
            (
                Command::SetShotKind {
                    section_id: 4,
                    shot_id: 2,
                    kind: ShotKind::Reference,
                },
                "Mark shot 4:3 as reference",
            ),
            (
                Command::SetShotKind {
                    section_id: 4,
                    shot_id: 2,
                    kind: ShotKind::Jump,
                },
                "Mark shot 4:3 as jump",
            ),
            (
                Command::SetShotKind {
                    section_id: 4,
                    shot_id: 2,
                    kind: ShotKind::Normal,
                },
                "Mark shot 4:3 as permanent",
            ),
            (
                Command::MergeStations {
                    station_a,
                    station_b,
                },
                "Merge stations 1:0 and 1:1",
            ),
            (
                Command::CreateLoopClosure {
                    station_a,
                    station_b,
                    closure_strategy: ClosureStrategy::ProportionalByLength,
                },
                "Create loop closure between 1:0 and 1:1",
            ),
            (
                Command::UnmergeStations {
                    station_ref: station_a,
                },
                "Unmerge station 1:0",
            ),
            (
                Command::UnmergeStationPair {
                    station_a,
                    station_b,
                },
                "Unmerge station pair 1:0 and 1:1",
            ),
            (
                Command::RemoveLoopClosure { closure_id: 42 },
                "Remove loop closure #42",
            ),
            (
                Command::SetZeroDatum {
                    station_ref: station_b,
                    coordinates: gps,
                },
                "Set zero datum at 1:1",
            ),
            (
                Command::RemoveZeroDatum {
                    station_ref: station_b,
                },
                "Remove zero datum from 1:1",
            ),
            (
                Command::MoveSection {
                    section_id: 2,
                    offset: Coordinates::new(1.0, 2.0, 3.0),
                },
                "Move section 2",
            ),
            (
                Command::MoveSegment {
                    section_id: 2,
                    offset: Coordinates::new(1.0, 2.0, 3.0),
                },
                "Move segment (section 2)",
            ),
            (
                Command::SetStationComment {
                    station_ref: station_a,
                    comment: Some("Test comment".to_string()),
                },
                "Set comment on station 1:0",
            ),
            (
                Command::SetStationComment {
                    station_ref: station_a,
                    comment: None,
                },
                "Remove comment from station 1:0",
            ),
            (
                Command::MoveStation {
                    station_ref: station_a,
                    offset: Coordinates::new(1.0, 0.0, 0.0),
                },
                "Move station 1:0",
            ),
            (
                Command::MoveComment {
                    source: CommentHolder::Station {
                        station_ref: station_a,
                    },
                    target: CommentHolder::Shot {
                        section_id: 1,
                        shot_id: 0,
                    },
                    swap: false,
                },
                "Move comment from station 1:0 to shot 1:1",
            ),
            (
                Command::MoveComment {
                    source: CommentHolder::Station {
                        station_ref: station_a,
                    },
                    target: CommentHolder::Station {
                        station_ref: station_b,
                    },
                    swap: true,
                },
                "Swap comments between station 1:0 and station 1:1",
            ),
            (
                Command::Batch {
                    commands: vec![Command::CloseProject],
                },
                "Batch of 1 commands",
            ),
            (
                Command::MergeProjects {
                    source_paths: vec![PathBuf::from("a.stalx"), PathBuf::from("b.stalx")],
                    output_path: PathBuf::from("out.stalx"),
                    output_name: "Merged".to_string(),
                    archive_originals: false,
                },
                "Merge 2 projects into 'Merged'",
            ),
        ];

        for (command, expected) in cases {
            assert_eq!(command.description(), expected);
        }
    }

    fn blank_receipt() -> ImportReceipt {
        ImportReceipt {
            source_format: String::new(),
            file_name: String::new(),
            sections_found: 0,
            sections_imported: 0,
            shot_count: 0,
            closures_requested: 0,
            closures_created: 0,
            unit_conversion: None,
            warnings: Vec::new(),
        }
    }

    /// A hostile/malformed import file can produce an unbounded number of
    /// warnings; `cap_warnings` must fold anything past the cap into one
    /// summary entry rather than shipping all of it back over IPC.
    #[test]
    fn cap_warnings_caps_a_huge_warning_count() {
        let mut receipt = blank_receipt();
        receipt.warnings = (0..10_000).map(|i| format!("warning {i}")).collect();
        receipt.cap_warnings();

        assert_eq!(receipt.warnings.len(), 51);
        for warning in &receipt.warnings[..50] {
            assert!(warning.chars().count() <= 300);
        }
        assert_eq!(receipt.warnings[50], "... and 9950 more warnings");
    }

    /// Each individual warning is clamped to 300 chars, truncating on a char
    /// boundary (never a raw byte slice) since a warning can embed arbitrary
    /// user-controlled text, including multi-byte characters.
    #[test]
    fn cap_warnings_clamps_an_overlong_warning_on_a_char_boundary() {
        let mut receipt = blank_receipt();
        // Multi-byte char (3 bytes each in UTF-8) so a byte-slice truncation
        // at 300 would panic; a char-boundary truncation must not.
        receipt.warnings = vec!["\u{2603}".repeat(500)];
        receipt.cap_warnings();

        assert_eq!(receipt.warnings.len(), 1);
        assert_eq!(receipt.warnings[0].chars().count(), 300);
    }

    #[test]
    fn cap_warnings_is_a_no_op_under_the_cap() {
        let mut receipt = blank_receipt();
        receipt.warnings = vec!["short warning".to_string()];
        receipt.cap_warnings();

        assert_eq!(receipt.warnings, vec!["short warning".to_string()]);
    }
}
