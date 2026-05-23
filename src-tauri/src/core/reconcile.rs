//! Collaboration reconcile engine.
//!
//! One-directional diff: given the baseline Stalagmight last exported (stored in
//! `project.collab`) and a returned Ariane `.tml` (parsed into `TmlFile`), compute
//! the set of changes the collaborator made — added / edited / removed shots and
//! section-metadata changes — so they can be previewed and applied to the `.stalx`
//! while preserving Stalagmight-only data (closures, merges, offsets, etc.).
//!
//! Matching is tiered (per the external edit-lock there are no conflicting edits):
//!   1. UUID            — exact, authoritative (Ariane 26+)
//!   2. Ariane integer ID — guarded: skipped if the file was wholesale-renumbered
//!   3. geometry fingerprint (LCS) — primary for UUID-less files (Ariane ≤25)
//!   4. positional      — last resort within a matched section
//!
//! The geometry fingerprint is the real backbone: real Ariane files renumber
//! integer IDs across edits, so IDs are only a hint.

use std::collections::{HashMap, HashSet};

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::models::{
    geo_key, DeleteShotImpact, Project, SectionId, ShotData, ShotId,
};
use crate::parsers::tml::{normalize_tml_shot, resolve_tml_depth_in, TmlFile, TmlSection, TmlShotType};

/// How shots were matched across the round-trip (worst tier used, for warning).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub enum MatchQuality {
    /// Nothing to match (no changes) or all matched by UUID.
    Uuid,
    /// Some matches relied on Ariane integer IDs.
    ArianeId,
    /// Some matches relied on the geometry fingerprint.
    Fingerprint,
    /// Some matches were positional only — review carefully.
    Positional,
}

/// A single representable field that differs between the Stalagmight shot/section
/// and the returned TML one.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct CollabFieldChange {
    pub field: String,
    pub old: String,
    pub new: String,
}

/// A shot present in the returned file but absent from the baseline.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct AddedShot {
    /// Target section if it already exists; `None` if part of a new section.
    pub section_id: Option<SectionId>,
    pub section_name: String,
    /// Index of this shot within the returned (Ariane) section — its document
    /// order, used to apply inserts in sequence. Not a live project index.
    pub position: u32,
    /// Id of the existing shot to insert after (the nearest preceding *matched*
    /// shot in returned order). `None` means insert at the front of the section.
    /// Anchoring on a stable shot id keeps the insert correct regardless of the
    /// edit/remove phases that run first at apply time.
    pub after_shot_id: Option<ShotId>,
    pub data: ShotData,
}

/// A shot matched to the baseline whose representable fields changed.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct EditedShot {
    pub section_id: SectionId,
    pub shot_index: u32,
    pub section_name: String,
    pub changes: Vec<CollabFieldChange>,
    /// New (normalized) shot data to apply; Stalagmight-only fields are merged
    /// from the existing shot at apply time, not taken from here.
    pub new_data: ShotData,
}

/// A baseline shot with no match in the returned file (deleted in Ariane).
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct RemovedShot {
    pub section_id: SectionId,
    pub shot_index: u32,
    pub section_name: String,
    /// What deleting this shot would affect (merges/closures/offsets).
    pub impact: DeleteShotImpact,
}

/// A whole section present in the returned file but not the baseline.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct AddedSection {
    pub name: String,
    pub color: String,
    pub surveyor: Option<String>,
    #[ts(type = "string | null")]
    pub date: Option<chrono::NaiveDate>,
    pub shots: Vec<ShotData>,
}

/// A section matched by name whose metadata (name/color/surveyor/date) changed.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct SectionMetaChange {
    pub section_id: SectionId,
    pub section_name: String,
    pub changes: Vec<CollabFieldChange>,
}

/// A non-fatal note surfaced in the preview (e.g. a removal underpins a closure).
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct CollabWarning {
    pub message: String,
}

/// The full set of changes detected in a returned collaborator file.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct CollabChangeSet {
    pub shots_added: Vec<AddedShot>,
    pub shots_edited: Vec<EditedShot>,
    pub shots_removed: Vec<RemovedShot>,
    pub sections_added: Vec<AddedSection>,
    pub section_meta_changed: Vec<SectionMetaChange>,
    pub warnings: Vec<CollabWarning>,
    pub match_quality: MatchQuality,
}

