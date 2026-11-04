//! [#576 HFI-10] The indexed lookups that replaced three full scans answer
//! exactly what the scans did.
//!
//! A very large Walls import spent most of its backend time in three places that
//! rescanned a whole collection per question: the zero-datum and station-comment
//! passes of `compute_station_coordinates` (every station, per datum and per
//! comment), the connectivity BFS (every merge and closure re-resolved at every
//! node it visited) and `are_stations_merged` (the station merge graph rebuilt on
//! every call, once per merge an import makes). Each now reads an index or
//! answers early. The change is meant to be invisible, so each is driven here
//! against the scan it replaced - written out below exactly as it was - over a
//! synthetic project that has every awkward edge: a dangling key, an anchor past
//! the end, a self-merge, two keys naming one station, a second datum on a
//! station, a merge component and a closure loop, and a closure that is a sole
//! bridge.
//!
//! [#576 NF-W12BE-2..4] The closure-ref passes of `compute_station_coordinates`
//! (every station tested against both groups of every closure), the range-delete
//! BFS (every merge and closure re-resolved at every node) and the per-station
//! offset lookup (every offset key resolved per station) followed. They are
//! driven the same way, and also over a seeded corpus of random projects
//! ([`random_project`]).

#![expect(
    clippy::unwrap_used,
    reason = "test module: a failed unwrap is the failure report"
)]

use std::collections::{HashSet, VecDeque};
use std::fmt::Write as _;

use chrono::Utc;

use crate::test_fixtures::straight_shot;
use crate::{
    ClosureRef, ClosureStrategy, GpsCoordinates, LoopClosure, Project, SectionData, SectionId,
    Station, StationAnchor, StationKey, StationMerge, StationRef, ZeroDatum,
};

/// Six sections of 3-5 shots: S0-S1-S2 merged in a chain and closed back onto
/// S0 by a loop closure, S3-S4 merged on their own, S5 tied to S4 only by a
/// closure (a sole bridge), plus the dangling and doubled references listed in
/// the module doc.
fn awkward_project() -> (Project, Vec<SectionId>) {
    let mut project = Project::new("parity".to_string(), None);
    let ids: Vec<SectionId> = [4u32, 3, 5, 3, 4, 3]
        .iter()
        .enumerate()
        .map(|(n, &shots)| {
            project
                .add_section(SectionData {
                    shots: (0..shots)
                        .map(|i| {
                            straight_shot(f64::from(30 * n as u32 + 7 * i), 4.0 + f64::from(i))
                        })
                        .collect(),
                    ..Default::default()
                })
                .id
        })
        .collect();
    project.ensure_shot_uuids();
    let key = |p: &Project, s: usize, i: u32| p.key_for_ref(StationRef::new(ids[s], i)).unwrap();
    let dangling =
        |s: usize| StationKey::new(ids[s], StationAnchor::AfterShot("no-such-shot".into()));
    let past_end = |s: usize| StationKey::new(ids[s], StationAnchor::Index(99));

    let merges = [
        (key(&project, 0, 2), key(&project, 1, 0)),
        (key(&project, 1, 3), key(&project, 2, 0)),
        (key(&project, 3, 0), key(&project, 4, 1)),
        // A self-merge, a merge with a dangling end and one past the end.
        (key(&project, 2, 2), key(&project, 2, 2)),
        (key(&project, 4, 2), dangling(5)),
        (past_end(0), key(&project, 5, 1)),
    ];
    for (station_a, station_b) in merges {
        project.station_merges.push(StationMerge {
            station_a,
            station_b,
            merged_at: Utc::now(),
        });
    }
    let closures = [
        (key(&project, 2, 4), key(&project, 0, 0)),
        (key(&project, 4, 4), key(&project, 5, 0)),
        (dangling(1), key(&project, 3, 2)),
    ];
    for (n, (station_a, station_b)) in closures.into_iter().enumerate() {
        project.loop_closures.push(LoopClosure {
            id: n as u64 + 1,
            station_a,
            station_b,
            path_length: 10.0,
            misclosure_distance: 0.1,
            error_percentage: 1.0,
            horizontal_misclosure: 0.1,
            vertical_misclosure: 0.0,
            strategy: ClosureStrategy::LeastSquaresWeighted,
            is_aligned: false,
        });
    }
    let gps = |lat: f64| GpsCoordinates::new(lat, 10.0, 0.0).unwrap();
    project.zero_datums = vec![
        ZeroDatum {
            station_ref: key(&project, 0, 0),
            gps: gps(1.0),
        },
        ZeroDatum {
            station_ref: key(&project, 3, 1),
            gps: gps(2.0),
        },
        // A second datum on the same station (the later one's GPS wins) and two
        // that resolve to nothing.
        ZeroDatum {
            station_ref: key(&project, 3, 1),
            gps: gps(3.0),
        },
        ZeroDatum {
            station_ref: dangling(2),
            gps: gps(4.0),
        },
        ZeroDatum {
            station_ref: past_end(4),
            gps: gps(5.0),
        },
    ];
    let comments = [
        (key(&project, 1, 1), "after shot 0"),
        // The same station by position: two keys, one station.
        (StationKey::new(ids[1], StationAnchor::Index(1)), "by index"),
        (key(&project, 5, 3), "end of S5"),
        (key(&project, 2, 0), "start of S2"),
        (dangling(3), "dangling"),
        (past_end(5), "past the end"),
    ];
    for (k, text) in comments {
        project.station_comments.insert(k, text.to_string());
    }
    (project, ids)
}

