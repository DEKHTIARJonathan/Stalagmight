//! Property-based, seeded fuzz tests for the collaboration reconcile engine
//! (Layers 1–2 of `docs/collab-stress-testing.md`).
//!
//! Dependency-free: a SplitMix64 PRNG plus a generator bounded to project
//! topologies *proven* to round-trip cleanly (mirroring the targeted tests in
//! `reconcile.rs::tests`). A failing case prints its seed so it can be pinned as
//! a fixed-seed regression test via [`run_seed`]. Iteration count is scaled by
//! `COLLAB_FUZZ_ITERS` (default 64; bump for local/nightly soak).

#![cfg(test)]
#![expect(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::float_cmp,
    clippy::indexing_slicing
)]

use std::collections::HashSet;
use std::path::Path;

use tempfile::TempDir;

use crate::core::reconcile::diff;
use crate::core::state::apply_changeset;
use crate::export::tml::export_tml_with_baseline;
use crate::models::{
    CollabState, GpsCoordinates, Project, SectionData, ShotData, StationMerge, StationRef,
    ZeroDatum,
};
use crate::parsers::tml::{parse_tml, TmlFile, TmlShotType};

// --------------------------------------------------------------------------
// PRNG (SplitMix64) — deterministic and reproducible from a seed.
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
    std::env::var("COLLAB_FUZZ_ITERS")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(64)
}

// --------------------------------------------------------------------------
// Generator — bounded to constructs proven to round-trip to an empty diff.
// --------------------------------------------------------------------------

/// The clean-round-trip topologies the generator can emit. Each mirrors a
/// passing targeted test, so a "clean round-trip ⇒ empty diff" property does not
/// surface unrelated export/parse lossiness.
#[derive(Clone, Copy, Debug)]
enum Kind {
    /// One section of N shots.
    Plain,
    /// One section with a zero datum on a mid-station (synthetic pre-zero leg).
    Datum,
    /// Root + a differently-named child merged mid-station (synthetic reversed leg).
    Merge,
    /// Root + a same-named child merged at its start (no synthetic leg; tests the
    /// identity split of duplicate names — needs UUIDs, so excluded from the
    /// degraded property).
    DupNames,
}

/// Depth-continuous shot run starting at `depth`, with within-section distinct
/// azimuths (so geo-keys are unique even without UUIDs). Returns the shots and
/// the final station depth.
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
            // Datum on a mid-station (>=1) of the root → pre-zero-datum leg.
            let station = rng.range(1, root_n);
            p.zero_datums.push(ZeroDatum {
                station_ref: StationRef::new(root_id, station as u32).into(),
                gps: GpsCoordinates::new(20.0, -87.0, 10.0).unwrap(),
            });
        }
        Kind::Merge => {
            p.add_section(section("Main", root_shots));
            // Child "Branch" merged at its station 1 (mid) → reversed leg. Its
            // merge station must sit at the parent depth (continuity).
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
        Kind::DupNames => {
            p.add_section(section("Main", root_shots));
            // Second "Main" attached at its start to root station 1 (no leg).
            let child_n = rng.range(1, 3);
            let mut child_shots = gen_run(rng, child_n, root_station1_depth).0;
            child_shots[0].depth_in = root_station1_depth;
            p.add_section(section("Main", child_shots));
            let root_id = p.sections[0].id;
            let child_id = p.sections[1].id;
            p.station_merges.push(StationMerge {
                station_a: StationRef::new(root_id, 1).into(),
                station_b: StationRef::new(child_id, 0).into(),
                merged_at: chrono::Utc::now(),
            });
        }
    }
    p
}

// --------------------------------------------------------------------------
// Round-trip helpers (mirror the private ones in reconcile.rs::tests).
// --------------------------------------------------------------------------

/// Seed `p.collab` from its own export, exactly like the save pipeline.
fn seed_baseline(p: &mut Project, dir: &Path) {
    let (baseline, _sha, synthetic) = export_tml_with_baseline(p, &dir.join("base.tml")).unwrap();
    let mut seen = HashSet::new();
    let mut name_map = Vec::new();
    for e in &baseline {
        if seen.insert(e.section_id) {
            name_map.push((e.section_name.clone(), e.section_id));
        }
    }
    let mut c = CollabState::new("x.tml".into());
    c.section_name_map = name_map;
    c.synthetic_section_names = synthetic;
    c.shot_baseline = baseline;
    p.collab = Some(c);
}

/// Re-export `p` and parse it back as a "returned" collaborator file. UUIDs are
/// reused from `p.collab`, so this mirrors an Ariane 26+ round-trip.
fn returned(p: &Project, dir: &Path) -> TmlFile {
    let path = dir.join("returned.tmlu");
    export_tml_with_baseline(p, &path).unwrap();
    parse_tml(&path).unwrap()
}

