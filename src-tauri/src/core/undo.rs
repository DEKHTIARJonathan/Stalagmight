use std::collections::{HashMap, VecDeque};

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

use super::Command;
use crate::models::{
    GpsCoordinates, LoopClosure, SectionData, SectionId, ShotData, ShotId, StationRef,
};

/// Default maximum number of undo entries to keep in memory
const DEFAULT_UNDO_HISTORY_LIMIT: usize = 100;

/// [#303] Byte budget for a Full-mode SpeleoDB-linked project's undo history.
///
/// Full mode bypasses the entry-count window (`undo_history_limit` /
/// `undo_persist_limit`) so the project keeps its whole edit history since the last
/// commit - but "unbounded" is not safe here, because a single `Delete shot`,
/// `Delete section`, `Reverse section` or `Batch` (every import) stores a
/// [`UndoData::ProjectSnapshotPair`]: TWO whole-project JSON snapshots. Measured on a
/// project-shaped payload, a 5,000-shot project is ~2.1 MB of JSON per snapshot, so
/// one such entry is ~4.2 MB - and this history rides in every SpeleoDB commit, which
/// is the storage cost the issue exists to REDUCE.
///
/// So depth is bounded by total size instead of entry count. At the measured ~13x gzip
/// ratio for this JSON shape, 32 MiB of JSON is roughly 2.5 MB per commit, and buys:
///
/// | entry kind | size each | entries that fit |
/// |---|---|---|
/// | ordinary edit (`PreviousValues`, `InverseCommand`) | ~1 KB | ~32,000 |
/// | whole-project pair, 5,000-shot project | ~4.2 MB | ~8 |
/// | whole-project pair, 20,000-shot project | ~17 MB | ~2 |
///
/// The number is a LATENCY budget as much as a storage one, because every save rewrites
/// the whole persisted stack (see [`StackSync`] for why it cannot be incremental): the
/// worst-case save gzips this many bytes, ~0.3 s at the measured throughput, which an
/// autosave every 30 s can absorb. Raising it deepens snapshot-heavy history and slows
/// every save in proportion; that is the whole trade, and this constant is the only lever.
///
/// Note what it replaces: the old fixed window persisted `undo_persist_limit` (20)
/// entries with NO size cap, which on a 20,000-shot project is ~336 MB of JSON per save.
/// So this is a large improvement in worst-case cost and an enormous one in ordinary
/// depth (100 entries -> ~32,000), at the price of shallower history for repeated
/// whole-survey operations on very large projects.
///
/// Measured against [`UndoStack::estimated_size`], NOT against a real serialization:
/// the point is to bound growth, and serializing the whole stack to measure it would
/// cost exactly what the budget exists to avoid.
pub const UNDO_BYTE_BUDGET_BYTES: usize = 32 * 1024 * 1024;

/// How a stack's depth is bounded.
///
/// Two shapes rather than one number, because the two are not interchangeable: a
/// count window is what a local project (and Disabled mode) has always had, and a byte
/// budget is what makes Full mode's "full depth since the last commit" survivable. See
/// [`UNDO_BYTE_BUDGET_BYTES`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DepthLimit {
    /// At most N entries, oldest evicted first. Local projects and Disabled mode.
    Count(usize),
    /// At most N bytes of estimated serialized size, oldest evicted first. Full mode
    /// on a SpeleoDB-linked project.
    Bytes(usize),
}

/// Which stack a [`PersistPlan`] is for.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PersistStack {
    Undo,
    Redo,
}

/// One row a save has to write, keyed by its stable id (the `sequence` column).
#[derive(Debug, Clone)]
pub struct PersistRow {
    /// Stable id = `head_dropped + position`. Written to `sequence`, so ordering by it
    /// still reproduces stack order.
    pub id: u64,
    pub command_json: String,
    pub undo_data_json: String,
    pub timestamp: Option<String>,
}

/// [#303] The write half and the delete half of one stack's save.
#[derive(Debug, Clone)]
pub struct PersistPlan {
    /// Rows to upsert - only those at or after the first changed id.
    pub rows: Vec<PersistRow>,
    /// `(first, last)` ids that must survive; every other row is stale and is deleted.
    /// `None` = the stack is empty, so every row is stale.
    pub keep_range: Option<(u64, u64)>,
}

/// Undo/redo stack
#[derive(Debug)]
#[expect(clippy::struct_field_names)]
pub struct UndoStack {
    /// Commands that can be undone
    undo_stack: VecDeque<UndoEntry>,
    /// Commands that can be redone
    redo_stack: VecDeque<UndoEntry>,
    /// Maximum entries to keep in memory
    history_limit: usize,
    /// [#303] The active bound. `Count(history_limit)` unless the open project is a
    /// Full-mode linked one, in which case `Bytes(UNDO_BYTE_BUDGET_BYTES)`.
    ///
    /// Kept alongside `history_limit` rather than replacing it so that switching a
    /// project back to a count window (closing it, flipping the mode to Disabled)
    /// restores the user's configured number without having to re-read the config.
    depth_limit: DepthLimit,
    /// [#303] Persistence bookkeeping for the undo stack - see [`StackSync`].
    undo_sync: StackSync,
    /// [#303] The same, for the redo stack.
    redo_sync: StackSync,
}

/// [#303] Per-stack id bookkeeping for persistence.
///
/// EVERY save writes the whole (budgeted) stack. That is not an oversight - it is
/// forced by the save pipeline: `save_project` builds a FRESH `.stalx.tmp`, renames it
/// over the target, and only then writes the undo tables into the reopened file
/// (`project_io.rs`). Nothing survives that rename, so there is no "already in the
/// destination" for a save to skip.
///
/// An earlier version of this tried to be incremental (write only the ids at or after
/// the first changed one) and SILENTLY DROPPED the history: any save with no undo
/// change since the last one - an idle autosave, or the push's own flush right after
/// another save - wrote zero rows into a file that had none, so the commit it produced
/// carried no history at all. The unit test that "proved" the optimization ran the
/// database helper against a database that persisted between calls, which is exactly
/// the assumption the save path breaks.
///
/// What is left is `head_dropped`, which keeps the `sequence` column monotonic across a
/// front eviction rather than renumbering from zero. The id of the entry at position
/// `i` is `head_dropped + i`, stable because the only mutations are a tail append and a
/// front eviction.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
struct StackSync {
    /// Entries ever evicted from the FRONT of this stack. Position 0 has this id.
    head_dropped: u64,
}

impl StackSync {
    /// Note that `count` entries left the FRONT of the stack.
    fn note_head_dropped(&mut self, count: u64) {
        self.head_dropped = self.head_dropped.saturating_add(count);
    }
}

/// Entry in the undo stack
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UndoEntry {
    /// The command that was executed
    pub command: Command,
    /// Data needed to undo this command
    pub undo_data: UndoData,
    /// Timestamp when the command was executed (None for legacy entries)
    #[serde(default)]
    pub timestamp: Option<DateTime<Utc>>,
}

/// Data needed to undo a command
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum UndoData {
    /// Simple inverse command (e.g., SetShotKind -> SetShotKind(prev kind), MergeStations -> UnmergeStations)
    InverseCommand(Command),

    /// Previous values for an update operation (JSON serialized)
    PreviousValues {
        section_id: SectionId,
        shot_id: Option<ShotId>,
        /// JSON serialized previous values (ShotUpdates or SectionUpdates)
        values_json: String,
    },

    /// Full section snapshot for restoring deleted sections
    SectionSnapshot {
        section_id: SectionId,
        /// Full section data including all shots
        section_data: SectionData,
    },

    /// Snapshot of a newly created section (for CreateSection undo/redo ID preservation)
    /// Distinct from SectionSnapshot (used by DeleteSection) to avoid ambiguity in redo logic.
    CreatedSectionSnapshot {
        section_id: SectionId,
        /// Full section data including all shots
        section_data: SectionData,
    },

    /// Shot snapshot for restoring deleted shots
    ShotSnapshot {
        section_id: SectionId,
        shot_id: ShotId,
        shot_data: ShotData,
        /// Position in the section's shot list (for re-insertion)
        position: usize,
        /// The deleted shot's persistent UUID, so undo restores the same
        /// identity (station cross-references anchor on it via
        /// `StationKey::AfterShot`) rather than minting a fresh one. `None` for
        /// legacy persisted entries.
        #[serde(default)]
        uuid: Option<String>,
    },

    /// Snapshot of a newly created shot (for CreateShot undo/redo ID preservation)
    /// Distinct from ShotSnapshot (used by DeleteShot) to avoid ambiguity in redo logic.
    CreatedShotSnapshot {
        section_id: SectionId,
        shot_id: ShotId,
        shot_data: ShotData,
        /// Position in the section's shot list (for re-insertion at correct position)
        position: usize,
        /// Station index from which to shift refs when restoring (redo).
        /// For insert_before: same as position. For insert_after/append: position + 1.
        /// Undo of CreateShot (delete) uses the inverse shift automatically via remove_shot.
        #[serde(default)]
        station_shift_from: u32,
        /// The original command's anchor shot. Redo re-runs the SAME
        /// `insert_shot_after`/`insert_shot_before` (with `shot_id` forced) so the
        /// forward and redo paths share one code path and can't drift apart. Both
        /// `None` means the shot was appended.
        #[serde(default)]
        after_shot_id: Option<ShotId>,
        #[serde(default)]
        before_shot_id: Option<ShotId>,
        /// The shot's persistent UUID at creation. Redo restores it via
        /// `Shot::with_uuid` so the recreated shot keeps the same identity that
        /// station cross-references (`AfterShot(uuid)`) anchor on.
        /// `None` for legacy persisted entries written before this field existed
        /// (redo then mints a fresh UUID, the pre-fix behavior).
        #[serde(default)]
        uuid: Option<String>,
    },

    /// Merge info for unmerging stations
    MergeInfo {
        station_a: StationRef,
        station_b: StationRef,
        /// Closures removed during unmerge (for restoring on undo)
        #[serde(default)]
        removed_closures: Vec<LoopClosure>,
        /// Section offsets before the merge (for restoring positions on undo)
        #[serde(default)]
        previous_offsets: HashMap<SectionId, Option<(f64, f64)>>,
    },

    /// Unmerge info for re-merging stations on undo (opposite of MergeInfo)
    UnmergeInfo {
        station_a: StationRef,
        station_b: StationRef,
        /// Closures removed during unmerge (for restoring on undo)
        #[serde(default)]
        removed_closures: Vec<LoopClosure>,
    },

    /// Loop closure info for undoing CreateLoopClosure
    ClosureInfo {
        /// The full loop closure data to remove on undo
        closure: LoopClosure,
    },

    /// Zero datum info for restoring previous GPS and section offsets
    ZeroDatumInfo {
        station_ref: StationRef,
        /// Previous GPS coordinates, None if there was no previous datum
        previous_gps: Option<GpsCoordinates>,
        /// Previous section offsets for affected sections
        /// - None value means the key didn't exist (should be removed on undo)
        /// - Some value means the offset should be restored to that value
        #[serde(default)]
        previous_offsets: HashMap<SectionId, Option<(f64, f64)>>,
    },

    /// Per-section previous offsets for segment moves (captured at execution time)
    /// Unlike InverseCommand, this stores the exact set of affected sections and their
    /// previous offsets so that undo/redo is correct even if the connectivity graph changes.
    SegmentMoveInfo {
        /// Section IDs that were moved (captured at execution time)
        affected_sections: Vec<SectionId>,
        /// Previous offsets for each affected section (None = no offset existed)
        previous_offsets: HashMap<SectionId, Option<(f64, f64)>>,
        /// The offset that was applied (for redo)
        offset: (f64, f64),
    },

    /// Previous shot data and station offset for station moves.
    /// MoveStation modifies adjacent shots' geometry (length/azimuth/depth) directly,
    /// so undo needs to restore the original shot data and station offset.
    StationMoveInfo {
        station_ref: StationRef,
        /// Shot data for the preceding shot (shot at station_index - 1), if any
        prev_shot_before: Option<(ShotId, ShotData)>,
        /// Shot data for the following shot (shot at station_index), if any
        prev_shot_after: Option<(ShotId, ShotData)>,
        /// Previous station offset (None = no offset existed)
        prev_offset: Option<(f64, f64, f64)>,
        /// Previous section offset (None = no offset existed)
        #[serde(default)]
        prev_section_offset: Option<(f64, f64)>,
    },

    /// Full project snapshot for batch operations (JSON serialized)
    ProjectSnapshot(String),

    /// Before and after project snapshots for operations that can't be re-executed
    /// (e.g., batch operations that create sections with dynamic IDs)
    /// - before: Snapshot before the operation (used for undo)
    /// - after: Snapshot after the operation (used for redo)
    ProjectSnapshotPair { before: String, after: String },

    /// No undo data (for commands that can't be undone)
    None,
}