impl CollabChangeSet {
    pub(crate) fn empty() -> Self {
        Self {
            shots_added: Vec::new(),
            shots_edited: Vec::new(),
            shots_removed: Vec::new(),
            sections_added: Vec::new(),
            section_meta_changed: Vec::new(),
            warnings: Vec::new(),
            match_quality: MatchQuality::Uuid,
        }
    }

    /// True when there is nothing to apply.
    pub fn is_empty(&self) -> bool {
        self.shots_added.is_empty()
            && self.shots_edited.is_empty()
            && self.shots_removed.is_empty()
            && self.sections_added.is_empty()
            && self.section_meta_changed.is_empty()
    }

    /// Total number of concrete changes (for summaries).
    pub fn total_changes(&self) -> usize {
        self.shots_added.len()
            + self.shots_edited.len()
            + self.shots_removed.len()
            + self.sections_added.len()
            + self.section_meta_changed.len()
    }
}

// ============================================================================
// Internal representation of a returned (collaborator) shot
// ============================================================================

struct ReturnedShot {
    uuid: Option<String>,
    ariane_id: i64,
    geo_key: String,
    data: ShotData,
}

/// Build the normalized real shots of a returned TML section, in order.
fn returned_section_shots(section: &TmlSection) -> Vec<ReturnedShot> {
    let real: Vec<&_> = section
        .shots
        .iter()
        .filter(|s| {
            s.shot_type != TmlShotType::Closure
                && s.shot_type != TmlShotType::Start
                && !s.excluded
        })
        .collect();

    let mut out = Vec::with_capacity(real.len());
    for (i, shot) in real.iter().enumerate() {
        let prev_depth = if i > 0 { Some(real[i - 1].depth) } else { None };
        let depth_in = resolve_tml_depth_in(shot, prev_depth, section.start_depth);
        let data = normalize_tml_shot(shot, depth_in);
        let gk = geo_key(shot.azimuth, shot.length, depth_in, shot.depth);
        out.push(ReturnedShot {
            uuid: shot.uuid.clone(),
            ariane_id: shot.id,
            geo_key: gk,
            data,
        });
    }
    out
}

// ============================================================================
// Diff
// ============================================================================

const F_EPS: f64 = 1e-3;

/// The placeholder date the TML exporter writes when a section has no date.
fn null_date_sentinel() -> chrono::NaiveDate {
    chrono::NaiveDate::from_ymd_opt(2000, 1, 1).expect("valid sentinel date")
}

