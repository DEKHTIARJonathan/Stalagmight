//! Foreign shot identity: Ariane's `<UUID>`/`<UU>` carried through a round trip
//! (#423).
//!
//! Ariane 26 gives each `<SurveyData>` row a stable id and preserves it across
//! edits. We used to discard it and mint our own, so a file that left Ariane and
//! came back was re-identified shot by shot. These tests pin the contract at
//! each place identity could be dropped: the parse, the import, the transforms
//! that rebuild shots from `ShotData` (reverse, section split, project merge),
//! the undo payload, and the export.
//!
//! No fixture files: every `.tml`/`.tmlu` here is synthetic XML built in-test
//! and written to a temp dir that the test owns.

use std::collections::HashSet;
use std::path::Path;

use super::{AppState, VirtualShotMode};
use crate::core::Command;
use crate::export::tml::{export_tml, export_tml_for_speleodb};
use crate::models::{Project, SectionData, ShotData, StationKey, StationRef};
use crate::parsers::tml::{convert_tml_to_import_configs, parse_tml};

// ---------------------------------------------------------------------------
// Synthetic Ariane XML
// ---------------------------------------------------------------------------

/// One `<SurveyData>` row to synthesize: Ariane id, the id it hangs off, and the
/// `<UUID>` the file gives it (`None` writes no element at all).
struct Row {
    id: i64,
    from_id: i64,
    uuid: Option<&'static str>,
}

impl Row {
    fn new(id: i64, from_id: i64, uuid: Option<&'static str>) -> Self {
        Self { id, from_id, uuid }
    }
}

/// A `<SurveyData>` element. `START` rows anchor the chain; every other row is a
/// REAL shot that becomes one of our shots.
fn survey_data_xml(row: &Row, shot_type: &str, section: &str) -> String {
    let uuid = row
        .uuid
        .map(|u| format!("\n    <UUID>{u}</UUID>"))
        .unwrap_or_default();
    let (id, from_id) = (row.id, row.from_id);
    format!(
        r"<SurveyData>
    <ID>{id}</ID>{uuid}
    <FromID>{from_id}</FromID>
    <ClosureToID>-1</ClosureToID>
    <Type>{shot_type}</Type>
    <Section>{section}</Section>
    <Azimut>90.0</Azimut>
    <Length>10.0</Length>
    <Depth>5.0</Depth>
    <DepthIn>-1.0</DepthIn>
    <Inclination>0.0</Inclination>
    <Left>1.0</Left>
    <Right>2.0</Right>
    <Up>3.0</Up>
    <Down>4.0</Down>
    <Comment></Comment>
    <Explorer>Tester</Explorer>
    <Date>2026-01-02</Date>
    <Color>0x8f6112ff</Color>
    <Excluded>false</Excluded>
    <Latitude>0.0</Latitude>
    <Longitude>0.0</Longitude>
</SurveyData>"
    )
}

/// A one-section cave file: a START row plus one REAL row per entry in `rows`.
fn cave_file_xml(rows: &[Row]) -> String {
    let start = survey_data_xml(&Row::new(0, -1, None), "START", "Main");
    let body: String = rows
        .iter()
        .map(|r| survey_data_xml(r, "REAL", "Main"))
        .collect::<Vec<_>>()
        .join("\n        ");
    format!(
        r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<CaveFile>
    <caveName>Synthetic</caveName>
    <unit>m</unit>
    <useMagneticAzimuth>true</useMagneticAzimuth>
    <firstStartAbsoluteElevation>0.0</firstStartAbsoluteElevation>
    <Data>
        {start}
        {body}
    </Data>
</CaveFile>"#
    )
}

/// Write `xml` next to `dir` under `name` and hand back the path. `.tmlu` is
/// plain XML, so the parser reads it as written.
fn write_tmlu(dir: &Path, name: &str, xml: &str) -> std::path::PathBuf {
    let path = dir.join(name);
    std::fs::write(&path, xml).unwrap();
    path
}

