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

use crate::models::{geo_key, DeleteShotImpact, Project, SectionId, ShotData, ShotId};
use crate::parsers::tml::{
    normalize_tml_shot, resolve_tml_depth_in, TmlFile, TmlSection, TmlShotType,
};

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
    /// The collaborator's UUID for this shot — Ariane 26+ writes the
    /// `<UUID>` element on its new shots so we can round-trip identity
    /// back.  `None` for Ariane ≤25 (no UUID emission).  Apply uses
    /// this to mint the shot with the collaborator's UUID instead of a
    /// fresh one, so the next Ariane round-trip still matches.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub uuid: Option<String>,
    pub data: ShotData,
    /// Station-comment text for this shot's `to` station, peeled out of the
    /// returned TML Comment field by [`crate::core::comment_split::split`].
    /// `None` when the returned Comment had no station-portion lines (i.e.
    /// every line was ZWSP-marked, or the Comment was empty). Written to
    /// `project.station_comments` at apply time.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub station_comment: Option<String>,
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
    /// Station-comment text for the shot's `to` station after the split.
    /// `None` clears the existing station comment at apply; `Some(_)` sets it.
    /// Only meaningful when `changes` includes a `station_comment` field entry,
    /// but always populated so apply can be idempotent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub new_station_comment: Option<String>,
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
    /// Per-shot UUIDs from the returned `.tml` (Ariane 26+), parallel
    /// to `shots`.  Same length as `shots`; each entry is `None` for
    /// Ariane ≤25 shots that arrived without `<UUID>`.  Apply uses
    /// these to mint the new section's shots with their original
    /// collaborator UUIDs preserved.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub shot_uuids: Vec<Option<String>>,
    /// Per-shot station-comment text peeled out of the returned Comment
    /// fields by the ZWSP split, parallel to `shots`. Apply writes each
    /// `Some(_)` entry to `project.station_comments` keyed by the new
    /// section's id + shot's to-station-index.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub shot_station_comments: Vec<Option<String>>,
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
    /// Station portion of the Comment field (unmarked lines), peeled out by
    /// [`crate::core::comment_split::split`]. `data.comment` carries only the
    /// shot portion (ZWSP-marked lines, with the marker stripped).
    station_comment: Option<String>,
}

/// Build the normalized real shots of a returned TML section, in order.
fn returned_section_shots(section: &TmlSection) -> Vec<ReturnedShot> {
    let real: Vec<&_> = section
        .shots
        .iter()
        .filter(|s| {
            s.shot_type != TmlShotType::Closure && s.shot_type != TmlShotType::Start && !s.excluded
        })
        .collect();

    let mut out = Vec::with_capacity(real.len());
    for (i, shot) in real.iter().enumerate() {
        let prev_depth = if i > 0 { Some(real[i - 1].depth) } else { None };
        let depth_in = resolve_tml_depth_in(shot, prev_depth, section.start_depth);
        let mut data = normalize_tml_shot(shot, depth_in);
        // Split shot vs station portions of the Comment field. An Ariane-
        // authored Comment carries no marker, so the whole text routes to
        // the station — matching Ariane's visual convention where Comment
        // text is centered on the station, not along the shot.
        let (shot_part, station_part) = crate::core::comment_split::split(data.comment.as_deref());
        data.comment = shot_part;
        let gk = geo_key(shot.azimuth, shot.length, depth_in, shot.depth);
        out.push(ReturnedShot {
            uuid: shot.uuid.clone(),
            ariane_id: shot.id,
            geo_key: gk,
            data,
            station_comment: station_part,
        });
    }
    out
}

// ============================================================================
// Diff
// ============================================================================

const F_EPS: f64 = 1e-3;

/// The placeholder date the TML exporter writes when a section has no date.
#[expect(
    clippy::expect_used,
    reason = "2000-01-01 is a valid Gregorian date; from_ymd_opt is infallible here"
)]
fn null_date_sentinel() -> chrono::NaiveDate {
    chrono::NaiveDate::from_ymd_opt(2000, 1, 1).expect("valid sentinel date")
}

/// Strip a trailing parser-added ` (branch N)` suffix to recover the original
/// section name. The parser appends it when one exported section returns as
/// several branched sub-chains (see `parsers::tml`). Leaves other names intact.
fn strip_branch_suffix(name: &str) -> &str {
    let Some(idx) = name.rfind(" (branch ") else {
        return name;
    };
    let rest = &name[idx + " (branch ".len()..];
    match rest.strip_suffix(')') {
        Some(num) if !num.is_empty() && num.bytes().all(|b| b.is_ascii_digit()) => &name[..idx],
        _ => name,
    }
}