/// Every station of the project, plus one past the end of a section and one in a
/// section that does not exist.
fn every_ref(project: &Project, ids: &[SectionId]) -> Vec<StationRef> {
    let mut refs: Vec<StationRef> = project
        .sections
        .iter()
        .flat_map(|s| (0..=s.shots.len() as u32).map(move |i| StationRef::new(s.id, i)))
        .collect();
    refs.push(StationRef::new(ids[0], 99));
    refs.push(StationRef::new(SectionId::MAX, 0));
    refs
}

/// `station_neighbors_excluding_shot` before #576 HFI-10: every merge and
/// closure re-resolved for the one station asked about.
fn scanned_neighbors(
    project: &Project,
    station_ref: StationRef,
    excluded_shot: Option<(SectionId, usize)>,
    include_closures: bool,
) -> Vec<StationRef> {
    let mut neighbors = Vec::new();
    let Some(section) = project.get_section(station_ref.section_id) else {
        return neighbors;
    };
    let idx = station_ref.station_index as usize;
    if idx > section.shots.len() {
        return neighbors;
    }
    if idx > 0 && excluded_shot != Some((station_ref.section_id, idx - 1)) {
        neighbors.push(StationRef::new(station_ref.section_id, (idx - 1) as u32));
    }
    if idx < section.shots.len() && excluded_shot != Some((station_ref.section_id, idx)) {
        neighbors.push(StationRef::new(station_ref.section_id, (idx + 1) as u32));
    }
    for merge in &project.station_merges {
        if project.key_is_ref(&merge.station_a, station_ref) {
            neighbors.extend(project.resolve_key(&merge.station_b));
        } else if project.key_is_ref(&merge.station_b, station_ref) {
            neighbors.extend(project.resolve_key(&merge.station_a));
        }
    }
    if include_closures {
        for closure in &project.loop_closures {
            if project.key_is_ref(&closure.station_a, station_ref) {
                neighbors.extend(project.resolve_key(&closure.station_b));
            } else if project.key_is_ref(&closure.station_b, station_ref) {
                neighbors.extend(project.resolve_key(&closure.station_a));
            }
        }
    }
    neighbors
}

/// `are_stations_connected_excluding_shot` over [`scanned_neighbors`].
fn scanned_connected(
    project: &Project,
    a: StationRef,
    b: StationRef,
    excluded_shot: Option<(SectionId, usize)>,
    include_closures: bool,
) -> bool {
    if a == b {
        return true;
    }
    let mut visited = HashSet::from([a]);
    let mut queue = VecDeque::from([a]);
    while let Some(current) = queue.pop_front() {
        for n in scanned_neighbors(project, current, excluded_shot, include_closures) {
            if visited.insert(n) {
                if n == b {
                    return true;
                }
                queue.push_back(n);
            }
        }
    }
    false
}