/// The full Ariane import as the app runs it: parse the file, convert it to
/// import configs, execute the import. Mirrors `speleodb_pull::adopt_build_into`
/// and the wizard's own call.
fn import_ariane_file(state: &AppState, path: &Path) {
    let tml = parse_tml(path).unwrap();
    let (sections, closures, _warnings) = convert_tml_to_import_configs(&tml, false, true).unwrap();
    let result = state.execute_import_sections(
        sections,
        closures,
        None,
        Vec::new(),
        Vec::new(),
        VirtualShotMode::Auto,
    );
    assert!(result.success, "import failed: {:?}", result.error);
}

fn state_with_project() -> AppState {
    let state = AppState::new().unwrap();
    state.execute(Command::CreateProject {
        name: "Synthetic".to_string(),
        location: None,
    });
    state
}

/// Every shot UUID of section `index`, in section order. `None` becomes an empty
/// string so a missing identity fails an equality assertion loudly rather than
/// being skipped.
fn section_uuids(project: &Project, index: usize) -> Vec<String> {
    project.sections[index]
        .shots
        .iter()
        .map(|s| s.uuid.clone().unwrap_or_default())
        .collect()
}

// ---------------------------------------------------------------------------
// 1. Round trip
// ---------------------------------------------------------------------------

/// The file's `<UUID>` values come back out of the export verbatim, for both
/// extensions. Red at `normalize_key_bytes` before #423 (the element was
/// discarded and every shot got a fresh v4), and red again if the export ever
/// starts re-minting.
#[test]
fn ariane_shot_uuids_survive_import_then_export_verbatim() {
    const U1: &str = "11111111-1111-4111-8111-111111111111";
    const U2: &str = "22222222-2222-4222-8222-222222222222";
    const U3: &str = "33333333-3333-4333-8333-333333333333";

    for ext in ["tmlu", "tml"] {
        let dir = tempfile::tempdir().unwrap();
        let source = write_tmlu(
            dir.path(),
            "source.tmlu",
            &cave_file_xml(&[
                Row::new(1, 0, Some(U1)),
                Row::new(2, 1, Some(U2)),
                Row::new(3, 2, Some(U3)),
            ]),
        );

        let state = state_with_project();
        import_ariane_file(&state, &source);

        let project = state.get_project_state().unwrap();
        assert_eq!(
            section_uuids(&project, 0),
            vec![U1.to_string(), U2.to_string(), U3.to_string()],
            "the file's identities must be the imported shots' identities"
        );

        // Round trip back out and in again: the exported document has to carry
        // the same ids, in the same order, under whichever element spelling the
        // extension selects (`<UUID>` for .tml, `<UU>` for .tmlu).
        let exported = dir.path().join(format!("out.{ext}"));
        export_tml(&project, &exported).unwrap();
        let reparsed = parse_tml(&exported).unwrap();
        let out: Vec<String> = reparsed
            .sections
            .iter()
            .flat_map(|s| s.shots.iter())
            .filter_map(|s| s.uuid.clone())
            .collect();
        for expected in [U1, U2, U3] {
            assert!(
                out.contains(&expected.to_string()),
                ".{ext} round trip lost {expected}; got {out:?}"
            );
        }
    }
}

// ---------------------------------------------------------------------------
// 2. Partial coverage
// ---------------------------------------------------------------------------

/// Only the middle row carries an id. It must land on the middle shot - not the
/// first, not the last - and the uncovered rows must still get distinct,
/// non-empty identities of their own. Red if the carry misaligns by index.
#[test]
fn a_single_covered_shot_keeps_its_id_and_the_others_get_fresh_ones() {
    const MID: &str = "44444444-4444-4444-8444-444444444444";

    let dir = tempfile::tempdir().unwrap();
    let source = write_tmlu(
        dir.path(),
        "partial.tmlu",
        &cave_file_xml(&[
            Row::new(1, 0, None),
            Row::new(2, 1, Some(MID)),
            Row::new(3, 2, None),
        ]),
    );

    let state = state_with_project();
    import_ariane_file(&state, &source);

    let project = state.get_project_state().unwrap();
    let uuids = section_uuids(&project, 0);
    assert_eq!(uuids.len(), 3);
    assert_eq!(uuids[1], MID, "the covered shot must keep the file's id");
    assert_ne!(uuids[0], MID, "an uncovered shot must not inherit it");
    assert_ne!(uuids[2], MID, "an uncovered shot must not inherit it");
    assert!(
        !uuids[0].is_empty() && !uuids[2].is_empty(),
        "uncovered shots must still get an identity: {uuids:?}"
    );
    assert_ne!(uuids[0], uuids[2], "fresh mints must be distinct");
}