impl UndoData {
    /// Return a short, safe variant name for logging (no payload data)
    pub fn variant_name(&self) -> &'static str {
        match self {
            UndoData::InverseCommand(_) => "InverseCommand",
            UndoData::PreviousValues { .. } => "PreviousValues",
            UndoData::SectionSnapshot { .. } => "SectionSnapshot",
            UndoData::CreatedSectionSnapshot { .. } => "CreatedSectionSnapshot",
            UndoData::ShotSnapshot { .. } => "ShotSnapshot",
            UndoData::CreatedShotSnapshot { .. } => "CreatedShotSnapshot",
            UndoData::MergeInfo { .. } => "MergeInfo",
            UndoData::UnmergeInfo { .. } => "UnmergeInfo",
            UndoData::ClosureInfo { .. } => "ClosureInfo",
            UndoData::ZeroDatumInfo { .. } => "ZeroDatumInfo",
            UndoData::SegmentMoveInfo { .. } => "SegmentMoveInfo",
            UndoData::StationMoveInfo { .. } => "StationMoveInfo",
            UndoData::ProjectSnapshot(_) => "ProjectSnapshot",
            UndoData::ProjectSnapshotPair { .. } => "ProjectSnapshotPair",
            UndoData::None => "None",
        }
    }
}

impl Default for UndoStack {
    fn default() -> Self {
        Self {
            undo_stack: VecDeque::new(),
            redo_stack: VecDeque::new(),
            history_limit: DEFAULT_UNDO_HISTORY_LIMIT,
            depth_limit: DepthLimit::Count(DEFAULT_UNDO_HISTORY_LIMIT),
            undo_sync: StackSync::default(),
            redo_sync: StackSync::default(),
        }
    }
}

impl UndoStack {
    /// Create a new empty undo stack with default limit
    pub fn new() -> Self {
        Self::default()
    }

    /// Create a new empty undo stack with custom limit
    pub fn new_with_limit(history_limit: usize) -> Self {
        Self {
            undo_stack: VecDeque::new(),
            redo_stack: VecDeque::new(),
            history_limit,
            depth_limit: DepthLimit::Count(history_limit),
            undo_sync: StackSync::default(),
            redo_sync: StackSync::default(),
        }
    }

    /// Get the current history limit
    pub fn history_limit(&self) -> usize {
        self.history_limit
    }

    /// Set the history limit
    pub fn set_history_limit(&mut self, limit: usize) {
        self.history_limit = limit;
        // [#303] Only re-arm the COUNT bound. A Full-mode linked project is on the byte
        // budget, and a config reload (which is what calls this) must not knock it back
        // onto the entry window - that would silently truncate the history the next push
        // is supposed to carry to the server.
        if matches!(self.depth_limit, DepthLimit::Count(_)) {
            self.depth_limit = DepthLimit::Count(limit);
        }
        self.enforce_depth_limit();
    }

    /// [#303] Switch this stack onto the byte budget (Full mode on a linked project).
    /// Idempotent, and trims immediately if the stack already exceeds the budget.
    pub fn set_byte_budget(&mut self, budget: usize) {
        self.depth_limit = DepthLimit::Bytes(budget);
        self.enforce_depth_limit();
    }

    /// [#303] Switch this stack back onto the configured entry-count window (a local
    /// project, Disabled mode, or no project open).
    pub fn use_count_limit(&mut self) {
        self.depth_limit = DepthLimit::Count(self.history_limit);
        self.enforce_depth_limit();
    }

    /// The active bound.
    pub fn depth_limit(&self) -> DepthLimit {
        self.depth_limit
    }

    /// [#303] The stamp for the next entry: wall-clock, but never at or below the entry
    /// beneath it.
    ///
    /// Everything that reasons about this stack by time assumes later-in-the-stack means
    /// later-in-time - `drop_entries_up_to` says so outright and uses `partition_point`,
    /// which silently returns a meaningless boundary if the order does not hold. Wall time
    /// alone does not guarantee it: an entry can arrive from a peer whose clock ran ahead
    /// (a chain step loads a past commit's history, stamped on the machine that authored
    /// it), and a local clock can be corrected backwards under us.
    ///
    /// So the stack keeps its own order. The stamp is the real instant whenever that is
    /// already ahead - the ordinary case, and the one that keeps displayed times honest -
    /// and otherwise the smallest value that preserves the invariant.
    fn next_stamp(&self) -> DateTime<Utc> {
        let now = Utc::now();
        match self.undo_stack.back().and_then(|entry| entry.timestamp) {
            // `>=`, not `>`: two entries sharing an instant would break the strict
            // ordering just as an inversion does.
            Some(prev) if prev >= now => prev + chrono::Duration::nanoseconds(1),
            // No previous entry, or a legacy one carrying no timestamp at all: there is
            // nothing to stay ahead of.
            _ => now,
        }
    }

    /// The newest stamp on the undo stack, if any - the ceiling a caller must clear to be
    /// sure it is talking about "everything currently on the stack" (see
    /// `speleodb_clear_undo_after_push`). Cheap: the invariant above makes it the back.
    pub fn newest_stamp(&self) -> Option<DateTime<Utc>> {
        self.undo_stack.back().and_then(|entry| entry.timestamp)
    }

    /// Push a command with its undo data to the undo stack
    pub fn push_with_data(&mut self, command: Command, undo_data: UndoData) {
        let entry = UndoEntry {
            command,
            undo_data,
            timestamp: Some(self.next_stamp()),
        };

        self.push_undo_tracked(entry);

        // Clear redo stack when new command is executed
        self.clear_redo();

        self.enforce_depth_limit();
    }

    /// Push a command without undo data (convenience wrapper, timestamps are added automatically)
    ///
    /// The resulting entry carries [`UndoData::None`], which `undo()` cannot apply
    /// (see [`Self::is_applicable`]). Production code must not use this: the command
    /// path guards on `UndoData::None` before pushing, and `load_from_persisted*`
    /// drops such entries. Kept for the stack-mechanics tests in
    /// `tests/integration_tests.rs`, which only exercise push/pop/limit ordering.
    pub fn push(&mut self, command: Command) {
        self.push_with_data(command, UndoData::None);
    }

    /// Pop from undo stack and return the entry
    pub fn pop_undo(&mut self) -> Option<UndoEntry> {
        // No `mark_dirty`: a tail removal shrinks the id range, and the sync deletes
        // every row outside that range, so the vacated id is cleaned up regardless.
        self.undo_stack.pop_back()
    }

    /// Push to redo stack
    pub fn push_redo(&mut self, entry: UndoEntry) {
        self.redo_stack.push_back(entry);
        // The redo stack is bounded too - undoing a long delete-heavy session moves
        // every one of those whole-project snapshots across.
        self.enforce_depth_limit();
    }

    /// Pop from redo stack
    pub fn pop_redo(&mut self) -> Option<UndoEntry> {
        self.redo_stack.pop_back()
    }

    /// Push back to undo stack (for redo operations)
    pub fn push_undo(&mut self, entry: UndoEntry) {
        self.push_undo_tracked(entry);
        // Don't clear redo stack when pushing for redo
        self.enforce_depth_limit();
    }

    /// Append to the undo stack, recording the new id as dirty. The one place an
    /// entry enters that stack, so the bookkeeping cannot be forgotten at a call site.
    fn push_undo_tracked(&mut self, entry: UndoEntry) {
        self.undo_stack.push_back(entry);
    }

    /// Check if undo is available
    pub fn can_undo(&self) -> bool {
        !self.undo_stack.is_empty()
    }

    /// Check if redo is available
    pub fn can_redo(&self) -> bool {
        !self.redo_stack.is_empty()
    }

    /// Clear both stacks
    pub fn clear(&mut self) {
        self.undo_stack.clear();
        self.redo_stack.clear();
        // No dirty marking: an empty stack has an empty id range, and the sync deletes
        // everything outside that range.
    }

    /// [#303] Drop every undo entry whose timestamp is at or before `cutoff`, and the
    /// whole redo stack, returning how many undo entries went.
    ///
    /// This is clear-on-push (q8 / Q25): a confirmed push has just uploaded those
    /// operations, so keeping them locally would duplicate them in the NEXT commit -
    /// and the hybrid model's answer to "undo past the last commit" is the explicit
    /// Unwind, not a second copy of the history.
    ///
    /// Keyed on the push-start instant rather than clearing everything, because an edit
    /// that landed AFTER the snapshot was taken is not on the server: `speleodb_upload`
    /// deliberately keeps its dirty bit so the next push carries it, so its undo entry
    /// has to survive too. Clearing the lot would leave a dirty project whose pending
    /// edit had no history at all.
    ///
    /// Entries with NO timestamp are legacy persisted ones, which necessarily predate
    /// this session's push, so they are dropped.
    pub fn drop_entries_up_to(&mut self, cutoff: DateTime<Utc>) -> usize {
        let before = self.undo_stack.len();
        // Timestamps are assigned in push order, so the entries to drop are a PREFIX -
        // which keeps ids stable for the survivors (a front eviction, exactly like a
        // trim). `partition_point` finds the boundary without scanning the tail.
        let keep_from = self
            .undo_stack
            .partition_point(|e| e.timestamp.is_none_or(|ts| ts <= cutoff));
        self.undo_stack.drain(..keep_from);
        self.undo_sync.note_head_dropped(keep_from as u64);
        // Redo is never uploaded (clarification #1) and a redo branch that replays onto
        // a state the server has now committed is exactly the stale-replay hazard, so it
        // goes wholesale.
        self.redo_stack.clear();
        before - self.undo_stack.len()
    }