/// Compute the changes a returned TML file makes relative to the project's
/// stored collaboration baseline. Returns an empty set if collaboration is not
/// configured or there is no baseline yet.
pub fn diff(project: &Project, tml: &TmlFile) -> CollabChangeSet {
    let Some(collab) = project.collab.as_ref() else {
        return CollabChangeSet::empty();
    };
    if collab.shot_baseline.is_empty() {
        return CollabChangeSet::empty();
    }

    let mut cs = CollabChangeSet::empty();
    let mut quality = MatchQuality::Uuid;

    // Exported section name -> SectionId.
    let name_to_id: HashMap<&str, SectionId> = collab
        .section_name_map
        .iter()
        .map(|(n, id)| (n.as_str(), *id))
        .collect();

    // Synthetic export legs (`<name> (reversed)`, `<name> (pre-zero-datum)`) are
    // reversed duplicates of forward geometry we wrote ourselves — never edits.
    // Skipping them keeps a clean round-trip (zero datum off the root station, or
    // a merged child section) from surfacing phantom new sections.
    let synthetic: HashSet<&str> = collab
        .synthetic_section_names
        .iter()
        .map(String::as_str)
        .collect();

    // Project sections by id.
    let sections_by_id: HashMap<SectionId, &_> =
        project.sections.iter().map(|s| (s.id, s)).collect();

    // Baseline grouped by section id, preserving shot order.
    let mut baseline_by_section: HashMap<SectionId, Vec<&_>> = HashMap::new();
    for e in &collab.shot_baseline {
        baseline_by_section.entry(e.section_id).or_default().push(e);
    }
    for v in baseline_by_section.values_mut() {
        v.sort_by_key(|e| e.shot_index);
    }

    // Decide whether Ariane integer IDs are reliable (not wholesale renumbered).
    let baseline_ids: HashSet<i64> = collab.shot_baseline.iter().map(|e| e.ariane_id).collect();
    let mut returned_id_count = 0usize;
    let mut returned_id_overlap = 0usize;
    for section in &tml.sections {
        for r in returned_section_shots(section) {
            returned_id_count += 1;
            if baseline_ids.contains(&r.ariane_id) {
                returned_id_overlap += 1;
            }
        }
    }
    let ids_reliable =
        !baseline_ids.is_empty() && returned_id_overlap * 2 >= baseline_ids.len();
    let _ = returned_id_count;

    // Track which sections of the baseline got a matching returned section.
    let mut matched_section_ids: HashSet<SectionId> = HashSet::new();

    for section in &tml.sections {
        if synthetic.contains(section.name.as_str()) {
            continue;
        }
        let returned = returned_section_shots(section);

        let Some(&sid) = name_to_id.get(section.name.as_str()) else {
            // New section — every shot is added.
            cs.sections_added.push(AddedSection {
                name: section.name.clone(),
                color: section.color.clone(),
                surveyor: section.surveyor.clone(),
                date: section.date,
                shots: returned.into_iter().map(|r| r.data).collect(),
            });
            continue;
        };
        matched_section_ids.insert(sid);

        let empty_b: Vec<&crate::models::ShotBaselineEntry> = Vec::new();
        let baseline = baseline_by_section.get(&sid).unwrap_or(&empty_b);
        let Some(proj_section) = sections_by_id.get(&sid) else {
            continue;
        };

        // Section metadata diff.
        let mut meta = Vec::new();
        if proj_section.color != section.color {
            meta.push(CollabFieldChange {
                field: "color".into(),
                old: proj_section.color.clone(),
                new: section.color.clone(),
            });
        }
        if opt_str(&proj_section.surveyor) != opt_str(&section.surveyor) {
            meta.push(CollabFieldChange {
                field: "surveyor".into(),
                old: opt_str(&proj_section.surveyor),
                new: opt_str(&section.surveyor),
            });
        }
        // Export writes 2000-01-01 for a null date; treat that re-imported
        // sentinel as "unset" so a clean round-trip isn't a phantom change.
        let returned_date = section.date.filter(|d| *d != null_date_sentinel());
        if proj_section.date != returned_date {
            meta.push(CollabFieldChange {
                field: "date".into(),
                old: proj_section.date.map(|d| d.to_string()).unwrap_or_default(),
                new: returned_date.map(|d| d.to_string()).unwrap_or_default(),
            });
        }
        if !meta.is_empty() {
            cs.section_meta_changed.push(SectionMetaChange {
                section_id: sid,
                section_name: section.name.clone(),
                changes: meta,
            });
        }

        // Per-section shot alignment.
        align_section(
            project,
            sid,
            &section.name,
            baseline,
            &returned,
            proj_section,
            ids_reliable,
            &mut cs,
            &mut quality,
        );
    }

    // Baseline sections with no returned section of that name → all shots removed.
    for (sid, entries) in &baseline_by_section {
        if matched_section_ids.contains(sid) {
            continue;
        }
        let Some(proj_section) = sections_by_id.get(sid) else { continue };
        for e in entries {
            push_removed(project, proj_section, *sid, e.shot_index, &e.section_name, &mut cs);
        }
    }

    cs.match_quality = quality;
    cs
}

