use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::cmp::Ordering;
use std::collections::{BinaryHeap, HashMap, HashSet, VecDeque};
use std::path::PathBuf;
use tracing::{debug, error, trace, warn};
use ts_rs::TS;

use crate::config::ClosureAdjustmentConfig;

use super::{
    ClosureRef, ClosureStrategy, CollabState, Coordinates, FrozenShotRef, GpsBounds, LoopClosure,
    Section, SectionData, SectionId, SectionUpdates, Shot, ShotData, ShotId, Station,
    StationAnchor, StationKey, StationMerge, StationMergeWire, StationRef, ZeroDatum,
};
use super::{LoopClosureWire, ZeroDatumWire};

// Used only by the `tests` module via `use super::*`; production code in this
// residual file no longer references them after the Phase 5.2 cluster moves.
#[cfg(test)]
use super::{GpsCoordinates, ShotUpdates};

mod connectivity;
mod mutations;
mod shots;

mod integrity;
mod offsets;
mod relationships;
mod stats;

pub use integrity::{IntegrityViolation, ViolationSeverity};

/// Relationships that reference a given section (merges, closures, offsets, zero datums).
/// Used by the frontend to show affected relationships before section deletion.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct SectionRelationships {
    /// Station merges referencing the section (positional wire form)
    pub merges: Vec<StationMergeWire>,
    /// Loop closures referencing the section (positional wire form)
    pub closures: Vec<LoopClosureWire>,
    /// Whether the section has a section offset
    pub has_section_offset: bool,
    /// Number of station offsets referencing the section
    pub station_offset_count: usize,
    /// Number of zero datums referencing the section
    pub zero_datum_count: usize,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, TS)]
pub struct StationPair {
    pub station_a: StationRef,
    pub station_b: StationRef,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, TS)]
pub struct ClosurePair {
    pub closure_id: u64,
    pub station_a: StationRef,
    pub station_b: StationRef,
}

#[derive(Debug, Clone, Copy)]
enum PathEdge {
    Shot {
        section_id: SectionId,
        shot_index: usize,
        forward: bool,
    },
    Merge,
}

#[derive(Debug, Clone, Copy)]
struct PathStep {
    to: StationRef,
    edge: PathEdge,
}

#[derive(Debug, Clone)]
struct StationPath {
    start: StationRef,
    steps: Vec<PathStep>,
}

#[derive(Debug, Clone, Copy)]
struct SegmentShot {
    section_id: SectionId,
    shot_index: usize,
    forward: bool,
    length: f64,
    path_vec: Coordinates,
    sign: f64,
}

#[derive(Debug, Clone, Copy)]
struct HeapItem {
    cost: f64,
    node: StationRef,
}

impl Eq for HeapItem {}

impl PartialEq for HeapItem {
    fn eq(&self, other: &Self) -> bool {
        self.cost == other.cost
    }
}

impl Ord for HeapItem {
    fn cmp(&self, other: &Self) -> Ordering {
        // Reverse for min-heap; treat NaN as equal (should not occur).
        other
            .cost
            .partial_cmp(&self.cost)
            .unwrap_or(Ordering::Equal)
    }
}

impl PartialOrd for HeapItem {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, TS)]
pub struct ClosureUpdate {
    pub closure_id: u64,
    pub old_station: StationRef,
    pub new_station: StationRef,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct DeleteShotImpact {
    pub removed_station: StationRef,
    pub removed_merges: Vec<StationPair>,
    pub removed_closures: Vec<ClosurePair>,
    pub replacement_merges: Vec<StationPair>,
    pub replacement_closure_updates: Vec<ClosureUpdate>,
    /// Closures broken by the deletion: the surviving endpoints are no longer
    /// connected through the survey, so the closure is replaced by a plain
    /// station merge instead of being kept as a (false) loop. See issue #8.
    #[serde(default)]
    pub closure_to_merge: Vec<StationPair>,
    pub merge_rewire_skipped: bool,
    pub closure_rewire_skipped: bool,
    #[serde(default)]
    pub shift_blocked: bool,
    #[serde(default)]
    pub shift_blocked_reasons: Vec<String>,
}

/// Which structural case a contiguous shot-range deletion falls into. Computed
/// from the range endpoints relative to the section's shot count.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum RangeDeleteKind {
    /// The range covers every shot — the whole section is removed.
    WholeSection,
    /// The range starts at the first shot (nothing before); the survivors keep
    /// their absolute position by an offset shift.
    Prefix,
    /// The range ends at the last shot (nothing after); the head is truncated.
    Suffix,
    /// Shots remain both before and after — the section can be split (A=before,
    /// B=after) or gap-closed (shift).
    Interior,
}

/// Aggregate impact of deleting a contiguous range of shots `[start_pos..=end_pos]`
/// from one section. The merge/closure fields mirror [`DeleteShotImpact`] (so the
/// frontend can render them with the same component); `kind` drives the dialog
/// routing and `shift_blocked` reports whether the gap-close path is available.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct DeleteShotRangeImpact {
    pub section_id: SectionId,
    pub start_pos: u32,
    pub end_pos: u32,
    pub kind: RangeDeleteKind,
    /// Stations any offered action removes. For an interior range this is the
    /// gap-close (shift) set `(start_pos+1 ..= end_pos+1)` — the superset that
    /// also covers the split's interior set — so the relationship panel never
    /// hides what closing the gap touches. (Prefix/suffix/whole remove exactly
    /// the gap-close set; only an interior split keeps the boundary `end_pos+1`.)
    pub removed_stations: Vec<StationRef>,
    pub removed_merges: Vec<StationPair>,
    pub removed_closures: Vec<ClosurePair>,
    pub replacement_merges: Vec<StationPair>,
    pub replacement_closure_updates: Vec<ClosureUpdate>,
    #[serde(default)]
    pub closure_to_merge: Vec<StationPair>,
    pub merge_rewire_skipped: bool,
    pub closure_rewire_skipped: bool,
    /// True when the gap-close (shift) path is unavailable for this range (the
    /// two sides are already connected or both anchored, or the gap-close drops
    /// a zero datum).
    #[serde(default)]
    pub shift_blocked: bool,
    #[serde(default)]
    pub shift_blocked_reasons: Vec<String>,
    /// Zero datums the SPLIT would drop (anchored on a strictly-interior station
    /// the split removes) — surfaced so the dialog can warn. The gap-close path
    /// is instead blocked when it would drop a datum, so this set is split-only.
    #[serde(default)]
    pub removed_datums: Vec<StationRef>,
    /// Station comments the SPLIT would drop (anchored on a strictly-interior
    /// station the split removes) — surfaced so the dialog can warn before the
    /// annotation disappears.
    #[serde(default)]
    pub removed_comments: Vec<StationRef>,
}

/// A complete cave survey project
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct Project {
    /// Project name (typically cave system name)
    pub name: String,
    /// Optional location description
    pub location: Option<String>,
    /// Creation timestamp
    #[ts(type = "string")]
    pub created_at: DateTime<Utc>,
    /// Last modification timestamp
    #[ts(type = "string")]
    pub modified_at: DateTime<Utc>,
    /// All sections in this project
    pub sections: Vec<Section>,
    /// Station merges. Stored with position-independent [`StationKey`] endpoints;
    /// the TS/frontend shape is the positional wire form (resolved at IPC encode).
    #[ts(type = "Array<StationMerge>")]
    pub station_merges: Vec<StationMerge>,
    /// Zero datums
    #[ts(type = "Array<ZeroDatum>")]
    pub zero_datums: Vec<ZeroDatum>,
    /// Detected loop closures
    #[serde(default)]
    #[ts(type = "Array<LoopClosure>")]
    pub loop_closures: Vec<LoopClosure>,
    /// File path if saved (None for new unsaved projects)
    #[ts(type = "string | null")]
    pub file_path: Option<PathBuf>,
    /// Next section ID to assign
    pub next_section_id: SectionId,
    /// Section offsets (x, y) applied when sections are merged/aligned
    #[serde(default)]
    pub section_offsets: HashMap<SectionId, (f64, f64)>,
    /// Station offsets (x, y, z) applied when individual stations are moved
    #[serde(
        default,
        serialize_with = "serialize_station_offsets",
        deserialize_with = "deserialize_station_offsets"
    )]
    #[ts(skip)]
    pub station_offsets: HashMap<StationKey, (f64, f64, f64)>,
    /// Station comments keyed by StationRef
    #[serde(
        default,
        serialize_with = "serialize_station_comments",
        deserialize_with = "deserialize_station_comments"
    )]
    #[ts(skip)]
    pub station_comments: HashMap<StationKey, String>,
    /// SHA256 hashes of imported DMP files (for duplicate detection)
    #[serde(default)]
    pub imported_file_hashes: Vec<String>,
    /// Content hashes of imported DMP sections (for section-level duplicate detection)
    #[serde(default)]
    pub imported_section_hashes: Vec<String>,
    /// Monotonic counter for closure IDs. Never reused, even after deletions.
    #[serde(default)]
    pub next_closure_id: u64,
    /// Collaboration mode state (sibling .tml linkage + baseline). None when off.
    #[serde(default)]
    pub collab: Option<CollabState>,

    /// Per-project validation thresholds (#57). Stored in the `.stalx` so they
    /// travel with the file between collaborators. New projects are seeded from
    /// the global config (the "defaults for new projects"); thereafter this is
    /// authoritative. Defaults on legacy projects until populated on load.
    #[serde(default)]
    pub validation: crate::config::ValidationConfig,

    /// Transient flag (NOT persisted) — when true,
    /// [`Self::cascade_connection_offsets`] returns immediately. Used by
    /// batch importers to skip the per-call O(N) cascade and run a
    /// single cascade after all sections / merges are in place. Callers
    /// must set the flag, run their batch, clear the flag, and then
    /// invoke `cascade_connection_offsets` themselves to leave the
    /// project in a consistent state.
    #[serde(skip, default)]
    #[ts(skip)]
    pub cascade_deferred: bool,

    /// Section-id → `sections[i]` index cache (transient, NOT persisted).
    /// Lookups via [`Self::get_section`] / [`Self::get_section_mut`]
    /// consult this map first to avoid the O(N) linear scan that used to
    /// dominate `merge_stations` and `compute_station_raw_coords` on
    /// large imports (~4 lookups per merge × 14 k merges = ~400 M ops).
    /// Maintained incrementally by `add_section` / `remove_section`.
    /// After deserialization the map is empty and a linear fallback
    /// kicks in — callers that hammer the lookup (e.g. the batch
    /// importer) should call [`Self::rebuild_section_index`] first.
    #[serde(skip, default)]
    #[ts(skip)]
    pub section_index_cache: HashMap<SectionId, usize>,

    /// Merge-only section adjacency cache: section_id → [neighbor section
    /// ids via station_merges]. Transient, NOT persisted. Maintained
    /// incrementally by `add_station_merge` / `remove_station_merge`;
    /// any structural mutation outside those entry points is expected
    /// to call `rebuild_merge_adjacency`. The cache exists to turn the
    /// per-BFS-step iteration over all `station_merges` (O(N) inner)
    /// into a HashMap lookup (O(1) inner). For a tree-shape import that
    /// converts `get_merged_section_ids` from O(N²) to O(N) per call.
    #[serde(skip, default)]
    #[ts(skip)]
    pub merge_adjacency_cache: HashMap<SectionId, Vec<SectionId>>,
}

/// Project metadata for listing
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct ProjectMetadata {
    pub name: String,
    pub location: Option<String>,
    #[ts(type = "string")]
    pub file_path: PathBuf,
    #[ts(type = "string")]
    pub modified_at: DateTime<Utc>,
    pub section_count: usize,
    pub total_length: f64,
    /// Number of stations in the project (shots + 1 per section)
    pub station_count: usize,
    /// GPS center from first zero datum (lng, lat) - MapLibre order
    pub gps_center: Option<(f64, f64)>,
    /// GPS bounds including all zero datums
    pub gps_bounds: Option<GpsBounds>,
    /// Whether Ariane collaboration mode is enabled for this project. Lets the
    /// recent-projects panel show/toggle the state without opening the project.
    pub collab_enabled: bool,
}

/// Per-station along-cave distance field from a chosen origin (or the zero-datum
/// entrance default). `distances[i]` corresponds to `station_refs[i]`; `None`
/// marks an unreachable station (JSON can't carry infinity). `max_reachable` is
/// the largest finite distance (0.0 if nothing is reachable), for auto-scaling
/// the gradient legend. Backs the distance-gradient overlay (#34); reuses the
/// shared reachability graph (jumps in, references out — see `build_survey_graph`).
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct DistanceField {
    pub distances: Vec<Option<f64>>,
    pub station_refs: Vec<StationRef>,
    pub max_reachable: f64,
}

/// One end of a ruler measurement (#26): either a **station** (set
/// `station_index`; leave `shot_id`/`t` null) or an exact **point on a shot** at
/// fraction `t` ∈ [0,1] from the shot's from-station toward its to-station (set
/// `shot_id` + `t`). `t` ≈ 0 / ≈ 1 collapses to the from/to station.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, TS)]
pub struct RulerEndpoint {
    pub section_id: SectionId,
    #[serde(default)]
    pub station_index: Option<u32>,
    #[serde(default)]
    pub shot_id: Option<ShotId>,
    #[serde(default)]
    pub t: Option<f64>,
}

/// A shot on the along-line path, identified for tinting.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct PathShot {
    pub section_id: SectionId,
    pub shot_id: ShotId,
}

/// Result of an along-cave-line ruler query (#26). `along_line` is `None` when the
/// two endpoints lie in different connected components (no path). `path_shots`
/// are the shots traversed from A toward B — whole shots, even when an endpoint
/// only partially crosses one — with zero-cost merge/closure ties skipped (they
/// aren't shots and must not be tinted). Uses the same shots+merges+closures
/// graph as the distance-gradient overlay (#34), so it matches the Display
/// "line distance" view.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct AlongLineResult {
    pub along_line: Option<f64>,
    pub path_shots: Vec<PathShot>,
    /// Stations traversed along the path (the chain nodes), in order from A toward
    /// B. Shot-point endpoints contribute their adjacent stations but not a
    /// station of their own. Tinted alongside `path_shots`.
    pub path_stations: Vec<StationRef>,
}

/// Overall project statistics
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct ProjectStats {
    pub section_count: usize,
    pub shot_count: usize,
    pub total_length: f64,
    pub min_depth: f64,
    pub max_depth: f64,
    pub station_count: usize,
    pub loop_count: usize,
    /// Maximum straight-line distance from zero datum to any station
    pub penetration_distance: f64,
}

/// Serialize station_offsets as a Vec of (StationRef, (f64, f64, f64)) tuples
/// to avoid serde_json's requirement that map keys be strings.
fn serialize_station_offsets<S: serde::Serializer>(
    map: &HashMap<StationKey, (f64, f64, f64)>,
    serializer: S,
) -> Result<S::Ok, S::Error> {
    let entries: Vec<(&StationKey, &(f64, f64, f64))> = map.iter().collect();
    entries.serialize(serializer)
}

/// Deserialize station_offsets from a Vec of (StationRef, (f64, f64, f64)) tuples.
fn deserialize_station_offsets<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<HashMap<StationKey, (f64, f64, f64)>, D::Error> {
    let entries: Vec<(StationKey, (f64, f64, f64))> = Vec::deserialize(deserializer)?;
    Ok(entries.into_iter().collect())
}

/// Serialize station_comments as a Vec of (StationRef, String) tuples.
fn serialize_station_comments<S: serde::Serializer>(
    map: &HashMap<StationKey, String>,
    serializer: S,
) -> Result<S::Ok, S::Error> {
    let entries: Vec<(&StationKey, &String)> = map.iter().collect();
    entries.serialize(serializer)
}

/// Deserialize station_comments from a Vec of (StationRef, String) tuples.
fn deserialize_station_comments<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<HashMap<StationKey, String>, D::Error> {
    let entries: Vec<(StationKey, String)> = Vec::deserialize(deserializer)?;
    Ok(entries.into_iter().collect())
}

/// IPC serialization view of [`Project`]. The stored `Project` keeps its
/// `StationKey`-based serde (lossless, required by the undo snapshot path), but
/// the frontend and the ts-rs `Project` type expect the three cross-reference
/// collections in positional wire form (`StationRef { section_id, station_index }`).
/// This wrapper forwards every ts-exported field and re-encodes those three to
/// wire, dropping dangling refs (the same resolution the binary load path's
/// `ProjectHeaderBinary` does). `#[ts(skip)]` fields on `Project` — the
/// `StationKey`-keyed `station_offsets`/`station_comments` and the transient
/// caches — are intentionally omitted to match the generated `Project` TS type.
struct ProjectIpc<'a>(&'a Project);

impl Serialize for ProjectIpc<'_> {
    fn serialize<S: serde::ser::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        use serde::ser::SerializeStruct;
        let p = self.0;
        let station_merges: Vec<_> = p
            .station_merges
            .iter()
            .filter_map(|m| p.merge_to_wire(m))
            .collect();
        let zero_datums: Vec<_> = p
            .zero_datums
            .iter()
            .filter_map(|z| p.datum_to_wire(z))
            .collect();
        let loop_closures: Vec<_> = p
            .loop_closures
            .iter()
            .filter_map(|c| p.closure_to_wire(c))
            .collect();
        // Field set + order MUST stay in lockstep with the generated Project.ts
        // (16 ts-exported fields). Adding a ts-exported field to `Project`
        // requires adding it here too, or it silently drops off the IPC payload.
        let mut st = serializer.serialize_struct("Project", 16)?;
        st.serialize_field("name", &p.name)?;
        st.serialize_field("location", &p.location)?;
        st.serialize_field("created_at", &p.created_at)?;
        st.serialize_field("modified_at", &p.modified_at)?;
        st.serialize_field("sections", &p.sections)?;
        st.serialize_field("station_merges", &station_merges)?;
        st.serialize_field("zero_datums", &zero_datums)?;
        st.serialize_field("loop_closures", &loop_closures)?;
        st.serialize_field("file_path", &p.file_path)?;
        st.serialize_field("next_section_id", &p.next_section_id)?;
        st.serialize_field("section_offsets", &p.section_offsets)?;
        st.serialize_field("imported_file_hashes", &p.imported_file_hashes)?;
        st.serialize_field("imported_section_hashes", &p.imported_section_hashes)?;
        st.serialize_field("next_closure_id", &p.next_closure_id)?;
        st.serialize_field("collab", &p.collab)?;
        st.serialize_field("validation", &p.validation)?;
        st.end()
    }
}

/// `#[serde(serialize_with = "...")]` target for every IPC struct that carries a
/// `Project` to the frontend (`ProjectState`, `LoadProjectFullResult`,
/// `CreateProjectFullResult`), so they all emit the positional wire shape the
/// frontend reads rather than the internal `StationKey` shape derived serde emits.
pub(crate) fn serialize_project_ipc<S: serde::ser::Serializer>(
    p: &Project,
    s: S,
) -> Result<S::Ok, S::Error> {
    Serialize::serialize(&ProjectIpc(p), s)
}

impl Project {
    /// Create a new empty project
    pub fn new(name: String, location: Option<String>) -> Self {
        let now = Utc::now();
        Self {
            name,
            location,
            created_at: now,
            modified_at: now,
            sections: Vec::new(),
            station_merges: Vec::new(),
            zero_datums: Vec::new(),
            loop_closures: Vec::new(),
            file_path: None,
            next_section_id: 0,
            section_offsets: HashMap::new(),
            station_offsets: HashMap::new(),
            station_comments: HashMap::new(),
            imported_file_hashes: Vec::new(),
            imported_section_hashes: Vec::new(),
            next_closure_id: 1,
            collab: None,
            validation: crate::config::ValidationConfig::default(),
            cascade_deferred: false,
            section_index_cache: HashMap::new(),
            merge_adjacency_cache: HashMap::new(),
        }
    }

    /// Assign sequential IDs to any loop closures that have id=0 (legacy projects).
    /// Updates `next_closure_id` to be greater than all existing IDs.
    pub fn assign_closure_ids(&mut self) {
        // First, ensure next_closure_id is at least max(existing) + 1
        let max_id = self.loop_closures.iter().map(|lc| lc.id).max().unwrap_or(0);
        if self.next_closure_id <= max_id {
            self.next_closure_id = max_id + 1;
        }
        // Assign IDs to any closures with id=0
        for lc in &mut self.loop_closures {
            if lc.id == 0 {
                lc.id = self.next_closure_id;
                self.next_closure_id += 1;
            }
            if lc.strategy == ClosureStrategy::Move {
                lc.is_aligned = true;
            }
        }
    }

    /// Mark the project as modified
    pub fn touch(&mut self) {
        self.modified_at = Utc::now();
    }

    // === Section operations ===

    /// Add a new section to the project
    pub fn add_section(&mut self, data: SectionData) -> &Section {
        let section = Section::new(self.next_section_id, data);
        self.next_section_id += 1;
        let new_idx = self.sections.len();
        self.section_index_cache.insert(section.id, new_idx);
        self.sections.push(section);
        self.touch();
        &self.sections[new_idx]
    }

    /// Get a section by ID. First tries the O(1) `section_index_cache`;
    /// if the cache is stale or empty (e.g. after deserialization), falls
    /// back to an O(N) linear scan so we never return a wrong answer.
    pub fn get_section(&self, section_id: SectionId) -> Option<&Section> {
        if let Some(&i) = self.section_index_cache.get(&section_id) {
            if let Some(s) = self.sections.get(i) {
                if s.id == section_id {
                    return Some(s);
                }
            }
        }
        self.sections.iter().find(|s| s.id == section_id)
    }

    /// Get a mutable reference to a section by ID. Same cache + fallback
    /// strategy as [`Self::get_section`].
    pub fn get_section_mut(&mut self, section_id: SectionId) -> Option<&mut Section> {
        let i = self.section_index_cache.get(&section_id).copied();
        if let Some(i) = i {
            if let Some(s) = self.sections.get(i) {
                if s.id == section_id {
                    return self.sections.get_mut(i);
                }
            }
        }
        self.sections.iter_mut().find(|s| s.id == section_id)
    }

    /// Update a section's metadata
    pub fn update_section(
        &mut self,
        section_id: SectionId,
        updates: &SectionUpdates,
    ) -> Option<&Section> {
        let section = self.get_section_mut(section_id)?;
        section.apply_updates(updates);
        self.touch();
        self.get_section(section_id)
    }

    /// Remove a section by ID
    pub fn remove_section(&mut self, section_id: SectionId) -> Option<Section> {
        let pos = self.sections.iter().position(|s| s.id == section_id)?;
        // Removing shifts every later section's index down by one — rather
        // than touching N cache entries, we drop the cache and let the
        // linear fallback rebuild it on demand (removes are rare relative
        // to lookups). Callers running a batch can call
        // `rebuild_section_index()` to restore O(1) lookups afterwards.
        self.section_index_cache.clear();
        self.touch();
        Some(self.sections.remove(pos))
    }

    /// Mint v4 UUIDs for any shot whose `uuid` field is `None` and write
    /// them back into the in-memory project.
    ///
    /// The save flow needs this before either the SQLite INSERT or the
    /// TML export runs.  Without it, pre-v6 .stalx files loaded today
    /// have `Shot::uuid = None` everywhere; the SQLite INSERT path
    /// mints fresh UUIDs at write time but does NOT update the in-memory
    /// shot, so a subsequent `export_tml_with_baseline` call in the
    /// SAME save sees the shots still as `uuid: None` and mints a
    /// SECOND, different set of UUIDs for the .tml.  The DB and the
    /// sibling .tml then disagree on every shot's identity until the
    /// next reload, breaking the collaboration round-trip.  Calling
    /// this once at the top of `save_project` guarantees both sides
    /// receive the same UUIDs.
    pub fn ensure_shot_uuids(&mut self) {
        for section in &mut self.sections {
            for shot in &mut section.shots {
                if shot.uuid.as_deref().map_or(true, str::is_empty) {
                    shot.uuid = Some(uuid::Uuid::new_v4().to_string());
                }
            }
        }
    }

