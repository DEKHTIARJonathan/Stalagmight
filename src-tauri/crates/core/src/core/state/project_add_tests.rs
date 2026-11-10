//! Tests for #674: the append shared by "Merge projects" and "Add .stalx to
//! current project". Every project here is synthetic, built in code and written
//! to a temp dir - no fixture file is read or written into the tree.

use std::path::{Path, PathBuf};

use chrono::{TimeZone, Utc};
use tempfile::TempDir;

use super::AppState;
use crate::core::{Command, CommandResult};
use crate::models::{
    AzimuthReference, ClosureStrategy, CorrectionSource, GpsCoordinates, LoopClosure, Project,
    SectionData, ShotData, StationMerge, StationRef, SurveyDirection,
};
use crate::persistence::Database;

/// A shot with a FIXED uuid, so every output that carries shot identity is
/// deterministic across runs (a minted uuid would make the parity digest
/// below differ on every run).
fn shot(uuid: &str, azimuth: f64, length: f64, depth: f64) -> ShotData {
    ShotData {
        uuid: Some(uuid.to_string()),
        azimuth_in: azimuth,
        azimuth_out: (azimuth + 180.0) % 360.0,
        length,
        depth_in: depth,
        depth_out: depth + 0.5,
        ..Default::default()
    }
}

fn section(name: &str, shots: Vec<ShotData>) -> SectionData {
    SectionData {
        name: Some(name.to_string()),
        surveyor: Some("user1".to_string()),
        date: None,
        color: "#4ecdc4".to_string(),
        direction: Some(SurveyDirection::In),
        quality: 1.0,
        shots,
    }
}

fn fixed_time(seconds: i64) -> chrono::DateTime<Utc> {
    Utc.timestamp_opt(1_700_000_000 + seconds, 0)
        .single()
        .unwrap_or_default()
}

fn closure(a: StationRef, b: StationRef, strategy: ClosureStrategy) -> LoopClosure {
    LoopClosure {
        id: 0,
        station_a: a.into(),
        station_b: b.into(),
        path_length: 12.5,
        misclosure_distance: 0.25,
        error_percentage: 2.0,
        horizontal_misclosure: 0.2,
        vertical_misclosure: 0.15,
        strategy,
        is_aligned: false,
    }
}

fn save_to(dir: &Path, file: &str, project: &Project) -> PathBuf {
    let path = dir.join(file);
    let mut db = Database::open(&path).unwrap();
    db.save_project(project).unwrap();
    path
}

/// Source A: a datum, an intra-project merge, a legacy id-0 closure, a project
/// default north reference AND a section that declares its own, a station
/// offset, comments, an entrance elevation and a location.
fn source_alpha() -> Project {
    let mut p = Project::new("Alpha".to_string(), Some("Yucatan".to_string()));
    p.surface_elevation = Some(12.0);
    p.default_azimuth_reference = Some(AzimuthReference::magnetic(
        -4.0,
        CorrectionSource::FileDeclared,
    ));
    let a0 = p
        .add_section(section(
            "A0",
            vec![
                shot("a0-0", 10.0, 5.0, 3.0),
                shot("a0-1", 40.0, 6.5, 3.5),
                shot("a0-2", 95.0, 4.25, 4.0),
            ],
        ))
        .id;
    let a1 = p
        .add_section(section(
            "A1",
            vec![shot("a1-0", 200.0, 7.0, 4.5), shot("a1-1", 230.0, 3.0, 5.0)],
        ))
        .id;
    let a2 = p
        .add_section(section("A2", vec![shot("a2-0", 300.0, 2.0, 6.0)]))
        .id;
    if let Some(s) = p.get_section_mut(a2) {
        s.azimuth_reference = Some(AzimuthReference::magnetic(10.0, CorrectionSource::Manual));
    }
    p.record_station_merge(StationMerge {
        station_a: StationRef::new(a0, 3).into(),
        station_b: StationRef::new(a1, 0).into(),
        merged_at: fixed_time(1),
    });
    p.section_offsets.insert(a1, (5.0, -2.0));
    p.section_offsets.insert(a2, (-30.0, 12.0));
    p.station_offsets
        .insert(StationRef::new(a0, 1).into(), (0.5, -0.5, 1.0));
    p.station_comments
        .insert(StationRef::new(a0, 2).into(), "squeeze".to_string());
    p.station_comments
        .insert(StationRef::new(a1, 0).into(), "junction".to_string());
    p.store_zero_datum_without_repositioning(
        StationRef::new(a0, 0),
        GpsCoordinates::new(20.5, -87.3, 0.0).unwrap(),
    )
    .unwrap();
    p.loop_closures.push(closure(
        StationRef::new(a0, 1),
        StationRef::new(a0, 3),
        ClosureStrategy::Batch,
    ));
    p
}

/// Source B: a second datum, a cross-section closure, a DISAGREEING entrance
/// elevation (the first source's must win, with a warning) and a new location.
fn source_bravo() -> Project {
    let mut p = Project::new("Bravo".to_string(), Some("Quintana Roo".to_string()));
    p.surface_elevation = Some(15.0);
    let b0 = p
        .add_section(section(
            "B0",
            vec![shot("b0-0", 120.0, 8.0, 2.0), shot("b0-1", 150.0, 9.0, 2.5)],
        ))
        .id;
    let b1 = p
        .add_section(section(
            "B1",
            vec![shot("b1-0", 60.0, 4.0, 3.0), shot("b1-1", 20.0, 5.5, 3.25)],
        ))
        .id;
    p.record_station_merge(StationMerge {
        station_a: StationRef::new(b0, 2).into(),
        station_b: StationRef::new(b1, 0).into(),
        merged_at: fixed_time(2),
    });
    p.station_comments
        .insert(StationRef::new(b1, 1).into(), "sump".to_string());
    p.store_zero_datum_without_repositioning(
        StationRef::new(b0, 0),
        GpsCoordinates::new(20.6, -87.4, 1.5).unwrap(),
    )
    .unwrap();
    p.loop_closures.push(closure(
        StationRef::new(b0, 0),
        StationRef::new(b1, 2),
        ClosureStrategy::Batch,
    ));
    p
}