#[test]
fn connectivity_over_the_link_index_matches_the_per_node_scan() {
    let (project, ids) = awkward_project();
    let refs = every_ref(&project, &ids);
    let mut connected = 0;
    let mut apart = 0;
    for excluded in [
        None,
        Some((ids[1], 1)),
        Some((ids[0], 2)),
        Some((ids[4], 0)),
    ] {
        for include_closures in [false, true] {
            for &a in &refs {
                for &b in &refs {
                    let want = scanned_connected(&project, a, b, excluded, include_closures);
                    let got = project.are_stations_connected_excluding_shot(
                        a,
                        b,
                        excluded,
                        include_closures,
                    );
                    assert_eq!(
                        got, want,
                        "{a:?} -> {b:?}, excluding {excluded:?}, closures {include_closures}"
                    );
                    if want {
                        connected += 1;
                    } else {
                        apart += 1;
                    }
                }
            }
        }
    }
    // Both answers occur, so the parity above is not about a constant.
    assert!(
        connected > 0 && apart > 0,
        "connected {connected}, apart {apart}"
    );
    // The integrity check's orphan pass rides on the same search: S5's sole-bridge
    // closure is flagged, the S2-S0 loop closure is not.
    let orphans = project.check_orphan_closures();
    assert_eq!(orphans.len(), 1, "{orphans:?}");
    assert!(
        orphans[0].message.starts_with("Loop closure 2 "),
        "{orphans:?}"
    );
}

#[test]
fn are_stations_merged_matches_the_station_graph_search() {
    let (project, ids) = awkward_project();
    let adjacency = project.build_station_merge_adjacency();
    let searched = |a: StationRef, b: StationRef| -> bool {
        if a == b {
            return true;
        }
        let mut visited = HashSet::from([a]);
        let mut queue = VecDeque::from([a]);
        while let Some(current) = queue.pop_front() {
            for &n in adjacency.get(&current).into_iter().flatten() {
                if n == b {
                    return true;
                }
                if visited.insert(n) {
                    queue.push_back(n);
                }
            }
        }
        false
    };
    let refs = every_ref(&project, &ids);
    let mut merged = 0;
    for &a in &refs {
        for &b in &refs {
            let want = searched(a, b);
            assert_eq!(project.are_stations_merged(a, b), want, "{a:?} ~ {b:?}");
            merged += usize::from(want && a != b);
        }
    }
    assert!(merged > 0, "the fixture merges some distinct stations");
}

#[test]
fn datums_and_comments_land_where_the_station_scan_put_them() {
    let (project, _) = awkward_project();
    let stations = project.compute_station_coordinates();

    // The two passes before #576 HFI-10, over a copy with their fields cleared.
    let mut scanned = stations.clone();
    for station in &mut scanned {
        station.is_zero_datum = false;
        station.gps_coordinates = None;
        station.comment = None;
    }
    for zd in &project.zero_datums {
        let Some(sr) = project.resolve_key(&zd.station_ref) else {
            continue;
        };
        for station in &mut scanned {
            if station.station_ref == sr {
                station.is_zero_datum = true;
                station.gps_coordinates = Some(zd.gps);
            }
        }
    }
    for (key, comment) in &project.station_comments {
        let Some(sr) = project.resolve_key(key) else {
            continue;
        };
        for station in &mut scanned {
            if station.station_ref == sr {
                station.comment = Some(comment.clone());
            }
        }
    }

    let fields = |s: &[Station]| -> Vec<(StationRef, bool, Option<f64>, Option<String>)> {
        s.iter()
            .map(|st| {
                (
                    st.station_ref,
                    st.is_zero_datum,
                    st.gps_coordinates.map(|g| g.latitude),
                    st.comment.clone(),
                )
            })
            .collect()
    };
    assert_eq!(fields(&stations), fields(&scanned));
    // The doubled datum kept the later GPS, and both comment keys hit one station.
    assert_eq!(stations.iter().filter(|s| s.is_zero_datum).count(), 2);
    assert!(stations.iter().any(|s| s
        .gps_coordinates
        .is_some_and(|g| (g.latitude - 3.0).abs() < 1e-12)));
    assert_eq!(stations.iter().filter(|s| s.comment.is_some()).count(), 3);
}

/// A small deterministic generator (xorshift64*), so a corpus is a list of seeds.
struct Rng(u64);

