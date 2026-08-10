//! Turning one declared TML section's shot graph into linear runs.
//!
//! An Ariane `<Section>` is a NAME on a set of shots, not a shape: the shots
//! under one name form an arbitrary directed graph, with junctions and with
//! parents that live under a different name entirely. A `models::Section`, by
//! contrast, is a strictly linear polyline - `Section::shots` is consumed
//! positionally and every cross-reference into it is a single `station_index`
//! - so this module has to cut the graph into linear runs, and the count of
//! those runs is what the import wizard shows as fragments (#412).
//!
//! At a junction only ONE successor can continue the run; the rest are
//! deferred into runs of their own. `choose_continuation` decides which,
//! so that the run that continues is the mainline rather than whichever
//! successor happened to be written first.

use std::collections::HashMap;

use super::{RawShot, TmlSection, TmlShot, TmlShotType};

/// Append every chain that begins exactly where another chain ends (#412).
///
/// `linearize_section` cuts one chain per (declared section name, linear run),
/// so a passage that carries on under a NEW name arrives as a separate chain
/// whose first shot's parent is the LAST shot of the previous chain. That join
/// is contiguous - the child's station 0 IS the parent's final station - so one
/// linear run holds both, and a `models::Section` polyline can express it
/// losslessly. Every other adjacency in the file attaches MID-chain, where a
/// polyline has nowhere to put it; see the module docs.
///
/// Trip metadata follows the rule the chain builder already applies: a run's
/// surveyor, date and colour are its FIRST shot's (see `linearize_section`), so
/// the parent's survive.
///
/// The absorbed chain's NAME does not just vanish, because every join here is
/// necessarily cross-name: a chain that continues under the SAME declared
/// section is never a candidate (it would have to attach at a chain end, and
/// the continuation walk always leaves its junction shot mid-chain). Two
/// sections a surveyor named separately would otherwise silently become one, so
/// the merged run is named `"A + B"` - capped by `MAX_JOINED_NAMES`, after
/// which it counts the rest.
///
/// Deterministic: parents are visited in ascending index order, and where two
/// chains start at the same end shot the LONGER one is appended (ties by lowest
/// index), so the same file always yields the same runs.
///
/// Returns the number of joins performed.
pub(super) fn join_contiguous_chains(sections: &mut Vec<TmlSection>) -> usize {
    if sections.len() < 2 {
        return 0;
    }
    /// How many declared names a merged run spells out before it starts
    /// counting. A run of eight joined names is not a label a person can read
    /// in the wizard's fragment list.
    const MAX_JOINED_NAMES: usize = 3;

    fn joined_name(names: &[String]) -> String {
        match names.len() {
            0 => String::new(),
            1 => names[0].clone(),
            n if n <= MAX_JOINED_NAMES => names.join(" + "),
            n => format!(
                "{} + {} more",
                names[..MAX_JOINED_NAMES].join(" + "),
                n - MAX_JOINED_NAMES
            ),
        }
    }

    // A CLOSURE shot is a loop marker that `convert_shots_to_shot_data` filters
    // out of the import, so it contributes no station. Joining THROUGH one would
    // silently land the child's first station on the previous real shot's end -
    // a different physical point. Structural, and independent of the
    // excluded-shots toggle, so section splitting stays toggle-invariant.
    let joinable_end = |s: &TmlSection| {
        s.shots
            .last()
            .is_some_and(|shot| shot.shot_type != TmlShotType::Closure)
    };
    let joinable_start = |s: &TmlSection| {
        s.shots
            .first()
            .is_some_and(|shot| shot.shot_type != TmlShotType::Closure)
    };

    // Which chain ends at a given shot id. A shot belongs to exactly one chain,
    // so it ends at most one.
    let mut ends_at: HashMap<i64, usize> = HashMap::new();
    for (idx, section) in sections.iter().enumerate() {
        if !joinable_end(section) {
            continue;
        }
        if let Some(last) = section.shots.last() {
            ends_at.insert(last.id, idx);
        }
    }

    // Group the chains that could extend each parent. A chain has ONE
    // start_ariane_id, so it can appear under at most one parent.
    let mut candidates: HashMap<usize, Vec<usize>> = HashMap::new();
    for (idx, section) in sections.iter().enumerate() {
        if !joinable_start(section) {
            continue;
        }
        if let Some(&parent) = ends_at.get(&section.start_ariane_id) {
            if parent != idx {
                candidates.entry(parent).or_default().push(idx);
            }
        }
    }

    // At most one child per parent: appending a second would branch the run.
    let mut child_of: Vec<Option<usize>> = vec![None; sections.len()];
    let mut parent_of: Vec<Option<usize>> = vec![None; sections.len()];
    let mut parents: Vec<usize> = candidates.keys().copied().collect();
    parents.sort_unstable();
    for parent in parents {
        let Some(&best) = candidates[&parent]
            .iter()
            .max_by_key(|&&i| (sections[i].shots.len(), std::cmp::Reverse(i)))
        else {
            continue;
        };
        child_of[parent] = Some(best);
        parent_of[best] = Some(parent);
    }

    let mut slots: Vec<Option<TmlSection>> = sections.drain(..).map(Some).collect();
    let mut out: Vec<TmlSection> = Vec::with_capacity(slots.len());
    let mut joins = 0;

    for idx in 0..slots.len() {
        if parent_of[idx].is_some() {
            continue; // this chain is somebody's tail
        }
        let Some(mut run) = slots[idx].take() else {
            continue;
        };
        let mut seen: std::collections::HashSet<usize> = std::collections::HashSet::new();
        seen.insert(idx);
        let mut names: Vec<String> = vec![run.name.clone()];
        let mut cursor = idx;
        while let Some(child) = child_of[cursor] {
            if !seen.insert(child) {
                break; // malformed file: a join cycle
            }
            let Some(tail) = slots[child].take() else {
                break;
            };
            if !names.contains(&tail.name) {
                names.push(tail.name.clone());
            }
            run.shots.extend(tail.shots);
            run.end_ariane_id = tail.end_ariane_id;
            run.is_branch_split = run.is_branch_split || tail.is_branch_split;
            joins += 1;
            cursor = child;
        }
        run.name = joined_name(&names);
        out.push(run);
    }

    // A pure cycle has no root, so nothing above emitted it. Emit the members
    // untouched rather than dropping shots on the floor.
    for slot in &mut slots {
        if let Some(run) = slot.take() {
            tracing::warn!(
                section = run.name,
                "Chain join cycle; emitting the chain unmerged"
            );
            out.push(run);
        }
    }

    *sections = out;
    joins
}