/// Source C: no datum (an unanchored island), a location the merge already
/// holds (so it is NOT appended twice), and a displaced section.
fn source_charlie() -> Project {
    let mut p = Project::new("Charlie".to_string(), Some("Yucatan".to_string()));
    let c0 = p
        .add_section(section("C0", vec![shot("c0-0", 270.0, 11.0, 7.0)]))
        .id;
    p.section_offsets.insert(c0, (100.0, 50.0));
    p
}

/// FNV-1a, 64 bit. Hand-rolled on purpose: `DefaultHasher`'s algorithm is not
/// stable across toolchains, and a digest pinned in a test has to be.
fn fnv1a64(bytes: &[u8]) -> u64 {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in bytes {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    hash
}

/// Round to 9 significant digits, so a last-bit difference in a re-solved
/// offset (a summation order the cascade does not promise) cannot move the
/// digest while any real change still does.
fn canonical_number(value: f64) -> serde_json::Value {
    if !value.is_finite() || value == 0.0 {
        return serde_json::Value::from(value);
    }
    let rounded = format!("{value:.8e}").parse::<f64>().unwrap_or(value);
    serde_json::Value::from(rounded)
}

fn canonicalize(value: &serde_json::Value) -> serde_json::Value {
    match value {
        serde_json::Value::Object(map) => serde_json::Value::Object(
            map.iter()
                .map(|(k, v)| (k.clone(), canonicalize(v)))
                .collect(),
        ),
        serde_json::Value::Array(items) => {
            serde_json::Value::Array(items.iter().map(canonicalize).collect())
        }
        serde_json::Value::Number(n) => n.as_f64().map_or_else(|| value.clone(), canonical_number),
        other => other.clone(),
    }
}

/// The merge's observable output as one comparable string: the project as
/// PERSISTED (reloaded raw, no load-time heal) plus the result's warnings.
///
/// Dropped, each because it is not the merge's doing: `created_at` /
/// `modified_at` (wall clock), `file_path` (the temp dir), and `validation`
/// (seeded from the host's global config, which is not the merge's input).
/// `station_offsets` / `station_comments` serialize from a `HashMap`, so they
/// are sorted.
fn canonical_merge_output(merged: &Project, result: &CommandResult) -> String {
    let mut value = serde_json::to_value(merged).unwrap();
    if let Some(map) = value.as_object_mut() {
        for key in ["created_at", "modified_at", "file_path", "validation"] {
            map.remove(key);
        }
        for key in ["station_offsets", "station_comments"] {
            if let Some(serde_json::Value::Array(items)) = map.get_mut(key) {
                items.sort_by_key(ToString::to_string);
            }
        }
    }
    let warnings: Vec<String> = result
        .warnings
        .iter()
        .map(|w| format!("{}: {}", w.code, w.message))
        .collect();
    format!(
        "{}\nsuccess={} warnings={warnings:?}",
        canonicalize(&value),
        result.success
    )
}

/// The digest of [`canonical_merge_output`] for the three sources above,
/// recorded on the merge loop as it stood BEFORE #674 extracted it into the
/// shared append. If this fires, merge output changed: diff the printed
/// canonical form against the previous one, and only re-pin if the change is
/// intended.
const MERGE_PARITY_DIGEST: u64 = 5_702_134_043_317_961_963;

/// #674 parity: "Merge projects" must produce exactly what it produced before
/// its per-source loop became the append that "Add .stalx" shares. Rich on
/// purpose - two datums, merges, a legacy id-0 closure, both north-reference
/// routes, offsets, comments, a disagreeing elevation and a repeated location -
/// so every branch of the loop contributes to the digest.
#[test]
fn merge_output_is_unchanged_by_the_append_extraction() {
    let temp = TempDir::new().unwrap();
    let sources = vec![
        save_to(temp.path(), "alpha.stalx", &source_alpha()),
        save_to(temp.path(), "bravo.stalx", &source_bravo()),
        save_to(temp.path(), "charlie.stalx", &source_charlie()),
    ];
    let state = AppState::new().unwrap();
    let output = temp.path().join("merged.stalx");
    let result = state.execute(Command::MergeProjects {
        source_paths: sources,
        output_path: output.clone(),
        output_name: "Parity".to_string(),
        archive_originals: false,
    });
    assert!(result.success, "merge failed: {:?}", result.error);

    let merged = Database::open_existing(&output)
        .unwrap()
        .load_project()
        .unwrap();
    assert_eq!(merged.sections.len(), 6, "every source section is merged");
    let canonical = canonical_merge_output(&merged, &result);
    assert_eq!(
        fnv1a64(canonical.as_bytes()),
        MERGE_PARITY_DIGEST,
        "merge output changed; canonical form:\n{canonical}"
    );
    // Not vacuous: the pinned form really carries what the loop copies.
    for needle in [
        "SURFACE_ELEVATION_MISMATCH",
        "Yucatan, Quintana Roo",
        "squeeze",
        "junction",
        "sump",
    ] {
        assert!(canonical.contains(needle), "canonical form lacks {needle}");
    }
    // The two datums survive with their GPS, the closures with fresh ids.
    assert_eq!(merged.zero_datums.len(), 2);
    assert_eq!(merged.loop_closures.len(), 2);
    assert!(merged.loop_closures.iter().all(|c| c.id != 0));
    assert_eq!(merged.station_merges.len(), 2);
}