// ---------------------------------------------------------------------------
// 3. Intra-section duplicate
// ---------------------------------------------------------------------------

/// A source file that repeats an id inside one section is REPAIRED, not
/// rejected and not admitted: the FIRST occurrence keeps the foreign value and
/// the rest are re-minted, which is what `resolve_key` (first match wins) needs.
/// Red without the repair - and the import would not merely warn, it would be
/// rolled back wholesale by the `duplicate_shot_uuid` Critical violation that
/// `finalize_structural_edit` refuses to commit.
#[test]
fn a_repeated_uuid_inside_one_section_is_repaired_keeping_the_first() {
    const DUP: &str = "55555555-5555-4555-8555-555555555555";

    let dir = tempfile::tempdir().unwrap();
    let source = write_tmlu(
        dir.path(),
        "dup.tmlu",
        &cave_file_xml(&[
            Row::new(1, 0, Some(DUP)),
            Row::new(2, 1, Some(DUP)),
            Row::new(3, 2, Some(DUP)),
        ]),
    );

    let state = state_with_project();
    import_ariane_file(&state, &source);

    let project = state.get_project_state().unwrap();
    let uuids = section_uuids(&project, 0);
    assert_eq!(uuids.len(), 3);
    assert_eq!(uuids[0], DUP, "the FIRST occurrence keeps the foreign id");
    assert_ne!(uuids[1], DUP, "the second must be re-minted");
    assert_ne!(uuids[2], DUP, "the third must be re-minted");
    assert_eq!(
        uuids.iter().collect::<HashSet<_>>().len(),
        3,
        "all three identities must differ: {uuids:?}"
    );
    let dupes: Vec<_> = project
        .check_structural_integrity()
        .into_iter()
        .filter(|v| v.category == "duplicate_shot_uuid")
        .collect();
    assert!(
        dupes.is_empty(),
        "import must not leave a duplicate_shot_uuid violation: {dupes:?}"
    );
}

// ---------------------------------------------------------------------------
// 4. Reverse on import
// ---------------------------------------------------------------------------

/// The import-time reverse (#24) moves each shot to the mirrored position.
/// Identity travels inside the `ShotData` being reversed, so it moves with its
/// own shot - the failure a parallel id vector would have had to keep in step by
/// hand. Red if identity ever stops travelling in the payload.
#[test]
fn the_import_reverse_carries_each_id_with_its_own_shot() {
    const FIRST: &str = "66666666-6666-4666-8666-666666666666";
    const LAST: &str = "77777777-7777-4777-8777-777777777777";

    let dir = tempfile::tempdir().unwrap();
    let source = write_tmlu(
        dir.path(),
        "reverse.tmlu",
        &cave_file_xml(&[
            Row::new(1, 0, Some(FIRST)),
            Row::new(2, 1, None),
            Row::new(3, 2, Some(LAST)),
        ]),
    );

    let state = state_with_project();
    let tml = parse_tml(&source).unwrap();
    let (mut sections, closures, _warnings) =
        convert_tml_to_import_configs(&tml, false, true).unwrap();
    sections[0].reverse = true;
    let result = state.execute_import_sections(
        sections,
        closures,
        None,
        Vec::new(),
        Vec::new(),
        VirtualShotMode::Auto,
    );
    assert!(result.success, "import failed: {:?}", result.error);

    let project = state.get_project_state().unwrap();
    let uuids = section_uuids(&project, 0);
    assert_eq!(uuids.len(), 3);
    assert_eq!(uuids[0], LAST, "the file's last id must be first now");
    assert_eq!(uuids[2], FIRST, "the file's first id must be last now");
}

