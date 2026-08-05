use chrono::Utc;
use std::collections::{HashMap, HashSet};
// `error!` is only reached inside the `#[cfg(debug_assertions)]` block in
// `debug_assert_merge_alignment`, so gate the import to match (else it's an
// unused import under `--release`).
#[cfg(debug_assertions)]
use tracing::error;

use crate::models::{SectionId, StationMerge};

use super::Project;

impl Project {
    /// Read a section's offset, defaulting to (0, 0).
    pub(crate) fn section_offset(&self, id: SectionId) -> (f64, f64) {
        self.section_offsets.get(&id).copied().unwrap_or((0.0, 0.0))
    }

    /// Write one section's offset, dropping the key when the value is exactly
    /// `(0, 0)`. THE write point for `section_offsets`: every write below goes
    /// through it, as do the two sites that cannot call a `&mut self` method
    /// because they hold a live borrow of `self.sections`
    /// (`Project::apply_station_move_internal`, `AppState::move_station`), and
    /// so does [`Self::write_adjusted_section_offset`], which layers the dust
    /// rule on top for values this app COMPUTED rather than restored.
    ///
    /// `section_offsets` means "sections that are actually displaced": every
    /// consumer reads it through [`Self::section_offset`] or an inline
    /// `.get(..).unwrap_or((0.0, 0.0))`, so a zero-valued entry and an absent
    /// one are the same geometry. They are NOT the same map, though -
    /// `HashMap::insert` is not undone by writing `0.0` back into it - so
    /// before this normalization existed, any adjust-and-adjust-back left the
    /// key behind and the next save serialized it into the `.stalx`
    /// (#413 finding 2: an insert plus its undo, a `MoveSection(+d)` plus its
    /// `-d`, a `ReverseSection` applied twice).
    ///
    /// EXACTLY zero here, with no tolerance: this is the writer a RESTORE uses,
    /// and a restore has to reproduce the value it was handed - rounding
    /// `2.22e-16` away on the way back in would make an undo differ from the
    /// state it is undoing. `-0.0 == 0.0` in IEEE, so a negated zero drops too;
    /// a non-finite value compares false and is left for `save_project`'s
    /// sanitize, which is where that case is handled. A value the app just
    /// COMPUTED by accumulating a delta has no such history to be faithful to,
    /// and goes through [`Self::write_adjusted_section_offset`] instead.
    ///
    /// Takes the map rather than `&mut self` so a caller holding a disjoint
    /// field borrow can still use it.
    pub(crate) fn write_section_offset(
        offsets: &mut HashMap<SectionId, (f64, f64)>,
        id: SectionId,
        value: (f64, f64),
    ) {
        if value.0 == 0.0 && value.1 == 0.0 {
            offsets.remove(&id);
        } else {
            offsets.insert(id, value);
        }
    }