#[allow(clippy::too_many_arguments)]
fn align_section(
    project: &Project,
    sid: SectionId,
    section_name: &str,
    baseline: &[&crate::models::ShotBaselineEntry],
    returned: &[ReturnedShot],
    proj_section: &crate::models::Section,
    ids_reliable: bool,
    cs: &mut CollabChangeSet,
    quality: &mut MatchQuality,
) {
    let mut b_used = vec![false; baseline.len()];
    let mut r_used = vec![false; returned.len()];
    // (baseline_idx, returned_idx)
    let mut pairs: Vec<(usize, usize)> = Vec::new();
    // Returned-shot indices with no baseline match (inserts), in document order.
    let mut added_returned: Vec<usize> = Vec::new();

    // Tier 1: UUID.
    let mut uuid_to_b: HashMap<&str, usize> = HashMap::new();
    for (bi, b) in baseline.iter().enumerate() {
        if !b.uuid.is_empty() {
            uuid_to_b.entry(b.uuid.as_str()).or_insert(bi);
        }
    }
    for (ri, r) in returned.iter().enumerate() {
        if let Some(u) = &r.uuid {
            if let Some(&bi) = uuid_to_b.get(u.as_str()) {
                if !b_used[bi] && !r_used[ri] {
                    b_used[bi] = true;
                    r_used[ri] = true;
                    pairs.push((bi, ri));
                }
            }
        }
    }

    // Tier 2: Ariane integer ID (only if not wholesale renumbered).
    if ids_reliable {
        let mut id_to_b: HashMap<i64, usize> = HashMap::new();
        for (bi, b) in baseline.iter().enumerate() {
            if !b_used[bi] {
                id_to_b.entry(b.ariane_id).or_insert(bi);
            }
        }
        for (ri, r) in returned.iter().enumerate() {
            if r_used[ri] {
                continue;
            }
            if let Some(&bi) = id_to_b.get(&r.ariane_id) {
                if !b_used[bi] {
                    b_used[bi] = true;
                    r_used[ri] = true;
                    pairs.push((bi, ri));
                    bump(quality, MatchQuality::ArianeId);
                }
            }
        }
    }

    // Tier 3/4: align the remaining shots by geometry fingerprint (LCS), then
    // pair leftover runs positionally.
    let rem_b: Vec<usize> = (0..baseline.len()).filter(|&i| !b_used[i]).collect();
    let rem_r: Vec<usize> = (0..returned.len()).filter(|&i| !r_used[i]).collect();
    let rem_b_keys: Vec<&str> = rem_b.iter().map(|&i| baseline[i].geo_key.as_str()).collect();
    let rem_r_keys: Vec<&str> = rem_r.iter().map(|&i| returned[i].geo_key.as_str()).collect();
    let anchors = lcs_pairs(&rem_b_keys, &rem_r_keys);

    let mut bi = 0usize;
    let mut ri = 0usize;
    let mut ai = 0usize;
    loop {
        let (na_b, na_r) = if ai < anchors.len() {
            anchors[ai]
        } else {
            (rem_b.len(), rem_r.len())
        };
        // Positional pairing of the run before the next anchor.
        let seg_b = na_b - bi;
        let seg_r = na_r - ri;
        let k = seg_b.min(seg_r);
        for o in 0..k {
            pairs.push((rem_b[bi + o], rem_r[ri + o]));
            bump(quality, MatchQuality::Positional);
        }
        for o in k..seg_b {
            push_removed(
                project,
                proj_section,
                sid,
                baseline[rem_b[bi + o]].shot_index,
                section_name,
                cs,
            );
        }
        for o in k..seg_r {
            added_returned.push(rem_r[ri + o]);
        }
        if ai < anchors.len() {
            // The anchor itself is an exact geo-key match.
            pairs.push((rem_b[na_b], rem_r[na_r]));
            bump(quality, MatchQuality::Fingerprint);
            bi = na_b + 1;
            ri = na_r + 1;
            ai += 1;
        } else {
            break;
        }
    }

    // Resolve insert anchors. For each added shot, find the proj shot id of the
    // nearest preceding *matched* shot in returned order (None = section front).
    // Built from every matched pair (all tiers), so it is correct even when most
    // shots matched by UUID and nothing remains in the positional remainder.
    let mut matched_by_returned: Vec<(usize, ShotId)> = pairs
        .iter()
        .filter_map(|&(b_idx, r_idx)| {
            let shot_index = baseline[b_idx].shot_index as usize;
            proj_section.shots.get(shot_index).map(|s| (r_idx, s.id))
        })
        .collect();
    matched_by_returned.sort_by_key(|&(r_idx, _)| r_idx);

    // `added_returned` is already in ascending document order, so the resulting
    // `shots_added` for this section are too — apply relies on that ordering.
    for &r_idx in &added_returned {
        let after_shot_id = matched_by_returned
            .iter()
            .rev()
            .find(|&&(mr, _)| mr < r_idx)
            .map(|&(_, id)| id);
        cs.shots_added.push(AddedShot {
            section_id: Some(sid),
            section_name: section_name.to_string(),
            position: r_idx as u32,
            after_shot_id,
            data: returned[r_idx].data.clone(),
        });
    }

    // Classify all pairs into edits (representable field changed) or unchanged.
    for (b_idx, r_idx) in pairs {
        let entry = baseline[b_idx];
        let shot_index = entry.shot_index;
        let Some(existing) = proj_section.shots.get(shot_index as usize) else {
            continue;
        };
        let new = &returned[r_idx].data;
        let changes = field_changes(existing, new);
        if !changes.is_empty() {
            cs.shots_edited.push(EditedShot {
                section_id: sid,
                shot_index,
                section_name: section_name.to_string(),
                changes,
                new_data: new.clone(),
            });
        }
    }
}