/// Linearize a group of shots belonging to one section name.
/// Splits into multiple sub-sections if branching is detected.
pub(super) fn linearize_section(
    section_name: &str,
    shots: &[&RawShot],
    successors: &HashMap<i64, Vec<i64>>,
    all_shots: &HashMap<i64, &RawShot>,
) -> Vec<TmlSection> {
    if shots.is_empty() {
        return Vec::new();
    }

    let shot_ids: std::collections::HashSet<i64> = shots.iter().map(|s| s.id).collect();
    let shot_by_id: HashMap<i64, &RawShot> = shots.iter().map(|s| (s.id, *s)).collect();

    // Preserve deterministic chain selection by ranking shots in encounter order.
    let order_rank: HashMap<i64, usize> =
        shots.iter().enumerate().map(|(i, s)| (s.id, i)).collect();
    let rank_key = |id: &i64| (order_rank.get(id).copied().unwrap_or(usize::MAX), *id);

    // Successors constrained to this section, sorted deterministically.
    let mut in_section_successors: HashMap<i64, Vec<i64>> = HashMap::new();
    for shot in shots {
        let mut succs: Vec<i64> = successors
            .get(&shot.id)
            .into_iter()
            .flatten()
            .copied()
            .filter(|id| shot_ids.contains(id))
            .collect();
        succs.sort_by_key(&rank_key);
        succs.dedup();
        in_section_successors.insert(shot.id, succs);
    }

    let downstream = downstream_lengths(shots, &shot_by_id, &in_section_successors);

    // Find chain roots: shots whose from_id is not in this section's shot set.
    let mut roots: Vec<i64> = shots
        .iter()
        .filter(|s| !shot_ids.contains(&s.from_id))
        .map(|s| s.id)
        .collect();
    roots.sort_by_key(&rank_key);

    let needs_split = roots.len() > 1 || has_branching_within(shots, successors);
    let mut visited: std::collections::HashSet<i64> = std::collections::HashSet::new();
    let mut pending_starts = std::collections::VecDeque::new();
    let mut chains: Vec<Vec<i64>> = Vec::new();

    // Walk natural roots first.
    for root_id in roots {
        let chain = collect_linear_chain(
            root_id,
            &shot_ids,
            &in_section_successors,
            &downstream,
            &shot_by_id,
            &mut visited,
            &mut pending_starts,
        );
        if !chain.is_empty() {
            chains.push(chain);
        }
    }

    // Then walk branch starts discovered while traversing roots.
    while let Some(start_id) = pending_starts.pop_front() {
        let chain = collect_linear_chain(
            start_id,
            &shot_ids,
            &in_section_successors,
            &downstream,
            &shot_by_id,
            &mut visited,
            &mut pending_starts,
        );
        if !chain.is_empty() {
            chains.push(chain);
        }
    }

    // Guard pass for malformed/disconnected graphs:
    // backtrack through in-section parents to find an upstream start.
    let mut unvisited_ids: Vec<i64> = shots
        .iter()
        .map(|s| s.id)
        .filter(|id| !visited.contains(id))
        .collect();
    unvisited_ids.sort_by_key(&rank_key);

    for shot_id in unvisited_ids {
        if visited.contains(&shot_id) {
            continue;
        }

        let mut start = shot_id;
        let mut seen_backtrack = std::collections::HashSet::new();
        loop {
            if !seen_backtrack.insert(start) {
                tracing::warn!(
                    section = section_name,
                    shot_id = start,
                    "Cycle detected while finding branch start; using cycle member as start"
                );
                break;
            }

            let Some(current) = shot_by_id.get(&start) else {
                tracing::warn!(
                    section = section_name,
                    shot_id = start,
                    "Shot missing while finding branch start; using current node as start"
                );
                break;
            };

            let parent_id = current.from_id;
            if !shot_ids.contains(&parent_id) || visited.contains(&parent_id) {
                break;
            }
            start = parent_id;
        }

        let chain = collect_linear_chain(
            start,
            &shot_ids,
            &in_section_successors,
            &downstream,
            &shot_by_id,
            &mut visited,
            &mut pending_starts,
        );
        if !chain.is_empty() {
            chains.push(chain);
        }

        while let Some(extra_start) = pending_starts.pop_front() {
            let extra_chain = collect_linear_chain(
                extra_start,
                &shot_ids,
                &in_section_successors,
                &downstream,
                &shot_by_id,
                &mut visited,
                &mut pending_starts,
            );
            if !extra_chain.is_empty() {
                chains.push(extra_chain);
            }
        }
    }

    // Last-resort guard: ensure every shot is emitted exactly once.
    let mut still_unvisited: Vec<i64> = shots
        .iter()
        .map(|s| s.id)
        .filter(|id| !visited.contains(id))
        .collect();
    still_unvisited.sort_by_key(&rank_key);
    for shot_id in still_unvisited {
        let chain = collect_linear_chain(
            shot_id,
            &shot_ids,
            &in_section_successors,
            &downstream,
            &shot_by_id,
            &mut visited,
            &mut pending_starts,
        );
        if !chain.is_empty() {
            tracing::warn!(
                section = section_name,
                shot_id,
                "Recovered unvisited shot via final guard pass"
            );
            chains.push(chain);
        }
    }

    let mut result = Vec::new();
    for chain_ids in chains {
        let mut chain = Vec::with_capacity(chain_ids.len());
        for shot_id in chain_ids {
            if let Some(shot) = shot_by_id.get(&shot_id) {
                chain.push((*shot).clone());
            } else {
                tracing::warn!(
                    section = section_name,
                    shot_id,
                    "Skipping missing shot while building linearized section"
                );
            }
        }

        if chain.is_empty() {
            continue;
        }

        // The first chain is the mainline (the continuation rule in
        // `choose_continuation` keeps walking it through every junction), so
        // it keeps the section's own name; only the deferred side chains get
        // "(branch N)" suffixes, numbered as if the mainline were branch 1.
        let has_prior_chains = !result.is_empty();
        let branch_number = result.len() + 1;
        let name = if has_prior_chains {
            format!("{section_name} (branch {branch_number})")
        } else {
            section_name.to_string()
        };
        let is_branch_split = needs_split || has_prior_chains;

        let first_shot = &chain[0];
        let last_shot = &chain[chain.len() - 1];
        let surveyor = first_shot.explorer.clone();
        let date = first_shot.date;
        let color = first_shot.color.clone();

        let tml_shots: Vec<TmlShot> = chain
            .iter()
            .map(|s| TmlShot {
                id: s.id,
                uuid: s.uuid.clone(),
                from_id: s.from_id,
                shot_type: s.shot_type,
                azimuth: s.azimuth,
                length: s.length,
                depth: s.depth,
                depth_in: s.depth_in,
                inclination: s.inclination,
                left: s.left,
                right: s.right,
                up: s.up,
                down: s.down,
                comment: s.comment.clone(),
                explorer: s.explorer.clone(),
                date: s.date,
                color: s.color.clone(),
                excluded: s.excluded,
                latitude: s.latitude,
                longitude: s.longitude,
                closure_to_id: s.closure_to_id,
                section: s.section.clone(),
            })
            .collect();

        // Look up the parent shot's cumulative depth for correct rebasing.
        // If from_id points to a shot (START or REAL/VIRTUAL), use its depth.
        let start_depth = all_shots
            .get(&first_shot.from_id)
            .map_or(0.0, |parent| parent.depth);

        result.push(TmlSection {
            name,
            start_ariane_id: first_shot.from_id,
            end_ariane_id: last_shot.id,
            shots: tml_shots,
            surveyor,
            date,
            color,
            is_branch_split,
            start_depth,
        });
    }

    result
}