    /// Re-mint the UUID of any shot that shares a UUID with an earlier shot in
    /// the SAME section, keeping the first occurrence (AfterShot anchors resolve
    /// to the first match via `position()`, so they stay valid). Returns the
    /// number re-minted. Restores the per-section uniqueness `resolve_key` relies
    /// on; the companion detection lives in [`check_structural_integrity`].
    /// Empty UUIDs are left for [`ensure_shot_uuids`].
    pub fn ensure_unique_shot_uuids(&mut self) -> usize {
        let mut reminted = 0;
        for section in &mut self.sections {
            let mut seen: HashSet<String> = HashSet::new();
            for shot in &mut section.shots {
                let Some(u) = shot.uuid.clone() else { continue };
                if u.is_empty() {
                    continue;
                }
                // insert() == false means this UUID already appeared in-section.
                if !seen.insert(u) {
                    let fresh = uuid::Uuid::new_v4().to_string();
                    seen.insert(fresh.clone());
                    shot.uuid = Some(fresh);
                    reminted += 1;
                }
            }
        }
        if reminted > 0 {
            self.touch();
        }
        reminted
    }

    /// Map every shot that has a UUID to its `(section_id, shot_id)` position.
    /// Shared by both load entry points (`open_project` and
    /// `do_load_project_full`) to feed `backfill_resolved_warning_uuids`, so the
    /// two sites can't diverge. Shots with no UUID are skipped — call
    /// [`ensure_shot_uuids`] first if every shot must be represented.
    pub fn shot_uuid_by_position(&self) -> HashMap<(u32, u32), String> {
        self.sections
            .iter()
            .flat_map(|s| {
                s.shots
                    .iter()
                    .filter_map(move |sh| sh.uuid.clone().map(|u| ((s.id, sh.id), u)))
            })
            .collect()
    }

    /// Rebuild the section-id → index cache from the current `sections`
    /// vector. Cheap (O(N)) and safe to call any time; call this after a
    /// bulk mutation (e.g. snapshot rollback) or before a hot lookup loop
    /// when you can't guarantee the cache is current.
    pub fn rebuild_section_index(&mut self) {
        self.section_index_cache.clear();
        self.section_index_cache.reserve(self.sections.len());
        for (i, s) in self.sections.iter().enumerate() {
            self.section_index_cache.insert(s.id, i);
        }
    }

    /// Rebuild the merge-only section adjacency cache from
    /// `station_merges`. O(N) where N is the merge count. Required
    /// after any path that mutates `station_merges` outside the
    /// `record_station_merge` / `remove_station_merges_matching`
    /// helpers (e.g. a serde-deserialised project, or a snapshot
    /// rollback).
    pub fn rebuild_merge_adjacency(&mut self) {
        self.merge_adjacency_cache.clear();
        // Each merge contributes one entry in each direction.
        self.merge_adjacency_cache.reserve(self.sections.len());
        for m in &self.station_merges {
            self.merge_adjacency_cache
                .entry(m.station_a.section_id)
                .or_default()
                .push(m.station_b.section_id);
            self.merge_adjacency_cache
                .entry(m.station_b.section_id)
                .or_default()
                .push(m.station_a.section_id);
        }
    }

    /// Push a new merge AND incrementally update the adjacency cache.
    /// Always use this instead of writing to `station_merges` directly
    /// so the cache stays in sync.
    pub(crate) fn record_station_merge(&mut self, merge: StationMerge) {
        // Guard against the half-populated-cache trap: `delete_section` /
        // `delete_shot` clear `merge_adjacency_cache` after retaining
        // surviving merges in `station_merges`, leaving the cache empty
        // and the merges intact.  If we then incrementally insert just
        // this new merge, the cache becomes non-empty but only contains
        // THIS edge — and `get_merged_section_ids` treats any non-empty
        // cache as authoritative, silently ignoring every surviving
        // merge from before the delete.  Rebuild from `station_merges`
        // first when the cache is empty but merges exist so the
        // incremental insert lands on a whole base.
        if self.merge_adjacency_cache.is_empty() && !self.station_merges.is_empty() {
            self.rebuild_merge_adjacency();
        }
        self.merge_adjacency_cache
            .entry(merge.station_a.section_id)
            .or_default()
            .push(merge.station_b.section_id);
        self.merge_adjacency_cache
            .entry(merge.station_b.section_id)
            .or_default()
            .push(merge.station_a.section_id);
        self.station_merges.push(merge);
    }

    /// Compute the (dx, dy) horizontal displacement of a shot from its data.
    /// Uses the same average azimuth calculation as coordinate computation.
    pub(crate) fn shot_displacement(data: &ShotData) -> (f64, f64) {
        let diff = (data.azimuth_out - data.azimuth_in + 540.0) % 360.0 - 180.0;
        let avg_az = (data.azimuth_in + diff / 2.0 + 360.0) % 360.0;
        let az_rad = avg_az.to_radians();
        let horizontal = data.horizontal_length();
        (horizontal * az_rad.sin(), horizontal * az_rad.cos())
    }

    // === Section offset helpers ===

    /// Shift all StationRef indices in the project for the given section.
    ///
    /// All station references where `section_id` matches AND `station_index >= from_index`
    /// have their `station_index` shifted by `delta`. This is needed when inserting or
    /// removing shots, which changes station indices for all subsequent stations.
    ///
    /// Affects: station_merges, loop_closures, zero_datums, station_offsets,
    /// station_comments — all routed through [`Self::map_station_refs`].
    /// THE single enumeration of every [`StationKey`]-bearing collection on the
    /// project, for READ access. `check_structural_integrity` and
    /// `reanchor_station_refs` consume this so a newly-added ref-bearing collection
    /// can't be silently missed; the `label` distinguishes categories.
    pub(crate) fn for_each_station_ref(&self, mut f: impl FnMut(&str, StationKey)) {
        for m in &self.station_merges {
            f("merge", m.station_a.clone());
            f("merge", m.station_b.clone());
        }
        for c in &self.loop_closures {
            f("loop closure", c.station_a.clone());
            f("loop closure", c.station_b.clone());
        }
        for zd in &self.zero_datums {
            f("zero datum", zd.station_ref.clone());
        }
        for k in self.station_offsets.keys() {
            f("station offset", k.clone());
        }
        for k in self.station_comments.keys() {
            f("station comment", k.clone());
        }
    }

    /// THE single enumeration for REWRITING every [`StationKey`]-bearing collection
    /// (rewrite twin of [`Self::for_each_station_ref`]). Vec fields mapped in place;
    /// the offset/comment HashMaps rebuilt with transformed keys. Used by
    /// [`Self::reanchor_station_refs`]. (Keys are position-independent, so
    /// insert/delete no longer rewrite them — `shift_station_refs` is gone.)
    pub(crate) fn map_station_refs(&mut self, mut f: impl FnMut(StationKey) -> StationKey) {
        for m in &mut self.station_merges {
            m.station_a = f(m.station_a.clone());
            m.station_b = f(m.station_b.clone());
        }
        for c in &mut self.loop_closures {
            c.station_a = f(c.station_a.clone());
            c.station_b = f(c.station_b.clone());
        }
        for zd in &mut self.zero_datums {
            zd.station_ref = f(zd.station_ref.clone());
        }
        let offsets = std::mem::take(&mut self.station_offsets);
        self.station_offsets = offsets.into_iter().map(|(k, v)| (f(k), v)).collect();
        let comments = std::mem::take(&mut self.station_comments);
        self.station_comments = comments.into_iter().map(|(k, v)| (f(k), v)).collect();
    }

    fn station_ref_key(station_ref: &StationRef) -> (SectionId, u32) {
        (station_ref.section_id, station_ref.station_index)
    }

    fn has_direct_merge(&self, a: StationRef, b: StationRef) -> bool {
        self.station_merges.iter().any(|m| {
            (self.key_is_ref(&m.station_a, a) && self.key_is_ref(&m.station_b, b))
                || (self.key_is_ref(&m.station_a, b) && self.key_is_ref(&m.station_b, a))
        })
    }

    fn get_merge_group(&self, station_ref: StationRef) -> HashSet<StationRef> {
        let mut visited = HashSet::new();
        let mut queue = VecDeque::new();
        visited.insert(station_ref);
        queue.push_back(station_ref);

        while let Some(current) = queue.pop_front() {
            for merge in &self.station_merges {
                // Compare/resolve through the stored keys (never positional ==).
                let neighbor = if self.key_is_ref(&merge.station_a, current) {
                    self.resolve_key(&merge.station_b)
                } else if self.key_is_ref(&merge.station_b, current) {
                    self.resolve_key(&merge.station_a)
                } else {
                    None
                };
                if let Some(next) = neighbor {
                    if visited.insert(next) {
                        queue.push_back(next);
                    }
                }
            }
        }

        visited
    }

    fn build_merge_components(
        &self,
        stations: &HashSet<StationRef>,
        removed_station: StationRef,
    ) -> Vec<Vec<StationRef>> {
        let mut adjacency: HashMap<StationRef, Vec<StationRef>> = HashMap::new();
        for station in stations {
            adjacency.entry(*station).or_default();
        }

        for merge in &self.station_merges {
            let (Some(a), Some(b)) = (
                self.resolve_key(&merge.station_a),
                self.resolve_key(&merge.station_b),
            ) else {
                continue;
            };
            if a == removed_station || b == removed_station {
                continue;
            }
            if stations.contains(&a) && stations.contains(&b) {
                adjacency.entry(a).or_default().push(b);
                adjacency.entry(b).or_default().push(a);
            }
        }

        let mut components = Vec::new();
        let mut visited = HashSet::new();

        let mut station_list: Vec<StationRef> = stations.iter().copied().collect();
        station_list.sort_by_key(Self::station_ref_key);

        for station in station_list {
            if visited.contains(&station) {
                continue;
            }
            let mut component = Vec::new();
            let mut queue = VecDeque::new();
            visited.insert(station);
            queue.push_back(station);

            while let Some(current) = queue.pop_front() {
                component.push(current);
                if let Some(neighbors) = adjacency.get(&current) {
                    for neighbor in neighbors {
                        if visited.insert(*neighbor) {
                            queue.push_back(*neighbor);
                        }
                    }
                }
            }

            component.sort_by_key(Self::station_ref_key);
            components.push(component);
        }

        components
    }

    // === Shot operations ===

    // === Station operations ===

    /// Get all stations colocated with the given station (via merges and aligned closures).
    ///
    /// Returns a vec including the station itself plus all merge/closure partners,
    /// transitively connected.
    fn get_colocated_stations(&self, station_ref: StationRef) -> Vec<StationRef> {
        let mut group = vec![station_ref];
        let mut visited = HashSet::new();
        visited.insert(station_ref);
        let mut queue = VecDeque::new();
        queue.push_back(station_ref);

        while let Some(current) = queue.pop_front() {
            // Check merges
            for merge in &self.station_merges {
                let partner = if self.key_is_ref(&merge.station_a, current) {
                    self.resolve_key(&merge.station_b)
                } else if self.key_is_ref(&merge.station_b, current) {
                    self.resolve_key(&merge.station_a)
                } else {
                    None
                };
                if let Some(p) = partner {
                    if visited.insert(p) {
                        group.push(p);
                        queue.push_back(p);
                    }
                }
            }
            // Check aligned closures
            for closure in &self.loop_closures {
                if !closure.is_aligned {
                    continue;
                }
                let partner = if self.key_is_ref(&closure.station_a, current) {
                    self.resolve_key(&closure.station_b)
                } else if self.key_is_ref(&closure.station_b, current) {
                    self.resolve_key(&closure.station_a)
                } else {
                    None
                };
                if let Some(p) = partner {
                    if visited.insert(p) {
                        group.push(p);
                        queue.push_back(p);
                    }
                }
            }
        }

        group
    }

    /// Compute a station's absolute depth from the average of surrounding shot depths.
    ///
    /// For a station and its colocated group (merge + aligned closure partners),
    /// collects depth measurements from:
    /// - **Incoming shot** (shot at index `station_index - 1`): use `depth_out`
    /// - **Outgoing shot** (shot at index `station_index`): use `depth_in`
    ///
    /// Returns the average of all collected measurements, or 0.0 if none exist.
    fn compute_station_depth(&self, colocated: &[StationRef]) -> f64 {
        let mut depths: Vec<f64> = Vec::new();

        for &sr in colocated {
            // O(1) cache lookup; legacy linear scan was the hot path —
            // 79 k groups × O(N sections) per `compute_station_coordinates`
            // call dominated load time for large projects.
            if let Some(section) = self.get_section(sr.section_id) {
                let idx = sr.station_index as usize;

                // Incoming shot: shot at index station_index - 1 → use depth_out
                if idx > 0 && idx - 1 < section.shots.len() {
                    depths.push(section.shots[idx - 1].depth_out);
                }

                // Outgoing shot: shot at index station_index → use depth_in
                if idx < section.shots.len() {
                    depths.push(section.shots[idx].depth_in);
                }
            }
        }

        if depths.is_empty() {
            0.0
        } else {
            depths.iter().sum::<f64>() / depths.len() as f64
        }
    }

    /// Compute raw station coordinates for a single station (without global zero datum offset)
    pub(crate) fn compute_station_raw_coords(
        &self,
        station_ref: StationRef,
    ) -> Option<Coordinates> {
        let section = self.get_section(station_ref.section_id)?;

        // Get section offset
        let (offset_x, offset_y) = self
            .section_offsets
            .get(&section.id)
            .copied()
            .unwrap_or((0.0, 0.0));
        let mut coords = Coordinates::new(offset_x, offset_y, 0.0);

        // Walk through shots to reach the station (X, Y only)
        for i in 0..station_ref.station_index as usize {
            if i >= section.shots.len() {
                return None;
            }
            let shot = &section.shots[i];
            let azimuth_rad = shot.average_azimuth().to_radians();
            let horizontal = shot.horizontal_length();
            let dx = horizontal * azimuth_rad.sin();
            let dy = horizontal * azimuth_rad.cos();
            coords.x += dx;
            coords.y += dy;
        }

        // Z = absolute depth from averaged surrounding shots
        let colocated = self.get_colocated_stations(station_ref);
        coords.z = self.compute_station_depth(&colocated);

        // Apply station offset if exists (individual station move)
        if let Some((ox, oy, oz)) = self.station_offset_for_ref(station_ref) {
            coords.x += ox;
            coords.y += oy;
            coords.z += oz;
        }

        Some(coords)
    }

    /// Calculate the path length between two stations through shots, merges, and closures.
    /// Both merges and closures are zero-distance edges.
    pub(crate) fn calculate_path_length_between(
        &self,
        station_a: StationRef,
        station_b: StationRef,
    ) -> f64 {
        self.calculate_path_length_impl(station_a, station_b, true)
    }

    /// Calculate path length through shots and merges only (no closures).
    /// Use this when only rigid-group survey path length is needed.
    #[cfg(test)]
    pub(crate) fn calculate_merge_only_path_length(
        &self,
        station_a: StationRef,
        station_b: StationRef,
    ) -> f64 {
        self.calculate_path_length_impl(station_a, station_b, false)
    }

    /// Internal Dijkstra path length implementation.
    /// When `include_closures` is true, loop closures are treated as zero-distance edges.
    fn calculate_path_length_impl(
        &self,
        station_a: StationRef,
        station_b: StationRef,
        include_closures: bool,
    ) -> f64 {
        if !self.station_exists(station_a) || !self.station_exists(station_b) {
            return 0.0;
        }

        let section_lookup = self.build_section_lookup();
        let merge_adj = self.build_merge_adjacency(&section_lookup);

        let mut closure_adj: HashMap<StationRef, Vec<StationRef>> = HashMap::new();
        if include_closures {
            for closure in &self.loop_closures {
                let (Some(a), Some(b)) = (
                    self.resolve_key(&closure.station_a),
                    self.resolve_key(&closure.station_b),
                ) else {
                    continue;
                };
                closure_adj.entry(a).or_default().push(b);
                closure_adj.entry(b).or_default().push(a);
            }
        }

        let mut dist: HashMap<StationRef, f64> = HashMap::new();
        let mut heap = BinaryHeap::new();
        dist.insert(station_a, 0.0);
        heap.push(HeapItem {
            cost: 0.0,
            node: station_a,
        });

        while let Some(HeapItem { cost, node }) = heap.pop() {
            if let Some(&known) = dist.get(&node) {
                if cost > known + 1e-9 {
                    continue;
                }
            }

            if node == station_b {
                return cost;
            }

            let Some(section) = section_lookup.get(&node.section_id) else {
                continue;
            };

            // Previous station (shot index = station_index - 1)
            if node.station_index > 0 {
                let prev_index = node.station_index - 1;
                if (prev_index as usize) <= section.shots.len() {
                    let shot_len = section
                        .shots
                        .get(prev_index as usize)
                        .map_or(0.0, |s| s.length.max(0.0));
                    let neighbor = StationRef::new(node.section_id, prev_index);
                    let next_cost = cost + shot_len;
                    if dist.get(&neighbor).is_none_or(|&d| next_cost < d - 1e-9) {
                        dist.insert(neighbor, next_cost);
                        heap.push(HeapItem {
                            cost: next_cost,
                            node: neighbor,
                        });
                    }
                }
            }

            // Next station (shot index = station_index)
            if (node.station_index as usize) < section.shots.len() {
                let next_index = node.station_index + 1;
                let shot_len = section
                    .shots
                    .get(node.station_index as usize)
                    .map_or(0.0, |s| s.length.max(0.0));
                let neighbor = StationRef::new(node.section_id, next_index);
                let next_cost = cost + shot_len;
                if dist.get(&neighbor).is_none_or(|&d| next_cost < d - 1e-9) {
                    dist.insert(neighbor, next_cost);
                    heap.push(HeapItem {
                        cost: next_cost,
                        node: neighbor,
                    });
                }
            }

            // Merge neighbors (zero distance)
            if let Some(neighbors) = merge_adj.get(&node) {
                for &neighbor in neighbors {
                    let next_cost = cost;
                    if dist.get(&neighbor).is_none_or(|&d| next_cost < d - 1e-9) {
                        dist.insert(neighbor, next_cost);
                        heap.push(HeapItem {
                            cost: next_cost,
                            node: neighbor,
                        });
                    }
                }
            }

            // Closure neighbors (zero distance)
            if include_closures {
                if let Some(neighbors) = closure_adj.get(&node) {
                    for &neighbor in neighbors {
                        let next_cost = cost;
                        if dist.get(&neighbor).is_none_or(|&d| next_cost < d - 1e-9) {
                            dist.insert(neighbor, next_cost);
                            heap.push(HeapItem {
                                cost: next_cost,
                                node: neighbor,
                            });
                        }
                    }
                }
            }
        }

        // No path found (shouldn't happen if sections are connected)
        // Fall back to sum of all reachable section lengths
        let fallback_sections = if include_closures {
            self.get_connected_section_ids(station_a.section_id)
        } else {
            self.get_merged_section_ids(station_a.section_id)
        };
        fallback_sections
            .iter()
            .filter_map(|sid| self.get_section(*sid))
            .flat_map(|s| s.shots.iter())
            .map(|shot| shot.length)
            .sum()
    }

    fn coords_add(a: Coordinates, b: Coordinates) -> Coordinates {
        Coordinates::new(a.x + b.x, a.y + b.y, a.z + b.z)
    }

    fn coords_sub(a: Coordinates, b: Coordinates) -> Coordinates {
        Coordinates::new(a.x - b.x, a.y - b.y, a.z - b.z)
    }

    fn coords_scale(a: Coordinates, factor: f64) -> Coordinates {
        Coordinates::new(a.x * factor, a.y * factor, a.z * factor)
    }

    fn coords_norm(a: Coordinates) -> f64 {
        (a.x * a.x + a.y * a.y + a.z * a.z).sqrt()
    }

    fn coords_close(a: Coordinates, b: Coordinates, eps: f64) -> bool {
        (a.x - b.x).abs() < eps && (a.y - b.y).abs() < eps && (a.z - b.z).abs() < eps
    }

    #[expect(dead_code)]
    fn coords_close_xy(a: Coordinates, b: Coordinates, eps: f64) -> bool {
        (a.x - b.x).abs() < eps && (a.y - b.y).abs() < eps
    }

    fn shot_vector_along(shot: &Shot, forward: bool) -> Coordinates {
        let azimuth_rad = shot.average_azimuth().to_radians();
        let horizontal = shot.horizontal_length();
        let dx = horizontal * azimuth_rad.sin();
        let dy = horizontal * azimuth_rad.cos();
        let dz = shot.depth_out - shot.depth_in;
        if forward {
            Coordinates::new(dx, dy, dz)
        } else {
            Coordinates::new(-dx, -dy, -dz)
        }
    }

    fn update_shot_from_forward_vector(shot: &mut Shot, vec: Coordinates) {
        let dx = vec.x;
        let dy = vec.y;
        let dz = vec.z;
        let horizontal = (dx * dx + dy * dy).sqrt();
        let new_len = (horizontal * horizontal + dz * dz).sqrt();
        let new_azi = if horizontal > 1e-9 {
            dx.atan2(dy).to_degrees().rem_euclid(360.0)
        } else {
            shot.average_azimuth()
        };
        shot.length = new_len;
        shot.azimuth_in = new_azi;
        shot.azimuth_out = new_azi;
        shot.depth_out = shot.depth_in + dz;
        let pitch = dz.atan2(horizontal).to_degrees();
        shot.pitch_in = Some(pitch);
        shot.pitch_out = Some(pitch);
    }

    /// Update only the horizontal geometry of a shot (azimuth and slope length)
    /// from a solved horizontal displacement, preserving original depths and pitch.
    fn update_shot_horizontal_only(shot: &mut Shot, dx: f64, dy: f64) {
        let horizontal = (dx * dx + dy * dy).sqrt();
        let new_azi = if horizontal > 1e-9 {
            dx.atan2(dy).to_degrees().rem_euclid(360.0)
        } else {
            shot.average_azimuth()
        };
        let dz = shot.depth_out - shot.depth_in;
        shot.length = (horizontal * horizontal + dz * dz).sqrt();
        shot.azimuth_in = new_azi;
        shot.azimuth_out = new_azi;
        // depth_in, depth_out, pitch_in, pitch_out are intentionally left unchanged
    }

    #[expect(dead_code)]
    fn collect_segment_shots(
        &self,
        path: &StationPath,
        section_lookup: &HashMap<SectionId, &Section>,
    ) -> Result<Vec<SegmentShot>, String> {
        let mut shots: Vec<SegmentShot> = Vec::new();
        for step in &path.steps {
            if let PathEdge::Shot {
                section_id,
                shot_index,
                forward,
            } = step.edge
            {
                let section = section_lookup
                    .get(&section_id)
                    .ok_or_else(|| "Section not found for closure path".to_string())?;
                let shot = section
                    .shots
                    .get(shot_index)
                    .ok_or_else(|| "Shot not found for closure path".to_string())?;
                let path_vec = Self::shot_vector_along(shot, forward);
                shots.push(SegmentShot {
                    section_id,
                    shot_index,
                    forward,
                    length: shot.length,
                    path_vec,
                    sign: 1.0,
                });
            }
        }
        Ok(shots)
    }

    fn apply_correction_to_shots(
        &mut self,
        shots: &[SegmentShot],
        correction_vec: Coordinates,
        distribution: ClosureStrategy,
    ) -> Result<(), String> {
        if shots.is_empty() {
            return Err("No distributable shots found for closure path".to_string());
        }

        let total_len: f64 = shots.iter().map(|s| s.length).sum();
        let shot_count = shots.len();

        if distribution == ClosureStrategy::ProportionalByLength && total_len <= 0.0 {
            return Err("No valid shot lengths for proportional distribution".to_string());
        }

        for shot in shots {
            let signed = Self::coords_scale(correction_vec, shot.sign);
            let (corr_x, corr_y, corr_z) = match distribution {
                ClosureStrategy::ProportionalByLength => {
                    let weight = shot.length / total_len;
                    (signed.x * weight, signed.y * weight, signed.z * weight)
                }
                ClosureStrategy::EqualDistribution => {
                    let weight = 1.0 / shot_count as f64;
                    (signed.x * weight, signed.y * weight, signed.z * weight)
                }
                _ => {
                    return Err("Unsupported distribution strategy for adjustment".to_string());
                }
            };

            let new_path_vec = Coordinates::new(
                shot.path_vec.x + corr_x,
                shot.path_vec.y + corr_y,
                shot.path_vec.z + corr_z,
            );
            let forward_vec = if shot.forward {
                new_path_vec
            } else {
                Self::coords_scale(new_path_vec, -1.0)
            };

            let section = self
                .get_section_mut(shot.section_id)
                .ok_or_else(|| "Section not found for closure path".to_string())?;
            let shot_mut = section
                .shots
                .get_mut(shot.shot_index)
                .ok_or_else(|| "Shot not found for closure path".to_string())?;
            Self::update_shot_from_forward_vector(shot_mut, forward_vec);
        }

        Ok(())
    }