fn push_removed(
    project: &Project,
    proj_section: &crate::models::Section,
    sid: SectionId,
    shot_index: u32,
    section_name: &str,
    cs: &mut CollabChangeSet,
) {
    let impact = proj_section
        .shots
        .get(shot_index as usize)
        .and_then(|s| project.preview_delete_shot(sid, s.id).ok())
        .unwrap_or_else(|| empty_impact(sid, shot_index));

    if !impact.removed_merges.is_empty()
        || !impact.removed_closures.is_empty()
    {
        cs.warnings.push(CollabWarning {
            message: format!(
                "Removing a shot in '{section_name}' affects {} merge(s) and {} closure(s)",
                impact.removed_merges.len(),
                impact.removed_closures.len()
            ),
        });
    }

    cs.shots_removed.push(RemovedShot {
        section_id: sid,
        shot_index,
        section_name: section_name.to_string(),
        impact,
    });
}

fn empty_impact(sid: SectionId, shot_index: u32) -> DeleteShotImpact {
    DeleteShotImpact {
        removed_station: crate::models::StationRef::new(sid, shot_index + 1),
        removed_merges: Vec::new(),
        removed_closures: Vec::new(),
        replacement_merges: Vec::new(),
        replacement_closure_updates: Vec::new(),
        merge_rewire_skipped: false,
        closure_rewire_skipped: false,
        shift_blocked: false,
        shift_blocked_reasons: Vec::new(),
    }
}

/// Representable-field comparison (TML-expressible fields only). Stalagmight-only
/// fields (azimuth_out, pitch_out, marker_index, temperature) are preserved and
/// never reported as changes.
fn field_changes(old: &crate::models::Shot, new: &ShotData) -> Vec<CollabFieldChange> {
    let mut c = Vec::new();
    let num = |field: &str, a: f64, b: f64, out: &mut Vec<CollabFieldChange>| {
        if (a - b).abs() > F_EPS {
            out.push(CollabFieldChange {
                field: field.into(),
                old: fmt_f(a),
                new: fmt_f(b),
            });
        }
    };
    num("azimuth", old.azimuth_in, new.azimuth_in, &mut c);
    num("length", old.length, new.length, &mut c);
    num("depth_in", old.depth_in, new.depth_in, &mut c);
    num("depth_out", old.depth_out, new.depth_out, &mut c);
    opt_num("inclination", old.pitch_in, new.pitch_in, &mut c);
    opt_num("left", old.left, new.left, &mut c);
    opt_num("right", old.right, new.right, &mut c);
    opt_num("up", old.up, new.up, &mut c);
    opt_num("down", old.down, new.down, &mut c);
    if opt_str(&old.comment) != opt_str(&new.comment) {
        c.push(CollabFieldChange {
            field: "comment".into(),
            old: opt_str(&old.comment),
            new: opt_str(&new.comment),
        });
    }
    if old.is_reference != new.is_reference {
        c.push(CollabFieldChange {
            field: "jump_line".into(),
            old: old.is_reference.to_string(),
            new: new.is_reference.to_string(),
        });
    }
    c
}