/// Walk a single linear chain, queueing extra branch starts when a node has
/// multiple unvisited successors within the same section.
fn collect_linear_chain(
    start_id: i64,
    shot_ids: &std::collections::HashSet<i64>,
    in_section_successors: &HashMap<i64, Vec<i64>>,
    downstream: &HashMap<i64, f64>,
    shot_by_id: &HashMap<i64, &RawShot>,
    visited: &mut std::collections::HashSet<i64>,
    pending_starts: &mut std::collections::VecDeque<i64>,
) -> Vec<i64> {
    if !shot_ids.contains(&start_id) || visited.contains(&start_id) {
        return Vec::new();
    }

    let mut chain = Vec::new();
    let mut current = start_id;

    loop {
        if !visited.insert(current) {
            break;
        }
        chain.push(current);

        let Some(successors) = in_section_successors.get(&current) else {
            break;
        };

        let unvisited_successors = successors
            .iter()
            .copied()
            .filter(|id| !visited.contains(id))
            .collect::<Vec<_>>();

        if unvisited_successors.is_empty() {
            break;
        }

        let next_id = choose_continuation(current, &unvisited_successors, downstream, shot_by_id);
        for extra in unvisited_successors {
            if extra != next_id {
                pending_starts.push_back(extra);
            }
        }

        current = next_id;
    }

    chain
}

