use std::collections::{HashMap, HashSet};
use tracing::{debug, error, trace, warn};

use crate::config::ClosureAdjustmentConfig;
use crate::models::{ClosureStrategy, Coordinates, LoopClosure, SectionId, Shot, StationRef};

use super::{PathEdge, Project, SegmentShot, StationPath};

impl Project {
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

    pub(super) fn shot_vector_along(shot: &Shot, forward: bool) -> Coordinates {
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
    pub(super) fn update_shot_horizontal_only(shot: &mut Shot, dx: f64, dy: f64) {
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
}
