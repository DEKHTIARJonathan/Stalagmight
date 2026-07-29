//! Property-based, seeded fuzz tests for cross-reference anchor stability.
//!
//! Station offsets, station comments, zero datums, loop closures and station
//! merges all anchor to a *station*, which is identified by the UUID of the shot
//! that creates it ([`StationKey::AfterShot`]). These properties pin the two
//! invariants that identity buys us:
//!
//! 1. a structural edit (insert / delete) never strands an anchor, and
//! 2. reversing a section neither mints nor drops a shot UUID.
//!
//! Both used to be asserted inside the collaboration reconcile fuzz harness,
//! which lived beside the diff engine it tested. They are not about
//! collaboration at all, so they outlived it - and they belong here, next to the
//! `Project` geometry they constrain.
//!
//! Dependency-free: a SplitMix64 PRNG plus a generator bounded to a handful of
//! representative topologies. A failing case prints its seed so it can be pinned
//! as a fixed-seed regression test. Iteration count is scaled by
//! `ANCHOR_FUZZ_ITERS` (default 64; bump for local/nightly soak).

#![cfg(test)]
#![expect(clippy::unwrap_used, clippy::indexing_slicing)]

use std::collections::HashSet;

use crate::models::{
    GpsCoordinates, Project, SectionData, ShotData, StationMerge, StationRef, ZeroDatum,
};

// --------------------------------------------------------------------------
// PRNG (SplitMix64) - deterministic and reproducible from a seed.
// --------------------------------------------------------------------------

struct Rng(u64);

impl Rng {
    fn new(seed: u64) -> Self {
        Rng(seed)
    }

    fn next_u64(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^ (z >> 31)
    }

    /// Uniform in `[0, n)`. `n` must be > 0.
    fn below(&mut self, n: usize) -> usize {
        (self.next_u64() % n as u64) as usize
    }

    /// Uniform in `[lo, hi]` (inclusive).
    fn range(&mut self, lo: usize, hi: usize) -> usize {
        lo + self.below(hi - lo + 1)
    }
}

fn iters() -> u64 {
    std::env::var("ANCHOR_FUZZ_ITERS")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(64)
}

// --------------------------------------------------------------------------
// Generator.
// --------------------------------------------------------------------------

/// The topologies the generator can emit. `Plain` has no external station refs
/// at all, so the ref-remapping paths only light up from `Datum` onwards.
#[derive(Clone, Copy, Debug)]
enum Kind {
    /// One section of N shots.
    Plain,
    /// One section with a zero datum on a mid-station.
    Datum,
    /// Root + a child merged mid-station.
    Merge,
}

const KINDS_ALL: [Kind; 3] = [Kind::Plain, Kind::Datum, Kind::Merge];

/// Depth-continuous shot run starting at `depth`, with within-section distinct
/// azimuths. Returns the shots and the final station depth.
fn gen_run(rng: &mut Rng, n: usize, start_depth: f64) -> (Vec<ShotData>, f64) {
    let mut shots = Vec::with_capacity(n);
    let mut depth = start_depth;
    for i in 0..n {
        let azimuth = 5.0 + (i as f64) * 7.0 + (rng.below(3) as f64); // distinct per i
        let length = 3.0 + (i as f64) * 0.37 + (rng.range(0, 4) as f64) * 0.05;
        let dz = 0.3 + (rng.range(0, 5) as f64) * 0.2;
        let depth_in = depth;
        let depth_out = depth + dz;
        depth = depth_out;
        shots.push(ShotData {
            azimuth_in: azimuth,
            azimuth_out: azimuth,
            length,
            depth_in,
            depth_out,
            ..Default::default()
        });
    }
    (shots, depth)
}

fn section(name: &str, shots: Vec<ShotData>) -> SectionData {
    SectionData {
        name: Some(name.to_string()),
        surveyor: None,
        date: None,
        color: "#3366cc".to_string(),
        direction: None,
        quality: 1.0,
        shots,
    }
}

fn gen_project(rng: &mut Rng, kind: Kind) -> Project {
    let mut p = Project::new("Fuzz".into(), None);
    let root_n = rng.range(1, 5);
    let (root_shots, _) = gen_run(rng, root_n, 0.0);
    let root_station1_depth = root_shots[0].depth_out;

    match kind {
        Kind::Plain => {
            p.add_section(section("Main", root_shots));
        }
        Kind::Datum => {
            p.add_section(section("Main", root_shots));
            let root_id = p.sections[0].id;
            let station = rng.range(1, root_n);
            p.zero_datums.push(ZeroDatum {
                station_ref: StationRef::new(root_id, station as u32).into(),
                gps: GpsCoordinates::new(20.0, -87.0, 10.0).unwrap(),
            });
        }
        Kind::Merge => {
            p.add_section(section("Main", root_shots));
            // Child "Branch" merged at its station 1 (mid). Its merge station
            // must sit at the parent depth (continuity).
            let child_n = rng.range(2, 4);
            let mut child_shots = gen_run(rng, child_n, root_station1_depth).0;
            // Make station 1 coincide with the parent depth: flatten shot 0.
            child_shots[0].depth_in = root_station1_depth;
            child_shots[0].depth_out = root_station1_depth;
            // Re-base the rest from the merge depth.
            let mut d = root_station1_depth;
            for s in child_shots.iter_mut().skip(1) {
                let dz = s.depth_out - s.depth_in;
                s.depth_in = d;
                s.depth_out = d + dz;
                d += dz;
            }
            p.add_section(section("Branch", child_shots));
            let root_id = p.sections[0].id;
            let child_id = p.sections[1].id;
            p.station_merges.push(StationMerge {
                station_a: StationRef::new(root_id, 1).into(),
                station_b: StationRef::new(child_id, 1).into(),
                merged_at: chrono::Utc::now(),
            });
        }
    }
    p
}