    /// Write an offset that was COMPUTED by adding a delta to the current one:
    /// [`Self::write_section_offset`] plus the dust normalization
    /// ([`Project::OFFSET_DUST_M`]).
    ///
    /// The exact-zero drop above is not enough for an adjustment, because an
    /// adjustment is not exactly invertible: `(c + d) - d == c` holds only when
    /// `c` is 0. An adjust-and-adjust-back therefore lands a femtometre from
    /// where it started, and the two cases are NOT the same defect:
    ///
    /// * on a section that ALREADY carries an offset, the residue is a VALUE
    ///   difference and stays one. Every consumer reads the value, and a
    ///   femtometre is nothing to any of them (the snapshot differ's own
    ///   `TOLERANCE_ABS` is a nanometre). Nothing here touches that case.
    /// * on a section that carries NONE, the residue lands a femtometre from
    ///   exact zero, and the exact-zero rule KEEPS it - a `section_offsets` key
    ///   for a section that is not displaced (#413 finding 2's dust half: a
    ///   `ReverseSection` applied twice, an insert plus the remove that undoes
    ///   it, a cascade "correcting" its own noise). That difference is
    ///   STRUCTURAL, not numeric: the key outlives the state it came from, the
    ///   next save serializes it, and the route that did nothing has no such
    ///   key - so two routes to the same geometry stop comparing equal.
    ///
    /// So an ADJUSTED value within [`Project::OFFSET_DUST_M`] of the origin in
    /// both components is written as absent, not as dust. A picometre is not a
    /// position; see the constant for why that bound and not another.
    ///
    /// Deliberately NOT applied by `write_section_offset` itself: a RESTORE
    /// (undo, `restore_section_offsets`, a loaded file) must reproduce the map
    /// it was given, dust included, or an undo would stop being the exact
    /// inverse of the thing it undoes. Only a value this app just computed by
    /// accumulation is normalized.
    ///
    /// Takes the map, like `write_section_offset`, so the two sites that hold a
    /// live borrow of `self.sections` (`Project::apply_station_move_internal`,
    /// `AppState::move_station`) can normalize identically.
    pub(crate) fn write_adjusted_section_offset(
        offsets: &mut HashMap<SectionId, (f64, f64)>,
        id: SectionId,
        value: (f64, f64),
    ) {
        // `<=` on `abs()`, so a NaN component (which compares false against
        // everything) falls through to `write_section_offset` unchanged - the
        // non-finite case belongs to `save_project`'s sanitize, not here.
        let normalized =
            if value.0.abs() <= Self::OFFSET_DUST_M && value.1.abs() <= Self::OFFSET_DUST_M {
                (0.0, 0.0)
            } else {
                value
            };
        Self::write_section_offset(offsets, id, normalized);
    }

    /// Apply a delta to one section's offset. Low-level primitive -
    /// callers handle cascade and invariants.
    pub(crate) fn adjust_section_offset(&mut self, id: SectionId, dx: f64, dy: f64) {
        let current = self.section_offset(id);
        Self::write_adjusted_section_offset(
            &mut self.section_offsets,
            id,
            (current.0 + dx, current.1 + dy),
        );
    }

    /// Set an exact offset value (for undo restoration / initial placement).
    pub(crate) fn set_section_offset(&mut self, id: SectionId, offset: (f64, f64)) {
        Self::write_section_offset(&mut self.section_offsets, id, offset);
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
        // Delegate to the resolve-aware check so a DANGLING datum (anchor key no
        // longer resolves) is not counted as an anchor - otherwise a move-drag is
        // wrongly blocked on a phantom-anchored, actually-unanchored group (#174).
        // Same merge-group scope as before: `component_datum_refs` (which backs
        // `section_has_zero_datum`) uses the same `get_merged_section_ids`.
        self.section_has_zero_datum(id)
    }