    /// [#303] Estimated serialized size of one entry, in bytes.
    ///
    /// An ESTIMATE by design: it exists to bound growth, and measuring exactly would
    /// mean serializing the whole stack on every push - the cost the byte budget is
    /// there to avoid. The dominant terms are exact (the snapshot variants hold their
    /// JSON as `String` already, so their length is the real payload); the structured
    /// variants are approximated from their element counts, and everything else is
    /// small enough that the flat overhead covers it.
    pub fn estimated_size(entry: &UndoEntry) -> usize {
        /// Roughly the JSON size of one serialized shot, from the measured
        /// project-shaped payload (~420 bytes/shot).
        const BYTES_PER_SHOT: usize = 420;
        /// Command JSON plus enum/field scaffolding for any entry.
        const ENTRY_OVERHEAD: usize = 512;

        let payload = match &entry.undo_data {
            // Exact: these hold the serialized project already.
            UndoData::ProjectSnapshot(json) => json.len(),
            UndoData::ProjectSnapshotPair { before, after } => before.len() + after.len(),
            UndoData::PreviousValues { values_json, .. } => values_json.len(),
            // Approximated from element counts - a section snapshot of a big section is
            // the only other variant that can reach megabytes.
            UndoData::SectionSnapshot { section_data, .. }
            | UndoData::CreatedSectionSnapshot { section_data, .. } => {
                section_data.shots.len() * BYTES_PER_SHOT
            }
            UndoData::ShotSnapshot { .. } | UndoData::CreatedShotSnapshot { .. } => BYTES_PER_SHOT,
            UndoData::MergeInfo {
                removed_closures,
                previous_offsets,
                ..
            } => removed_closures.len() * 256 + previous_offsets.len() * 64,
            UndoData::UnmergeInfo {
                removed_closures, ..
            } => removed_closures.len() * 256,
            UndoData::ClosureInfo { .. } => 256,
            UndoData::ZeroDatumInfo {
                previous_offsets, ..
            } => previous_offsets.len() * 64,
            UndoData::SegmentMoveInfo {
                affected_sections,
                previous_offsets,
                ..
            } => affected_sections.len() * 16 + previous_offsets.len() * 64,
            UndoData::StationMoveInfo { .. } => 2 * BYTES_PER_SHOT,
            UndoData::InverseCommand(_) | UndoData::None => 0,
        };
        payload + ENTRY_OVERHEAD
    }

    /// [#303] Total estimated size of the undo stack (the budget's subject).
    pub fn estimated_undo_bytes(&self) -> usize {
        self.undo_stack.iter().map(Self::estimated_size).sum()
    }

    /// Apply whichever bound is active to BOTH stacks, evicting oldest-first.
    ///
    /// Under `Bytes`, the newest entry is always kept even if it alone exceeds the
    /// budget: dropping it would silently discard the operation the user just did, and
    /// a single entry over the budget is a very large import, not runaway growth.
    fn enforce_depth_limit(&mut self) {
        match self.depth_limit {
            DepthLimit::Count(limit) => {
                let undo_dropped = Self::trim_to_count(&mut self.undo_stack, limit);
                self.undo_sync.note_head_dropped(undo_dropped);
                let redo_dropped = Self::trim_to_count(&mut self.redo_stack, limit);
                self.redo_sync.note_head_dropped(redo_dropped);
            }
            DepthLimit::Bytes(budget) => {
                let (undo_dropped, undo_bytes) = Self::trim_to_bytes(&mut self.undo_stack, budget);
                self.undo_sync.note_head_dropped(undo_dropped);
                let (redo_dropped, _) = Self::trim_to_bytes(&mut self.redo_stack, budget);
                self.redo_sync.note_head_dropped(redo_dropped);
                if undo_dropped > 0 {
                    // ONE counted line, not one per entry: the trim is a policy outcome
                    // the user may need explained ("why can't I undo further?"), but a
                    // long import must not turn it into a log flood.
                    tracing::info!(
                        dropped = undo_dropped,
                        remaining = self.undo_stack.len(),
                        estimated_bytes = undo_bytes,
                        budget,
                        purpose = "bound a Full-mode SpeleoDB project's undo history (#303)",
                        "Trimmed oldest undo entries to stay within the undo byte budget"
                    );
                }
            }
        }
    }

    /// Evict from the front until at most `limit` entries remain. Returns how many went.
    fn trim_to_count(stack: &mut VecDeque<UndoEntry>, limit: usize) -> u64 {
        let mut dropped = 0;
        while stack.len() > limit {
            stack.pop_front();
            dropped += 1;
        }
        dropped
    }

    /// Evict from the front until the estimated total is at most `budget`, always
    /// keeping the newest entry. Returns (evicted, remaining estimated bytes).
    fn trim_to_bytes(stack: &mut VecDeque<UndoEntry>, budget: usize) -> (u64, usize) {
        let mut total: usize = stack.iter().map(Self::estimated_size).sum();
        let mut dropped = 0;
        while total > budget && stack.len() > 1 {
            if let Some(front) = stack.pop_front() {
                total = total.saturating_sub(Self::estimated_size(&front));
                dropped += 1;
            }
        }
        (dropped, total)
    }

    /// Clear the redo stack only, leaving undo history intact.
    ///
    /// `push_with_data` already clears redo as part of pushing; this is for the
    /// command path's other branch, where a command SUCCEEDED but produced no
    /// undoable entry. The redo branch is invalidated either way - the project has
    /// moved on from the state those entries would replay onto - so the clear must
    /// not be coupled to whether an entry was pushed.
    pub fn clear_redo(&mut self) {
        self.redo_stack.clear();
    }

    /// Get the last command that can be undone
    pub fn peek_undo(&self) -> Option<&Command> {
        self.undo_stack.back().map(|e| &e.command)
    }

    /// Get the last command that can be redone
    pub fn peek_redo(&self) -> Option<&Command> {
        self.redo_stack.back().map(|e| &e.command)
    }

    /// Get the undo data for the last undoable command
    pub fn peek_undo_data(&self) -> Option<&UndoData> {
        self.undo_stack.back().map(|e| &e.undo_data)
    }

    /// [#303] What a save must write for one stack: the rows at or after the first
    /// changed id, plus the id range every surviving row falls in.
    ///
    /// The sync deletes anything outside `keep_range` and upserts `rows`, so between
    /// them they express both halves of "make the table match memory" while only
    /// serializing (and gzipping) what actually changed. `rows` empty with a
    /// `keep_range` covering the whole stack means "nothing changed" - the common case
    /// for a save that follows no edit.
    #[must_use]
    pub fn persist_plan(&self, stack: PersistStack, count_limit: Option<usize>) -> PersistPlan {
        let (entries, sync) = match stack {
            PersistStack::Undo => (&self.undo_stack, &self.undo_sync),
            PersistStack::Redo => (&self.redo_stack, &self.redo_sync),
        };

        // A count limit (local / Disabled mode) persists only the last N entries; the
        // byte budget has already bounded the whole stack, so Full mode writes all of it.
        let skip = match count_limit {
            Some(limit) if entries.len() > limit => entries.len() - limit,
            _ => 0,
        };
        let first_id = sync.head_dropped + skip as u64;
        let last_id = sync.head_dropped + entries.len().saturating_sub(1) as u64;

        // EVERY row in the window, every time. See `StackSync`: the save rebuilds the
        // file, so anything not written here is gone.
        let rows = entries
            .iter()
            .enumerate()
            .skip(skip)
            .filter_map(|(i, entry)| {
                Self::serialize_entry_with_timestamp(entry).map(
                    |(command_json, undo_data_json, timestamp)| PersistRow {
                        id: sync.head_dropped + i as u64,
                        command_json,
                        undo_data_json,
                        timestamp,
                    },
                )
            })
            .collect();

        PersistPlan {
            rows,
            keep_range: if entries.is_empty() {
                None
            } else {
                Some((first_id, last_id))
            },
        }
    }

    /// Get undo entries to persist (last N entries up to persist_limit)
    pub fn entries_to_persist(&self, persist_limit: usize) -> impl Iterator<Item = &UndoEntry> {
        let skip = if self.undo_stack.len() > persist_limit {
            self.undo_stack.len() - persist_limit
        } else {
            0
        };
        self.undo_stack.iter().skip(skip)
    }

    /// Get redo entries to persist (last N entries up to persist_limit)
    pub fn redo_entries_to_persist(
        &self,
        persist_limit: usize,
    ) -> impl Iterator<Item = &UndoEntry> {
        let skip = if self.redo_stack.len() > persist_limit {
            self.redo_stack.len() - persist_limit
        } else {
            0
        };
        self.redo_stack.iter().skip(skip)
    }

    /// Serialize an entry to JSON for persistence
    /// Returns (command_json, undo_data_json, timestamp_iso8601)
    pub fn serialize_entry(entry: &UndoEntry) -> Option<(String, String)> {
        let command_json = serde_json::to_string(&entry.command).ok()?;
        let undo_data_json = serde_json::to_string(&entry.undo_data).ok()?;
        Some((command_json, undo_data_json))
    }

    /// Serialize an entry with timestamp for database persistence
    /// Returns (command_json, undo_data_json, timestamp_iso8601)
    pub fn serialize_entry_with_timestamp(
        entry: &UndoEntry,
    ) -> Option<(String, String, Option<String>)> {
        let command_json = serde_json::to_string(&entry.command).ok()?;
        let undo_data_json = serde_json::to_string(&entry.undo_data).ok()?;
        let timestamp_str = entry.timestamp.map(|t| t.to_rfc3339());
        Some((command_json, undo_data_json, timestamp_str))
    }

    /// Deserialize an entry from JSON
    pub fn deserialize_entry(command_json: &str, undo_data_json: &str) -> Option<UndoEntry> {
        let command: Command = match serde_json::from_str(command_json) {
            Ok(command) => command,
            Err(e) => {
                // A command that no longer exists in this build (e.g. a variant
                // removed in a newer version) can't be deserialized. Skip the
                // entry rather than aborting the whole load, but log it so the
                // truncation of undo history is not silent.
                tracing::warn!(
                    error = %e,
                    purpose = "load persisted undo history",
                    "Skipping an undo entry whose command could not be deserialized; its undo step is dropped"
                );
                return None;
            }
        };
        let undo_data: UndoData = serde_json::from_str(undo_data_json).ok()?;
        Some(UndoEntry {
            command,
            undo_data,
            timestamp: None, // Legacy entries without timestamp
        })
    }

