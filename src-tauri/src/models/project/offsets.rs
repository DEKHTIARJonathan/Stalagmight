use chrono::Utc;
use std::collections::HashSet;
use tracing::error;

use crate::models::{SectionId, StationMerge};

use super::Project;

impl Project {
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
        group.iter().any(|sid| {
            self.zero_datums
                .iter()
                .any(|zd| zd.station_ref.section_id == *sid)
        })
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
                let a = self
                    .resolve_key(&merge.station_a)
                    .and_then(|s| self.compute_station_raw_coords(s));
                let b = self
                    .resolve_key(&merge.station_b)
                    .and_then(|s| self.compute_station_raw_coords(s));
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

    /// One authoritative anchor section per connected merge group, preferring a
    /// zero-datum section so the realign keeps the group pinned to GPS.
    fn realign_seeds(&self) -> Vec<SectionId> {
        let datum_sections: HashSet<SectionId> = self
            .zero_datums
            .iter()
            .map(|z| z.station_ref.section_id)
            .collect();
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
                let (Some(a), Some(b)) = (
                    self.resolve_key(&c.station_a),
                    self.resolve_key(&c.station_b),
                ) else {
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