    pub fn adjust_loop_closures(
        &mut self,
        anchor_station: StationRef,
        method: ClosureStrategy,
        config: &ClosureAdjustmentConfig,
    ) -> Result<(), String> {
        if !self.station_exists(anchor_station) {
            return Err("Anchor station does not exist".to_string());
        }

        let component = self.get_connected_section_ids(anchor_station.section_id);
        let zero_datum_set: HashSet<StationRef> = self
            .zero_datums
            .iter()
            .filter(|zd| component.contains(&zd.station_ref.section_id))
            .filter_map(|zd| self.resolve_key(&zd.station_ref))
            .collect();

        debug!(
            anchor_station = ?anchor_station,
            method = ?method,
            component_section_count = component.len(),
            zero_datum_count = zero_datum_set.len(),
            purpose = "adjust loop closures",
            "Preparing loop closure adjustment"
        );

        let mut zero_datum_coords: HashMap<StationRef, Coordinates> = HashMap::new();
        for zd in &zero_datum_set {
            let coords = self
                .compute_station_raw_coords(*zd)
                .ok_or_else(|| "Failed to compute zero datum coordinates".to_string())?;
            zero_datum_coords.insert(*zd, coords);
        }

        let closures: Vec<LoopClosure> = self
            .loop_closures
            .iter()
            .filter(|lc| {
                component.contains(&lc.station_a.section_id)
                    && component.contains(&lc.station_b.section_id)
                    && (lc.strategy == method || lc.strategy == ClosureStrategy::Batch)
            })
            .cloned()
            .collect();

        if closures.is_empty() {
            warn!(
                anchor_station = ?anchor_station,
                method = ?method,
                purpose = "adjust loop closures",
                "No eligible loop closures found for adjustment"
            );
            return Err("No eligible loop closures found for adjustment".to_string());
        }

        match method {
            ClosureStrategy::LeastSquaresWeighted => {
                self.adjust_least_squares(&component, &closures, anchor_station, config)?;
            }
            _ => {
                return Err("Unsupported adjustment method".to_string());
            }
        }

        // Verify zero datums remain fixed
        for (zd, before) in &zero_datum_coords {
            let after = self
                .compute_station_raw_coords(*zd)
                .ok_or_else(|| "Failed to compute zero datum coordinates".to_string())?;
            if !Self::coords_close(*before, after, 1e-6) {
                error!(
                    zero_datum = ?zd,
                    before = ?before,
                    after = ?after,
                    purpose = "protect zero datum position",
                    "Adjustment would move a zero datum station"
                );
                return Err("Adjustment would move a zero datum station".to_string());
            }
        }

        // Recompute closure metrics for the affected component
        self.recompute_closure_metrics_for_component(&component);

        // Mark adjusted closures as aligned (locked for future moves)
        let adjusted_ids: HashSet<u64> = closures.iter().map(|lc| lc.id).collect();
        for closure in &mut self.loop_closures {
            if adjusted_ids.contains(&closure.id) {
                closure.is_aligned = true;
            }
        }

        Ok(())
    }

    /// Enforce merge alignment by adjusting section and station offsets.
    #[expect(dead_code)]
    fn enforce_merge_alignment(
        &mut self,
        sections_to_align: &HashSet<SectionId>,
        colocated_groups: &HashMap<StationRef, Vec<StationRef>>,
        fixed_initial: &HashSet<StationRef>,
    ) -> Result<(), String> {
        if sections_to_align.is_empty() {
            return Ok(());
        }

        let mut section_deltas: HashMap<SectionId, Coordinates> = HashMap::new();
        let mut conflict_samples: Vec<(
            SectionId,
            StationRef,
            StationRef,
            Coordinates,
            Coordinates,
        )> = Vec::new();
        let mut conflicted_sections: HashSet<SectionId> = HashSet::new();
        let mut section_station_counts: HashMap<SectionId, usize> = HashMap::new();
        let mut section_targets: HashMap<SectionId, HashMap<StationRef, Coordinates>> =
            HashMap::new();

        for section in self
            .sections
            .iter()
            .filter(|s| sections_to_align.contains(&s.id))
        {
            section_station_counts.insert(section.id, section.shots.len());
        }

        for members in colocated_groups.values() {
            let group_sections: HashSet<SectionId> = members.iter().map(|m| m.section_id).collect();
            if group_sections.is_disjoint(sections_to_align) {
                continue;
            }

            let anchor = members
                .iter()
                .copied()
                .find(|m| fixed_initial.contains(m))
                .unwrap_or_else(|| members[0]);
            let anchor_coords = self
                .compute_station_raw_coords(anchor)
                .ok_or_else(|| "Failed to compute merge anchor coordinates".to_string())?;

            for member in members {
                let coords = self
                    .compute_station_raw_coords(*member)
                    .ok_or_else(|| "Failed to compute merge member coordinates".to_string())?;
                let delta = Self::coords_sub(anchor_coords, coords);
                section_targets
                    .entry(member.section_id)
                    .or_default()
                    .insert(*member, anchor_coords);
                let entry = section_deltas.entry(member.section_id).or_insert(delta);
                if !Self::coords_close(*entry, delta, 1e-6) {
                    conflicted_sections.insert(member.section_id);
                    conflict_samples.push((member.section_id, anchor, *member, *entry, delta));
                }
            }
        }

        if !conflict_samples.is_empty() {
            debug!(
                samples = conflict_samples.len(),
                ?conflict_samples,
                "Merge alignment produced conflicting section translations"
            );
        }

        for (section_id, delta) in &section_deltas {
            if !sections_to_align.contains(section_id) || conflicted_sections.contains(section_id) {
                continue;
            }
            if delta.x.abs() > 1e-9 || delta.y.abs() > 1e-9 {
                self.adjust_section_offset(*section_id, delta.x, delta.y);
            }
            if delta.z.abs() > 1e-9 {
                if let Some(shot_count) = section_station_counts.get(section_id).copied() {
                    let keys: Vec<StationKey> = (0..=shot_count)
                        .filter_map(|idx| {
                            self.key_for_ref(StationRef::new(*section_id, idx as u32))
                        })
                        .collect();
                    for key in keys {
                        let entry = self.station_offsets.entry(key).or_insert((0.0, 0.0, 0.0));
                        entry.2 += delta.z;
                    }
                }
            }
        }

        if !conflicted_sections.is_empty() {
            for section_id in conflicted_sections.iter().copied() {
                let mut anchor_map: HashMap<StationRef, Coordinates> = HashMap::new();
                if let Some(targets) = section_targets.get(&section_id) {
                    for (station, target) in targets {
                        anchor_map.insert(*station, *target);
                    }
                }

                for fixed in fixed_initial.iter().filter(|s| s.section_id == section_id) {
                    let coords = self
                        .compute_station_raw_coords(*fixed)
                        .ok_or_else(|| "Failed to compute fixed station coordinates".to_string())?;
                    anchor_map.insert(*fixed, coords);
                }

                if anchor_map.is_empty() {
                    continue;
                }

                let mut anchors: Vec<(StationRef, Coordinates)> = anchor_map.into_iter().collect();
                anchors.sort_by(|a, b| (a.0.station_index).cmp(&b.0.station_index));

                let ref_index = anchors
                    .iter()
                    .position(|(s, _)| fixed_initial.contains(s))
                    .unwrap_or(0);
                let (ref_station, ref_target) = anchors[ref_index];
                let ref_current = self
                    .compute_station_raw_coords(ref_station)
                    .ok_or_else(|| "Failed to compute reference anchor coordinates".to_string())?;
                let ref_delta = Self::coords_sub(ref_target, ref_current);
                if Self::coords_norm(ref_delta) > 1e-9 {
                    if ref_delta.x.abs() > 1e-9 || ref_delta.y.abs() > 1e-9 {
                        self.adjust_section_offset(section_id, ref_delta.x, ref_delta.y);
                    }
                    if ref_delta.z.abs() > 1e-9 {
                        if let Some(shot_count) = section_station_counts.get(&section_id).copied() {
                            let keys: Vec<StationKey> = (0..=shot_count)
                                .filter_map(|idx| {
                                    self.key_for_ref(StationRef::new(section_id, idx as u32))
                                })
                                .collect();
                            for key in keys {
                                let entry =
                                    self.station_offsets.entry(key).or_insert((0.0, 0.0, 0.0));
                                entry.2 += ref_delta.z;
                            }
                        }
                    }
                }

                let mut apply_segment_alignment = |start: StationRef,
                                                   end: StationRef,
                                                   target_end: Coordinates|
                 -> Result<(), String> {
                    if start.station_index == end.station_index {
                        return Ok(());
                    }
                    let current_end = self.compute_station_raw_coords(end).ok_or_else(|| {
                        "Failed to compute merge segment end coordinates".to_string()
                    })?;
                    let correction = Self::coords_sub(target_end, current_end);
                    if Self::coords_norm(correction) <= 1e-9 {
                        return Ok(());
                    }

                    let section_lookup = self.build_section_lookup();
                    let section = section_lookup
                        .get(&section_id)
                        .ok_or_else(|| "Section not found for merge alignment".to_string())?;
                    let (start_idx, end_idx, forward) = if start.station_index < end.station_index {
                        (
                            start.station_index as usize,
                            end.station_index as usize,
                            true,
                        )
                    } else {
                        (
                            end.station_index as usize,
                            start.station_index as usize,
                            false,
                        )
                    };
                    let mut shots: Vec<SegmentShot> = Vec::new();
                    for idx in start_idx..end_idx {
                        let shot = section
                            .shots
                            .get(idx)
                            .ok_or_else(|| "Shot not found for merge alignment".to_string())?;
                        let path_vec = Self::shot_vector_along(shot, forward);
                        shots.push(SegmentShot {
                            section_id,
                            shot_index: idx,
                            forward,
                            length: shot.length,
                            path_vec,
                            sign: 1.0,
                        });
                    }

                    if shots.is_empty() {
                        self.apply_station_move_internal(end, correction)?;
                        return Ok(());
                    }

                    self.apply_correction_to_shots(
                        &shots,
                        correction,
                        ClosureStrategy::ProportionalByLength,
                    )?;
                    Ok(())
                };

                for idx in ref_index..anchors.len().saturating_sub(1) {
                    let (start, _) = anchors[idx];
                    let (end, target_end) = anchors[idx + 1];
                    apply_segment_alignment(start, end, target_end)?;
                }
                for idx in (1..=ref_index).rev() {
                    let (start, _) = anchors[idx];
                    let (end, target_end) = anchors[idx - 1];
                    apply_segment_alignment(start, end, target_end)?;
                }
            }
        }

        Ok(())
    }

    /// Coordinate-only, component-scoped batch of raw (measured) station
    /// coordinates — the same values [`Self::compute_station_raw_coords`] returns,
    /// computed for every station in `component` in one linear pass.
    ///
    /// The closure solve runs this once per connected component, so it deliberately
    /// avoids whole-project [`Self::compute_station_coordinates`], which would be
    /// (a) `O(component_count × total_stations)` across the per-component loop and
    /// (b) `O(closures × stations)` from rebuilding the `merged_with`/`closures_with`
    /// metadata the solver never reads. Merges and aligned closures only connect
    /// stations within one connected component (see
    /// [`Self::get_connected_section_ids`]), so scoping the colocated depth grouping
    /// to `component` is exact.
    fn compute_component_raw_coords(
        &self,
        component: &HashSet<SectionId>,
    ) -> HashMap<StationRef, Coordinates> {
        let station_list: Vec<StationRef> = self
            .sections
            .iter()
            .filter(|s| component.contains(&s.id))
            .flat_map(|s| (0..=s.shots.len()).map(move |idx| StationRef::new(s.id, idx as u32)))
            .collect();

        // Colocated depth groups (merges + aligned closures), restricted to the
        // component. Simple union-find with path compression.
        fn find(parent: &mut HashMap<StationRef, StationRef>, x: StationRef) -> StationRef {
            let mut cur = x;
            while let Some(&p) = parent.get(&cur) {
                if p == cur {
                    break;
                }
                cur = p;
            }
            let mut node = x;
            while let Some(&p) = parent.get(&node) {
                if p == cur {
                    break;
                }
                parent.insert(node, cur);
                node = p;
            }
            cur
        }
        let mut parent: HashMap<StationRef, StationRef> =
            station_list.iter().map(|&sr| (sr, sr)).collect();
        let unite = |parent: &mut HashMap<StationRef, StationRef>, a, b| {
            let (ra, rb) = (find(parent, a), find(parent, b));
            if ra != rb {
                parent.insert(ra, rb);
            }
        };
        for merge in &self.station_merges {
            if component.contains(&merge.station_a.section_id)
                && component.contains(&merge.station_b.section_id)
            {
                if let (Some(a), Some(b)) = (
                    self.resolve_key(&merge.station_a),
                    self.resolve_key(&merge.station_b),
                ) {
                    unite(&mut parent, a, b);
                }
            }
        }
        for closure in &self.loop_closures {
            if !closure.is_aligned {
                continue;
            }
            if component.contains(&closure.station_a.section_id)
                && component.contains(&closure.station_b.section_id)
            {
                if let (Some(a), Some(b)) = (
                    self.resolve_key(&closure.station_a),
                    self.resolve_key(&closure.station_b),
                ) {
                    unite(&mut parent, a, b);
                }
            }
        }
        let mut groups: HashMap<StationRef, Vec<StationRef>> = HashMap::new();
        for &sr in &station_list {
            let root = find(&mut parent, sr);
            groups.entry(root).or_default().push(sr);
        }
        let mut depth: HashMap<StationRef, f64> = HashMap::with_capacity(station_list.len());
        for members in groups.values() {
            let d = self.compute_station_depth(members);
            for &sr in members {
                depth.insert(sr, d);
            }
        }

        // Per-section XY walk + individual station offsets.
        let mut out: HashMap<StationRef, Coordinates> = HashMap::with_capacity(station_list.len());
        for section in self.sections.iter().filter(|s| component.contains(&s.id)) {
            let (offset_x, offset_y) = self
                .section_offsets
                .get(&section.id)
                .copied()
                .unwrap_or((0.0, 0.0));
            let mut cur = (offset_x, offset_y);
            for idx in 0..=section.shots.len() {
                if idx > 0 {
                    let shot = &section.shots[idx - 1];
                    let az = shot.average_azimuth().to_radians();
                    let h = shot.horizontal_length();
                    cur.0 += h * az.sin();
                    cur.1 += h * az.cos();
                }
                let sr = StationRef::new(section.id, idx as u32);
                let z = depth.get(&sr).copied().unwrap_or(0.0);
                let mut coords = Coordinates::new(cur.0, cur.1, z);
                if let Some((ox, oy, oz)) = self.station_offset_for_ref(sr) {
                    coords.x += ox;
                    coords.y += oy;
                    coords.z += oz;
                }
                out.insert(sr, coords);
            }
        }
        out
    }

    /// Solve the two SPD weighted-Laplacian systems `A·x = atb_x` and
    /// `A·y = atb_y` the closure adjustment assembles. Both systems share the
    /// same sparsity (`adj`) but use different per-axis weights.
    ///
    /// A cave survey graph is almost a tree: long degree-2 passages and degree-1
    /// spurs with only a handful of independent loops (≈ one per eligible
    /// closure). We exploit that with **exact** Gaussian elimination of every
    /// node whose current off-diagonal degree is ≤ 2 — degree-1 is leaf
    /// back-substitution, degree-2 is series reduction (fill between the two
    /// neighbours). Both axes are carried in lockstep since the structure is
    /// shared; SPD guarantees positive pivots throughout. Peeling collapses the
    /// tree and chains in O(n); what survives is the 2-core (≈ the cycle space),
    /// solved with Jacobi-PCG (tiny, so effectively exact and instant). Peeled
    /// nodes are then recovered by back-substitution in reverse order.
    ///
    /// `adj[i]` holds symmetric off-diagonal entries `(j, off_x, off_y)` (the
    /// negative edge weights). Returns `(sol_x, sol_y)`, each length `n`.
    fn solve_reduced_laplacian(
        n: usize,
        diag_x: &[f64],
        diag_y: &[f64],
        atb_x: &[f64],
        atb_y: &[f64],
        adj: &[Vec<(usize, f64, f64)>],
        x0_x: &[f64],
        x0_y: &[f64],
    ) -> (Vec<f64>, Vec<f64>) {
        // A node is only eliminated when its current pivot is *safely positive*
        // relative to the node's original diagonal. A pivot that is non-positive or
        // has collapsed to roundoff (a tiny fraction of its starting scale) means
        // the node sits in the system's null space — a floating axis. Such a pivot
        // is mathematically 0 but, with varied edge weights, lands at ~±1e-12 from
        // cancellation, so an absolute 1e-30 floor would wrongly eliminate it and
        // divide by ~0, shifting the whole component off its warm-started (measured)
        // translation. These stay in the core for the warm-started PCG instead.
        const PIVOT_REL: f64 = 1e-9;

        // Mutable working copies of the system (diagonals, rhs, adjacency).
        let mut dx = diag_x.to_vec();
        let mut dy = diag_y.to_vec();
        let mut cx = atb_x.to_vec();
        let mut cy = atb_y.to_vec();
        let mut nbr: Vec<HashMap<usize, (f64, f64)>> = vec![HashMap::new(); n];
        for (i, row) in adj.iter().enumerate() {
            for &(j, ox, oy) in row {
                let e = nbr[i].entry(j).or_insert((0.0, 0.0));
                e.0 += ox;
                e.1 += oy;
            }
        }

        // Back-substitution record captured at the moment a node is eliminated.
        struct Elim {
            u: usize,
            nbrs: Vec<(usize, f64, f64)>,
            dxu: f64,
            dyu: f64,
            cxu: f64,
            cyu: f64,
        }
        let mut eliminated = vec![false; n];
        let mut order: Vec<Elim> = Vec::new();

        let mut queue: VecDeque<usize> = (0..n).filter(|&i| nbr[i].len() <= 2).collect();
        while let Some(u) = queue.pop_front() {
            // Stale entry: already gone, or degree grew above 2 since enqueued.
            if eliminated[u] || nbr[u].len() > 2 {
                continue;
            }
            let (pdx, pdy) = (dx[u], dy[u]);
            // Scale-relative, sign-aware floor: skip when either axis pivot is
            // non-positive or tiny vs. its original diagonal (null-space / floating).
            if pdx <= PIVOT_REL * diag_x[u] || pdy <= PIVOT_REL * diag_y[u] {
                continue; // null-space / ill-conditioned pivot → leave for the core solve
            }
            let nbrs: Vec<(usize, f64, f64)> =
                nbr[u].iter().map(|(&v, &(ox, oy))| (v, ox, oy)).collect();
            let (pcx, pcy) = (cx[u], cy[u]);
            eliminated[u] = true;
            order.push(Elim {
                u,
                nbrs: nbrs.clone(),
                dxu: pdx,
                dyu: pdy,
                cxu: pcx,
                cyu: pcy,
            });

            // Detach u from its neighbours.
            for &(v, _, _) in &nbrs {
                nbr[v].remove(&u);
            }
            // Schur complement onto each neighbour: diagonal + rhs.
            for &(v, ox, oy) in &nbrs {
                cx[v] -= ox * pcx / pdx;
                cy[v] -= oy * pcy / pdy;
                dx[v] -= ox * ox / pdx;
                dy[v] -= oy * oy / pdy;
            }
            // Schur complement fill between neighbour pairs (series reduction).
            for a in 0..nbrs.len() {
                for b in (a + 1)..nbrs.len() {
                    let (i, oxa, oya) = nbrs[a];
                    let (j, oxb, oyb) = nbrs[b];
                    let fx = -(oxa * oxb) / pdx;
                    let fy = -(oya * oyb) / pdy;
                    let e = nbr[i].entry(j).or_insert((0.0, 0.0));
                    e.0 += fx;
                    e.1 += fy;
                    let e = nbr[j].entry(i).or_insert((0.0, 0.0));
                    e.0 += fx;
                    e.1 += fy;
                }
            }
            // Neighbours may now be peelable.
            for &(v, _, _) in &nbrs {
                if !eliminated[v] && nbr[v].len() <= 2 {
                    queue.push_back(v);
                }
            }
        }

        let mut sol_x = vec![0.0; n];
        let mut sol_y = vec![0.0; n];

        // Solve the irreducible 2-core (degree ≥ 3 / ill-conditioned nodes) with
        // Jacobi-PCG. For a cave this is at most a few nodes per loop.
        let core: Vec<usize> = (0..n).filter(|&i| !eliminated[i]).collect();
        if !core.is_empty() {
            let k = core.len();
            let mut local: HashMap<usize, usize> = HashMap::with_capacity(k);
            for (li, &g) in core.iter().enumerate() {
                local.insert(g, li);
            }
            let cdx: Vec<f64> = core.iter().map(|&g| dx[g]).collect();
            let cdy: Vec<f64> = core.iter().map(|&g| dy[g]).collect();
            let crx: Vec<f64> = core.iter().map(|&g| cx[g]).collect();
            let cry: Vec<f64> = core.iter().map(|&g| cy[g]).collect();
            let mut cadj: Vec<Vec<(usize, f64, f64)>> = vec![Vec::new(); k];
            for (li, &g) in core.iter().enumerate() {
                for (&v, &(ox, oy)) in &nbr[g] {
                    // Every surviving neighbour is itself a core node.
                    if let Some(&lv) = local.get(&v) {
                        cadj[li].push((lv, ox, oy));
                    }
                }
            }
            let cx0: Vec<f64> = core.iter().map(|&g| x0_x[g]).collect();
            let cy0: Vec<f64> = core.iter().map(|&g| x0_y[g]).collect();
            let csx = Self::pcg_axis(k, &cdx, &crx, &cadj, 0, &cx0);
            let csy = Self::pcg_axis(k, &cdy, &cry, &cadj, 1, &cy0);
            for (li, &g) in core.iter().enumerate() {
                sol_x[g] = csx[li];
                sol_y[g] = csy[li];
            }
        }

        // Back-substitute eliminated nodes in reverse elimination order.
        for rec in order.iter().rev() {
            let mut sx = rec.cxu;
            let mut sy = rec.cyu;
            for &(v, ox, oy) in &rec.nbrs {
                sx -= ox * sol_x[v];
                sy -= oy * sol_y[v];
            }
            sol_x[rec.u] = sx / rec.dxu;
            sol_y[rec.u] = sy / rec.dyu;
        }

        (sol_x, sol_y)
    }

    /// Jacobi-preconditioned Conjugate Gradient for one axis of an SPD/PSD system
    /// stored as diagonal + symmetric off-diagonal adjacency `(j, off_x, off_y)`
    /// (`axis` selects the weight). Used only for the small reduced core.
    ///
    /// Starts from the warm-start guess `x0` (the measured positions). This is not
    /// just for convergence speed: a node that is unconstrained on this axis (e.g.
    /// reachable only through a zero-length cardinal shot, so its weight is 0) has
    /// an empty row, leaving that coordinate in the system's null space. CG never
    /// moves a null-space direction, so it stays at `x0` — preserving the measured
    /// position instead of snapping it to world 0.
    fn pcg_axis(
        n: usize,
        diag: &[f64],
        rhs: &[f64],
        adj: &[Vec<(usize, f64, f64)>],
        axis: usize,
        x0: &[f64],
    ) -> Vec<f64> {
        let off = |e: (usize, f64, f64)| if axis == 0 { e.1 } else { e.2 };
        let spmv = |x: &[f64]| -> Vec<f64> {
            let mut y = vec![0.0; n];
            for i in 0..n {
                y[i] += diag[i] * x[i];
                for &edge in &adj[i] {
                    y[i] += off(edge) * x[edge.0];
                }
            }
            y
        };
        let max_iter = n.min(10_000);
        let tol = 1e-12;
        let inv_diag: Vec<f64> = diag
            .iter()
            .map(|&d| if d.abs() > 1e-30 { 1.0 / d } else { 1.0 })
            .collect();

        let mut x = x0.to_vec();
        let ax0 = spmv(&x);
        let mut r: Vec<f64> = rhs.iter().zip(ax0.iter()).map(|(&b, &a)| b - a).collect();
        let mut z: Vec<f64> = r
            .iter()
            .zip(inv_diag.iter())
            .map(|(&ri, &mi)| ri * mi)
            .collect();
        let mut p = z.clone();
        let mut rz: f64 = r.iter().zip(z.iter()).map(|(&ri, &zi)| ri * zi).sum();

        // Converge relative to the *initial residual* ‖b − A·x0‖, not ‖b‖. With a
        // warm start that is the correct reference: return x0 only when it already
        // satisfies the system (residual ~0 — which includes pure null-space
        // directions), and otherwise let CG converge the range component while
        // leaving null-space directions at x0. Keying the early exit off ‖b‖ alone
        // would wrongly return a non-optimal x0 when Schur elimination cancels the
        // core RHS for a balanced loop even though the matrix rows are non-zero
        // (Codex #86).
        let r0_norm_sq: f64 = r.iter().map(|&v| v * v).sum();
        if r0_norm_sq < tol * tol {
            return x;
        }

        for _iter in 0..max_iter {
            let ap = spmv(&p);
            let pap: f64 = p.iter().zip(ap.iter()).map(|(&pi, &api)| pi * api).sum();
            if pap.abs() < 1e-30 {
                break;
            }
            let alpha = rz / pap;
            for i in 0..n {
                x[i] += alpha * p[i];
                r[i] -= alpha * ap[i];
            }
            let r_norm_sq: f64 = r.iter().map(|&v| v * v).sum();
            if r_norm_sq < tol * tol * r0_norm_sq {
                break;
            }
            for i in 0..n {
                z[i] = r[i] * inv_diag[i];
            }
            let rz_new: f64 = r.iter().zip(z.iter()).map(|(&ri, &zi)| ri * zi).sum();
            let beta = rz_new / rz;
            for i in 0..n {
                p[i] = z[i] + beta * p[i];
            }
            rz = rz_new;
        }
        x
    }