    /// Deserialize an entry from JSON with optional timestamp
    pub fn deserialize_entry_with_timestamp(
        command_json: &str,
        undo_data_json: &str,
        timestamp_str: Option<&str>,
    ) -> Option<UndoEntry> {
        let command: Command = match serde_json::from_str(command_json) {
            Ok(command) => command,
            Err(e) => {
                // A command that no longer exists in this build (e.g. a variant
                // removed in a newer version) can't be deserialized. Skip the
                // entry rather than aborting the whole load, but log it so the
                // truncation of undo history is not silent.
                tracing::warn!(
                    error = %e,
                    purpose = "load persisted undo history",
                    "Skipping an undo entry whose command could not be deserialized; its undo step is dropped"
                );
                return None;
            }
        };
        let undo_data: UndoData = serde_json::from_str(undo_data_json).ok()?;
        let timestamp = timestamp_str
            .and_then(|s| DateTime::parse_from_rfc3339(s).ok())
            .map(|dt| dt.with_timezone(&Utc));
        Some(UndoEntry {
            command,
            undo_data,
            timestamp,
        })
    }

    /// True when `undo()` can actually apply this entry.
    ///
    /// A [`UndoData::None`] entry cannot be applied: `undo_inner` maps that variant
    /// to a failure, and the failure epilogue pushes the entry straight BACK onto the
    /// undo stack. So the top of the stack is unpoppable forever and every older
    /// entry underneath it is permanently unreachable - the stack is wedged. The
    /// command path now refuses to push such an entry, but stacks written before that
    /// guard are ON DISK and are restored verbatim (and re-persisted on every save),
    /// so the poison also has to be dropped at load.
    ///
    /// Applied to the UNDO stack only. A redo entry with `UndoData::None` redoes
    /// CORRECTLY - `redo_inner`'s catch-all arm re-executes `entry.command` and never
    /// reads `undo_data` - so filtering the redo stack would destroy working
    /// functionality and shift the indices `redo_to` is called with.
    fn is_applicable(entry: &UndoEntry) -> bool {
        !matches!(entry.undo_data, UndoData::None)
    }

    /// Emit a single counted warning for the entries a load dropped as unapplicable,
    /// naming the commands so the truncation of history is not silent.
    fn warn_dropped_unapplicable(dropped: &[String]) {
        if dropped.is_empty() {
            return;
        }
        tracing::warn!(
            count = dropped.len(),
            commands = %dropped.join("; "),
            purpose = "load persisted undo history",
            "Dropped persisted undo entries that carry no undo data; they could not be undone and would have blocked every older entry"
        );
    }

    /// Load entries from persisted data
    pub fn load_from_persisted(&mut self, entries: Vec<(String, String)>) {
        self.undo_stack.clear();
        self.redo_stack.clear();

        let mut dropped: Vec<String> = Vec::new();
        for (command_json, undo_data_json) in entries {
            if let Some(entry) = Self::deserialize_entry(&command_json, &undo_data_json) {
                if Self::is_applicable(&entry) {
                    self.undo_stack.push_back(entry);
                } else {
                    dropped.push(entry.command.description());
                }
            }
        }
        Self::warn_dropped_unapplicable(&dropped);

        self.reset_sync_after_load();
        self.enforce_depth_limit();
    }

    /// [#303] Restart the id numbering after a load.
    ///
    /// The ids are minted from position 0 rather than adopted from the `sequence`
    /// column, because a load FILTERS (unapplicable entries, undeserializable commands)
    /// and TRIMS - so the rows on disk are not the entries in memory, and the next save
    /// rewrites the file from what is in memory anyway.
    fn reset_sync_after_load(&mut self) {
        self.undo_sync = StackSync::default();
        self.redo_sync = StackSync::default();
    }

    /// Load entries from persisted data with timestamps
    pub fn load_from_persisted_with_timestamps(
        &mut self,
        undo_entries: Vec<(String, String, Option<String>)>,
        redo_entries: Vec<(String, String, Option<String>)>,
    ) {
        self.undo_stack.clear();
        self.redo_stack.clear();

        let mut dropped: Vec<String> = Vec::new();
        for (command_json, undo_data_json, timestamp_str) in undo_entries {
            if let Some(entry) = Self::deserialize_entry_with_timestamp(
                &command_json,
                &undo_data_json,
                timestamp_str.as_deref(),
            ) {
                if Self::is_applicable(&entry) {
                    self.undo_stack.push_back(entry);
                } else {
                    dropped.push(entry.command.description());
                }
            }
        }
        Self::warn_dropped_unapplicable(&dropped);

        // The redo stack is loaded UNFILTERED on purpose - see `is_applicable`.
        for (command_json, undo_data_json, timestamp_str) in redo_entries {
            if let Some(entry) = Self::deserialize_entry_with_timestamp(
                &command_json,
                &undo_data_json,
                timestamp_str.as_deref(),
            ) {
                self.redo_stack.push_back(entry);
            }
        }

        self.reset_sync_after_load();
        self.enforce_depth_limit();
    }

    /// Get the number of entries in the undo stack
    pub fn len(&self) -> usize {
        self.undo_stack.len()
    }

    /// Check if the undo stack is empty
    pub fn is_empty(&self) -> bool {
        self.undo_stack.is_empty()
    }

    /// Get the number of entries in the redo stack
    pub fn redo_len(&self) -> usize {
        self.redo_stack.len()
    }

    /// Get an iterator over the undo stack entries (index 0 = most recent)
    /// Returns entries in LIFO order (most recent first)
    pub fn undo_entries(&self) -> impl Iterator<Item = &UndoEntry> {
        self.undo_stack.iter().rev()
    }

    /// Get an iterator over the redo stack entries (index 0 = most recent)
    /// Returns entries in LIFO order (most recent first)
    pub fn redo_entries(&self) -> impl Iterator<Item = &UndoEntry> {
        self.redo_stack.iter().rev()
    }
}

#[cfg(test)]
#[expect(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::float_cmp
)]
mod tests {
    use super::*;
    use crate::models::ShotData;

    /// Helper to create a test command
    fn test_create_section_command(name: &str) -> Command {
        Command::CreateSection {
            name: Some(name.to_string()),
            surveyor: None,
            date: None,
            color: "#ff0000".to_string(),
            direction: None,
            shots: vec![],
        }
    }

    /// Helper to create a test delete section command
    fn test_delete_section_command(section_id: SectionId) -> Command {
        Command::DeleteSection { section_id }
    }

    /// Helper to create test section data
    fn test_section_data(name: &str) -> SectionData {
        SectionData {
            name: Some(name.to_string()),
            surveyor: None,
            date: None,
            color: "#ff0000".to_string(),
            direction: None,
            quality: 1.0,
            shots: vec![],
        }
    }

    // === Undo Stack Basic Tests ===

    #[test]
    fn test_new_undo_stack_is_empty() {
        let stack = UndoStack::new();
        assert!(stack.is_empty());
        assert!(!stack.can_undo());
        assert!(!stack.can_redo());
        assert_eq!(stack.len(), 0);
        assert_eq!(stack.redo_len(), 0);
    }

    #[test]
    fn test_new_with_limit() {
        let stack = UndoStack::new_with_limit(50);
        assert_eq!(stack.history_limit(), 50);
        assert!(stack.is_empty());
    }

    #[test]
    fn test_default_history_limit() {
        let stack = UndoStack::new();
        assert_eq!(stack.history_limit(), 100);
    }

    #[test]
    fn test_push_enables_undo() {
        let mut stack = UndoStack::new();
        let cmd = test_create_section_command("Test");

        stack.push_with_data(cmd, UndoData::None);

        assert!(stack.can_undo());
        assert_eq!(stack.len(), 1);
    }

    #[test]
    fn test_push_multiple_commands() {
        let mut stack = UndoStack::new();

        stack.push_with_data(test_create_section_command("First"), UndoData::None);
        stack.push_with_data(test_create_section_command("Second"), UndoData::None);
        stack.push_with_data(test_create_section_command("Third"), UndoData::None);

        assert_eq!(stack.len(), 3);
        assert!(stack.can_undo());
    }

    #[test]
    fn test_pop_undo_returns_last_command() {
        let mut stack = UndoStack::new();

        stack.push_with_data(test_create_section_command("First"), UndoData::None);
        stack.push_with_data(test_create_section_command("Second"), UndoData::None);

        let entry = stack.pop_undo().unwrap();
        if let Command::CreateSection { name, .. } = entry.command {
            assert_eq!(name, Some("Second".to_string()));
        } else {
            panic!("Expected CreateSection command");
        }

        assert_eq!(stack.len(), 1);
    }

    #[test]
    fn test_pop_undo_empty_returns_none() {
        let mut stack = UndoStack::new();
        assert!(stack.pop_undo().is_none());
    }

    #[test]
    fn test_peek_undo_does_not_modify_stack() {
        let mut stack = UndoStack::new();
        let cmd = test_create_section_command("Test");

        stack.push_with_data(cmd, UndoData::None);

        let peeked = stack.peek_undo();
        assert!(peeked.is_some());
        assert_eq!(stack.len(), 1); // Stack unchanged
    }

    #[test]
    fn test_clear_removes_all_entries() {
        let mut stack = UndoStack::new();

        stack.push_with_data(test_create_section_command("First"), UndoData::None);
        stack.push_with_data(test_create_section_command("Second"), UndoData::None);
        stack.push_redo(UndoEntry {
            command: test_create_section_command("Redo"),
            undo_data: UndoData::None,
            timestamp: None,
        });

        stack.clear();

        assert!(!stack.can_undo());
        assert!(!stack.can_redo());
        assert_eq!(stack.len(), 0);
        assert_eq!(stack.redo_len(), 0);
    }

    // === Redo Stack Tests ===

    #[test]
    fn test_push_redo_enables_redo() {
        let mut stack = UndoStack::new();
        let entry = UndoEntry {
            command: test_create_section_command("Test"),
            undo_data: UndoData::None,
            timestamp: None,
        };

        stack.push_redo(entry);

        assert!(stack.can_redo());
        assert_eq!(stack.redo_len(), 1);
    }

    #[test]
    fn test_pop_redo_returns_last_entry() {
        let mut stack = UndoStack::new();

        stack.push_redo(UndoEntry {
            command: test_create_section_command("First"),
            undo_data: UndoData::None,
            timestamp: None,
        });
        stack.push_redo(UndoEntry {
            command: test_create_section_command("Second"),
            undo_data: UndoData::None,
            timestamp: None,
        });

        let entry = stack.pop_redo().unwrap();
        if let Command::CreateSection { name, .. } = entry.command {
            assert_eq!(name, Some("Second".to_string()));
        } else {
            panic!("Expected CreateSection command");
        }

        assert_eq!(stack.redo_len(), 1);
    }

    #[test]
    fn test_pop_redo_empty_returns_none() {
        let mut stack = UndoStack::new();
        assert!(stack.pop_redo().is_none());
    }