    /// Assert that all merge points are colocated (within
    /// [`Project::MERGE_ALIGNMENT_INVARIANT_M`]).
    /// Only active in debug builds - no-op in release.
    /// Check that all merge points are colocated. Logs an error for any merge
    /// pair past the user-facing [`Project::MERGE_ALIGNMENT_TOLERANCE_M`]. In
    /// test builds, panics past the tighter invariant threshold to catch
    /// regressions with synthetic data - the SAME threshold
    /// [`Self::realign_merges`] heals at, so nothing this asserts on can be a
    /// state the self-heal declines to repair (#413 findings 14 and 20).
    pub(crate) fn debug_assert_merge_alignment(&self, context: &str) {
        // Despite the name, this used to run in release too - and the cost
        // is brutal: O(N) merges × 2 × O(N) `compute_station_raw_coords`
        // per call, called from every mutating command. For a 1 200-section
        // TML import this contributed ~1.5 billion operations to the hot
        // path. Gate the whole body behind `debug_assertions` so it
        // remains a sanity check during development without harming
        // production performance. The release-mode `error!` log it used
        // to emit was informational only - alignment drift inside a
        // *single* command is a programmer bug, not a data condition the
        // user can fix at runtime.
        #[cfg(debug_assertions)]
        {
            // During a deferred-cascade batch (e.g. a large import) connections
            // are created in dependency order, so intermediate states are
            // transiently misaligned BY DESIGN - and running this
            // O(merges × colocation-BFS) check after every command would make the
            // batch O(N³) (the import of a large Walls project pinned a core for
            // minutes in dev builds). Skip until the batch completes; the cascade
            // that runs when the guard is disarmed restores alignment.
            if self.cascade_deferred {
                return;
            }
            // Same tripwire idea one level down: a merge-adjacency memo that no
            // longer matches the merges is how a rewritten endpoint silently
            // fools the double-anchor guard.
            self.station_merges.debug_assert_memo_fresh(context);
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
                    if dist >= Self::MERGE_ALIGNMENT_TOLERANCE_M {
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
                            threshold = Self::MERGE_ALIGNMENT_TOLERANCE_M,
                        );
                    }
                    #[cfg(test)]
                    debug_assert!(
                        dist < Self::MERGE_ALIGNMENT_INVARIANT_M,
                        "Merge alignment violated after {context}: stations {a_ref:?} and {b_ref:?} \
                         are {dist:.6}m apart (threshold {threshold}m). \
                         A=({ax:.6}, {ay:.6}), B=({bx:.6}, {by:.6})",
                        threshold = Self::MERGE_ALIGNMENT_INVARIANT_M,
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
        self.rebuild_shot_uuid_index();
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
        // Zero-trust: never honor a persisted derivable offset - re-solve
        // unconditionally so a sub-tolerance stale offset can't survive the load.
        self.resolve_offsets()
    }

    /// Enforce the invariant that a loop closure exists only for a TRUE loop. If
    /// a closure's two endpoints are no longer connected through the survey
    /// (shots + merges) independently of the closure, the closure is the *sole*
    /// connection between them - that is a merge, not a loop - so convert it.
    ///
    /// Iterative: when two closures bridge the same pair, the first becomes the
    /// merge and the second is then a genuine (redundant) loop and is kept.
    /// Returns the number converted. (Issue #8 - a shot deletion can strand a
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
            // mode). Keep it a (soft) closure instead - a closure between two
            // anchored groups is legitimate - and let the over-anchoring detector
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
    /// beyond the REPORTING tolerance before the realign.
    ///
    /// This is the per-command self-heal (via `reconcile_geometry`): it keeps the
    /// fast no-drift early-return because the in-memory offsets it sees were just
    /// computed by the command/cascade, not read from an untrusted source, and an
    /// unconditional re-solve after every command would override the exact state
    /// an undo/redo snapshot just restored. The *load*/repair paths use
    /// [`Self::resolve_offsets`] instead, which never trusts a persisted value.
    ///
    /// The gate is [`Self::MERGE_ALIGNMENT_INVARIANT_M`], NOT the 5 cm reporting
    /// tolerance the return value counts against. Gating the repair on the
    /// reporting number left the entire 1-5 cm band unhealed - a state the app's
    /// own `debug_assert_merge_alignment` calls a violation and panics a test
    /// build on, silently saved to the `.stalx` in a release one (#413 finding
    /// 20: a shot edit in an unanchored merge group produced exactly that, and
    /// the drift equalled the edit). The heal gate must stay at or below the
    /// assert; it may never be loosened back onto the reporting threshold.
    pub fn realign_merges(&mut self) -> usize {
        if self
            .merge_alignment_beyond(Self::MERGE_ALIGNMENT_INVARIANT_M)
            .is_empty()
        {
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
        // moved anything - including SUB-tolerance changes the `before`/`after`
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
        // edited - a later no-edit save would then persist a bogus timestamp, and
        // it would make a no-op integrity Repair look like a real change.
        if self.section_offsets != offsets_before {
            self.touch();
        }
        before.saturating_sub(self.check_merge_alignment().len())
    }
}