    fn adjust_least_squares(
        &mut self,
        component: &HashSet<SectionId>,
        closures: &[LoopClosure],
        anchor_station: StationRef,
        config: &ClosureAdjustmentConfig,
    ) -> Result<(), String> {
        // Collect all stations in component
        let mut stations: Vec<StationRef> = Vec::new();
        for section in self.sections.iter().filter(|s| component.contains(&s.id)) {
            for idx in 0..=section.shots.len() {
                stations.push(StationRef::new(section.id, idx as u32));
            }
        }

        // Precompute every component station's raw (measured) coordinates in one
        // linear, component-scoped pass. The warm-start, group-Z and section-delta
        // phases below each need a station's measured position; calling
        // `compute_station_raw_coords` per station re-walks the section from its
        // start (O(index)), which made the solve O(n^2) on long degree-2 chains
        // (#81). The map is owned (no borrow of `self`), so it stays valid across
        // the later `iter_mut` update phase.
        let raw_coords = self.compute_component_raw_coords(component);

        let mut parent: HashMap<StationRef, StationRef> = HashMap::new();
        for station in &stations {
            parent.insert(*station, *station);
        }

        let find = |x: StationRef, parent: &mut HashMap<StationRef, StationRef>| -> StationRef {
            let mut current = x;
            while let Some(p) = parent.get(&current) {
                if *p == current {
                    break;
                }
                current = *p;
            }
            let root = current;
            // Path compression
            let mut current = x;
            while let Some(p) = parent.get(&current) {
                if *p == root {
                    break;
                }
                let next = *p;
                parent.insert(current, root);
                current = next;
            }
            root
        };

        let union = |a: StationRef, b: StationRef, parent: &mut HashMap<StationRef, StationRef>| {
            let ra = find(a, parent);
            let rb = find(b, parent);
            if ra != rb {
                parent.insert(ra, rb);
            }
        };

        for merge in &self.station_merges {
            if component.contains(&merge.station_a.section_id)
                && component.contains(&merge.station_b.section_id)
            {
                if let (Some(a), Some(b)) = (
                    self.resolve_key(&merge.station_a),
                    self.resolve_key(&merge.station_b),
                ) {
                    union(a, b, &mut parent);
                }
            }
        }

        for closure in closures {
            if component.contains(&closure.station_a.section_id)
                && component.contains(&closure.station_b.section_id)
            {
                if let (Some(a), Some(b)) = (
                    self.resolve_key(&closure.station_a),
                    self.resolve_key(&closure.station_b),
                ) {
                    union(a, b, &mut parent);
                }
            }
        }

        let mut groups: HashMap<StationRef, Vec<StationRef>> = HashMap::new();
        let mut station_root: HashMap<StationRef, StationRef> = HashMap::new();
        for station in &stations {
            let root = find(*station, &mut parent);
            station_root.insert(*station, root);
            groups.entry(root).or_default().push(*station);
        }

        let zero_datum_set: HashSet<StationRef> = self
            .zero_datums
            .iter()
            .filter(|zd| component.contains(&zd.station_ref.section_id))
            .filter_map(|zd| self.resolve_key(&zd.station_ref))
            .collect();

        let mut fixed_groups: HashSet<StationRef> = HashSet::new();
        let mut fixed_coords: HashMap<StationRef, Coordinates> = HashMap::new();

        for (root, members) in &groups {
            let mut datum_members: Vec<StationRef> = members
                .iter()
                .filter(|m| zero_datum_set.contains(m))
                .copied()
                .collect();
            if datum_members.len() > 1 {
                return Err("Multiple zero datums in a single constraint group".to_string());
            }
            if let Some(datum) = datum_members.pop() {
                let coords = raw_coords
                    .get(&datum)
                    .copied()
                    .ok_or_else(|| "Failed to compute zero datum coordinates".to_string())?;
                fixed_groups.insert(*root);
                fixed_coords.insert(*root, coords);
            }
        }

        if fixed_groups.is_empty() {
            let anchor_root = *station_root
                .get(&anchor_station)
                .ok_or_else(|| "Anchor station not found".to_string())?;
            let coords = raw_coords
                .get(&anchor_station)
                .copied()
                .ok_or_else(|| "Failed to compute anchor coordinates".to_string())?;
            fixed_groups.insert(anchor_root);
            fixed_coords.insert(anchor_root, coords);
        }

        let mut unknown_index: HashMap<StationRef, usize> = HashMap::new();
        for root in groups.keys() {
            if !fixed_groups.contains(root) {
                let next = unknown_index.len();
                unknown_index.insert(*root, next);
            }
        }

        let n = unknown_index.len();
        if n == 0 {
            return Ok(());
        }

        // Sparse assembly for the symmetric positive-definite normal matrix A^T A.
        // The matrix is a weighted graph Laplacian (grounded at the fixed
        // datum/anchor) — extremely sparse (≤3 non-zeros per row). We store
        // diagonal entries and off-diagonal adjacency, then solve via degree-≤2
        // graph reduction plus PCG on the tiny core (see `solve_reduced_laplacian`).
        let mut atb_x = vec![0.0; n];
        let mut atb_y = vec![0.0; n];
        let mut diag_x = vec![0.0; n];
        let mut diag_y = vec![0.0; n];
        // Adjacency list: for each node, list of (neighbor, weight_x, weight_y)
        let mut adj: Vec<Vec<(usize, f64, f64)>> = vec![Vec::new(); n];

        for section in self.sections.iter().filter(|s| component.contains(&s.id)) {
            let quality = if section.quality.is_finite() && section.quality > 0.0 {
                section.quality
            } else {
                1.0
            };
            let sigma_len = config.base_sigma_length_m * quality;
            let sigma_az = config.base_sigma_azimuth_deg.to_radians() * quality;

            for (idx, shot) in section.shots.iter().enumerate() {
                let station_i = StationRef::new(section.id, idx as u32);
                let station_j = StationRef::new(section.id, (idx + 1) as u32);

                let root_i = *station_root
                    .get(&station_i)
                    .ok_or_else(|| "Missing station root".to_string())?;
                let root_j = *station_root
                    .get(&station_j)
                    .ok_or_else(|| "Missing station root".to_string())?;

                if root_i == root_j {
                    continue;
                }

                let vec = Self::shot_vector_along(shot, true);
                let az = shot.average_azimuth().to_radians();
                let len = shot.length;

                let sigma_dx =
                    ((az.sin() * sigma_len).powi(2) + (len * az.cos() * sigma_az).powi(2)).sqrt();
                let sigma_dy =
                    ((az.cos() * sigma_len).powi(2) + (len * az.sin() * sigma_az).powi(2)).sqrt();

                let w_x = if sigma_dx > 0.0 {
                    1.0 / (sigma_dx * sigma_dx)
                } else {
                    0.0
                };
                let w_y = if sigma_dy > 0.0 {
                    1.0 / (sigma_dy * sigma_dy)
                } else {
                    0.0
                };

                let i_idx = unknown_index.get(&root_i).copied();
                let j_idx = unknown_index.get(&root_j).copied();

                let b_x = match (i_idx, j_idx) {
                    (Some(_), Some(_)) => vec.x,
                    (Some(_), None) => {
                        let xj = fixed_coords
                            .get(&root_j)
                            .copied()
                            .unwrap_or_else(|| Coordinates::new(0.0, 0.0, 0.0));
                        vec.x - xj.x
                    }
                    (None, Some(_)) => {
                        let xi = fixed_coords
                            .get(&root_i)
                            .copied()
                            .unwrap_or_else(|| Coordinates::new(0.0, 0.0, 0.0));
                        vec.x + xi.x
                    }
                    (None, None) => 0.0,
                };
                let b_y = match (i_idx, j_idx) {
                    (Some(_), Some(_)) => vec.y,
                    (Some(_), None) => {
                        let yj = fixed_coords
                            .get(&root_j)
                            .copied()
                            .unwrap_or_else(|| Coordinates::new(0.0, 0.0, 0.0));
                        vec.y - yj.y
                    }
                    (None, Some(_)) => {
                        let yi = fixed_coords
                            .get(&root_i)
                            .copied()
                            .unwrap_or_else(|| Coordinates::new(0.0, 0.0, 0.0));
                        vec.y + yi.y
                    }
                    (None, None) => 0.0,
                };

                // Accumulate into sparse structure
                macro_rules! add_sparse {
                    ($w:expr, $b_val:expr, $diag:expr, $atb:expr, $axis:literal) => {
                        if $w.is_finite() && $w > 0.0 {
                            match (i_idx, j_idx) {
                                (Some(ii), Some(jj)) => {
                                    $diag[ii] += $w;
                                    $diag[jj] += $w;
                                    $atb[ii] += -$w * $b_val;
                                    $atb[jj] += $w * $b_val;
                                }
                                (Some(ii), None) => {
                                    $diag[ii] += $w;
                                    $atb[ii] += -$w * $b_val;
                                }
                                (None, Some(jj)) => {
                                    $diag[jj] += $w;
                                    $atb[jj] += $w * $b_val;
                                }
                                (None, None) => {}
                            }
                        }
                    };
                }
                add_sparse!(w_x, b_x, diag_x, atb_x, 0);
                add_sparse!(w_y, b_y, diag_y, atb_y, 1);

                // Record adjacency for off-diagonal entries (edge weight = -w)
                if let (Some(ii), Some(jj)) = (i_idx, j_idx) {
                    // Check if edge already exists and accumulate
                    let mut found = false;
                    for entry in adj[ii].iter_mut() {
                        if entry.0 == jj {
                            entry.1 -= w_x;
                            entry.2 -= w_y;
                            found = true;
                            break;
                        }
                    }
                    if !found {
                        adj[ii].push((jj, -w_x, -w_y));
                    }
                    let mut found = false;
                    for entry in adj[jj].iter_mut() {
                        if entry.0 == ii {
                            entry.1 -= w_x;
                            entry.2 -= w_y;
                            found = true;
                            break;
                        }
                    }
                    if !found {
                        adj[jj].push((ii, -w_x, -w_y));
                    }
                }
            }
        }

        // Warm-start guess: each unknown group's measured position. This seeds the
        // core PCG so a coordinate that is unconstrained on an axis (e.g. only a
        // zero-length cardinal shot touches it → zero weight → null-space row)
        // stays at its measured value instead of snapping to world 0.
        let mut x0_x = vec![0.0; n];
        let mut x0_y = vec![0.0; n];
        for (root, members) in &groups {
            if let Some(&idx) = unknown_index.get(root) {
                if let Some(coords) = members.first().and_then(|m| raw_coords.get(m).copied()) {
                    x0_x[idx] = coords.x;
                    x0_y[idx] = coords.y;
                }
            }
        }

        // Solve both axes (sharing sparsity, differing in per-axis weights) with
        // exact degree-≤2 graph reduction: peel spurs and series-reduce long
        // passages in O(n), then Jacobi-PCG on the small remaining 2-core (≈ the
        // cycle space, ~#closures nodes), then back-substitute. This replaces the
        // former full-system PCG, which took O(loop-diameter) iterations — i.e.
        // O(n) iterations on a single long loop, making the solve O(n²) (#81).
        // See `solve_reduced_laplacian`.
        let (sol_x, sol_y) =
            Self::solve_reduced_laplacian(n, &diag_x, &diag_y, &atb_x, &atb_y, &adj, &x0_x, &x0_y);

        // Optimality guard (tests only): the closure adjustment is the minimizer of
        // the weighted misclosure, i.e. the solution of the SPD normal equations
        // `A·x = atb`. Verify that directly on the *real* assembled system by
        // checking the residual `‖A·x − atb‖∞ ≈ 0` for both axes. This runs for
        // every test that exercises the solve (analytic, realistic, fuzz), so it
        // proves the result is the true optimum — not merely that "the loop closed".
        #[cfg(test)]
        {
            let residual_inf = |diag: &[f64], atb: &[f64], sol: &[f64], axis: usize| -> f64 {
                let mut max = 0.0_f64;
                for i in 0..n {
                    let mut ax = diag[i] * sol[i];
                    for &(j, wx, wy) in &adj[i] {
                        ax += if axis == 0 { wx } else { wy } * sol[j];
                    }
                    max = max.max((ax - atb[i]).abs());
                }
                max
            };
            let rx = residual_inf(&diag_x, &atb_x, &sol_x, 0);
            let ry = residual_inf(&diag_y, &atb_y, &sol_y, 1);
            assert!(
                rx < 1e-6 && ry < 1e-6,
                "closure solve is not at the LSQ optimum: ‖A·x−b‖∞ = ({rx:.3e}, {ry:.3e})"
            );
        }

        // Collect original Z coordinates for each group root (depths are not adjusted)
        let mut group_raw_z: HashMap<StationRef, f64> = HashMap::new();
        for (root, members) in &groups {
            // Use the first member's raw Z as representative for the group
            if let Some(member) = members.first() {
                if let Some(coords) = raw_coords.get(member).copied() {
                    group_raw_z.insert(*root, coords.z);
                }
            }
        }

        let mut group_coords: HashMap<StationRef, Coordinates> = HashMap::new();
        for root in groups.keys() {
            let raw_z = group_raw_z.get(root).copied().unwrap_or(0.0);
            if let Some(coords) = fixed_coords.get(root) {
                // Fixed groups keep their original coords but Z is always original
                group_coords.insert(*root, Coordinates::new(coords.x, coords.y, raw_z));
                continue;
            }
            if let Some(idx) = unknown_index.get(root) {
                group_coords.insert(*root, Coordinates::new(sol_x[*idx], sol_y[*idx], raw_z));
            }
        }

        let station_offsets = self.resolved_station_offsets();

        // Identify spur stations (not on any cycle) by iterative leaf pruning.
        // Spur shots have no redundancy — there's nothing to adjust them against —
        // so they must be skipped in the update phase.
        let spur_stations: HashSet<StationRef> = {
            let mut adj_deg: HashMap<StationRef, Vec<StationRef>> = HashMap::new();
            for section in self.sections.iter().filter(|s| component.contains(&s.id)) {
                for idx in 0..section.shots.len() {
                    let si = StationRef::new(section.id, idx as u32);
                    let sj = StationRef::new(section.id, (idx + 1) as u32);
                    adj_deg.entry(si).or_default().push(sj);
                    adj_deg.entry(sj).or_default().push(si);
                }
            }
            for merge in &self.station_merges {
                if component.contains(&merge.station_a.section_id)
                    && component.contains(&merge.station_b.section_id)
                {
                    if let (Some(a), Some(b)) = (
                        self.resolve_key(&merge.station_a),
                        self.resolve_key(&merge.station_b),
                    ) {
                        adj_deg.entry(a).or_default().push(b);
                        adj_deg.entry(b).or_default().push(a);
                    }
                }
            }
            for closure in closures {
                if let (Some(a), Some(b)) = (
                    self.resolve_key(&closure.station_a),
                    self.resolve_key(&closure.station_b),
                ) {
                    adj_deg.entry(a).or_default().push(b);
                    adj_deg.entry(b).or_default().push(a);
                }
            }

            // Fixed stations must not be pruned — they anchor the network
            // even if they sit at a graph leaf.  The anchor station is only
            // fixed when no zero datums exist (mirrors the solver logic).
            let mut pinned: HashSet<StationRef> = zero_datum_set.clone();
            if pinned.is_empty() {
                pinned.insert(anchor_station);
            }

            let mut degree: HashMap<StationRef, usize> =
                adj_deg.iter().map(|(s, nbrs)| (*s, nbrs.len())).collect();

            let mut stack: Vec<StationRef> = degree
                .iter()
                .filter(|(&s, &d)| d == 1 && !pinned.contains(&s))
                .map(|(&s, _)| s)
                .collect();

            let mut pruned: HashSet<StationRef> = HashSet::new();
            while let Some(station) = stack.pop() {
                pruned.insert(station);
                if let Some(neighbors) = adj_deg.get(&station) {
                    for neighbor in neighbors {
                        if !pruned.contains(neighbor) {
                            if let Some(d) = degree.get_mut(neighbor) {
                                *d = d.saturating_sub(1);
                                if *d == 1 && !pinned.contains(neighbor) {
                                    stack.push(*neighbor);
                                }
                            }
                        }
                    }
                }
            }
            pruned
        };

        // Update shots based on solved coordinates
        for section in self
            .sections
            .iter_mut()
            .filter(|s| component.contains(&s.id))
        {
            for idx in 0..section.shots.len() {
                let station_i = StationRef::new(section.id, idx as u32);
                let station_j = StationRef::new(section.id, (idx + 1) as u32);

                // Skip spur shots — they have no loop redundancy and must
                // not be modified by the adjustment.
                if spur_stations.contains(&station_i) || spur_stations.contains(&station_j) {
                    continue;
                }

                let root_i = *station_root
                    .get(&station_i)
                    .ok_or_else(|| "Missing station root".to_string())?;
                let root_j = *station_root
                    .get(&station_j)
                    .ok_or_else(|| "Missing station root".to_string())?;

                // Skip shots within the same constraint group — both endpoints
                // share the same solved position, so the shot displacement would
                // collapse to zero. These shots are internal to a rigid group
                // (connected via merges/closures) and should not be modified.
                if root_i == root_j {
                    continue;
                }

                let coords_i = group_coords
                    .get(&root_i)
                    .ok_or_else(|| "Missing solved coordinates".to_string())?;
                let coords_j = group_coords
                    .get(&root_j)
                    .ok_or_else(|| "Missing solved coordinates".to_string())?;

                let offset_i = station_offsets
                    .get(&station_i)
                    .copied()
                    .unwrap_or((0.0, 0.0, 0.0));
                let offset_j = station_offsets
                    .get(&station_j)
                    .copied()
                    .unwrap_or((0.0, 0.0, 0.0));

                let base_i = Coordinates::new(
                    coords_i.x - offset_i.0,
                    coords_i.y - offset_i.1,
                    coords_i.z - offset_i.2,
                );
                let base_j = Coordinates::new(
                    coords_j.x - offset_j.0,
                    coords_j.y - offset_j.1,
                    coords_j.z - offset_j.2,
                );

                let shot = section
                    .shots
                    .get_mut(idx)
                    .ok_or_else(|| "Shot not found for LSQ update".to_string())?;
                // Only adjust horizontal geometry (azimuth + length); depths stay untouched.
                Self::update_shot_horizontal_only(shot, base_j.x - base_i.x, base_j.y - base_i.y);
            }
        }

        // Recompute coordinates now that the shots above were rewritten. The
        // section-alignment phase below compares each station's *post-update*
        // position against its solved target, so it must not reuse `raw_coords`
        // (the pre-update measured snapshot). Same component-scoped O(n) batch.
        let post_update_coords = self.compute_component_raw_coords(component);

        // Align each section's absolute position to solved coordinates (rigid XY translation).
        // This prevents merged stations in different sections from drifting apart.
        // Only X and Y are compared/applied; Z (depth) is not adjusted.
        let mut section_deltas: HashMap<SectionId, (f64, f64)> = HashMap::new();
        for section in self.sections.iter().filter(|s| component.contains(&s.id)) {
            let mut delta_xy: Option<(f64, f64)> = None;
            for idx in 0..=section.shots.len() {
                let station = StationRef::new(section.id, idx as u32);
                // Skip spur stations — their shots were not updated, so their
                // current positions don't match the solved positions.
                if spur_stations.contains(&station) {
                    continue;
                }
                let root = *station_root.get(&station).unwrap_or(&station);
                let target = group_coords
                    .get(&root)
                    .ok_or_else(|| "Missing solved coordinates".to_string())?;
                let current = post_update_coords
                    .get(&station)
                    .copied()
                    .ok_or_else(|| "Failed to compute station coordinates".to_string())?;
                let dx = target.x - current.x;
                let dy = target.y - current.y;
                if let Some((ex, ey)) = delta_xy {
                    if (ex - dx).abs() > 1e-6 || (ey - dy).abs() > 1e-6 {
                        return Err(
                            "Least squares adjustment produced inconsistent section translation"
                                .to_string(),
                        );
                    }
                } else {
                    delta_xy = Some((dx, dy));
                }
            }
            // For all-spur sections (no non-spur station set a delta), derive the
            // translation from the merge attachment point.  That station's group
            // is shared with a loop station, so its solved position is exact.
            if delta_xy.is_none() {
                for merge in &self.station_merges {
                    let local_key = if merge.station_a.section_id == section.id
                        && component.contains(&merge.station_b.section_id)
                    {
                        &merge.station_a
                    } else if merge.station_b.section_id == section.id
                        && component.contains(&merge.station_a.section_id)
                    {
                        &merge.station_b
                    } else {
                        continue;
                    };
                    let Some(local) = self.resolve_key(local_key) else {
                        continue;
                    };
                    let root = *station_root.get(&local).unwrap_or(&local);
                    if let (Some(target), Some(current)) = (
                        group_coords.get(&root),
                        post_update_coords.get(&local).copied(),
                    ) {
                        delta_xy = Some((target.x - current.x, target.y - current.y));
                        break;
                    }
                }
            }
            if let Some((dx, dy)) = delta_xy {
                if dx.abs() > 1e-9 || dy.abs() > 1e-9 {
                    section_deltas.insert(section.id, (dx, dy));
                }
            }
        }

        for (section_id, (dx, dy)) in section_deltas {
            self.adjust_section_offset(section_id, dx, dy);
        }

        self.debug_assert_merge_alignment("adjust_loop_closures");
        Ok(())
    }

    fn recompute_closure_metrics_for_component(&mut self, component: &HashSet<SectionId>) {
        let mut updates = Vec::new();
        for (idx, closure) in self.loop_closures.iter().enumerate() {
            if component.contains(&closure.station_a.section_id)
                && component.contains(&closure.station_b.section_id)
            {
                if let (Some(a), Some(b)) = (
                    self.resolve_key(&closure.station_a),
                    self.resolve_key(&closure.station_b),
                ) {
                    if let Ok(metrics) = self.compute_closure_metrics(a, b) {
                        updates.push((idx, metrics));
                    }
                }
            }
        }

        for (idx, metrics) in updates {
            if let Some(closure) = self.loop_closures.get_mut(idx) {
                closure.path_length = metrics.path_length;
                closure.misclosure_distance = metrics.misclosure_distance;
                closure.error_percentage = metrics.error_percentage;
                closure.horizontal_misclosure = metrics.horizontal_misclosure;
                closure.vertical_misclosure = metrics.vertical_misclosure;
            }
        }
    }

    pub(crate) fn build_section_lookup(&self) -> HashMap<SectionId, &Section> {
        self.sections.iter().map(|s| (s.id, s)).collect()
    }

    pub(crate) fn build_merge_adjacency(
        &self,
        section_lookup: &HashMap<SectionId, &Section>,
    ) -> HashMap<StationRef, Vec<StationRef>> {
        let mut adjacency: HashMap<StationRef, Vec<StationRef>> = HashMap::new();
        for merge in &self.station_merges {
            if !section_lookup.contains_key(&merge.station_a.section_id)
                || !section_lookup.contains_key(&merge.station_b.section_id)
            {
                continue;
            }
            if let (Some(a), Some(b)) = (
                self.resolve_key(&merge.station_a),
                self.resolve_key(&merge.station_b),
            ) {
                adjacency.entry(a).or_default().push(b);
                adjacency.entry(b).or_default().push(a);
            }
        }
        adjacency
    }