    #[test]
    fn test_peek_redo_does_not_modify_stack() {
        let mut stack = UndoStack::new();
        let entry = UndoEntry {
            command: test_create_section_command("Test"),
            undo_data: UndoData::None,
            timestamp: None,
        };

        stack.push_redo(entry);

        let peeked = stack.peek_redo();
        assert!(peeked.is_some());
        assert_eq!(stack.redo_len(), 1); // Stack unchanged
    }

    #[test]
    fn test_push_clears_redo_stack() {
        let mut stack = UndoStack::new();

        // Add some redo entries
        stack.push_redo(UndoEntry {
            command: test_create_section_command("Redo1"),
            undo_data: UndoData::None,
            timestamp: None,
        });
        stack.push_redo(UndoEntry {
            command: test_create_section_command("Redo2"),
            undo_data: UndoData::None,
            timestamp: None,
        });

        assert!(stack.can_redo());

        // New command should clear redo stack
        stack.push_with_data(test_create_section_command("New"), UndoData::None);

        assert!(!stack.can_redo());
        assert_eq!(stack.redo_len(), 0);
    }

    #[test]
    fn test_push_undo_does_not_clear_redo_stack() {
        let mut stack = UndoStack::new();

        // Add redo entries
        stack.push_redo(UndoEntry {
            command: test_create_section_command("Redo"),
            undo_data: UndoData::None,
            timestamp: None,
        });

        // push_undo is used for redo operations and should NOT clear redo
        stack.push_undo(UndoEntry {
            command: test_create_section_command("Restored"),
            undo_data: UndoData::None,
            timestamp: None,
        });

        assert!(stack.can_redo()); // Redo stack preserved
    }

    // === History Limit Tests ===

    #[test]
    fn test_history_limit_enforced_on_push() {
        let mut stack = UndoStack::new_with_limit(3);

        for i in 0..5 {
            stack.push_with_data(
                test_create_section_command(&format!("Section {i}")),
                UndoData::None,
            );
        }

        assert_eq!(stack.len(), 3);

        // The oldest entries should be removed
        let entry = stack.pop_undo().unwrap();
        if let Command::CreateSection { name, .. } = entry.command {
            assert_eq!(name, Some("Section 4".to_string()));
        } else {
            panic!("Expected Section 4");
        }
    }

    #[test]
    fn test_set_history_limit_trims_stack() {
        let mut stack = UndoStack::new();

        for i in 0..10 {
            stack.push_with_data(
                test_create_section_command(&format!("Section {i}")),
                UndoData::None,
            );
        }

        assert_eq!(stack.len(), 10);

        // Reduce limit - should trim oldest entries
        stack.set_history_limit(5);

        assert_eq!(stack.len(), 5);
        assert_eq!(stack.history_limit(), 5);

        // Verify we have the most recent entries
        let entry = stack.pop_undo().unwrap();
        if let Command::CreateSection { name, .. } = entry.command {
            assert_eq!(name, Some("Section 9".to_string()));
        } else {
            panic!("Expected Section 9");
        }
    }

    #[test]
    fn test_set_history_limit_zero() {
        let mut stack = UndoStack::new();
        stack.push_with_data(test_create_section_command("Test"), UndoData::None);

        stack.set_history_limit(0);

        assert_eq!(stack.len(), 0);
        assert!(!stack.can_undo());
    }

    #[test]
    fn test_set_history_limit_trims_redo_stack() {
        let mut stack = UndoStack::new();

        // Build up a redo stack by pushing then undoing
        for i in 0..10 {
            stack.push_redo(UndoEntry {
                command: test_create_section_command(&format!("Redo {i}")),
                undo_data: UndoData::None,
                timestamp: None,
            });
        }

        assert_eq!(stack.redo_len(), 10);

        // Reduce limit - should trim redo stack too
        stack.set_history_limit(3);

        assert_eq!(stack.redo_len(), 3);
    }

    // === UndoData Tests ===

    #[test]
    fn test_undo_data_inverse_command() {
        let mut stack = UndoStack::new();

        let inverse = Command::DeleteSection { section_id: 42 };
        stack.push_with_data(
            test_create_section_command("Test"),
            UndoData::InverseCommand(inverse),
        );

        let data = stack.peek_undo_data().unwrap();
        if let UndoData::InverseCommand(cmd) = data {
            if let Command::DeleteSection { section_id } = cmd {
                assert_eq!(*section_id, 42);
            } else {
                panic!("Expected DeleteSection");
            }
        } else {
            panic!("Expected InverseCommand");
        }
    }

    #[test]
    fn test_undo_data_section_snapshot() {
        let mut stack = UndoStack::new();

        let section_data = test_section_data("Snapshot Test");
        stack.push_with_data(
            test_delete_section_command(5),
            UndoData::SectionSnapshot {
                section_id: 5,
                section_data,
            },
        );

        let data = stack.peek_undo_data().unwrap();
        if let UndoData::SectionSnapshot {
            section_id,
            section_data: stored_data,
        } = data
        {
            assert_eq!(*section_id, 5);
            assert_eq!(stored_data.name, Some("Snapshot Test".to_string()));
        } else {
            panic!("Expected SectionSnapshot");
        }
    }

    #[test]
    fn test_undo_data_shot_snapshot() {
        let mut stack = UndoStack::new();

        let shot_data = ShotData {
            azimuth_in: 45.0,
            azimuth_out: 225.0,
            length: 10.0,
            depth_in: 5.0,
            depth_out: 6.0,
            ..Default::default()
        };

        stack.push_with_data(
            Command::DeleteShot {
                section_id: 1,
                shot_id: 100,
            },
            UndoData::ShotSnapshot {
                section_id: 1,
                shot_id: 100,
                shot_data,
                position: 2,
                uuid: None,
            },
        );

        let data = stack.peek_undo_data().unwrap();
        if let UndoData::ShotSnapshot {
            section_id,
            shot_id,
            shot_data: stored_data,
            position,
            ..
        } = data
        {
            assert_eq!(*section_id, 1);
            assert_eq!(*shot_id, 100);
            assert_eq!(stored_data.length, 10.0);
            assert_eq!(*position, 2);
        } else {
            panic!("Expected ShotSnapshot");
        }
    }

    #[test]
    fn test_undo_data_merge_info() {
        let mut stack = UndoStack::new();

        stack.push_with_data(
            Command::MergeStations {
                station_a: StationRef::new(1, 0),
                station_b: StationRef::new(2, 3),
            },
            UndoData::MergeInfo {
                station_a: StationRef::new(1, 0),
                station_b: StationRef::new(2, 3),
                removed_closures: Vec::new(),
                previous_offsets: HashMap::new(),
            },
        );

        let data = stack.peek_undo_data().unwrap();
        if let UndoData::MergeInfo {
            station_a,
            station_b,
            removed_closures,
            ..
        } = data
        {
            assert_eq!(station_a.section_id, 1);
            assert_eq!(station_a.station_index, 0);
            assert_eq!(station_b.section_id, 2);
            assert_eq!(station_b.station_index, 3);
            assert!(removed_closures.is_empty());
        } else {
            panic!("Expected MergeInfo");
        }
    }

    #[test]
    fn test_undo_data_zero_datum_info() {
        let mut stack = UndoStack::new();

        let gps = GpsCoordinates::new(45.0, -73.5, 100.0).unwrap();
        let mut offsets = HashMap::new();
        offsets.insert(1, Some((10.0, 20.0)));
        offsets.insert(2, None); // Key didn't exist before
        stack.push_with_data(
            Command::SetZeroDatum {
                station_ref: StationRef::new(1, 0),
                coordinates: gps,
            },
            UndoData::ZeroDatumInfo {
                station_ref: StationRef::new(1, 0),
                previous_gps: Some(GpsCoordinates::new(40.0, -70.0, 50.0).unwrap()),
                previous_offsets: offsets,
            },
        );

        let data = stack.peek_undo_data().unwrap();
        if let UndoData::ZeroDatumInfo {
            station_ref,
            previous_gps,
            previous_offsets,
        } = data
        {
            assert_eq!(station_ref.section_id, 1);
            let prev = previous_gps.as_ref().unwrap();
            assert_eq!(prev.latitude, 40.0);
            assert_eq!(previous_offsets.get(&1), Some(&Some((10.0, 20.0))));
            assert_eq!(previous_offsets.get(&2), Some(&None));
        } else {
            panic!("Expected ZeroDatumInfo");
        }
    }

    // === Serialization / Persistence Tests ===

    #[test]
    fn test_serialize_entry_basic() {
        let entry = UndoEntry {
            command: test_create_section_command("Serialize Test"),
            undo_data: UndoData::None,
            timestamp: None,
        };

        let result = UndoStack::serialize_entry(&entry);
        assert!(result.is_some());

        let (cmd_json, undo_json) = result.unwrap();
        assert!(cmd_json.contains("Serialize Test"));
        assert!(undo_json.contains("None"));
    }

    #[test]
    fn test_deserialize_entry_basic() {
        let entry = UndoEntry {
            command: test_create_section_command("Deserialize Test"),
            undo_data: UndoData::InverseCommand(test_delete_section_command(42)),
            timestamp: None,
        };

        let (cmd_json, undo_json) = UndoStack::serialize_entry(&entry).unwrap();
        let restored = UndoStack::deserialize_entry(&cmd_json, &undo_json).unwrap();

        if let Command::CreateSection { name, .. } = restored.command {
            assert_eq!(name, Some("Deserialize Test".to_string()));
        } else {
            panic!("Expected CreateSection");
        }

        if let UndoData::InverseCommand(Command::DeleteSection { section_id }) = restored.undo_data
        {
            assert_eq!(section_id, 42);
        } else {
            panic!("Expected InverseCommand with DeleteSection");
        }
    }

    #[test]
    fn test_deserialize_entry_invalid_json() {
        let result = UndoStack::deserialize_entry("not valid json", "{}");
        assert!(result.is_none());

        let result = UndoStack::deserialize_entry("{}", "not valid json");
        assert!(result.is_none());
    }

    #[test]
    fn test_serialize_entry_with_section_snapshot() {
        let entry = UndoEntry {
            command: test_delete_section_command(5),
            undo_data: UndoData::SectionSnapshot {
                section_id: 5,
                section_data: test_section_data("Snapshot"),
            },
            timestamp: None,
        };

        let result = UndoStack::serialize_entry(&entry);
        assert!(result.is_some());

        let (cmd_json, undo_json) = result.unwrap();
        let restored = UndoStack::deserialize_entry(&cmd_json, &undo_json).unwrap();

        if let UndoData::SectionSnapshot {
            section_id,
            section_data,
        } = restored.undo_data
        {
            assert_eq!(section_id, 5);
            assert_eq!(section_data.name, Some("Snapshot".to_string()));
        } else {
            panic!("Expected SectionSnapshot");
        }
    }