// ---------------------------------------------------------------------------
// 5. Section split
// ---------------------------------------------------------------------------

/// Splitting a section keeps the foreign ids on BOTH halves (section B is
/// rebuilt from `to_shot_data`), and every station cross-reference still points
/// at the same physical station it did before.
///
/// This is also what pins the split's positional remap as still necessary. A
/// `StationKey` is `(section_id, anchor)`, so a preserved uuid alone cannot
/// follow a shot into the NEW section: drop the remap and the B-half comment's
/// key keeps naming section A, where its anchoring shot no longer exists, and
/// resolves to `None`.
#[test]
fn a_section_split_preserves_the_foreign_ids_and_the_cross_references_of_both_halves() {
    const IDS: [&str; 5] = [
        "aaaaaaaa-0000-4000-8000-000000000001",
        "aaaaaaaa-0000-4000-8000-000000000002",
        "aaaaaaaa-0000-4000-8000-000000000003",
        "aaaaaaaa-0000-4000-8000-000000000004",
        "aaaaaaaa-0000-4000-8000-000000000005",
    ];

    let dir = tempfile::tempdir().unwrap();
    let source = write_tmlu(
        dir.path(),
        "split.tmlu",
        &cave_file_xml(&[
            Row::new(1, 0, Some(IDS[0])),
            Row::new(2, 1, Some(IDS[1])),
            Row::new(3, 2, Some(IDS[2])),
            Row::new(4, 3, Some(IDS[3])),
            Row::new(5, 4, Some(IDS[4])),
        ]),
    );

    let state = state_with_project();
    import_ariane_file(&state, &source);

    let section_id = state.get_project_state().unwrap().sections[0].id;
    // One cross-reference on each side of the coming split: station 1 stays in
    // A, station 4 moves into B.
    for (index, text) in [(1u32, "stays in A"), (4u32, "moves into B")] {
        let r = state.execute(Command::SetStationComment {
            station_ref: StationRef::new(section_id, index),
            comment: Some(text.to_string()),
        });
        assert!(r.success, "{:?}", r.error);
    }

    // Where each stored comment key physically sits before the split.
    let before = state.get_project_state().unwrap();
    let coords_before = |p: &Project, key: &StationKey| {
        let sr = p.resolve_key(key).expect("comment key resolves");
        p.compute_station_coordinates()
            .into_iter()
            .find(|s| s.station_ref == sr)
            .expect("resolved station has coordinates")
            .coordinates
    };
    let anchored: Vec<(StationKey, String, _)> = before
        .station_comments
        .iter()
        .map(|(k, text)| (k.clone(), text.clone(), coords_before(&before, k)))
        .collect();
    assert_eq!(anchored.len(), 2);

    // Split at the middle shot (index 2): A keeps shots 0..2, the shot at 2 is
    // deleted, B receives shots 3..5.
    let mid = before.sections[0].shots[2].id;
    let r = state.execute_delete_shot_and_split(section_id, mid, "A".to_string(), "B".to_string());
    assert!(r.success, "{:?}", r.error);

    let after = state.get_project_state().unwrap();
    assert_eq!(after.sections.len(), 2);
    assert_eq!(
        section_uuids(&after, 0),
        vec![IDS[0].to_string(), IDS[1].to_string()],
        "the A half lost its foreign ids"
    );
    assert_eq!(
        section_uuids(&after, 1),
        vec![IDS[3].to_string(), IDS[4].to_string()],
        "the B half lost its foreign ids - the case the side-channel design gave up on"
    );

    // Every cross-reference still resolves, and to the same physical station.
    assert_eq!(after.station_comments.len(), 2);
    for (_, text, coords) in &anchored {
        let (key, _) = after
            .station_comments
            .iter()
            .find(|(_, t)| *t == text)
            .unwrap_or_else(|| panic!("comment {text:?} disappeared across the split"));
        let sr = after
            .resolve_key(key)
            .unwrap_or_else(|| panic!("comment {text:?} dangles after the split"));
        let now = after
            .compute_station_coordinates()
            .into_iter()
            .find(|s| s.station_ref == sr)
            .expect("resolved station has coordinates")
            .coordinates;
        let moved = (now.x - coords.x).abs() + (now.y - coords.y).abs() + (now.z - coords.z).abs();
        assert!(
            moved < 1e-9,
            "comment {text:?} re-anchored onto a different station: {coords:?} -> {now:?}"
        );
    }
}