impl Rng {
    fn new(seed: u64) -> Self {
        Self(seed.wrapping_mul(0x9E37_79B9_7F4A_7C15) | 1)
    }
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 >> 12;
        self.0 ^= self.0 << 25;
        self.0 ^= self.0 >> 27;
        self.0.wrapping_mul(0x2545_F491_4F6C_DD1D)
    }
    fn below(&mut self, n: usize) -> usize {
        (self.next() % n.max(1) as u64) as usize
    }
    fn chance(&mut self, percent: u64) -> bool {
        self.next() % 100 < percent
    }
}

/// [#576 NF-W12BE-2..4] A random project with the shapes the indexed passes have
/// to get right: merge chains and self-merges, repeated merges, closures inside
/// one merge group and between groups, aligned and not, a station with several
/// closures, dangling keys and keys past the end, positional (`Index`) keys for
/// merges and closures, a second copy of a section (one ref at two positions),
/// sections out of id order, and a shot sharing its neighbour's UUID.
///
/// With `collide` the comments and offsets also get a second key naming the
/// same station (a positional `Index` beside the canonical key) with a
/// different value; without it every comment and offset station has one key, so
/// the result does not depend on which colliding key wins.
fn random_project(seed: u64, collide: bool) -> Project {
    let mut rng = Rng::new(seed);
    let mut project = Project::new(format!("corpus {seed}"), None);
    let section_count = 1 + rng.below(6);
    for _ in 0..section_count {
        let shots = (0..=rng.below(5))
            .map(|_| straight_shot(rng.below(360) as f64, 1.0 + rng.below(20) as f64))
            .collect();
        project.add_section(SectionData {
            shots,
            ..Default::default()
        });
    }
    project.ensure_shot_uuids();
    if rng.chance(15) {
        // Two shots sharing one UUID: the second's key names the first's station.
        let s = rng.below(project.sections.len());
        let section = &mut project.sections[s];
        if section.shots.len() >= 2 {
            let uuid = section.shots[0].uuid.clone();
            section.shots[1].uuid = uuid;
        }
    }
    let refs: Vec<StationRef> = project
        .sections
        .iter()
        .flat_map(|s| (0..=s.shots.len() as u32).map(move |i| StationRef::new(s.id, i)))
        .collect();
    let pick = |rng: &mut Rng| refs[rng.below(refs.len())];
    let key = |rng: &mut Rng, project: &Project, sr: StationRef| -> StationKey {
        match rng.below(20) {
            0 => StationKey::new(
                sr.section_id,
                StationAnchor::AfterShot("no-such-shot".into()),
            ),
            1 => StationKey::new(sr.section_id, StationAnchor::Index(99)),
            2..=5 => StationKey::positional(sr.section_id, sr.station_index),
            _ => project.key_for_ref(sr).unwrap(),
        }
    };

    let mut merged: Vec<(StationKey, StationKey)> = Vec::new();
    for _ in 0..rng.below(9) {
        let pair = if !merged.is_empty() && rng.chance(10) {
            merged[rng.below(merged.len())].clone()
        } else {
            let a = pick(&mut rng);
            let b = if rng.chance(10) { a } else { pick(&mut rng) };
            (key(&mut rng, &project, a), key(&mut rng, &project, b))
        };
        merged.push(pair);
    }
    for (station_a, station_b) in merged {
        project.station_merges.push(StationMerge {
            station_a,
            station_b,
            merged_at: Utc::now(),
        });
    }
    // A hub station closing to several others gives the chain-transitive pass work.
    let hub = pick(&mut rng);
    for n in 0..rng.below(10) {
        let a = if rng.chance(40) { hub } else { pick(&mut rng) };
        let b = if rng.chance(5) { a } else { pick(&mut rng) };
        let station_a = key(&mut rng, &project, a);
        let station_b = key(&mut rng, &project, b);
        project.loop_closures.push(LoopClosure {
            id: n as u64 + 1,
            station_a,
            station_b,
            path_length: 10.0,
            misclosure_distance: 0.1,
            error_percentage: 1.0,
            horizontal_misclosure: 0.1,
            vertical_misclosure: 0.0,
            strategy: ClosureStrategy::LeastSquaresWeighted,
            is_aligned: rng.chance(30),
        });
    }
    if rng.chance(50) {
        let sr = pick(&mut rng);
        project.zero_datums.push(ZeroDatum {
            station_ref: project.key_for_ref(sr).unwrap(),
            gps: GpsCoordinates::new(1.0, 10.0, 0.0).unwrap(),
        });
    }
    let mut annotated: HashSet<StationRef> = HashSet::new();
    for n in 0..rng.below(6) {
        let Some(canonical) = project.key_for_ref(pick(&mut rng)) else {
            continue;
        };
        // One key per station without `collide` (a shared UUID can make two refs
        // one key, and so one station).
        let named = project.resolve_key(&canonical).unwrap();
        if !annotated.insert(named) {
            continue;
        }
        let offset = (n as f64 + 0.5, -(n as f64), 0.25 * n as f64);
        project
            .station_comments
            .insert(canonical.clone(), format!("comment {n}"));
        project.station_offsets.insert(canonical, offset);
        if collide {
            let positional =
                StationKey::new(named.section_id, StationAnchor::Index(named.station_index));
            project
                .station_comments
                .insert(positional.clone(), format!("by index {n}"));
            project
                .station_offsets
                .insert(positional, (offset.0 + 100.0, offset.1, offset.2));
        }
    }
    if rng.chance(25) && project.sections.len() >= 2 {
        let (i, j) = (
            rng.below(project.sections.len()),
            rng.below(project.sections.len()),
        );
        project.sections.swap(i, j);
    }
    if rng.chance(15) {
        let copy = project.sections[rng.below(project.sections.len())].clone();
        project.sections.push(copy);
    }
    project
}

