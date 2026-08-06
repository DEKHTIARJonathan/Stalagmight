use chrono::Utc;
use std::collections::hash_map::DefaultHasher;
use std::collections::{HashMap, HashSet};
use std::hash::{Hash, Hasher};
// `error!` is only reached inside the `#[cfg(debug_assertions)]` block in
// `debug_assert_merge_alignment`, so gate the import to match (else it's an
// unused import under `--release`).
#[cfg(debug_assertions)]
use tracing::error;

use crate::models::{LoopClosure, SectionId, StationMerge};

use super::Project;

/// One beyond-invariant merge, as the fixpoint fingerprint records it: the two
/// endpoints as they currently resolve, and the EXACT gap between them.
///
/// The gap is kept as raw bits rather than as an `f64` so the fingerprint can be
/// compared for equality without a float comparison, and so that a gap differing
/// by a single ULP - the smallest change any edit can make to it - misses.
type ResidualGap = ((SectionId, u32), (SectionId, u32), u64);

/// A merge residual the offset solver has already run on and failed to reduce -
/// see [`Project::realign_merges`], which is the only producer and consumer.
///
/// Two parts, because two different things can turn an irreducible residual into
/// a reducible one:
///
/// * `structure` hashes every input to solvability that is NOT geometry - the
///   section set, the merge edges, the closure edges (id, endpoints, aligned
///   flag, strategy) and the zero-datum anchors. Dropping one of two datums from
///   an over-anchored component makes the gap healable without moving a single
///   station, so a fingerprint blind to structure would keep skipping the heal
///   that has just become possible;
/// * `residual` is the beyond-invariant merge set itself. Every geometry edit
///   that changes what the solve would produce for these merges changes one of
///   these gaps, so geometry needs no hook of its own.
///
/// The structure hash is `SipHash` via `DefaultHasher` - stable within a process,
/// which is all that is required of a field that is never persisted and never
/// compared across runs.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct RealignFixpoint {
    structure: u64,
    residual: Vec<ResidualGap>,
}

impl Project {
    /// Read a section's offset, defaulting to (0, 0).
    pub(crate) fn section_offset(&self, id: SectionId) -> (f64, f64) {
        self.section_offsets.get(&id).copied().unwrap_or((0.0, 0.0))
    }

    /// # THE `section_offsets` INVARIANT
    ///
    /// **A dust-zero entry does not exist.** `section_offsets` holds a key only
    /// for a section that is ACTUALLY DISPLACED, and "not displaced" has exactly
    /// one spelling: the key is absent. A value within [`Project::OFFSET_DUST_M`]
    /// of the origin in both components is not a position, so it is not written -
    /// it is removed. That holds for every writer, computed or restored, in memory
    /// and on disk, with no exceptions:
    ///
    /// * this function is THE write point, and everything routes through it -
    ///   [`Self::adjust_section_offset`], [`Self::set_section_offset`],
    ///   [`Self::restore_section_offsets`], the offset solver, the closure solve,
    ///   the move tools, the undo restore arms, and the two sites that cannot call
    ///   a `&mut self` method because they hold a live borrow of `self.sections`
    ///   (`Project::apply_station_move_internal`, `AppState::move_station`);
    /// * [`Self::normalize_section_offsets`] enforces it on a map this app did not
    ///   write - a `.stalx` from a build that predates the invariant, and the
    ///   snapshot payload of an undo entry persisted by one.
    ///
    /// ## Why it has to be an invariant and not a per-writer rule
    ///
    /// Because no write-local rule can satisfy both of the identities the app
    /// owes. `MoveSection(+d)` followed by `MoveSection(-d)` must leave the map it
    /// found, and a writer that sees only its own arguments cannot tell the two
    /// starting points apart:
    ///
    /// * from an ABSENT key, `(0 + d) - d` lands a femtometre off zero and the
    ///   key must end ABSENT - the route that did nothing has none either
    ///   (#413 finding 2's dust half: a `ReverseSection` applied twice, an insert
    ///   plus the remove that undoes it, a cascade "correcting" its own noise);
    /// * from a PRESENT all-zero key, the same arithmetic must end PRESENT.
    ///
    /// The two demands are contradictory, and both were real: the second is the
    /// defect the metamorphic pair `move-out-and-back-is-identity` reported once
    /// a project carrying a legacy all-zero row was fed to it. Making the state
    /// UNREPRESENTABLE dissolves the contradiction - there is no present all-zero
    /// key to preserve, so the first rule is the only one left. The undo/redo
    /// exactness that #413 finding 27 was about follows for free: presence cannot
    /// differ between two states that agree geometrically.
    ///
    /// ## Notes on the comparison
    ///
    /// `<=` on `abs()`, so a NaN component (which compares false against
    /// everything) is INSERTED rather than dropped: the non-finite case belongs to
    /// `save_project`'s sanitize and the load boundary, not here. `-0.0 == 0.0` in
    /// IEEE, so a negated zero drops too.
    ///
    /// Takes the map rather than `&mut self` so a caller holding a disjoint field
    /// borrow can still use it.
    pub(crate) fn write_section_offset(
        offsets: &mut HashMap<SectionId, (f64, f64)>,
        id: SectionId,
        value: (f64, f64),
    ) {
        if value.0.abs() <= Self::OFFSET_DUST_M && value.1.abs() <= Self::OFFSET_DUST_M {
            offsets.remove(&id);
        } else {
            offsets.insert(id, value);
        }
    }

