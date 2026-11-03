//! [#576 RV6a-15] The first save of a new project carries no
//! `SIDE_TABLES_NOT_CARRIED` warning.
//!
//! That warning says "the original file could not be read": it is for a Save As
//! away from an open file whose database handle was lost and could not be
//! reopened (`save_as_unreadable_tests`). A project that was never saved has no
//! original file, so the warning was spurious on the first save of a project
//! created in memory with no file (`Command::CreateProject`). That create is a
//! test fixture only: a release build refuses the variant, it is not behind any
//! IPC command, and File > New goes through `create_project_full`, whose project
//! either has its file and handle already or is a deferred first save - both
//! pinned here as they are.
//!
//! All data is synthetic.

use std::sync::Arc;

use tempfile::TempDir;

use super::save_sidecars::SIDE_TABLES_NOT_CARRIED_CODE;
use super::AppState;
use crate::core::Command;

struct NoListener;

impl crate::core::events::EventSink for NoListener {
    fn emit(&self, _event: &str, _payload: serde_json::Value) {}

    fn with_app_state(&self, _f: Box<dyn FnOnce(&AppState) + Send>) -> bool {
        false
    }
}

/// The warning codes of `state`'s save to `dir/CaveF.stalx`.
fn first_save_codes(state: &AppState, dir: &TempDir) -> Vec<String> {
    let saved = state.execute(Command::SaveProject {
        path: Some(dir.path().join("CaveF.stalx")),
    });
    assert!(saved.success, "the save goes through: {:?}", saved.error);
    saved.warnings.into_iter().map(|w| w.code).collect()
}

#[test]
fn the_first_save_of_a_project_created_in_memory_does_not_say_a_file_was_unreadable() {
    let _cfg = crate::test_helpers::isolated_config();
    let dir = TempDir::new().unwrap();
    let state = AppState::new().unwrap();
    assert!(
        state
            .execute(Command::CreateProject {
                name: "CaveF".to_owned(),
                location: None,
            })
            .success
    );
    let codes = first_save_codes(&state, &dir);
    println!("first save of an in-memory project (no file, no handle): warnings {codes:?}");
    assert!(
        !codes.iter().any(|c| c == SIDE_TABLES_NOT_CARRIED_CODE),
        "there is no original file to have failed to read: {codes:?}"
    );
}

/// DO-NOT-REGRESS: File > New, both ways it creates (a file now, or a deferred
/// first save), saves without the warning.
#[test]
fn the_first_save_after_file_new_does_not_say_a_file_was_unreadable() {
    for deferred in [true, false] {
        let _cfg = crate::test_helpers::isolated_config();
        let dir = TempDir::new().unwrap();
        let state = AppState::new().unwrap();
        state.set_event_sink(Arc::new(NoListener));
        let created = state.do_create_project_full(
            "CaveF".to_owned(),
            None,
            None,
            Some(dir.path().join("CaveF.stalx")),
            deferred,
        );
        assert!(created.is_ok(), "File > New (deferred: {deferred})");
        let codes = first_save_codes(&state, &dir);
        println!("first save after File > New (deferred: {deferred}): warnings {codes:?}");
        assert!(
            !codes.iter().any(|c| c == SIDE_TABLES_NOT_CARRIED_CODE),
            "deferred: {deferred}: {codes:?}"
        );
    }
}