/// FNV-1a over a string: a corpus fingerprint short enough to compare by eye.
fn fingerprint(text: &str) -> u64 {
    text.bytes().fold(0xcbf2_9ce4_8422_2325, |h, b| {
        (h ^ u64::from(b)).wrapping_mul(0x0100_0000_01b3)
    })
}

/// The corpus seeds every parity test below runs.
const CORPUS: std::ops::Range<u64> = 0..400;

/// [#576 NF-W12BE-2..4] Prints one fingerprint per pass over the collision-free
/// corpus, for comparing two builds by hand: run it on the code before a change
/// and after, and the lines must match. Ignored because a fingerprint is not an
/// assertion; the parity tests are.
#[test]
#[ignore = "prints corpus fingerprints for a before/after comparison"]
#[expect(clippy::print_stdout, reason = "the fingerprints are the output")]
fn print_corpus_fingerprints() {
    let mut coords = String::new();
    let mut raw = String::new();
    let mut previews = String::new();
    for seed in CORPUS {
        let project = random_project(seed, false);
        writeln!(coords, "{seed}:{:?}", project.compute_station_coordinates()).unwrap();
        let mut ids: Vec<SectionId> = project.sections.iter().map(|s| s.id).collect();
        ids.sort_unstable();
        ids.dedup();
        for &id in &ids {
            let component = project.get_connected_section_ids(id);
            let mut by_ref: Vec<_> = project
                .compute_component_raw_coords(&component)
                .into_iter()
                .collect();
            by_ref.sort_by_key(|(sr, _)| *sr);
            writeln!(raw, "{seed}/{id}:{by_ref:?}").unwrap();
            let section = project.get_section(id).unwrap();
            let n = section.shots.len();
            for start in 0..n {
                for end in start..n {
                    let preview = project.preview_delete_shot_range(
                        id,
                        section.shots[start].id,
                        section.shots[end].id,
                    );
                    writeln!(previews, "{seed}/{id}/{start}-{end}:{preview:?}").unwrap();
                }
            }
        }
    }
    println!(
        "corpus {CORPUS:?}: coordinates {:016x} ({} bytes), raw coords {:016x} ({} bytes), range previews {:016x} ({} bytes)",
        fingerprint(&coords),
        coords.len(),
        fingerprint(&raw),
        raw.len(),
        fingerprint(&previews),
        previews.len()
    );
}