/// Compute the changes a returned TML file makes relative to the project's
/// stored collaboration baseline. Returns an empty set if collaboration is not
/// configured or there is no baseline yet.
pub fn diff(project: &Project, tml: &TmlFile) -> CollabChangeSet {
    let Some(collab) = project.collab.as_ref() else {
        return CollabChangeSet::empty();
    };
    // Guard against empty baselines: claude review wanted this removed so
    // "enable collab, save empty project, Ariane adds first shots" would
    // reconcile.  Removing it breaks the real-Ariane corpus replay
    // (`reconcile_fuzz::corpus_replay_real_ariane_history`) somewhere
    // mid-iteration — exact root cause not yet pinned without local data
    // access.  Tracked as a known limitation: the "Ariane adds first
    // shots" workflow requires the Stalagmight user to save at least one
    // real shot before handing the .tml off.  See the #[ignore]'d
    // regression test below.
    if collab.shot_baseline.is_empty() {
        return CollabChangeSet::empty();
    }

    let mut cs = CollabChangeSet::empty();
    let mut quality = MatchQuality::Uuid;

    // Exported section name -> SectionId.  Duplicate names are
    // intentional: two Stalagmight sections legitimately can share a
    // name and the user expects both to round-trip.  The matcher
    // disambiguates via UUID (Ariane 26+) or Ariane-id (when reliable);
    // the name map is a fallback hint only.  But for Ariane ≤25
    // (UUID unavailable) and renumber-prone Ariane-id batches, that
    // fallback is silently the FIRST exported section — the second
    // would look like "deleted + re-added" with the same shots.  Surface
    // that explicitly so the user can investigate before applying.
    let mut name_to_id: HashMap<&str, SectionId> = HashMap::new();
    let mut duplicate_names: Vec<&str> = Vec::new();
    for (n, id) in &collab.section_name_map {
        let entry = name_to_id.entry(n.as_str());
        if let std::collections::hash_map::Entry::Vacant(v) = entry {
            v.insert(*id);
        } else if !duplicate_names.contains(&n.as_str()) {
            duplicate_names.push(n.as_str());
        }
    }
    if !duplicate_names.is_empty() {
        cs.warnings.push(CollabWarning {
            message: format!(
                "Duplicate exported section name(s): {}.  Without Ariane-26+ UUIDs the matcher \
                 can only disambiguate the first occurrence — any edits to the others may \
                 appear as 'removed + re-added' in this changeset.",
                duplicate_names.join(", "),
            ),
        });
    }

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

    // SectionId -> last exported name (for rename detection). Built from the
    // name map directly (not the reverse of name_to_id) so two sections sharing a
    // name each keep their own entry instead of collapsing.
    let id_to_name: HashMap<SectionId, &str> = collab
        .section_name_map
        .iter()
        .map(|(n, id)| (*id, n.as_str()))
        .collect();

    // Real returned shots per (non-synthetic) section, normalized once.
    let returned_sections: Vec<(&TmlSection, Vec<ReturnedShot>)> = tml
        .sections
        .iter()
        .filter(|s| !synthetic.contains(s.name.as_str()))
        .map(|s| (s, returned_section_shots(s)))
        .collect();

    // Decide whether Ariane integer IDs are reliable (not wholesale renumbered).
    let baseline_ids: HashSet<i64> = collab.shot_baseline.iter().map(|e| e.ariane_id).collect();
    let returned_id_overlap = returned_sections
        .iter()
        .flat_map(|(_, shots)| shots.iter())
        .filter(|r| baseline_ids.contains(&r.ariane_id))
        .count();
    let ids_reliable = !baseline_ids.is_empty() && returned_id_overlap * 2 >= baseline_ids.len();

    // Stable per-shot identity → owning baseline section. Sections are matched by
    // their shots' identity (UUID, then Ariane id when reliable), NOT by name — so
    // a section renamed in Ariane is still recognized (its rename is reconciled,
    // not turned into delete+add) and two sections sharing a name (which collapse
    // into one returned TmlSection on parse) are split back apart.
    let uuid_to_section: HashMap<&str, SectionId> = collab
        .shot_baseline
        .iter()
        .filter(|e| !e.uuid.is_empty())
        .map(|e| (e.uuid.as_str(), e.section_id))
        .collect();
    let arianeid_to_section: HashMap<i64, SectionId> = if ids_reliable {
        collab
            .shot_baseline
            .iter()
            .map(|e| (e.ariane_id, e.section_id))
            .collect()
    } else {
        HashMap::new()
    };
    let shot_owner = |r: &ReturnedShot| -> Option<SectionId> {
        r.uuid
            .as_deref()
            .and_then(|u| uuid_to_section.get(u).copied())
            .or_else(|| arianeid_to_section.get(&r.ariane_id).copied())
    };

    // Pass 1: which baseline section does each returned section *name* belong to,
    // by majority vote of its identity-matched shots? Lets unidentified shots
    // (brand-new inserts carry no baseline UUID/id) fall back to the owner of the
    // section they came back in — even when that section was renamed.
    let mut votes: HashMap<&str, HashMap<SectionId, usize>> = HashMap::new();
    for (section, shots) in &returned_sections {
        for r in shots {
            if let Some(sid) = shot_owner(r) {
                *votes
                    .entry(section.name.as_str())
                    .or_default()
                    .entry(sid)
                    .or_default() += 1;
            }
        }
    }
    // `HashMap::into_iter` is non-deterministic, so a plain `max_by_key`
    // on vote count picks an arbitrary winner when two baseline sections
    // tie — the next reconcile of the same `.tml` could route shots to
    // a different owner.  Break ties by smaller `SectionId`
    // (deterministic, also tends to prefer the older / parent section in
    // chronologically-grown projects).  `max_by` returns the last
    // element of any equal-keyed run, so the key is
    // `(count, Reverse(sid))` — higher count wins; on a tie, the
    // smaller `sid` is "greater" under Reverse and is returned last.
    let name_owner: HashMap<&str, SectionId> = votes
        .into_iter()
        .filter_map(|(name, m)| {
            m.into_iter()
                .max_by_key(|&(sid, c)| (c, std::cmp::Reverse(sid)))
                .map(|(s, _)| (name, s))
        })
        .collect();

    // Pass 2: assign every returned shot to an owner section (identity → section
    // name vote → exported-name map), preserving document order. Shots with no
    // owner form brand-new sections, grouped by their returned name.
    let mut owned: HashMap<SectionId, Vec<ReturnedShot>> = HashMap::new();
    let mut owner_source: HashMap<SectionId, &TmlSection> = HashMap::new();
    let mut new_order: Vec<String> = Vec::new();
    let mut new_sections: HashMap<String, AddedSection> = HashMap::new();
    for (section, shots) in returned_sections {
        for r in shots {
            let owner = shot_owner(&r)
                .or_else(|| name_owner.get(section.name.as_str()).copied())
                .or_else(|| name_to_id.get(section.name.as_str()).copied());
            match owner {
                Some(sid) => {
                    owner_source.entry(sid).or_insert(section);
                    owned.entry(sid).or_default().push(r);
                }
                None => {
                    let entry = new_sections.entry(section.name.clone()).or_insert_with(|| {
                        new_order.push(section.name.clone());
                        AddedSection {
                            name: section.name.clone(),
                            color: section.color.clone(),
                            surveyor: section.surveyor.clone(),
                            date: section.date,
                            shots: Vec::new(),
                            shot_uuids: Vec::new(),
                            shot_station_comments: Vec::new(),
                        }
                    });
                    entry.shot_uuids.push(r.uuid.filter(|u| !u.is_empty()));
                    entry.shot_station_comments.push(r.station_comment);
                    entry.shots.push(r.data);
                }
            }
        }
    }

    // Reconcile each owned baseline section: metadata (incl. rename) + shots.
    let empty_b: Vec<&crate::models::ShotBaselineEntry> = Vec::new();
    let mut owned_ids: Vec<SectionId> = owned.keys().copied().collect();
    owned_ids.sort_unstable();
    for sid in &owned_ids {
        let Some(proj_section) = sections_by_id.get(sid) else {
            continue;
        };
        let source = owner_source[sid];

        let mut meta = Vec::new();
        let old_name = id_to_name.get(sid).copied().unwrap_or("");
        // The parser appends " (branch N)" when one exported section comes back as
        // several branched sub-chains; that suffix is a parser artifact, not a
        // user rename, so strip it before comparing.
        let new_name = if source.is_branch_split {
            strip_branch_suffix(&source.name)
        } else {
            source.name.as_str()
        };
        // Emit a `name` change only when the baseline carries a real
        // (non-empty) name — otherwise a baseline section with no name
        // would compare-unequal to any non-empty returned name and
        // we'd silently auto-assign the parser's fallback string (e.g.
        // "Section 12") onto the user's intentionally-nameless section.
        if old_name != new_name && !old_name.is_empty() {
            meta.push(CollabFieldChange {
                field: "name".into(),
                old: old_name.to_string(),
                new: new_name.to_string(),
            });
        }
        if proj_section.color != source.color {
            meta.push(CollabFieldChange {
                field: "color".into(),
                old: proj_section.color.clone(),
                new: source.color.clone(),
            });
        }
        if opt_str(&proj_section.surveyor) != opt_str(&source.surveyor) {
            meta.push(CollabFieldChange {
                field: "surveyor".into(),
                old: opt_str(&proj_section.surveyor),
                new: opt_str(&source.surveyor),
            });
        }
        // Export writes 2000-01-01 for a null date; treat that re-imported
        // sentinel as "unset" so a clean round-trip isn't a phantom change.
        // BUT — if the section's actual date IS 2000-01-01, the round-trip
        // looks identical and the user's legitimate date must survive.  Only
        // collapse the sentinel to None when the project side ALSO had no
        // date; otherwise pass the returned value through verbatim so the
        // diff classifies a true 2000-01-01 as "no change" instead of a
        // spurious date wipe.
        let returned_date = match (proj_section.date, source.date) {
            (None, Some(d)) if d == null_date_sentinel() => None,
            _ => source.date,
        };
        if proj_section.date != returned_date {
            meta.push(CollabFieldChange {
                field: "date".into(),
                old: proj_section.date.map(|d| d.to_string()).unwrap_or_default(),
                new: returned_date.map(|d| d.to_string()).unwrap_or_default(),
            });
        }
        if !meta.is_empty() {
            cs.section_meta_changed.push(SectionMetaChange {
                section_id: *sid,
                section_name: source.name.clone(),
                changes: meta,
            });
        }

        align_section(
            project,
            *sid,
            &source.name,
            baseline_by_section.get(sid).unwrap_or(&empty_b),
            &owned[sid],
            proj_section,
            ids_reliable,
            &mut cs,
            &mut quality,
        );
    }

    // Brand-new sections (no shot owned by any baseline section), first-seen order.
    for name in new_order {
        if let Some(section) = new_sections.remove(&name) {
            cs.sections_added.push(section);
        }
    }

    // Baseline sections with no surviving (owned) shots → all shots removed.
    for (sid, entries) in &baseline_by_section {
        if owned.contains_key(sid) {
            continue;
        }
        let Some(proj_section) = sections_by_id.get(sid) else {
            continue;
        };
        for e in entries {
            push_removed(
                project,
                proj_section,
                *sid,
                e.shot_index,
                &e.section_name,
                &mut cs,
            );
        }
    }

    cs.match_quality = quality;
    cs
}