// ---------------------------------------------------------------------------
// 6. Project merge
// ---------------------------------------------------------------------------

/// Two projects that each imported the same Ariane file hold the same foreign
/// ids in different sections. Uniqueness in this model is per-SECTION, so that
/// is legal and the merge must leave both copies alone. Red on the old
/// project-wide dedupe, which re-minted the second project's whole section.
#[test]
fn merging_two_projects_that_imported_one_file_keeps_both_copies_of_its_ids() {
    const IDS: [&str; 3] = [
        "bbbbbbbb-0000-4000-8000-000000000001",
        "bbbbbbbb-0000-4000-8000-000000000002",
        "bbbbbbbb-0000-4000-8000-000000000003",
    ];

    // What an Ariane import produces: shots whose ShotData already carries the
    // file's ids.
    let imported_project = |name: &str| {
        let mut project = Project::new(name.to_string(), None);
        project.add_section(SectionData {
            name: Some("Main".to_string()),
            shots: IDS
                .iter()
                .map(|u| ShotData {
                    uuid: Some((*u).to_string()),
                    azimuth_in: 90.0,
                    azimuth_out: 90.0,
                    length: 10.0,
                    depth_in: 5.0,
                    depth_out: 5.0,
                    ..Default::default()
                })
                .collect(),
            ..Default::default()
        });
        project
    };

    let a = imported_project("A");
    let b = imported_project("B");
    assert_eq!(section_uuids(&a, 0), IDS.map(String::from).to_vec());

    let (db_a, _keep_a) = crate::test_helpers::TestDb::with_project(&a).unwrap();
    let (db_b, _keep_b) = crate::test_helpers::TestDb::with_project(&b).unwrap();
    let out_dir = tempfile::tempdir().unwrap();
    let out = out_dir.path().join("merged.stalx");

    let state = AppState::new().unwrap();
    let result = state.merge_projects(
        vec![db_a.path().to_path_buf(), db_b.path().to_path_buf()],
        out.clone(),
        "Merged".to_string(),
        false,
    );
    assert!(result.success, "merge failed: {:?}", result.error);

    // The merge writes the output file rather than opening it, so read it back.
    let merged = crate::persistence::Database::open_existing(&out)
        .unwrap()
        .load_project()
        .unwrap();
    assert_eq!(merged.sections.len(), 2, "both sections must survive");
    let expected = IDS.map(String::from).to_vec();
    assert_eq!(
        section_uuids(&merged, 0),
        expected,
        "the first source's foreign ids must survive the merge"
    );
    assert_eq!(
        section_uuids(&merged, 1),
        expected,
        "the second source's foreign ids must survive too - a cross-section \
         repeat is legal, and re-minting throws away the identity the import kept"
    );
}

// ---------------------------------------------------------------------------
// 7. Non-canonical spellings
// ---------------------------------------------------------------------------

