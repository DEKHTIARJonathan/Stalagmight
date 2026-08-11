//! [#555] A project may not mint more section ids than the shot-id encode has
//! room for.
//!
//! A shot id is `section_id * FEATURE_ID_STRIDE + position` in `u32`, so the
//! last usable section id is [`MAX_SECTION_ID`] (42_948) and the last usable
//! COUNT is [`MAX_SECTIONS_IN_ID_SPACE`] (42_949). `Section::new` computes
//! `next_shot_id = id * FEATURE_ID_STRIDE` unchecked, so a section minted past
//! the bound panics in debug and wraps in release, and a wrapped base ALIASES
//! distinct shots onto one id.
//!
//! Only the TML cut budget was bounded before this (`linearize::cut_budget`),
//! which covers exactly one way of reaching the boundary. The three places that
//! actually MINT ids are pinned here: `create_section` (the per-section door
//! every command comes through), `execute_import_sections_inner` (the batch
//! door every importer comes through), and `merge_projects`.
//!
//! The setup is deliberately arithmetic rather than 42k real sections:
//! `next_section_id` is the project's own record of how many ids are spent, so
//! setting it directly states the same precondition 42_948 creates would, and
//! the boundary is what is under test, not the loop that reaches it. The merge
//! test is the exception - its check sums the SOURCES' section counts, which
//! nothing but real sections can supply.

use tempfile::TempDir;

use super::{AppState, VirtualShotMode};
use crate::core::{Command, CommandResult};
use crate::models::{
    ImportPlacement, ImportSectionConfig, Project, SectionData, ShotData, MAX_SECTIONS_IN_ID_SPACE,
    MAX_SECTION_ID,
};
use crate::persistence::Database;

fn shot(length: f64) -> ShotData {
    ShotData {
        azimuth_in: 45.0,
        azimuth_out: 225.0,
        length,
        depth_in: 10.0,
        depth_out: 11.0,
        ..Default::default()
    }
}

/// A project whose id counter says `spent` ids have been handed out, with no
/// sections to show for them. Everything under test reads the counter, not the
/// section list.
fn state_with_spent_section_ids(spent: u32) -> AppState {
    let mut project = Project::new("Bound".to_string(), None);
    project.next_section_id = spent;
    let state = AppState::new().unwrap();
    state.set_project_for_tests(project);
    state
}

fn create_one_section(state: &AppState) -> CommandResult {
    state.execute(Command::CreateSection {
        name: Some("S".to_string()),
        surveyor: None,
        date: None,
        color: "#4ecdc4".to_string(),
        direction: None,
        shots: vec![shot(5.0)],
    })
}

fn import_config(index: u32) -> ImportSectionConfig {
    ImportSectionConfig {
        reverse: false,
        section_index: index,
        name: Some(format!("Imported {index}")),
        surveyor: None,
        date: None,
        color: "#ff0000".to_string(),
        direction: None,
        quality: 1.0,
        shots: vec![shot(3.0)],
        station_comments: Vec::new(),
        placement: ImportPlacement::Origin,
        azimuth_reference: None,
    }
}

/// The LAST id is usable: 42_948 * 100_000 + 99_999 = 4_294_899_999, which
/// still fits `u32`. An off-by-one guard would refuse this one.
#[test]
fn the_last_encodable_section_id_is_still_minted() {
    let state = state_with_spent_section_ids(MAX_SECTION_ID);

    let result = create_one_section(&state);

    assert!(
        result.success,
        "id {MAX_SECTION_ID} still encodes and must be allowed: {:?}",
        result.error
    );
    assert_eq!(
        result.section_id,
        Some(MAX_SECTION_ID),
        "the section minted must BE the last encodable id"
    );
}

/// One past it is refused, instead of `Section::new` panicking on the debug
/// multiply or wrapping in release.
#[test]
fn minting_one_section_past_the_encode_is_refused() {
    let state = state_with_spent_section_ids(MAX_SECTION_ID + 1);

    let result = create_one_section(&state);

    assert!(
        !result.success,
        "section id {} cannot hold shots and must be refused",
        MAX_SECTION_ID + 1
    );
    let error = result.error.unwrap_or_default();
    assert!(
        error.contains("maximum number of sections")
            && error.contains(&MAX_SECTIONS_IN_ID_SPACE.to_string()),
        "the refusal must name the limit, got: {error}"
    );
    let project = state.get_project_state().unwrap();
    assert!(
        project.sections.is_empty(),
        "a refused create must not leave a section behind"
    );
}

