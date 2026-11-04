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

#![expect(
    clippy::unwrap_used,
    reason = "test module: a failed unwrap is the failure report"
)]

use std::collections::{HashSet, VecDeque};

use chrono::Utc;

use crate::test_fixtures::straight_shot;
use crate::{
    ClosureStrategy, GpsCoordinates, LoopClosure, Project, SectionData, SectionId, StationAnchor,
    StationKey, StationMerge, StationRef, ZeroDatum,
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

    let fields = |s: &[crate::Station]| -> Vec<(StationRef, bool, Option<f64>, Option<String>)> {
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