/// `Shot::uuid` is no longer guaranteed to be a v4 we minted, so the two export
/// profiles diverge on purpose. The user-facing file writes whatever the source
/// said, verbatim. The SpeleoDB sidecar re-spells what it accepts into the
/// `8-4-4-4-12` form its `UUID4` field requires, and drops what it does not
/// (a nil uuid is not a v4).
#[test]
fn the_user_export_is_verbatim_while_the_speleodb_sidecar_canonicalises_or_drops() {
    const BRACED: &str = "{cccccccc-0000-4000-8000-000000000001}";
    const HYPHENLESS: &str = "cccccccc000040008000000000000002";
    const NIL: &str = "00000000-0000-0000-0000-000000000000";

    let mut project = Project::new("Spellings".to_string(), None);
    project.add_section(SectionData {
        name: Some("Main".to_string()),
        shots: [BRACED, HYPHENLESS, NIL]
            .iter()
            .map(|u| ShotData {
                uuid: Some((*u).to_string()),
                azimuth_in: 90.0,
                azimuth_out: 90.0,
                length: 10.0,
                depth_in: 5.0,
                depth_out: 5.0,
                ..Default::default()
            })
            .collect(),
        ..Default::default()
    });
    assert_eq!(
        section_uuids(&project, 0),
        vec![BRACED.to_string(), HYPHENLESS.to_string(), NIL.to_string()],
        "the model stores what it was given, un-coerced"
    );

    let dir = tempfile::tempdir().unwrap();
    let user = dir.path().join("user.tmlu");
    export_tml(&project, &user).unwrap();
    let user_xml = std::fs::read_to_string(&user).unwrap();
    for raw in [BRACED, HYPHENLESS, NIL] {
        assert!(
            user_xml.contains(&format!("<UU>{raw}</UU>")),
            "the user export must not rewrite {raw}"
        );
    }

    let sidecar = dir.path().join("sidecar.tmlu");
    export_tml_for_speleodb(&project, &sidecar).unwrap();
    let sidecar_xml = std::fs::read_to_string(&sidecar).unwrap();
    assert!(
        sidecar_xml.contains("<UU>cccccccc-0000-4000-8000-000000000001</UU>"),
        "the sidecar must canonicalise the braced form"
    );
    assert!(
        sidecar_xml.contains("<UU>cccccccc-0000-4000-8000-000000000002</UU>"),
        "the sidecar must canonicalise the hyphenless form"
    );
    assert!(
        !sidecar_xml.contains(BRACED),
        "the braced spelling would fail the server's UUID4 field"
    );
    assert!(
        !sidecar_xml.contains(NIL),
        "a nil uuid is not a v4 and must be omitted from the sidecar"
    );
}

// ---------------------------------------------------------------------------
// 8. Adoption is idempotent
// ---------------------------------------------------------------------------

/// Adopting the same Ariane file twice must give the same shot identities.
/// `speleodb_pull::adopt_build_into` re-imports `ariane.tml` from scratch, so
/// before the file's `<UUID>` was read back every adoption re-identified every
/// shot - the user-visible churn in the issue.
///
/// The assertion runs the identity-deciding pipeline (`parse_tml` ->
/// `convert_tml_to_import_configs` -> `execute_import_sections`) twice on the
/// same file. `adopt_build_into` itself cannot be called from a unit test: it
/// goes through `do_create_project_full`, which requires a real `AppHandle`
/// (`tauri::test::mock_app` yields a `MockRuntime` handle, which `AppState`
/// cannot hold). The tripwire below therefore pins that adoption really is that
/// pipeline, so this test cannot pass while the shipped path diverges from it.
///
/// Full `<UUID>` coverage is load-bearing: an uncovered row legitimately mints
/// per adoption, so a mixed file could only be compared over its covered subset.
#[test]
fn adopting_the_same_ariane_file_twice_gives_the_same_shot_uuids() {
    const IDS: [&str; 3] = [
        "eeeeeeee-0000-4000-8000-000000000001",
        "eeeeeeee-0000-4000-8000-000000000002",
        "eeeeeeee-0000-4000-8000-000000000003",
    ];

    let dir = tempfile::tempdir().unwrap();
    let source = write_tmlu(
        dir.path(),
        "ariane.tmlu",
        &cave_file_xml(&[
            Row::new(1, 0, Some(IDS[0])),
            Row::new(2, 1, Some(IDS[1])),
            Row::new(3, 2, Some(IDS[2])),
        ]),
    );

    let adopt_once = || {
        let state = state_with_project();
        import_ariane_file(&state, &source);
        section_uuids(&state.get_project_state().unwrap(), 0)
    };

    let first = adopt_once();
    let second = adopt_once();
    assert_eq!(
        first,
        IDS.map(String::from).to_vec(),
        "an adopted project must carry the file's own shot ids"
    );
    assert_eq!(
        first, second,
        "re-adopting the same file must not re-identify its shots"
    );
}

