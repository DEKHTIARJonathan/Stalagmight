use std::collections::{HashMap, HashSet, VecDeque};

use crate::config::ClosureAdjustmentConfig;
use crate::models::{Coordinates, LoopClosure, SectionId, StationRef};

use super::Project;

impl Project {
    /// Solve the two SPD weighted-Laplacian systems `A·x = atb_x` and
    /// `A·y = atb_y` the closure adjustment assembles. Both systems share the
    /// same sparsity (`adj`) but use different per-axis weights.
    ///
    /// A cave survey graph is almost a tree: long degree-2 passages and degree-1
    /// spurs with only a handful of independent loops (≈ one per eligible
    /// closure). We exploit that with **exact** Gaussian elimination of every
    /// node whose current off-diagonal degree is ≤ 2 - degree-1 is leaf
    /// back-substitution, degree-2 is series reduction (fill between the two
    /// neighbours). Both axes are carried in lockstep since the structure is
    /// shared; SPD guarantees positive pivots throughout. Peeling collapses the
    /// tree and chains in O(n); what survives is the 2-core (≈ the cycle space),
    /// solved with Jacobi-PCG (tiny, so effectively exact and instant). Peeled
    /// nodes are then recovered by back-substitution in reverse order.
    ///
    /// `adj[i]` holds symmetric off-diagonal entries `(j, off_x, off_y)` (the
    /// negative edge weights). Returns `(sol_x, sol_y)`, each length `n`.
    pub(super) fn solve_reduced_laplacian(
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
        // the node sits in the system's null space - a floating axis. Such a pivot
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
            order.push(Elim {
                u,
                nbrs: nbrs.clone(),
                dxu: pdx,
                dyu: pdy,
                cxu: pcx,
                cyu: pcy,
            });

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
    /// moves a null-space direction, so it stays at `x0` - preserving the measured
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
        let mut z: Vec<f64> = r
            .iter()
            .zip(inv_diag.iter())
            .map(|(&ri, &mi)| ri * mi)
            .collect();
        let mut p = z.clone();
        let mut rz: f64 = r.iter().zip(z.iter()).map(|(&ri, &zi)| ri * zi).sum();

        // Converge relative to the *initial residual* ‖b - A·x0‖, not ‖b‖. With a
        // warm start that is the correct reference: return x0 only when it already
        // satisfies the system (residual ~0 - which includes pure null-space
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

    pub(super) fn adjust_least_squares(
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
        // datum/anchor) - extremely sparse (≤3 non-zeros per row). We store
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

                let sigma_dx =
                    ((az.sin() * sigma_len).powi(2) + (len * az.cos() * sigma_az).powi(2)).sqrt();
                let sigma_dy =
                    ((az.cos() * sigma_len).powi(2) + (len * az.sin() * sigma_az).powi(2)).sqrt();

                let w_x = if sigma_dx > 0.0 {
                    1.0 / (sigma_dx * sigma_dx)
                } else {
                    0.0
                };
                let w_y = if sigma_dy > 0.0 {
                    1.0 / (sigma_dy * sigma_dy)
                } else {
                    0.0
                };

                let i_idx = unknown_index.get(&root_i).copied();
                let j_idx = unknown_index.get(&root_j).copied();

                let b_x = match (i_idx, j_idx) {
                    (Some(_), Some(_)) => vec.x,
                    (Some(_), None) => {
                        let xj = fixed_coords
                            .get(&root_j)
                            .copied()
                            .unwrap_or_else(|| Coordinates::new(0.0, 0.0, 0.0));
                        vec.x - xj.x
                    }
                    (None, Some(_)) => {
                        let xi = fixed_coords
                            .get(&root_i)
                            .copied()
                            .unwrap_or_else(|| Coordinates::new(0.0, 0.0, 0.0));
                        vec.x + xi.x
                    }
                    (None, None) => 0.0,
                };
                let b_y = match (i_idx, j_idx) {
                    (Some(_), Some(_)) => vec.y,
                    (Some(_), None) => {
                        let yj = fixed_coords
                            .get(&root_j)
                            .copied()
                            .unwrap_or_else(|| Coordinates::new(0.0, 0.0, 0.0));
                        vec.y - yj.y
                    }
                    (None, Some(_)) => {
                        let yi = fixed_coords
                            .get(&root_i)
                            .copied()
                            .unwrap_or_else(|| Coordinates::new(0.0, 0.0, 0.0));
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
        // former full-system PCG, which took O(loop-diameter) iterations - i.e.
        // O(n) iterations on a single long loop, making the solve O(n²) (#81).
        // See `solve_reduced_laplacian`.
        let (sol_x, sol_y) =
            Self::solve_reduced_laplacian(n, &diag_x, &diag_y, &atb_x, &atb_y, &adj, &x0_x, &x0_y);

        // Optimality guard (tests only): the closure adjustment is the minimizer of
        // the weighted misclosure, i.e. the solution of the SPD normal equations
        // `A·x = atb`. Verify that directly on the *real* assembled system by
        // checking the residual `‖A·x - atb‖∞ ≈ 0` for both axes. This runs for
        // every test that exercises the solve (analytic, realistic, fuzz), so it
        // proves the result is the true optimum - not merely that "the loop closed".
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
                "closure solve is not at the LSQ optimum: ‖A·x-b‖∞ = ({rx:.3e}, {ry:.3e})"
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
                group_coords.insert(*root, Coordinates::new(sol_x[*idx], sol_y[*idx], raw_z));
            }
        }

        let station_offsets = self.resolved_station_offsets();

        // Identify spur stations (not on any cycle) by iterative leaf pruning.
        // Spur shots have no redundancy - there's nothing to adjust them against -
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

            // Fixed stations must not be pruned - they anchor the network
            // even if they sit at a graph leaf.  The anchor station is only
            // fixed when no zero datums exist (mirrors the solver logic).
            let mut pinned: HashSet<StationRef> = zero_datum_set.clone();
            if pinned.is_empty() {
                pinned.insert(anchor_station);
            }

            let mut degree: HashMap<StationRef, usize> =
                adj_deg.iter().map(|(s, nbrs)| (*s, nbrs.len())).collect();

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
        for section in self
            .sections
            .iter_mut()
            .filter(|s| component.contains(&s.id))
        {
            for idx in 0..section.shots.len() {
                let station_i = StationRef::new(section.id, idx as u32);
                let station_j = StationRef::new(section.id, (idx + 1) as u32);

                // Skip spur shots - they have no loop redundancy and must
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

                // Skip shots within the same constraint group - both endpoints
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

                let offset_i = station_offsets
                    .get(&station_i)
                    .copied()
                    .unwrap_or((0.0, 0.0, 0.0));
                let offset_j = station_offsets
                    .get(&station_j)
                    .copied()
                    .unwrap_or((0.0, 0.0, 0.0));

                let base_i = Coordinates::new(
                    coords_i.x - offset_i.0,
                    coords_i.y - offset_i.1,
                    coords_i.z - offset_i.2,
                );
                let base_j = Coordinates::new(
                    coords_j.x - offset_j.0,
                    coords_j.y - offset_j.1,
                    coords_j.z - offset_j.2,
                );

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
                // Skip spur stations - their shots were not updated, so their
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
                        return Err(
                            "Least squares adjustment produced inconsistent section translation"
                                .to_string(),
                        );
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
}