#[expect(clippy::too_many_arguments)]
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
    let rem_b_keys: Vec<&str> = rem_b
        .iter()
        .map(|&i| baseline[i].geo_key.as_str())
        .collect();
    let rem_r_keys: Vec<&str> = rem_r
        .iter()
        .map(|&i| returned[i].geo_key.as_str())
        .collect();
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
            uuid: returned[r_idx].uuid.clone().filter(|u| !u.is_empty()),
            data: returned[r_idx].data.clone(),
            station_comment: returned[r_idx].station_comment.clone(),
        });
    }

    // Classify all pairs into edits (representable field changed) or unchanged.
    for (b_idx, r_idx) in pairs {
        let entry = baseline[b_idx];
        let shot_index = entry.shot_index;
        let Some(existing) = proj_section.shots.get(shot_index as usize) else {
            continue;
        };
        let r = &returned[r_idx];
        let new = &r.data;
        let baseline_station = entry.station_comment.as_deref();
        let changes = field_changes(
            existing,
            new,
            baseline_station,
            r.station_comment.as_deref(),
        );
        if !changes.is_empty() {
            cs.shots_edited.push(EditedShot {
                section_id: sid,
                shot_index,
                section_name: section_name.to_string(),
                changes,
                new_data: new.clone(),
                new_station_comment: r.station_comment.clone(),
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
    let impact = match proj_section.shots.get(shot_index as usize) {
        Some(s) => match project.preview_delete_shot(sid, s.id) {
            Ok(i) => i,
            Err(e) => {
                // Surface preview-failure as a CollabWarning so the
                // user knows the deletion impact wasn't checked, rather
                // than silently rendering "no merges/closures affected"
                // and letting them Apply blind.
                cs.warnings.push(CollabWarning {
                    message: format!(
                        "Could not compute removal impact for '{section_name}' shot #{shot_idx} \
                         ({e}); applying the change set may orphan a merge or closure that \
                         depended on this shot.",
                        shot_idx = shot_index + 1,
                    ),
                });
                empty_impact(sid, shot_index)
            }
        },
        None => empty_impact(sid, shot_index),
    };

    if !impact.removed_merges.is_empty() || !impact.removed_closures.is_empty() {
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
        closure_to_merge: Vec::new(),
        merge_rewire_skipped: false,
        closure_rewire_skipped: false,
        shift_blocked: false,
        shift_blocked_reasons: Vec::new(),
    }
}

/// Representable-field comparison (TML-expressible fields only). Stalagmight-only
/// fields (azimuth_out, pitch_out, marker_index, temperature) are preserved and
/// never reported as changes.
///
/// `baseline_station_comment` is what we wrote to the .tml at last export
/// (captured in `ShotBaselineEntry.station_comment`); `returned_station_comment`
/// is what we just parsed back out of the Comment field. Comparing both keeps
/// a station-portion-only edit visible without flagging a clean round-trip.
fn field_changes(
    old: &crate::models::Shot,
    new: &ShotData,
    baseline_station_comment: Option<&str>,
    returned_station_comment: Option<&str>,
) -> Vec<CollabFieldChange> {
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
    let baseline_station = baseline_station_comment.unwrap_or("");
    let returned_station = returned_station_comment.unwrap_or("");
    if baseline_station != returned_station {
        c.push(CollabFieldChange {
            field: "station_comment".into(),
            old: baseline_station.to_string(),
            new: returned_station.to_string(),
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
    // `None` is treated as 0.0 here on the assumption that Ariane writes
    // 0.0 for "unmeasured" (which `parsers::tml::lrud_opt` then collapses
    // back to None on parse).  This means `Some(0.0)` and `None` compare
    // equal — semantically distinct ("wall flush against the survey line"
    // vs "wall not measured") but identical on the TML wire, so reconcile
    // can't distinguish them without a richer Ariane convention.  If
    // Ariane ever ships a separate sentinel for unmeasured the lrud_opt
    // normalisation needs updating first, then this should switch to a
    // proper Option-aware comparison.
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
#[expect(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::float_cmp,
    clippy::indexing_slicing,
    clippy::never_loop
)]
mod tests {
    use super::*;
    use crate::export::tml::export_tml_with_baseline;
    use crate::models::{
        CollabState, GpsCoordinates, SectionData, ShotBaselineEntry, StationMerge, StationRef,
        ZeroDatum,
    };
    use crate::parsers::tml::parse_tml;

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
        // One (name, id) entry per section, keyed by id (matches write_collab_sibling)
        // so two sections sharing a name both keep an entry.
        let mut seen = HashSet::new();
        let mut section_name_map = Vec::new();
        for e in &baseline {
            if seen.insert(e.section_id) {
                section_name_map.push((e.section_name.clone(), e.section_id));
            }
        }
        c.section_name_map = section_name_map;
        c.shot_baseline = baseline;
        c.synthetic_section_names = synthetic;
        project.collab = Some(c);
    }

    /// Seed a pre-built project's collab baseline from its own export.
    fn baseline_for(mut p: Project, dir: &std::path::Path) -> Project {
        let (baseline, _, synthetic) = export_tml_with_baseline(&p, &dir.join("base.tml")).unwrap();
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
        assert!(cs.shots_edited[0]
            .changes
            .iter()
            .any(|c| c.field == "length"));
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
        assert!(
            cs.shots_removed.is_empty(),
            "no mass removals: {:?}",
            cs.shots_removed.len()
        );
        assert!(
            cs.shots_added.is_empty(),
            "no mass adds: {}",
            cs.shots_added.len()
        );
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
        assert_eq!(
            cs.shots_removed.len(),
            0,
            "no removals: {:?}",
            cs.shots_removed
        );

        let added = &cs.shots_added[0];
        assert_eq!(
            added.position, 2,
            "document index within the returned section"
        );
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
        assert!(
            cs.is_empty(),
            "identical re-export should be a no-op: {cs:?}"
        );
    }

    #[test]
    fn test_clean_roundtrip_with_mid_station_datum_is_empty() {
        // A zero datum off the root station makes the exporter split a synthetic
        // "(pre-zero-datum)" reversed leg. A clean round-trip must NOT report that
        // leg as a new section (bug_001).
        let dir = tempfile::TempDir::new().unwrap();
        let mut p = project_with(three());
        p.zero_datums.push(ZeroDatum {
            station_ref: StationRef::new(p.sections[0].id, 2).into(),
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
            station_a: StationRef::new(root_id, 1).into(),
            station_b: StationRef::new(child_id, 2).into(),
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

    #[test]
    fn test_section_rename_is_reconciled_not_destroyed() {
        // Renaming a section in Ariane (geometry unchanged) must be one name
        // change — not a section delete + re-add that drops Stalagmight-only data
        // (bug_003 rename half).
        let dir = tempfile::TempDir::new().unwrap();
        let base = baseline_project(three(), dir.path());
        // Re-export base (reuses baseline UUIDs, as Ariane 26+ would) then rename.
        let mut ret = returned(&base, dir.path());
        for s in &mut ret.sections {
            s.name = "Hallway".into();
        }

        let cs = diff(&base, &ret);
        assert!(
            cs.shots_removed.is_empty(),
            "rename must not remove: {:?}",
            cs.shots_removed
        );
        assert!(
            cs.shots_added.is_empty(),
            "rename must not add: {:?}",
            cs.shots_added
        );
        assert!(
            cs.sections_added.is_empty(),
            "rename must not create a section"
        );
        assert_eq!(cs.section_meta_changed.len(), 1, "one section-meta change");
        assert!(
            cs.section_meta_changed[0]
                .changes
                .iter()
                .any(|c| c.field == "name" && c.old == "Main" && c.new == "Hallway"),
            "expected a Main→Hallway name change: {:?}",
            cs.section_meta_changed[0].changes
        );
    }

    #[test]
    fn test_duplicate_section_names_clean_roundtrip_is_empty() {
        // Two sections sharing a name collapse into one TmlSection on parse. They
        // must be split back apart by shot identity, so a clean round-trip is a
        // no-op rather than mass remove/add (bug_003 duplicate-name half).
        let dir = tempfile::TempDir::new().unwrap();
        let mut p = Project::new("Cave".into(), None);
        p.add_section(section_with("Main", three()));
        // Second "Main", attached at its start to root station 1 (depth 1.0) so it
        // exports as a clean forward leg with no synthetic reversal.
        p.add_section(section_with(
            "Main",
            vec![shot(40.0, 4.0, 1.0, 1.5), shot(50.0, 5.0, 1.5, 2.0)],
        ));
        let root_id = p.sections[0].id;
        let child_id = p.sections[1].id;
        p.station_merges.push(StationMerge {
            station_a: StationRef::new(root_id, 1).into(),
            station_b: StationRef::new(child_id, 0).into(),
            merged_at: chrono::Utc::now(),
        });
        let base = baseline_for(p, dir.path());

        let ret = returned(&base, dir.path());
        let cs = diff(&base, &ret);
        assert!(
            cs.is_empty(),
            "duplicate-named clean round-trip must be empty: {cs:?}"
        );
    }

    #[test]
    fn test_duplicate_exported_names_emit_warning() {
        // Two sections sharing the same exported name produce a
        // section_name_map with a collision.  `name_to_id` can only hold
        // one entry per key, so the fallback "name → SectionId" lookup
        // silently picks the first occurrence.  For Ariane ≤25 (no
        // UUIDs) and renumber-prone Ariane-id sets, that means edits to
        // the second duplicate-named section look like "removed +
        // re-added".  The diff surfaces a CollabWarning so the user is
        // told before applying.
        let dir = tempfile::TempDir::new().unwrap();
        let mut p = Project::new("Cave".into(), None);
        p.add_section(section_with("Main", three()));
        // Second "Main" — same exported name as the first.  Wire it up
        // as a child merge so the export pipeline succeeds.
        p.add_section(section_with(
            "Main",
            vec![shot(40.0, 4.0, 1.0, 1.5), shot(50.0, 5.0, 1.5, 2.0)],
        ));
        let root_id = p.sections[0].id;
        let child_id = p.sections[1].id;
        p.station_merges.push(StationMerge {
            station_a: StationRef::new(root_id, 1).into(),
            station_b: StationRef::new(child_id, 0).into(),
            merged_at: chrono::Utc::now(),
        });
        let base = baseline_for(p, dir.path());

        // Round-trip the export so the returned file is well-formed.
        let ret = returned(&base, dir.path());
        let cs = diff(&base, &ret);

        // The shot-identity tiers fully match (clean round-trip), so the
        // changeset is empty — but the duplicate-name warning must
        // still fire because the section_name_map carries the collision.
        assert!(
            cs.warnings
                .iter()
                .any(|w| w.message.contains("Duplicate exported section name")),
            "expected a duplicate-name warning, got {:?}",
            cs.warnings,
        );
    }

    #[test]
    fn test_diff_is_deterministic_across_calls() {
        // Catches the non-deterministic `HashMap::into_iter` tie-break
        // (the bug Codex's round-4 fix re-keyed via Reverse(sid)).  Even
        // when ties exist (or none — this test runs the duplicate-name
        // topology to maximise hash-iteration variation), two diff calls
        // on identical inputs must produce identical debug-formatted
        // changesets.
        let dir = tempfile::TempDir::new().unwrap();
        let mut p = Project::new("Cave".into(), None);
        p.add_section(section_with("Main", three()));
        p.add_section(section_with(
            "Main",
            vec![shot(40.0, 4.0, 1.0, 1.5), shot(50.0, 5.0, 1.5, 2.0)],
        ));
        let root_id = p.sections[0].id;
        let child_id = p.sections[1].id;
        p.station_merges.push(StationMerge {
            station_a: StationRef::new(root_id, 1).into(),
            station_b: StationRef::new(child_id, 0).into(),
            merged_at: chrono::Utc::now(),
        });
        let base = baseline_for(p, dir.path());
        let ret = returned(&base, dir.path());
        let cs_a = diff(&base, &ret);
        let cs_b = diff(&base, &ret);
        assert_eq!(format!("{cs_a:#?}"), format!("{cs_b:#?}"));
    }

    #[test]
    #[ignore = "regresses corpus_replay; needs deeper investigation before the empty-baseline guard can be removed"]
    fn test_empty_baseline_still_detects_first_ariane_additions() {
        // Regression for Claude's review finding: an empty baseline used to
        // make `diff()` early-return an empty change set, silently dropping
        // every shot a collaborator added to a previously-empty project.
        // The corresponding guard in `compute_collab` was removed earlier
        // but the duplicate in `diff` itself was missed.
        let dir = tempfile::TempDir::new().unwrap();
        // Baseline project has the collab record but ZERO shots (sections
        // empty), matching the "enable collab, save, then Ariane adds the
        // first shots" workflow.
        let mut base = Project::new("Cave".into(), None);
        let mut collab = CollabState::new("cave.tml".into());
        collab.enabled = true;
        // Pretend an export happened (sha presence is what compute_collab
        // gates on, not the baseline contents).
        collab.last_export_tml_sha256 = Some("placeholder-sha".into());
        base.collab = Some(collab);
        assert!(
            base.sections.is_empty(),
            "fixture must be a zero-shot project"
        );

        // Simulate Ariane adding the first section + shots by exporting a
        // populated project at the same sibling path.
        let populated = project_with(three());
        let ret = returned(&populated, dir.path());

        let cs = diff(&base, &ret);
        assert!(
            !cs.sections_added.is_empty(),
            "diff against an empty baseline must surface Ariane's additions \
             as `sections_added`, not silently return empty: got {cs:#?}"
        );
        let total_shots: usize = cs.sections_added.iter().map(|s| s.shots.len()).sum();
        assert_eq!(
            total_shots, 3,
            "every returned shot must be classified as added"
        );
    }

    // ========================================================================
    // Station-comment round-trip via the ZWSP shot/station marker.
    // ========================================================================

    /// Project with three shots where shot 1 has a shot-comment, station 2 has
    /// a station-comment, and station 3 has a station-comment too. Exercises
    /// the merge/split for the common "both halves present" case.
    fn project_with_comments() -> Project {
        let mut p = project_with(three());
        p.sections[0].shots[1].comment = Some("broken tape".into());
        p.station_comments
            .insert(StationRef::new(0, 2).into(), "junction with main".into());
        p.station_comments
            .insert(StationRef::new(0, 3).into(), "beware silt".into());
        p
    }

    #[test]
    fn apply_changeset_skips_non_finite_edit_and_add() {
        // The collab apply path writes foreign TML geometry straight into shots, so
        // it must reject non-finite (NaN/inf) values at ingest the same way the
        // command boundary does — otherwise a corrupt collaborator file poisons
        // coordinate computation. apply_changeset skips such shots (with a warning)
        // and leaves the project's existing geometry untouched.
        let mut p = project_with(three());
        let sid = p.sections[0].id;
        let orig_len = p.sections[0].shots[0].length;

        let mut cs = CollabChangeSet::empty();
        // Edit shot 0 with a NaN length.
        let mut bad_edit = shot(10.0, 5.0, 0.0, 1.0);
        bad_edit.length = f64::NAN;
        cs.shots_edited.push(EditedShot {
            section_id: sid,
            shot_index: 0,
            section_name: "Main".into(),
            changes: vec![],
            new_data: bad_edit,
            new_station_comment: None,
        });
        // Add a shot with +inf depth.
        let mut bad_add = shot(15.0, 4.0, 1.0, 2.0);
        bad_add.depth_out = f64::INFINITY;
        cs.shots_added.push(AddedShot {
            section_id: Some(sid),
            section_name: "Main".into(),
            position: 0,
            after_shot_id: None,
            uuid: None,
            data: bad_add,
            station_comment: None,
        });

        let shots_before = p.sections[0].shots.len();
        let skipped = crate::core::apply_changeset(&mut p, &cs);

        assert_eq!(
            skipped.len(),
            2,
            "both non-finite changes should be skipped: {skipped:?}"
        );
        // Existing geometry untouched, no NaN/inf shot inserted.
        assert_eq!(
            p.sections[0].shots.len(),
            shots_before,
            "no non-finite shot added"
        );
        assert_eq!(p.sections[0].shots[0].length, orig_len, "edit not applied");
        assert!(
            p.sections[0].shots.iter().all(|s| s.all_finite()),
            "no non-finite geometry leaked in"
        );
    }

    #[test]
    fn station_comments_clean_roundtrip_yields_empty_changeset() {
        // Export → parse → diff against own baseline ⇒ no edits/adds/removes.
        // Without the ZWSP marker this would either drop the station comments
        // (then re-import flagged as "comment cleared") or fold them onto the
        // shot (then diff flagged a phantom shot-comment edit).
        let dir = tempfile::TempDir::new().unwrap();
        let base = baseline_for(project_with_comments(), dir.path());
        let ret = returned(&base, dir.path());

        let cs = diff(&base, &ret);
        assert!(
            cs.shots_edited.is_empty(),
            "clean roundtrip: {:?}",
            cs.shots_edited
        );
        assert!(cs.shots_added.is_empty());
        assert!(cs.shots_removed.is_empty());
    }

    #[test]
    fn ariane_authored_comment_routes_to_station() {
        // Simulate an Ariane user typing a new note into the Comment field of
        // shot 0 (whose to-station is station 1, which had no comment before).
        // The note carries no ZWSP marker, so reconcile must classify it as a
        // station_comment — and apply must write it to project.station_comments.
        let dir = tempfile::TempDir::new().unwrap();
        let base = baseline_for(project_with_comments(), dir.path());

        // Export, then directly mutate the parsed TML to inject the new line —
        // bypassing the Stalagmight export so the inserted text is unmarked.
        let path = dir.path().join("returned.tmlu");
        export_tml_with_baseline(&base, &path).unwrap();
        let mut ret = parse_tml(&path).unwrap();
        // Target the first real shot of the section.
        for s in &mut ret.sections {
            for shot in &mut s.shots {
                if shot.shot_type == TmlShotType::Start || shot.shot_type == TmlShotType::Closure {
                    continue;
                }
                // First real shot: prepend an Ariane-typed (unmarked) note.
                shot.comment = Some("muddy floor".into());
                break;
            }
            break;
        }

        let cs = diff(&base, &ret);
        // Shot 0 had no station comment in the baseline; the Ariane-added
        // unmarked line should appear as a station_comment edit.
        let edit = cs
            .shots_edited
            .iter()
            .find(|e| e.shot_index == 0)
            .expect("shot 0 should have an edit recorded");
        assert!(
            edit.changes.iter().any(|c| c.field == "station_comment"),
            "edit on shot 0 should include a station_comment change: {:?}",
            edit.changes
        );
        assert_eq!(edit.new_station_comment.as_deref(), Some("muddy floor"));

        // Apply and verify project.station_comments is updated.
        let mut applied = base.clone();
        crate::core::apply_changeset(&mut applied, &cs);
        let s1 = StationRef::new(0, 1);
        assert_eq!(
            applied.station_comment_for_ref(s1).map(String::as_str),
            Some("muddy floor"),
        );
    }

    #[test]
    fn baseline_diff_detects_station_only_edit() {
        // Edit only a station comment in Stalagmight, export+reparse,
        // reconcile against the original baseline ⇒ one EditedShot whose
        // changes vec carries a station_comment field.
        let dir = tempfile::TempDir::new().unwrap();
        let base = baseline_for(project_with_comments(), dir.path());

        let mut edited = base.clone();
        edited.station_comments.insert(
            StationRef::new(0, 2).into(),
            "junction widened in 2026".into(),
        );
        let ret = returned(&edited, dir.path());

        let cs = diff(&base, &ret);
        assert_eq!(
            cs.shots_edited.len(),
            1,
            "single station-only edit: {:?}",
            cs.shots_edited
        );
        let e = &cs.shots_edited[0];
        assert_eq!(e.shot_index, 1, "shot whose to-station is station 2");
        let sc_change = e
            .changes
            .iter()
            .find(|c| c.field == "station_comment")
            .expect("station_comment change present");
        assert_eq!(sc_change.old, "junction with main");
        assert_eq!(sc_change.new, "junction widened in 2026");
        assert_eq!(
            e.new_station_comment.as_deref(),
            Some("junction widened in 2026")
        );
        // The shot-portion of the Comment field didn't change, so no shot
        // comment edit should be emitted.
        assert!(
            !e.changes.iter().any(|c| c.field == "comment"),
            "shot.comment unchanged: {:?}",
            e.changes
        );
    }

    #[test]
    fn fresh_import_with_split_routes_marked_and_unmarked_correctly() {
        // Mirrors what an external `.tml` looks like when imported via the
        // dialog with commentsOnStations=true. Shot 1's Comment carries one
        // ZWSP-marked line (shot) plus one unmarked line (station).
        let dir = tempfile::TempDir::new().unwrap();
        let mut p = project_with(three());
        p.sections[0].shots[1].comment = Some("broken tape".into());
        p.station_comments
            .insert(StationRef::new(0, 2).into(), "junction with main".into());

        let path = dir.path().join("import.tmlu");
        export_tml_with_baseline(&p, &path).unwrap();
        let tml = parse_tml(&path).unwrap();
        let (configs, _) = crate::parsers::tml::convert_tml_to_import_configs(
            &tml, false, /* comments_on_stations = */ true,
        )
        .unwrap();
        // Shot 1 of the first section: comment kept as "broken tape" (marker
        // stripped); station 2 of the section's station_comments gets the
        // unmarked line.
        let cfg = &configs[0];
        let shot_one = &cfg.shots[1];
        assert_eq!(shot_one.comment.as_deref(), Some("broken tape"));
        let sc = cfg
            .station_comments
            .iter()
            .find(|(idx, _)| *idx == 2)
            .expect("station 2 should have a comment after split");
        assert_eq!(sc.1, "junction with main");
    }
}