/// Tripwire for the test above: `adopt_build_into` must keep building the
/// project through the same three calls the idempotence test drives. If it grows
/// its own import path, the idempotence claim stops being tested and this fails
/// loudly instead.
#[test]
fn adoption_still_builds_through_the_pipeline_the_idempotence_test_drives() {
    let path = format!(
        "{}/src/core/state/speleodb_pull.rs",
        env!("CARGO_MANIFEST_DIR")
    );
    let src = std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("read {path}: {e}"));
    let start = src
        .find("fn adopt_build_into")
        .expect("adopt_build_into is still defined in speleodb_pull.rs");
    let body = &src[start..];
    let body = &body[..body.find("\n    }\n").expect("fn body terminates")];
    for call in [
        "parsers::tml::parse_tml",
        "parsers::tml::convert_tml_to_import_configs",
        "execute_import_sections",
    ] {
        assert!(
            body.contains(call),
            "adopt_build_into no longer calls {call}; the adoption-idempotence \
             test is driving a pipeline the shipped path does not use"
        );
    }
}

// ---------------------------------------------------------------------------
// 9. Undo
// ---------------------------------------------------------------------------

/// Identity now travels in the undo payload, so both undo paths must give back
/// the SAME ids rather than fresh ones: the per-shot restore (which replays a
/// `ShotData` plus the uuid the entry recorded beside it) and the import's
/// snapshot undo/redo.
#[test]
fn undo_restores_the_imported_identities_rather_than_minting_new_ones() {
    const IDS: [&str; 3] = [
        "dddddddd-0000-4000-8000-000000000001",
        "dddddddd-0000-4000-8000-000000000002",
        "dddddddd-0000-4000-8000-000000000003",
    ];

    let dir = tempfile::tempdir().unwrap();
    let source = write_tmlu(
        dir.path(),
        "undo.tmlu",
        &cave_file_xml(&[
            Row::new(1, 0, Some(IDS[0])),
            Row::new(2, 1, Some(IDS[1])),
            Row::new(3, 2, Some(IDS[2])),
        ]),
    );

    let state = state_with_project();
    import_ariane_file(&state, &source);
    let expected = IDS.map(String::from).to_vec();
    assert_eq!(
        section_uuids(&state.get_project_state().unwrap(), 0),
        expected
    );

    // Leg 1: delete a shot and undo it. The restored shot must come back with
    // the file's id, not a new one.
    let (section_id, mid_shot_id) = {
        let p = state.get_project_state().unwrap();
        (p.sections[0].id, p.sections[0].shots[1].id)
    };
    let r = state.execute(Command::DeleteShot {
        section_id,
        shot_id: mid_shot_id,
    });
    assert!(r.success, "{:?}", r.error);
    let undone = state.undo();
    assert!(undone.success, "{:?}", undone.error);
    assert_eq!(
        section_uuids(&state.get_project_state().unwrap(), 0),
        expected,
        "undoing a shot delete must restore the shot's own identity"
    );

    // Leg 2: undo the import itself, then redo it.
    let undone = state.undo();
    assert!(undone.success, "{:?}", undone.error);
    assert!(
        state.get_project_state().unwrap().sections.is_empty(),
        "undoing the import must remove the imported section"
    );
    let redone = state.redo();
    assert!(redone.success, "{:?}", redone.error);
    assert_eq!(
        section_uuids(&state.get_project_state().unwrap(), 0),
        expected,
        "redoing the import must bring back the file's identities, not fresh mints"
    );
}