fn opt_num(field: &str, a: Option<f64>, b: Option<f64>, out: &mut Vec<CollabFieldChange>) {
    let av = a.unwrap_or(0.0);
    let bv = b.unwrap_or(0.0);
    if (av - bv).abs() > F_EPS {
        out.push(CollabFieldChange {
            field: field.into(),
            old: a.map(fmt_f).unwrap_or_default(),
            new: b.map(fmt_f).unwrap_or_default(),
        });
    }
}

fn fmt_f(v: f64) -> String {
    format!("{v:.3}")
}

fn opt_str(s: &Option<String>) -> String {
    s.clone().unwrap_or_default()
}

fn bump(current: &mut MatchQuality, candidate: MatchQuality) {
    fn rank(q: MatchQuality) -> u8 {
        match q {
            MatchQuality::Uuid => 0,
            MatchQuality::ArianeId => 1,
            MatchQuality::Fingerprint => 2,
            MatchQuality::Positional => 3,
        }
    }
    if rank(candidate) > rank(*current) {
        *current = candidate;
    }
}

/// Longest common subsequence over two key slices, returned as index pairs into
/// the respective slices (in order).
fn lcs_pairs(a: &[&str], b: &[&str]) -> Vec<(usize, usize)> {
    let n = a.len();
    let m = b.len();
    if n == 0 || m == 0 {
        return Vec::new();
    }
    let mut dp = vec![vec![0u32; m + 1]; n + 1];
    for i in (0..n).rev() {
        for j in (0..m).rev() {
            dp[i][j] = if a[i] == b[j] {
                dp[i + 1][j + 1] + 1
            } else {
                dp[i + 1][j].max(dp[i][j + 1])
            };
        }
    }
    let mut res = Vec::new();
    let (mut i, mut j) = (0usize, 0usize);
    while i < n && j < m {
        if a[i] == b[j] {
            res.push((i, j));
            i += 1;
            j += 1;
        } else if dp[i + 1][j] >= dp[i][j + 1] {
            i += 1;
        } else {
            j += 1;
        }
    }
    res
}

#[cfg(test)]
#[expect(clippy::unwrap_used, clippy::expect_used, clippy::float_cmp, clippy::indexing_slicing)]
mod tests {
    use super::*;
    use crate::export::tml::export_tml_with_baseline;
    use crate::models::{
        CollabState, GpsCoordinates, SectionData, ShotBaselineEntry, StationMerge, StationRef,
        ZeroDatum,
    };
    use crate::parsers::tml::parse_tml;
    use std::collections::HashMap as Map;

    fn section_with(name: &str, shots: Vec<ShotData>) -> SectionData {
        SectionData {
            name: Some(name.into()),
            surveyor: None,
            date: None,
            color: "#112233".into(),
            direction: None,
            quality: 1.0,
            shots,
        }
    }

    fn shot(az: f64, len: f64, d_in: f64, d_out: f64) -> ShotData {
        ShotData {
            azimuth_in: az,
            azimuth_out: az,
            length: len,
            depth_in: d_in,
            depth_out: d_out,
            ..Default::default()
        }
    }

    fn project_with(shots: Vec<ShotData>) -> Project {
        let mut p = Project::new("Cave".into(), None);
        p.add_section(SectionData {
            name: Some("Main".into()),
            surveyor: None,
            date: None,
            color: "#112233".into(),
            direction: None,
            quality: 1.0,
            shots,
        });
        p
    }

    fn three() -> Vec<ShotData> {
        vec![
            shot(10.0, 5.0, 0.0, 1.0),
            shot(20.0, 6.0, 1.0, 2.5),
            shot(30.0, 7.0, 2.5, 4.0),
        ]
    }

    fn set_baseline(
        project: &mut Project,
        baseline: Vec<ShotBaselineEntry>,
        synthetic: Vec<String>,
    ) {
        let mut c = CollabState::new("x.tml".into());
        let map: Map<String, SectionId> = baseline
            .iter()
            .map(|e| (e.section_name.clone(), e.section_id))
            .collect();
        c.section_name_map = map.into_iter().collect();
        c.shot_baseline = baseline;
        c.synthetic_section_names = synthetic;
        project.collab = Some(c);
    }

