use std::collections::{HashMap, HashSet, VecDeque};

use crate::models::{SectionId, StationRef};

use super::Project;

impl Project {
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
                        && !connected.contains(&merge.station_a.section_id)
                    {
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
                        && !connected.contains(&closure.station_a.section_id)
                    {
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
                        && !connected.contains(&merge.station_a.section_id)
                    {
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
                        && !connected.contains(&closure.station_a.section_id)
                    {
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
            if let (Some(a), Some(b)) = (
                self.resolve_key(&m.station_a),
                self.resolve_key(&m.station_b),
            ) {
                push_edge(&mut merge_adj, a, b);
            }
        }
        let mut closure_adj: HashMap<SectionId, Vec<(StationRef, StationRef)>> = HashMap::new();
        for c in &self.loop_closures {
            if c.is_aligned {
                if let (Some(a), Some(b)) = (
                    self.resolve_key(&c.station_a),
                    self.resolve_key(&c.station_b),
                ) {
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
            // Skip dangling datums (anchor key no longer resolves) — they are not
            // real anchors, mirroring `section_has_zero_datum`/`component_datum_refs`
            // (#174). Otherwise an unanchored section gets frozen as authoritative.
            if self.resolve_key(&zd.station_ref).is_some() {
                authoritative.insert(zd.station_ref.section_id);
            }
        }

        let sorted = |auth: &HashSet<SectionId>| {
            let mut v: Vec<SectionId> = auth.iter().copied().collect();
            v.sort_unstable();
            v
        };

        // Phase 1: BFS over merges only, to full reachability.
        let seed1 = sorted(&authoritative);
        self.cascade_bfs(
            &merge_adj,
            &local,
            &station_offsets,
            &mut authoritative,
            &seed1,
        );

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
            self.cascade_bfs(
                &combined,
                &local,
                &station_offsets,
                &mut authoritative,
                &seed2,
            );
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
    pub(super) fn cascade_bfs(
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
    pub(crate) fn has_datum_path_excluding(&self, start: SectionId, excluded: SectionId) -> bool {
        let mut visited = HashSet::new();
        let mut queue = vec![start];
        while let Some(current) = queue.pop() {
            if current == excluded {
                continue;
            }
            if !visited.insert(current) {
                continue;
            }
            if self.zero_datums.iter().any(|zd| {
                // A dangling datum (key no longer resolves) does not anchor (#174).
                zd.station_ref.section_id == current && self.resolve_key(&zd.station_ref).is_some()
            }) {
                return true;
            }
            for m in &self.station_merges {
                if m.station_a.section_id == current && !visited.contains(&m.station_b.section_id) {
                    queue.push(m.station_b.section_id);
                }
                if m.station_b.section_id == current && !visited.contains(&m.station_a.section_id) {
                    queue.push(m.station_a.section_id);
                }
            }
            for c in &self.loop_closures {
                if !c.is_aligned {
                    continue;
                }
                if c.station_a.section_id == current && !visited.contains(&c.station_b.section_id) {
                    queue.push(c.station_b.section_id);
                }
                if c.station_b.section_id == current && !visited.contains(&c.station_a.section_id) {
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
                        && !connected.contains(&merge.station_a.section_id)
                    {
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
    pub(super) fn section_has_zero_datum(&self, section_id: SectionId) -> bool {
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
}