    fn shortest_path_with_target<F>(
        &self,
        start: StationRef,
        is_target: F,
    ) -> Option<(StationRef, HashMap<StationRef, (StationRef, PathEdge)>)>
    where
        F: Fn(StationRef) -> bool,
    {
        let section_lookup = self.build_section_lookup();
        let merge_adj = self.build_merge_adjacency(&section_lookup);

        // Validate start station exists
        let start_section = section_lookup.get(&start.section_id)?;
        if start.station_index as usize > start_section.shots.len() {
            return None;
        }

        let mut dist: HashMap<StationRef, f64> = HashMap::new();
        let mut prev: HashMap<StationRef, (StationRef, PathEdge)> = HashMap::new();
        let mut heap = BinaryHeap::new();

        dist.insert(start, 0.0);
        heap.push(HeapItem {
            cost: 0.0,
            node: start,
        });

        while let Some(HeapItem { cost, node }) = heap.pop() {
            if let Some(&known) = dist.get(&node) {
                if cost > known + 1e-9 {
                    continue;
                }
            }

            if is_target(node) {
                return Some((node, prev));
            }

            let Some(section) = section_lookup.get(&node.section_id) else {
                continue;
            };

            // Previous station
            if node.station_index > 0 {
                let prev_index = node.station_index - 1;
                if (prev_index as usize) <= section.shots.len() {
                    let shot_len = section
                        .shots
                        .get(prev_index as usize)
                        .map_or(0.0, |s| s.length);
                    let neighbor = StationRef::new(node.section_id, prev_index);
                    let next_cost = cost + shot_len;
                    if dist.get(&neighbor).is_none_or(|&d| next_cost < d - 1e-9) {
                        dist.insert(neighbor, next_cost);
                        prev.insert(
                            neighbor,
                            (
                                node,
                                PathEdge::Shot {
                                    section_id: node.section_id,
                                    shot_index: prev_index as usize,
                                    forward: false,
                                },
                            ),
                        );
                        heap.push(HeapItem {
                            cost: next_cost,
                            node: neighbor,
                        });
                    }
                }
            }

            // Next station
            if (node.station_index as usize) < section.shots.len() {
                let next_index = node.station_index + 1;
                let shot_len = section
                    .shots
                    .get(node.station_index as usize)
                    .map_or(0.0, |s| s.length);
                let neighbor = StationRef::new(node.section_id, next_index);
                let next_cost = cost + shot_len;
                if dist.get(&neighbor).is_none_or(|&d| next_cost < d - 1e-9) {
                    dist.insert(neighbor, next_cost);
                    prev.insert(
                        neighbor,
                        (
                            node,
                            PathEdge::Shot {
                                section_id: node.section_id,
                                shot_index: node.station_index as usize,
                                forward: true,
                            },
                        ),
                    );
                    heap.push(HeapItem {
                        cost: next_cost,
                        node: neighbor,
                    });
                }
            }

            // Merge neighbors (zero distance)
            if let Some(neighbors) = merge_adj.get(&node) {
                for &neighbor in neighbors {
                    let next_cost = cost;
                    if dist.get(&neighbor).is_none_or(|&d| next_cost < d - 1e-9) {
                        dist.insert(neighbor, next_cost);
                        prev.insert(neighbor, (node, PathEdge::Merge));
                        heap.push(HeapItem {
                            cost: next_cost,
                            node: neighbor,
                        });
                    }
                }
            }
        }

        None
    }

    fn reconstruct_path(
        start: StationRef,
        goal: StationRef,
        prev: &HashMap<StationRef, (StationRef, PathEdge)>,
    ) -> Option<StationPath> {
        let mut steps_rev: Vec<PathStep> = Vec::new();
        let mut current = goal;
        while current != start {
            let (p, edge) = prev.get(&current).copied()?;
            steps_rev.push(PathStep { to: current, edge });
            current = p;
        }
        steps_rev.reverse();
        Some(StationPath {
            start,
            steps: steps_rev,
        })
    }

    fn shortest_path_shots_merges(
        &self,
        start: StationRef,
        goal: StationRef,
    ) -> Option<StationPath> {
        let (found, prev) = self.shortest_path_with_target(start, |node| node == goal)?;
        Self::reconstruct_path(start, found, &prev)
    }

    fn shortest_path_to_any_zero_datum(
        &self,
        start: StationRef,
    ) -> Option<(StationRef, StationPath)> {
        if self.zero_datums.is_empty() {
            return None;
        }
        let zero_set: HashSet<StationRef> = self
            .zero_datums
            .iter()
            .filter_map(|zd| self.resolve_key(&zd.station_ref))
            .collect();
        let (found, prev) =
            self.shortest_path_with_target(start, |node| zero_set.contains(&node))?;
        let path = Self::reconstruct_path(start, found, &prev)?;
        Some((found, path))
    }

    fn build_colocated_groups(&self) -> HashMap<StationRef, Vec<StationRef>> {
        let mut parent: HashMap<StationRef, StationRef> = HashMap::new();
        let mut rank: HashMap<StationRef, usize> = HashMap::new();

        for section in &self.sections {
            for idx in 0..=section.shots.len() {
                let sr = StationRef::new(section.id, idx as u32);
                parent.insert(sr, sr);
                rank.insert(sr, 0);
            }
        }

        fn find(parent: &mut HashMap<StationRef, StationRef>, x: StationRef) -> StationRef {
            let mut current = x;
            while let Some(&p) = parent.get(&current) {
                if p == current {
                    break;
                }
                current = p;
            }
            let mut node = x;
            while let Some(&p) = parent.get(&node) {
                if p == current {
                    break;
                }
                parent.insert(node, current);
                node = p;
            }
            current
        }

        fn union(
            parent: &mut HashMap<StationRef, StationRef>,
            rank: &mut HashMap<StationRef, usize>,
            a: StationRef,
            b: StationRef,
        ) {
            let ra = find(parent, a);
            let rb = find(parent, b);
            if ra == rb {
                return;
            }
            let rank_a = *rank.get(&ra).unwrap_or(&0);
            let rank_b = *rank.get(&rb).unwrap_or(&0);
            match rank_a.cmp(&rank_b) {
                Ordering::Less => {
                    parent.insert(ra, rb);
                }
                Ordering::Greater => {
                    parent.insert(rb, ra);
                }
                Ordering::Equal => {
                    parent.insert(rb, ra);
                    rank.insert(ra, rank_a + 1);
                }
            }
        }

        for merge in &self.station_merges {
            if let (Some(a), Some(b)) = (
                self.resolve_key(&merge.station_a),
                self.resolve_key(&merge.station_b),
            ) {
                union(&mut parent, &mut rank, a, b);
            }
        }

        for closure in &self.loop_closures {
            if !closure.is_aligned {
                continue;
            }
            if let (Some(a), Some(b)) = (
                self.resolve_key(&closure.station_a),
                self.resolve_key(&closure.station_b),
            ) {
                union(&mut parent, &mut rank, a, b);
            }
        }

        let mut groups: HashMap<StationRef, Vec<StationRef>> = HashMap::new();
        for section in &self.sections {
            for idx in 0..=section.shots.len() {
                let sr = StationRef::new(section.id, idx as u32);
                let root = find(&mut parent, sr);
                groups.entry(root).or_default().push(sr);
            }
        }

        groups
    }

    fn build_merge_groups(&self) -> HashMap<StationRef, Vec<StationRef>> {
        let mut parent: HashMap<StationRef, StationRef> = HashMap::new();
        let mut rank: HashMap<StationRef, usize> = HashMap::new();

        for section in &self.sections {
            for idx in 0..=section.shots.len() {
                let sr = StationRef::new(section.id, idx as u32);
                parent.insert(sr, sr);
                rank.insert(sr, 0);
            }
        }

        fn find(parent: &mut HashMap<StationRef, StationRef>, x: StationRef) -> StationRef {
            let mut current = x;
            while let Some(&p) = parent.get(&current) {
                if p == current {
                    break;
                }
                current = p;
            }
            let mut node = x;
            while let Some(&p) = parent.get(&node) {
                if p == current {
                    break;
                }
                parent.insert(node, current);
                node = p;
            }
            current
        }

        fn union(
            parent: &mut HashMap<StationRef, StationRef>,
            rank: &mut HashMap<StationRef, usize>,
            a: StationRef,
            b: StationRef,
        ) {
            let ra = find(parent, a);
            let rb = find(parent, b);
            if ra == rb {
                return;
            }
            let rank_a = *rank.get(&ra).unwrap_or(&0);
            let rank_b = *rank.get(&rb).unwrap_or(&0);
            match rank_a.cmp(&rank_b) {
                Ordering::Less => {
                    parent.insert(ra, rb);
                }
                Ordering::Greater => {
                    parent.insert(rb, ra);
                }
                Ordering::Equal => {
                    parent.insert(rb, ra);
                    rank.insert(ra, rank_a + 1);
                }
            }
        }

        for merge in &self.station_merges {
            if let (Some(a), Some(b)) = (
                self.resolve_key(&merge.station_a),
                self.resolve_key(&merge.station_b),
            ) {
                union(&mut parent, &mut rank, a, b);
            }
        }

        let mut groups: HashMap<StationRef, Vec<StationRef>> = HashMap::new();
        for section in &self.sections {
            for idx in 0..=section.shots.len() {
                let sr = StationRef::new(section.id, idx as u32);
                let root = find(&mut parent, sr);
                groups.entry(root).or_default().push(sr);
            }
        }

        groups
    }

    fn apply_station_move_internal(
        &mut self,
        station_ref: StationRef,
        delta: Coordinates,
    ) -> Result<(), String> {
        if self
            .zero_datums
            .iter()
            .any(|zd| self.key_is_ref(&zd.station_ref, station_ref))
            && Self::coords_norm(delta) > 1e-9
        {
            error!(
                station_ref = ?station_ref,
                delta = ?delta,
                purpose = "protect zero datum position",
                "Zero datum station move requested outside GPS update"
            );
        }

        let existing = self
            .station_offset_for_ref(station_ref)
            .unwrap_or((0.0, 0.0, 0.0));
        let total_dx = existing.0 + delta.x;
        let total_dy = existing.1 + delta.y;
        let total_dz = existing.2 + delta.z;

        let Some(section) = self
            .sections
            .iter_mut()
            .find(|s| s.id == station_ref.section_id)
        else {
            return Err("Section not found".to_string());
        };

        let idx = station_ref.station_index as usize;
        if idx > section.shots.len() {
            return Err("Invalid station index".to_string());
        }

        if idx == 0 && (total_dx != 0.0 || total_dy != 0.0) {
            let current = self
                .section_offsets
                .get(&station_ref.section_id)
                .copied()
                .unwrap_or((0.0, 0.0));
            self.section_offsets.insert(
                station_ref.section_id,
                (current.0 + total_dx, current.1 + total_dy),
            );
        }

        if idx > 0 {
            if let Some(shot) = section.shots.get_mut(idx - 1) {
                let azi_rad = shot.average_azimuth().to_radians();
                let old_horizontal = shot.horizontal_length();
                let old_dx = old_horizontal * azi_rad.sin();
                let old_dy = old_horizontal * azi_rad.cos();
                let new_dx = old_dx + total_dx;
                let new_dy = old_dy + total_dy;
                let new_horizontal = (new_dx * new_dx + new_dy * new_dy).sqrt();
                let new_dz = (shot.depth_out + total_dz) - shot.depth_in;
                let new_len = (new_horizontal * new_horizontal + new_dz * new_dz).sqrt();
                let new_azi = if new_horizontal > 1e-9 {
                    new_dx.atan2(new_dy).to_degrees().rem_euclid(360.0)
                } else {
                    shot.average_azimuth()
                };
                shot.length = new_len;
                shot.azimuth_in = new_azi;
                shot.azimuth_out = new_azi;
                shot.depth_out += total_dz;
                let pitch = new_dz.atan2(new_horizontal).to_degrees();
                shot.pitch_in = Some(pitch);
                shot.pitch_out = Some(pitch);
            }
        }

        if let Some(shot) = section.shots.get_mut(idx) {
            let azi_rad = shot.average_azimuth().to_radians();
            let old_horizontal = shot.horizontal_length();
            let old_dx = old_horizontal * azi_rad.sin();
            let old_dy = old_horizontal * azi_rad.cos();
            let new_dx = old_dx - total_dx;
            let new_dy = old_dy - total_dy;
            let new_horizontal = (new_dx * new_dx + new_dy * new_dy).sqrt();
            let new_dz = shot.depth_out - (shot.depth_in + total_dz);
            let new_len = (new_horizontal * new_horizontal + new_dz * new_dz).sqrt();
            let new_azi = if new_horizontal > 1e-9 {
                new_dx.atan2(new_dy).to_degrees().rem_euclid(360.0)
            } else {
                shot.average_azimuth()
            };
            shot.length = new_len;
            shot.azimuth_in = new_azi;
            shot.azimuth_out = new_azi;
            shot.depth_in += total_dz;
            let pitch = new_dz.atan2(new_horizontal).to_degrees();
            shot.pitch_in = Some(pitch);
            shot.pitch_out = Some(pitch);
        }

        if let Some(key) = self.key_for_ref(station_ref) {
            self.station_offsets.remove(&key);
        }
        Ok(())
    }

    // Deferred: create-time distribution algorithms are disabled; retained for potential future use.
    fn distribute_closure_error_internal(
        &mut self,
        station_a: StationRef,
        station_b: StationRef,
        strategy: ClosureStrategy,
        extra_fixed: Option<&HashSet<StationRef>>,
        use_merge_groups: bool,
    ) -> Result<(), String> {
        let colocated_groups = if use_merge_groups {
            self.build_merge_groups()
        } else {
            self.build_colocated_groups()
        };
        let mut station_to_group: HashMap<StationRef, StationRef> = HashMap::new();
        for (root, members) in &colocated_groups {
            for member in members {
                station_to_group.insert(*member, *root);
            }
        }
        let root_for =
            |station: StationRef| station_to_group.get(&station).copied().unwrap_or(station);
        let mut zero_datum_set: HashSet<StationRef> = self
            .zero_datums
            .iter()
            .filter_map(|zd| self.resolve_key(&zd.station_ref))
            .collect();
        if let Some(extra) = extra_fixed {
            zero_datum_set.extend(extra.iter().copied());
        }

        debug!(
            station_a = ?station_a,
            station_b = ?station_b,
            strategy = ?strategy,
            use_merge_groups,
            extra_fixed_count = extra_fixed.map_or(0, HashSet::len),
            group_count = colocated_groups.len(),
            zero_datum_count = zero_datum_set.len(),
            purpose = "distribute loop closure error",
            "Starting closure error distribution"
        );

        let is_group_anchored =
            |station: StationRef, groups: &HashMap<StationRef, Vec<StationRef>>| -> bool {
                let root = groups
                    .iter()
                    .find(|(_, members)| members.contains(&station))
                    .map(|(r, _)| *r);
                if let Some(root) = root {
                    if let Some(members) = groups.get(&root) {
                        return members.iter().any(|m| zero_datum_set.contains(m));
                    }
                }
                false
            };

        let a_anchored = is_group_anchored(station_a, &colocated_groups);
        let b_anchored = is_group_anchored(station_b, &colocated_groups);

        let (start, end) = if b_anchored && !a_anchored {
            (station_b, station_a)
        } else {
            (station_a, station_b)
        };
        debug!(
            station_a = ?station_a,
            station_b = ?station_b,
            a_anchored,
            b_anchored,
            start = ?start,
            end = ?end,
            purpose = "select closure anchor order",
            "Resolved anchor order for closure distribution"
        );

        let coords_a_orig = self
            .compute_station_raw_coords(station_a)
            .ok_or_else(|| "Failed to compute coordinates for station A".to_string())?;
        let coords_b_orig = self
            .compute_station_raw_coords(station_b)
            .ok_or_else(|| "Failed to compute coordinates for station B".to_string())?;

        let coords_start = if start == station_a {
            coords_a_orig
        } else {
            coords_b_orig
        };
        let coords_end = if end == station_a {
            coords_a_orig
        } else {
            coords_b_orig
        };

        let base_correction = Self::coords_sub(coords_end, coords_start);
        let correction = Self::coords_sub(coords_b_orig, coords_a_orig);
        trace!(
            base_correction = ?base_correction,
            correction = ?correction,
            purpose = "compute closure correction vectors",
            "Computed closure correction vectors"
        );

        let mut targets: HashMap<StationRef, Coordinates> = HashMap::new();
        let section_lookup = self.build_section_lookup();

        let apply_path_targets = |path: &StationPath,
                                  start_coords: Coordinates,
                                  correction_vec: Coordinates,
                                  sign: f64,
                                  total_len: f64,
                                  shot_count: usize,
                                  targets: &mut HashMap<StationRef, Coordinates>|
         -> Result<(), String> {
            let mut current = start_coords;
            let mut current_root = root_for(path.start);
            if let Some(existing) = targets.get(&current_root) {
                if !Self::coords_close(*existing, current, 1e-6) {
                    return Err("Inconsistent target coordinates on path start".to_string());
                }
            } else {
                targets.insert(current_root, current);
            }

            for step in &path.steps {
                let next_root = root_for(step.to);
                if next_root == current_root {
                    continue;
                }
                let vec = match step.edge {
                    PathEdge::Shot {
                        section_id,
                        shot_index,
                        forward,
                    } => {
                        let section = section_lookup
                            .get(&section_id)
                            .ok_or_else(|| "Section not found for closure path".to_string())?;
                        let shot = section
                            .shots
                            .get(shot_index)
                            .ok_or_else(|| "Shot not found for closure path".to_string())?;
                        let mut v = Self::shot_vector_along(shot, forward);
                        let weight = if strategy == ClosureStrategy::ProportionalByLength {
                            shot.length / total_len
                        } else {
                            1.0 / shot_count as f64
                        };
                        let corr = Self::coords_scale(correction_vec, sign * weight);
                        v = Self::coords_add(v, corr);
                        v
                    }
                    PathEdge::Merge => Coordinates::new(0.0, 0.0, 0.0),
                };
                current = Self::coords_add(current, vec);
                if let Some(existing) = targets.get(&next_root) {
                    if !Self::coords_close(*existing, current, 1e-6) {
                        return Err("Inconsistent target coordinates in closure path".to_string());
                    }
                } else {
                    targets.insert(next_root, current);
                }
                current_root = next_root;
            }
            Ok(())
        };

        let add_path_stats = |path: &StationPath, total_len: &mut f64, shot_count: &mut usize| {
            let mut current_root = root_for(path.start);
            for step in &path.steps {
                let next_root = root_for(step.to);
                if next_root == current_root {
                    continue;
                }
                if let PathEdge::Shot {
                    section_id,
                    shot_index,
                    ..
                } = step.edge
                {
                    if let Some(section) = section_lookup.get(&section_id) {
                        if let Some(shot) = section.shots.get(shot_index) {
                            *total_len += shot.length;
                            *shot_count += 1;
                        }
                    }
                }
                current_root = next_root;
            }
        };

        let loop_path_ab = self.shortest_path_shots_merges(station_a, station_b);

        if let Some(loop_path) = loop_path_ab {
            // Inspect loop path for zero datum anchors
            let mut zero_nodes: Vec<StationRef> = Vec::new();
            let mut nodes: Vec<StationRef> = Vec::with_capacity(loop_path.steps.len() + 1);
            nodes.push(loop_path.start);
            for step in &loop_path.steps {
                nodes.push(step.to);
            }
            for node in nodes {
                if zero_datum_set.contains(&node) {
                    zero_nodes.push(node);
                }
            }
            zero_nodes.sort_by(|a, b| {
                (a.section_id, a.station_index).cmp(&(b.section_id, b.station_index))
            });
            zero_nodes.dedup();

            if zero_nodes.len() > 1 {
                return Err("Multiple zero datum stations in closure path".to_string());
            }

            if zero_nodes.len() == 1 && zero_nodes[0] != station_a && zero_nodes[0] != station_b {
                let anchor = zero_nodes[0];
                let path_a = self
                    .shortest_path_shots_merges(anchor, station_a)
                    .ok_or_else(|| {
                        "Failed to build path from zero datum to station A".to_string()
                    })?;
                let path_b = self
                    .shortest_path_shots_merges(anchor, station_b)
                    .ok_or_else(|| {
                        "Failed to build path from zero datum to station B".to_string()
                    })?;

                let mut total_len = 0.0;
                let mut shot_count = 0usize;
                add_path_stats(&path_a, &mut total_len, &mut shot_count);
                add_path_stats(&path_b, &mut total_len, &mut shot_count);

                if (strategy == ClosureStrategy::ProportionalByLength && total_len <= 0.0)
                    || (strategy == ClosureStrategy::EqualDistribution && shot_count == 0)
                {
                    return Err("No distributable shots found for zero datum loop path".to_string());
                }

                let coords_anchor = self.compute_station_raw_coords(anchor).ok_or_else(|| {
                    "Failed to compute coordinates for zero datum anchor".to_string()
                })?;

                apply_path_targets(
                    &path_a,
                    coords_anchor,
                    correction,
                    1.0,
                    total_len,
                    shot_count,
                    &mut targets,
                )?;
                apply_path_targets(
                    &path_b,
                    coords_anchor,
                    correction,
                    -1.0,
                    total_len,
                    shot_count,
                    &mut targets,
                )?;
            } else {
                let path = if start == station_a && end == station_b {
                    loop_path
                } else {
                    self.shortest_path_shots_merges(start, end)
                        .ok_or_else(|| "Failed to build closure path".to_string())?
                };

                let mut total_len = 0.0;
                let mut shot_count = 0usize;
                add_path_stats(&path, &mut total_len, &mut shot_count);

                if (strategy == ClosureStrategy::ProportionalByLength && total_len <= 0.0)
                    || (strategy == ClosureStrategy::EqualDistribution && shot_count == 0)
                {
                    warn!(
                        strategy = ?strategy,
                        total_len,
                        shot_count,
                        purpose = "distribute loop closure error",
                        "No distributable shots found for closure path"
                    );
                    return Err("No distributable shots found for closure path".to_string());
                }

                let coords_start = if path.start == station_a {
                    coords_a_orig
                } else {
                    coords_b_orig
                };
                apply_path_targets(
                    &path,
                    coords_start,
                    base_correction,
                    -1.0,
                    total_len,
                    shot_count,
                    &mut targets,
                )?;
            }
        } else {
            // Fallback: use zero datum paths
            debug!(
                station_a = ?station_a,
                station_b = ?station_b,
                strategy = ?strategy,
                purpose = "distribute loop closure error",
                "Using zero datum fallback paths for closure distribution"
            );
            let (zd_a, _) = self
                .shortest_path_to_any_zero_datum(station_a)
                .ok_or_else(|| "No zero datum path found from station A".to_string())?;
            let (zd_b, _) = self
                .shortest_path_to_any_zero_datum(station_b)
                .ok_or_else(|| "No zero datum path found from station B".to_string())?;

            let path_a = self
                .shortest_path_shots_merges(zd_a, station_a)
                .ok_or_else(|| "Failed to build path from zero datum to station A".to_string())?;
            let path_b = self
                .shortest_path_shots_merges(zd_b, station_b)
                .ok_or_else(|| "Failed to build path from zero datum to station B".to_string())?;

            let coords_zd_a = self
                .compute_station_raw_coords(zd_a)
                .ok_or_else(|| "Failed to compute coordinates for zero datum A".to_string())?;
            let coords_zd_b = self
                .compute_station_raw_coords(zd_b)
                .ok_or_else(|| "Failed to compute coordinates for zero datum B".to_string())?;

            let mut total_len = 0.0;
            let mut shot_count = 0usize;
            add_path_stats(&path_a, &mut total_len, &mut shot_count);
            add_path_stats(&path_b, &mut total_len, &mut shot_count);

            if (strategy == ClosureStrategy::ProportionalByLength && total_len <= 0.0)
                || (strategy == ClosureStrategy::EqualDistribution && shot_count == 0)
            {
                warn!(
                    strategy = ?strategy,
                    total_len,
                    shot_count,
                    purpose = "distribute loop closure error",
                    "No distributable shots found for zero datum fallback"
                );
                return Err("No distributable shots found for zero datum fallback".to_string());
            }

            apply_path_targets(
                &path_a,
                coords_zd_a,
                correction,
                1.0,
                total_len,
                shot_count,
                &mut targets,
            )?;
            apply_path_targets(
                &path_b,
                coords_zd_b,
                correction,
                -1.0,
                total_len,
                shot_count,
                &mut targets,
            )?;
        }

        let mut group_delta: HashMap<StationRef, Coordinates> = HashMap::new();
        for (root, target) in &targets {
            let current = self
                .compute_station_raw_coords(*root)
                .ok_or_else(|| "Failed to compute station coordinates".to_string())?;
            let delta = Self::coords_sub(*target, current);
            if Self::coords_norm(delta) > 1e-9 {
                group_delta.insert(*root, delta);
            }
        }
        debug!(
            target_count = targets.len(),
            move_group_count = group_delta.len(),
            purpose = "distribute loop closure error",
            "Computed closure target deltas"
        );

        let mut final_deltas: HashMap<StationRef, Coordinates> = HashMap::new();
        for (root, delta) in &group_delta {
            if let Some(members) = colocated_groups.get(root) {
                for member in members {
                    final_deltas.insert(*member, *delta);
                }
            } else {
                final_deltas.insert(*root, *delta);
            }
        }

        // Prevent moving zero datum stations
        for (station, delta) in &final_deltas {
            if zero_datum_set.contains(station) && Self::coords_norm(*delta) > 1e-9 {
                error!(
                    station_ref = ?station,
                    delta = ?delta,
                    strategy = ?strategy,
                    purpose = "protect zero datum position",
                    "Closure distribution would move a zero datum station"
                );
                return Err("Closure distribution would move a zero datum station".to_string());
            }
        }

        // Apply moves
        let mut moves: Vec<(StationRef, Coordinates)> = final_deltas.into_iter().collect();
        moves.sort_by(|a, b| {
            (a.0.section_id, a.0.station_index).cmp(&(b.0.section_id, b.0.station_index))
        });
        for (station, delta) in moves {
            if Self::coords_norm(delta) <= 1e-9 {
                continue;
            }
            self.apply_station_move_internal(station, delta)?;
        }

        // Ensure endpoints overlap exactly
        let coords_a_after = self
            .compute_station_raw_coords(station_a)
            .ok_or_else(|| "Failed to compute station A after distribution".to_string())?;
        let coords_b_after = self
            .compute_station_raw_coords(station_b)
            .ok_or_else(|| "Failed to compute station B after distribution".to_string())?;
        let residual = Self::coords_sub(coords_b_after, coords_a_after);
        if Self::coords_norm(residual) > 1e-6 {
            // Move B's group if possible, otherwise move A's group
            let b_root = colocated_groups
                .iter()
                .find(|(_, members)| members.contains(&station_b))
                .map_or(station_b, |(r, _)| *r);
            let a_root = colocated_groups
                .iter()
                .find(|(_, members)| members.contains(&station_a))
                .map_or(station_a, |(r, _)| *r);

            let b_anchor = colocated_groups
                .get(&b_root)
                .is_some_and(|members| members.iter().any(|m| zero_datum_set.contains(m)));
            let a_anchor = colocated_groups
                .get(&a_root)
                .is_some_and(|members| members.iter().any(|m| zero_datum_set.contains(m)));

            if !b_anchor {
                if let Some(members) = colocated_groups.get(&b_root) {
                    for member in members {
                        self.apply_station_move_internal(
                            *member,
                            Self::coords_scale(residual, -1.0),
                        )?;
                    }
                } else {
                    self.apply_station_move_internal(
                        station_b,
                        Self::coords_scale(residual, -1.0),
                    )?;
                }
            } else if !a_anchor {
                if let Some(members) = colocated_groups.get(&a_root) {
                    for member in members {
                        self.apply_station_move_internal(*member, residual)?;
                    }
                } else {
                    self.apply_station_move_internal(station_a, residual)?;
                }
            } else {
                error!(
                    residual = ?residual,
                    station_a = ?station_a,
                    station_b = ?station_b,
                    purpose = "align closure endpoints",
                    "Closure distribution failed to align endpoints without moving zero datum"
                );
                return Err("Closure distribution failed to align endpoints".to_string());
            }
        }

        Ok(())
    }