/// An import is refused as a WHOLE when its section count would cross the
/// bound, before any mutation - not part-way through the loop, and not with a
/// rollback after the work. One id is left here and the file declares two.
#[test]
fn an_import_that_would_cross_the_bound_is_refused_atomically() {
    let state = state_with_spent_section_ids(MAX_SECTION_ID);

    let result = state.execute_import_sections(
        vec![import_config(0), import_config(1)],
        Vec::new(),
        None,
        Vec::new(),
        Vec::new(),
        VirtualShotMode::Auto,
    );

    assert!(!result.success, "2 sections do not fit into 1 remaining id");
    let error = result.error.unwrap_or_default();
    assert!(
        error.contains("would add 2 sections"),
        "the refusal must name what the file declares, got: {error}"
    );
    assert!(
        error.contains(&MAX_SECTION_ID.to_string())
            && error.contains(&MAX_SECTIONS_IN_ID_SPACE.to_string()),
        "the refusal must name how many ids are spent and the limit, got: {error}"
    );

    let project = state.get_project_state().unwrap();
    assert!(
        project.sections.is_empty(),
        "nothing may be created by a refused import"
    );
    assert_eq!(
        project.next_section_id, MAX_SECTION_ID,
        "and no id may be spent by it either"
    );
    assert!(
        !state.can_undo(),
        "a refused import is not an undoable unit"
    );
}

/// The same import, one section smaller, lands: the batch check is exact, not
/// a conservative margin.
#[test]
fn an_import_that_exactly_fills_the_id_space_is_accepted() {
    let state = state_with_spent_section_ids(MAX_SECTION_ID);

    let result = state.execute_import_sections(
        vec![import_config(0)],
        Vec::new(),
        None,
        Vec::new(),
        Vec::new(),
        VirtualShotMode::Auto,
    );

    assert!(result.success, "import failed: {:?}", result.error);
    let project = state.get_project_state().unwrap();
    assert_eq!(
        project.sections.iter().map(|s| s.id).collect::<Vec<_>>(),
        vec![MAX_SECTION_ID],
        "the last id in the space is spent, exactly once"
    );
}

/// A merge whose sources hold more sections between them than the id space
/// allows is refused before any section is appended, and writes no output file.
///
/// Real sections, because the check sums the sources' section counts - the one
/// place in this file where the id counter cannot stand in for them. They are
/// empty (no shots) so the cost is one row each.
#[test]
fn a_merge_past_the_id_space_is_refused_and_writes_no_output() {
    fn source(name: &str, sections: usize, dir: &TempDir) -> std::path::PathBuf {
        let mut project = Project::new(name.to_string(), None);
        for _ in 0..sections {
            project.add_section(SectionData {
                color: "#4ecdc4".to_string(),
                ..Default::default()
            });
        }
        let path = dir.path().join(format!("{name}.stalx"));
        let mut db = Database::open(&path).unwrap();
        db.save_project(&project).unwrap();
        drop(db);
        path
    }

    let temp_dir = TempDir::new().unwrap();
    // 42_949 + 1: the smallest pair that crosses the bound at all.
    let source_a = source("a", MAX_SECTIONS_IN_ID_SPACE, &temp_dir);
    let source_b = source("b", 1, &temp_dir);
    let output_path = temp_dir.path().join("merged.stalx");

    let state = AppState::new().unwrap();
    let result = state.execute(Command::MergeProjects {
        source_paths: vec![source_a, source_b],
        output_path: output_path.clone(),
        output_name: "Merged".to_string(),
        archive_originals: false,
    });

    assert!(!result.success, "the merged project cannot hold that many");
    let error = result.error.unwrap_or_default();
    assert!(
        error.contains(&(MAX_SECTIONS_IN_ID_SPACE + 1).to_string())
            && error.contains(&MAX_SECTIONS_IN_ID_SPACE.to_string()),
        "the refusal must name the combined count and the limit, got: {error}"
    );
    assert!(
        !output_path.exists(),
        "a refused merge must leave no output file"
    );
    assert!(
        !output_path.with_extension("stalx.tmp").exists(),
        "nor a temp file"
    );
}
