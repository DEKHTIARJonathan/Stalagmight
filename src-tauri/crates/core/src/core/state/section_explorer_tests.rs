use super::AppState;
use crate::core::Command;
use crate::models::{SectionId, SectionUpdates, ShotData};

fn seeded_state() -> (AppState, SectionId) {
    let state = AppState::new().unwrap();
    assert!(
        state
            .execute(Command::CreateProject {
                name: "Explorer metadata".into(),
                location: None
            })
            .success
    );
    let result = state.execute(Command::CreateSection {
        name: Some("Synthetic section".into()),
        surveyor: Some("Survey team".into()),
        date: None,
        color: "#4ecdc4".into(),
        direction: None,
        shots: vec![
            ShotData {
                length: 10.0,
                azimuth_in: 90.0,
                azimuth_out: 90.0,
                ..Default::default()
            };
            3
        ],
    });
    assert!(result.success);
    (state, result.section_id.unwrap())
}

fn set_explorer(state: &AppState, section_id: SectionId, explorer: Option<&str>) {
    let result = state.execute(Command::UpdateSectionMetadata {
        section_id,
        updates: SectionUpdates {
            explorer: Some(explorer.map(str::to_string)),
            ..Default::default()
        },
    });
    assert!(result.success, "{:?}", result.error);
}

#[expect(
    clippy::unwrap_in_result,
    reason = "missing project or section must fail rather than masquerade as an unset explorer"
)]
fn explorer(state: &AppState, section_id: SectionId) -> Option<String> {
    state
        .get_project_state()
        .unwrap()
        .get_section(section_id)
        .unwrap()
        .explorer
        .clone()
}

#[test]
fn explorer_is_independent_nullable_and_undoable() {
    let (state, id) = seeded_state();
    assert_eq!(explorer(&state, id), None);
    set_explorer(&state, id, Some("Explorer team"));
    assert_eq!(explorer(&state, id).as_deref(), Some("Explorer team"));
    assert_eq!(
        state
            .get_project_state()
            .unwrap()
            .get_section(id)
            .unwrap()
            .surveyor
            .as_deref(),
        Some("Survey team")
    );
    assert!(state.undo().success);
    assert_eq!(explorer(&state, id), None);
    assert!(state.redo().success);
    assert_eq!(explorer(&state, id).as_deref(), Some("Explorer team"));
    let clear: SectionUpdates = serde_json::from_str(r#"{"explorer":null}"#).unwrap();
    assert_eq!(clear.explorer, Some(None));
    assert!(
        state
            .execute(Command::UpdateSectionMetadata {
                section_id: id,
                updates: clear
            })
            .success
    );
    assert_eq!(explorer(&state, id), None);
    assert!(state.undo().success);
    assert_eq!(explorer(&state, id).as_deref(), Some("Explorer team"));
}

#[test]
fn explorer_survives_save_reopen_and_persisted_metadata_undo() {
    let (state, id) = seeded_state();
    set_explorer(&state, id, Some("Explorer team"));
    let temp = tempfile::TempDir::new().unwrap();
    let path = temp.path().join("explorer.stalx");
    assert!(state.save_project(Some(path.clone())).success);
    let reopened = AppState::new().unwrap();
    assert!(reopened.open_project(path).success);
    assert_eq!(explorer(&reopened, id).as_deref(), Some("Explorer team"));
    assert!(reopened.undo().success);
    assert_eq!(explorer(&reopened, id), None);
    assert!(reopened.redo().success);
    assert_eq!(explorer(&reopened, id).as_deref(), Some("Explorer team"));
    assert!(
        reopened
            .execute(Command::DeleteSection { section_id: id })
            .success
    );
    assert!(reopened.undo().success);
    assert_eq!(explorer(&reopened, id).as_deref(), Some("Explorer team"));
}

#[test]
fn native_split_copies_explorer_to_both_halves() {
    let (state, id) = seeded_state();
    set_explorer(&state, id, Some("Explorer team"));
    let middle = state
        .get_project_state()
        .unwrap()
        .get_section(id)
        .unwrap()
        .shots[1]
        .id;
    assert!(
        state
            .execute_delete_shot_and_split(id, middle, "A".into(), "B".into())
            .success
    );
    let project = state.get_project_state().unwrap();
    assert_eq!(project.sections.len(), 2);
    assert!(project
        .sections
        .iter()
        .all(|section| section.explorer.as_deref() == Some("Explorer team")));
    assert!(state.undo().success);
    assert_eq!(explorer(&state, id).as_deref(), Some("Explorer team"));
    assert!(state.redo().success);
    assert!(state
        .get_project_state()
        .unwrap()
        .sections
        .iter()
        .all(|section| section.explorer.as_deref() == Some("Explorer team")));
}

#[test]
fn merging_projects_preserves_each_explorer() {
    let temp = tempfile::TempDir::new().unwrap();
    let mut paths = Vec::new();
    for (index, name) in ["Explorer A", "Explorer B"].iter().enumerate() {
        let (state, id) = seeded_state();
        set_explorer(&state, id, Some(name));
        let path = temp.path().join(format!("source-{index}.stalx"));
        assert!(state.save_project(Some(path.clone())).success);
        paths.push(path);
    }
    let state = AppState::new().unwrap();
    let output = temp.path().join("merged.stalx");
    let result = state.merge_projects(paths, output.clone(), "Merged".into(), false);
    assert!(result.success, "{:?}", result.error);
    let db = crate::persistence::Database::open(&output).unwrap();
    let project = db.load_project().unwrap();
    let names: Vec<_> = project
        .sections
        .iter()
        .map(|section| section.explorer.as_deref())
        .collect();
    assert_eq!(names, vec![Some("Explorer A"), Some("Explorer B")]);
}

#[test]
fn legacy_file_without_explorer_metadata_defaults_none_and_keeps_surveyor() {
    let (state, id) = seeded_state();
    let temp = tempfile::TempDir::new().unwrap();
    let path = temp.path().join("legacy-explorer.stalx");
    assert!(state.save_project(Some(path.clone())).success);
    let connection = rusqlite::Connection::open(&path).unwrap();
    connection
        .execute(
            "DELETE FROM project_settings WHERE key = 'section_explorers'",
            [],
        )
        .unwrap();
    drop(connection);
    let reopened = AppState::new().unwrap();
    assert!(reopened.open_project(path).success);
    assert_eq!(explorer(&reopened, id), None);
    assert_eq!(
        reopened
            .get_project_state()
            .unwrap()
            .get_section(id)
            .unwrap()
            .surveyor
            .as_deref(),
        Some("Survey team")
    );
}