    #[expect(dead_code)]
    fn distribute_closure_error(
        &mut self,
        station_a: StationRef,
        station_b: StationRef,
        strategy: ClosureStrategy,
    ) -> Result<(), String> {
        self.distribute_closure_error_internal(station_a, station_b, strategy, None, false)
    }

    #[cfg(test)]
    pub(crate) fn test_distribute_closure_error(
        &mut self,
        station_a: StationRef,
        station_b: StationRef,
        strategy: ClosureStrategy,
    ) -> Result<(), String> {
        self.distribute_closure_error_internal(station_a, station_b, strategy, None, false)
    }

    // === Coordinate computation ===

    /// Compute all station coordinates from shots.
    /// Backward-compat wrapper that calls `compute_station_coordinates_with_progress(None)`.
    pub fn compute_station_coordinates(&self) -> Vec<Station> {
        self.compute_station_coordinates_with_progress(None)
    }

    /// Pick a deterministic anchor station for a component that has no zero datum.
    ///
    /// Returns the lexicographically smallest `(section_id, station_index)` station
    /// in the component. The anchor only fixes the otherwise-free absolute translation
    /// (gauge) of a datum-less component — the *shape* of the adjusted geometry is
    /// independent of this choice. Picking the lex-min keeps it stable and reproducible
    /// across reloads so the adjusted view doesn't jump between refreshes.
    fn default_anchor_for_component(&self, component: &HashSet<SectionId>) -> Option<StationRef> {
        self.sections
            .iter()
            .filter(|s| component.contains(&s.id))
            .flat_map(|s| (0..=s.shots.len()).map(move |idx| StationRef::new(s.id, idx as u32)))
            .min_by(|a, b| {
                a.section_id
                    .cmp(&b.section_id)
                    .then(a.station_index.cmp(&b.station_index))
            })
    }

    /// Whether a loop closure participates in the least-squares adjustment.
    /// Mirrors the strategy filter inside [`Self::adjust_loop_closures`]: `Move`
    /// closures are already coincident (snap-to-merge) and the deferred
    /// proportional/equal strategies are not solved.
    fn closure_is_eligible(strategy: ClosureStrategy) -> bool {
        matches!(
            strategy,
            ClosureStrategy::Batch | ClosureStrategy::LeastSquaresWeighted
        )
    }

    /// Plan which component anchors to feed the closure-adjustment solve.
    ///
    /// Returns one anchor per connected component that contains an eligible
    /// closure: a zero datum in the component when present, otherwise a
    /// deterministic default anchor (see [`Self::default_anchor_for_component`]).
    /// Computed from the *measured* topology so it can run once up front, before
    /// any adjustment mutates the working copy.
    fn plan_adjustment_anchors(&self) -> Vec<StationRef> {
        let mut anchors = Vec::new();
        let mut visited: HashSet<SectionId> = HashSet::new();
        for section in &self.sections {
            if visited.contains(&section.id) {
                continue;
            }
            let component = self.get_connected_section_ids(section.id);
            for sid in &component {
                visited.insert(*sid);
            }

            let has_eligible = self.loop_closures.iter().any(|lc| {
                Self::closure_is_eligible(lc.strategy)
                    && component.contains(&lc.station_a.section_id)
                    && component.contains(&lc.station_b.section_id)
            });
            if !has_eligible {
                continue;
            }

            // Anchor on a zero datum in the component when present, otherwise a
            // deterministic default so the gauge is reproducible across reloads.
            let anchor = self
                .zero_datums
                .iter()
                .find(|zd| component.contains(&zd.station_ref.section_id))
                .and_then(|zd| self.resolve_key(&zd.station_ref))
                .or_else(|| self.default_anchor_for_component(&component));

            if let Some(anchor) = anchor {
                anchors.push(anchor);
            }
        }
        anchors
    }

    /// Compute station coordinates with loop-closure adjustment applied as a
    /// **non-destructive derived view**.
    ///
    /// The measured project is never mutated: the proven adjustment runs on a
    /// throwaway clone and only the resulting coordinates are returned. The output
    /// is identical to the geometry users saw after the old "Run Adjustment" action,
    /// but it is recomputed live from intact measured data — so adding/removing
    /// closures always re-solves accurately instead of compounding on already-adjusted
    /// geometry. Each disconnected component is solved independently, anchored on a
    /// zero datum when present and otherwise on a deterministic default anchor.
    pub fn compute_adjusted_station_coordinates(
        &self,
        config: &ClosureAdjustmentConfig,
    ) -> Vec<Station> {
        // Fast path: nothing to adjust → adjusted == measured (skip the clone).
        if !self
            .loop_closures
            .iter()
            .any(|lc| Self::closure_is_eligible(lc.strategy))
        {
            return self.compute_station_coordinates();
        }

        self.clone().into_adjusted_station_coordinates(config)
    }

    /// By-value counterpart of [`Self::compute_adjusted_station_coordinates`] that
    /// consumes `self` as the working copy, so a caller already holding an owned
    /// clone (the IPC path in `AppState::get_adjusted_stations`) avoids a second
    /// full-project clone.
    ///
    /// The adjustment plan (which component anchors on what) is derived up front
    /// from the pristine measured topology, before any mutation. Each component is
    /// then solved on the working copy and **rolled back to measured on failure**:
    /// `adjust_loop_closures` mutates in place and can return `Err` *after* the
    /// solve has already moved stations (e.g. the post-solve zero-datum-fixed
    /// check), so without the rollback a failed component would render
    /// partially-adjusted geometry instead of the measured fallback the warning
    /// promises.
    ///
    /// Cost: the rollback snapshots the working copy once per eligible component,
    /// so a cache-miss solve clones the project `O(eligible components)` times.
    /// In practice that is one or two clones (most surveys are a single connected
    /// component), it only happens on a cache miss, and `adjust_least_squares`
    /// rewrites `section.shots` in place — so a cheaper offsets-only snapshot would
    /// be unsound. Revisit with a scoped {sections, offsets, closures} snapshot
    /// only if profiling large surveys shows the clones matter.
    pub fn into_adjusted_station_coordinates(
        self,
        config: &ClosureAdjustmentConfig,
    ) -> Vec<Station> {
        let anchors = self.plan_adjustment_anchors();
        let mut working = self;
        for anchor in anchors {
            let snapshot = working.clone();
            if let Err(e) =
                working.adjust_loop_closures(anchor, ClosureStrategy::LeastSquaresWeighted, config)
            {
                working = snapshot;
                warn!(
                    error = %e,
                    anchor = ?anchor,
                    purpose = "derive closure-adjusted view",
                    "Skipping closure adjustment for component; showing measured geometry"
                );
            }
        }
        working.compute_station_coordinates()
    }

    /// Compute all station coordinates from shots with optional progress callback.
    ///
    /// The callback receives (current, total) station counts for progress reporting.
    /// Total stations = shots + 1 per section (first station).
    pub fn compute_station_coordinates_with_progress(
        &self,
        mut on_progress: Option<&mut dyn FnMut(u32, u32)>,
    ) -> Vec<Station> {
        // Calculate total stations first for progress reporting
        let total_stations: u32 = self.sections.iter().map(|s| s.shots.len() as u32 + 1).sum();

        // Pre-compute absolute station depths using colocated groups.
        // Each station's Z is the average of surrounding shot depths across
        // all merge/closure partners — no cumulative dz walk needed.
        let t_phase = std::time::Instant::now();
        let colocated_groups = self.build_colocated_groups();
        tracing::debug!(
            ms = t_phase.elapsed().as_millis() as u64,
            groups = colocated_groups.len(),
            "compute_station_coordinates: build_colocated_groups"
        );
        let t_phase = std::time::Instant::now();
        let mut station_depths: HashMap<StationRef, f64> = HashMap::new();
        for group in colocated_groups.values() {
            let depth = self.compute_station_depth(group);
            for &sr in group {
                station_depths.insert(sr, depth);
            }
        }
        tracing::debug!(
            ms = t_phase.elapsed().as_millis() as u64,
            "compute_station_coordinates: depths loop"
        );
        let t_phase = std::time::Instant::now();

        let mut stations: Vec<Station> = Vec::new();
        let mut station_count = 0u32;

        for section in &self.sections {
            // Get section offset (from merges)
            let (offset_x, offset_y) = self
                .section_offsets
                .get(&section.id)
                .copied()
                .unwrap_or((0.0, 0.0));
            let mut current_xy = (offset_x, offset_y);

            // First station of section
            let first_station_ref = StationRef::new(section.id, 0);
            let z = station_depths
                .get(&first_station_ref)
                .copied()
                .unwrap_or(0.0);
            let mut station_coords = Coordinates::new(current_xy.0, current_xy.1, z);
            // Apply station offset if exists
            if let Some((ox, oy, oz)) = self.station_offset_for_ref(first_station_ref) {
                station_coords = Coordinates::new(
                    station_coords.x + ox,
                    station_coords.y + oy,
                    station_coords.z + oz,
                );
            }
            stations.push(Station::with_coordinates(first_station_ref, station_coords));
            station_count += 1;

            // Report progress for first station
            if let Some(ref mut cb) = on_progress {
                cb(station_count, total_stations);
            }

            // Compute subsequent stations from shots (X, Y walk; Z from pre-computed depths)
            for (i, shot) in section.shots.iter().enumerate() {
                let azimuth_rad = shot.average_azimuth().to_radians();
                let horizontal_length = shot.horizontal_length();

                // Compute new X, Y position
                let dx = horizontal_length * azimuth_rad.sin();
                let dy = horizontal_length * azimuth_rad.cos();
                current_xy.0 += dx;
                current_xy.1 += dy;

                let station_ref = StationRef::new(section.id, (i + 1) as u32);
                let z = station_depths.get(&station_ref).copied().unwrap_or(0.0);
                let mut station_coords = Coordinates::new(current_xy.0, current_xy.1, z);
                // Apply station offset if exists
                if let Some((ox, oy, oz)) = self.station_offset_for_ref(station_ref) {
                    station_coords = Coordinates::new(
                        station_coords.x + ox,
                        station_coords.y + oy,
                        station_coords.z + oz,
                    );
                }
                stations.push(Station::with_coordinates(station_ref, station_coords));
                station_count += 1;

                // Report progress after each station
                if let Some(ref mut cb) = on_progress {
                    cb(station_count, total_stations);
                }
            }
        }

        // NOTE: Global zero datum subtraction removed (fn-19-mmx.2).
        // Positioning is now controlled solely by section_offsets, which are
        // computed when set_zero_datum() is called.
        tracing::debug!(
            ms = t_phase.elapsed().as_millis() as u64,
            "compute_station_coordinates: xyz walk"
        );
        let t_phase = std::time::Instant::now();

        // Mark merged stations - build merge groups (transitive closure)
        // First, build a map of station_ref -> group_id using Union-Find logic
        let mut station_to_group: HashMap<StationRef, usize> = HashMap::new();
        let mut groups: Vec<Vec<StationRef>> = Vec::new();

        for merge in &self.station_merges {
            let (Some(sa), Some(sb)) = (
                self.resolve_key(&merge.station_a),
                self.resolve_key(&merge.station_b),
            ) else {
                continue;
            };
            let group_a = station_to_group.get(&sa).copied();
            let group_b = station_to_group.get(&sb).copied();

            match (group_a, group_b) {
                (None, None) => {
                    // Neither station is in a group, create a new group
                    let group_id = groups.len();
                    groups.push(vec![sa, sb]);
                    station_to_group.insert(sa, group_id);
                    station_to_group.insert(sb, group_id);
                }
                (Some(gid), None) => {
                    // station_a is in a group, add station_b to it
                    groups[gid].push(sb);
                    station_to_group.insert(sb, gid);
                }
                (None, Some(gid)) => {
                    // station_b is in a group, add station_a to it
                    groups[gid].push(sa);
                    station_to_group.insert(sa, gid);
                }
                (Some(gid_a), Some(gid_b)) => {
                    if gid_a != gid_b {
                        // Both are in different groups, merge the groups
                        // Move all from group_b to group_a
                        let group_b_members: Vec<StationRef> = groups[gid_b].drain(..).collect();
                        for member in &group_b_members {
                            station_to_group.insert(*member, gid_a);
                        }
                        groups[gid_a].extend(group_b_members);
                    }
                    // If same group, nothing to do
                }
            }
        }

        tracing::debug!(
            ms = t_phase.elapsed().as_millis() as u64,
            groups = groups.len(),
            "compute_station_coordinates: union-find groups"
        );
        let t_phase = std::time::Instant::now();

        // Now assign merged_with for each station based on their group
        for station in &mut stations {
            if let Some(&group_id) = station_to_group.get(&station.station_ref) {
                for member in &groups[group_id] {
                    if *member != station.station_ref {
                        station.merged_with.push(*member);
                    }
                }
            }
        }
        tracing::debug!(
            ms = t_phase.elapsed().as_millis() as u64,
            "compute_station_coordinates: merged_with"
        );
        let t_phase = std::time::Instant::now();

        // Populate closures_with for each station from loop_closures
        // For each closure, both endpoint stations (and their merged equivalents)
        // get a ClosureRef entry. Transitive closures go through merged stations.
        for closure in &self.loop_closures {
            let (Some(a_ref), Some(b_ref)) = (
                self.resolve_key(&closure.station_a),
                self.resolve_key(&closure.station_b),
            ) else {
                continue;
            };

            // Collect merged equivalents for each endpoint
            let a_group: Vec<StationRef> = station_to_group
                .get(&a_ref)
                .map_or_else(|| vec![a_ref], |&gid| groups[gid].clone());
            let b_group: Vec<StationRef> = station_to_group
                .get(&b_ref)
                .map_or_else(|| vec![b_ref], |&gid| groups[gid].clone());

            // Skip if both endpoints are in the same merge group (legacy data edge case)
            let a_group_id = station_to_group.get(&a_ref);
            let b_group_id = station_to_group.get(&b_ref);
            if a_group_id.is_some() && a_group_id == b_group_id {
                continue;
            }

            // For each station in A's group, add direct ref to B and transitive refs to B's merged partners
            for station in &mut stations {
                if a_group.contains(&station.station_ref) {
                    // Direct closure to station_b (skip self-references)
                    if station.station_ref != b_ref {
                        let via = if station.station_ref == a_ref {
                            None
                        } else {
                            Some(a_ref) // transitive: reached via the actual closure endpoint
                        };
                        station.closures_with.push(ClosureRef {
                            closure_id: closure.id,
                            station_ref: b_ref,
                            via_station: via,
                            is_transitive: via.is_some(),
                        });
                    }
                    // Transitive closures to B's merged partners (skip self-references)
                    for &b_member in &b_group {
                        if b_member != b_ref && b_member != station.station_ref {
                            station.closures_with.push(ClosureRef {
                                closure_id: closure.id,
                                station_ref: b_member,
                                via_station: Some(b_ref),
                                is_transitive: true,
                            });
                        }
                    }
                } else if b_group.contains(&station.station_ref) {
                    // Direct closure to station_a (skip self-references)
                    if station.station_ref != a_ref {
                        let via = if station.station_ref == b_ref {
                            None
                        } else {
                            Some(b_ref)
                        };
                        station.closures_with.push(ClosureRef {
                            closure_id: closure.id,
                            station_ref: a_ref,
                            via_station: via,
                            is_transitive: via.is_some(),
                        });
                    }
                    // Transitive closures to A's merged partners (skip self-references)
                    for &a_member in &a_group {
                        if a_member != a_ref && a_member != station.station_ref {
                            station.closures_with.push(ClosureRef {
                                closure_id: closure.id,
                                station_ref: a_member,
                                via_station: Some(a_ref),
                                is_transitive: true,
                            });
                        }
                    }
                }
            }
        }

        tracing::debug!(
            ms = t_phase.elapsed().as_millis() as u64,
            closures = self.loop_closures.len(),
            "compute_station_coordinates: closures_with"
        );
        let t_phase = std::time::Instant::now();

        // Closure-chain transitivity: when a station has direct closures to multiple
        // other stations, those other stations should see transitive closures to each
        // other via the shared station.
        //
        // Example: Station X has closures to Y and Z.
        //   Y should see: transitive closure to Z (via X)
        //   Z should see: transitive closure to Y (via X)
        //
        // The closure_id used is the one connecting the shared station to the far endpoint,
        // so the metrics displayed correspond to that specific loop closure.
        {
            // Collect direct (non-transitive) closure refs for each station
            let mut direct_closures: HashMap<StationRef, Vec<(u64, StationRef)>> = HashMap::new();
            for station in &stations {
                for cr in &station.closures_with {
                    if !cr.is_transitive {
                        direct_closures
                            .entry(station.station_ref)
                            .or_default()
                            .push((cr.closure_id, cr.station_ref));
                    }
                }
            }

            // For each station with 2+ direct closures, create chain-transitive refs
            // between all pairs of its closure partners
            let mut chain_transitive_refs: Vec<(StationRef, ClosureRef)> = Vec::new();
            for (shared_ref, endpoints) in &direct_closures {
                if endpoints.len() < 2 {
                    continue;
                }
                for i in 0..endpoints.len() {
                    for j in 0..endpoints.len() {
                        if i == j {
                            continue;
                        }
                        let (_, target_i) = &endpoints[i];
                        let (closure_j, target_j) = &endpoints[j];

                        // target_i should see transitive closure to target_j via shared_ref
                        // using closure_j's id (the closure connecting shared_ref to target_j)
                        if target_i != target_j {
                            chain_transitive_refs.push((
                                *target_i,
                                ClosureRef {
                                    closure_id: *closure_j,
                                    station_ref: *target_j,
                                    via_station: Some(*shared_ref),
                                    is_transitive: true,
                                },
                            ));
                        }
                    }
                }
            }

            // Apply chain-transitive refs, avoiding duplicates
            for (station_ref, new_ref) in chain_transitive_refs {
                if let Some(station) = stations.iter_mut().find(|s| s.station_ref == station_ref) {
                    let already_exists = station.closures_with.iter().any(|cr| {
                        cr.station_ref == new_ref.station_ref
                            && cr.via_station == new_ref.via_station
                    });
                    if !already_exists {
                        station.closures_with.push(new_ref);
                    }
                }
            }
        }

        tracing::debug!(
            ms = t_phase.elapsed().as_millis() as u64,
            "compute_station_coordinates: closure-chain transitivity"
        );
        let t_phase = std::time::Instant::now();

        // Mark zero datums
        for zd in &self.zero_datums {
            let Some(sr) = self.resolve_key(&zd.station_ref) else {
                continue;
            };
            for station in &mut stations {
                if station.station_ref == sr {
                    station.is_zero_datum = true;
                    station.gps_coordinates = Some(zd.gps);
                }
            }
        }

        tracing::debug!(
            ms = t_phase.elapsed().as_millis() as u64,
            "compute_station_coordinates: zero datums"
        );
        let t_phase = std::time::Instant::now();

        // Assign station comments
        for (key, comment) in &self.station_comments {
            let Some(sr) = self.resolve_key(key) else {
                continue;
            };
            for station in &mut stations {
                if station.station_ref == sr {
                    station.comment = Some(comment.clone());
                }
            }
        }
        tracing::debug!(
            ms = t_phase.elapsed().as_millis() as u64,
            "compute_station_coordinates: station comments"
        );

        stations
    }

    /// Build a `StationRef -> index` map for `stations` (index = position in the
    /// slice) so graph builders can resolve shot/merge/closure endpoints to
    /// nodes without a linear search.
    fn station_index_map(stations: &[Station]) -> HashMap<StationRef, usize> {
        let mut m: HashMap<StationRef, usize> = HashMap::with_capacity(stations.len());
        for (i, s) in stations.iter().enumerate() {
            m.insert(s.station_ref, i);
        }
        m
    }