    /// Seed a pre-built project's collab baseline from its own export.
    fn baseline_for(mut p: Project, dir: &std::path::Path) -> Project {
        let (baseline, _, synthetic) =
            export_tml_with_baseline(&p, &dir.join("base.tml")).unwrap();
        set_baseline(&mut p, baseline, synthetic);
        p
    }

    /// Build the baseline project (with collab baseline seeded from its own export).
    fn baseline_project(shots: Vec<ShotData>, dir: &std::path::Path) -> Project {
        baseline_for(project_with(shots), dir)
    }

    /// Export an "edited" project and parse it back as the returned collaborator file.
    fn returned(edited: &Project, dir: &std::path::Path) -> TmlFile {
        let path = dir.join("returned.tmlu");
        export_tml_with_baseline(edited, &path).unwrap();
        parse_tml(&path).unwrap()
    }

    #[test]
    fn test_appended_shot_detected_as_added() {
        let dir = tempfile::TempDir::new().unwrap();
        let base = baseline_project(three(), dir.path());

        let mut more = three();
        more.push(shot(40.0, 8.0, 4.0, 5.5));
        let ret = returned(&project_with(more), dir.path());

        let cs = diff(&base, &ret);
        assert_eq!(cs.shots_added.len(), 1, "one appended shot");
        assert_eq!(cs.shots_edited.len(), 0);
        assert_eq!(cs.shots_removed.len(), 0);
        assert_eq!(cs.sections_added.len(), 0);
    }

    #[test]
    fn test_edited_length_detected_as_edit() {
        let dir = tempfile::TempDir::new().unwrap();
        let base = baseline_project(three(), dir.path());

        let mut edited = three();
        edited[1].length = 99.0;
        let ret = returned(&project_with(edited), dir.path());

        let cs = diff(&base, &ret);
        assert_eq!(cs.shots_edited.len(), 1, "one edited shot");
        assert_eq!(cs.shots_edited[0].shot_index, 1);
        assert!(cs.shots_edited[0].changes.iter().any(|c| c.field == "length"));
        assert_eq!(cs.shots_added.len(), 0);
        assert_eq!(cs.shots_removed.len(), 0);
    }

    #[test]
    fn test_removed_shot_detected() {
        let dir = tempfile::TempDir::new().unwrap();
        let base = baseline_project(three(), dir.path());

        let mut fewer = three();
        fewer.pop(); // drop last shot
        let ret = returned(&project_with(fewer), dir.path());

        let cs = diff(&base, &ret);
        assert_eq!(cs.shots_removed.len(), 1, "one removed shot");
        assert_eq!(cs.shots_added.len(), 0);
        assert_eq!(cs.shots_edited.len(), 0);
    }

    #[test]
    fn test_renumbered_ids_do_not_cause_mass_remove_add() {
        // Simulate Ariane ≤25 wholesale renumber: clear UUIDs and shift all IDs,
        // with one genuine length edit. The engine must fall back to geometry
        // matching and report exactly one edit — NOT remove-all + add-all.
        let dir = tempfile::TempDir::new().unwrap();
        let base = baseline_project(three(), dir.path());

        let mut edited = three();
        edited[1].length = 99.0;
        let mut ret = returned(&project_with(edited), dir.path());
        for section in &mut ret.sections {
            for s in &mut section.shots {
                s.uuid = None;
                s.id += 1000;
            }
        }

        let cs = diff(&base, &ret);
        assert!(cs.shots_removed.is_empty(), "no mass removals: {:?}", cs.shots_removed.len());
        assert!(cs.shots_added.is_empty(), "no mass adds: {}", cs.shots_added.len());
        assert_eq!(cs.shots_edited.len(), 1, "exactly the one real edit");
        assert_ne!(cs.match_quality, MatchQuality::Uuid);
    }