    /// Drop every `section_offsets` entry that violates the invariant on
    /// [`Self::write_section_offset`], and report how many went.
    ///
    /// For a map this app did not write through that function: a `.stalx` from a
    /// build that predates the invariant (the load path inserts whatever rows the
    /// file holds), and the snapshot payload of an undo entry persisted by one.
    /// Both are legacy debris - a key for a section that is not displaced - and
    /// the app is free to drop it: every consumer reads the map through
    /// [`Self::section_offset`] or an inline `.get(..).unwrap_or((0.0, 0.0))`, so
    /// dropping changes no geometry, no coordinate and no rendered position. What
    /// it changes is that the two spellings of "not displaced" stop coexisting.
    pub(crate) fn normalize_section_offsets(&mut self) -> usize {
        let before = self.section_offsets.len();
        self.section_offsets.retain(|_, value| {
            !(value.0.abs() <= Self::OFFSET_DUST_M && value.1.abs() <= Self::OFFSET_DUST_M)
        });
        before - self.section_offsets.len()
    }

    /// Apply a delta to one section's offset. Low-level primitive -
    /// callers handle cascade and invariants.
    pub(crate) fn adjust_section_offset(&mut self, id: SectionId, dx: f64, dy: f64) {
        let current = self.section_offset(id);
        Self::write_section_offset(
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
        let healed = self.resolve_offsets();
        // The same doctrine, one step further: a persisted DUST-ZERO row is not a
        // derivable offset the re-solve rewrites - the cascade never seed-adjusts
        // an anchor or a free-floating component, so such a row survives it
        // untouched - and it is a state the app may not hold (see the invariant on
        // `write_section_offset`). A `.stalx` from a build that predates the
        // invariant therefore stops carrying one HERE, at the boundary, rather
        // than being carried into memory for every downstream rule to special-case.
        // Nothing observable changes: an absent key and an all-zero one are the
        // same geometry to every consumer. The file settles on the next save.
        let dropped = self.normalize_section_offsets();
        if dropped > 0 {
            tracing::info!(
                dropped,
                purpose = "hold the section_offsets invariant at the load boundary",
                "Dropped persisted section offsets that were within dust of the origin"
            );
        }
        healed
    }

    /// The orphanhood question [`Self::convert_orphan_closures_to_merges`] asks of
    /// one closure: are its two endpoints still connected through the survey
    /// (shots + merges) independently of the closure itself? If not, the closure
    /// is their *sole* bridge - a merge, not a loop.
    ///
    /// A same-section closure is never an orphan (the section itself connects the
    /// endpoints), and neither is one whose endpoint no longer resolves (there is
    /// nothing to ask the connectivity walk about; a dangling ref is integrity's
    /// problem, not this one).
    ///
    /// The single definition of the predicate: the sweep below scans with it, and
    /// [`Self::orphan_closure_ids`] snapshots with it, so a mutation path's
    /// before-set and the sweep that follows can never disagree about what an
    /// orphan is.
    fn is_orphan_closure(&self, closure: &LoopClosure) -> bool {
        if closure.station_a.section_id == closure.station_b.section_id {
            return false;
        }
        let (Some(a), Some(b)) = (
            self.resolve_key(&closure.station_a),
            self.resolve_key(&closure.station_b),
        ) else {
            return false;
        };
        !self.are_stations_connected_excluding_shot(a, b, None, false)
    }

    /// The ids of every closure that is orphaned RIGHT NOW. A mutation path takes
    /// this before it mutates and hands it to
    /// [`Self::convert_closures_orphaned_since`] afterwards; see that function for
    /// why an inverse needs the distinction.
    pub(crate) fn orphan_closure_ids(&self) -> HashSet<u64> {
        self.loop_closures
            .iter()
            .filter(|c| self.is_orphan_closure(c))
            .map(|c| c.id)
            .collect()
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
    ///
    /// Whole-project sweep: every orphan it finds is converted, no matter what
    /// made it one. That is right for a load, a Repair and a forward command -
    /// and wrong inside an inverse, which is what
    /// [`Self::convert_closures_orphaned_since`] exists for.
    pub fn convert_orphan_closures_to_merges(&mut self) -> usize {
        self.convert_closures_orphaned_since(&HashSet::new())
    }

    /// [`Self::convert_orphan_closures_to_merges`] restricted to the orphans a
    /// mutation JUST created: `preexisting` is the [`Self::orphan_closure_ids`]
    /// snapshot the caller took before mutating, and every id in it is left as a
    /// closure.
    ///
    /// An inverse must not do more than invert (#413, the orphan-closure
    /// observation in `fuzz_undo_tests.rs`'s header). A
    /// closure can be orphaned by a command whose own path never converts it -
    /// `removeZeroDatum` un-anchors one side, and the sweep's double-anchor guard
    /// stops refusing it - and that un-converted closure is part of the state the
    /// history RECORDED. Sweeping the whole project from inside an undo would
    /// convert it as a side effect of removing an unrelated shot, landing on a
    /// state no snapshot ever held. Scoping by *what this mutation orphaned*
    /// keeps the pre-existing orphan exactly as recorded while still converting
    /// the closures the removal genuinely stranded - including ones nowhere near
    /// the removed station, whose loop-ness hung off a merge that was.
    pub(crate) fn convert_closures_orphaned_since(&mut self, preexisting: &HashSet<u64>) -> usize {
        let mut converted = 0;
        // Sole-bridge closures left UNCONVERTED because turning them into a rigid
        // merge would fuse two independently zero-datum-anchored groups. Tracked by
        // id so the orphan scan below does not reconsider them on every iteration
        // (which would loop forever, since they are never removed).
        let mut left_as_closure: HashSet<u64> = HashSet::new();
        loop {
            let orphan = self.loop_closures.iter().position(|c| {
                if left_as_closure.contains(&c.id) || preexisting.contains(&c.id) {
                    return false;
                }
                self.is_orphan_closure(c)
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

    /// Every merge whose endpoints are at least [`Self::MERGE_ALIGNMENT_INVARIANT_M`]
    /// apart, with the exact gap. The geometry is [`Self::merge_alignment_beyond`]'s
    /// (same precompute, same skips: a same-section merge is meaningless, a
    /// dangling endpoint is a structural problem and not a gap) - what differs is
    /// what comes out. That one reports to a human and rounds to centimetres; this
    /// one is compared for identity, so it keeps the bits.
    ///
    /// Ordered by `station_merges`, whose order the structure hash pins, so two
    /// calls on one state produce identical vectors.
    fn residual_merge_gaps(&self) -> Vec<ResidualGap> {
        let local = self.section_local_coords();
        let station_offsets = self.resolved_station_offsets();
        let mut residual = Vec::new();
        for merge in &self.station_merges {
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
                let gap = ((ax - bx).powi(2) + (ay - by).powi(2)).sqrt();
                if gap >= Self::MERGE_ALIGNMENT_INVARIANT_M {
                    residual.push((
                        (a.section_id, a.station_index),
                        (b.section_id, b.station_index),
                        gap.to_bits(),
                    ));
                }
            }
        }
        residual
    }

    /// Hash of everything the offset solve depends on that is NOT geometry: which
    /// sections exist and how many shots each holds, the merge edges, the closure
    /// edges, and the datum anchors. The [`RealignFixpoint`] carries it so that a
    /// structural edit which changes what the solver CAN do - a merge or closure
    /// added or removed, a closure converted, a datum added, moved or dropped, a
    /// section gone - invalidates a recorded fixpoint even though it moves nothing
    /// and leaves every gap bit-identical.
    ///
    /// This is a whole-project scan rather than a set of invalidation hooks on the
    /// mutators on purpose. Those collections are mutated from many places
    /// (including the undo restore arms, which assign whole vectors), and a hook
    /// set that is one call site short does not degrade - it silently skips a heal
    /// that had become possible. Deriving the answer from the state cannot be one
    /// call site short. The scan is `O(sections + merges + closures + datums)` and
    /// runs only when a beyond-invariant residual already exists, next to a
    /// `merge_alignment_beyond` pass that is `O(total shots)` and a re-solve that
    /// is more expensive still.
    fn realign_structure_hash(&self) -> u64 {
        let mut hasher = DefaultHasher::new();
        self.sections.len().hash(&mut hasher);
        for section in &self.sections {
            section.id.hash(&mut hasher);
            section.shots.len().hash(&mut hasher);
        }
        self.station_merges.len().hash(&mut hasher);
        for merge in &self.station_merges {
            merge.station_a.hash(&mut hasher);
            merge.station_b.hash(&mut hasher);
        }
        self.loop_closures.len().hash(&mut hasher);
        for closure in &self.loop_closures {
            closure.id.hash(&mut hasher);
            closure.station_a.hash(&mut hasher);
            closure.station_b.hash(&mut hasher);
            closure.is_aligned.hash(&mut hasher);
            std::mem::discriminant(&closure.strategy).hash(&mut hasher);
        }
        self.zero_datums.len().hash(&mut hasher);
        for datum in &self.zero_datums {
            datum.station_ref.hash(&mut hasher);
        }
        hasher.finish()
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
    ///
    /// ## The fixpoint skip
    ///
    /// Not every beyond-invariant gap is healable. An over-anchored component
    /// (two zero datums in one rigid merge group) and a cyclic merge misclosure
    /// both leave a residual the cascade cannot reduce: the solve runs, changes
    /// nothing, and the gate is non-empty again on the next command - so this
    /// function used to re-solve the WHOLE project after every keystroke-scale
    /// edit, forever, and each of those re-solves also overrode the exact offsets
    /// an undo/redo snapshot had just restored (the thing the drift gate exists
    /// to avoid). When a solve leaves the residual and the offsets untouched, the
    /// state is a solver fixpoint and is recorded as a [`RealignFixpoint`]; while
    /// the live state still fingerprints identically, the re-solve is skipped.
    ///
    /// The invariant is not weakened by that, because the skip is not a decision
    /// about the gap - it is a decision about the SOLVER. It fires only for a
    /// residual this same code path has already run the full solve on and watched
    /// it fail to move, and only while both halves of the fingerprint still
    /// match: every geometry edit that could change the outcome changes a gap,
    /// and every structural edit that could change it (merge, closure, datum or
    /// section added, removed or converted) changes the structure hash. Anything
    /// the solve could have healed therefore misses the fingerprint and gets the
    /// solve. What the skip removes is strictly the repetition of a proven no-op.
    pub fn realign_merges(&mut self) -> usize {
        let residual = self.residual_merge_gaps();
        if residual.is_empty() {
            return 0;
        }
        let fingerprint = RealignFixpoint {
            structure: self.realign_structure_hash(),
            residual,
        };
        if self.realign_fixpoint.as_ref() == Some(&fingerprint) {
            // Observationally identical to running the solve: a recorded fixpoint
            // is a state the cascade left byte-for-byte alone, so `resolve_offsets`
            // would have counted the same misalignments before and after and
            // returned the same 0 healed merges the early-return above does.
            return 0;
        }
        let (healed, changed) = self.resolve_offsets_tracked();
        self.realign_fixpoint = if changed {
            // The solve moved something, so it is not (yet) a fixpoint - and the
            // residual it was fingerprinted from is stale. A later call re-derives.
            None
        } else {
            // Nothing moved: `resolve_offsets` only ever writes `section_offsets`,
            // so with those identical the residual and the structure are identical
            // too, and `fingerprint` IS the post-solve fingerprint.
            Some(fingerprint)
        };
        healed
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
        self.resolve_offsets_tracked().0
    }

    /// [`Self::resolve_offsets`], also reporting whether the re-solve MOVED an
    /// offset. That flag is what lets [`Self::realign_merges`] tell a solve which
    /// healed something from one which provably cannot: the healed COUNT cannot,
    /// being blind to every sub-reporting-tolerance change - which is the whole
    /// reason this function re-cascades unconditionally.
    fn resolve_offsets_tracked(&mut self) -> (usize, bool) {
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
        let changed = self.section_offsets != offsets_before;
        if changed {
            self.touch();
        }
        (
            before.saturating_sub(self.check_merge_alignment().len()),
            changed,
        )
    }
}