    /// Build the survey distance graph as an adjacency list over the `n` stations
    /// (nodes indexed by position; `station_index` maps refs to those indices).
    /// Edges are **every real topological connection**:
    /// - every shot — permanent AND jump/reference — weighted by its measured
    ///   `length` (reference shots are real measured legs / jumps a diver swims);
    /// - `station_merges` (zero cost — the same physical point);
    /// - every `loop_closures` entry (zero cost — a closed loop means the two
    ///   stations are the same physical point), **regardless of `is_aligned`**;
    ///   alignment is only a geometry-reconciliation strategy (`Move` vs `Batch`),
    ///   so the topological connection exists either way.
    ///
    /// We deliberately include everything. Distances are shortest-path (Dijkstra
    /// always takes the minimum), so an extra real edge can only ever yield a
    /// shorter, more correct route — never inflate one. Excluding real
    /// connections is what hides reachable areas or routes "the long way".
    ///
    /// NOTE (#77): the one residual risk is a *non-physical* reference tie (a pure
    /// survey backsight, not swimmable) creating a false shortcut that understates
    /// distance. Telling those apart from real jumps needs a first-class model;
    /// until then we favor completeness — real data showed over-exclusion (a
    /// dropped jump shortcut, excluded non-aligned closures) was the actual bug.
    fn build_survey_graph(
        &self,
        n: usize,
        station_index: &HashMap<StationRef, usize>,
        coords: Option<&[Coordinates]>,
    ) -> Vec<Vec<(usize, f64)>> {
        let mut adj: Vec<Vec<(usize, f64)>> = vec![Vec::new(); n];

        // Shots (permanent and jump/reference). Edge weight = straight-line
        // distance between the endpoints' `coords` when supplied (the
        // closure-adjusted geometry, for the distance gradient), else the
        // measured shot length (penetration / topological queries).
        for section in &self.sections {
            for (i, shot) in section.shots.iter().enumerate() {
                let from = StationRef::new(section.id, i as u32);
                let to = StationRef::new(section.id, (i + 1) as u32);
                if let (Some(&fi), Some(&ti)) = (station_index.get(&from), station_index.get(&to)) {
                    let w = match coords {
                        Some(c) => {
                            let (a, b) = (&c[fi], &c[ti]);
                            let (dx, dy, dz) = (b.x - a.x, b.y - a.y, b.z - a.z);
                            (dx * dx + dy * dy + dz * dz).sqrt()
                        }
                        None => shot.length.max(0.0),
                    };
                    adj[fi].push((ti, w));
                    adj[ti].push((fi, w));
                }
            }
        }
        // Station merges: zero-cost (same physical point).
        for merge in &self.station_merges {
            if let (Some(a_sr), Some(b_sr)) = (
                self.resolve_key(&merge.station_a),
                self.resolve_key(&merge.station_b),
            ) {
                if let (Some(&a), Some(&b)) = (station_index.get(&a_sr), station_index.get(&b_sr)) {
                    adj[a].push((b, 0.0));
                    adj[b].push((a, 0.0));
                }
            }
        }
        // Loop closures: zero-cost, INCLUDING non-aligned ones — a closed loop is
        // a real physical connection no matter the reconciliation strategy.
        for closure in &self.loop_closures {
            if let (Some(a_sr), Some(b_sr)) = (
                self.resolve_key(&closure.station_a),
                self.resolve_key(&closure.station_b),
            ) {
                if let (Some(&a), Some(&b)) = (station_index.get(&a_sr), station_index.get(&b_sr)) {
                    adj[a].push((b, 0.0));
                    adj[b].push((a, 0.0));
                }
            }
        }

        adj
    }

    /// Multi-source Dijkstra over `adj` from the given `roots` (node indices,
    /// each seeded at distance 0). Returns the shortest-path distance to every
    /// node; unreachable nodes — and every node when `roots` is empty — stay
    /// `f64::INFINITY`.
    fn dijkstra(adj: &[Vec<(usize, f64)>], roots: &[usize]) -> Vec<f64> {
        let n = adj.len();
        let mut dist = vec![f64::INFINITY; n];

        #[derive(Copy, Clone, PartialEq)]
        struct Node(f64, usize);
        impl Eq for Node {}
        impl PartialOrd for Node {
            fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
                Some(self.cmp(other))
            }
        }
        impl Ord for Node {
            fn cmp(&self, other: &Self) -> Ordering {
                self.0
                    .partial_cmp(&other.0)
                    .unwrap_or(Ordering::Equal)
                    .then(self.1.cmp(&other.1))
            }
        }

        let mut heap: BinaryHeap<std::cmp::Reverse<Node>> = BinaryHeap::new();
        for &r in roots {
            // Bounds-guard only; a duplicate root just gets re-popped once and
            // filtered by the `d > dist[u]` check below — no need to dedup here.
            if r < n {
                dist[r] = 0.0;
                heap.push(std::cmp::Reverse(Node(0.0, r)));
            }
        }
        while let Some(std::cmp::Reverse(Node(d, u))) = heap.pop() {
            if d > dist[u] {
                continue;
            }
            for &(v, w) in &adj[u] {
                let nd = d + w;
                if nd < dist[v] {
                    dist[v] = nd;
                    heap.push(std::cmp::Reverse(Node(nd, v)));
                }
            }
        }
        dist
    }

    /// Resolve the project's zero-datum stations to their indices in `stations`.
    fn zero_datum_roots(&self, station_index: &HashMap<StationRef, usize>) -> Vec<usize> {
        self.zero_datums
            .iter()
            .filter_map(|zd| {
                self.resolve_key(&zd.station_ref)
                    .and_then(|sr| station_index.get(&sr).copied())
            })
            .collect()
    }

    /// Per-station along-cave distance from the given `roots` (indices into
    /// `stations`), summing each shot's measured `length` along the shortest
    /// path. Merges and all loop closures are zero-cost (a closed loop ties two
    /// stations to the same physical point). Unreachable stations — and every
    /// station when `roots`/`stations` is empty — get `f64::INFINITY`.
    ///
    /// This is the reusable core shared by penetration distance (roots = zero
    /// datums), the distance-gradient overlay (roots = a chosen station), and a
    /// future gas-planning mode. All graph/geometry work stays here in the
    /// domain layer; callers (IPC, UI) only consume the resulting distances.
    pub fn compute_distances_from(&self, stations: &[Station], roots: &[usize]) -> Vec<f64> {
        let n = stations.len();
        if n == 0 || roots.is_empty() {
            return vec![f64::INFINITY; n];
        }
        let station_index = Self::station_index_map(stations);
        let adj = self.build_survey_graph(n, &station_index, None);
        Self::dijkstra(&adj, roots)
    }

    /// Per-station along-cave distance to the nearest zero datum: the
    /// shortest path through the survey graph summing each shot's measured
    /// length. Edges are *all* shots (reference and non-reference, since
    /// refs are real measured legs) plus zero-cost edges for
    /// `station_merges` and all `loop_closures` (a closed loop ties two
    /// stations to the same physical point). Unreachable stations get
    /// `f64::INFINITY`. Empty projects / no zero datums → all `INFINITY`.
    ///
    /// Equivalent to [`compute_distances_from`] seeded with the zero-datum
    /// station indices — the default origin for the distance-gradient overlay.
    pub fn compute_penetration_distances(&self, stations: &[Station]) -> Vec<f64> {
        let n = stations.len();
        if n == 0 || self.zero_datums.is_empty() {
            return vec![f64::INFINITY; n];
        }
        let station_index = Self::station_index_map(stations);
        let roots = self.zero_datum_roots(&station_index);
        let adj = self.build_survey_graph(n, &station_index, None);
        Self::dijkstra(&adj, &roots)
    }

    /// Maximum along-cave penetration distance — the longest shortest-path
    /// distance from any zero datum to any station through the survey
    /// graph. Zero if there are no zero datums or nothing is reachable.
    pub fn calculate_penetration(&self, stations: &[Station]) -> f64 {
        self.compute_penetration_distances(stations)
            .into_iter()
            .filter(|d| d.is_finite())
            .fold(0.0_f64, f64::max)
    }

    /// Per-station distance field from a chosen origin `from` station, or from the
    /// zero datum(s) when `from` is `None` (the gradient's entrance default).
    ///
    /// Edge weights come from each station's **coordinates** in `stations` — the
    /// caller passes MEASURED coordinates (surveyed lengths), so distances reflect
    /// the physical guideline length (#34). Merges/closures stay zero-cost.
    /// Unreachable stations come back as `None`; the returned `station_refs` echo
    /// the input, so the field is self-describing.
    pub fn distance_field_from(
        &self,
        stations: &[Station],
        from: Option<&StationRef>,
    ) -> DistanceField {
        let n = stations.len();
        let station_index = Self::station_index_map(stations);
        let coords: Vec<Coordinates> = stations.iter().map(|s| s.coordinates).collect();
        let roots: Vec<usize> = match from {
            Some(r) => {
                let key: StationKey = (*r).into();
                self.resolve_key(&key)
                    .and_then(|sr| station_index.get(&sr).copied())
                    .into_iter()
                    .collect()
            }
            None => self.zero_datum_roots(&station_index),
        };
        let raw = if n == 0 || roots.is_empty() {
            vec![f64::INFINITY; n]
        } else {
            let adj = self.build_survey_graph(n, &station_index, Some(&coords));
            Self::dijkstra(&adj, &roots)
        };
        let mut max_reachable = 0.0_f64;
        let distances: Vec<Option<f64>> = raw
            .iter()
            .map(|&d| {
                if d.is_finite() {
                    if d > max_reachable {
                        max_reachable = d;
                    }
                    Some(d)
                } else {
                    None
                }
            })
            .collect();
        DistanceField {
            distances,
            station_refs: stations.iter().map(|s| s.station_ref).collect(),
            max_reachable,
        }
    }

    /// Shortest along-cave-line distance between two ruler endpoints (#26), plus
    /// the ordered shots traversed (for tinting). The distance sums the lengths of
    /// the shots on the path — each shot weighted by the euclidean distance between
    /// its endpoints in `stations` (the *placed* shot length), so passing the
    /// closure-ADJUSTED coordinates (see `AppState::along_line_between`) yields the
    /// closure-adjusted shot lengths the user asked for. For a continuous survey
    /// this placed length equals the surveyed tape length; at depth discontinuities
    /// the depth-averaged station placement can differ slightly, matching what is
    /// drawn rather than the raw tape figure. An
    /// endpoint may be a station or an exact point on a shot at fraction `t` (which
    /// splits that shot's edge; a mid-shot leg contributes `t` of the adjusted shot
    /// length). Returns `along_line: None` when the endpoints are in different
    /// connected components. `stations` supplies both the `StationRef -> index` map
    /// and the per-node coordinates used for the weights.
    pub fn along_line_between(
        &self,
        stations: &[Station],
        a: RulerEndpoint,
        b: RulerEndpoint,
    ) -> AlongLineResult {
        const EPS: f64 = 1e-9;
        let none = || AlongLineResult {
            along_line: None,
            path_shots: Vec::new(),
            path_stations: Vec::new(),
        };

        let n = stations.len();
        if n == 0 {
            return none();
        }
        let idx = Self::station_index_map(stations);
        let section_lookup = self.build_section_lookup();

        // Shot lengths come from the euclidean distance between the (adjusted)
        // station coordinates, so the along-line distance sums the closure-adjusted
        // shot lengths (#26). `shot_len` is only ever called with real station node
        // indices (a shot's from/to), which are always < `coords.len()`.
        let coords: Vec<Coordinates> = stations.iter().map(|s| s.coordinates).collect();
        let shot_len = |from: usize, to: usize| -> f64 {
            let (p, q) = (&coords[from], &coords[to]);
            ((q.x - p.x).powi(2) + (q.y - p.y).powi(2) + (q.z - p.z).powi(2)).sqrt()
        };

        // How an endpoint resolves onto the graph: an existing station node, or a
        // virtual split of a shot edge at fraction `t`.
        enum Resolved {
            Station(usize),
            Shot {
                from: usize,
                to: usize,
                t: f64,
                len: f64,
                shot: PathShot,
            },
        }

        let resolve = |ep: &RulerEndpoint| -> Option<Resolved> {
            // Shot-point endpoint.
            if let (Some(shot_id), Some(t)) = (ep.shot_id, ep.t) {
                let section = section_lookup.get(&ep.section_id)?;
                let pos = section.shots.iter().position(|s| s.id == shot_id)?;
                let from = *idx.get(&StationRef::new(ep.section_id, pos as u32))?;
                let to = *idx.get(&StationRef::new(ep.section_id, (pos + 1) as u32))?;
                let len = shot_len(from, to);
                let tt = t.clamp(0.0, 1.0);
                if tt <= EPS {
                    return Some(Resolved::Station(from));
                }
                if tt >= 1.0 - EPS {
                    return Some(Resolved::Station(to));
                }
                return Some(Resolved::Shot {
                    from,
                    to,
                    t: tt,
                    len,
                    shot: PathShot {
                        section_id: ep.section_id,
                        shot_id,
                    },
                });
            }
            // Station endpoint.
            let si = ep.station_index?;
            let node = *idx.get(&StationRef::new(ep.section_id, si))?;
            Some(Resolved::Station(node))
        };

        let ra = match resolve(&a) {
            Some(r) => r,
            None => return none(),
        };
        let rb = match resolve(&b) {
            Some(r) => r,
            None => return none(),
        };

        // Both endpoints on the SAME shot: the direct sub-segment is |Δt|·L. We do
        // NOT short-circuit to it — a merge/loop closure between the shot's stations
        // can make a route *around* shorter than the direct segment, and Dijkstra
        // must stay free to pick the genuine shortest along-cave-line path. Instead
        // we remember it and add it as a direct edge between the two virtual nodes
        // after materializing, so it simply competes with the around routes.
        let same_shot_direct: Option<(f64, PathShot)> = match (&ra, &rb) {
            (
                Resolved::Shot {
                    t: ta,
                    len,
                    shot: sa,
                    ..
                },
                Resolved::Shot {
                    t: tb, shot: sb, ..
                },
            ) if sa == sb => Some(((ta - tb).abs() * len, *sa)),
            _ => None,
        };

        // Graph + a parallel (node_a, node_b) -> shot map, built in the SAME loop
        // order as `build_survey_graph` so reconstructed node pairs map back to a
        // shot. Zero-cost merge/closure edges are intentionally absent here ⇒ a
        // reconstructed pair not in the map is a tie to skip (never tinted).
        let mut adj = self.build_survey_graph(n, &idx, Some(&coords));
        let mut shot_edge: HashMap<(usize, usize), PathShot> = HashMap::new();
        for section in &self.sections {
            for (i, shot) in section.shots.iter().enumerate() {
                let from = StationRef::new(section.id, i as u32);
                let to = StationRef::new(section.id, (i + 1) as u32);
                if let (Some(&fi), Some(&ti)) = (idx.get(&from), idx.get(&to)) {
                    let ps = PathShot {
                        section_id: section.id,
                        shot_id: shot.id,
                    };
                    shot_edge.insert((fi, ti), ps);
                    shot_edge.insert((ti, fi), ps);
                }
            }
        }

        // Materialize an endpoint into a node index, appending a virtual node that
        // splits the shot edge into `t·L` / `(1-t)·L` when it's a shot-point. Both
        // partial legs map to the WHOLE shot so the partial end shot still tints.
        fn materialize(
            adj: &mut Vec<Vec<(usize, f64)>>,
            shot_edge: &mut HashMap<(usize, usize), PathShot>,
            r: Resolved,
        ) -> usize {
            match r {
                Resolved::Station(i) => i,
                Resolved::Shot {
                    from,
                    to,
                    t,
                    len,
                    shot,
                } => {
                    let v = adj.len();
                    adj.push(vec![(from, t * len), (to, (1.0 - t) * len)]);
                    adj[from].push((v, t * len));
                    adj[to].push((v, (1.0 - t) * len));
                    shot_edge.insert((v, from), shot);
                    shot_edge.insert((from, v), shot);
                    shot_edge.insert((v, to), shot);
                    shot_edge.insert((to, v), shot);
                    v
                }
            }
        }

        let start = materialize(&mut adj, &mut shot_edge, ra);
        let goal = materialize(&mut adj, &mut shot_edge, rb);

        // Same-shot direct sub-segment (see above): connect the two virtual nodes
        // directly with weight |Δt|·L so it competes with routing around via the
        // shared stations / any closure. Tagged with the shot so a direct pick still
        // tints it.
        if let Some((w, ps)) = same_shot_direct {
            adj[start].push((goal, w));
            adj[goal].push((start, w));
            shot_edge.insert((start, goal), ps);
            shot_edge.insert((goal, start), ps);
        }

        // Predecessor-tracking Dijkstra (the shared `dijkstra` returns distances
        // only). Same min-heap ordering as `dijkstra`.
        #[derive(Copy, Clone, PartialEq)]
        struct Node(f64, usize);
        impl Eq for Node {}
        impl PartialOrd for Node {
            fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
                Some(self.cmp(other))
            }
        }
        impl Ord for Node {
            fn cmp(&self, other: &Self) -> Ordering {
                self.0
                    .partial_cmp(&other.0)
                    .unwrap_or(Ordering::Equal)
                    .then(self.1.cmp(&other.1))
            }
        }

        let total = adj.len();
        let mut dist = vec![f64::INFINITY; total];
        let mut pred = vec![usize::MAX; total];
        let mut heap: BinaryHeap<std::cmp::Reverse<Node>> = BinaryHeap::new();
        dist[start] = 0.0;
        heap.push(std::cmp::Reverse(Node(0.0, start)));
        while let Some(std::cmp::Reverse(Node(d, u))) = heap.pop() {
            if d > dist[u] {
                continue;
            }
            if u == goal {
                break;
            }
            for &(v, w) in &adj[u] {
                let nd = d + w;
                if nd < dist[v] {
                    dist[v] = nd;
                    pred[v] = u;
                    heap.push(std::cmp::Reverse(Node(nd, v)));
                }
            }
        }

        if !dist[goal].is_finite() {
            return none();
        }

        // Reconstruct the node chain start..goal and map consecutive pairs to
        // shots, skipping zero-cost merge/closure ties and deduping repeats.
        let mut chain = vec![goal];
        let mut cur = goal;
        while cur != start {
            let p = pred[cur];
            if p == usize::MAX {
                return none();
            }
            chain.push(p);
            cur = p;
        }
        chain.reverse();
        let mut path_shots: Vec<PathShot> = Vec::new();
        for w in chain.windows(2) {
            // Skip a step that actually traversed a zero-cost merge/closure tie. When
            // a closure runs PARALLEL to a real shot (same station pair) `shot_edge`
            // maps the pair to the shot, but a ~0-cost step means Dijkstra took the
            // tie, not the shot — tinting it would be wrong. This also drops a
            // zero-length same-shot measurement (ta≈tb), whose direct edge has weight
            // 0, leaving an empty path like identical station endpoints (#26, Codex).
            // `w[0]` is the predecessor of `w[1]`, so the step weight is exactly the
            // distance delta.
            if dist[w[1]] - dist[w[0]] <= EPS {
                continue;
            }
            if let Some(ps) = shot_edge.get(&(w[0], w[1])) {
                if path_shots.last() != Some(ps) {
                    path_shots.push(*ps);
                }
            }
        }
        // Stations on the path = chain nodes that are real stations (virtual
        // shot-split nodes have index >= n and carry no StationRef).
        let mut path_stations: Vec<StationRef> = Vec::new();
        for &node in &chain {
            if node < n {
                let sr = stations[node].station_ref;
                if path_stations.last() != Some(&sr) {
                    path_stations.push(sr);
                }
            }
        }

        AlongLineResult {
            along_line: Some(dist[goal]),
            path_shots,
            path_stations,
        }
    }

    // ── Frozen shots ─────────────────────────────────────────────────

    /// Build adjacency from aligned loop closures (bidirectional).
    pub(crate) fn build_aligned_closure_adjacency(
        &self,
        section_lookup: &HashMap<SectionId, &Section>,
    ) -> HashMap<StationRef, Vec<StationRef>> {
        let mut adjacency: HashMap<StationRef, Vec<StationRef>> = HashMap::new();
        for closure in &self.loop_closures {
            if !closure.is_aligned {
                continue;
            }
            if !section_lookup.contains_key(&closure.station_a.section_id)
                || !section_lookup.contains_key(&closure.station_b.section_id)
            {
                continue;
            }
            if let (Some(a), Some(b)) = (
                self.resolve_key(&closure.station_a),
                self.resolve_key(&closure.station_b),
            ) {
                adjacency.entry(a).or_default().push(b);
                adjacency.entry(b).or_default().push(a);
            }
        }
        adjacency
    }

    /// BFS reachability check: can `start` reach any zero datum station,
    /// traversing shots + merges + aligned closures, but excluding one specific shot edge?
    fn can_reach_datum_excluding_shot(
        &self,
        start: StationRef,
        exclude_section_id: SectionId,
        exclude_shot_index: usize,
        section_lookup: &HashMap<SectionId, &Section>,
        merge_adj: &HashMap<StationRef, Vec<StationRef>>,
        closure_adj: &HashMap<StationRef, Vec<StationRef>>,
        datum_stations: &HashSet<StationRef>,
    ) -> bool {
        if datum_stations.contains(&start) {
            return true;
        }

        let mut visited: HashSet<StationRef> = HashSet::new();
        let mut queue: VecDeque<StationRef> = VecDeque::new();
        visited.insert(start);
        queue.push_back(start);

        while let Some(node) = queue.pop_front() {
            let Some(section) = section_lookup.get(&node.section_id) else {
                continue;
            };

            // Adjacent stations via shots (backward: station_index - 1 via shot index-1)
            if node.station_index > 0 {
                let shot_idx = (node.station_index - 1) as usize;
                let is_excluded =
                    node.section_id == exclude_section_id && shot_idx == exclude_shot_index;
                if !is_excluded && shot_idx < section.shots.len() {
                    let neighbor = StationRef::new(node.section_id, node.station_index - 1);
                    if visited.insert(neighbor) {
                        if datum_stations.contains(&neighbor) {
                            return true;
                        }
                        queue.push_back(neighbor);
                    }
                }
            }

            // Adjacent stations via shots (forward: station_index + 1 via shot at station_index)
            if (node.station_index as usize) < section.shots.len() {
                let shot_idx = node.station_index as usize;
                let is_excluded =
                    node.section_id == exclude_section_id && shot_idx == exclude_shot_index;
                if !is_excluded {
                    let neighbor = StationRef::new(node.section_id, node.station_index + 1);
                    if visited.insert(neighbor) {
                        if datum_stations.contains(&neighbor) {
                            return true;
                        }
                        queue.push_back(neighbor);
                    }
                }
            }

            // Merge neighbors
            if let Some(neighbors) = merge_adj.get(&node) {
                for &neighbor in neighbors {
                    if visited.insert(neighbor) {
                        if datum_stations.contains(&neighbor) {
                            return true;
                        }
                        queue.push_back(neighbor);
                    }
                }
            }

            // Aligned closure neighbors
            if let Some(neighbors) = closure_adj.get(&node) {
                for &neighbor in neighbors {
                    if visited.insert(neighbor) {
                        if datum_stations.contains(&neighbor) {
                            return true;
                        }
                        queue.push_back(neighbor);
                    }
                }
            }
        }

        false
    }

    /// Check if a specific shot is frozen.
    /// A shot is frozen when both its endpoints can reach a zero datum station
    /// (excluding the shot itself) via shots, merges, and aligned closures.
    pub(crate) fn is_shot_frozen(
        &self,
        section_id: SectionId,
        shot_index: usize,
        section_lookup: &HashMap<SectionId, &Section>,
        merge_adj: &HashMap<StationRef, Vec<StationRef>>,
        closure_adj: &HashMap<StationRef, Vec<StationRef>>,
        datum_stations: &HashSet<StationRef>,
    ) -> bool {
        if datum_stations.is_empty() {
            return false;
        }

        let station_a = StationRef::new(section_id, shot_index as u32);
        let station_b = StationRef::new(section_id, (shot_index + 1) as u32);

        self.can_reach_datum_excluding_shot(
            station_a,
            section_id,
            shot_index,
            section_lookup,
            merge_adj,
            closure_adj,
            datum_stations,
        ) && self.can_reach_datum_excluding_shot(
            station_b,
            section_id,
            shot_index,
            section_lookup,
            merge_adj,
            closure_adj,
            datum_stations,
        )
    }

    /// Convenience wrapper around [`Self::is_shot_frozen`] that resolves the
    /// shot's index from its id and builds the section lookup / adjacency /
    /// datum-station structures internally. Returns `false` if the section or
    /// shot id cannot be found. Call sites that need to check a single shot
    /// should prefer this over hand-rolling the adjacency setup.
    pub(crate) fn is_shot_frozen_by_id(&self, section_id: SectionId, shot_id: ShotId) -> bool {
        let Some(section) = self.sections.iter().find(|s| s.id == section_id) else {
            return false;
        };
        let Some(shot_index) = section.shots.iter().position(|s| s.id == shot_id) else {
            return false;
        };
        let section_lookup = self.build_section_lookup();
        let merge_adj = self.build_merge_adjacency(&section_lookup);
        let closure_adj = self.build_aligned_closure_adjacency(&section_lookup);
        let datum_stations: HashSet<StationRef> = self
            .zero_datums
            .iter()
            .filter_map(|d| self.resolve_key(&d.station_ref))
            .collect();
        self.is_shot_frozen(
            section_id,
            shot_index,
            &section_lookup,
            &merge_adj,
            &closure_adj,
            &datum_stations,
        )
    }

    /// Compute all frozen shots for the project.
    ///
    /// A shot is frozen when both its endpoints can reach a zero datum station
    /// (excluding the shot itself) via shots, merges, and aligned closures.
    ///
    /// Uses Tarjan's bridge-finding algorithm for O(V+E) total complexity instead
    /// of the naive O(shots × BFS) approach.
    pub fn compute_frozen_shots(&self) -> Vec<FrozenShotRef> {
        if self.zero_datums.is_empty() {
            return Vec::new();
        }

        let section_lookup = self.build_section_lookup();
        let merge_adj = self.build_merge_adjacency(&section_lookup);
        let closure_adj = self.build_aligned_closure_adjacency(&section_lookup);
        let datum_stations: HashSet<StationRef> = self
            .zero_datums
            .iter()
            .filter_map(|d| self.resolve_key(&d.station_ref))
            .collect();

        // Assign each station a compact integer index
        let mut station_to_idx: HashMap<StationRef, usize> = HashMap::new();
        let mut idx_to_station: Vec<StationRef> = Vec::new();
        for section in &self.sections {
            for i in 0..=section.shots.len() {
                let sr = StationRef::new(section.id, i as u32);
                let idx = idx_to_station.len();
                station_to_idx.insert(sr, idx);
                idx_to_station.push(sr);
            }
        }
        let v = idx_to_station.len();
        if v == 0 {
            return Vec::new();
        }

        // Edge descriptor: (neighbor_idx, is_shot, section_id, shot_index)
        // is_shot=true means this edge corresponds to a shot that could be frozen.
        let mut adj: Vec<Vec<(usize, bool, SectionId, u32)>> = vec![Vec::new(); v];

        // Add shot edges
        for section in &self.sections {
            for shot_index in 0..section.shots.len() {
                let a = StationRef::new(section.id, shot_index as u32);
                let b = StationRef::new(section.id, (shot_index + 1) as u32);
                if let (Some(&ai), Some(&bi)) = (station_to_idx.get(&a), station_to_idx.get(&b)) {
                    adj[ai].push((bi, true, section.id, shot_index as u32));
                    adj[bi].push((ai, true, section.id, shot_index as u32));
                }
            }
        }

        // Add merge edges
        for (station, neighbors) in &merge_adj {
            if let Some(&si) = station_to_idx.get(station) {
                for neighbor in neighbors {
                    if let Some(&ni) = station_to_idx.get(neighbor) {
                        adj[si].push((ni, false, 0, 0));
                    }
                }
            }
        }

        // Add aligned closure edges
        for (station, neighbors) in &closure_adj {
            if let Some(&si) = station_to_idx.get(station) {
                for neighbor in neighbors {
                    if let Some(&ni) = station_to_idx.get(neighbor) {
                        adj[si].push((ni, false, 0, 0));
                    }
                }
            }
        }

        // Tarjan's bridge-finding + datum counting in subtrees.
        // disc[u] = discovery time, low[u] = lowest disc reachable via back-edges.
        // An edge (u, v) with disc[u] < disc[v] is a bridge iff low[v] > disc[u].
        // We also count datums in each DFS subtree to decide bridge-frozen status.
        let mut disc = vec![0u32; v];
        let mut low = vec![0u32; v];
        let mut visited = vec![false; v];
        let mut subtree_datums = vec![0u32; v]; // datums in DFS subtree rooted at node
        let mut dfs_parent = vec![usize::MAX; v];
        let mut is_bridge = vec![false; v]; // indexed by child node of the bridge edge
        let mut component_datums = vec![0u32; v]; // total datums in the component
        let mut component_root = vec![usize::MAX; v];

        let is_datum: Vec<bool> = idx_to_station
            .iter()
            .map(|sr| datum_stations.contains(sr))
            .collect();

        let mut timer: u32 = 1;

        // Iterative Tarjan's DFS to avoid stack overflow on large graphs.
        // We track whether the tree edge to the parent has been skipped
        // (parent_edge_skipped) to handle multigraph edges correctly:
        // if A-B are connected by both a shot and a merge, only one edge
        // is the tree edge; the others are back edges that prevent bridging.
        for start in 0..v {
            if visited[start] {
                continue;
            }

            // DFS stack: (node, adj_index, parent_edge_skipped)
            let mut stack: Vec<(usize, usize, bool)> = Vec::new();
            visited[start] = true;
            disc[start] = timer;
            low[start] = timer;
            timer += 1;
            subtree_datums[start] = if is_datum[start] { 1 } else { 0 };
            component_root[start] = start;
            stack.push((start, 0, true)); // root has no parent edge to skip

            while let Some((u, ei, parent_skipped)) = stack.last_mut() {
                let u = *u;
                if *ei < adj[u].len() {
                    let (w, _, _, _) = adj[u][*ei];
                    *ei += 1;
                    if !visited[w] {
                        visited[w] = true;
                        disc[w] = timer;
                        low[w] = timer;
                        timer += 1;
                        subtree_datums[w] = if is_datum[w] { 1 } else { 0 };
                        dfs_parent[w] = u;
                        component_root[w] = start;
                        stack.push((w, 0, false));
                    } else if w == dfs_parent[u] && !*parent_skipped {
                        // First edge back to parent = tree edge, skip it once
                        *parent_skipped = true;
                    } else {
                        // Back/cross edge (or second+ edge to parent): update low
                        low[u] = low[u].min(disc[w]);
                    }
                } else {
                    // Done with u, propagate to parent
                    let u_low = low[u];
                    let u_datums = subtree_datums[u];
                    stack.pop();
                    if let Some((parent, _, _)) = stack.last() {
                        let parent = *parent;
                        low[parent] = low[parent].min(u_low);
                        subtree_datums[parent] += u_datums;
                        // Check if edge (parent, u) is a bridge
                        if u_low > disc[parent] {
                            is_bridge[u] = true;
                        }
                    }
                }
            }

            // Record total datums for this component
            component_datums[start] = subtree_datums[start];
        }

        // Now determine which shots are frozen:
        // - Non-bridge shot: frozen if its component has ≥1 datum
        // - Bridge shot (parent→child): frozen if both sides have datums.
        //   child-side has subtree_datums[child], other side has
        //   component_datums[root] - subtree_datums[child].
        let mut frozen = Vec::new();
        for section in &self.sections {
            for shot_index in 0..section.shots.len() {
                let a = StationRef::new(section.id, shot_index as u32);
                let b = StationRef::new(section.id, (shot_index + 1) as u32);
                let (Some(&ai), Some(&bi)) = (station_to_idx.get(&a), station_to_idx.get(&b))
                else {
                    continue;
                };

                let root = component_root[ai];
                let total = component_datums[root];
                if total == 0 {
                    continue;
                }

                // Determine if this shot edge is a bridge
                let (child, is_bridge_edge) = if dfs_parent[bi] == ai && is_bridge[bi] {
                    (bi, true)
                } else if dfs_parent[ai] == bi && is_bridge[ai] {
                    (ai, true)
                } else {
                    (0, false)
                };

                if is_bridge_edge {
                    // Bridge: frozen only if both sides have datums
                    let child_datums = subtree_datums[child];
                    let other_datums = total - child_datums;
                    if child_datums > 0 && other_datums > 0 {
                        frozen.push(FrozenShotRef {
                            section_id: section.id,
                            shot_index: shot_index as u32,
                        });
                    }
                } else {
                    // Non-bridge in a component with datums: frozen
                    frozen.push(FrozenShotRef {
                        section_id: section.id,
                        shot_index: shot_index as u32,
                    });
                }
            }
        }
        frozen
    }

    /// Find orphaned connected components and suggest placements for their leaf
    /// ends against newly imported sections.
    ///
    /// An orphaned component is a set of sections connected via merges that has
    /// no zero datum. Leaf ends are terminal stations with at least 3 free shots
    /// (shots not adjacent to a merge or aligned closure).
    pub fn suggest_orphan_placements(
        &self,
        newly_imported_section_ids: &[SectionId],
        ps_config: &crate::config::PlacementSuggestionConfig,
    ) -> Vec<super::placement_suggest::OrphanPlacementSuggestion> {
        use super::placement_suggest::{
            suggest_placements, ExistingSection, OrphanPlacementSuggestion,
        };

        let new_set: HashSet<SectionId> = newly_imported_section_ids.iter().copied().collect();

        // 1. Build all connected components (via merges only)
        let mut visited: HashSet<SectionId> = HashSet::new();
        let mut components: Vec<HashSet<SectionId>> = Vec::new();

        for section in &self.sections {
            if visited.contains(&section.id) {
                continue;
            }
            let component = self.get_merged_section_ids(section.id);
            for &sid in &component {
                visited.insert(sid);
            }
            components.push(component);
        }

        // 2. Filter to orphan components: no datum AND no newly-imported member
        let orphan_components: Vec<&HashSet<SectionId>> = components
            .iter()
            .filter(|comp| {
                // Skip if any member is newly imported
                if comp.iter().any(|sid| new_set.contains(sid)) {
                    return false;
                }
                // Skip if component has a datum (an empty component — impossible
                // here — is treated as non-orphan).
                let Some(&any_member) = comp.iter().next() else {
                    return false;
                };
                !self.rigid_group_has_datum(any_member)
            })
            .collect();

        if orphan_components.is_empty() || newly_imported_section_ids.is_empty() {
            return Vec::new();
        }

        // 3. Build target sections (newly imported only)
        let target_sections: Vec<ExistingSection> = newly_imported_section_ids
            .iter()
            .filter_map(|&id| self.get_section(id))
            .map(|s| ExistingSection {
                id: s.id,
                name: s
                    .name
                    .clone()
                    .unwrap_or_else(|| format!("Section {}", s.id)),
                shots: s.shots.clone(),
            })
            .collect();

        if target_sections.is_empty() {
            return Vec::new();
        }

        // Helper: check if a station has any merge
        let station_has_merge = |sr: StationRef| -> bool {
            self.station_merges
                .iter()
                .any(|m| self.key_is_ref(&m.station_a, sr) || self.key_is_ref(&m.station_b, sr))
        };

        // Helper: check if a station has any aligned closure
        let station_has_aligned_closure = |sr: StationRef| -> bool {
            self.loop_closures.iter().any(|c| {
                c.is_aligned
                    && (self.key_is_ref(&c.station_a, sr) || self.key_is_ref(&c.station_b, sr))
            })
        };

        // Helper: check if a station is constrained (merge or aligned closure)
        let station_is_constrained =
            |sr: StationRef| -> bool { station_has_merge(sr) || station_has_aligned_closure(sr) };

        let mut suggestions: Vec<OrphanPlacementSuggestion> = Vec::new();

        // 4. For each orphan component, find leaf candidates
        for component in &orphan_components {
            for &section_id in *component {
                let section = match self.get_section(section_id) {
                    Some(s) => s,
                    None => continue,
                };
                if section.shots.is_empty() {
                    continue;
                }

                let section_name = section
                    .name
                    .clone()
                    .unwrap_or_else(|| format!("Section {}", section_id));
                let n_shots = section.shots.len();

                // Try both ends: station 0 and station N
                let ends: [(u32, bool); 2] = [(0, true), (n_shots as u32, false)];

                for &(terminal_station_idx, is_start) in &ends {
                    let terminal = StationRef {
                        section_id,
                        station_index: terminal_station_idx,
                    };

                    // Skip if this terminal station has a merge (not a leaf)
                    if station_has_merge(terminal) {
                        continue;
                    }

                    // Walk inward counting free shots until hitting a constraint
                    let mut free_count = 0usize;
                    if is_start {
                        // Station 0: walk shots 0, 1, 2, ...
                        for shot_idx in 0..n_shots {
                            // Check the far station of this shot
                            let far_station = StationRef {
                                section_id,
                                station_index: (shot_idx + 1) as u32,
                            };
                            if station_is_constrained(far_station) {
                                break;
                            }
                            free_count += 1;
                        }
                    } else {
                        // Station N: walk shots N-1, N-2, ...
                        for shot_idx in (0..n_shots).rev() {
                            // Check the far station of this shot (going inward)
                            let far_station = StationRef {
                                section_id,
                                station_index: shot_idx as u32,
                            };
                            if station_is_constrained(far_station) {
                                break;
                            }
                            free_count += 1;
                        }
                    }

                    if free_count < 3 {
                        continue;
                    }

                    let max_shots = (free_count - 1).min(5);

                    // Collect the shots as ShotData
                    let leaf_shots: Vec<ShotData> = if is_start {
                        section.shots[..max_shots]
                            .iter()
                            .map(|s| s.to_shot_data())
                            .collect()
                    } else {
                        section.shots[n_shots - max_shots..]
                            .iter()
                            .rev()
                            .map(|s| {
                                let mut sd = s.to_shot_data();
                                // Reverse shot: flip azimuth 180°, swap depths
                                sd.azimuth_in = (sd.azimuth_in + 180.0) % 360.0;
                                sd.azimuth_out = (sd.azimuth_out + 180.0) % 360.0;
                                std::mem::swap(&mut sd.depth_in, &mut sd.depth_out);
                                sd
                            })
                            .collect()
                    };

                    // 5. Run suggest_placements for this leaf against target sections
                    let placement_suggestions =
                        suggest_placements(&leaf_shots, &target_sections, ps_config);

                    for ps in placement_suggestions {
                        // Only keep matches from the terminal end (import station 0).
                        // suggest_placements tries both ends of the leaf, but for orphan
                        // placement only the terminal end is meaningful — matches from
                        // the interior end would produce wrong orphan station indices.
                        if ps.import_station_index != 0 {
                            continue;
                        }
                        suggestions.push(OrphanPlacementSuggestion {
                            orphan_section_id: section_id,
                            orphan_section_name: section_name.clone(),
                            orphan_station_index: terminal_station_idx as usize,
                            target_section_id: ps.existing_section_id,
                            target_section_name: ps.existing_section_name,
                            target_station_index: ps.existing_station_index,
                            score: ps.score,
                            matched_shots: ps.matched_shots,
                            existing_matched_shots: ps.existing_matched_shots,
                            preferred_merge_offset: ps.preferred_merge_offset,
                            direction: ps.direction,
                            is_partial: ps.is_partial,
                            confidence: ps.confidence,
                        });
                    }
                }
            }
        }

        // Sort by score descending
        suggestions.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap_or(Ordering::Equal));

        suggestions
    }
}

