use std::collections::{HashMap, HashSet, VecDeque};
use tracing::warn;

use crate::config::ClosureAdjustmentConfig;
use crate::models::{ClosureRef, ClosureStrategy, Coordinates, SectionId, Station, StationRef};

use super::Project;

impl Project {
    /// Get all stations colocated with the given station (via merges and aligned closures).
    ///
    /// Returns a vec including the station itself plus all merge/closure partners,
    /// transitively connected.
    fn get_colocated_stations(&self, station_ref: StationRef) -> Vec<StationRef> {
        // Colocation adjacency = merges + ALIGNED closures, every endpoint
        // resolved once (O(edges)). BFS over it is O(edges + group) instead of
        // rescanning all merges/closures at each BFS node — the latter made
        // coordinate/closure work on a large merged component O(group × edges).
        let mut adjacency = self.build_station_merge_adjacency();
        for closure in &self.loop_closures {
            if !closure.is_aligned {
                continue;
            }
            if let (Some(sa), Some(sb)) = (
                self.resolve_key(&closure.station_a),
                self.resolve_key(&closure.station_b),
            ) {
                adjacency.entry(sa).or_default().push(sb);
                adjacency.entry(sb).or_default().push(sa);
            }
        }

        let mut group = vec![station_ref];
        let mut visited = HashSet::new();
        visited.insert(station_ref);
        let mut queue = VecDeque::new();
        queue.push_back(station_ref);

        while let Some(current) = queue.pop_front() {
            let Some(neighbors) = adjacency.get(&current) else {
                continue;
            };
            for &p in neighbors {
                if visited.insert(p) {
                    group.push(p);
                    queue.push_back(p);
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

    /// World `(x, y)` of a single station via the shot-walk only — the same x/y
    /// [`Self::compute_station_raw_coords`] returns, but WITHOUT the
    /// `get_colocated_stations` colocation BFS that computes Z. For callers that
    /// only need the horizontal position (e.g. merge offset alignment), this
    /// avoids an O(group × merges) traversal per call — the dominant cost when
    /// merging the thousands of stations of a large import.
    pub(crate) fn compute_station_raw_xy(&self, station_ref: StationRef) -> Option<(f64, f64)> {
        let section = self.get_section(station_ref.section_id)?;
        let (offset_x, offset_y) = self
            .section_offsets
            .get(&section.id)
            .copied()
            .unwrap_or((0.0, 0.0));
        let (mut x, mut y) = (offset_x, offset_y);
        for i in 0..station_ref.station_index as usize {
            let shot = section.shots.get(i)?;
            let azimuth_rad = shot.average_azimuth().to_radians();
            let horizontal = shot.horizontal_length();
            x += horizontal * azimuth_rad.sin();
            y += horizontal * azimuth_rad.cos();
        }
        if let Some((ox, oy, _)) = self.station_offset_for_ref(station_ref) {
            x += ox;
            y += oy;
        }
        Some((x, y))
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
    pub(super) fn compute_component_raw_coords(
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
}