/// Fraction of the longest candidate's downstream length a rival must reach
/// to still count as "comparable", handing the decision to azimuth continuity.
const COMPARABLE_LENGTH_RATIO: f64 = 0.8;

/// Decide which successor continues the current chain at a branch point (#412).
///
/// The continuation should be the mainline; every other successor defers into
/// its own "(branch N)" section. The rule, in order:
/// 1. Greatest total downstream length wins outright: rivals below
///    `COMPARABLE_LENGTH_RATIO` (80%) of the longest are eliminated.
/// 2. Among comparable survivors, azimuth continuity: the successor whose
///    azimuth is closest (minimum angular distance) to the current shot's
///    azimuth continues - a mainline tends to hold its heading through a
///    junction, while a side passage leaves at an angle.
/// 3. Ascending shot id.
///
/// Deterministic by construction: `candidates` arrives in the section's
/// sorted encounter order (never HashMap iteration order), the downstream
/// lengths are fixed-order IEEE 754 sums of parsed values (see
/// `downstream_lengths`), and the comparisons above are the same total order
/// over those values on every run and platform.
fn choose_continuation(
    current_id: i64,
    candidates: &[i64],
    downstream: &HashMap<i64, f64>,
    shot_by_id: &HashMap<i64, &RawShot>,
) -> i64 {
    if candidates.len() == 1 {
        return candidates[0];
    }

    let length_of = |id: i64| downstream.get(&id).copied().unwrap_or(0.0);
    let longest = candidates
        .iter()
        .map(|&id| length_of(id))
        .fold(0.0_f64, f64::max);
    let threshold = longest * COMPARABLE_LENGTH_RATIO;

    let current_azimuth = shot_by_id.get(&current_id).map(|s| s.azimuth);
    let turn_of = |id: i64| -> f64 {
        match (current_azimuth, shot_by_id.get(&id)) {
            (Some(azimuth_in), Some(shot)) => {
                let diff = (shot.azimuth - azimuth_in).rem_euclid(360.0);
                diff.min(360.0 - diff)
            }
            _ => f64::MAX,
        }
    };

    let mut best: Option<(i64, f64)> = None;
    for &candidate in candidates {
        if length_of(candidate) < threshold {
            continue;
        }
        let turn = turn_of(candidate);
        let better = match best {
            None => true,
            Some((best_id, best_turn)) => match turn.partial_cmp(&best_turn) {
                Some(std::cmp::Ordering::Less) => true,
                Some(std::cmp::Ordering::Equal) => candidate < best_id,
                _ => false,
            },
        };
        if better {
            best = Some((candidate, turn));
        }
    }
    best.map_or(candidates[0], |(id, _)| id)
}