/// Strip stable identity from a returned file to force the geometry/positional
/// tiers (simulates Ariane ≤25: no UUIDs, wholesale-renumbered IDs).
fn degrade(tml: &mut TmlFile) {
    for s in &mut tml.sections {
        for shot in &mut s.shots {
            shot.uuid = None;
            shot.id += 1_000_000;
        }
    }
}

fn real_shot_indices(tml: &TmlFile, section_idx: usize) -> Vec<usize> {
    tml.sections[section_idx]
        .shots
        .iter()
        .enumerate()
        .filter(|(_, s)| s.shot_type == TmlShotType::Real || s.shot_type == TmlShotType::Virtual)
        .map(|(i, _)| i)
        .collect()
}

// --------------------------------------------------------------------------
// Properties
// --------------------------------------------------------------------------

/// Run one iteration of property 1: a UUID-preserving clean round-trip must
/// produce an empty change set. Panics with the seed on failure.
fn prop_clean_roundtrip(seed: u64, kind: Kind) {
    let dir = TempDir::new().unwrap();
    let mut p = gen_project(&mut Rng::new(seed), kind);
    seed_baseline(&mut p, dir.path());
    let ret = returned(&p, dir.path());
    let cs = diff(&p, &ret);
    assert!(
        cs.is_empty(),
        "seed={seed} kind={kind:?}: clean round-trip not empty:\n{cs:#?}\nproject:\n{p:#?}"
    );
}

/// Run one iteration of property 2: a clean round-trip with identity stripped
/// (geometry/positional tiers only) must still be empty.
fn prop_degraded_roundtrip(seed: u64, kind: Kind) {
    let dir = TempDir::new().unwrap();
    let mut p = gen_project(&mut Rng::new(seed), kind);
    seed_baseline(&mut p, dir.path());
    let mut ret = returned(&p, dir.path());
    degrade(&mut ret);
    let cs = diff(&p, &ret);
    assert!(
        cs.is_empty(),
        "seed={seed} kind={kind:?}: degraded round-trip not empty:\n{cs:#?}\nproject:\n{p:#?}"
    );
}

/// Run one iteration of property 3: a single depth-safe edit must be detected,
/// applied, and converge (re-diff empty). This is the regression net for the
/// insert-position (`after_shot_id`) bug.
fn prop_edit_converges(seed: u64) {
    let dir = TempDir::new().unwrap();
    let mut rng = Rng::new(seed);
    // Plain single-section topology keeps mutations unambiguous.
    let mut p = gen_project(&mut rng, Kind::Plain);
    seed_baseline(&mut p, dir.path());

    let mut mutated = returned(&p, dir.path());
    let reals = real_shot_indices(&mutated, 0);
    // Need at least one real shot for most mutations.
    if reals.is_empty() {
        return;
    }
    let mutation = rng.below(5);
    match mutation {
        // Edit a shot's length.
        0 => {
            let idx = reals[rng.below(reals.len())];
            mutated.sections[0].shots[idx].length += 0.5;
        }
        // Edit a shot's azimuth.
        1 => {
            let idx = reals[rng.below(reals.len())];
            mutated.sections[0].shots[idx].azimuth += 5.0;
        }
        // Insert a depth-safe (flat) shot after a random real shot.
        2 => {
            let at = reals[rng.below(reals.len())];
            let mut ins = mutated.sections[0].shots[at].clone();
            let prev_depth = mutated.sections[0].shots[at].depth;
            ins.uuid = None;
            ins.id += 5_000_000;
            ins.azimuth = 3.0; // distinct, low
            ins.length = 2.0;
            ins.depth = prev_depth; // flat → preserves continuity
            ins.depth_in = prev_depth;
            mutated.sections[0].shots.insert(at + 1, ins);
        }
        // Delete the last real shot.
        3 => {
            let last = *reals.last().unwrap();
            mutated.sections[0].shots.remove(last);
        }
        // Rename the section.
        _ => {
            mutated.sections[0].name = format!("Renamed{seed}");
        }
    }

    let cs = diff(&p, &mutated);
    assert!(
        !cs.is_empty(),
        "seed={seed} mutation={mutation}: edit not detected\nproject:\n{p:#?}"
    );

    let mut p2 = p.clone();
    apply_changeset(&mut p2, &cs);

    // Convergence: after applying, re-seed p2's baseline and re-diff against the
    // same returned file — there must be nothing left to do (content + order).
    // Degrade the returned side so matching is geometry-only: an insert/delete
    // shifts shot indices, and p2's re-seeded baseline reuses the cloned UUIDs by
    // (section_id, shot_index), so a UUID-tier match here would compare shifted
    // shots. Geometry matching is index-independent and is the right equivalence.
    seed_baseline(&mut p2, dir.path());
    degrade(&mut mutated);
    let cs2 = diff(&p2, &mutated);
    assert!(
        cs2.is_empty(),
        "seed={seed} mutation={mutation}: did not converge after apply:\n{cs2:#?}\nafter-apply project:\n{p2:#?}"
    );
}

