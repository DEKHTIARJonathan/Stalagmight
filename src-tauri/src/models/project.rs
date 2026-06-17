use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::collections::{BinaryHeap, HashMap, HashSet, VecDeque};
use std::cmp::Ordering;
use std::path::PathBuf;
use tracing::{debug, error, info, trace, warn};
use ts_rs::TS;

use crate::config::ClosureAdjustmentConfig;

use super::{
    gps_to_local, ClosurePreview, ClosureRef, ClosureStrategy, CollabState, Coordinates,
    FrozenShotRef, GpsBounds, GpsCoordinates, LoopClosure, Section, SectionData, SectionId,
    SectionUpdates, Shot, ShotData, ShotId, ShotUpdates, Station, StationAnchor, StationKey,
    StationMerge, StationMergeWire, StationRef, ZeroDatum, FEATURE_ID_STRIDE,
};
use super::{LoopClosureWire, ZeroDatumWire};

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
    #[serde(default, serialize_with = "serialize_station_offsets", deserialize_with = "deserialize_station_offsets")]
    #[ts(skip)]
    pub station_offsets: HashMap<StationKey, (f64, f64, f64)>,
    /// Station comments keyed by StationRef
    #[serde(default, serialize_with = "serialize_station_comments", deserialize_with = "deserialize_station_comments")]
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
        let station_merges: Vec<_> = p.station_merges.iter().filter_map(|m| p.merge_to_wire(m)).collect();
        let zero_datums: Vec<_> = p.zero_datums.iter().filter_map(|z| p.datum_to_wire(z)).collect();
        let loop_closures: Vec<_> = p.loop_closures.iter().filter_map(|c| p.closure_to_wire(c)).collect();
        // Field set + order MUST stay in lockstep with the generated Project.ts
        // (15 ts-exported fields). Adding a ts-exported field to `Project`
        // requires adding it here too, or it silently drops off the IPC payload.
        let mut st = serializer.serialize_struct("Project", 15)?;
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


    /// Query relationships that reference the given section.
    /// Returns merges, closures, offset info, and zero datum count.
    pub fn get_section_relationships(&self, section_id: SectionId) -> SectionRelationships {
        let merges: Vec<StationMergeWire> = self
            .station_merges
            .iter()
            .filter(|m| m.station_a.section_id == section_id || m.station_b.section_id == section_id)
            .filter_map(|m| self.merge_to_wire(m))
            .collect();

        let closures: Vec<LoopClosureWire> = self
            .loop_closures
            .iter()
            .filter(|lc| lc.station_a.section_id == section_id || lc.station_b.section_id == section_id)
            .filter_map(|lc| self.closure_to_wire(lc))
            .collect();

        let has_section_offset = self.section_offsets.contains_key(&section_id);

        let station_offset_count = self
            .station_offsets
            .keys()
            .filter(|sr| sr.section_id == section_id)
            .count();

        let zero_datum_count = self
            .zero_datums
            .iter()
            .filter(|zd| zd.station_ref.section_id == section_id)
            .count();

        SectionRelationships {
            merges,
            closures,
            has_section_offset,
            station_offset_count,
            zero_datum_count,
        }
    }

    /// Preserve merge-group connectivity and rewire closures before removing a section.
    ///
    /// For every station on the deleted section that participates in merges with
    /// stations on OTHER sections, we find the merge group, remove the deleted
    /// station, compute connected components among the remaining stations, and
    /// create replacement merges so that the group stays connected.
    ///
    /// For closures that reference a station on the deleted section, we rewire
    /// them to a merge-group partner on another section if one exists.
    pub(crate) fn preserve_connections_for_section_deletion(&mut self, section_id: SectionId) {
        let station_count = self
            .get_section(section_id)
            .map(|s| s.shots.len() + 1)
            .unwrap_or(0);

        // Collect all stations on this section
        let section_stations: HashSet<StationRef> = (0..station_count as u32)
            .map(|i| StationRef::new(section_id, i))
            .collect();

        // --- Merge preservation ---
        // Track which merge groups we've already processed (by a canonical member)
        let mut processed_groups: HashSet<StationRef> = HashSet::new();
        let mut replacement_merges: Vec<(StationRef, StationRef)> = Vec::new();

        for &station in &section_stations {
            let group = self.get_merge_group(station);

            // Only process groups that touch other sections
            let external_members: HashSet<StationRef> = group
                .iter()
                .filter(|s| s.section_id != section_id)
                .copied()
                .collect();

            if external_members.is_empty() {
                continue;
            }

            // Skip if we already processed this group via another station
            if external_members.iter().any(|s| processed_groups.contains(s)) {
                continue;
            }
            for &s in &external_members {
                processed_groups.insert(s);
            }

            // Build components among the external members after removing ALL
            // section stations from the graph
            let components = self.build_merge_components_excluding_section(
                &external_members,
                section_id,
            );

            if components.len() > 1 {
                // Connect each disconnected component to the first one
                let base = &components[0];
                for component in components.iter().skip(1) {
                    // Find a cross-section pair (prefer different sections)
                    let mut found = None;
                    for a in base {
                        for b in component {
                            if a.section_id != b.section_id {
                                found = Some((*a, *b));
                                break;
                            }
                        }
                        if found.is_some() {
                            break;
                        }
                    }
                    // Fall back to same-section pair if needed
                    if found.is_none() {
                        if let (Some(a), Some(b)) = (base.first(), component.first()) {
                            found = Some((*a, *b));
                        }
                    }
                    if let Some((a, b)) = found {
                        if !self.has_direct_merge(a, b)
                            && !replacement_merges
                                .iter()
                                .any(|(ra, rb)| (*ra == a && *rb == b) || (*ra == b && *rb == a))
                        {
                            replacement_merges.push((a, b));
                        }
                    }
                }
            }
        }

        // Add replacement merges (via the helper so the adjacency cache
        // stays consistent for subsequent BFS calls in this transaction).
        for (a, b) in &replacement_merges {
            let (Some(ka), Some(kb)) = (self.key_for_ref(*a), self.key_for_ref(*b)) else {
                continue;
            };
            self.record_station_merge(StationMerge {
                station_a: ka,
                station_b: kb,
                merged_at: Utc::now(),
            });
            debug!(
                a_section = a.section_id,
                a_station = a.station_index,
                b_section = b.section_id,
                b_station = b.station_index,
                "Added replacement merge during section deletion"
            );
        }

        // --- Closure rewiring ---
        let closures_to_rewire: Vec<_> = self
            .loop_closures
            .iter()
            .filter(|lc| {
                lc.station_a.section_id == section_id || lc.station_b.section_id == section_id
            })
            .map(|lc| (lc.id, lc.station_a.clone(), lc.station_b.clone()))
            .collect();

        for (closure_id, station_a, station_b) in closures_to_rewire {
            let (removed_station, other_station) = if station_a.section_id == section_id {
                (station_a, station_b)
            } else {
                (station_b, station_a)
            };

            // If both sides are on the deleted section, it will just be removed
            if other_station.section_id == section_id {
                continue;
            }
            // Resolve the keys to positional refs for the merge-group walk / checks.
            let (Some(removed_ref), Some(other_ref)) =
                (self.resolve_key(&removed_station), self.resolve_key(&other_station))
            else {
                continue;
            };

            // Find a merge-group partner on another section to rewire to
            let group = self.get_merge_group(removed_ref);
            let mut candidates: Vec<StationRef> = group
                .into_iter()
                .filter(|s| s.section_id != section_id)
                .collect();
            candidates.sort_by_key(Self::station_ref_key);

            if let Some(replacement) = candidates.first().copied() {
                // Don't rewire if it would create a self-referencing or duplicate closure
                if replacement == other_ref
                    || self.are_stations_merged(replacement, other_ref)
                    || self.are_stations_in_closure(replacement, other_ref)
                {
                    continue;
                }
                let Some(replacement_key) = self.key_for_ref(replacement) else {
                    continue;
                };

                // Rewire the closure in place
                if let Some(lc) = self.loop_closures.iter_mut().find(|lc| lc.id == closure_id) {
                    if lc.station_a.section_id == section_id {
                        lc.station_a = replacement_key;
                    } else {
                        lc.station_b = replacement_key;
                    }
                    debug!(
                        closure_id,
                        replacement_section = replacement.section_id,
                        replacement_station = replacement.station_index,
                        "Rewired closure during section deletion"
                    );
                }
            }
        }
    }

    /// Like `build_merge_components` but excludes ALL stations from a given section
    /// (not just a single station). Used during section deletion.
    fn build_merge_components_excluding_section(
        &self,
        stations: &HashSet<StationRef>,
        excluded_section: SectionId,
    ) -> Vec<Vec<StationRef>> {
        let mut adjacency: HashMap<StationRef, Vec<StationRef>> = HashMap::new();
        for station in stations {
            adjacency.entry(*station).or_default();
        }

        for merge in &self.station_merges {
            if merge.station_a.section_id == excluded_section
                || merge.station_b.section_id == excluded_section
            {
                continue;
            }
            let (Some(a), Some(b)) =
                (self.resolve_key(&merge.station_a), self.resolve_key(&merge.station_b))
            else {
                continue;
            };
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

    /// Remove all merges, closures, section_offsets, station_offsets, and zero_datums
    /// that reference the given section. Call before `remove_section()` to avoid orphans.
    pub fn cleanup_section_references(&mut self, section_id: SectionId) {
        // Remove merges referencing this section. Clearing the
        // adjacency cache is mandatory — we just dropped entries that
        // the cache still claims exist.
        self.station_merges.retain(|m| {
            m.station_a.section_id != section_id && m.station_b.section_id != section_id
        });
        self.merge_adjacency_cache.clear();

        // Remove closures referencing this section
        self.loop_closures.retain(|lc| {
            lc.station_a.section_id != section_id && lc.station_b.section_id != section_id
        });

        // Remove section offset
        self.remove_section_offset(section_id);

        // Remove station offsets referencing this section
        self.station_offsets.retain(|sr, _| sr.section_id != section_id);

        // Remove station comments referencing this section
        self.station_comments.retain(|sr, _| sr.section_id != section_id);

        // Remove zero datums referencing this section
        self.zero_datums.retain(|zd| zd.station_ref.section_id != section_id);
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

    /// Read a section's offset, defaulting to (0, 0).
    pub(crate) fn section_offset(&self, id: SectionId) -> (f64, f64) {
        self.section_offsets.get(&id).copied().unwrap_or((0.0, 0.0))
    }

    /// Apply a delta to one section's offset. Low-level primitive —
    /// callers handle cascade and invariants.
    pub(crate) fn adjust_section_offset(&mut self, id: SectionId, dx: f64, dy: f64) {
        let current = self.section_offset(id);
        self.section_offsets
            .insert(id, (current.0 + dx, current.1 + dy));
    }

    /// Set an exact offset value (for undo restoration / initial placement).
    pub(crate) fn set_section_offset(&mut self, id: SectionId, offset: (f64, f64)) {
        self.section_offsets.insert(id, offset);
    }

    /// Remove a section's offset entry entirely.
    pub(crate) fn remove_section_offset(&mut self, id: SectionId) {
        self.section_offsets.remove(&id);
    }

    /// Apply the same delta to every section in a merge group.
    pub(crate) fn adjust_rigid_group_offsets(&mut self, anchor: SectionId, dx: f64, dy: f64) {
        let group = self.get_merged_section_ids(anchor);
        for sid in group {
            self.adjust_section_offset(sid, dx, dy);
        }
    }

    /// Does the merge group containing `section_id` hold a zero datum?
    pub(crate) fn rigid_group_has_datum(&self, id: SectionId) -> bool {
        let group = self.get_merged_section_ids(id);
        group
            .iter()
            .any(|sid| self.zero_datums.iter().any(|zd| zd.station_ref.section_id == *sid))
    }


    /// Assert that all merge points are colocated (within 1cm tolerance).
    /// Only active in debug builds — no-op in release.
    /// Check that all merge points are colocated. Logs a warning for any
    /// merge pair more than 5cm apart (allows for floating-point accumulation
    /// across many shots in real survey data). In test builds, panics for
    /// gaps > 1cm to catch regressions with synthetic data.
    pub(crate) fn debug_assert_merge_alignment(&self, context: &str) {
        // Despite the name, this used to run in release too — and the cost
        // is brutal: O(N) merges × 2 × O(N) `compute_station_raw_coords`
        // per call, called from every mutating command. For a 1 200-section
        // TML import this contributed ~1.5 billion operations to the hot
        // path. Gate the whole body behind `debug_assertions` so it
        // remains a sanity check during development without harming
        // production performance. The release-mode `error!` log it used
        // to emit was informational only — alignment drift inside a
        // *single* command is a programmer bug, not a data condition the
        // user can fix at runtime.
        #[cfg(debug_assertions)]
        {
            for merge in &self.station_merges {
                // Skip same-section merges (physically meaningless, used only in tests)
                if merge.station_a.section_id == merge.station_b.section_id {
                    continue;
                }
                let a = self.resolve_key(&merge.station_a).and_then(|s| self.compute_station_raw_coords(s));
                let b = self.resolve_key(&merge.station_b).and_then(|s| self.compute_station_raw_coords(s));
                if let (Some(a_pos), Some(b_pos)) = (a, b) {
                    let dist = ((a_pos.x - b_pos.x).powi(2) + (a_pos.y - b_pos.y).powi(2)).sqrt();
                    if dist >= 0.05 {
                        error!(
                            context,
                            a_ref = ?merge.station_a,
                            b_ref = ?merge.station_b,
                            dist,
                            a_x = a_pos.x,
                            a_y = a_pos.y,
                            b_x = b_pos.x,
                            b_y = b_pos.y,
                            "Merge alignment violated (>{threshold}m)",
                            threshold = 0.05,
                        );
                    }
                    #[cfg(test)]
                    debug_assert!(
                        dist < 0.01,
                        "Merge alignment violated after {context}: stations {a_ref:?} and {b_ref:?} \
                         are {dist:.6}m apart (threshold 0.01m). \
                         A=({ax:.6}, {ay:.6}), B=({bx:.6}, {by:.6})",
                        a_ref = merge.station_a,
                        b_ref = merge.station_b,
                        ax = a_pos.x,
                        ay = a_pos.y,
                        bx = b_pos.x,
                        by = b_pos.y,
                    );
                }
            }
        }
        // Suppress unused warning in release.
        let _ = context;
    }

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
            let (Some(a), Some(b)) =
                (self.resolve_key(&merge.station_a), self.resolve_key(&merge.station_b))
            else {
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

    /// Stations adjacent to `station_ref` through shots (skipping `excluded_shot`)
    /// and merges, plus loop closures when `include_closures` is true. Pass
    /// `false` to ask "are these connected by the *survey itself*" — used to tell
    /// a true loop from a detached pair when deciding closure-vs-merge.
    fn station_neighbors_excluding_shot(
        &self,
        station_ref: StationRef,
        excluded_shot: Option<(SectionId, usize)>,
        include_closures: bool,
    ) -> Vec<StationRef> {
        let mut neighbors = Vec::new();
        let Some(section) = self.get_section(station_ref.section_id) else {
            return neighbors;
        };
        let idx = station_ref.station_index as usize;
        if idx > section.shots.len() {
            return neighbors;
        }

        // Adjacent stations via shots (skip the excluded shot)
        if idx > 0 {
            let shot_idx = idx - 1;
            if excluded_shot != Some((station_ref.section_id, shot_idx)) {
                neighbors.push(StationRef::new(station_ref.section_id, (idx - 1) as u32));
            }
        }
        if idx < section.shots.len() {
            let shot_idx = idx;
            if excluded_shot != Some((station_ref.section_id, shot_idx)) {
                neighbors.push(StationRef::new(station_ref.section_id, (idx + 1) as u32));
            }
        }

        // Merges (resolve stored keys to positional refs)
        for merge in &self.station_merges {
            if self.key_is_ref(&merge.station_a, station_ref) {
                neighbors.extend(self.resolve_key(&merge.station_b));
            } else if self.key_is_ref(&merge.station_b, station_ref) {
                neighbors.extend(self.resolve_key(&merge.station_a));
            }
        }

        // Closures (all strategies)
        if include_closures {
            for closure in &self.loop_closures {
                if self.key_is_ref(&closure.station_a, station_ref) {
                    neighbors.extend(self.resolve_key(&closure.station_b));
                } else if self.key_is_ref(&closure.station_b, station_ref) {
                    neighbors.extend(self.resolve_key(&closure.station_a));
                }
            }
        }

        neighbors
    }

    fn are_stations_connected_excluding_shot(
        &self,
        station_a: StationRef,
        station_b: StationRef,
        excluded_shot: Option<(SectionId, usize)>,
        include_closures: bool,
    ) -> bool {
        if station_a == station_b {
            return true;
        }
        let mut visited = HashSet::new();
        let mut queue = VecDeque::new();
        visited.insert(station_a);
        queue.push_back(station_a);

        while let Some(current) = queue.pop_front() {
            for neighbor in self.station_neighbors_excluding_shot(current, excluded_shot, include_closures) {
                if visited.insert(neighbor) {
                    if neighbor == station_b {
                        return true;
                    }
                    queue.push_back(neighbor);
                }
            }
        }
        false
    }

    fn station_reaches_zero_datum_excluding_shot(
        &self,
        station_ref: StationRef,
        excluded_shot: Option<(SectionId, usize)>,
    ) -> bool {
        let zero_datum_set: HashSet<StationRef> = self
            .zero_datums
            .iter()
            .filter_map(|zd| self.resolve_key(&zd.station_ref))
            .collect();
        if zero_datum_set.contains(&station_ref) {
            return true;
        }
        let mut visited = HashSet::new();
        let mut queue = VecDeque::new();
        visited.insert(station_ref);
        queue.push_back(station_ref);

        while let Some(current) = queue.pop_front() {
            for neighbor in self.station_neighbors_excluding_shot(current, excluded_shot, true) {
                if visited.insert(neighbor) {
                    if zero_datum_set.contains(&neighbor) {
                        return true;
                    }
                    queue.push_back(neighbor);
                }
            }
        }
        false
    }

    // === Shot operations ===

    fn max_shots_per_section() -> usize {
        FEATURE_ID_STRIDE.saturating_sub(1) as usize
    }

    /// Add a shot to a section
    pub fn add_shot(&mut self, section_id: SectionId, data: ShotData) -> Option<&Shot> {
        let section = self.get_section_mut(section_id)?;
        if section.shots.len() >= Self::max_shots_per_section() {
            return None;
        }
        let shot = section.add_shot(data);
        let shot_id = shot.id;
        self.touch();
        self.get_section(section_id)?.get_shot(shot_id)
    }

    /// Insert a shot after a specific shot in a section. `forced_id` preserves
    /// the original id and `forced_uuid` the original collaboration UUID when
    /// redo re-runs this exact path (see [`AppState::redo`]); pass `None`/`None`
    /// for normal inserts (a fresh UUID is minted).
    pub fn insert_shot_after(
        &mut self,
        section_id: SectionId,
        after_shot_id: ShotId,
        data: ShotData,
        forced_id: Option<ShotId>,
        forced_uuid: Option<String>,
    ) -> Option<&Shot> {
        // Look up position before mutable borrow
        let section = self.get_section(section_id)?;
        let pos = section.shots.iter().position(|s| s.id == after_shot_id)?;
        if section.shots.len() >= Self::max_shots_per_section() {
            return None;
        }
        // Compute displacement before data is consumed — the new shot shifts
        // all stations after the insertion point.
        let (dx, dy) = Self::shot_displacement(&data);
        let section = self.get_section_mut(section_id)?;
        let shot = section.insert_shot_after_with_id(after_shot_id, data, forced_id, forced_uuid)?;
        let shot_id = shot.id;
        // Station keys are position-independent: no ref-shifting on insert (the
        // junction the new shot extends from keeps its anchor; shots beyond keep
        // theirs). The new shot's displacement still shifts stations > pos+1 in
        // space — if the tail side is datum-anchored, back-shift the offset so the
        // tail stays put. Positions are resolved from the stored keys.
        if dx != 0.0 || dy != 0.0 {
            let boundary = (pos + 1) as u32;
            let on_tail = |key: &StationKey| -> bool {
                key.section_id == section_id
                    && self.resolve_key(key).is_some_and(|sr| sr.station_index > boundary)
            };
            let tail_anchored = self.zero_datums.iter().any(|zd| on_tail(&zd.station_ref))
                || self.station_merges.iter().any(|m| {
                    let (our, their) = if m.station_a.section_id == section_id {
                        (&m.station_a, &m.station_b)
                    } else if m.station_b.section_id == section_id {
                        (&m.station_b, &m.station_a)
                    } else {
                        return false;
                    };
                    on_tail(our)
                        && their.section_id != section_id
                        && self.has_datum_path_excluding(their.section_id, section_id)
                })
                || self.loop_closures.iter().any(|c| {
                    if !c.is_aligned { return false; }
                    let (our, their) = if c.station_a.section_id == section_id {
                        (&c.station_a, &c.station_b)
                    } else if c.station_b.section_id == section_id {
                        (&c.station_b, &c.station_a)
                    } else {
                        return false;
                    };
                    on_tail(our)
                        && their.section_id != section_id
                        && self.has_datum_path_excluding(their.section_id, section_id)
                });

            if tail_anchored {
                self.adjust_section_offset(section_id, -dx, -dy);
            }
        }
        self.cascade_connection_offsets(&[section_id]);
        self.debug_assert_merge_alignment("insert_shot_after");
        self.touch();
        self.get_section(section_id)?.get_shot(shot_id)
    }

    /// Insert a shot before a specific shot in a section. `forced_id` preserves
    /// the original id and `forced_uuid` the original collaboration UUID when
    /// redo re-runs this exact path; pass `None`/`None` for normal inserts.
    pub fn insert_shot_before(
        &mut self,
        section_id: SectionId,
        before_shot_id: ShotId,
        data: ShotData,
        forced_id: Option<ShotId>,
        forced_uuid: Option<String>,
    ) -> Option<&Shot> {
        // Look up position before mutable borrow
        let section = self.get_section(section_id)?;
        let pos = section.shots.iter().position(|s| s.id == before_shot_id)?;
        if section.shots.len() >= Self::max_shots_per_section() {
            return None;
        }

        // Inserting before shot[pos] (pos > 0) is the SAME physical insertion as
        // inserting after shot[pos-1]: same array slot, same station split. Route
        // it through the one code path so the ref-shift / offset / cascade can't
        // diverge between the two entry points (the off-by-one that re-pointed a
        // boundary merge onto the new station and silently displaced its
        // partner). Only the prepend case (pos == 0, no preceding shot) is
        // genuinely distinct and handled below.
        if pos > 0 {
            let prev_id = section.shots[pos - 1].id;
            return self.insert_shot_after(section_id, prev_id, data, forced_id, forced_uuid);
        }

        // Prepend (pos == 0): the new shot becomes the section's first shot and
        // every existing station shifts up by one; keep them in place by
        // back-shifting the offset.
        let (dx, dy) = Self::shot_displacement(&data);
        let section = self.get_section_mut(section_id)?;
        let shot = section.insert_shot_before_with_id(before_shot_id, data, forced_id, forced_uuid)?;
        let shot_id = shot.id;
        // Prepend is the one insert that shifts identity: the old section-start
        // station is now *after* the new first shot, so re-anchor any ref on this
        // section that was `SectionStart` to `AfterShot(new_shot)`. Every other
        // anchor is position-independent and needs no change.
        let new_uuid = self.get_section(section_id).and_then(|s| s.shots.first()?.uuid.clone());
        if let Some(new_uuid) = new_uuid {
            self.map_station_refs(|key| {
                if key.section_id == section_id && key.anchor == StationAnchor::SectionStart {
                    StationKey::new(section_id, StationAnchor::AfterShot(new_uuid.clone()))
                } else {
                    key
                }
            });
        }
        if dx != 0.0 || dy != 0.0 {
            self.adjust_section_offset(section_id, -dx, -dy);
        }
        self.cascade_connection_offsets(&[section_id]);
        self.debug_assert_merge_alignment("insert_shot_before");
        self.touch();
        self.get_section(section_id)?.get_shot(shot_id)
    }

    /// Update a shot
    pub fn update_shot(
        &mut self,
        section_id: SectionId,
        shot_id: ShotId,
        updates: &ShotUpdates,
    ) -> Option<&Shot> {
        let section = self.get_section_mut(section_id)?;
        let shot = section.get_shot_mut(shot_id)?;
        shot.apply_updates(updates);
        self.touch();
        self.get_section(section_id)?.get_shot(shot_id)
    }

    pub fn preview_delete_shot(
        &self,
        section_id: SectionId,
        shot_id: ShotId,
    ) -> Result<DeleteShotImpact, String> {
        let section = self
            .get_section(section_id)
            .ok_or_else(|| format!("Section {section_id} not found"))?;
        let pos = section
            .shots
            .iter()
            .position(|s| s.id == shot_id)
            .ok_or_else(|| format!("Shot {shot_id} not found in section {section_id}"))?;

        let removed_station = if pos == 0 {
            StationRef::new(section_id, 0)
        } else {
            StationRef::new(section_id, (pos + 1) as u32)
        };

        let mut impact = DeleteShotImpact {
            removed_station,
            removed_merges: Vec::new(),
            removed_closures: Vec::new(),
            replacement_merges: Vec::new(),
            replacement_closure_updates: Vec::new(),
            closure_to_merge: Vec::new(),
            merge_rewire_skipped: false,
            closure_rewire_skipped: false,
            shift_blocked: false,
            shift_blocked_reasons: Vec::new(),
        };

        for merge in &self.station_merges {
            if self.key_is_ref(&merge.station_a, removed_station)
                || self.key_is_ref(&merge.station_b, removed_station)
            {
                impact.removed_merges.push(StationPair {
                    station_a: self.key_to_ref_lossy(&merge.station_a),
                    station_b: self.key_to_ref_lossy(&merge.station_b),
                });
            }
        }

        for closure in &self.loop_closures {
            if self.key_is_ref(&closure.station_a, removed_station)
                || self.key_is_ref(&closure.station_b, removed_station)
            {
                impact.removed_closures.push(ClosurePair {
                    closure_id: closure.id,
                    station_a: self.key_to_ref_lossy(&closure.station_a),
                    station_b: self.key_to_ref_lossy(&closure.station_b),
                });
            }
        }

        let merge_group = self.get_merge_group(removed_station);
        let mut merge_group_without = merge_group;
        merge_group_without.remove(&removed_station);

        if merge_group_without.len() > 1 {
            let components = self.build_merge_components(&merge_group_without, removed_station);
            if components.len() > 1 {
                let base_component = &components[0];

                let mut planned_pairs: Vec<StationPair> = Vec::new();
                for component in components.iter().skip(1) {
                    let mut found_pair: Option<StationPair> = None;
                    for station_a in base_component {
                        for station_b in component {
                            if station_a.section_id != station_b.section_id {
                                found_pair = Some(StationPair {
                                    station_a: *station_a,
                                    station_b: *station_b,
                                });
                                break;
                            }
                        }
                        if found_pair.is_some() {
                            break;
                        }
                    }

                    if let Some(pair) = found_pair {
                        if !self.has_direct_merge(pair.station_a, pair.station_b)
                            && !planned_pairs.iter().any(|p| {
                                (p.station_a == pair.station_a && p.station_b == pair.station_b)
                                    || (p.station_a == pair.station_b
                                        && p.station_b == pair.station_a)
                            })
                        {
                            planned_pairs.push(pair);
                        }
                    } else {
                        impact.merge_rewire_skipped = true;
                    }
                }

                impact.replacement_merges = planned_pairs;
            }
        }

        if !impact.removed_closures.is_empty() {
            let mut candidates: Vec<StationRef> = merge_group_without.into_iter().collect();
            candidates.sort_by_key(Self::station_ref_key);
            let replacement = candidates.first().copied();

            for closure in &impact.removed_closures {
                if let Some(replacement_station) = replacement {
                    let other = if closure.station_a == removed_station {
                        closure.station_b
                    } else {
                        closure.station_a
                    };

                    if replacement_station == other
                        || self.are_stations_merged(replacement_station, other)
                        || self.are_stations_in_closure(replacement_station, other)
                    {
                        impact.closure_rewire_skipped = true;
                    } else if self.are_stations_connected_excluding_shot(
                        replacement_station,
                        other,
                        Some((section_id, pos)),
                        false,
                    ) {
                        // The two ends still reach each other through the survey
                        // (shots + merges), so it remains a genuine loop — just
                        // move the closure off the deleted station.
                        impact.replacement_closure_updates.push(ClosureUpdate {
                            closure_id: closure.closure_id,
                            old_station: removed_station,
                            new_station: replacement_station,
                        });
                    } else {
                        // The loop is broken: the surviving segment is detached,
                        // so the closure becomes a plain merge (issue #8).
                        impact.closure_to_merge.push(StationPair {
                            station_a: replacement_station,
                            station_b: other,
                        });
                    }
                } else {
                    impact.closure_rewire_skipped = true;
                }
            }
        }

        let is_mid_shot = pos > 0 && pos < section.shots.len() - 1;
        if is_mid_shot {
            let station_before = StationRef::new(section_id, pos as u32);
            let station_after = StationRef::new(section_id, (pos + 1) as u32);
            let excluded = Some((section_id, pos));

            if self.are_stations_connected_excluding_shot(station_before, station_after, excluded, true) {
                impact.shift_blocked_reasons.push(
                    "This shot is part of a loop (the two sides are already connected).".to_string(),
                );
            }

            let anchored_before = self.station_reaches_zero_datum_excluding_shot(station_before, excluded);
            let anchored_after = self.station_reaches_zero_datum_excluding_shot(station_after, excluded);
            if anchored_before && anchored_after {
                impact.shift_blocked_reasons.push(
                    "Both sides are anchored to a zero datum.".to_string(),
                );
            }

            impact.shift_blocked = !impact.shift_blocked_reasons.is_empty();
        }

        Ok(impact)
    }

    pub fn remove_shot_with_rewire(
        &mut self,
        section_id: SectionId,
        shot_id: ShotId,
    ) -> Result<(Shot, DeleteShotImpact), String> {
        let section = self
            .get_section(section_id)
            .ok_or_else(|| format!("Section {section_id} not found"))?;
        let pos = section
            .shots
            .iter()
            .position(|s| s.id == shot_id)
            .ok_or_else(|| format!("Shot {shot_id} not found in section {section_id}"))?;

        let impact = self.preview_delete_shot(section_id, shot_id)?;
        let removed_station = impact.removed_station;
        // The deleted station's canonical key (still resolvable — the shot is
        // removed below). Stored refs are canonical, so key equality is sound.
        let removed_key = self.key_for_ref(removed_station);

        if let Some(rk) = removed_key.clone() {
            self.station_offsets.remove(&rk);
            self.station_comments.remove(&rk);
            self.zero_datums.retain(|zd| zd.station_ref != rk);
            self.station_merges.retain(|m| m.station_a != rk && m.station_b != rk);
        }
        self.merge_adjacency_cache.clear();

        // Pre-resolve replacement closure targets to keys (the drain below can't
        // borrow `self`).
        let closure_updates: HashMap<u64, StationKey> = impact
            .replacement_closure_updates
            .iter()
            .filter_map(|u| self.key_for_ref(u.new_station).map(|k| (u.closure_id, k)))
            .collect();

        let mut updated_closures = Vec::with_capacity(self.loop_closures.len());
        for mut closure in self.loop_closures.drain(..) {
            let touches_a = removed_key.as_ref() == Some(&closure.station_a);
            let touches_b = removed_key.as_ref() == Some(&closure.station_b);
            if touches_a || touches_b {
                if let Some(new_key) = closure_updates.get(&closure.id).cloned() {
                    if touches_a {
                        closure.station_a = new_key;
                    } else {
                        closure.station_b = new_key;
                    }
                    updated_closures.push(closure);
                }
                // else: closure dropped (its anchoring station is gone)
            } else {
                updated_closures.push(closure);
            }
        }
        self.loop_closures = updated_closures;

        for pair in &impact.replacement_merges {
            if !self.has_direct_merge(pair.station_a, pair.station_b) {
                if let (Some(ka), Some(kb)) =
                    (self.key_for_ref(pair.station_a), self.key_for_ref(pair.station_b))
                {
                    self.record_station_merge(StationMerge {
                        station_a: ka,
                        station_b: kb,
                        merged_at: Utc::now(),
                    });
                }
            }
        }

        // Closures whose loop the deletion broke become plain merges: the
        // endpoints stay declared-coincident but are no longer a true loop (#8).
        for pair in &impact.closure_to_merge {
            if !self.has_direct_merge(pair.station_a, pair.station_b) {
                if let (Some(ka), Some(kb)) =
                    (self.key_for_ref(pair.station_a), self.key_for_ref(pair.station_b))
                {
                    self.record_station_merge(StationMerge {
                        station_a: ka,
                        station_b: kb,
                        merged_at: Utc::now(),
                    });
                }
            }
        }

        let deleted_shot = {
            let section_mut = self
                .get_section_mut(section_id)
                .ok_or_else(|| format!("Section {section_id} not found"))?;
            section_mut
                .remove_shot(shot_id)
                .ok_or_else(|| format!("Shot {shot_id} not found in section {section_id}"))?
        };

        // Station keys are position-independent — no ref-shifting on delete. The
        // deleted station's own refs were rewired above; every surviving ref keeps
        // its anchor (its resolved index just moves down).
        //
        // One case the `removed_station` rewire above can't catch: a ref anchored
        // directly on the DELETED shot's boundary, `AfterShot(deleted_uuid)`, that
        // is NOT the `removed_station` (this happens at `pos == 0`, where
        // `removed_station` is `SectionStart` but a prepend had re-anchored a
        // boundary ref to `AfterShot(first_shot)`). Its anchoring shot is now gone,
        // so re-anchor it to the station that absorbs the deleted boundary —
        // `SectionStart` when the first shot was removed, else `AfterShot(prev)`.
        if let Some(deleted_uuid) = deleted_shot.uuid.clone() {
            let survivor = if pos == 0 {
                Some(StationAnchor::SectionStart)
            } else {
                self.get_section(section_id)
                    .and_then(|s| s.shots.get(pos - 1))
                    .and_then(|s| s.uuid.clone())
                    .map(StationAnchor::AfterShot)
            };
            if let Some(survivor) = survivor {
                let stale = StationAnchor::AfterShot(deleted_uuid);
                self.map_station_refs(|key| {
                    if key.section_id == section_id && key.anchor == stale {
                        StationKey::new(section_id, survivor.clone())
                    } else {
                        key
                    }
                });
            }
        }

        // The deletion may have removed the OTHER path of a loop, leaving a
        // closure as the sole bridge to a section — that is no longer a loop, so
        // turn any such closure into a merge before the offsets are recomputed
        // (issue #8, beyond the closure-touched-the-deleted-station case above).
        self.convert_orphan_closures_to_merges();

        // After removing a shot, stations after the deletion point (index > pos)
        // shift by -displacement in section-local coordinates.  We must decide
        // which side to keep at its original absolute position:
        //
        //   - tail anchored (datum reachable via post-deletion stations):
        //     adjust offset += displacement → tail stays, head shifts
        //   - head anchored or neither anchored:
        //     don't adjust offset → head stays, tail shifts
        //
        // The shift_blocked guard already prevents deletion when BOTH sides
        // are datum-anchored.
        let (dx, dy) = Self::shot_displacement(&deleted_shot.to_shot_data());

        if pos == 0 {
            // First shot: station 0 removed, ALL remaining stations are "tail".
            // Always adjust to keep them in place.
            if dx != 0.0 || dy != 0.0 {
                self.adjust_section_offset(section_id, dx, dy);
            }
        } else if dx != 0.0 || dy != 0.0 {
            // Mid-section: check if the tail side is datum-anchored. Tail stations
            // resolve to index > pos (after the deletion renumbered them).
            let on_tail = |key: &StationKey| -> bool {
                key.section_id == section_id
                    && self.resolve_key(key).is_some_and(|sr| sr.station_index > pos as u32)
            };
            let tail_anchored = self.zero_datums.iter().any(|zd| on_tail(&zd.station_ref))
                || self.station_merges.iter().any(|m| {
                    let (our, their) = if m.station_a.section_id == section_id {
                        (&m.station_a, &m.station_b)
                    } else if m.station_b.section_id == section_id {
                        (&m.station_b, &m.station_a)
                    } else {
                        return false;
                    };
                    on_tail(our)
                        && their.section_id != section_id
                        && self.has_datum_path_excluding(their.section_id, section_id)
                })
                || self.loop_closures.iter().any(|c| {
                    if !c.is_aligned { return false; }
                    let (our, their) = if c.station_a.section_id == section_id {
                        (&c.station_a, &c.station_b)
                    } else if c.station_b.section_id == section_id {
                        (&c.station_b, &c.station_a)
                    } else {
                        return false;
                    };
                    on_tail(our)
                        && their.section_id != section_id
                        && self.has_datum_path_excluding(their.section_id, section_id)
                });

            if tail_anchored {
                self.adjust_section_offset(section_id, dx, dy);
            }
        }

        // Cascade offset adjustments for any drifted connections on the
        // non-anchored side.
        self.cascade_connection_offsets(&[section_id]);
        self.debug_assert_merge_alignment("remove_shot_with_rewire");

        self.touch();
        Ok((deleted_shot, impact))
    }

    /// Remove a shot
    pub fn remove_shot(&mut self, section_id: SectionId, shot_id: ShotId) -> Option<Shot> {
        self.remove_shot_with_rewire(section_id, shot_id)
            .ok()
            .map(|(shot, _)| shot)
    }

    /// Set a shot as reference or not
    pub fn set_shot_reference(
        &mut self,
        section_id: SectionId,
        shot_id: ShotId,
        is_reference: bool,
    ) -> Option<&Shot> {
        let section = self.get_section_mut(section_id)?;
        let shot = section.get_shot_mut(shot_id)?;
        shot.is_reference = is_reference;
        self.touch();
        self.get_section(section_id)?.get_shot(shot_id)
    }

    // === Station operations ===

    /// Get all section IDs connected to the given section through merges and closures.
    /// Both merges and closures are treated as bidirectional edges.
    /// Returns a set containing the given section and all transitively connected sections.
    pub fn get_connected_section_ids(&self, section_id: SectionId) -> HashSet<SectionId> {
        let mut connected = HashSet::new();
        let mut queue = vec![section_id];

        while let Some(current) = queue.pop() {
            if connected.insert(current) {
                // Follow merges as edges
                for merge in &self.station_merges {
                    if merge.station_a.section_id == current {
                        if !connected.contains(&merge.station_b.section_id) {
                            queue.push(merge.station_b.section_id);
                        }
                    } else if merge.station_b.section_id == current
                        && !connected.contains(&merge.station_a.section_id) {
                            queue.push(merge.station_a.section_id);
                        }
                }
                // Follow closures as edges (bidirectional, same as merges)
                for closure in &self.loop_closures {
                    if closure.station_a.section_id == current {
                        if !connected.contains(&closure.station_b.section_id) {
                            queue.push(closure.station_b.section_id);
                        }
                    } else if closure.station_b.section_id == current
                        && !connected.contains(&closure.station_a.section_id) {
                            queue.push(closure.station_a.section_id);
                        }
                }
            }
        }
        connected
    }

    /// Get all section IDs connected through merges and aligned closures (rigid groups).
    /// Unaligned closures are ignored so sections can move independently before adjustment.
    pub fn get_rigid_connected_section_ids(&self, section_id: SectionId) -> HashSet<SectionId> {
        let mut connected = HashSet::new();
        let mut queue = vec![section_id];

        while let Some(current) = queue.pop() {
            if connected.insert(current) {
                // Follow merges as edges
                for merge in &self.station_merges {
                    if merge.station_a.section_id == current {
                        if !connected.contains(&merge.station_b.section_id) {
                            queue.push(merge.station_b.section_id);
                        }
                    } else if merge.station_b.section_id == current
                        && !connected.contains(&merge.station_a.section_id) {
                            queue.push(merge.station_a.section_id);
                        }
                }
                // Follow aligned closures as edges (bidirectional, same as merges)
                for closure in &self.loop_closures {
                    if !closure.is_aligned {
                        continue;
                    }
                    if closure.station_a.section_id == current {
                        if !connected.contains(&closure.station_b.section_id) {
                            queue.push(closure.station_b.section_id);
                        }
                    } else if closure.station_b.section_id == current
                        && !connected.contains(&closure.station_a.section_id) {
                            queue.push(closure.station_a.section_id);
                        }
                }
            }
        }
        connected
    }

    /// Cascade offset adjustments through drifted merge/closure connections.
    ///
    /// `seeds` are the sections whose geometry is authoritative (changed
    /// sections, datum-bearing sections, etc.).  BFS outward through merges
    /// and aligned closures: when one side is authoritative and the other is
    /// not, adjust the non-authoritative side's section offset to re-align,
    /// then mark it authoritative so further connections cascade.
    ///
    /// Zero-datum-bearing sections are always included as authoritative.
    pub(crate) fn cascade_connection_offsets(&mut self, seeds: &[SectionId]) {
        // Honor the batch-import opt-out: skip cascade during the
        // per-section import loop so the cost stays linear. The batch
        // driver in execute_import_sections runs ONE final cascade
        // (with all created sections as seeds) after the loop, which
        // is equivalent to the union of the deferred cascades for a
        // tree-shaped import.
        if self.cascade_deferred {
            return;
        }

        // Coincidence edges, kept in TWO graphs: merges (the rigid, acyclic
        // forest — loop-forming merges are rejected in merge_stations) and
        // ALIGNED loop closures (the redundant, cycle-closing edges; unaligned
        // closures are inert). Solving merges to full reach FIRST, then closures,
        // keeps a hard merge constraint winning over a stale aligned closure on
        // any section the merges can reach.
        let push_edge = |adj: &mut HashMap<SectionId, Vec<(StationRef, StationRef)>>,
                         a: StationRef,
                         b: StationRef| {
            adj.entry(a.section_id).or_default().push((a, b));
            adj.entry(b.section_id).or_default().push((b, a));
        };
        let mut merge_adj: HashMap<SectionId, Vec<(StationRef, StationRef)>> = HashMap::new();
        for m in &self.station_merges {
            if let (Some(a), Some(b)) =
                (self.resolve_key(&m.station_a), self.resolve_key(&m.station_b))
            {
                push_edge(&mut merge_adj, a, b);
            }
        }
        let mut closure_adj: HashMap<SectionId, Vec<(StationRef, StationRef)>> = HashMap::new();
        for c in &self.loop_closures {
            if c.is_aligned {
                if let (Some(a), Some(b)) =
                    (self.resolve_key(&c.station_a), self.resolve_key(&c.station_b))
                {
                    push_edge(&mut closure_adj, a, b);
                }
            }
        }
        if merge_adj.is_empty() && closure_adj.is_empty() {
            return;
        }

        // O(1) station coordinates via the per-section local-coord precompute,
        // so each visit is constant work instead of re-walking the section's
        // shots. Local coords are offset-independent, so this stays valid as
        // offsets are mutated.
        let local = self.section_local_coords();
        let station_offsets = self.resolved_station_offsets();

        // Authoritative anchors: the seeds + every datum-bearing section.
        let mut authoritative: HashSet<SectionId> = HashSet::new();
        for &sid in seeds {
            authoritative.insert(sid);
        }
        for zd in &self.zero_datums {
            authoritative.insert(zd.station_ref.section_id);
        }

        let sorted = |auth: &HashSet<SectionId>| {
            let mut v: Vec<SectionId> = auth.iter().copied().collect();
            v.sort_unstable();
            v
        };

        // Phase 1: BFS over merges only, to full reachability.
        let seed1 = sorted(&authoritative);
        self.cascade_bfs(&merge_adj, &local, &station_offsets, &mut authoritative, &seed1);

        // Phase 2: aligned closures bridge to any component merges couldn't
        // reach; merges within that component then continue. A redundant closure
        // (both ends already authoritative) is skipped, leaving its residual —
        // the loop misclosure — intact.
        if !closure_adj.is_empty() {
            let mut combined = merge_adj;
            for (section, edges) in closure_adj {
                combined.entry(section).or_default().extend(edges);
            }
            let seed2 = sorted(&authoritative);
            self.cascade_bfs(&combined, &local, &station_offsets, &mut authoritative, &seed2);
        }
    }

    /// One BFS pass of the offset solver over a coincidence-edge `adjacency`,
    /// starting from the already-`authoritative` sections in `seeds` order. Each
    /// non-authoritative neighbour reached through a computable edge has its
    /// section offset set so its station coincides with the anchored side, then
    /// is itself marked authoritative and enqueued. A neighbour reached only
    /// through a dangling/out-of-range edge (coords return `None`) is left alone
    /// — it is not anchored or propagated, so it can't mis-position a chain
    /// behind a broken reference.
    fn cascade_bfs(
        &mut self,
        adjacency: &HashMap<SectionId, Vec<(StationRef, StationRef)>>,
        local: &HashMap<SectionId, Vec<(f64, f64)>>,
        station_offsets: &HashMap<StationRef, (f64, f64, f64)>,
        authoritative: &mut HashSet<SectionId>,
        seeds: &[SectionId],
    ) {
        let mut queue: VecDeque<SectionId> = seeds.iter().copied().collect();
        while let Some(section) = queue.pop_front() {
            let Some(neighbors) = adjacency.get(&section).cloned() else {
                continue;
            };
            for (mine, theirs) in neighbors {
                if authoritative.contains(&theirs.section_id) {
                    continue;
                }
                if let (Some((mx, my)), Some((tx, ty))) = (
                    self.station_world_xy(mine, local, station_offsets),
                    self.station_world_xy(theirs, local, station_offsets),
                ) {
                    let dx = mx - tx;
                    let dy = my - ty;
                    // A non-finite delta means the coincidence isn't computable (a
                    // NaN/inf-poisoned section). Don't adjust, anchor, OR propagate
                    // through it: marking the unpositioned neighbour authoritative
                    // would drag ITS other partners to a bogus location, and the
                    // alignment check can't see a NaN distance to catch it later.
                    // Treat it like a dangling edge — leave the neighbour alone.
                    if dx.is_finite() && dy.is_finite() {
                        if dx != 0.0 || dy != 0.0 {
                            self.adjust_section_offset(theirs.section_id, dx, dy);
                        }
                        // Anchor + propagate ONLY when the coincidence was computable.
                        authoritative.insert(theirs.section_id);
                        queue.push_back(theirs.section_id);
                    }
                }
            }
        }
    }

    /// Check whether `start` can reach a zero datum station via merges and
    /// aligned closures WITHOUT traversing through `excluded`.  This is used
    /// by the doubly-anchored guard: a merge/closure to a partner is only a
    /// positional constraint if that partner is independently datum-anchored.
    pub(crate) fn has_datum_path_excluding(
        &self,
        start: SectionId,
        excluded: SectionId,
    ) -> bool {
        let mut visited = HashSet::new();
        let mut queue = vec![start];
        while let Some(current) = queue.pop() {
            if current == excluded {
                continue;
            }
            if !visited.insert(current) {
                continue;
            }
            if self
                .zero_datums
                .iter()
                .any(|zd| zd.station_ref.section_id == current)
            {
                return true;
            }
            for m in &self.station_merges {
                if m.station_a.section_id == current
                    && !visited.contains(&m.station_b.section_id)
                {
                    queue.push(m.station_b.section_id);
                }
                if m.station_b.section_id == current
                    && !visited.contains(&m.station_a.section_id)
                {
                    queue.push(m.station_a.section_id);
                }
            }
            for c in &self.loop_closures {
                if !c.is_aligned {
                    continue;
                }
                if c.station_a.section_id == current
                    && !visited.contains(&c.station_b.section_id)
                {
                    queue.push(c.station_b.section_id);
                }
                if c.station_b.section_id == current
                    && !visited.contains(&c.station_a.section_id)
                {
                    queue.push(c.station_a.section_id);
                }
            }
        }
        false
    }

    /// Get all section IDs connected through station merges only (rigid groups).
    /// Closures are NOT followed. Use this for rigid-group operations:
    /// datum propagation, offset application, zero-datum validation.
    pub fn get_merged_section_ids(&self, section_id: SectionId) -> HashSet<SectionId> {
        let mut connected = HashSet::new();
        // Fast path: the adjacency cache is non-empty (or we have no
        // merges at all). BFS visits each connected section once with
        // O(neighbours) work per step → O(group size) total instead of
        // the legacy O(group × N_merges).
        if !self.merge_adjacency_cache.is_empty() || self.station_merges.is_empty() {
            let mut queue = vec![section_id];
            while let Some(current) = queue.pop() {
                if connected.insert(current) {
                    if let Some(neighbours) = self.merge_adjacency_cache.get(&current) {
                        for &n in neighbours {
                            if !connected.contains(&n) {
                                queue.push(n);
                            }
                        }
                    }
                }
            }
            return connected;
        }

        // Cold path: cache was cleared (e.g. after deserialisation or a
        // structural remove). Fall back to the legacy linear scan rather
        // than mutating self here — callers that care about throughput
        // call `rebuild_merge_adjacency` first.
        let mut queue = vec![section_id];
        while let Some(current) = queue.pop() {
            if connected.insert(current) {
                for merge in &self.station_merges {
                    if merge.station_a.section_id == current {
                        if !connected.contains(&merge.station_b.section_id) {
                            queue.push(merge.station_b.section_id);
                        }
                    } else if merge.station_b.section_id == current
                        && !connected.contains(&merge.station_a.section_id) {
                            queue.push(merge.station_a.section_id);
                        }
                }
            }
        }
        connected
    }

    /// Capture section offsets for all sections connected to the given section.
    /// Returns a HashMap where:
    ///   - Key is the section ID
    ///   - Value is Option<(f64, f64)>: Some if offset existed, None if key didn't exist
    ///
    /// This is used by undo to restore exact previous state.
    pub fn capture_connected_section_offsets(
        &self,
        section_id: SectionId,
    ) -> HashMap<SectionId, Option<(f64, f64)>> {
        let merged_sections = self.get_merged_section_ids(section_id);
        let mut offsets = HashMap::new();
        for sid in merged_sections {
            offsets.insert(sid, self.section_offsets.get(&sid).copied());
        }
        offsets
    }

    /// Restore section offsets from a captured snapshot.
    ///
    /// For each entry in `offsets`:
    /// - `Some(offset)` restores the offset to that value
    /// - `None` removes the offset (it didn't exist before)
    ///
    /// This is used by undo to restore exact previous state (counterpart of
    /// `capture_connected_section_offsets`).
    pub fn restore_section_offsets(&mut self, offsets: &HashMap<SectionId, Option<(f64, f64)>>) {
        for (section_id, prev_offset) in offsets {
            match prev_offset {
                Some(offset) => {
                    self.section_offsets.insert(*section_id, *offset);
                }
                None => {
                    self.section_offsets.remove(section_id);
                }
            }
        }
    }

    /// Every zero-datum station whose section lies in the same merge-connected
    /// component as `section_id` (resolved to current StationRefs).
    ///
    /// This is the single source of truth for "what anchors this rigid group?" —
    /// `section_has_zero_datum`, `find_connected_zero_datum`, the merge guard, and
    /// the over-anchoring detector all derive from it, so they cannot drift apart.
    ///
    /// Counts only datums that still RESOLVE: a corrupt project can be opened with a
    /// dangling zero datum (anchor shot deleted) so the user can repair it, and a
    /// dangling datum is not a real anchor. Counting it would let a merge pick the
    /// phantom-anchored section as the fixed group and shift the world coordinate
    /// system around a station that doesn't exist.
    pub(crate) fn component_datum_refs(&self, section_id: SectionId) -> Vec<StationRef> {
        let merged = self.get_merged_section_ids(section_id);
        self.zero_datums
            .iter()
            .filter_map(|zd| self.resolve_key(&zd.station_ref))
            .filter(|sr| merged.contains(&sr.section_id))
            .collect()
    }

    /// Check if a section is connected to a zero datum (directly or through merges only).
    fn section_has_zero_datum(&self, section_id: SectionId) -> bool {
        !self.component_datum_refs(section_id).is_empty()
    }

    /// Group resolved zero datums by their merge-connected component, returning
    /// only the components that hold MORE THAN ONE datum. An empty result means
    /// the "≤1 zero datum per merge component" invariant holds.
    ///
    /// Two GPS anchors in one rigid merge group over-constrain it: the offset
    /// cascade ([`Self::cascade_connection_offsets`]) marks every datum section
    /// authoritative, so the two wavefronts meet on a merge edge that cannot
    /// satisfy both anchors and that merge visibly tears apart. This is how the
    /// invariant violation surfaces to the user.
    pub fn over_anchored_merge_components(&self) -> Vec<Vec<StationRef>> {
        let resolved: Vec<StationRef> = self
            .zero_datums
            .iter()
            .filter_map(|zd| self.resolve_key(&zd.station_ref))
            .collect();
        let mut groups: Vec<(HashSet<SectionId>, Vec<StationRef>)> = Vec::new();
        for sr in resolved {
            if let Some(group) = groups
                .iter_mut()
                .find(|(sections, _)| sections.contains(&sr.section_id))
            {
                group.1.push(sr);
            } else {
                groups.push((self.get_merged_section_ids(sr.section_id), vec![sr]));
            }
        }
        groups
            .into_iter()
            .map(|(_, refs)| refs)
            .filter(|refs| refs.len() > 1)
            .collect()
    }

    /// Would adding a merge between sections `a` and `b` place two zero datums in
    /// one merge component? True only when `a` and `b` are in DIFFERENT merge
    /// components and EACH component is already anchored — i.e. the merge would
    /// fuse two independently-anchored rigid groups. Used to keep
    /// [`Self::convert_orphan_closures_to_merges`] from silently creating the
    /// over-constraint (a closure between two anchored groups is legitimate; a
    /// rigid merge between them is not).
    pub(crate) fn merge_would_double_anchor(&self, a: SectionId, b: SectionId) -> bool {
        let component_a = self.get_merged_section_ids(a);
        if component_a.contains(&b) {
            // Already the same merge component — a redundant merge adds no anchor.
            return false;
        }
        let anchored = |component: &HashSet<SectionId>| {
            self.zero_datums
                .iter()
                .filter_map(|zd| self.resolve_key(&zd.station_ref))
                .any(|sr| component.contains(&sr.section_id))
        };
        anchored(&component_a) && anchored(&self.get_merged_section_ids(b))
    }

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
    pub(crate) fn compute_station_raw_coords(&self, station_ref: StationRef) -> Option<Coordinates> {
        let section = self.get_section(station_ref.section_id)?;

        // Get section offset
        let (offset_x, offset_y) = self.section_offsets.get(&section.id).copied().unwrap_or((0.0, 0.0));
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
    pub(crate) fn calculate_path_length_between(&self, station_a: StationRef, station_b: StationRef) -> f64 {
        self.calculate_path_length_impl(station_a, station_b, true)
    }

    /// Calculate path length through shots and merges only (no closures).
    /// Use this when only rigid-group survey path length is needed.
    #[cfg(test)]
    pub(crate) fn calculate_merge_only_path_length(&self, station_a: StationRef, station_b: StationRef) -> f64 {
        self.calculate_path_length_impl(station_a, station_b, false)
    }

    /// Internal Dijkstra path length implementation.
    /// When `include_closures` is true, loop closures are treated as zero-distance edges.
    fn calculate_path_length_impl(&self, station_a: StationRef, station_b: StationRef, include_closures: bool) -> f64 {
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
        heap.push(HeapItem { cost: 0.0, node: station_a });

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
                        heap.push(HeapItem { cost: next_cost, node: neighbor });
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
                    heap.push(HeapItem { cost: next_cost, node: neighbor });
                }
            }

            // Merge neighbors (zero distance)
            if let Some(neighbors) = merge_adj.get(&node) {
                for &neighbor in neighbors {
                    let next_cost = cost;
                    if dist.get(&neighbor).is_none_or(|&d| next_cost < d - 1e-9) {
                        dist.insert(neighbor, next_cost);
                        heap.push(HeapItem { cost: next_cost, node: neighbor });
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
                            heap.push(HeapItem { cost: next_cost, node: neighbor });
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
        fallback_sections.iter()
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
                    (
                        signed.x * weight,
                        signed.y * weight,
                        signed.z * weight,
                    )
                }
                ClosureStrategy::EqualDistribution => {
                    let weight = 1.0 / shot_count as f64;
                    (
                        signed.x * weight,
                        signed.y * weight,
                        signed.z * weight,
                    )
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
                self.adjust_least_squares(
                    &component,
                    &closures,
                    anchor_station,
                    config,
                )?;
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
        let mut conflict_samples: Vec<(SectionId, StationRef, StationRef, Coordinates, Coordinates)> = Vec::new();
        let mut conflicted_sections: HashSet<SectionId> = HashSet::new();
        let mut section_station_counts: HashMap<SectionId, usize> = HashMap::new();
        let mut section_targets: HashMap<SectionId, HashMap<StationRef, Coordinates>> = HashMap::new();

        for section in self.sections.iter().filter(|s| sections_to_align.contains(&s.id)) {
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
                        .filter_map(|idx| self.key_for_ref(StationRef::new(*section_id, idx as u32)))
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
                                .filter_map(|idx| self.key_for_ref(StationRef::new(section_id, idx as u32)))
                                .collect();
                            for key in keys {
                                let entry = self.station_offsets.entry(key).or_insert((0.0, 0.0, 0.0));
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
                    let current_end = self
                        .compute_station_raw_coords(end)
                        .ok_or_else(|| "Failed to compute merge segment end coordinates".to_string())?;
                    let correction = Self::coords_sub(target_end, current_end);
                    if Self::coords_norm(correction) <= 1e-9 {
                        return Ok(());
                    }

                    let section_lookup = self.build_section_lookup();
                    let section = section_lookup
                        .get(&section_id)
                        .ok_or_else(|| "Section not found for merge alignment".to_string())?;
                    let (start_idx, end_idx, forward) = if start.station_index < end.station_index {
                        (start.station_index as usize, end.station_index as usize, true)
                    } else {
                        (end.station_index as usize, start.station_index as usize, false)
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
                if let (Some(a), Some(b)) =
                    (self.resolve_key(&merge.station_a), self.resolve_key(&merge.station_b))
                {
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
                if let (Some(a), Some(b)) =
                    (self.resolve_key(&closure.station_a), self.resolve_key(&closure.station_b))
                {
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
        let mut out: HashMap<StationRef, Coordinates> =
            HashMap::with_capacity(station_list.len());
        for section in self.sections.iter().filter(|s| component.contains(&s.id)) {
            let (offset_x, offset_y) =
                self.section_offsets.get(&section.id).copied().unwrap_or((0.0, 0.0));
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
            order.push(Elim { u, nbrs: nbrs.clone(), dxu: pdx, dyu: pdy, cxu: pcx, cyu: pcy });

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
        let mut z: Vec<f64> = r.iter().zip(inv_diag.iter()).map(|(&ri, &mi)| ri * mi).collect();
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

                let sigma_dx = ((az.sin() * sigma_len).powi(2) + (len * az.cos() * sigma_az).powi(2)).sqrt();
                let sigma_dy = ((az.cos() * sigma_len).powi(2) + (len * az.sin() * sigma_az).powi(2)).sqrt();

                let w_x = if sigma_dx > 0.0 { 1.0 / (sigma_dx * sigma_dx) } else { 0.0 };
                let w_y = if sigma_dy > 0.0 { 1.0 / (sigma_dy * sigma_dy) } else { 0.0 };

                let i_idx = unknown_index.get(&root_i).copied();
                let j_idx = unknown_index.get(&root_j).copied();

                let b_x = match (i_idx, j_idx) {
                    (Some(_), Some(_)) => vec.x,
                    (Some(_), None) => {
                        let xj = fixed_coords.get(&root_j).copied().unwrap_or_else(|| Coordinates::new(0.0, 0.0, 0.0));
                        vec.x - xj.x
                    }
                    (None, Some(_)) => {
                        let xi = fixed_coords.get(&root_i).copied().unwrap_or_else(|| Coordinates::new(0.0, 0.0, 0.0));
                        vec.x + xi.x
                    }
                    (None, None) => 0.0,
                };
                let b_y = match (i_idx, j_idx) {
                    (Some(_), Some(_)) => vec.y,
                    (Some(_), None) => {
                        let yj = fixed_coords.get(&root_j).copied().unwrap_or_else(|| Coordinates::new(0.0, 0.0, 0.0));
                        vec.y - yj.y
                    }
                    (None, Some(_)) => {
                        let yi = fixed_coords.get(&root_i).copied().unwrap_or_else(|| Coordinates::new(0.0, 0.0, 0.0));
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
        let (sol_x, sol_y) = Self::solve_reduced_laplacian(
            n, &diag_x, &diag_y, &atb_x, &atb_y, &adj, &x0_x, &x0_y,
        );

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
                group_coords.insert(
                    *root,
                    Coordinates::new(sol_x[*idx], sol_y[*idx], raw_z),
                );
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

            let mut degree: HashMap<StationRef, usize> = adj_deg
                .iter()
                .map(|(s, nbrs)| (*s, nbrs.len()))
                .collect();

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
        for section in self.sections.iter_mut().filter(|s| component.contains(&s.id)) {
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

                let offset_i = station_offsets.get(&station_i).copied().unwrap_or((0.0, 0.0, 0.0));
                let offset_j = station_offsets.get(&station_j).copied().unwrap_or((0.0, 0.0, 0.0));

                let base_i = Coordinates::new(coords_i.x - offset_i.0, coords_i.y - offset_i.1, coords_i.z - offset_i.2);
                let base_j = Coordinates::new(coords_j.x - offset_j.0, coords_j.y - offset_j.1, coords_j.z - offset_j.2);

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
                        return Err("Least squares adjustment produced inconsistent section translation".to_string());
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
        heap.push(HeapItem { cost: 0.0, node: start });

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
                    let shot_len = section.shots.get(prev_index as usize).map_or(0.0, |s| s.length);
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
                        heap.push(HeapItem { cost: next_cost, node: neighbor });
                    }
                }
            }

            // Next station
            if (node.station_index as usize) < section.shots.len() {
                let next_index = node.station_index + 1;
                let shot_len = section.shots.get(node.station_index as usize).map_or(0.0, |s| s.length);
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
                    heap.push(HeapItem { cost: next_cost, node: neighbor });
                }
            }

            // Merge neighbors (zero distance)
            if let Some(neighbors) = merge_adj.get(&node) {
                for &neighbor in neighbors {
                    let next_cost = cost;
                    if dist.get(&neighbor).is_none_or(|&d| next_cost < d - 1e-9) {
                        dist.insert(neighbor, next_cost);
                        prev.insert(neighbor, (node, PathEdge::Merge));
                        heap.push(HeapItem { cost: next_cost, node: neighbor });
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
        Some(StationPath { start, steps: steps_rev })
    }

    fn shortest_path_shots_merges(&self, start: StationRef, goal: StationRef) -> Option<StationPath> {
        let (found, prev) = self.shortest_path_with_target(start, |node| node == goal)?;
        Self::reconstruct_path(start, found, &prev)
    }

    fn shortest_path_to_any_zero_datum(&self, start: StationRef) -> Option<(StationRef, StationPath)> {
        if self.zero_datums.is_empty() {
            return None;
        }
        let zero_set: HashSet<StationRef> =
            self.zero_datums.iter().filter_map(|zd| self.resolve_key(&zd.station_ref)).collect();
        let (found, prev) = self.shortest_path_with_target(start, |node| zero_set.contains(&node))?;
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

        fn find(
            parent: &mut HashMap<StationRef, StationRef>,
            x: StationRef,
        ) -> StationRef {
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
                Ordering::Less => { parent.insert(ra, rb); }
                Ordering::Greater => { parent.insert(rb, ra); }
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

        fn find(
            parent: &mut HashMap<StationRef, StationRef>,
            x: StationRef,
        ) -> StationRef {
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
                Ordering::Less => { parent.insert(ra, rb); }
                Ordering::Greater => { parent.insert(rb, ra); }
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
        if self.zero_datums.iter().any(|zd| self.key_is_ref(&zd.station_ref, station_ref))
            && Self::coords_norm(delta) > 1e-9
        {
            error!(
                station_ref = ?station_ref,
                delta = ?delta,
                purpose = "protect zero datum position",
                "Zero datum station move requested outside GPS update"
            );
        }

        let existing = self.station_offset_for_ref(station_ref).unwrap_or((0.0, 0.0, 0.0));
        let total_dx = existing.0 + delta.x;
        let total_dy = existing.1 + delta.y;
        let total_dz = existing.2 + delta.z;

        let Some(section) = self.sections.iter_mut().find(|s| s.id == station_ref.section_id) else {
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
        let root_for = |station: StationRef| station_to_group.get(&station).copied().unwrap_or(station);
        let mut zero_datum_set: HashSet<StationRef> =
            self.zero_datums.iter().filter_map(|zd| self.resolve_key(&zd.station_ref)).collect();
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

        let is_group_anchored = |station: StationRef, groups: &HashMap<StationRef, Vec<StationRef>>| -> bool {
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

        let coords_start = if start == station_a { coords_a_orig } else { coords_b_orig };
        let coords_end = if end == station_a { coords_a_orig } else { coords_b_orig };

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
                if let PathEdge::Shot { section_id, shot_index, .. } = step.edge {
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
            zero_nodes.sort_by(|a, b| (a.section_id, a.station_index).cmp(&(b.section_id, b.station_index)));
            zero_nodes.dedup();

            if zero_nodes.len() > 1 {
                return Err("Multiple zero datum stations in closure path".to_string());
            }

            if zero_nodes.len() == 1 && zero_nodes[0] != station_a && zero_nodes[0] != station_b {
                let anchor = zero_nodes[0];
                let path_a = self
                    .shortest_path_shots_merges(anchor, station_a)
                    .ok_or_else(|| "Failed to build path from zero datum to station A".to_string())?;
                let path_b = self
                    .shortest_path_shots_merges(anchor, station_b)
                    .ok_or_else(|| "Failed to build path from zero datum to station B".to_string())?;

                let mut total_len = 0.0;
                let mut shot_count = 0usize;
                add_path_stats(&path_a, &mut total_len, &mut shot_count);
                add_path_stats(&path_b, &mut total_len, &mut shot_count);

                if (strategy == ClosureStrategy::ProportionalByLength && total_len <= 0.0)
                    || (strategy == ClosureStrategy::EqualDistribution && shot_count == 0)
                {
                    return Err("No distributable shots found for zero datum loop path".to_string());
                }

                let coords_anchor = self
                    .compute_station_raw_coords(anchor)
                    .ok_or_else(|| "Failed to compute coordinates for zero datum anchor".to_string())?;

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

                let coords_start = if path.start == station_a { coords_a_orig } else { coords_b_orig };
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
                        self.apply_station_move_internal(*member, Self::coords_scale(residual, -1.0))?;
                    }
                } else {
                    self.apply_station_move_internal(station_b, Self::coords_scale(residual, -1.0))?;
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

    /// Merge two stations
    /// Returns Err if validation fails, Ok(true) on success
    pub fn merge_stations(
        &mut self,
        station_a: StationRef,
        station_b: StationRef,
    ) -> Result<bool, String> {
        debug!(
            station_a = ?station_a,
            station_b = ?station_b,
            purpose = "merge stations",
            "Merging stations"
        );
        // Check that both stations exist
        if !self.station_exists(station_a) || !self.station_exists(station_b) {
            return Err("One or both stations do not exist".to_string());
        }

        // Check not already merged
        if self.are_stations_merged(station_a, station_b) {
            return Err("These stations are already merged".to_string());
        }

        // Reject only if the two sections are already RIGIDLY connected (via merges
        // or *aligned* closures) — adding a merge there would create a redundant
        // rigid cycle, which is what a loop closure is for. An INERT (unaligned)
        // closure does not constrain the two stations yet, so a merge across one is
        // the first real connection and must be allowed; rejecting it (the old
        // get_connected_section_ids walk, which followed inert closures too) forced
        // users into the sole-bridge-closure-that-should-be-a-merge bug. This asserts
        // the same graph the cascade actually solves (catalog #8 / #integrity Root 3).
        let connected_a = self.get_rigid_connected_section_ids(station_a.section_id);
        if connected_a.contains(&station_b.section_id) {
            return Err("Stations are already connected. Use Create Loop Closure instead.".to_string());
        }

        // Check zero datum status - uses transitive connections through existing merges
        // This ensures that if B is connected to a datum-holding section C through an
        // earlier merge, b_has_zd will be true and the merge will propagate datum positioning
        let a_has_zd = self.section_has_zero_datum(station_a.section_id);
        let b_has_zd = self.section_has_zero_datum(station_b.section_id);

        if a_has_zd && b_has_zd {
            return Err("Both stations are connected to zero datums. Remove one zero datum before merging, or create a loop closure if the sections are connected.".to_string());
        }

        debug!(
            station_a = ?station_a,
            station_b = ?station_b,
            a_has_zero_datum = a_has_zd,
            b_has_zero_datum = b_has_zd,
            purpose = "merge stations",
            "Resolved zero datum anchors for merge"
        );

        // Compute current coordinates (includes existing section offsets)
        // Coordinates are in the world coordinate system established by the datum
        let coords_a = self.compute_station_raw_coords(station_a)
            .ok_or_else(|| "Failed to compute coordinates for station A".to_string())?;
        let coords_b = self.compute_station_raw_coords(station_b)
            .ok_or_else(|| "Failed to compute coordinates for station B".to_string())?;

        // Datum propagation: When merging a section without datum into a datum group,
        // the non-datum section is repositioned to align with the datum coordinate system.
        // This is similar to set_zero_datum() offset calculation but triggered by merge.
        //
        // Determine which section group needs to move:
        // - If A has zero datum (direct or transitive), B's group moves to align with A
        // - If B has zero datum (direct or transitive), A's group moves to align with B
        // - If neither has zero datum, A's group moves to align with B (arbitrary choice)
        let (anchor_coords, moving_coords, moving_section_id) = if a_has_zd {
            (coords_a, coords_b, station_b.section_id)
        } else {
            // B has zero datum OR neither has one (in which case B is the anchor)
            (coords_b, coords_a, station_a.section_id)
        };

        // Calculate offset to move the merge point station from its current position
        // to the anchor station's position, aligning them in world coordinates
        let offset_x = anchor_coords.x - moving_coords.x;
        let offset_y = anchor_coords.y - moving_coords.y;

        // Apply offset to all sections in the moving merge group (rigid body)
        // This repositions the entire moving group relative to the datum coordinate system
        let moving_sections = self.get_merged_section_ids(moving_section_id);
        // Resolve-aware (a dangling datum is not a real anchor — matching
        // section_has_zero_datum), so a deleted-anchor datum can't trigger a
        // spurious "merge would move a zero datum" alarm.
        let moving_has_zero_datum = self
            .zero_datums
            .iter()
            .filter_map(|zd| self.resolve_key(&zd.station_ref))
            .any(|sr| moving_sections.contains(&sr.section_id));
        if moving_has_zero_datum && (offset_x.abs() > 1e-9 || offset_y.abs() > 1e-9) {
            error!(
                moving_section_id,
                offset_x,
                offset_y,
                moving_section_count = moving_sections.len(),
                purpose = "protect zero datum position",
                "Merge would move a zero datum section"
            );
        }

        debug!(
            moving_section_id,
            moving_section_count = moving_sections.len(),
            offset_x,
            offset_y,
            purpose = "merge stations",
            "Computed merge offset for moving sections"
        );
        self.adjust_rigid_group_offsets(moving_section_id, offset_x, offset_y);

        // Record the merge via the helper so the merge-adjacency cache
        // stays in sync. (Direct push would silently skip the cache,
        // forcing the next BFS into the O(N) fallback path.)
        let (Some(key_a), Some(key_b)) =
            (self.key_for_ref(station_a), self.key_for_ref(station_b))
        else {
            return Err("Cannot merge: station has no stable anchor".to_string());
        };
        self.record_station_merge(StationMerge {
            station_a: key_a,
            station_b: key_b,
            merged_at: Utc::now(),
        });

        // Cascade through any further connections that the new merge may ripple into
        self.cascade_connection_offsets(&[station_a.section_id, station_b.section_id]);
        self.debug_assert_merge_alignment("merge_stations");
        self.touch();
        Ok(true)
    }

    /// Compute closure metrics between two stations without mutation.
    /// Both stations must exist and have computable coordinates.
    pub(crate) fn compute_closure_metrics(
        &self,
        station_a: StationRef,
        station_b: StationRef,
    ) -> Result<ClosurePreview, String> {
        trace!(
            station_a = ?station_a,
            station_b = ?station_b,
            purpose = "compute closure metrics",
            "Computing closure metrics"
        );
        let coords_a = self.compute_station_raw_coords(station_a)
            .ok_or_else(|| "Failed to compute coordinates for station A".to_string())?;
        let coords_b = self.compute_station_raw_coords(station_b)
            .ok_or_else(|| "Failed to compute coordinates for station B".to_string())?;

        let horizontal_misclosure = coords_a.horizontal_distance_to(&coords_b);
        let vertical_misclosure = (coords_a.z - coords_b.z).abs();
        let misclosure_distance = coords_a.distance_to(&coords_b);
        let path_length = self.calculate_path_length_between(station_a, station_b);

        let error_percentage = if path_length > 0.0 {
            (misclosure_distance / path_length) * 100.0
        } else {
            0.0
        };

        debug!(
            station_a = ?station_a,
            station_b = ?station_b,
            path_length,
            misclosure_distance,
            error_percentage,
            horizontal_misclosure,
            vertical_misclosure,
            purpose = "compute closure metrics",
            "Computed closure metrics"
        );

        Ok(ClosurePreview {
            path_length,
            misclosure_distance,
            error_percentage,
            horizontal_misclosure,
            vertical_misclosure,
        })
    }

    /// Create a loop closure between two connected stations
    /// Returns the created LoopClosure on success
    pub fn create_loop_closure(
        &mut self,
        station_a: StationRef,
        station_b: StationRef,
        strategy: ClosureStrategy,
    ) -> Result<LoopClosure, String> {
        debug!(
            station_a = ?station_a,
            station_b = ?station_b,
            strategy = ?strategy,
            purpose = "create loop closure",
            "Creating loop closure"
        );
        // Check that both stations exist
        if !self.station_exists(station_a) || !self.station_exists(station_b) {
            return Err("One or both stations do not exist".to_string());
        }

        // Reject already-merged station pairs
        if self.are_stations_merged(station_a, station_b) {
            return Err("These stations are already merged. Closures are for unmerged station pairs.".to_string());
        }

        // Check stations are connected (via merges or closures)
        let connected_a = self.get_connected_section_ids(station_a.section_id);
        let connected = connected_a.contains(&station_b.section_id);
        if !connected {
            let a_has_zd = self.section_has_zero_datum(station_a.section_id);
            let b_has_zd = self.section_has_zero_datum(station_b.section_id);
            if !(a_has_zd && b_has_zd) {
                return Err("Stations are not connected. They must be in the same connected group to create a loop closure.".to_string());
            }
        }

        // Check for duplicate closure between same station pair
        let already_has_closure = self.are_stations_in_closure(station_a, station_b);
        if already_has_closure {
            return Err("A loop closure already exists between these stations.".to_string());
        }

        // Compute closure values using shared helper
        let metrics = self.compute_closure_metrics(station_a, station_b)?;

        // Deferred: create-time distribution strategies are disabled for now.
        if matches!(
            strategy,
            ClosureStrategy::ProportionalByLength | ClosureStrategy::EqualDistribution
        ) {
            return Err("Closure distribution strategies are deferred. Use Batch.".to_string());
        }

        // Normalize next_closure_id in case of legacy deserialization (default 0)
        let max_existing = self.loop_closures.iter().map(|lc| lc.id).max().unwrap_or(0);
        if self.next_closure_id <= max_existing {
            self.next_closure_id = max_existing + 1;
        }
        // Assign next closure ID from monotonic counter
        let next_id = self.next_closure_id;
        self.next_closure_id += 1;

        let (Some(key_a), Some(key_b)) =
            (self.key_for_ref(station_a), self.key_for_ref(station_b))
        else {
            return Err("Cannot create loop closure: station has no stable anchor".to_string());
        };
        let closure = LoopClosure {
            id: next_id,
            station_a: key_a,
            station_b: key_b,
            path_length: metrics.path_length,
            misclosure_distance: metrics.misclosure_distance,
            error_percentage: metrics.error_percentage,
            horizontal_misclosure: metrics.horizontal_misclosure,
            vertical_misclosure: metrics.vertical_misclosure,
            strategy,
            is_aligned: strategy == ClosureStrategy::Move,
        };

        self.loop_closures.push(closure.clone());
        self.touch();

        info!(
            closure_id = closure.id,
            station_a = ?station_a,
            station_b = ?station_b,
            strategy = ?strategy,
            purpose = "create loop closure",
            "Loop closure created"
        );

        Ok(closure)
    }

    /// Remove a loop closure by ID
    pub fn remove_loop_closure(&mut self, closure_id: u64) -> Result<LoopClosure, String> {
        if let Some(pos) = self.loop_closures.iter().position(|lc| lc.id == closure_id) {
            let closure = self.loop_closures.remove(pos);
            self.touch();
            info!(
                closure_id,
                station_a = ?closure.station_a,
                station_b = ?closure.station_b,
                purpose = "remove loop closure",
                "Loop closure removed"
            );
            Ok(closure)
        } else {
            Err("Loop closure not found".to_string())
        }
    }

    /// Unmerge stations. Also removes closures for the specific unmerged pair only.
    /// Returns (success, removed_closures) where removed_closures contains any
    /// loop closures that matched this specific station pair.
    pub fn unmerge_stations(
        &mut self,
        station_a: StationRef,
        station_b: StationRef,
    ) -> (bool, Vec<LoopClosure>) {
        let pos = self.station_merges.iter().position(|m| {
            (self.key_is_ref(&m.station_a, station_a) && self.key_is_ref(&m.station_b, station_b))
                || (self.key_is_ref(&m.station_a, station_b)
                    && self.key_is_ref(&m.station_b, station_a))
        });

        if let Some(pos) = pos {
            self.station_merges.remove(pos);
            // Drop the adjacency cache — recomputing the precise edge
            // deletion would duplicate the work `retain` already did.
            self.merge_adjacency_cache.clear();

            // Decide which closures match the unmerged pair before the retain —
            // `resolve_key` needs `&self`, but `retain` borrows `loop_closures`
            // mutably, so the resolution can't happen inside the closure.
            let remove_flags: Vec<bool> = self
                .loop_closures
                .iter()
                .map(|lc| {
                    (self.key_is_ref(&lc.station_a, station_a)
                        && self.key_is_ref(&lc.station_b, station_b))
                        || (self.key_is_ref(&lc.station_a, station_b)
                            && self.key_is_ref(&lc.station_b, station_a))
                })
                .collect();

            // Remove closures for the specific unmerged pair only
            let mut removed_closures = Vec::new();
            let mut flag_iter = remove_flags.into_iter();
            self.loop_closures.retain(|lc| {
                if flag_iter.next() == Some(true) {
                    removed_closures.push(lc.clone());
                    false
                } else {
                    true
                }
            });

            self.touch();
            (true, removed_closures)
        } else {
            (false, Vec::new())
        }
    }

    /// Check if two stations are merged
    pub fn are_stations_merged(&self, a: StationRef, b: StationRef) -> bool {
        if a == b {
            return true;
        }
        // Check transitive merge equivalence using BFS through merge graph.
        // Two stations are "merged" if there's any chain of merges connecting them
        // (i.e., they're in the same merge group).
        let mut visited = HashSet::new();
        let mut queue = VecDeque::new();
        visited.insert(a);
        queue.push_back(a);

        while let Some(current) = queue.pop_front() {
            for merge in &self.station_merges {
                let neighbor = if self.key_is_ref(&merge.station_a, current) {
                    self.resolve_key(&merge.station_b)
                } else if self.key_is_ref(&merge.station_b, current) {
                    self.resolve_key(&merge.station_a)
                } else {
                    None
                };
                if let Some(n) = neighbor {
                    if n == b {
                        return true;
                    }
                    if visited.insert(n) {
                        queue.push_back(n);
                    }
                }
            }
        }
        false
    }

    /// Check if two stations are in a loop closure
    pub fn are_stations_in_closure(&self, a: StationRef, b: StationRef) -> bool {
        self.loop_closures.iter().any(|lc| {
            (self.key_is_ref(&lc.station_a, a) && self.key_is_ref(&lc.station_b, b))
                || (self.key_is_ref(&lc.station_a, b) && self.key_is_ref(&lc.station_b, a))
        })
    }

    /// Check if a station reference is valid
    pub fn station_exists(&self, station_ref: StationRef) -> bool {
        if let Some(section) = self.get_section(station_ref.section_id) {
            // Station index 0 is before first shot, subsequent indices are after each shot
            station_ref.station_index as usize <= section.shots.len()
        } else {
            false
        }
    }

    /// The zero datum (other than `station_ref` itself) that already anchors the
    /// merge-connected rigid group `station_ref` belongs to, if any. Used to reject
    /// setting a second datum on an already-anchored group. Merge-only connectivity
    /// via the shared [`Self::component_datum_refs`] source of truth.
    fn find_connected_zero_datum(&self, station_ref: StationRef) -> Option<StationRef> {
        self.component_datum_refs(station_ref.section_id)
            .into_iter()
            .find(|&sr| sr != station_ref)
    }

    /// Format a station reference for user display.
    /// Uses section name if available, otherwise "Section N" (0-indexed to match canonical IDs).
    /// Station index is displayed as 0-indexed to match UI format (e.g., "Section #0").
    fn format_station_ref_for_display(&self, station_ref: StationRef) -> String {
        let section_label = self
            .sections
            .iter()
            .find(|s| s.id == station_ref.section_id)
            .and_then(|s| s.name.as_ref()).map_or_else(|| format!("Section {}", station_ref.section_id), |name| format!("\"{name}\""));

        // Display station index as 0-indexed to match canonical StationRef format
        format!("{} #{}", section_label, station_ref.station_index)
    }

    /// Set a station as the zero datum and reposition connected sections.
    ///
    /// When a GPS reference is set:
    /// - For the first datum: The station is repositioned to (0, 0) via section offsets
    /// - For subsequent datums: The station is positioned at the GPS offset from the first datum
    ///
    /// All sections connected through station merges are moved together.
    /// Z-coordinates (depths) are preserved and not affected by GPS positioning.
    ///
    /// Returns Err if the station doesn't exist, GPS is invalid, or if a connected station
    /// already has a zero datum.
    pub fn set_zero_datum(
        &mut self,
        station_ref: StationRef,
        gps: GpsCoordinates,
    ) -> Result<bool, String> {
        if !self.station_exists(station_ref) {
            return Err("Station does not exist".to_string());
        }

        // Validate GPS coordinates to prevent serialization issues
        GpsCoordinates::validate(gps.latitude, gps.longitude, gps.depth_reference)?;

        // Stable stored identity for this datum's station.
        let datum_key = self
            .key_for_ref(station_ref)
            .ok_or_else(|| "Cannot set zero datum: station has no stable anchor".to_string())?;

        // Check for connected zero datum
        if let Some(existing) = self.find_connected_zero_datum(station_ref) {
            let new_station = self.format_station_ref_for_display(station_ref);
            let existing_station = self.format_station_ref_for_display(existing);
            return Err(format!(
                "Cannot set zero datum: {new_station} is connected to {existing_station} which already has a zero datum"
            ));
        }

        info!(
            station_ref = ?station_ref,
            gps_lat = gps.latitude,
            gps_lng = gps.longitude,
            purpose = "anchor survey to GPS",
            "Setting zero datum"
        );

        // Get all sections connected through merges (rigid group for offset propagation)
        let connected_sections = self.get_merged_section_ids(station_ref.section_id);
        debug!(
            station_ref = ?station_ref,
            connected_section_count = connected_sections.len(),
            connected_sections = ?connected_sections,
            purpose = "reposition connected sections",
            "Computed connected sections for zero datum"
        );

        // Compute current raw coordinates of the datum station
        let current_coords = self
            .compute_station_raw_coords(station_ref)
            .ok_or_else(|| "Failed to compute station coordinates".to_string())?;
        debug!(
            station_ref = ?station_ref,
            coords = ?current_coords,
            purpose = "reposition connected sections",
            "Computed raw station coordinates for zero datum"
        );

        // Determine target position based on whether this is the first datum
        // Special case: if updating the first datum station itself, keep it at origin
        let target_x: f64;
        let target_y: f64;

        let is_first_datum_station = self
            .zero_datums
            .first()
            .is_some_and(|d| d.station_ref == datum_key);

        if is_first_datum_station {
            // Updating the first datum: keep at origin (0, 0)
            target_x = 0.0;
            target_y = 0.0;
            debug!(
                station_ref = ?station_ref,
                purpose = "anchor survey to GPS",
                "Updating first datum; keeping at origin"
            );
        } else if let Some(first_datum) = self.zero_datums.first() {
            // Subsequent datum: compute GPS offset from first datum
            let (east, north) = gps_to_local(&gps, &first_datum.gps);
            target_x = east;
            target_y = north;
            debug!(
                station_ref = ?station_ref,
                offset_x = east,
                offset_y = north,
                purpose = "anchor survey to GPS",
                "Computed GPS offset from first datum"
            );
        } else {
            // First datum: position at origin (0, 0)
            target_x = 0.0;
            target_y = 0.0;
            debug!(
                station_ref = ?station_ref,
                purpose = "anchor survey to GPS",
                "First datum; positioning at origin"
            );
        }

        // Compute the offset needed to move station from current position to target
        let offset_delta_x = target_x - current_coords.x;
        let offset_delta_y = target_y - current_coords.y;
        debug!(
            station_ref = ?station_ref,
            offset_delta_x,
            offset_delta_y,
            purpose = "reposition connected sections",
            "Computed offset delta for zero datum"
        );

        // Apply offset to all connected sections (rigid group)
        self.adjust_rigid_group_offsets(station_ref.section_id, offset_delta_x, offset_delta_y);

        // Cascade through aligned closures that may have been affected
        self.cascade_connection_offsets(&[station_ref.section_id]);
        self.debug_assert_merge_alignment("set_zero_datum");

        // Store the GPS datum
        // Update in-place if datum exists (preserves order/position for stable center)
        let mut updated_existing = false;
        if let Some(existing) = self
            .zero_datums
            .iter_mut()
            .find(|zd| zd.station_ref == datum_key)
        {
            existing.gps = gps;
            updated_existing = true;
        } else {
            self.zero_datums.push(ZeroDatum { station_ref: datum_key, gps });
        }

        self.touch();
        info!(
            station_ref = ?station_ref,
            updated_existing,
            connected_section_count = connected_sections.len(),
            total_zero_datums = self.zero_datums.len(),
            purpose = "anchor survey to GPS",
            "Zero datum set successfully"
        );
        Ok(true)
    }

    /// Store a zero datum without triggering section repositioning.
    ///
    /// This is an internal helper for use by `merge_projects` and import paths
    /// that need to copy datums from source projects without recomputing offsets.
    /// The source project's section_offsets are assumed to already be correct.
    ///
    /// Returns Err if validation fails (same rules as `set_zero_datum`).
    pub fn store_zero_datum_without_repositioning(
        &mut self,
        station_ref: StationRef,
        gps: GpsCoordinates,
    ) -> Result<bool, String> {
        if !self.station_exists(station_ref) {
            return Err("Station does not exist".to_string());
        }

        // Validate GPS coordinates
        GpsCoordinates::validate(gps.latitude, gps.longitude, gps.depth_reference)?;

        // Stable stored identity for this datum's station.
        let datum_key = self
            .key_for_ref(station_ref)
            .ok_or_else(|| "Cannot store zero datum: station has no stable anchor".to_string())?;

        // Check for connected zero datum (same validation as set_zero_datum)
        if let Some(existing) = self.find_connected_zero_datum(station_ref) {
            let new_station = self.format_station_ref_for_display(station_ref);
            let existing_station = self.format_station_ref_for_display(existing);
            return Err(format!(
                "Cannot store zero datum: {new_station} is connected to {existing_station} which already has a zero datum"
            ));
        }

        debug!(
            station_ref = ?station_ref,
            gps_lat = gps.latitude,
            gps_lng = gps.longitude,
            purpose = "store zero datum without repositioning",
            "Storing zero datum without repositioning"
        );

        // Store the GPS datum without computing or applying offsets
        let mut updated_existing = false;
        if let Some(existing) = self
            .zero_datums
            .iter_mut()
            .find(|zd| zd.station_ref == datum_key)
        {
            existing.gps = gps;
            updated_existing = true;
        } else {
            self.zero_datums.push(ZeroDatum { station_ref: datum_key, gps });
        }

        self.touch();
        debug!(
            station_ref = ?station_ref,
            updated_existing,
            total_zero_datums = self.zero_datums.len(),
            purpose = "store zero datum without repositioning",
            "Zero datum stored without repositioning"
        );
        Ok(true)
    }

    /// Remove zero datum from a station
    pub fn remove_zero_datum(&mut self, station_ref: StationRef) -> bool {
        let len_before = self.zero_datums.len();
        let target_key = self.key_for_ref(station_ref);
        self.zero_datums
            .retain(|zd| Some(&zd.station_ref) != target_key.as_ref());
        if self.zero_datums.len() == len_before {
            debug!(
                station_ref = ?station_ref,
                purpose = "remove zero datum",
                "Zero datum not found for removal"
            );
            false
        } else {
            self.touch();
            info!(
                station_ref = ?station_ref,
                remaining_zero_datums = self.zero_datums.len(),
                purpose = "remove zero datum",
                "Zero datum removed"
            );
            true
        }
    }

    /// Get the primary zero datum (first one, or None)
    pub fn primary_zero_datum(&self) -> Option<&ZeroDatum> {
        self.zero_datums.first()
    }

    /// After a geometry-changing shot edit in `edited_section_id`, realign the
    /// merge group's section offsets so that anchored stations (zero datums,
    /// merge points to pinned sections) remain at their correct positions.
    ///
    /// Stations upstream of the edit absorb the length change; stations downstream
    /// (including merge points and closure endpoints) remain stationary.
    ///
    /// Algorithm:
    /// 1. Find the zero datum anchoring this merge group (if any)
    /// 2. Reanchor the datum section (adjust offset to keep datum at GPS target)
    /// 3. BFS through merges: adjust each partner section's offset so merge
    ///    points stay aligned
    ///
    /// Idempotent: calling multiple times produces the same result.
    pub(crate) fn realign_after_shot_edit(&mut self, edited_section_id: SectionId) {
        // Find the merge group containing the edited section
        let merge_group = self.get_merged_section_ids(edited_section_id);

        // Find the zero datum for this merge group (if any)
        let datum = self
            .zero_datums
            .iter()
            .find(|d| merge_group.contains(&d.station_ref.section_id))
            .cloned();

        let datum = match datum {
            Some(d) => d,
            None => return, // No anchor in this group, nothing to realign
        };

        // Determine the datum's target position
        let is_first = self
            .zero_datums
            .first()
            .map(|d| d.station_ref == datum.station_ref)
            .unwrap_or(false);

        let (target_x, target_y) = if is_first {
            (0.0, 0.0)
        } else if let Some(first) = self.zero_datums.first() {
            gps_to_local(&datum.gps, &first.gps)
        } else {
            return;
        };

        // Step 1: Reanchor the datum section's offset to keep datum at target
        let datum_section_id = datum.station_ref.section_id;
        if let Some(current) = self
            .resolve_key(&datum.station_ref)
            .and_then(|sr| self.compute_station_raw_coords(sr))
        {
            let delta_x = target_x - current.x;
            let delta_y = target_y - current.y;
            if delta_x.abs() > 1e-12 || delta_y.abs() > 1e-12 {
                self.adjust_section_offset(datum_section_id, delta_x, delta_y);
            }
        }

        // Step 2: BFS through merges from the datum section, adjusting each
        // partner section's offset so its merge station matches the already-
        // aligned station on the other side.
        let merges = self.station_merges.clone();
        let mut visited = HashSet::new();
        visited.insert(datum_section_id);
        let mut queue = VecDeque::new();
        queue.push_back(datum_section_id);

        while let Some(current_section) = queue.pop_front() {
            for merge in &merges {
                let (this_station, partner_station) =
                    if merge.station_a.section_id == current_section
                        && !visited.contains(&merge.station_b.section_id)
                    {
                        (&merge.station_a, &merge.station_b)
                    } else if merge.station_b.section_id == current_section
                        && !visited.contains(&merge.station_a.section_id)
                    {
                        (&merge.station_b, &merge.station_a)
                    } else {
                        continue;
                    };

                let partner_section = partner_station.section_id;
                visited.insert(partner_section);

                // this_station's section is already aligned; partner needs adjustment
                if let (Some(this_pos), Some(partner_pos)) = (
                    self.resolve_key(this_station).and_then(|sr| self.compute_station_raw_coords(sr)),
                    self.resolve_key(partner_station).and_then(|sr| self.compute_station_raw_coords(sr)),
                ) {
                    let delta_x = this_pos.x - partner_pos.x;
                    let delta_y = this_pos.y - partner_pos.y;
                    if delta_x.abs() > 1e-12 || delta_y.abs() > 1e-12 {
                        self.adjust_section_offset(partner_section, delta_x, delta_y);
                    }
                }

                queue.push_back(partner_section);
            }
        }
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
        let total_stations: u32 = self.sections
            .iter()
            .map(|s| s.shots.len() as u32 + 1)
            .sum();

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
            let (offset_x, offset_y) = self.section_offsets.get(&section.id).copied().unwrap_or((0.0, 0.0));
            let mut current_xy = (offset_x, offset_y);

            // First station of section
            let first_station_ref = StationRef::new(section.id, 0);
            let z = station_depths.get(&first_station_ref).copied().unwrap_or(0.0);
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
                .get(&a_ref).map_or_else(|| vec![a_ref], |&gid| groups[gid].clone());
            let b_group: Vec<StationRef> = station_to_group
                .get(&b_ref).map_or_else(|| vec![b_ref], |&gid| groups[gid].clone());

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
            let mut direct_closures: HashMap<StationRef, Vec<(u64, StationRef)>> =
                HashMap::new();
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

    /// Calculate project statistics
    pub fn stats(&self) -> ProjectStats {
        let mut shot_count = 0;
        let mut total_length = 0.0;
        let mut min_depth = f64::MAX;
        let mut max_depth = f64::MIN;

        for section in &self.sections {
            let section_stats = section.stats();
            shot_count += section_stats.shot_count;
            total_length += section_stats.total_length;
            min_depth = min_depth.min(section_stats.min_depth);
            max_depth = max_depth.max(section_stats.max_depth);
        }

        if self.sections.is_empty() {
            min_depth = 0.0;
            max_depth = 0.0;
        }

        // Station count = shots + 1 per section (first station)
        let station_count = shot_count + self.sections.len();

        // Loop count = number of detected loop closures
        let loop_count = self.loop_closures.len();

        ProjectStats {
            section_count: self.sections.len(),
            shot_count,
            total_length,
            min_depth,
            max_depth,
            station_count,
            loop_count,
            penetration_distance: 0.0, // Calculated separately with stations
        }
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
                if let (Some(&fi), Some(&ti)) =
                    (station_index.get(&from), station_index.get(&to))
                {
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
                if let (Some(&a), Some(&b)) =
                    (station_index.get(&a_sr), station_index.get(&b_sr))
                {
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
                if let (Some(&a), Some(&b)) =
                    (station_index.get(&a_sr), station_index.get(&b_sr))
                {
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
                    shot: PathShot { section_id: ep.section_id, shot_id },
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
                Resolved::Shot { t: ta, len, shot: sa, .. },
                Resolved::Shot { t: tb, shot: sb, .. },
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
                    let ps = PathShot { section_id: section.id, shot_id: shot.id };
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
                Resolved::Shot { from, to, t, len, shot } => {
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

        AlongLineResult { along_line: Some(dist[goal]), path_shots, path_stations }
    }

    /// Get metadata for this project
    pub fn metadata(&self) -> Option<ProjectMetadata> {
        let file_path = self.file_path.clone()?;
        let stats = self.stats();

        // Compute GPS center and bounds from zero datums
        let (gps_center, gps_bounds) = self.compute_gps_info();

        Some(ProjectMetadata {
            name: self.name.clone(),
            location: self.location.clone(),
            file_path,
            modified_at: self.modified_at,
            section_count: stats.section_count,
            total_length: stats.total_length,
            station_count: stats.station_count,
            gps_center,
            gps_bounds,
            collab_enabled: self.collab.as_ref().is_some_and(|c| c.enabled),
        })
    }

    /// Compute GPS center and bounds from zero datums
    /// Returns (center, bounds) where center is from first valid zero datum
    /// and bounds encompass all valid zero datums.
    /// Returns (None, None) if no valid datums exist.
    fn compute_gps_info(&self) -> (Option<(f64, f64)>, Option<GpsBounds>) {
        // Filter to valid datums only to prevent serialization issues
        let valid_datums: Vec<_> = self
            .zero_datums
            .iter()
            .filter(|zd| zd.gps.is_valid())
            .collect();

        if valid_datums.is_empty() {
            return (None, None);
        }

        // Center from first valid zero datum (lng, lat order for MapLibre)
        let first_gps = &valid_datums[0].gps;
        let gps_center = Some((first_gps.longitude, first_gps.latitude));

        // Bounds from all valid zero datums with dateline-aware longitude handling
        let mut south = f64::INFINITY;
        let mut north = f64::NEG_INFINITY;

        // Collect all longitudes for dateline-aware calculation
        let mut longitudes: Vec<f64> = Vec::with_capacity(valid_datums.len());

        for zd in &valid_datums {
            south = south.min(zd.gps.latitude);
            north = north.max(zd.gps.latitude);
            longitudes.push(zd.gps.longitude);
        }

        // Calculate longitude bounds with dateline awareness
        // Sort longitudes and find the largest gap - the bounds are on the opposite side
        let (west, east) = Self::compute_longitude_bounds(&longitudes);

        let gps_bounds = Some(GpsBounds {
            north,
            south,
            east,
            west,
        });

        (gps_center, gps_bounds)
    }

    /// Compute longitude bounds with dateline awareness
    /// Returns (west, east) where east < west indicates crossing the dateline
    pub(crate) fn compute_longitude_bounds(longitudes: &[f64]) -> (f64, f64) {
        if longitudes.is_empty() {
            return (0.0, 0.0);
        }
        if longitudes.len() == 1 {
            return (longitudes[0], longitudes[0]);
        }

        // Sort longitudes
        let mut sorted = longitudes.to_vec();
        sorted.sort_by(|a, b| a.partial_cmp(b).unwrap_or(Ordering::Equal));

        // Find the largest gap between consecutive longitudes (including wrap-around)
        let mut max_gap = 0.0f64;
        let mut max_gap_end_idx = 0;

        for i in 0..sorted.len() {
            let next_idx = (i + 1) % sorted.len();
            let gap = if next_idx == 0 {
                // Wrap-around gap from last to first (crossing -180/180)
                (sorted[0] + 360.0) - sorted[sorted.len() - 1]
            } else {
                sorted[next_idx] - sorted[i]
            };

            if gap > max_gap {
                max_gap = gap;
                max_gap_end_idx = next_idx;
            }
        }

        // The bounds are on the opposite side of the largest gap
        // west is at max_gap_end_idx, east is at (max_gap_end_idx - 1 + len) % len
        let west = sorted[max_gap_end_idx];
        let east_idx = (max_gap_end_idx + sorted.len() - 1) % sorted.len();
        let east = sorted[east_idx];

        (west, east)
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
        let datum_stations: HashSet<StationRef> =
            self.zero_datums.iter().filter_map(|d| self.resolve_key(&d.station_ref)).collect();

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
                let (Some(&ai), Some(&bi)) =
                    (station_to_idx.get(&a), station_to_idx.get(&b))
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
            ExistingSection, OrphanPlacementSuggestion, suggest_placements,
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
                // Skip if component has a datum
                let any_member = *comp.iter().next().unwrap();
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
                name: s.name.clone().unwrap_or_else(|| format!("Section {}", s.id)),
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
        let station_is_constrained = |sr: StationRef| -> bool {
            station_has_merge(sr) || station_has_aligned_closure(sr)
        };

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
        suggestions
            .sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap_or(Ordering::Equal));

        suggestions
    }
}

/// Severity of a structural-integrity violation.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum ViolationSeverity {
    /// A dangling reference that will cause runtime panics or geometry
    /// corruption if used (e.g. a merge pointing at a deleted station).
    Critical,
    /// A stale/orphaned entry that is ignored by lookups but signals an
    /// inconsistent project (e.g. an offset keyed by a deleted section).
    Warning,
}

/// A single structural-integrity violation found by
/// [`Project::check_structural_integrity`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct IntegrityViolation {
    pub severity: ViolationSeverity,
    /// Stable machine-readable category (e.g. `"dangling_merge_ref"`).
    pub category: String,
    /// Human-readable description.
    pub message: String,
}

impl Project {
    /// Reason a stored [`StationKey`] is invalid — it names a section that no
    /// longer exists, or its anchor no longer resolves to a real station (its
    /// anchoring shot was deleted) — or `None` if it points at a real station.
    /// With stable identity this catches a *dangling* anchor (the integrity win
    /// over positional refs, which could only ever be out-of-range, never
    /// silently mispointed at the wrong in-range station).
    fn station_ref_violation(&self, key: &StationKey) -> Option<String> {
        match self.get_section(key.section_id) {
            None => Some(format!("references missing section {}", key.section_id)),
            Some(_) => {
                if self.resolve_key(key).is_some() {
                    None
                } else {
                    Some(format!(
                        "anchor no longer resolves in section {} (its anchoring shot was deleted)",
                        key.section_id
                    ))
                }
            }
        }
    }

    /// Audit every cross-reference in the project and return all structural
    /// violations (an empty vec means the project is structurally sound). This
    /// does not mutate the project and does not look at shot geometry — it only
    /// checks that merges, loop closures, zero datums, and the offset/comment
    /// maps point at stations and sections that actually exist.
    ///
    /// Used to (a) block commands that would introduce corruption and (b) warn
    /// about — and repair — corruption already present in a loaded project.
    pub fn check_structural_integrity(&self) -> Vec<IntegrityViolation> {
        let mut violations = Vec::new();

        // Non-finite (NaN/inf) shot geometry — loaded from an older/corrupt file
        // or an unguarded import. It silently poisons coordinates (NaN passes the
        // tolerance comparisons in the alignment checks), so surface it.
        for section in &self.sections {
            if let Some(pos) = section.shots.iter().position(|s| !s.all_finite()) {
                violations.push(IntegrityViolation {
                    severity: ViolationSeverity::Critical,
                    category: "non_finite_geometry".to_string(),
                    message: format!(
                        "Section {} has a shot with a non-finite (NaN/inf) value (at index {pos})",
                        section.id
                    ),
                });
            }
        }

        // Two shots in one section sharing a UUID make AfterShot anchors
        // mis-resolve: resolve_key takes the FIRST match via position(), so a
        // merge/closure/datum pointing at the second station silently snaps to
        // the first — geometrically wrong with no other signal. Critical, and
        // section-scoped because resolve_key is section-local. Empty UUIDs are
        // "no identity yet" (ensure_shot_uuids fills them) so they don't count.
        for section in &self.sections {
            let mut seen: HashSet<&str> = HashSet::new();
            for shot in &section.shots {
                if let Some(u) = shot.uuid.as_deref() {
                    if !u.is_empty() && !seen.insert(u) {
                        violations.push(IntegrityViolation {
                            severity: ViolationSeverity::Critical,
                            category: "duplicate_shot_uuid".to_string(),
                            message: format!(
                                "Section {} has two shots sharing UUID {u}",
                                section.id
                            ),
                        });
                    }
                }
            }
        }

        // Validate every StationRef-bearing collection through the single
        // traversal, so a newly-added ref-bearing collection is checked by
        // construction. Dangling merge/closure/datum refs are Critical (they
        // corrupt connectivity); orphaned offset/comment keys are Warning (they
        // are inert until their station is recreated).
        self.for_each_station_ref(|label, key| {
            let Some(reason) = self.station_ref_violation(&key) else {
                return;
            };
            let (severity, category) = match label {
                "merge" => (ViolationSeverity::Critical, "dangling_merge_ref"),
                "loop closure" => (ViolationSeverity::Critical, "dangling_closure_ref"),
                "zero datum" => (ViolationSeverity::Critical, "dangling_zero_datum_ref"),
                "station offset" => (ViolationSeverity::Warning, "orphan_station_offset"),
                _ => (ViolationSeverity::Warning, "orphan_station_comment"),
            };
            let mut subject = label.to_string();
            if let Some(first) = subject.get_mut(0..1) {
                first.make_ascii_uppercase();
            }
            violations.push(IntegrityViolation {
                severity,
                category: category.to_string(),
                message: format!("{subject} {reason}"),
            });
        });

        // section_offsets is keyed by SectionId (not a StationRef), so it isn't
        // covered by for_each_station_ref — check it for a missing section here.
        for section_id in self.section_offsets.keys() {
            if self.get_section(*section_id).is_none() {
                violations.push(IntegrityViolation {
                    severity: ViolationSeverity::Warning,
                    category: "orphan_section_offset".to_string(),
                    message: format!("Section offset for missing section {section_id}"),
                });
            }
        }

        // Two or more zero datums in one merge-connected component over-constrain
        // the rigid group (two GPS anchors), so the offset cascade tears a merge
        // edge apart. The interactive guards (set_zero_datum / merge_stations)
        // prevent this on clean state, but a file written by an older build or a
        // closure-to-merge conversion can still arrive in this state — surface it
        // instead of silently mis-solving the geometry. Warning, not Critical: the
        // project still opens and the user resolves it by removing a datum.
        for component in self.over_anchored_merge_components() {
            let datums = component
                .iter()
                .map(|sr| format!("{}:{}", sr.section_id, sr.station_index))
                .collect::<Vec<_>>()
                .join(", ");
            violations.push(IntegrityViolation {
                severity: ViolationSeverity::Warning,
                category: "multiple_datums_per_merge_component".to_string(),
                message: format!(
                    "Merge-connected group has {} zero datums ({datums}); remove all but one to keep the group's geometry consistent",
                    component.len()
                ),
            });
        }

        violations
    }

    /// True if the project has any [`ViolationSeverity::Critical`] violation —
    /// the cheap gate used to block corrupting commands.
    pub fn has_critical_integrity_violations(&self) -> bool {
        self.check_structural_integrity()
            .iter()
            .any(|v| v.severity == ViolationSeverity::Critical)
    }

    /// True if ANY persisted cross-reference (a merge/closure/datum endpoint, or
    /// an offset/comment key) no longer resolves — its anchoring shot was deleted
    /// or its section is gone. These are precisely the keys that would otherwise
    /// be collapsed to a phantom `(section, 0)` ref on save and can collide on the
    /// `(section_id, station_index)` PRIMARY KEY. The save path blocks on this so
    /// corruption is never persisted; `repair_structural_integrity` drops exactly
    /// these keys, so repair unblocks the save. Includes Warning-severity orphan
    /// offsets/comments (they cause the same PK collision), so this is broader
    /// than [`has_critical_integrity_violations`].
    pub fn has_unresolvable_cross_references(&self) -> bool {
        let mut dangling = false;
        self.for_each_station_ref(|_label, key| {
            if self.station_ref_violation(&key).is_some() {
                dangling = true;
            }
        });
        dangling
    }

    /// Drop every structurally-invalid cross-reference (dangling merges, loop
    /// closures, zero datums) and orphaned offset/comment entries, returning the
    /// violations that were repaired (empty = nothing to do). Valid data is left
    /// untouched. Used by the load-time "warn and offer repair" path.
    pub fn repair_structural_integrity(&mut self) -> Vec<IntegrityViolation> {
        let violations = self.check_structural_integrity();
        if violations.is_empty() {
            return violations;
        }

        // Re-mint duplicate shot UUIDs first (keeping the first occurrence), so
        // the per-section UUID snapshot below reflects the de-duplicated set and
        // AfterShot anchors that pointed at the kept shot stay valid.
        self.ensure_unique_shot_uuids();

        // Snapshot, per section, the station count and the set of shot UUIDs, so
        // the retain closures can validate a stored `StationKey` without
        // borrowing `self` while mutating its fields. Owns the UUID strings so no
        // borrow of `self.sections` outlives into the mutating retains.
        let sect_info: HashMap<SectionId, (u32, HashSet<String>)> = self
            .sections
            .iter()
            .map(|s| {
                let uuids = s.shots.iter().filter_map(|sh| sh.uuid.clone()).collect();
                (s.id, (s.shots.len() as u32, uuids))
            })
            .collect();
        let key_valid = |key: &StationKey| -> bool {
            match sect_info.get(&key.section_id) {
                None => false,
                Some((count, uuids)) => match &key.anchor {
                    StationAnchor::SectionStart => true,
                    StationAnchor::AfterShot(u) => uuids.contains(u),
                    StationAnchor::Index(i) => *i <= *count,
                },
            }
        };

        self.station_merges
            .retain(|m| key_valid(&m.station_a) && key_valid(&m.station_b));
        self.loop_closures
            .retain(|c| key_valid(&c.station_a) && key_valid(&c.station_b));
        self.zero_datums.retain(|z| key_valid(&z.station_ref));
        self.section_offsets
            .retain(|section_id, _| sect_info.contains_key(section_id));
        self.station_offsets.retain(|key, _| key_valid(key));
        self.station_comments.retain(|key, _| key_valid(key));

        // Merges may have been dropped; the adjacency cache is now stale.
        self.merge_adjacency_cache.clear();
        self.touch();

        violations
    }

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
        self.resolve_key(key).unwrap_or_else(|| StationRef::new(key.section_id, 0))
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
        let (ox, oy) = self.section_offsets.get(&sr.section_id).copied().unwrap_or((0.0, 0.0));
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

    /// Cross-section merges whose two stations have drifted apart — the
    /// references are valid but the geometry is wrong (a stale section offset
    /// from a missed cascade). Distinct from [`Self::check_structural_integrity`];
    /// repaired by re-cascading offsets via [`Self::realign_merges`] rather than
    /// by dropping data.
    pub fn check_merge_alignment(&self) -> Vec<IntegrityViolation> {
        let local = self.section_local_coords();
        let station_offsets = self.resolved_station_offsets();
        let mut violations = Vec::new();
        for merge in &self.station_merges {
            // Same-section merges are physically meaningless (test-only).
            if merge.station_a.section_id == merge.station_b.section_id {
                continue;
            }
            let (Some(a), Some(b)) = (
                self.resolve_key(&merge.station_a),
                self.resolve_key(&merge.station_b),
            ) else {
                continue;
            };
            if let (Some((ax, ay)), Some((bx, by))) = (
                self.station_world_xy(a, &local, &station_offsets),
                self.station_world_xy(b, &local, &station_offsets),
            ) {
                let dist = ((ax - bx).powi(2) + (ay - by).powi(2)).sqrt();
                if dist >= Self::MERGE_ALIGNMENT_TOLERANCE_M {
                    violations.push(IntegrityViolation {
                        severity: ViolationSeverity::Critical,
                        category: "merge_misaligned".to_string(),
                        message: format!(
                            "Merged stations {}:{} and {}:{} are {:.2} m apart but should be the same point",
                            a.section_id,
                            a.station_index,
                            b.section_id,
                            b.station_index,
                            dist
                        ),
                    });
                }
            }
        }
        violations
    }

    /// Cross-section *aligned* loop closures whose two stations have drifted
    /// apart. An aligned closure (`is_aligned == true`) asserts its loop is
    /// closed — its endpoints coincide — and the offset solver enforces it as a
    /// rigid edge. But `is_aligned` is never set back to false, so a later shot
    /// edit can leave the closure stale while still marked aligned. The
    /// merge-only [`Self::check_merge_alignment`] cannot see this; surface it so
    /// the user can recompute or remove the loop closure (forcing a loop
    /// misclosure to zero is over-constrained, so this is detect-and-report, not
    /// auto-heal).
    pub fn check_closure_alignment(&self) -> Vec<IntegrityViolation> {
        let local = self.section_local_coords();
        let station_offsets = self.resolved_station_offsets();
        let mut violations = Vec::new();
        for closure in &self.loop_closures {
            if !closure.is_aligned || closure.station_a.section_id == closure.station_b.section_id {
                continue;
            }
            let (Some(a), Some(b)) = (
                self.resolve_key(&closure.station_a),
                self.resolve_key(&closure.station_b),
            ) else {
                continue;
            };
            if let (Some((ax, ay)), Some((bx, by))) = (
                self.station_world_xy(a, &local, &station_offsets),
                self.station_world_xy(b, &local, &station_offsets),
            ) {
                let dist = ((ax - bx).powi(2) + (ay - by).powi(2)).sqrt();
                if dist >= Self::MERGE_ALIGNMENT_TOLERANCE_M {
                    violations.push(IntegrityViolation {
                        severity: ViolationSeverity::Critical,
                        category: "closure_misaligned".to_string(),
                        message: format!(
                            "Loop closure {} ({}:{} ↔ {}:{}) is marked closed but its ends are {:.2} m apart — recompute or remove it",
                            closure.id,
                            a.section_id,
                            a.station_index,
                            b.section_id,
                            b.station_index,
                            dist
                        ),
                    });
                }
            }
        }
        violations
    }

    /// Closures that are not true loops: their two endpoints are connected ONLY
    /// through the closure itself (a sole bridge), which is a merge, not a loop.
    /// [`Self::convert_orphan_closures_to_merges`] normally fixes these the
    /// moment they appear (on delete/split and on load), so this is a safety-net
    /// detector for any path that bypassed that (e.g. a collaborator's reconciled
    /// edit) — it lets the integrity banner surface the condition.
    pub fn check_orphan_closures(&self) -> Vec<IntegrityViolation> {
        let mut violations = Vec::new();
        for closure in &self.loop_closures {
            if closure.station_a.section_id == closure.station_b.section_id {
                continue;
            }
            let (Some(a), Some(b)) = (
                self.resolve_key(&closure.station_a),
                self.resolve_key(&closure.station_b),
            ) else {
                continue;
            };
            if !self.are_stations_connected_excluding_shot(a, b, None, false) {
                // A sole-bridge closure between two independently zero-datum-anchored
                // groups is intentionally KEPT as a closure (converting it to a rigid
                // merge would double-anchor one merge component and tear it — see
                // `convert_orphan_closures_to_merges`). Don't flag it as an
                // orphan-that-should-be-a-merge: that warning would be misleading and
                // Repair could never clear it, since the converter correctly refuses
                // to merge it. The same `merge_would_double_anchor` predicate keeps the
                // checker and the converter in agreement.
                if self.merge_would_double_anchor(a.section_id, b.section_id) {
                    continue;
                }
                violations.push(IntegrityViolation {
                    severity: ViolationSeverity::Warning,
                    category: "orphan_closure".to_string(),
                    message: format!(
                        "Loop closure {} ({}:{} ↔ {}:{}) is the only connection between its sections — it should be a merge, not a loop",
                        closure.id,
                        a.section_id,
                        a.station_index,
                        b.section_id,
                        b.station_index
                    ),
                });
            }
        }
        violations
    }

    /// One authoritative anchor section per connected merge group, preferring a
    /// zero-datum section so the realign keeps the group pinned to GPS.
    fn realign_seeds(&self) -> Vec<SectionId> {
        let datum_sections: HashSet<SectionId> =
            self.zero_datums.iter().map(|z| z.station_ref.section_id).collect();
        let mut seeds = Vec::new();
        let mut visited: HashSet<SectionId> = HashSet::new();
        for section in &self.sections {
            if visited.contains(&section.id) {
                continue;
            }
            let component = self.get_connected_section_ids(section.id);
            let anchor = component
                .iter()
                .copied()
                .filter(|s| datum_sections.contains(s))
                .min()
                .or_else(|| component.iter().copied().min());
            if let Some(a) = anchor {
                seeds.push(a);
            }
            visited.extend(component);
        }
        seeds
    }

    /// Re-derive section offsets from the merge/datum constraints right after
    /// loading from disk. Section offsets are **derived** state that the file
    /// merely caches; re-solving them on load heals any drift a previous session
    /// persisted (e.g. an older redo bug) so the project always opens
    /// geometrically correct, without the user having to repair anything. The
    /// transient caches are rebuilt first so the solve walks the merge graph
    /// correctly. Returns the number of merges that had drifted (0 = file was
    /// already consistent, the common case).
    pub fn redrive_offsets_after_load(&mut self) -> usize {
        self.rebuild_section_index();
        self.rebuild_merge_adjacency();
        // Normalize any closure that is really a sole-bridge attachment into a
        // merge before solving, so a file persisted in that state (e.g. a section
        // stranded by an older delete) opens correctly.
        // De-duplicate shot UUIDs BEFORE re-anchoring: if a section persisted two
        // shots sharing a UUID, canonicalizing a positional Index(i) ref to
        // AfterShot(uuid) would later resolve to the FIRST match, silently moving
        // a ref off the duplicate it was meant to target (and Repair couldn't
        // recover the intended endpoint). Re-minting the duplicate first gives the
        // second station its own UUID so the re-anchor stays faithful.
        self.ensure_unique_shot_uuids();
        // Upgrade any positional (Index) ref from an older file to the stable
        // shot-UUID anchor now that shots (with UUIDs) are loaded.
        self.reanchor_station_refs();
        self.convert_orphan_closures_to_merges();
        // Zero-trust: never honor a persisted derivable offset — re-solve
        // unconditionally so a sub-tolerance stale offset can't survive the load.
        self.resolve_offsets()
    }

    /// Enforce the invariant that a loop closure exists only for a TRUE loop. If
    /// a closure's two endpoints are no longer connected through the survey
    /// (shots + merges) independently of the closure, the closure is the *sole*
    /// connection between them — that is a merge, not a loop — so convert it.
    ///
    /// Iterative: when two closures bridge the same pair, the first becomes the
    /// merge and the second is then a genuine (redundant) loop and is kept.
    /// Returns the number converted. (Issue #8 — a shot deletion can strand a
    /// section so its only attachment is a closure.)
    pub fn convert_orphan_closures_to_merges(&mut self) -> usize {
        let mut converted = 0;
        // Sole-bridge closures left UNCONVERTED because turning them into a rigid
        // merge would fuse two independently zero-datum-anchored groups. Tracked by
        // id so the orphan scan below does not reconsider them on every iteration
        // (which would loop forever, since they are never removed).
        let mut left_as_closure: HashSet<u64> = HashSet::new();
        loop {
            let orphan = self.loop_closures.iter().position(|c| {
                if left_as_closure.contains(&c.id) {
                    return false;
                }
                if c.station_a.section_id == c.station_b.section_id {
                    return false;
                }
                let (Some(a), Some(b)) =
                    (self.resolve_key(&c.station_a), self.resolve_key(&c.station_b))
                else {
                    return false;
                };
                !self.are_stations_connected_excluding_shot(a, b, None, false)
            });
            let Some(idx) = orphan else { break };

            // Converting a sole-bridge closure into a merge makes it a RIGID edge.
            // If both endpoints' groups are already zero-datum-anchored, that edge
            // would place two GPS anchors in one merge component, and the next
            // offset cascade would tear the merge apart (the reported failure
            // mode). Keep it a (soft) closure instead — a closure between two
            // anchored groups is legitimate — and let the over-anchoring detector
            // surface it for the user to resolve.
            {
                let closure = &self.loop_closures[idx];
                if self.merge_would_double_anchor(
                    closure.station_a.section_id,
                    closure.station_b.section_id,
                ) {
                    tracing::warn!(
                        closure_id = closure.id,
                        purpose = "avoid double-anchoring a merge component",
                        "Left a sole-bridge loop closure unconverted: both endpoints are zero-datum-anchored"
                    );
                    left_as_closure.insert(closure.id);
                    continue;
                }
            }

            let closure = self.loop_closures.remove(idx);
            let already = match (
                self.resolve_key(&closure.station_a),
                self.resolve_key(&closure.station_b),
            ) {
                (Some(a), Some(b)) => self.has_direct_merge(a, b),
                _ => false,
            };
            if !already {
                self.record_station_merge(StationMerge {
                    station_a: closure.station_a,
                    station_b: closure.station_b,
                    merged_at: Utc::now(),
                });
            }
            converted += 1;
        }
        converted
    }

    /// Recompute section offsets so every merge's endpoints coincide again,
    /// anchoring each connected group at its zero datum (or, failing that, an
    /// arbitrary section). Returns the number of merges that were misaligned
    /// before the realign. A no-op when everything is already aligned (within the
    /// 5 cm reporting tolerance).
    ///
    /// This is the per-command self-heal (via `reconcile_geometry`): it keeps the
    /// fast no-drift early-return because the in-memory offsets it sees were just
    /// computed by the command/cascade, not read from an untrusted source, and an
    /// unconditional re-solve after every command would override the exact state
    /// an undo/redo snapshot just restored. The *load*/repair paths use
    /// [`Self::resolve_offsets`] instead, which never trusts a persisted value.
    pub fn realign_merges(&mut self) -> usize {
        let before = self.check_merge_alignment().len();
        if before == 0 {
            return 0;
        }
        self.resolve_offsets()
    }

    /// Zero-trust re-solve of section offsets, used on LOAD and explicit REPAIR.
    /// Unlike [`Self::realign_merges`] it ALWAYS re-runs the cascade, even when no
    /// merge is drifted past the 5 cm reporting tolerance: section offsets are
    /// derived state, so a *sub-tolerance* stale/wrong cached offset (which
    /// `check_merge_alignment` can't see) must never be trusted across a reload.
    /// The cascade re-derives every offset reachable from an anchor; only the
    /// genuinely non-derivable anchors (datum sections and free-placed floating
    /// components) keep their stored offset, because the cascade never
    /// seed-adjusts them. Returns the number of merges that were misaligned beyond
    /// the reporting tolerance before the re-solve.
    pub fn resolve_offsets(&mut self) -> usize {
        let before = self.check_merge_alignment().len();
        // Snapshot the derived offsets so we can tell whether the re-solve actually
        // moved anything — including SUB-tolerance changes the `before`/`after`
        // misalignment count can't see (that is the whole reason this re-cascades
        // unconditionally). Comparing the count alone would miss them.
        let offsets_before = self.section_offsets.clone();
        let seeds = self.realign_seeds();
        let was_deferred = self.cascade_deferred;
        self.cascade_deferred = false;
        self.cascade_connection_offsets(&seeds);
        self.cascade_deferred = was_deferred;
        // Only stamp a modification when the re-solve genuinely changed an offset.
        // Opening a byte-clean project re-solves to the identical offsets, and
        // touch()ing there would bump `modified_at` for a project the user never
        // edited — a later no-edit save would then persist a bogus timestamp, and
        // it would make a no-op integrity Repair look like a real change.
        if self.section_offsets != offsets_before {
            self.touch();
        }
        before.saturating_sub(self.check_merge_alignment().len())
    }
}

#[cfg(test)]
#[expect(clippy::unwrap_used, clippy::expect_used, clippy::float_cmp)]
mod tests;
