//! [#576 RV5-F4-5] An edit refused because an Ariane adoption is handing the
//! project over to SpeleoDB says so in a code the frontend can read.
//!
//! The refusal carried only `EDIT_DISABLED`, so the frontend showed its generic
//! "open read-only - click Start editing to take the write lock" notice in the
//! middle of the hand-over, which invites a Start editing that races the
//! adoption's own lock operations. It now puts `ADOPTION_IN_PROGRESS` behind
//! `EDIT_DISABLED`, the same pattern as `NEWER_FILE_READ_ONLY` and
//! `WORKSPACE_READ_ONLY`, so every caller that treats a gated refusal as
//! "read-only, not a failure" keeps doing so. All data is synthetic.

use super::AppState;
use crate::core::command::{ADOPTION_IN_PROGRESS_CODE, EDIT_DISABLED_CODE};
use crate::core::Command;
use crate::models::ShotData;

#[test]
fn an_edit_during_an_adoption_hand_over_carries_the_adoption_code() {
    let state = AppState::new().unwrap();
    assert!(
        state
            .execute(Command::CreateProject {
                name: "CaveA".to_owned(),
                location: None,
            })
            .success
    );
    state.speleodb_shut_gate_for_adoption();
    let refused = state.execute(Command::CreateSection {
        name: Some("SectionA".to_owned()),
        surveyor: None,
        date: None,
        color: "#336699".to_owned(),
        direction: None,
        shots: vec![ShotData {
            length: 5.0,
            ..Default::default()
        }],
    });
    let error = refused.error.unwrap_or_default();
    println!(
        "edit during the hand-over: success {}, error {error:?}",
        refused.success
    );
    assert!(!refused.success);
    assert!(
        error.starts_with(&format!(
            "{EDIT_DISABLED_CODE}: {ADOPTION_IN_PROGRESS_CODE}: "
        )),
        "the refusal names the adoption behind EDIT_DISABLED: {error:?}"
    );
    assert!(error.contains("handed over to SpeleoDB"));

    // Once the adoption returns, edits go through again.
    state.speleodb_open_gate_after_adoption();
    let renamed = state.update_project_settings(
        "CaveB".to_owned(),
        state.get_project_state().unwrap().validation,
        None,
    );
    assert!(renamed.success, "{:?}", renamed.error);
}