/// Run one iteration of property 4: the diff is deterministic.  Running
/// `diff` twice on identical inputs must produce identical changesets
/// — catches non-determinism from `HashMap::into_iter` (e.g. the
/// majority-vote tie-break before the `Reverse(sid)` ordering fix).
fn prop_diff_is_deterministic(seed: u64, kind: Kind) {
    let dir = TempDir::new().unwrap();
    let mut p = gen_project(&mut Rng::new(seed), kind);
    seed_baseline(&mut p, dir.path());
    let ret = returned(&p, dir.path());
    let cs_a = diff(&p, &ret);
    let cs_b = diff(&p, &ret);
    assert_eq!(
        format!("{cs_a:#?}"),
        format!("{cs_b:#?}"),
        "seed={seed} kind={kind:?}: diff output not deterministic across calls"
    );
}

/// Run one iteration of property 5: inserting a shot in Stalagmight
/// between two exports must not silently re-bind UUIDs.  This is the
/// regression net for the `pick_uuid((section_id, shot_index))` bug —
/// before the `Shot.uuid` field, the second export would assign the
/// pre-existing shots' UUIDs to whichever shot happened to land at that
/// `(section_id, shot_index)` slot after the insert.
fn prop_uuid_survives_local_insert(seed: u64) {
    use crate::models::{Shot, ShotData};
    let dir = TempDir::new().unwrap();
    let mut p = gen_project(&mut Rng::new(seed), Kind::Plain);
    seed_baseline(&mut p, dir.path());
    let pre_uuids: Vec<String> = p.sections[0]
        .shots
        .iter()
        .map(|s| s.uuid.clone().unwrap_or_default())
        .collect();
    assert!(
        pre_uuids.iter().all(|u| !u.is_empty()),
        "seed={seed}: every shot must already carry a uuid"
    );

    // Stalagmight-side insert at the front of section 0 → all indices
    // shift by +1.  We do NOT update the baseline (no save happened
    // yet from the user's perspective).
    let depth = p.sections[0].shots[0].depth_in;
    p.sections[0].shots.insert(
        0,
        Shot::new(
            99,
            ShotData {
                azimuth_in: 12.0,
                length: 1.0,
                depth_in: depth,
                depth_out: depth,
                ..Default::default()
            },
        ),
    );

    // Export again; baseline must contain every pre-existing UUID.
    let (b2, _, _) = export_tml_with_baseline(&p, &dir.path().join("v2.tmlu")).unwrap();
    let b2_uuids: HashSet<&String> = b2.iter().map(|e| &e.uuid).collect();
    for u in &pre_uuids {
        assert!(
            b2_uuids.contains(u),
            "seed={seed}: pre-existing UUID {u} dropped from baseline after local insert"
        );
    }
    assert_eq!(
        b2.len(),
        pre_uuids.len() + 1,
        "seed={seed}: baseline must have grown by exactly one for the inserted shot"
    );
}

/// True if any stored cross-reference dangles (its anchoring shot is gone).
/// With stable identity this is the failure an interleaved insert/delete must
/// never produce — a missed positional shift used to leave one silently.
fn has_dangling_ref(p: &Project) -> bool {
    p.check_structural_integrity()
        .iter()
        .any(|v| v.category.starts_with("dangling_"))
}

/// Property: a random interleaving of shot inserts and deletes on a merged
/// project never strands a cross-reference (no dangling anchor after ANY edit)
/// and the surviving merge stays colocated. This is the core C1 invariant:
/// anchors track their physical station across structural edits without the
/// positional ref-shifting that used to mispoint them.
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
    // cascade kept its endpoints coincident — no silent drift).
    assert!(
        p.check_merge_alignment().is_empty(),
        "seed={seed}: a merge drifted after interleaved edits:\n{p:#?}"
    );
}

/// Re-run a single seed across all properties — for pinning a discovered failure
/// as a deterministic regression test.
#[expect(dead_code)]
fn run_seed(seed: u64) {
    for kind in [Kind::Plain, Kind::Datum, Kind::Merge, Kind::DupNames] {
        prop_clean_roundtrip(seed, kind);
        prop_diff_is_deterministic(seed, kind);
    }
    for kind in [Kind::Plain, Kind::Datum, Kind::Merge] {
        prop_degraded_roundtrip(seed, kind);
    }
    prop_edit_converges(seed);
    prop_uuid_survives_local_insert(seed);
    prop_anchors_survive_interleaved_edits(seed);
}

const KINDS_ALL: [Kind; 4] = [Kind::Plain, Kind::Datum, Kind::Merge, Kind::DupNames];
const KINDS_DEGRADED: [Kind; 3] = [Kind::Plain, Kind::Datum, Kind::Merge];