    #[test]
    fn test_load_from_persisted() {
        let mut stack = UndoStack::new();

        // Create serialized entries
        let entries: Vec<(String, String)> = (0..3)
            .map(|i| {
                let entry = UndoEntry {
                    command: test_create_section_command(&format!("Section {i}")),
                    undo_data: UndoData::InverseCommand(test_delete_section_command(i as u32)),
                    timestamp: None,
                };
                UndoStack::serialize_entry(&entry).unwrap()
            })
            .collect();

        stack.load_from_persisted(entries);

        assert_eq!(stack.len(), 3);
        assert!(stack.can_undo());
        assert!(!stack.can_redo()); // Redo should be cleared

        // Verify entries loaded in correct order
        let entry = stack.pop_undo().unwrap();
        if let Command::CreateSection { name, .. } = entry.command {
            assert_eq!(name, Some("Section 2".to_string()));
        } else {
            panic!("Expected Section 2");
        }
    }

    #[test]
    fn test_load_from_persisted_respects_limit() {
        let mut stack = UndoStack::new_with_limit(2);

        // Create more entries than the limit. The filler undo data must be a REAL
        // variant: `load_from_persisted` drops `UndoData::None` entries, so `None`
        // here would test the filter instead of the limit.
        let entries: Vec<(String, String)> = (0..5)
            .map(|i| {
                let entry = UndoEntry {
                    command: test_create_section_command(&format!("Section {i}")),
                    undo_data: UndoData::InverseCommand(test_delete_section_command(1)),
                    timestamp: None,
                };
                UndoStack::serialize_entry(&entry).unwrap()
            })
            .collect();

        stack.load_from_persisted(entries);

        assert_eq!(stack.len(), 2);

        // Should have the most recent entries
        let entry = stack.pop_undo().unwrap();
        if let Command::CreateSection { name, .. } = entry.command {
            assert_eq!(name, Some("Section 4".to_string()));
        } else {
            panic!("Expected Section 4");
        }
    }

    #[test]
    fn test_load_from_persisted_clears_existing() {
        let mut stack = UndoStack::new();

        // Add some entries
        stack.push_with_data(test_create_section_command("Existing"), UndoData::None);
        stack.push_redo(UndoEntry {
            command: test_create_section_command("Existing Redo"),
            undo_data: UndoData::None,
            timestamp: None,
        });

        // Load persisted data should clear existing. Real undo data, so the load
        // filter keeps the entry and this stays a test of the clear.
        let entries: Vec<(String, String)> = vec![UndoStack::serialize_entry(&UndoEntry {
            command: test_create_section_command("Loaded"),
            undo_data: UndoData::InverseCommand(test_delete_section_command(1)),
            timestamp: None,
        })
        .unwrap()];

        stack.load_from_persisted(entries);

        assert_eq!(stack.len(), 1);
        assert_eq!(stack.redo_len(), 0);
    }

    #[test]
    fn test_load_from_persisted_skips_invalid() {
        let mut stack = UndoStack::new();

        // Real undo data, so the only thing that can drop this entry is the
        // malformed-JSON skip this test is about.
        let valid_entry = UndoStack::serialize_entry(&UndoEntry {
            command: test_create_section_command("Valid"),
            undo_data: UndoData::InverseCommand(test_delete_section_command(1)),
            timestamp: None,
        })
        .unwrap();

        let entries = vec![
            ("invalid json".to_string(), "{}".to_string()),
            valid_entry,
            ("{}".to_string(), "also invalid".to_string()),
        ];

        stack.load_from_persisted(entries);

        // Only the valid entry should be loaded
        assert_eq!(stack.len(), 1);
    }

    /// A stack persisted before the forward guard existed can carry an entry with
    /// `UndoData::None`. `undo()` cannot apply it and pushes it straight back, so
    /// everything below it is unreachable forever. Loading must drop it and keep the
    /// real history underneath usable.
    #[test]
    fn load_drops_a_persisted_none_entry_and_keeps_the_history_under_it() {
        let mut stack = UndoStack::new();

        let entries: Vec<(String, String)> = vec![
            UndoStack::serialize_entry(&UndoEntry {
                command: test_create_section_command("Older"),
                undo_data: UndoData::InverseCommand(test_delete_section_command(1)),
                timestamp: None,
            })
            .unwrap(),
            UndoStack::serialize_entry(&UndoEntry {
                command: test_create_section_command("Poison"),
                undo_data: UndoData::None,
                timestamp: None,
            })
            .unwrap(),
            UndoStack::serialize_entry(&UndoEntry {
                command: test_create_section_command("Newer"),
                undo_data: UndoData::InverseCommand(test_delete_section_command(3)),
                timestamp: None,
            })
            .unwrap(),
        ];

        stack.load_from_persisted(entries);

        assert_eq!(stack.len(), 2, "the unapplicable entry must be dropped");

        let top = stack.pop_undo().unwrap();
        match top.command {
            Command::CreateSection { name, .. } => assert_eq!(name, Some("Newer".to_string())),
            other => panic!("Expected Newer, got {other:?}"),
        }
        let below = stack.pop_undo().unwrap();
        match below.command {
            Command::CreateSection { name, .. } => assert_eq!(name, Some("Older".to_string())),
            other => panic!("Expected Older, got {other:?}"),
        }
    }

    /// The timestamped twin - the only loader real project opens use
    /// (`project_load.rs`), and previously the only one with no unit coverage.
    #[test]
    fn load_with_timestamps_drops_a_persisted_none_undo_entry() {
        let mut stack = UndoStack::new();

        let undo_entries: Vec<(String, String, Option<String>)> = vec![
            UndoStack::serialize_entry_with_timestamp(&UndoEntry {
                command: test_create_section_command("Older"),
                undo_data: UndoData::InverseCommand(test_delete_section_command(1)),
                timestamp: None,
            })
            .unwrap(),
            UndoStack::serialize_entry_with_timestamp(&UndoEntry {
                command: test_create_section_command("Poison"),
                undo_data: UndoData::None,
                timestamp: None,
            })
            .unwrap(),
            UndoStack::serialize_entry_with_timestamp(&UndoEntry {
                command: test_create_section_command("Newer"),
                undo_data: UndoData::InverseCommand(test_delete_section_command(3)),
                timestamp: None,
            })
            .unwrap(),
        ];

        stack.load_from_persisted_with_timestamps(undo_entries, vec![]);

        assert_eq!(stack.len(), 2);

        let top = stack.pop_undo().unwrap();
        match top.command {
            Command::CreateSection { name, .. } => assert_eq!(name, Some("Newer".to_string())),
            other => panic!("Expected Newer, got {other:?}"),
        }
        let below = stack.pop_undo().unwrap();
        match below.command {
            Command::CreateSection { name, .. } => assert_eq!(name, Some("Older".to_string())),
            other => panic!("Expected Older, got {other:?}"),
        }
    }

    /// Guards against over-filtering. `redo_inner`'s catch-all arm re-executes
    /// `entry.command` and never reads `undo_data`, so a `UndoData::None` REDO entry
    /// redoes correctly. Dropping it would destroy working functionality and shift
    /// the indices `redo_to` is called with.
    #[test]
    fn load_keeps_a_none_redo_entry() {
        let mut stack = UndoStack::new();

        let redo_entries: Vec<(String, String, Option<String>)> =
            vec![UndoStack::serialize_entry_with_timestamp(&UndoEntry {
                command: test_create_section_command("Redoable"),
                undo_data: UndoData::None,
                timestamp: None,
            })
            .unwrap()];

        stack.load_from_persisted_with_timestamps(vec![], redo_entries);

        assert_eq!(stack.redo_len(), 1, "the redo stack must not be filtered");
        assert!(stack.can_redo());
    }

    #[test]
    fn test_entries_to_persist_all_entries() {
        let mut stack = UndoStack::new();

        for i in 0..5 {
            stack.push_with_data(
                test_create_section_command(&format!("Section {i}")),
                UndoData::None,
            );
        }

        let persisted: Vec<_> = stack.entries_to_persist(10).collect();
        assert_eq!(persisted.len(), 5);
    }

    #[test]
    fn test_entries_to_persist_limited() {
        let mut stack = UndoStack::new();

        for i in 0..10 {
            stack.push_with_data(
                test_create_section_command(&format!("Section {i}")),
                UndoData::None,
            );
        }

        let persisted: Vec<_> = stack.entries_to_persist(3).collect();
        assert_eq!(persisted.len(), 3);

        // Should be the most recent 3
        if let Command::CreateSection { name, .. } = &persisted[0].command {
            assert_eq!(*name, Some("Section 7".to_string()));
        } else {
            panic!("Expected Section 7");
        }
    }

    // === Complex Operation Sequences ===

    #[test]
    fn test_undo_redo_cycle() {
        let mut stack = UndoStack::new();

        // Push command
        let entry = UndoEntry {
            command: test_create_section_command("Test"),
            undo_data: UndoData::InverseCommand(test_delete_section_command(1)),
            timestamp: None,
        };
        stack.push_with_data(entry.command.clone(), entry.undo_data);

        assert!(stack.can_undo());
        assert!(!stack.can_redo());

        // Simulate undo: pop from undo, push to redo
        let undone = stack.pop_undo().unwrap();
        stack.push_redo(undone);

        assert!(!stack.can_undo());
        assert!(stack.can_redo());

        // Simulate redo: pop from redo, push to undo
        let redone = stack.pop_redo().unwrap();
        stack.push_undo(redone);

        assert!(stack.can_undo());
        assert!(!stack.can_redo());
    }

    #[test]
    fn test_multiple_undo_redo_cycles() {
        let mut stack = UndoStack::new();

        // Push 3 commands
        for i in 0..3 {
            stack.push_with_data(
                test_create_section_command(&format!("Section {i}")),
                UndoData::InverseCommand(test_delete_section_command(i as u32)),
            );
        }

        assert_eq!(stack.len(), 3);

        // Undo all 3
        for _ in 0..3 {
            let entry = stack.pop_undo().unwrap();
            stack.push_redo(entry);
        }

        assert_eq!(stack.len(), 0);
        assert_eq!(stack.redo_len(), 3);

        // Redo 2
        for _ in 0..2 {
            let entry = stack.pop_redo().unwrap();
            stack.push_undo(entry);
        }

        assert_eq!(stack.len(), 2);
        assert_eq!(stack.redo_len(), 1);
    }

    #[test]
    fn test_new_command_after_undo_clears_redo() {
        let mut stack = UndoStack::new();

        // Create -> Undo -> New action (should clear redo)
        stack.push_with_data(test_create_section_command("Original"), UndoData::None);

        let entry = stack.pop_undo().unwrap();
        stack.push_redo(entry);

        assert!(stack.can_redo());

        // New command should clear redo
        stack.push_with_data(test_create_section_command("New"), UndoData::None);

        assert!(!stack.can_redo());
        assert!(stack.can_undo());
    }