/// Total downstream traverse length (own length plus all in-section
/// descendants) for every shot in the section.
///
/// Memoized via an iterative post-order walk, so the whole section costs
/// O(V + E) - one linear pass even on 10^5-shot files, never a per-branch
/// BFS. Children are summed in the pre-sorted successor order, so the f64
/// accumulation order is fixed and the result is identical across runs and
/// platforms (IEEE 754 arithmetic is deterministic given a fixed order).
///
/// Excluded and CLOSURE shots count toward the length: segmentation reflects
/// the topology the file declares, and the excluded-shots import toggle
/// (applied downstream of section building) must not change how sections
/// split. A back-edge in a malformed cycle (guarded during chain collection)
/// contributes 0, so each cycle member's length is counted exactly once.
fn downstream_lengths(
    shots: &[&RawShot],
    shot_by_id: &HashMap<i64, &RawShot>,
    in_section_successors: &HashMap<i64, Vec<i64>>,
) -> HashMap<i64, f64> {
    let empty: Vec<i64> = Vec::new();
    let mut lengths: HashMap<i64, f64> = HashMap::with_capacity(shots.len());
    let mut in_progress: std::collections::HashSet<i64> = std::collections::HashSet::new();

    for shot in shots {
        if lengths.contains_key(&shot.id) {
            continue;
        }
        in_progress.insert(shot.id);
        let mut stack: Vec<(i64, usize)> = vec![(shot.id, 0)];
        while let Some(&(id, next_child)) = stack.last() {
            let succs = in_section_successors.get(&id).unwrap_or(&empty);
            if let Some(&child) = succs.get(next_child) {
                if let Some(frame) = stack.last_mut() {
                    frame.1 = next_child + 1;
                }
                if !lengths.contains_key(&child) && in_progress.insert(child) {
                    stack.push((child, 0));
                }
            } else {
                let own = shot_by_id.get(&id).map_or(0.0, |s| s.length);
                let total = own
                    + succs
                        .iter()
                        .map(|c| lengths.get(c).copied().unwrap_or(0.0))
                        .sum::<f64>();
                lengths.insert(id, total);
                in_progress.remove(&id);
                stack.pop();
            }
        }
    }

    lengths
}

/// Check if any shot in the group has multiple successors within the same group.
fn has_branching_within(shots: &[&RawShot], successors: &HashMap<i64, Vec<i64>>) -> bool {
    let shot_ids: std::collections::HashSet<i64> = shots.iter().map(|s| s.id).collect();
    for shot in shots {
        if let Some(succs) = successors.get(&shot.id) {
            let in_section = succs.iter().filter(|id| shot_ids.contains(id)).count();
            if in_section > 1 {
                return true;
            }
        }
    }
    false
}