    #[test]
    fn test_mid_section_insert_anchored_to_preceding_shot() {
        // A shot inserted between B and C must be reported once, anchored after
        // B (not appended to the section end). Forces the geometry tier (cleared
        // UUIDs + shifted IDs) so the anchor is resolved from cross-tier pairs.
        let dir = tempfile::TempDir::new().unwrap();
        let base = baseline_project(three(), dir.path()); // [A, B, C]

        let mut edited = three();
        edited.insert(2, shot(25.0, 6.5, 2.5, 2.5)); // X between B and C → [A, B, X, C]
        let mut ret = returned(&project_with(edited), dir.path());
        for section in &mut ret.sections {
            for s in &mut section.shots {
                s.uuid = None;
                s.id += 1000;
            }
        }

        let cs = diff(&base, &ret);
        assert_eq!(cs.shots_added.len(), 1, "exactly one inserted shot");
        assert_eq!(cs.shots_edited.len(), 0, "no edits: {:?}", cs.shots_edited);
        assert_eq!(cs.shots_removed.len(), 0, "no removals: {:?}", cs.shots_removed);

        let added = &cs.shots_added[0];
        assert_eq!(added.position, 2, "document index within the returned section");
        let b_id = base.sections[0].shots[1].id;
        assert_eq!(
            added.after_shot_id,
            Some(b_id),
            "insert must be anchored after B, not appended at the end"
        );
    }

    #[test]
    fn test_no_changes_yields_empty() {
        let dir = tempfile::TempDir::new().unwrap();
        let base = baseline_project(three(), dir.path());
        let ret = returned(&project_with(three()), dir.path());
        let cs = diff(&base, &ret);
        assert!(cs.is_empty(), "identical re-export should be a no-op: {cs:?}");
    }

    #[test]
    fn test_clean_roundtrip_with_mid_station_datum_is_empty() {
        // A zero datum off the root station makes the exporter split a synthetic
        // "(pre-zero-datum)" reversed leg. A clean round-trip must NOT report that
        // leg as a new section (bug_001).
        let dir = tempfile::TempDir::new().unwrap();
        let mut p = project_with(three());
        p.zero_datums.push(ZeroDatum {
            station_ref: StationRef::new(p.sections[0].id, 2),
            gps: GpsCoordinates::new(20.25, -87.5, 12.0).unwrap(),
        });
        let base = baseline_for(p, dir.path());
        assert!(
            base.collab
                .as_ref()
                .unwrap()
                .synthetic_section_names
                .iter()
                .any(|n| n.ends_with("(pre-zero-datum)")),
            "fixture should produce a pre-zero-datum synthetic leg"
        );

        let ret = returned(&base, dir.path());
        let cs = diff(&base, &ret);
        assert!(cs.is_empty(), "clean round-trip must be a no-op: {cs:?}");
    }

    #[test]
    fn test_clean_roundtrip_with_merged_child_is_empty() {
        // A child section merged mid-station makes the exporter split a synthetic
        // "(reversed)" leg. A clean round-trip must NOT report it as a new
        // section (bug_001).
        let dir = tempfile::TempDir::new().unwrap();
        let mut p = Project::new("Cave".into(), None);
        p.add_section(section_with("Main", three()));
        // Branch's merge station (child station 2) sits at depth 1.0 — the same
        // depth as root station 1 it merges onto (merged points are physically
        // coincident), so the forward leg round-trips without a phantom depth edit.
        p.add_section(section_with(
            "Branch",
            vec![
                shot(40.0, 4.0, 0.0, 0.5),
                shot(50.0, 5.0, 0.5, 1.0),
                shot(60.0, 6.0, 1.0, 1.5),
            ],
        ));
        let root_id = p.sections[0].id;
        let child_id = p.sections[1].id;
        p.station_merges.push(StationMerge {
            station_a: StationRef::new(root_id, 1),
            station_b: StationRef::new(child_id, 2),
            merged_at: chrono::Utc::now(),
        });
        let base = baseline_for(p, dir.path());
        assert!(
            base.collab
                .as_ref()
                .unwrap()
                .synthetic_section_names
                .iter()
                .any(|n| n.ends_with("(reversed)")),
            "fixture should produce a reversed synthetic leg"
        );

        let ret = returned(&base, dir.path());
        let cs = diff(&base, &ret);
        assert!(cs.is_empty(), "clean round-trip must be a no-op: {cs:?}");
    }
}