/// True if any stored cross-reference dangles (its anchoring shot is gone).
/// With stable identity this is the failure an interleaved insert/delete must
/// never produce - a missed positional shift used to leave one silently.
fn has_dangling_ref(p: &Project) -> bool {
    p.check_structural_integrity()
        .iter()
        .any(|v| v.category.starts_with("dangling_"))
}

/// Every UUID currently carried by a live shot, project-wide.
fn live_uuids(p: &Project) -> HashSet<String> {
    p.sections
        .iter()
        .flat_map(|s| s.shots.iter())
        .map(|s| s.uuid.clone().unwrap_or_default())
        .collect()
}

// --------------------------------------------------------------------------
// Properties.
// --------------------------------------------------------------------------

/// Property: a random interleaving of shot inserts and deletes on a merged
/// project never strands a cross-reference (no dangling anchor after ANY edit)
/// and the surviving merge stays colocated. Anchors must track their physical
/// station across structural edits without positional ref-shifting.
fn prop_anchors_survive_interleaved_edits(seed: u64) {
    let mut rng = Rng::new(seed);
    let mut p = gen_project(&mut rng, Kind::Merge);
    // Canonicalize anchors, exactly as a load does, then confirm it starts sound.
    p.redrive_offsets_after_load();
    assert!(
        !has_dangling_ref(&p),
        "seed={seed}: project starts with a dangling ref"
    );

    let root_id = p.sections[0].id;
    let ops = rng.range(3, 12);
    for _ in 0..ops {
        let Some(shots_len) = p.get_section(root_id).map(|s| s.shots.len()) else {
            break;
        };
        if shots_len == 0 {
            break;
        }
        let pick = rng.below(shots_len);
        let shot_id = p.get_section(root_id).unwrap().shots[pick].id;
        if shots_len > 1 && rng.below(2) == 0 {
            // Delete the picked shot (rewires/removes any ref on its station).
            let _ = p.remove_shot_with_rewire(root_id, shot_id);
        } else {
            // Insert a fresh shot after the picked one.
            let data = gen_run(&mut rng, 1, 0.0).0.into_iter().next().unwrap();
            p.insert_shot_after(root_id, shot_id, data, None, None);
        }
        assert!(
            !has_dangling_ref(&p),
            "seed={seed}: an interleaved edit stranded a cross-reference:\n{:#?}",
            p.check_structural_integrity()
        );
    }
    // Any merge that survived the edits must still be colocated (the offset
    // cascade kept its endpoints coincident - no silent drift).
    assert!(
        p.check_merge_alignment().is_empty(),
        "seed={seed}: a merge drifted after interleaved edits:\n{p:#?}"
    );
}

/// Property: reversing a section re-binds identity to the *shot*, never to a
/// position. The set of live shot UUIDs is therefore unchanged across the
/// reverse, and no anchor is left dangling by the ref remapping.
///
/// Runs over every generated topology, not just `Kind::Plain`: a single section
/// with no merges and no datums has NO external station refs, so it exercises
/// none of the read/write ref-remapping a reverse carries for merges, zero
/// datums, closures and station comments.
fn prop_reverse_preserves_uuids_and_anchors(seed: u64, kind: Kind) {
    let mut p = gen_project(&mut Rng::new(seed), kind);
    p.redrive_offsets_after_load();

    // Section 0 is the root every other generated construct hangs off, so
    // reversing it is the case that moves a merge / datum / comment anchor.
    let section_id = p.sections[0].id;
    let before = live_uuids(&p);

    assert!(
        p.reverse_section(section_id, false),
        "seed={seed} kind={kind:?}: reverse failed"
    );

    assert_eq!(
        before,
        live_uuids(&p),
        "seed={seed} kind={kind:?}: reverse must not mint or drop a shot UUID - \
         every station anchor keyed on one would move to a different station"
    );
    assert!(
        !has_dangling_ref(&p),
        "seed={seed} kind={kind:?}: reverse left a dangling cross-reference:\n{:#?}",
        p.check_structural_integrity()
    );
}

// --------------------------------------------------------------------------
// Drivers.
// --------------------------------------------------------------------------

#[test]
fn fuzz_anchors_survive_interleaved_edits() {
    for i in 0..iters() {
        prop_anchors_survive_interleaved_edits(i ^ 0x0A11_0001);
    }
}

#[test]
fn fuzz_reverse_preserves_uuids_and_anchors() {
    for i in 0..iters() {
        prop_reverse_preserves_uuids_and_anchors(
            i ^ 0x0A11_0002,
            KINDS_ALL[(i as usize) % KINDS_ALL.len()],
        );
    }
}