#[test]
fn fuzz_clean_roundtrip_is_empty() {
    for i in 0..iters() {
        let seed = i ^ 0xC011AB_0001;
        prop_clean_roundtrip(seed, KINDS_ALL[(i as usize) % KINDS_ALL.len()]);
    }
}

#[test]
fn fuzz_degraded_roundtrip_is_empty() {
    for i in 0..iters() {
        let seed = i ^ 0xC011AB_0002;
        prop_degraded_roundtrip(seed, KINDS_DEGRADED[(i as usize) % KINDS_DEGRADED.len()]);
    }
}

#[test]
fn fuzz_edit_converges() {
    for i in 0..iters() {
        let seed = i ^ 0xC011AB_0003;
        prop_edit_converges(seed);
    }
}

#[test]
fn fuzz_diff_is_deterministic() {
    for i in 0..iters() {
        let seed = i ^ 0xC011AB_0004;
        prop_diff_is_deterministic(seed, KINDS_ALL[(i as usize) % KINDS_ALL.len()]);
    }
}

#[test]
fn fuzz_uuid_survives_local_insert() {
    for i in 0..iters() {
        let seed = i ^ 0xC011AB_0005;
        prop_uuid_survives_local_insert(seed);
    }
}

#[test]
fn fuzz_anchors_survive_interleaved_edits() {
    for i in 0..iters() {
        let seed = i ^ 0xC011AB_0006;
        prop_anchors_survive_interleaved_edits(seed);
    }
}

// --------------------------------------------------------------------------
// Layer 2 — real-Ariane corpus replay (opt-in; skips if the data is absent).
// --------------------------------------------------------------------------

fn corpus_dir() -> std::path::PathBuf {
    if let Ok(d) = std::env::var("COLLAB_CORPUS_DIR") {
        return std::path::PathBuf::from(d);
    }
    let home = std::env::var("HOME").unwrap_or_default();
    std::path::PathBuf::from(home).join("src/cave/data/collab_test_data")
}

fn files_with_ext(dir: &Path, ext: &str) -> Vec<std::path::PathBuf> {
    let mut v: Vec<std::path::PathBuf> = std::fs::read_dir(dir)
        .map(|rd| {
            rd.filter_map(|e| e.ok().map(|e| e.path()))
                .filter(|p| p.extension().and_then(|x| x.to_str()) == Some(ext))
                .collect()
        })
        .unwrap_or_default();
    v.sort();
    v
}

/// Replays the real Naharon Ariane edit history against the live engine: load the
/// `.stalx`, then for each successive real `.tml` version diff → apply → assert
/// convergence (re-diff empty). Exercises real Ariane UUID/ID/branch/datum output.
/// Skips silently when the corpus is absent (data lives outside the repo).
#[test]
fn corpus_replay_real_ariane_history() {
    let dir = corpus_dir();
    if !dir.is_dir() {
        eprintln!("corpus_replay: skipped (no dir {})", dir.display());
        return;
    }
    let Some(stalx) = files_with_ext(&dir, "stalx").into_iter().next() else {
        eprintln!("corpus_replay: skipped (no .stalx in {})", dir.display());
        return;
    };
    let versions = files_with_ext(&dir, "tml");
    if versions.is_empty() {
        eprintln!(
            "corpus_replay: skipped (no .tml versions in {})",
            dir.display()
        );
        return;
    }

    let db = crate::persistence::Database::open_existing(&stalx).unwrap();
    let mut p = db.load_project().unwrap();
    p.file_path = Some(stalx.clone());

    let tdir = TempDir::new().unwrap();
    seed_baseline(&mut p, tdir.path());

    for vn in &versions {
        // Parse + diff + apply must not panic on real Ariane output.
        let ret = parse_tml(vn).unwrap();
        let cs = diff(&p, &ret);
        apply_changeset(&mut p, &cs);

        // Convergence: re-seed from the applied state (fresh UUIDs) and re-diff
        // against the same version with identity stripped (geometry-only, robust
        // to index shifts and real-survey geo-key duplicates). Must be empty.
        p.collab = None;
        seed_baseline(&mut p, tdir.path());
        let mut deg = parse_tml(vn).unwrap();
        degrade(&mut deg);
        let cs2 = diff(&p, &deg);
        assert!(
            cs2.is_empty(),
            "corpus_replay: no convergence after applying {}:\n added={} edited={} removed={} sections={} meta={}",
            vn.display(),
            cs2.shots_added.len(),
            cs2.shots_edited.len(),
            cs2.shots_removed.len(),
            cs2.sections_added.len(),
            cs2.section_meta_changed.len(),
        );
    }
    eprintln!(
        "corpus_replay: replayed {} versions from {}",
        versions.len(),
        dir.display()
    );
}