/// [#576 NF-W12BE-2/4] Wall-clock time of the passes the indexes replaced, on a
/// large synthetic project: 200 sections of 100 shots (20,200 stations) chained
/// end to start by merges into one component, 2,000 loop closures between
/// random stations and 500 station offsets. Ignored: a timing, run by hand on
/// the code before a change and after.
#[test]
#[ignore = "timing: run by hand before and after a change"]
#[expect(clippy::print_stdout, reason = "the timings are the output")]
fn time_the_indexed_passes_on_a_large_project() {
    let mut rng = Rng::new(576);
    let mut project = Project::new("large".to_string(), None);
    let ids: Vec<SectionId> = (0..200)
        .map(|s| {
            project
                .add_section(SectionData {
                    shots: (0..100)
                        .map(|i| straight_shot(f64::from((s * 7 + i) % 360), 3.0))
                        .collect(),
                    ..Default::default()
                })
                .id
        })
        .collect();
    project.ensure_shot_uuids();
    for pair in ids.windows(2) {
        let station_a = project.key_for_ref(StationRef::new(pair[0], 100)).unwrap();
        let station_b = project.key_for_ref(StationRef::new(pair[1], 0)).unwrap();
        project.station_merges.push(StationMerge {
            station_a,
            station_b,
            merged_at: Utc::now(),
        });
    }
    let mut random_key = |project: &Project| {
        let sr = StationRef::new(ids[rng.below(ids.len())], rng.below(101) as u32);
        project.key_for_ref(sr).unwrap()
    };
    for n in 0..2000 {
        let station_a = random_key(&project);
        let station_b = random_key(&project);
        project.loop_closures.push(LoopClosure {
            id: n + 1,
            station_a,
            station_b,
            path_length: 10.0,
            misclosure_distance: 0.1,
            error_percentage: 1.0,
            horizontal_misclosure: 0.1,
            vertical_misclosure: 0.0,
            strategy: ClosureStrategy::LeastSquaresWeighted,
            is_aligned: false,
        });
    }
    for n in 0..500 {
        let key = random_key(&project);
        project
            .station_offsets
            .insert(key, (0.01 * f64::from(n), 0.0, 0.0));
    }
    let best_of = |runs: usize, f: &mut dyn FnMut() -> String| {
        let mut best = std::time::Duration::MAX;
        let mut out = String::new();
        for _ in 0..runs {
            let t = std::time::Instant::now();
            out = f();
            best = best.min(t.elapsed());
        }
        (best, fingerprint(&out))
    };
    let (coords_time, coords_print) = best_of(3, &mut || {
        format!("{:?}", project.compute_station_coordinates())
    });
    let component = project.get_connected_section_ids(ids[0]);
    let (raw_time, raw_print) = best_of(3, &mut || {
        let mut v: Vec<_> = project
            .compute_component_raw_coords(&component)
            .into_iter()
            .collect();
        v.sort_by_key(|(sr, _)| *sr);
        format!("{v:?}")
    });
    let section = project.get_section(ids[100]).unwrap();
    let (first, last) = (section.shots[10].id, section.shots[20].id);
    let (preview_time, preview_print) = best_of(1, &mut || {
        format!(
            "{:?}",
            project.preview_delete_shot_range(ids[100], first, last)
        )
    });
    println!(
        "[NF-W12BE-2/4] 20,200 stations, 2,000 closures, 500 offsets (debug build, best of runs): \
         compute_station_coordinates {coords_time:?} (fingerprint {coords_print:016x}), \
         compute_component_raw_coords {raw_time:?} ({raw_print:016x}), \
         preview_delete_shot_range interior {preview_time:?} ({preview_print:016x})"
    );
}

