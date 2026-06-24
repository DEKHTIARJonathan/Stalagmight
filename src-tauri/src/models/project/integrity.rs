use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};

use crate::models::{SectionId, StationAnchor, StationKey};

use super::Project;

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
}