    #[test]
    fn test_roundtrip_serialization_all_undo_data_types() {
        // Test that all UndoData variants can be serialized and deserialized

        let test_cases: Vec<UndoEntry> = vec![
            UndoEntry {
                command: test_create_section_command("None"),
                undo_data: UndoData::None,
                timestamp: None,
            },
            UndoEntry {
                command: test_create_section_command("Inverse"),
                undo_data: UndoData::InverseCommand(test_delete_section_command(1)),
                timestamp: None,
            },
            UndoEntry {
                command: test_delete_section_command(2),
                undo_data: UndoData::SectionSnapshot {
                    section_id: 2,
                    section_data: test_section_data("Snapshot"),
                },
                timestamp: None,
            },
            UndoEntry {
                command: test_create_section_command("Created Snapshot"),
                undo_data: UndoData::CreatedSectionSnapshot {
                    section_id: 3,
                    section_data: test_section_data("Created"),
                },
                timestamp: None,
            },
            UndoEntry {
                command: Command::DeleteShot {
                    section_id: 1,
                    shot_id: 100,
                },
                undo_data: UndoData::ShotSnapshot {
                    section_id: 1,
                    shot_id: 100,
                    shot_data: ShotData {
                        length: 5.0,
                        ..Default::default()
                    },
                    position: 0,
                    uuid: None,
                },
                timestamp: None,
            },
            UndoEntry {
                command: Command::CreateShot {
                    section_id: 1,
                    shot: ShotData {
                        length: 8.0,
                        ..Default::default()
                    },
                    after_shot_id: None,
                    before_shot_id: None,
                },
                undo_data: UndoData::CreatedShotSnapshot {
                    section_id: 1,
                    shot_id: 200,
                    shot_data: ShotData {
                        length: 8.0,
                        ..Default::default()
                    },
                    position: 0,
                    station_shift_from: 1,
                    after_shot_id: None,
                    before_shot_id: None,
                    uuid: None,
                },
                timestamp: None,
            },
            UndoEntry {
                command: Command::SetZeroDatum {
                    station_ref: StationRef::new(1, 0),
                    coordinates: GpsCoordinates::new(45.0, -73.0, 100.0).unwrap(),
                },
                undo_data: UndoData::ZeroDatumInfo {
                    station_ref: StationRef::new(1, 0),
                    previous_gps: None,
                    previous_offsets: HashMap::new(),
                },
                timestamp: None,
            },
            UndoEntry {
                command: Command::MergeStations {
                    station_a: StationRef::new(1, 0),
                    station_b: StationRef::new(2, 1),
                },
                undo_data: UndoData::MergeInfo {
                    station_a: StationRef::new(1, 0),
                    station_b: StationRef::new(2, 1),
                    removed_closures: Vec::new(),
                    previous_offsets: HashMap::new(),
                },
                timestamp: None,
            },
            UndoEntry {
                command: Command::Batch { commands: vec![] },
                undo_data: UndoData::ProjectSnapshot("{}".to_string()),
                timestamp: None,
            },
            UndoEntry {
                command: Command::UpdateShot {
                    section_id: 1,
                    shot_id: 100,
                    updates: crate::models::ShotUpdates {
                        length: Some(10.0),
                        ..Default::default()
                    },
                },
                undo_data: UndoData::PreviousValues {
                    section_id: 1,
                    shot_id: Some(100),
                    values_json: r#"{"length":5.0}"#.to_string(),
                },
                timestamp: None,
            },
        ];

        for (i, original) in test_cases.iter().enumerate() {
            let serialized = UndoStack::serialize_entry(original);
            assert!(serialized.is_some(), "Failed to serialize test case {i}");

            let (cmd_json, undo_json) = serialized.unwrap();
            let deserialized = UndoStack::deserialize_entry(&cmd_json, &undo_json);
            assert!(
                deserialized.is_some(),
                "Failed to deserialize test case {i}"
            );
        }
    }

    // === [#303] Byte budget (spec items 7, 8, 9) ===

    /// An entry whose estimated size is `payload` bytes plus the flat overhead.
    fn sized_entry(payload: usize, name: &str) -> (Command, UndoData) {
        (
            test_create_section_command(name),
            UndoData::ProjectSnapshot("x".repeat(payload)),
        )
    }

    /// Spec item 7: Full mode keeps MORE than `undo_history_limit` entries. The count
    /// window is what the byte budget replaces, so a stack on the budget must not be
    /// truncated at 100 (or at whatever the user configured).
    #[test]
    fn undo_budget_keeps_more_than_the_count_limit() {
        let mut stack = UndoStack::new_with_limit(10);
        stack.set_byte_budget(10 * 1024 * 1024);

        for i in 0..50 {
            let (cmd, data) = sized_entry(64, &format!("S{i}"));
            stack.push_with_data(cmd, data);
        }

        assert_eq!(
            stack.len(),
            50,
            "the byte budget replaces the count window, it does not coexist with it"
        );
    }

    /// Spec item 8: past the budget, the OLDEST entries go first and the newest survive.
    #[test]
    fn undo_budget_drops_oldest_past_the_budget() {
        // Budget for ~4 entries of 1 KiB payload (+512 overhead each).
        let entry_size = 1024 + 512;
        let mut stack = UndoStack::new_with_limit(1000);
        stack.set_byte_budget(entry_size * 4);

        for i in 0..10 {
            let (cmd, data) = sized_entry(1024, &format!("S{i}"));
            stack.push_with_data(cmd, data);
        }

        assert_eq!(stack.len(), 4, "bounded by bytes, not by count");
        assert!(
            stack.estimated_undo_bytes() <= entry_size * 4,
            "the surviving stack fits the budget"
        );
        // The NEWEST entry is the one the user just did, so it must be the last to go.
        let top = stack.pop_undo().expect("newest");
        match top.command {
            Command::CreateSection { name, .. } => assert_eq!(name, Some("S9".to_owned())),
            other => panic!("expected the newest entry, got {other:?}"),
        }
    }

    /// A single entry larger than the whole budget is KEPT: dropping it would silently
    /// discard the operation the user just performed, and one oversized entry is a very
    /// large import rather than runaway growth.
    #[test]
    fn undo_budget_always_keeps_the_newest_entry() {
        let mut stack = UndoStack::new_with_limit(1000);
        stack.set_byte_budget(1024);

        let (cmd, data) = sized_entry(64 * 1024, "huge");
        stack.push_with_data(cmd, data);

        assert_eq!(stack.len(), 1, "the newest entry survives its own size");
        assert!(stack.can_undo(), "and stays undoable");
    }

    /// Spec item 9: Disabled mode (and every local project) keeps the count window, and
    /// switching back to it from the budget re-applies the configured number.
    #[test]
    fn undo_budget_reverting_to_count_limit_retrims() {
        let mut stack = UndoStack::new_with_limit(3);
        stack.set_byte_budget(10 * 1024 * 1024);
        for i in 0..10 {
            let (cmd, data) = sized_entry(64, &format!("S{i}"));
            stack.push_with_data(cmd, data);
        }
        assert_eq!(stack.len(), 10);

        stack.use_count_limit();
        assert_eq!(stack.len(), 3, "back on the configured entry window");
        assert_eq!(stack.depth_limit(), DepthLimit::Count(3));
    }

    /// A config reload must not knock a Full-mode project off the byte budget: that
    /// would truncate the history its next push is supposed to carry to the server.
    #[test]
    fn undo_budget_survives_a_history_limit_change() {
        let mut stack = UndoStack::new_with_limit(100);
        stack.set_byte_budget(10 * 1024 * 1024);
        for i in 0..20 {
            let (cmd, data) = sized_entry(64, &format!("S{i}"));
            stack.push_with_data(cmd, data);
        }

        stack.set_history_limit(5);

        assert_eq!(stack.len(), 20, "still on the byte budget");
        assert!(matches!(stack.depth_limit(), DepthLimit::Bytes(_)));
        // ...and the new count is remembered for when the project goes back to it.
        stack.use_count_limit();
        assert_eq!(stack.len(), 5);
    }

    /// The estimator has to be dominated by the snapshot payloads - they are the only
    /// variants that reach megabytes, and the whole budget rests on that being true.
    #[test]
    fn undo_budget_size_estimate_tracks_the_snapshot_payload() {
        let small = UndoEntry {
            command: test_create_section_command("small"),
            undo_data: UndoData::InverseCommand(test_delete_section_command(1)),
            timestamp: None,
        };
        let big = UndoEntry {
            command: test_create_section_command("big"),
            undo_data: UndoData::ProjectSnapshotPair {
                before: "b".repeat(1_000_000),
                after: "a".repeat(1_000_000),
            },
            timestamp: None,
        };
        assert!(UndoStack::estimated_size(&small) < 1024);
        assert!(
            UndoStack::estimated_size(&big) >= 2_000_000,
            "a snapshot PAIR counts both halves - it is two whole-project JSON blobs"
        );
    }

    // === [#303] Persistence (spec item 10) ===

    /// Every save plans EVERY row, including a save with nothing changed since the last
    /// one.
    ///
    /// This is the regression guard for the bug that shipped in the first cut of #303:
    /// the plan used to skip rows it believed were already in the destination, which is
    /// false - `save_project` builds a fresh `.stalx.tmp` and renames it over the target,
    /// so a save that writes nothing produces a file with NO history. Live, that turned
    /// the commit made right after another save into one carrying no undo history at all.
    #[test]
    fn undo_persist_plan_writes_every_row_even_when_nothing_changed() {
        let mut stack = UndoStack::new_with_limit(1000);
        stack.set_byte_budget(64 * 1024 * 1024);
        for i in 0..5 {
            let (cmd, data) = sized_entry(64, &format!("S{i}"));
            stack.push_with_data(cmd, data);
        }

        let first = stack.persist_plan(PersistStack::Undo, None);
        assert_eq!(first.rows.len(), 5);
        assert_eq!(first.keep_range, Some((0, 4)));

        // The SAME plan again, with no mutation in between - an idle autosave, or the
        // push's flush right after another save. It must still carry all five.
        let again = stack.persist_plan(PersistStack::Undo, None);
        assert_eq!(
            again.rows.len(),
            5,
            "a save with nothing changed still rewrites the whole stack - the file it \
             writes into is brand new"
        );
        assert_eq!(
            again.rows.iter().map(|r| r.id).collect::<Vec<_>>(),
            vec![0, 1, 2, 3, 4]
        );
    }

    /// Ids stay monotonic across a front eviction, so `ORDER BY sequence` keeps
    /// reproducing stack order rather than renumbering from zero on every trim.
    #[test]
    fn undo_persist_plan_ids_are_stable_across_a_trim() {
        let entry_size = 1024 + 512;
        let mut stack = UndoStack::new_with_limit(1000);
        stack.set_byte_budget(entry_size * 3);
        for i in 0..3 {
            let (cmd, data) = sized_entry(1024, &format!("S{i}"));
            stack.push_with_data(cmd, data);
        }
        assert_eq!(
            stack.persist_plan(PersistStack::Undo, None).keep_range,
            Some((0, 2))
        );

        // A fourth push evicts id 0.
        let (cmd, data) = sized_entry(1024, "S3");
        stack.push_with_data(cmd, data);
        let plan = stack.persist_plan(PersistStack::Undo, None);
        assert_eq!(
            plan.keep_range,
            Some((1, 3)),
            "the evicted id falls outside the range, so the sync deletes its row"
        );
        assert_eq!(
            plan.rows.iter().map(|r| r.id).collect::<Vec<_>>(),
            vec![1, 2, 3],
            "and the survivors keep the ids they already had"
        );
    }