impl Project {
    /// Tolerance (metres) within which two merged stations are considered the
    /// same physical point. The old release-mode alignment check used 5cm.
    pub const MERGE_ALIGNMENT_TOLERANCE_M: f64 = 0.05;

    /// Per-section cumulative LOCAL `(x, y)` for every station index
    /// (`0..=shots.len()`), before section/station offsets are applied. Built
    /// once so callers that look up many stations — the alignment check and the
    /// offset solver — avoid re-walking a section's shots on every lookup. This
    /// is what keeps those operations `O(shots + merges)` instead of the
    /// `O(merges × depth)` that made the per-mutation alignment check too costly.
    /// Resolve a stored, position-independent [`StationKey`] to a transient
    /// positional [`StationRef`] against the CURRENT section structure.
    /// `None` if the section is gone or the anchoring shot was deleted (which is
    /// exactly the "dangling reference" an integrity check should surface).
    ///
    /// This is the read side of the stable-identity boundary: cross-references are
    /// stored as `StationKey`, and the solver/IPC resolve them to a positional
    /// `StationRef` here. `O(shots)` per call — callers that resolve many keys for
    /// the same section should hoist the lookup.
    pub fn resolve_key(&self, key: &StationKey) -> Option<StationRef> {
        let section = self.get_section(key.section_id)?;
        let index = match &key.anchor {
            StationAnchor::SectionStart => 0,
            StationAnchor::AfterShot(uuid) => {
                let pos = section
                    .shots
                    .iter()
                    .position(|s| s.uuid.as_deref() == Some(uuid.as_str()))?;
                (pos + 1) as u32
            }
            StationAnchor::Index(i) => {
                if *i as usize > section.shots.len() {
                    return None;
                }
                *i
            }
        };
        Some(StationRef::new(key.section_id, index))
    }

    /// True if the stored key resolves to exactly `sr` (the sound way to ask "is
    /// this stored ref the same physical station as this positional ref" — never
    /// compare a positional `Index` key to a stored `AfterShot` key directly).
    pub fn key_is_ref(&self, key: &StationKey, sr: StationRef) -> bool {
        self.resolve_key(key) == Some(sr)
    }

    /// Build the stored [`StationKey`] for a transient positional [`StationRef`].
    /// `None` if the section is gone, the index is out of range, or the anchoring
    /// shot has no UUID (shouldn't happen after the load-time mint). Station 0
    /// anchors to `SectionStart`; station `i` to `AfterShot(uuid of shot i-1)`.
    pub fn key_for_ref(&self, sr: StationRef) -> Option<StationKey> {
        let section = self.get_section(sr.section_id)?;
        let anchor = if sr.station_index == 0 {
            StationAnchor::SectionStart
        } else {
            let shot = section.shots.get((sr.station_index - 1) as usize)?;
            StationAnchor::AfterShot(shot.uuid.clone()?)
        };
        Some(StationKey::new(sr.section_id, anchor))
    }

    /// Resolve a stored key to a positional ref for a **non-persistence display
    /// payload only**, falling back to station 0 if the anchor no longer resolves
    /// (a dangling ref). NEVER use this on a save/wire path: collapsing a dangling
    /// key to `(section, 0)` writes a phantom station-0 relationship and can
    /// collide on the `(section_id, station_index)` PRIMARY KEY. Persistence and
    /// wire encoders use [`resolve_key`] and skip what doesn't resolve. The one
    /// legitimate caller is the delete-shot impact preview, where an endpoint may
    /// intentionally be the station being removed.
    pub(crate) fn key_to_ref_lossy(&self, key: &StationKey) -> StationRef {
        self.resolve_key(key)
            .unwrap_or_else(|| StationRef::new(key.section_id, 0))
    }

    /// Positional wire form of a stored merge, or `None` if either endpoint
    /// dangles (its anchoring shot was deleted) — a dangling merge is invalid and
    /// must be omitted rather than shown at a phantom station.
    pub(crate) fn merge_to_wire(&self, m: &StationMerge) -> Option<StationMergeWire> {
        Some(StationMergeWire {
            station_a: self.resolve_key(&m.station_a)?,
            station_b: self.resolve_key(&m.station_b)?,
            merged_at: m.merged_at,
        })
    }

    /// Positional wire form of a stored zero datum, or `None` if its ref dangles.
    pub(crate) fn datum_to_wire(&self, zd: &ZeroDatum) -> Option<ZeroDatumWire> {
        Some(ZeroDatumWire {
            station_ref: self.resolve_key(&zd.station_ref)?,
            gps: zd.gps,
        })
    }

    /// Positional wire form of a stored loop closure, or `None` if either
    /// endpoint dangles.
    pub(crate) fn closure_to_wire(&self, c: &LoopClosure) -> Option<LoopClosureWire> {
        Some(LoopClosureWire {
            id: c.id,
            station_a: self.resolve_key(&c.station_a)?,
            station_b: self.resolve_key(&c.station_b)?,
            path_length: c.path_length,
            misclosure_distance: c.misclosure_distance,
            error_percentage: c.error_percentage,
            horizontal_misclosure: c.horizontal_misclosure,
            vertical_misclosure: c.vertical_misclosure,
            strategy: c.strategy,
            is_aligned: c.is_aligned,
        })
    }

    /// Re-anchor every stored cross-reference from a transitional positional form
    /// (`Index`) to the stable `AfterShot(uuid)` / `SectionStart` form, now that
    /// shots (with UUIDs) are present. Run on load so a v6 file's positional refs
    /// open with stable identity and no `Index` anchor survives into the live model.
    pub fn reanchor_station_refs(&mut self) {
        let canon: Vec<Option<StationKey>> = {
            let mut out = Vec::new();
            self.for_each_station_ref(|_label, key| {
                out.push(self.resolve_key(&key).and_then(|sr| self.key_for_ref(sr)));
            });
            out
        };
        let mut i = 0;
        self.map_station_refs(|key| {
            let next = canon.get(i).cloned().flatten();
            i += 1;
            next.unwrap_or(key)
        });
        // The two passes (for_each_station_ref above, map_station_refs here) must
        // visit the ref-bearing collections in identical order for the positional
        // `canon` alignment to be correct. That holds only because the two HashMaps
        // (station_offsets/comments) are not mutated between the passes. Assert it
        // so a future change that breaks the order coupling fails loudly in debug
        // instead of silently re-anchoring an offset onto the wrong station.
        debug_assert_eq!(
            i,
            canon.len(),
            "reanchor_station_refs: map_station_refs visited a different number of \
             refs than for_each_station_ref produced — station-ref traversal order \
             diverged between the read and write passes"
        );
    }

    fn section_local_coords(&self) -> HashMap<SectionId, Vec<(f64, f64)>> {
        let mut map = HashMap::with_capacity(self.sections.len());
        for section in &self.sections {
            let mut coords = Vec::with_capacity(section.shots.len() + 1);
            let (mut x, mut y) = (0.0_f64, 0.0_f64);
            coords.push((x, y));
            for shot in &section.shots {
                let azimuth_rad = shot.average_azimuth().to_radians();
                let horizontal = shot.horizontal_length();
                x += horizontal * azimuth_rad.sin();
                y += horizontal * azimuth_rad.cos();
                coords.push((x, y));
            }
            map.insert(section.id, coords);
        }
        map
    }

    /// World `(x, y)` of a station using a [`Self::section_local_coords`] map:
    /// section offset + cumulative local position + optional station offset.
    /// Matches the `x`/`y` of [`Self::compute_station_raw_coords`] in `O(1)`.
    fn station_world_xy(
        &self,
        sr: StationRef,
        local: &HashMap<SectionId, Vec<(f64, f64)>>,
        station_offsets: &HashMap<StationRef, (f64, f64, f64)>,
    ) -> Option<(f64, f64)> {
        let &(lx, ly) = local.get(&sr.section_id)?.get(sr.station_index as usize)?;
        let (ox, oy) = self
            .section_offsets
            .get(&sr.section_id)
            .copied()
            .unwrap_or((0.0, 0.0));
        let (mut x, mut y) = (lx + ox, ly + oy);
        if let Some(&(sx, sy, _)) = station_offsets.get(&sr) {
            x += sx;
            y += sy;
        }
        Some((x, y))
    }

    /// The `station_offsets` map (per-station manual nudges) resolved to
    /// transient positional [`StationRef`] keys against the CURRENT structure —
    /// the sound positional view for hot solver paths. Usually empty; entries
    /// whose anchor no longer resolves are dropped (surfaced by integrity).
    fn resolved_station_offsets(&self) -> HashMap<StationRef, (f64, f64, f64)> {
        let mut out = HashMap::with_capacity(self.station_offsets.len());
        for (key, &v) in &self.station_offsets {
            if let Some(sr) = self.resolve_key(key) {
                out.insert(sr, v);
            }
        }
        out
    }

    /// Per-station manual offset for a single positional ref. Found by resolving
    /// each stored key to its positional ref — sound for ANY anchor kind
    /// (canonical `AfterShot`/`SectionStart` after reanchor, or transitional
    /// `Index` straight off a raw load), unlike building a canonical key (which
    /// would never match an `Index` entry). `None` when there is no nudge (the
    /// common case — short-circuits before touching the map).
    pub(crate) fn station_offset_for_ref(&self, sr: StationRef) -> Option<(f64, f64, f64)> {
        if self.station_offsets.is_empty() {
            return None;
        }
        self.station_offsets
            .iter()
            .find(|(k, _)| self.resolve_key(k) == Some(sr))
            .map(|(_, v)| *v)
    }

    /// Station comment for a positional ref, found by resolving each stored key
    /// (sound for any anchor kind). For callers/tests that hold a positional ref
    /// rather than a stored key.
    pub(crate) fn station_comment_for_ref(&self, sr: StationRef) -> Option<&String> {
        self.station_comments
            .iter()
            .find(|(k, _)| self.resolve_key(k) == Some(sr))
            .map(|(_, v)| v)
    }
}

#[cfg(test)]
#[expect(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::float_cmp,
    clippy::panic,
    clippy::print_stderr,
    clippy::print_stdout
)]
mod tests;