/// The closure-ref passes of `compute_station_coordinates` before #576
/// NF-W12BE-2, written out as they were: every station tested against both
/// groups of every closure, and each chain-transitive entry's station found by
/// a scan of every station.
fn scanned_closure_refs(project: &Project, stations: &mut [Station]) {
    let (station_to_group, groups) = project.station_merge_groups();
    for closure in &project.loop_closures {
        let (Some(a_ref), Some(b_ref)) = (
            project.resolve_key(&closure.station_a),
            project.resolve_key(&closure.station_b),
        ) else {
            continue;
        };
        let a_group: Vec<StationRef> = station_to_group
            .get(&a_ref)
            .map_or_else(|| vec![a_ref], |&gid| groups[gid].clone());
        let b_group: Vec<StationRef> = station_to_group
            .get(&b_ref)
            .map_or_else(|| vec![b_ref], |&gid| groups[gid].clone());
        let a_group_id = station_to_group.get(&a_ref);
        let b_group_id = station_to_group.get(&b_ref);
        if a_group_id.is_some() && a_group_id == b_group_id {
            continue;
        }
        for station in stations.iter_mut() {
            if a_group.contains(&station.station_ref) {
                if station.station_ref != b_ref {
                    let via = if station.station_ref == a_ref {
                        None
                    } else {
                        Some(a_ref)
                    };
                    station.closures_mut().push(ClosureRef {
                        closure_id: closure.id,
                        station_ref: b_ref,
                        via_station: via,
                        is_transitive: via.is_some(),
                    });
                }
                for &b_member in &b_group {
                    if b_member != b_ref && b_member != station.station_ref {
                        station.closures_mut().push(ClosureRef {
                            closure_id: closure.id,
                            station_ref: b_member,
                            via_station: Some(b_ref),
                            is_transitive: true,
                        });
                    }
                }
            } else if b_group.contains(&station.station_ref) {
                if station.station_ref != a_ref {
                    let via = if station.station_ref == b_ref {
                        None
                    } else {
                        Some(b_ref)
                    };
                    station.closures_mut().push(ClosureRef {
                        closure_id: closure.id,
                        station_ref: a_ref,
                        via_station: via,
                        is_transitive: via.is_some(),
                    });
                }
                for &a_member in &a_group {
                    if a_member != a_ref && a_member != station.station_ref {
                        station.closures_mut().push(ClosureRef {
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
    let mut chain_transitive_refs: Vec<(StationRef, ClosureRef)> = Vec::new();
    for station in stations.iter() {
        let shared_ref = &station.station_ref;
        let endpoints: Vec<(u64, StationRef)> = station
            .closures()
            .iter()
            .filter(|cr| !cr.is_transitive)
            .map(|cr| (cr.closure_id, cr.station_ref))
            .collect();
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
    for (station_ref, new_ref) in chain_transitive_refs {
        if let Some(station) = stations.iter_mut().find(|s| s.station_ref == station_ref) {
            let already_exists = station.closures().iter().any(|cr| {
                cr.station_ref == new_ref.station_ref && cr.via_station == new_ref.via_station
            });
            if !already_exists {
                station.closures_mut().push(new_ref);
            }
        }
    }
}

/// The awkward project and the whole corpus, with and without colliding keys.
fn parity_projects() -> Vec<Project> {
    let mut projects = vec![awkward_project().0];
    projects.extend(CORPUS.map(|seed| random_project(seed, seed % 2 == 1)));
    projects
}

/// [#576 NF-W12BE-2] Every station's closure refs - the entries, their order and
/// whether the list exists at all - are the ones the station scan built.
#[test]
#[expect(clippy::print_stdout, reason = "the test prints the corpus coverage")]
fn closure_refs_over_the_layout_match_the_station_scan() {
    let (mut refs, mut via_merge, mut chained, mut doubled_refs) = (0, 0, 0, 0);
    for (n, project) in parity_projects().iter().enumerate() {
        let stations = project.compute_station_coordinates();
        let mut scanned = stations.clone();
        for station in &mut scanned {
            station.closures_with = None;
        }
        scanned_closure_refs(project, &mut scanned);
        assert_eq!(
            format!("{stations:?}"),
            format!("{scanned:?}"),
            "project {n} of the corpus"
        );
        for station in &stations {
            for c in station.closures() {
                refs += 1;
                match c.via_station {
                    Some(via) if c.station_ref == via => {}
                    Some(_) if station.merged_with.contains(&c.via_station.unwrap()) => {
                        via_merge += 1;
                    }
                    Some(_) => chained += 1,
                    None => {}
                }
            }
        }
        let distinct: HashSet<StationRef> = stations.iter().map(|s| s.station_ref).collect();
        doubled_refs += usize::from(distinct.len() < stations.len());
    }
    println!(
        "[NF-W12BE-2] {refs} closure refs ({via_merge} through a merge partner, {chained} other \
         transitive), {doubled_refs} projects with a ref at two positions"
    );
    // The corpus reaches every branch the layout has to get right.
    assert!(refs > 0 && via_merge > 0 && chained > 0 && doubled_refs > 0);
}