    /// An undo pops the tail, so that id leaves the range and its row is deleted - while
    /// the survivors are still written out.
    #[test]
    fn undo_persist_plan_range_retires_a_popped_tail() {
        let mut stack = UndoStack::new_with_limit(1000);
        stack.set_byte_budget(64 * 1024 * 1024);
        for i in 0..3 {
            let (cmd, data) = sized_entry(64, &format!("S{i}"));
            stack.push_with_data(cmd, data);
        }

        let popped = stack.pop_undo().expect("pop");
        stack.push_redo(popped);

        let undo_plan = stack.persist_plan(PersistStack::Undo, None);
        assert_eq!(
            undo_plan.keep_range,
            Some((0, 1)),
            "the popped id is outside the range and its row is deleted"
        );
        assert_eq!(undo_plan.rows.len(), 2, "the survivors are still written");
        // The redo side gained the entry.
        assert_eq!(stack.persist_plan(PersistStack::Redo, None).rows.len(), 1);
    }

    /// A count-limited project (local, or Disabled mode) persists a WINDOW over the tail
    /// of the stack, and that window's start moves with every push - so those saves
    /// rewrite it, exactly as they always did.
    #[test]
    fn undo_persist_plan_count_limit_writes_the_window() {
        let mut stack = UndoStack::new_with_limit(1000);
        for i in 0..10 {
            let (cmd, data) = sized_entry(64, &format!("S{i}"));
            stack.push_with_data(cmd, data);
        }

        let plan = stack.persist_plan(PersistStack::Undo, Some(3));
        assert_eq!(plan.rows.len(), 3, "only the last 3 entries are persisted");
        assert_eq!(plan.keep_range, Some((7, 9)));
        assert_eq!(
            plan.rows.iter().map(|r| r.id).collect::<Vec<_>>(),
            vec![7, 8, 9]
        );
    }

    /// A load restarts the id numbering from zero, and the next save writes the loaded
    /// entries out in full.
    #[test]
    fn undo_persist_plan_after_load_writes_everything() {
        let mut stack = UndoStack::new();
        let entries: Vec<(String, String, Option<String>)> = (0..3)
            .map(|i| {
                UndoStack::serialize_entry_with_timestamp(&UndoEntry {
                    command: test_create_section_command(&format!("S{i}")),
                    undo_data: UndoData::InverseCommand(test_delete_section_command(i)),
                    timestamp: None,
                })
                .expect("serialize")
            })
            .collect();
        stack.load_from_persisted_with_timestamps(entries, vec![]);

        let plan = stack.persist_plan(PersistStack::Undo, None);
        assert_eq!(plan.rows.len(), 3);
        assert_eq!(
            plan.rows.iter().map(|r| r.id).collect::<Vec<_>>(),
            vec![0, 1, 2]
        );
    }

    // === [#303] clear-on-push (spec items 4, 5, 11) ===

    /// [#303] The stack orders itself: a new entry never lands at or below the one under
    /// it, whatever the wall clock says.
    ///
    /// `drop_entries_up_to` uses `partition_point`, which needs the stamps sorted to mean
    /// anything, and the push-time cut compares entries against a watermark. Both read a
    /// stack whose order can otherwise be broken from outside: a chain step loads entries
    /// stamped by the machine that authored them, and a local clock can be corrected
    /// backwards mid-session.
    #[test]
    fn stamps_stay_strictly_increasing_against_a_clock_that_does_not() {
        let mut stack = UndoStack::new();
        let push = |stack: &mut UndoStack, i: u32| {
            stack.push_with_data(
                test_create_section_command(&format!("S{i}")),
                UndoData::InverseCommand(test_delete_section_command(i)),
            );
        };

        // An entry loaded from a peer whose clock runs a day fast.
        push(&mut stack, 0);
        let future = Utc::now() + chrono::Duration::days(1);
        stack.undo_stack.back_mut().expect("seeded").timestamp = Some(future);

        // Everything the user does now is stamped ABOVE it, even though `now` is a day
        // behind. Without this, the watermark cut would classify their own work as
        // inherited and drop it from the upload.
        for i in 1..4 {
            push(&mut stack, i);
        }

        // `undo_entries` yields most-recent FIRST, so reverse into stack order (oldest
        // first) - the order the invariant is about and the one `partition_point` walks.
        let mut stamps: Vec<_> = stack
            .undo_entries()
            .map(|e| e.timestamp.expect("stamped"))
            .collect();
        stamps.reverse();
        assert!(
            stamps.windows(2).all(|w| w[0] < w[1]),
            "stamps must be strictly increasing in stack order, got {stamps:?}"
        );
        assert!(
            stamps[1] > future,
            "the user's first edit must sit above the peer's future-dated entry"
        );
        assert_eq!(
            stack.newest_stamp(),
            stamps.last().copied(),
            "newest_stamp is the back, which the invariant makes the maximum"
        );
    }

    /// The ordinary case must keep telling the truth: with a sane clock the stamp IS the
    /// wall-clock instant, so displayed times stay honest and the clamp is invisible.
    #[test]
    fn an_ordinary_push_is_stamped_at_the_real_instant() {
        let mut stack = UndoStack::new();
        let before = Utc::now();
        stack.push_with_data(
            test_create_section_command("S0"),
            UndoData::InverseCommand(test_delete_section_command(0)),
        );
        let after = Utc::now();
        let stamp = stack.newest_stamp().expect("stamped");
        assert!(
            stamp >= before && stamp <= after,
            "expected the real instant, got {stamp:?} outside {before:?}..{after:?}"
        );
    }

    /// Spec items 4 + 5: the push-start boundary. Entries captured by the push go (they
    /// are on the server now, and keeping them would duplicate them in the next commit);
    /// an edit that landed AFTER the snapshot was taken STAYS, because its dirty bit
    /// stays too and the next push has to carry both the edit and its history.
    #[test]
    fn drop_entries_up_to_keeps_edits_that_landed_after_push_start() {
        let mut stack = UndoStack::new();
        let t =
            |secs: i64| DateTime::from_timestamp(1_700_000_000 + secs, 0).expect("valid timestamp");

        for (i, secs) in [0, 10, 20, 30].into_iter().enumerate() {
            stack.push_with_data(
                test_create_section_command(&format!("S{i}")),
                UndoData::InverseCommand(test_delete_section_command(i as u32)),
            );
            // Overwrite the auto-assigned timestamp so the boundary is deterministic.
            if let Some(entry) = stack.undo_stack.back_mut() {
                entry.timestamp = Some(t(secs));
            }
        }
        // A push that started at t=25: the first three entries are in its snapshot.
        let dropped = stack.drop_entries_up_to(t(25));

        assert_eq!(dropped, 3);
        assert_eq!(stack.len(), 1, "the post-push-start edit survives");
        let survivor = stack.peek_undo().expect("survivor");
        match survivor {
            Command::CreateSection { name, .. } => assert_eq!(*name, Some("S3".to_owned())),
            other => panic!("expected S3, got {other:?}"),
        }
    }

    /// Spec item 11: a confirmed push clears the redo stack outright. Redo is never
    /// uploaded, and a redo branch that replays onto a state the server has now
    /// committed is the stale-replay hazard the whole design avoids.
    #[test]
    fn drop_entries_up_to_clears_redo_wholesale() {
        let mut stack = UndoStack::new();
        stack.push_with_data(
            test_create_section_command("a"),
            UndoData::InverseCommand(test_delete_section_command(1)),
        );
        let entry = stack.pop_undo().expect("pop");
        stack.push_redo(entry);
        assert!(stack.can_redo());

        stack.drop_entries_up_to(Utc::now());

        assert!(!stack.can_redo(), "redo goes wholesale on a confirmed push");
        assert!(!stack.can_undo());
    }

    /// A legacy persisted entry carries no timestamp. It necessarily predates this
    /// session's push, so it is dropped rather than kept forever.
    #[test]
    fn drop_entries_up_to_drops_untimestamped_legacy_entries() {
        let mut stack = UndoStack::new();
        stack.push_with_data(
            test_create_section_command("legacy"),
            UndoData::InverseCommand(test_delete_section_command(1)),
        );
        if let Some(entry) = stack.undo_stack.back_mut() {
            entry.timestamp = None;
        }

        assert_eq!(stack.drop_entries_up_to(Utc::now()), 1);
        assert!(stack.is_empty());
    }

    #[test]
    fn test_undo_data_closure_info_serialization() {
        let closure = LoopClosure {
            id: 1,
            station_a: StationRef::new(1, 0).into(),
            station_b: StationRef::new(2, 3).into(),
            path_length: 45.5,
            misclosure_distance: 1.2,
            error_percentage: 2.6,
            horizontal_misclosure: 1.0,
            vertical_misclosure: 0.7,
            strategy: crate::models::ClosureStrategy::ProportionalByLength,
            is_aligned: false,
        };

        let entry = UndoEntry {
            command: Command::CreateLoopClosure {
                station_a: StationRef::new(1, 0),
                station_b: StationRef::new(2, 3),
                closure_strategy: crate::models::ClosureStrategy::ProportionalByLength,
            },
            undo_data: UndoData::ClosureInfo { closure },
            timestamp: None,
        };

        // Serialize
        let (cmd_json, undo_json) =
            UndoStack::serialize_entry(&entry).expect("ClosureInfo should serialize");

        // Deserialize
        let restored = UndoStack::deserialize_entry(&cmd_json, &undo_json)
            .expect("ClosureInfo should deserialize");

        // Verify roundtrip
        match &restored.undo_data {
            UndoData::ClosureInfo {
                closure: restored_closure,
            } => {
                // Pure serialization roundtrip (no project / no reanchor): the
                // transitional Index anchors survive verbatim, so compare keys directly.
                assert_eq!(restored_closure.station_a, StationRef::new(1, 0).into());
                assert_eq!(restored_closure.station_b, StationRef::new(2, 3).into());
                assert!((restored_closure.path_length - 45.5).abs() < 1e-6);
                assert!((restored_closure.misclosure_distance - 1.2).abs() < 1e-6);
                assert!((restored_closure.error_percentage - 2.6).abs() < 1e-6);
                assert!((restored_closure.horizontal_misclosure - 1.0).abs() < 1e-6);
                assert!((restored_closure.vertical_misclosure - 0.7).abs() < 1e-6);
            }
            other => panic!("Expected ClosureInfo, got {}", other.variant_name()),
        }

        match &restored.command {
            Command::CreateLoopClosure {
                station_a,
                station_b,
                ..
            } => {
                assert_eq!(*station_a, StationRef::new(1, 0));
                assert_eq!(*station_b, StationRef::new(2, 3));
            }
            _ => panic!("Expected CreateLoopClosure command"),
        }
    }
}
