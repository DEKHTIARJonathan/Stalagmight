//! RED regression tests for the open undo/redo bugs the agent-harness fuzzer
//! found (`e2e/agent/scenarios/undoRedoFuzz.ts`, whose header carries the
//! per-bug repro commands and root causes).
//!
//! # The rule
//!
//! Every test here is `#[ignore]`d with the bug it pins, so the default suite
//! stays green while `cargo test -- --ignored` runs them RED. They are not
//! aspirational: each one fails today, on the mechanism named in its `#[ignore]`
//! reason. **When a bug is fixed, delete the `#[ignore]` and the test becomes
//! its regression guard** - that is the whole point of committing them failing.
//!
//! A test that starts passing while still `#[ignore]`d means the bug was fixed
//! incidentally; un-ignore it rather than deleting it.
//!
//! # Data
//!
//! Everything is built in code. No fixture is read, copied or derived from.

#![expect(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::indexing_slicing,
    reason = "test module: see docs/linting.md for the per-test-module expect idiom"
)]

use std::path::PathBuf;

use tempfile::TempDir;

use super::AppState;
use crate::core::Command;
use crate::models::{
    ClosureStrategy, Coordinates, GpsCoordinates, SectionId, SectionUpdates, ShotData, ShotId,
    ShotKind, ShotUpdates, StationRef,
};

/// A shot with distinct, easily-recognised geometry.
fn shot(azimuth: f64, length: f64) -> ShotData {
    ShotData {
        azimuth_in: azimuth,
        azimuth_out: azimuth,
        length,
        depth_in: 0.0,
        depth_out: 0.0,
        ..Default::default()
    }
}

/// An `AppState` with an empty project open, ready for commands.
fn state_with_project() -> AppState {
    let state = AppState::new().unwrap();
    let result = state.execute(Command::CreateProject {
        name: "OpenUndoBugs".to_string(),
        location: None,
    });
    assert!(result.success, "CreateProject failed: {:?}", result.error);
    state
}

/// Create a section with `shots` and return its id.
fn create_section(state: &AppState, name: &str, shots: Vec<ShotData>) -> SectionId {
    let result = state.execute(Command::CreateSection {
        name: Some(name.to_string()),
        surveyor: None,
        date: None,
        color: "#3388FF".to_string(),
        direction: None,
        shots,
    });
    assert!(result.success, "CreateSection failed: {:?}", result.error);
    result
        .section_id
        .expect("CreateSection returned no section id")
}

/// Every shot uuid in `section_id`, in order.
fn shot_uuids(state: &AppState, section_id: SectionId) -> Vec<Option<String>> {
    let project = state.get_project_state().expect("no project open");
    project
        .sections
        .iter()
        .find(|section| section.id == section_id)
        .expect("section missing")
        .shots
        .iter()
        .map(|s| s.uuid.clone())
        .collect()
}

/// Every shot id in `section_id`, in order.
fn shot_ids(state: &AppState, section_id: SectionId) -> Vec<ShotId> {
    let project = state.get_project_state().expect("no project open");
    project
        .sections
        .iter()
        .find(|section| section.id == section_id)
        .expect("section missing")
        .shots
        .iter()
        .map(|s| s.id)
        .collect()
}

// ===========================================================================
// Bug 1: redo of CreateSection re-mints every shot uuid
// ===========================================================================

/// `UndoData::CreatedSectionSnapshot` stores a `SectionData`, which has no uuid
/// field, so redo goes `restore_section` -> `Section::new_with_id` ->
/// `Section::new` -> `add_shot` -> `Shot::new` -> `Uuid::new_v4()`. The sibling
/// `CreateShot` path was explicitly fixed for this exact reason
/// (`UndoData::CreatedShotSnapshot { uuid }`), because a fresh uuid dangles
/// every `StationKey::AfterShot` anchor and the Ariane export identity.
#[test]
#[ignore = "open bug 1: redo of CreateSection re-mints shot uuids - see e2e/agent/scenarios/undoRedoFuzz.ts header"]
fn redo_of_create_section_preserves_shot_uuids() {
    let state = state_with_project();
    let section_id = create_section(&state, "Main", vec![shot(0.0, 5.0), shot(90.0, 4.0)]);

    let before = shot_uuids(&state, section_id);
    assert!(
        before.iter().all(Option::is_some),
        "setup: freshly created shots should all have uuids, got {before:?}"
    );

    assert!(state.undo().success, "undo of CreateSection failed");
    assert!(state.redo().success, "redo of CreateSection failed");

    let after = shot_uuids(&state, section_id);
    assert_eq!(
        before, after,
        "redo of CreateSection re-minted the shot uuids: every StationKey::AfterShot anchor \
         onto this section now dangles"
    );
}

/// The same root cause in a second field. `restore_section` rebuilds through
/// `Section::new`, which hardcodes `gauge_shot_uuid: None` /
/// `gauge_neighbour_uuid: None` (models/section.rs), and `SectionData` carries
/// neither - so a redo discards the least-squares gauge pair.
///
/// The anchors only exist after a save (`capture_missing_gauge_anchors` is a
/// save-time heal), which is why the fuzzer could not see this half until it
/// started crossing the persistence boundary.
#[test]
#[ignore = "open bug 1 (second half): redo of CreateSection discards captured gauge anchors - see e2e/agent/scenarios/undoRedoFuzz.ts header"]
fn redo_of_create_section_preserves_gauge_anchors() {
    let temp = TempDir::new().unwrap();
    let state = state_with_project();
    let section_id = create_section(&state, "Gauged", vec![shot(0.0, 5.0), shot(90.0, 4.0)]);

    // The save is what mints the gauge pair.
    let saved = state.save_project(Some(temp.path().join("gauge.stalx")));
    assert!(saved.success, "save failed: {:?}", saved.error);

    let gauge_before = {
        let project = state.get_project_state().expect("no project");
        let section = project
            .sections
            .iter()
            .find(|s| s.id == section_id)
            .expect("section missing");
        (
            section.gauge_shot_uuid.clone(),
            section.gauge_neighbour_uuid.clone(),
        )
    };
    assert!(
        gauge_before.0.is_some(),
        "setup: a save should have captured a gauge anchor, got {gauge_before:?}"
    );

    assert!(state.undo().success, "undo of CreateSection failed");
    assert!(state.redo().success, "redo of CreateSection failed");

    let gauge_after = {
        let project = state.get_project_state().expect("no project");
        let section = project
            .sections
            .iter()
            .find(|s| s.id == section_id)
            .expect("section missing");
        (
            section.gauge_shot_uuid.clone(),
            section.gauge_neighbour_uuid.clone(),
        )
    };
    assert_eq!(
        gauge_before, gauge_after,
        "redo of CreateSection discarded the captured gauge anchors"
    );
}

// ===========================================================================
// Bug 5: undo of UpdateSectionMetadata cannot restore a previously-null field
// ===========================================================================

/// The capture is correct - `generate_undo_data` builds
/// `SectionUpdates { surveyor: Some(None), .. }` for a section whose surveyor
/// was null - but `SectionUpdates` (models/section.rs) has only
/// `#[serde(default)]` on `name` / `surveyor` / `date`, with no
/// `deserialize_with = "double_option"` and no `skip_serializing_if`. So
/// `Some(None)` and `None` BOTH serialize to `null` and both read back as
/// `None` = "leave it alone".
///
/// This test pins the mechanism at the exact layer the undo path uses: the
/// `values_json` round trip. `ShotUpdates` gets this right; `SectionUpdates` was
/// left out.
#[test]
#[ignore = "open bug 5: SectionUpdates lacks double_option, so Some(None) cannot survive values_json - see e2e/agent/scenarios/undoRedoFuzz.ts header"]
fn section_updates_round_trip_preserves_clear_to_null() {
    let clear_the_surveyor = SectionUpdates {
        surveyor: Some(None),
        ..Default::default()
    };

    let json = serde_json::to_string(&clear_the_surveyor).expect("serialize SectionUpdates");
    let restored: SectionUpdates = serde_json::from_str(&json).expect("deserialize SectionUpdates");

    assert_eq!(
        restored.surveyor,
        Some(None),
        "SectionUpdates lost the difference between \"clear this field\" (Some(None)) and \
         \"leave it alone\" (None) through values_json: serialized as {json}"
    );
}

/// The end-to-end consequence of the round trip above: set a surveyor on a
/// section that had none, undo, and the value survives the undo.
#[test]
#[ignore = "open bug 5: undo cannot restore a previously-null section field - see e2e/agent/scenarios/undoRedoFuzz.ts header"]
fn undo_restores_a_previously_null_surveyor() {
    let state = state_with_project();
    let section_id = create_section(&state, "NoSurveyor", vec![shot(0.0, 5.0)]);

    let surveyor_before = {
        let project = state.get_project_state().expect("no project");
        project
            .sections
            .iter()
            .find(|s| s.id == section_id)
            .expect("section missing")
            .surveyor
            .clone()
    };
    assert_eq!(
        surveyor_before, None,
        "setup: the section should start with no surveyor"
    );

    let updated = state.execute(Command::UpdateSectionMetadata {
        section_id,
        updates: SectionUpdates {
            surveyor: Some(Some("Someone".to_string())),
            ..Default::default()
        },
    });
    assert!(updated.success, "UpdateSectionMetadata failed");

    assert!(state.undo().success, "undo of UpdateSectionMetadata failed");

    let surveyor_after = {
        let project = state.get_project_state().expect("no project");
        project
            .sections
            .iter()
            .find(|s| s.id == section_id)
            .expect("section missing")
            .surveyor
            .clone()
    };
    assert_eq!(
        surveyor_after, None,
        "undo left the new surveyor in place instead of clearing it back to null"
    );
}

// ===========================================================================
// Bug 8: after save/reload, undo deletes the WRONG shot
// ===========================================================================

/// The data-loss one.
///
/// Shots are renumbered on load to `section_id * FEATURE_ID_STRIDE +
/// sequence_order` (persistence/sqlite/read.rs), undo entries reload as opaque
/// JSON with no remapping anywhere on the restore path, and
/// `UndoData::CreatedShotSnapshot { section_id, shot_id }` undoes by calling
/// `delete_shot(section_id, shot_id)`. Because the in-session allocator
/// (`take_shot_id`) hands out ids from the SAME `section_id * STRIDE + n` space
/// the loader renumbers into, a stale id does not miss - it COLLIDES with
/// whatever shot now occupies that slot.
///
/// An insert-BEFORE into a one-shot section is the minimal way to make the
/// in-session ids diverge from positional order, which is the precondition.
#[test]
#[ignore = "open bug 8 (DATA LOSS): after save/reload, undo deletes the wrong shot - see e2e/agent/scenarios/undoRedoFuzz.ts header"]
fn undo_after_reload_deletes_the_shot_it_created() {
    let temp = TempDir::new().unwrap();
    let save_path: PathBuf = temp.path().join("renumbered.stalx");

    let original_uuid;
    let inserted_uuid;
    {
        let state = state_with_project();
        let section_id = create_section(&state, "Diverged", vec![shot(0.0, 5.0)]);
        let first_shot = shot_ids(&state, section_id)[0];

        // Insert BEFORE the existing shot: the new shot takes position 0 while
        // its id comes from the allocator, so ids no longer match positions.
        let created = state.execute(Command::CreateShot {
            section_id,
            shot: shot(180.0, 7.0),
            after_shot_id: None,
            before_shot_id: Some(first_shot),
        });
        assert!(created.success, "CreateShot failed: {:?}", created.error);

        let uuids = shot_uuids(&state, section_id);
        assert_eq!(uuids.len(), 2, "setup: expected two shots");
        inserted_uuid = uuids[0].clone().expect("inserted shot has no uuid");
        original_uuid = uuids[1].clone().expect("original shot has no uuid");

        let saved = state.save_project(Some(save_path.clone()));
        assert!(saved.success, "save failed: {:?}", saved.error);
    }

    // Reopen: the loader renumbers shot ids, the persisted undo entry does not.
    let reopened = AppState::new().unwrap();
    let opened = reopened.execute(Command::OpenProject { path: save_path });
    assert!(opened.success, "reopen failed: {:?}", opened.error);

    let undone = reopened.undo();
    assert!(
        undone.success,
        "undo after reopen failed: {:?}",
        undone.error
    );

    let project = reopened.get_project_state().expect("no project after undo");
    let remaining: Vec<Option<String>> = project
        .sections
        .iter()
        .flat_map(|section| section.shots.iter().map(|s| s.uuid.clone()))
        .collect();

    assert!(
        remaining
            .iter()
            .any(|u| u.as_deref() == Some(original_uuid.as_str())),
        "undo of CreateShot destroyed the ORIGINAL shot {original_uuid} instead of the one it \
         created; surviving uuids: {remaining:?}"
    );
    assert!(
        !remaining
            .iter()
            .any(|u| u.as_deref() == Some(inserted_uuid.as_str())),
        "undo of CreateShot left the shot it created ({inserted_uuid}) in place; surviving \
         uuids: {remaining:?}"
    );
}

/// `section_offsets` for `section_id`, or `None` when the section has no entry.
fn section_offset(state: &AppState, section_id: SectionId) -> Option<(f64, f64)> {
    state
        .get_project_state()?
        .section_offsets
        .get(&section_id)
        .copied()
}

// ===========================================================================
// Bug 2: undo of a shot insert leaves an orphan all-zero section_offsets entry
// ===========================================================================

/// `adjust_section_offset` CREATES the `section_offsets` key while compensating
/// an insert; the undo puts the value back to zero but nothing removes the key.
/// Geometrically inert, but it means undo is not an exact inverse and the leaked
/// key is serialized into the .stalx.
#[test]
#[ignore = "open bug 2: undo of a shot insert leaks an all-zero section_offsets key - see e2e/agent/scenarios/undoRedoFuzz.ts header"]
fn undo_of_a_shot_insert_leaves_no_orphan_offset_entry() {
    let state = state_with_project();
    let section_id = create_section(&state, "Inserted", vec![shot(0.0, 5.0), shot(90.0, 4.0)]);
    let first_shot = shot_ids(&state, section_id)[0];

    let before = section_offset(&state, section_id);

    let created = state.execute(Command::CreateShot {
        section_id,
        shot: shot(180.0, 3.0),
        after_shot_id: None,
        before_shot_id: Some(first_shot),
    });
    assert!(created.success, "CreateShot failed: {:?}", created.error);
    assert!(state.undo().success, "undo of CreateShot failed");

    let after = section_offset(&state, section_id);
    assert_eq!(
        before, after,
        "undo of a shot insert changed the section_offsets map: it was {before:?} and is now \
         {after:?} (the compensating adjust_section_offset creates the key and nothing removes it)"
    );
}

// ===========================================================================
// Bug 3: appending the FIRST shot into an EMPTY section, then undoing,
// displaces the whole section - and the displacement RATCHETS
// ===========================================================================

/// `Project::add_shot` (the append path) is offset-neutral, but the undo routes
/// through `remove_shot_with_rewire`, whose `pos == 0` branch unconditionally
/// calls `adjust_section_offset`. With one shot the appended shot IS index 0, so
/// the delete slides the section by that shot's horizontal vector.
#[test]
#[ignore = "open bug 3: undoing the first shot appended into an empty section displaces it - see e2e/agent/scenarios/undoRedoFuzz.ts header"]
fn undo_of_the_first_shot_in_an_empty_section_does_not_move_it() {
    let state = state_with_project();
    let section_id = create_section(&state, "Empty", vec![]);

    let before = section_offset(&state, section_id).unwrap_or((0.0, 0.0));

    let created = state.execute(Command::CreateShot {
        section_id,
        shot: shot(90.0, 10.0),
        after_shot_id: None,
        before_shot_id: None,
    });
    assert!(created.success, "CreateShot failed: {:?}", created.error);
    assert!(state.undo().success, "undo of CreateShot failed");

    let after = section_offset(&state, section_id).unwrap_or((0.0, 0.0));
    assert_eq!(
        before, after,
        "undoing the first shot appended into an empty section moved the section from {before:?} \
         to {after:?}"
    );
}

/// The displacement is not a one-off: redo re-inserts without giving the offset
/// back, so every undo/redo cycle slides the section again.
#[test]
#[ignore = "open bug 3 (ratchet): the displacement compounds on every undo/redo cycle - see e2e/agent/scenarios/undoRedoFuzz.ts header"]
fn the_empty_section_displacement_does_not_ratchet() {
    let state = state_with_project();
    let section_id = create_section(&state, "Ratchet", vec![]);

    let created = state.execute(Command::CreateShot {
        section_id,
        shot: shot(90.0, 10.0),
        after_shot_id: None,
        before_shot_id: None,
    });
    assert!(created.success, "CreateShot failed: {:?}", created.error);

    assert!(state.undo().success, "first undo failed");
    let after_one = section_offset(&state, section_id).unwrap_or((0.0, 0.0));

    assert!(state.redo().success, "redo failed");
    assert!(state.undo().success, "second undo failed");
    let after_two = section_offset(&state, section_id).unwrap_or((0.0, 0.0));

    assert_eq!(
        after_one, after_two,
        "a second undo/redo cycle moved the section again ({after_one:?} -> {after_two:?}): the \
         displacement compounds without bound"
    );
}

/// The ids of every loop closure, in `Project::loop_closures` order.
fn closure_ids(state: &AppState) -> Vec<u64> {
    let project = state.get_project_state().expect("no project open");
    project.loop_closures.iter().map(|c| c.id).collect()
}

/// Two sections joined by a merge, with a zero datum anchoring the first, so a
/// loop closure between them is legal. Returns `(section_a, section_b)`.
fn two_merged_sections(state: &AppState) -> (SectionId, SectionId) {
    let a = create_section(state, "A", vec![shot(0.0, 5.0), shot(0.0, 5.0)]);
    let b = create_section(state, "B", vec![shot(90.0, 5.0)]);
    let datum = state.execute(Command::SetZeroDatum {
        station_ref: StationRef::new(a, 0),
        coordinates: GpsCoordinates::new(10.0, 20.0, 0.0).unwrap(),
    });
    assert!(datum.success, "SetZeroDatum failed: {:?}", datum.error);
    let merged = state.execute(Command::MergeStations {
        station_a: StationRef::new(a, 2),
        station_b: StationRef::new(b, 0),
    });
    assert!(merged.success, "MergeStations failed: {:?}", merged.error);
    (a, b)
}

// ===========================================================================
// Bug 4: undo of RemoveLoopClosure appends instead of reinserting
// ===========================================================================

/// The removal takes the closure out with `Vec::remove(pos)`; the undo puts it
/// back with `loop_closures.push()` (core/state/undo.rs). Same closure, same id,
/// new position - and the order is persisted to the .stalx, indexed by the
/// frontend, and used to build the adjacency lists `resolve_offsets` traverses.
#[test]
#[ignore = "open bug 4: undo of RemoveLoopClosure appends instead of reinserting at its index - see e2e/agent/scenarios/undoRedoFuzz.ts header"]
fn undo_of_remove_loop_closure_restores_the_original_order() {
    let state = state_with_project();
    let (a, b) = two_merged_sections(&state);

    let first = state.execute(Command::CreateLoopClosure {
        station_a: StationRef::new(a, 0),
        station_b: StationRef::new(b, 1),
        closure_strategy: ClosureStrategy::default(),
    });
    assert!(
        first.success,
        "first CreateLoopClosure failed: {:?}",
        first.error
    );
    let second = state.execute(Command::CreateLoopClosure {
        station_a: StationRef::new(a, 1),
        station_b: StationRef::new(b, 1),
        closure_strategy: ClosureStrategy::default(),
    });
    assert!(
        second.success,
        "second CreateLoopClosure failed: {:?}",
        second.error
    );

    let before = closure_ids(&state);
    assert_eq!(
        before.len(),
        2,
        "setup: expected two closures, got {before:?}"
    );
    let removed_id = before[0];

    let removed = state.execute(Command::RemoveLoopClosure {
        closure_id: removed_id,
    });
    assert!(
        removed.success,
        "RemoveLoopClosure failed: {:?}",
        removed.error
    );
    assert!(state.undo().success, "undo of RemoveLoopClosure failed");

    let after = closure_ids(&state);
    assert_eq!(
        before, after,
        "undo put closure {removed_id} back at the END of loop_closures instead of its original \
         index; the list order is persisted and is what resolve_offsets traverses"
    );
}

// ===========================================================================
// Bug 6: a CreateShot that is permitted forward but CANNOT be undone
// ===========================================================================

/// Undo of `CreateShot` runs the user-facing `delete_shot`, guards and all, so a
/// shot inserted into a datum-anchored loop is an action that cannot be undone.
/// `core/state/undo.rs` pushes the entry back on failure, so it fails the same
/// way forever and every entry beneath it is unreachable - a WEDGED history,
/// which is worse than any amount of drift.
#[test]
#[ignore = "open bug 6: undo of CreateShot into an anchored loop fails and wedges the history - see e2e/agent/scenarios/undoRedoFuzz.ts header"]
fn undo_of_create_shot_in_an_anchored_loop_succeeds() {
    let state = state_with_project();
    let (a, b) = two_merged_sections(&state);

    // Close the loop. It has to be a CLOSURE, not a second merge: A and B are
    // already connected, and MergeStations refuses that with "Stations are
    // already connected. Use Create Loop Closure instead." (A second zero datum
    // is refused for the same component too, which is why the precondition here
    // is the loop itself - matching the guard the fuzzer's naharon soak hit.)
    let closed = state.execute(Command::CreateLoopClosure {
        station_a: StationRef::new(a, 0),
        station_b: StationRef::new(b, 1),
        closure_strategy: ClosureStrategy::default(),
    });
    assert!(
        closed.success,
        "loop-closing closure failed: {:?}",
        closed.error
    );

    // MID-CHAIN, not appended: an appended shot ends at a fresh leaf station,
    // which is not part of the cycle, so its removal is unguarded. A shot
    // inserted inside A's chain has both endpoints on the loop, which is the
    // condition `delete_shot` refuses.
    let first_shot_of_a = shot_ids(&state, a)[0];
    let created = state.execute(Command::CreateShot {
        section_id: a,
        shot: shot(45.0, 3.0),
        after_shot_id: Some(first_shot_of_a),
        before_shot_id: None,
    });
    assert!(
        created.success,
        "setup: the forward CreateShot must be permitted for this test to mean anything: {:?}",
        created.error
    );

    let undone = state.undo();
    assert!(
        undone.success,
        "undo of a PERMITTED CreateShot was refused ({:?}); the entry is pushed back, so the \
         history is now wedged and nothing beneath it can ever be undone. A second undo fails \
         identically: {:?}",
        undone.error,
        state.undo().error
    );
}

// ===========================================================================
// Bug 7: PINNED at last - by a seed, in the fuzz module
// ===========================================================================
//
// `undo()`/`redo()` call `invalidate_adjusted_cache()` before and
// `reconcile_geometry()` after (core/state/undo.rs); `undo_to()`/`redo_to()`
// loop the `*_inner` variants and call NEITHER.
//
// The red test is `bug_7_a_jump_is_n_single_steps` in
// `src-tauri/src/core/state/fuzz_undo_tests.rs`. It does not pattern-match a
// shape: on a jump that diverges the fuzzer REPLAYS the same distance one step
// at a time, through the same `undo()`/`redo()` entry points a user's Ctrl+Z
// would, and records the finding only when the single-step path lands exactly
// on the state the model recorded while the jump did not. That is the contract
// "undo_to(N) == N x undo()" measured directly.
//
// CORRECTION to the mechanism as previously documented. The missing
// `invalidate_adjusted_cache()` is NOT observable: `get_adjusted_stations`
// (core/state/app_state.rs) keys its cache on `project.modified_at` plus a
// config hash, and every undo calls `Project::touch()`, so the next read misses
// and re-solves whether or not the cache was explicitly cleared. Only the
// missing `reconcile_geometry()` half is a real defect.
//
// WHY IT IS NOT PINNED HERE, which is the part worth keeping. It needs an undo
// whose RAW restore leaves a merge beyond MERGE_ALIGNMENT_TOLERANCE_M, and none
// of the drift sources reachable in a small synthetic project qualifies. Each
// was measured, not assumed:
//
//   * bug 3's empty-section displacement DROPS the merge it would misalign -
//     the `pos == 0` branch removes refs keyed to station 0, and an empty
//     section has no other station to merge on.
//   * `UpdateShot` on a merged section restores the offsets symmetrically: both
//     unwind paths land on the same offset (verified by instrumenting).
//   * an insert-before on a section merged at a SURVIVING station compensates
//     correctly - the offset returns to (0, 0) and `check_merge_alignment()`
//     stays empty on both paths.
//   * undo-of-`RepairIntegrity`, whose `before` snapshot is documented to carry
//     the drift Repair healed and which therefore RELIES on the epilogue. Two
//     repairable shapes were built: bug 3's displaced section (repair returns
//     `changed = false`, so no entry is pushed at all) and finding 10's orphan
//     closure (repair fires, but `undo()` and `undo_to(0)` land on identical
//     projects - `realign_merges` early-returns while `check_merge_alignment()`
//     is empty, and it is empty in both).
//
// That is the shape of the difficulty: `realign_merges` IS `resolve_offsets`
// behind a tolerance gate, and every command's own epilogue has already run it,
// so a persistently misaligned merge is not reachable through the command API in
// a small project. It needs drift produced by ANOTHER bug over a long history -
// which the fuzzer reaches and minimal synthesis does not. Hence a seed.
//
// ===========================================================================
// Finding 10: a delete path strands a loop closure without converting it,
// so save + reopen is not state-preserving
// ===========================================================================

/// The app's invariant is that a loop closure exists only for a TRUE loop; a
/// closure that has become the sole connection is "really" a merge, and
/// `convert_orphan_closures_to_merges` normalizes it. That conversion runs from
/// `execute()`'s epilogue for commands flagged `can_orphan_closures`
/// (core/state/commands.rs), from two of the four delete-family entry points
/// (`execute_delete_shot_and_split`, `execute_delete_shot_range_split`), and
/// unconditionally on LOAD from `redrive_offsets_after_load`.
///
/// It does NOT run from `execute_delete_last_shot_and_section` or
/// `execute_delete_shot_range_shift` (command_delete_split.rs), which are
/// separate entry points rather than `Command` variants and so never see the
/// `execute()` epilogue either. Deleting the section that carried the loop's
/// other path therefore leaves an orphan closure in memory, the save persists
/// it, and the next load silently reclassifies it as a merge.
///
/// This may be INTENDED - the loader is entitled to enforce the invariant. The
/// test exists to force an explicit decision: either the two delete paths should
/// convert like their siblings do (so memory and disk agree), or save/reopen is
/// knowingly not state-preserving and this test should be deleted saying so.
///
/// Derived from the fuzzer's naharon seed 26 x40, whose history contains
/// `deleteLastShotAndSection` before the reload that diverged.
#[test]
#[ignore = "finding 10 (may be intended): a delete path orphans a closure without converting it, so reopen reclassifies it - see e2e/agent/scenarios/undoRedoFuzz.ts header"]
fn save_and_reopen_preserves_an_orphan_loop_closure() {
    let temp = TempDir::new().unwrap();
    let save_path: PathBuf = temp.path().join("orphan-closure.stalx");

    let before = {
        let state = state_with_project();
        // A - bridge - B, plus a closure straight from A to B: a genuine loop
        // with two independent paths.
        let a = create_section(&state, "A", vec![shot(0.0, 5.0)]);
        let bridge = create_section(&state, "Bridge", vec![shot(90.0, 5.0)]);
        let b = create_section(&state, "B", vec![shot(180.0, 5.0)]);
        let datum = state.execute(Command::SetZeroDatum {
            station_ref: StationRef::new(a, 0),
            coordinates: GpsCoordinates::new(10.0, 20.0, 0.0).unwrap(),
        });
        assert!(datum.success, "SetZeroDatum failed: {:?}", datum.error);
        for (left, right) in [((a, 1), (bridge, 0)), ((bridge, 1), (b, 0))] {
            let merged = state.execute(Command::MergeStations {
                station_a: StationRef::new(left.0, left.1),
                station_b: StationRef::new(right.0, right.1),
            });
            assert!(merged.success, "MergeStations failed: {:?}", merged.error);
        }
        let closure = state.execute(Command::CreateLoopClosure {
            station_a: StationRef::new(a, 0),
            station_b: StationRef::new(b, 1),
            closure_strategy: ClosureStrategy::default(),
        });
        assert!(
            closure.success,
            "CreateLoopClosure failed: {:?}",
            closure.error
        );

        // Delete the bridge through the entry point that does NOT convert.
        let bridge_shot = shot_ids(&state, bridge)[0];
        let deleted = state.execute_delete_last_shot_and_section(bridge, bridge_shot);
        assert!(
            deleted.success,
            "delete_last_shot_and_section failed: {:?}",
            deleted.error
        );

        let project = state.get_project_state().expect("no project");
        let counts = (project.loop_closures.len(), project.station_merges.len());
        assert!(
            counts.0 > 0,
            "setup: the closure should still be present in memory after the delete, got {counts:?}"
        );

        let saved = state.save_project(Some(save_path.clone()));
        assert!(saved.success, "save failed: {:?}", saved.error);
        counts
    };

    let reopened = AppState::new().unwrap();
    let opened = reopened.execute(Command::OpenProject { path: save_path });
    assert!(opened.success, "reopen failed: {:?}", opened.error);

    let project = reopened
        .get_project_state()
        .expect("no project after reopen");
    assert_eq!(
        (project.loop_closures.len(), project.station_merges.len()),
        before,
        "save + reopen reclassified a loop closure as a station merge: the delete path that \
         orphaned it does not run convert_orphan_closures_to_merges, but the loader does"
    );
}

// ===========================================================================
// Finding 11: a save's undo-less heals are reverted by undoing a snapshot-pair
// entry recorded before it
// ===========================================================================

/// `save_project` HEALS live state with no undo entry of its own -
/// `ensure_shot_uuids`, `ensure_unique_shot_uuids`,
/// `capture_missing_gauge_anchors`, the orphan `section_offsets` retain
/// (`core/state/project_io.rs`). A `ProjectSnapshotPair` captured BEFORE that
/// save holds the pre-heal project in BOTH its `before` and its `after`, and
/// neither is refreshed. So undoing (or redoing) an unrelated command recorded
/// before the save silently reverts the heal.
///
/// The consequence is worse than losing the anchors, which the next save would
/// re-capture: it makes the project at a given undo depth depend on the ROUTE
/// taken to reach it. Land on depth N by saving there and it has the anchors;
/// land on the same depth N by undoing a pre-save entry and it does not. An undo
/// stack whose states are not well-defined is the thing the whole history
/// feature promises.
///
/// Found by the fuzzer at fractal seed 4 x60 STRICT on the v2 stream, where a
/// save at depth 1 was followed by a redo/undo of a `moveStation` recorded
/// before it.
#[test]
#[ignore = "open finding 11: undoing a snapshot-pair entry recorded before a save reverts the save's heals - see e2e/agent/scenarios/undoRedoFuzz.ts header"]
fn undo_of_a_pre_save_entry_keeps_the_saves_gauge_anchors() {
    let temp = TempDir::new().unwrap();
    let state = state_with_project();
    let section_id = create_section(&state, "Gauged", vec![shot(0.0, 5.0), shot(90.0, 4.0)]);

    let gauge_of = |s: &AppState| -> (Option<String>, Option<String>) {
        let project = s.get_project_state().expect("no project");
        let section = project
            .sections
            .iter()
            .find(|sec| sec.id == section_id)
            .expect("section missing");
        (
            section.gauge_shot_uuid.clone(),
            section.gauge_neighbour_uuid.clone(),
        )
    };

    // A command whose undo data is a ProjectSnapshotPair, recorded BEFORE the
    // save so both of its snapshots predate the heal.
    let moved = state.execute(Command::MoveStation {
        station_ref: StationRef::new(section_id, 1),
        offset: Coordinates {
            x: 1.0,
            y: 2.0,
            z: 0.0,
        },
    });
    assert!(moved.success, "MoveStation failed: {:?}", moved.error);
    assert_eq!(
        gauge_of(&state),
        (None, None),
        "setup: the gauge pair is only captured on save, so it should still be unset"
    );

    // The save mints the gauge pair, with no undo entry of its own.
    let saved = state.save_project(Some(temp.path().join("pre-save-entry.stalx")));
    assert!(saved.success, "save failed: {:?}", saved.error);
    let after_save = gauge_of(&state);
    assert!(
        after_save.0.is_some(),
        "setup: the save should have captured a gauge anchor, got {after_save:?}"
    );

    // Undo the move recorded BEFORE the save.
    assert!(state.undo().success, "undo of MoveStation failed");

    assert_eq!(
        gauge_of(&state),
        after_save,
        "undoing a command recorded BEFORE the save reverted the save's gauge capture: the \
         snapshot pair holds the pre-heal project in both halves, so the heal is lost and the \
         project at this depth now depends on the route taken to reach it"
    );
}

/// The kind of every shot in `section_id`, in order.
fn shot_kinds(state: &AppState, section_id: SectionId) -> Vec<ShotKind> {
    let project = state.get_project_state().expect("no project open");
    project
        .sections
        .iter()
        .find(|section| section.id == section_id)
        .expect("section missing")
        .shots
        .iter()
        .map(|s| s.kind)
        .collect()
}

/// The length of every shot in `section_id`, in order.
fn shot_lengths(state: &AppState, section_id: SectionId) -> Vec<f64> {
    let project = state.get_project_state().expect("no project open");
    project
        .sections
        .iter()
        .find(|section| section.id == section_id)
        .expect("section missing")
        .shots
        .iter()
        .map(|s| s.length)
        .collect()
}

/// Build a section whose shot ids no longer match positional order, save it, and
/// return the path plus the section id.
///
/// Three shots and one insert-BEFORE: the new shot takes position 0 while its id
/// comes from the allocator, so after the save the loader's
/// `section_id * FEATURE_ID_STRIDE + sequence_order` renumbering moves every id
/// by one slot. No shot is DELETED, so the ids the allocator handed out are
/// exactly the ids the loader renumbers into - which is what makes a stale id
/// COLLIDE with a live shot rather than miss it (the miss case is its own test
/// below).
fn diverged_section(state: &AppState) -> SectionId {
    let section_id = create_section(
        state,
        "Diverged",
        vec![shot(0.0, 5.0), shot(90.0, 6.0), shot(180.0, 7.0)],
    );
    let first = shot_ids(state, section_id)[0];
    let created = state.execute(Command::CreateShot {
        section_id,
        shot: shot(270.0, 8.0),
        after_shot_id: None,
        before_shot_id: Some(first),
    });
    assert!(created.success, "CreateShot failed: {:?}", created.error);
    let ids = shot_ids(state, section_id);
    assert_ne!(
        ids,
        (0..ids.len())
            .map(|i| section_id * crate::models::FEATURE_ID_STRIDE + i as u32)
            .collect::<Vec<_>>(),
        "setup: the ids must no longer match positional order, or the reload changes nothing"
    );
    section_id
}

// ===========================================================================
// Finding 12: bug 8's mechanism is NOT confined to CreateShot - after a
// save/reload, undo of SetShotKind or UpdateShot writes to the WRONG SHOT
// ===========================================================================

/// `UndoData::InverseCommand(Command::SetShotKind { shot_id, .. })` names the
/// shot by its IN-SESSION id (`undo_capture.rs`), and undo executes that command
/// verbatim (`execute_without_undo`, core/state/undo.rs). The loader renumbers
/// shots to `section_id * FEATURE_ID_STRIDE + sequence_order`
/// (persistence/sqlite/read.rs) and nothing remaps the persisted entries, so
/// after a reopen the id addresses whichever shot now occupies that slot.
///
/// Quieter than bug 8 and just as wrong: no shot is lost, no uuid changes and no
/// count moves. One shot silently keeps an edit the undo was supposed to take
/// away, and another silently gains one it never had.
///
/// Found by `undo-persistence-fuzz` (e2e/agent/scenarios/undoPersistenceFuzz.ts).
#[test]
#[ignore = "open finding 12: after save/reload, undo of SetShotKind hits the wrong shot - see e2e/agent/scenarios/undoPersistenceFuzz.ts header"]
fn undo_of_set_shot_kind_after_reload_hits_the_shot_it_changed() {
    let temp = TempDir::new().unwrap();
    let save_path: PathBuf = temp.path().join("wrong-shot-kind.stalx");

    let marked_uuid;
    let section_id;
    {
        let state = state_with_project();
        section_id = diverged_section(&state);

        // Mark the shot at POSITION 0, whose id is the highest the allocator
        // handed out - so the renumbering will move it to the lowest.
        let target = shot_ids(&state, section_id)[0];
        marked_uuid = shot_uuids(&state, section_id)[0]
            .clone()
            .expect("shot has no uuid");
        let marked = state.execute(Command::SetShotKind {
            section_id,
            shot_id: target,
            kind: ShotKind::Jump,
        });
        assert!(marked.success, "SetShotKind failed: {:?}", marked.error);
        assert_eq!(
            shot_kinds(&state, section_id)[0],
            ShotKind::Jump,
            "setup: the forward command should have marked position 0"
        );

        let saved = state.save_project(Some(save_path.clone()));
        assert!(saved.success, "save failed: {:?}", saved.error);
    }

    let reopened = AppState::new().unwrap();
    let opened = reopened.execute(Command::OpenProject { path: save_path });
    assert!(opened.success, "reopen failed: {:?}", opened.error);

    let undone = reopened.undo();
    assert!(
        undone.success,
        "undo after reopen failed: {:?}",
        undone.error
    );

    let project = reopened.get_project_state().expect("no project after undo");
    let section = project
        .sections
        .iter()
        .find(|s| s.id == section_id)
        .expect("section missing");
    let marked = section
        .shots
        .iter()
        .find(|s| s.uuid.as_deref() == Some(marked_uuid.as_str()))
        .expect("the marked shot vanished");
    assert_eq!(
        marked.kind,
        ShotKind::Normal,
        "undo of SetShotKind left the shot it changed as {:?} and reset a DIFFERENT shot instead: \
         kinds are now {:?} (the entry named the in-session shot id, which the loaders \
         renumbering has since reassigned)",
        marked.kind,
        shot_kinds(&reopened, section_id)
    );
}

/// The same defect through `UndoData::PreviousValues { section_id, shot_id, .. }`,
/// whose undo calls `update_shot(section_id, shot_id, prev)` with the stale id
/// (core/state/undo.rs). `redo_inner`'s catch-all arm re-executes
/// `entry.command` - `Command::UpdateShot { shot_id, .. }` - so the REDO half
/// carries the same stale id, which is what makes an undo/redo cycle after a
/// reload move a measurement onto a shot that never had it.
#[test]
#[ignore = "open finding 12: after save/reload, undo of UpdateShot hits the wrong shot - see e2e/agent/scenarios/undoPersistenceFuzz.ts header"]
fn undo_of_update_shot_after_reload_restores_the_shot_it_changed() {
    let temp = TempDir::new().unwrap();
    let save_path: PathBuf = temp.path().join("wrong-shot-length.stalx");

    let edited_uuid;
    let original_length;
    let section_id;
    {
        let state = state_with_project();
        section_id = diverged_section(&state);

        let target = shot_ids(&state, section_id)[0];
        edited_uuid = shot_uuids(&state, section_id)[0]
            .clone()
            .expect("shot has no uuid");
        original_length = shot_lengths(&state, section_id)[0];
        let edited = state.execute(Command::UpdateShot {
            section_id,
            shot_id: target,
            updates: ShotUpdates {
                length: Some(42.5),
                ..Default::default()
            },
        });
        assert!(edited.success, "UpdateShot failed: {:?}", edited.error);

        let saved = state.save_project(Some(save_path.clone()));
        assert!(saved.success, "save failed: {:?}", saved.error);
    }

    let reopened = AppState::new().unwrap();
    let opened = reopened.execute(Command::OpenProject { path: save_path });
    assert!(opened.success, "reopen failed: {:?}", opened.error);

    let undone = reopened.undo();
    assert!(
        undone.success,
        "undo after reopen failed: {:?}",
        undone.error
    );

    let project = reopened.get_project_state().expect("no project after undo");
    let section = project
        .sections
        .iter()
        .find(|s| s.id == section_id)
        .expect("section missing");
    let edited = section
        .shots
        .iter()
        .find(|s| s.uuid.as_deref() == Some(edited_uuid.as_str()))
        .expect("the edited shot vanished");
    assert!(
        (edited.length - original_length).abs() < 1e-9,
        "undo of UpdateShot left the edited shot at {} m instead of restoring {} m, and wrote the \
         old value onto a DIFFERENT shot: lengths are now {:?}",
        edited.length,
        original_length,
        shot_lengths(&reopened, section_id)
    );
}

// ===========================================================================
// Finding 13: when the stale id is PAST the renumbered range, the undo does not
// hit the wrong shot - it fails outright and WEDGES the history
// ===========================================================================

/// Bug 8's mechanism with the opposite outcome, and the reason it needs its own
/// entry: a section that has had a shot DELETED has handed out more ids than it
/// has shots, so the newest persisted id runs past
/// `section_id * FEATURE_ID_STRIDE + (len - 1)`. `delete_shot` then finds
/// nothing, the undo fails, and `undo_inner`'s epilogue pushes the entry back
/// (core/state/undo.rs) - so it fails identically forever and EVERY entry
/// beneath it is unreachable for the rest of the project's life.
///
/// A wedged history is worse than a wrong one: the user cannot even walk past it
/// to reach the edits underneath. The same shape applies to `update_shot` and
/// `set_shot_kind`, whose undo also returns `Shot ... not found in section ...`.
///
/// Found by `undo-persistence-fuzz` with
/// `STALAGMIGHT_PERSIST_FUZZ_DELETE_IN_TARGET=1`.
#[test]
#[ignore = "open finding 13: after save/reload, an out-of-range stale shot id makes undo fail and wedges the history - see e2e/agent/scenarios/undoPersistenceFuzz.ts header"]
fn undo_after_reload_is_not_wedged_by_an_out_of_range_shot_id() {
    let temp = TempDir::new().unwrap();
    let save_path: PathBuf = temp.path().join("wedged.stalx");

    let section_id;
    {
        let state = state_with_project();
        section_id = create_section(
            &state,
            "Wedged",
            vec![shot(0.0, 5.0), shot(90.0, 6.0), shot(180.0, 7.0)],
        );

        // The delete is what makes the allocator run ahead of the shot count.
        let middle = shot_ids(&state, section_id)[1];
        let deleted = state.execute(Command::DeleteShot {
            section_id,
            shot_id: middle,
        });
        assert!(deleted.success, "DeleteShot failed: {:?}", deleted.error);

        let first = shot_ids(&state, section_id)[0];
        let created = state.execute(Command::CreateShot {
            section_id,
            shot: shot(270.0, 8.0),
            after_shot_id: None,
            before_shot_id: Some(first),
        });
        assert!(created.success, "CreateShot failed: {:?}", created.error);

        let ids = shot_ids(&state, section_id);
        let highest_renumbered =
            section_id * crate::models::FEATURE_ID_STRIDE + ids.len() as u32 - 1;
        assert!(
            ids.iter().any(|id| *id > highest_renumbered),
            "setup: at least one live id must be past the range the loader renumbers into, \
             got {ids:?} against a ceiling of {highest_renumbered}"
        );

        let saved = state.save_project(Some(save_path.clone()));
        assert!(saved.success, "save failed: {:?}", saved.error);
    }

    let reopened = AppState::new().unwrap();
    let opened = reopened.execute(Command::OpenProject { path: save_path });
    assert!(opened.success, "reopen failed: {:?}", opened.error);

    let depth_before = reopened.get_undo_stack().len();
    let undone = reopened.undo();
    assert!(
        undone.success,
        "undo of a CreateShot failed after the reopen ({:?}); the entry is pushed back, so the \
         history is WEDGED and the {} entr(y/ies) beneath it can never be undone. A second undo \
         fails identically: {:?}",
        undone.error,
        depth_before.saturating_sub(1),
        reopened.undo().error
    );
}

// ===========================================================================
// Finding 14: REAL, and pinned - but by a SEED, not by a reduction
// ===========================================================================
//
// With a datum on section A and a merge chain A -> B -> C, a mid-chain
// `CreateShot` into A leaves the A/B merge metres apart and the app's own
// `debug_assert_merge_alignment` (`models/project/offsets.rs`, whose assert arm
// is `#[cfg(test)]` and therefore exists in NO other tier) panics inside
// `insert_shot_after`.
//
// The red test is `finding_14_no_insert_leaves_a_merge_out_of_alignment` in
// `src-tauri/src/core/state/fuzz_undo_tests.rs`, pinned to one deterministic
// fuzzer seed. It lives there rather than here because two reductions were
// MEASURED not to reproduce, and a red test has to be red:
//
//   * sections A(3 shots, datum at 0), B(1), C(1), merges A:3<->B:0 and
//     B:1<->C:0, then `CreateShot(after = A's first shot)` - every merge stays
//     aligned. The cascade handles the plain chain.
//   * the same with the fuzzer's FULL starting topology transcribed (seven
//     sections of varied length, the zero datum, both merges, the loop closure)
//     and a `MoveStation` on the bridge before the insert - also clean.
//
// So the ingredient is further back in the fuzzer's history than either
// reduction reaches, and pinning the seed pins the defect honestly while a
// reduction would only pin a guess. `models/project/shots.rs`'s
// `insert_shot_after` back-shifts the section offset only when the merged
// partner has an INDEPENDENT datum path (`has_datum_path_excluding`), which on a
// chain it does not, leaving `cascade_connection_offsets` to move the partner
// instead - that is still the suspected mechanism, and it is what a fix should
// start from.
//
// Also part of the finding: `check_merge_alignment`
// (`models/project/integrity.rs`) measures through `resolved_station_offsets()`
// and reports NOTHING about the same state the raw-coordinate assert panics on.
// Whichever is authoritative, the two should not disagree.

// ===========================================================================
// Finding 15: an undo leaves a `section_offsets` entry with REAL geometry -
// which is FINDING 3, re-measured several moves later
// ===========================================================================

/// Finding 15 was filed as its own defect because the move that FAILS is not
/// the move that did it. Finding 3 displaces the empty section on the undo that
/// removes its first shot; nothing puts that back (the redo re-inserts through
/// the offset-neutral append path, which is finding 3's ratchet half), so the
/// leftover is still there several undos later, when the entry being consumed
/// is something unrelated - a `set_station_comment`, an `update_shot` - and the
/// snapshot it is compared against never had the key.
///
/// Root-caused with the Rust fuzzer's own reported instance: seed 7 at 100
/// moves, `section_offsets.1` = `[7.11187043796, 0.315846281796]` at depth 14,
/// whose immediately preceding two moves are `createShot(s=1,n=0,append)` and
/// the undo of it. The write-up read the move log from the wrong end.
///
/// This test pins the CONSEQUENCE rather than the cause, because that is what a
/// user sees and what finding 3's own tests do not cover: unwinding the whole
/// history has to return the project to the state it started in.
#[test]
#[ignore = "open finding 15 (= finding 3, cascading): the empty-section displacement survives every later undo - see src-tauri/src/core/state/fuzz_undo_tests.rs"]
fn unwinding_the_history_leaves_no_displaced_section_behind() {
    let state = state_with_project();
    let keeper = create_section(&state, "Keeper", vec![shot(0.0, 5.0)]);
    let empty = create_section(&state, "Empty", vec![]);

    let before = section_offset(&state, empty);
    assert_eq!(
        before, None,
        "setup: a section that has never been moved should have no offset entry"
    );

    // Depth 1: an ordinary edit on an unrelated section.
    let keeper_shot = shot_ids(&state, keeper)[0];
    let edited = state.execute(Command::UpdateShot {
        section_id: keeper,
        shot_id: keeper_shot,
        updates: ShotUpdates {
            length: Some(9.0),
            ..Default::default()
        },
    });
    assert!(edited.success, "UpdateShot failed: {:?}", edited.error);

    // Depth 2: the first shot appended into the empty section.
    let created = state.execute(Command::CreateShot {
        section_id: empty,
        shot: shot(90.0, 10.0),
        after_shot_id: None,
        before_shot_id: None,
    });
    assert!(created.success, "CreateShot failed: {:?}", created.error);

    // All the way back down.
    assert!(state.undo().success, "undo of CreateShot failed");
    assert!(state.undo().success, "undo of UpdateShot failed");

    assert_eq!(
        section_offset(&state, empty),
        before,
        "unwinding the history left section {empty} displaced: the undo of the first shot in an \
         empty section slides it (finding 3) and nothing puts it back, so the offset is still \
         there after the undo of an UNRELATED entry - which is what finding 15 observed"
    );
}

// ===========================================================================
// Finding 16: after a reload, an undo/redo cycle of CreateShot leaves the
// section holding the SAME shot uuid twice
// ===========================================================================

/// The redo half of finding 8, which nothing had exercised.
///
/// After a reload the undo deletes the wrong shot (finding 8) and leaves the
/// created one in place. The redo then re-runs the SAME insert through
/// `redo_inner`'s `CreatedShotSnapshot` arm (`core/state/undo.rs`), which forces
/// both the id AND the uuid from the entry - so the shot it re-creates is a
/// second copy of one that never left. The section ends up holding one
/// `Shot::uuid` twice.
///
/// That is worse than a wrong shot: uuid is the identity `StationKey::AfterShot`
/// resolves stations by (`models/station.rs`), the identity the Ariane export
/// writes, and the identity `ensure_unique_shot_uuids` will silently RE-MINT on
/// the next save - moving whichever anchor loses the coin toss.
///
/// Found by the Rust fuzzer at seed 13 x 60 with persistence.
#[test]
#[ignore = "open finding 16 (DATA CORRUPTION): after a reload, undo+redo of CreateShot duplicates a shot uuid - see src-tauri/src/core/state/fuzz_undo_tests.rs"]
fn redo_after_reload_does_not_duplicate_a_shot_uuid() {
    let temp = TempDir::new().unwrap();
    let save_path: PathBuf = temp.path().join("duplicated.stalx");

    let section_id;
    {
        let state = state_with_project();
        section_id = diverged_section(&state);
        let saved = state.save_project(Some(save_path.clone()));
        assert!(saved.success, "save failed: {:?}", saved.error);
    }

    let reopened = AppState::new().unwrap();
    let opened = reopened.execute(Command::OpenProject { path: save_path });
    assert!(opened.success, "reopen failed: {:?}", opened.error);

    assert!(reopened.undo().success, "undo after reopen failed");
    assert!(reopened.redo().success, "redo after reopen failed");

    let uuids: Vec<String> = shot_uuids(&reopened, section_id)
        .into_iter()
        .flatten()
        .collect();
    let mut unique = uuids.clone();
    unique.sort_unstable();
    unique.dedup();
    assert_eq!(
        unique.len(),
        uuids.len(),
        "an undo/redo cycle after the reopen left section {section_id} holding the same shot uuid \
         twice: {uuids:?}. The undo deleted the wrong shot and the redo re-inserted the one that \
         was still there, forcing the persisted uuid onto the copy"
    );
}

// ===========================================================================
// Finding 17: undo of RemoveZeroDatum appends the datum instead of restoring
// its index - finding 4's defect, one collection over
// ===========================================================================

/// `UndoData::ZeroDatumInfo`'s restore arm ends in
/// `project.zero_datums.push(ZeroDatum { .. })` (`core/state/undo.rs`) where the
/// forward path removed the datum in place, so a datum that was not last comes
/// back last.
///
/// Exactly finding 4's shape and exactly its consequences: `zero_datums` is
/// persisted in order, the frontend indexes it, and `resolve_offsets` anchors
/// connected groups by walking it - so the order decides which datum wins when a
/// component has more than one candidate anchor.
///
/// Found by the Rust fuzzer's closure-shapes mode, which is the first thing that
/// gave a run two datums to reorder.
#[test]
#[ignore = "open finding 17: undo of RemoveZeroDatum appends instead of reinserting at its index - see src-tauri/src/core/state/fuzz_undo_tests.rs"]
fn undo_of_remove_zero_datum_restores_the_original_order() {
    let state = state_with_project();
    // Two INDEPENDENT components, so both may carry a datum: a second datum in
    // one component is refused.
    let first = create_section(&state, "First", vec![shot(0.0, 5.0)]);
    let second = create_section(&state, "Second", vec![shot(90.0, 5.0)]);
    for (section_id, latitude) in [(first, 10.0), (second, 11.0)] {
        let datum = state.execute(Command::SetZeroDatum {
            station_ref: StationRef::new(section_id, 0),
            coordinates: GpsCoordinates::new(latitude, 20.0, 0.0).unwrap(),
        });
        assert!(datum.success, "SetZeroDatum failed: {:?}", datum.error);
    }

    let before = datum_sections(&state);
    assert_eq!(
        before,
        vec![first, second],
        "setup: the datums should be in creation order"
    );

    // Remove the FIRST of the two. Removing the last one would come back in the
    // right place by luck and prove nothing.
    let removed = state.execute(Command::RemoveZeroDatum {
        station_ref: StationRef::new(first, 0),
    });
    assert!(
        removed.success,
        "RemoveZeroDatum failed: {:?}",
        removed.error
    );
    assert!(state.undo().success, "undo of RemoveZeroDatum failed");

    assert_eq!(
        datum_sections(&state),
        before,
        "undo put the datum back at the END of zero_datums instead of its original index; the \
         order is persisted, indexed by the frontend, and the order resolve_offsets anchors \
         connected groups in"
    );
}

/// The section of every zero datum, in `Project::zero_datums` order.
fn datum_sections(state: &AppState) -> Vec<SectionId> {
    let project = state.get_project_state().expect("no project open");
    project
        .zero_datums
        .iter()
        .map(|datum| datum.station_ref.section_id)
        .collect()
}

// ===========================================================================
// Finding 20: a geometry edit inside an UNANCHORED merge group leaves the merge
// drifted, under every threshold that would report it
// ===========================================================================

/// The raw distance between two stations, measured the way
/// `Project::debug_assert_merge_alignment` measures it
/// (`compute_station_raw_coords`, `models/project/offsets.rs`) rather than
/// through `resolved_station_offsets()`. The app's two alignment measures
/// disagree by construction (issue #413 finding 14), so a test about the
/// invariant the app ASSERTS has to use the assert's own measure.
fn raw_station_gap(state: &AppState, a: (SectionId, u32), b: (SectionId, u32)) -> f64 {
    let project = state.get_project_state().expect("no project open");
    let left = project
        .compute_station_raw_coords(StationRef::new(a.0, a.1))
        .expect("station a has no raw coordinates");
    let right = project
        .compute_station_raw_coords(StationRef::new(b.0, b.1))
        .expect("station b has no raw coordinates");
    ((left.x - right.x).powi(2) + (left.y - right.y).powi(2)).sqrt()
}

/// Two sections joined by ONE merge and anchored by NOTHING - no zero datum
/// anywhere in the project. Returns `(a, b)`, merged at `a:1 <-> b:0`.
///
/// The absence of the datum is the whole precondition, so it is not an
/// oversight: `realign_after_shot_edit` looks for a datum in the edited
/// section's merge group and returns early when there is none.
fn two_unanchored_merged_sections(state: &AppState) -> (SectionId, SectionId) {
    let a = create_section(state, "A", vec![shot(0.0, 5.0), shot(0.0, 5.0)]);
    let b = create_section(state, "B", vec![shot(90.0, 5.0)]);
    let merged = state.execute(Command::MergeStations {
        station_a: StationRef::new(a, 1),
        station_b: StationRef::new(b, 0),
    });
    assert!(merged.success, "MergeStations failed: {:?}", merged.error);
    assert!(
        raw_station_gap(state, (a, 1), (b, 0)) < 1e-9,
        "setup: MergeStations should leave the pair co-located"
    );
    (a, b)
}

/// FINDING 20: editing a shot's geometry inside a merge group that holds no zero
/// datum moves one side of the merge and realigns nothing, and the drift then
/// sits below every threshold that would report it.
///
/// Two gates decline in sequence:
///
/// 1. `Project::realign_after_shot_edit` (`models/project/mutations.rs:923`) -
///    the only thing `update_shot` calls to repair the merge
///    (`core/state/command_shot.rs:173`) - looks for a zero datum in the edited
///    section's merge group and, finding none, returns at
///    `mutations.rs:941` ("No anchor in this group, nothing to realign").
/// 2. `AppState::execute`'s epilogue (`core/state/commands.rs:654`) then runs
///    `reconcile_geometry()` -> `Project::realign_merges()`
///    (`models/project/offsets.rs:280`), which re-solves ONLY when
///    `check_merge_alignment()` already reports a violation - and that checker's
///    threshold is `Project::MERGE_ALIGNMENT_TOLERANCE_M` = 5 cm
///    (`models/project.rs:1064`).
///
/// So drift under 5 cm survives, and the app's OWN invariant for the same pair,
/// asserted by `debug_assert_merge_alignment` (`models/project/offsets.rs:112`),
/// is 1 cm. The whole band from 1 cm to 5 cm is a state the app asserts cannot
/// exist and produces on purpose.
///
/// Measured band, from the probe this test was reduced from: +0.005 m of shot
/// length leaves 0.005 m, +0.02 leaves 0.02, +0.0499 leaves 0.0499, +0.0501
/// leaves 0 (the epilogue heals it), +0.5 leaves 0. And with a datum in the
/// group every one of those leaves 0.
///
/// Found by the Rust fuzzer's HORIZON mode, seed 1, where an `updateShot` after
/// a `mergeStations` left a pair 1.58 cm apart, raw and resolved agreeing.
#[test]
#[ignore = "open finding 20: a shot edit in an unanchored merge group leaves the merge drifted under the 5 cm heal gate - see src-tauri/src/core/state/fuzz_undo_tests.rs"]
fn a_shot_edit_keeps_an_unanchored_merge_aligned() {
    let state = state_with_project();
    let (a, b) = two_unanchored_merged_sections(&state);

    // 2 cm of extra length on the shot BEFORE the merged station, so the station
    // moves by exactly that. Deliberately inside the band: 5.1 cm would be
    // healed by the epilogue and would prove nothing.
    let first_shot = shot_ids(&state, a)[0];
    let updated = state.execute(Command::UpdateShot {
        section_id: a,
        shot_id: first_shot,
        updates: ShotUpdates {
            length: Some(5.02),
            ..ShotUpdates::default()
        },
    });
    assert!(updated.success, "UpdateShot failed: {:?}", updated.error);

    let gap = raw_station_gap(&state, (a, 1), (b, 0));
    assert!(
        gap < 0.01,
        "a shot edit left the merged pair {gap:.6} m apart, past the 0.01 m the app's own \
         debug_assert_merge_alignment calls a violation - and under the 0.05 m \
         check_merge_alignment reports, so the user is told nothing and the drift is saved"
    );
}

/// The same defect's CONSEQUENCE, and the reason it is not merely cosmetic: the
/// drift is a landmine for a later, unrelated command.
///
/// `update_shot` is not one of the call sites that runs
/// `debug_assert_merge_alignment` (the eight that do are the insert/remove/split
/// shot paths, `merge_stations`, `set_zero_datum`, `adjust_loop_closures` and
/// `delete_shot_range_shift`), so the edit itself says nothing. The next command
/// that DOES assert - here a `CreateShot` into a third, entirely unrelated
/// section - trips on the merge the edit broke two commands ago, in a test build
/// with no way to attribute it.
///
/// In a release build the same state produces neither the assert nor a user
/// warning: it is simply saved.
#[test]
#[ignore = "open finding 20: the drift an unanchored shot edit leaves trips the app's own alignment assert in a later unrelated command"]
fn a_shot_edit_does_not_arm_an_alignment_assert_for_a_later_command() {
    let state = state_with_project();
    let (a, _b) = two_unanchored_merged_sections(&state);
    let elsewhere = create_section(&state, "Elsewhere", vec![shot(45.0, 5.0)]);

    let first_shot = shot_ids(&state, a)[0];
    let updated = state.execute(Command::UpdateShot {
        section_id: a,
        shot_id: first_shot,
        updates: ShotUpdates {
            length: Some(5.02),
            ..ShotUpdates::default()
        },
    });
    assert!(updated.success, "UpdateShot failed: {:?}", updated.error);

    // A command in a DIFFERENT section, touching neither side of the merge.
    let anchor = shot_ids(&state, elsewhere)[0];
    let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        state.execute(Command::CreateShot {
            section_id: elsewhere,
            shot: shot(10.0, 3.0),
            after_shot_id: Some(anchor),
            before_shot_id: None,
        })
    }));
    let message = match outcome {
        Ok(_) => String::new(),
        Err(payload) => payload
            .downcast_ref::<String>()
            .cloned()
            .or_else(|| payload.downcast_ref::<&str>().map(|s| (*s).to_string()))
            .unwrap_or_else(|| "<non-string panic>".to_string()),
    };
    assert!(
        message.is_empty(),
        "an unrelated insert into a third section tripped the app's own merge-alignment assert \
         on the merge a shot edit broke two commands earlier: {}",
        message.lines().next().unwrap_or_default()
    );
}

// ===========================================================================
// Finding 21: the ADJUSTED geometry is not a function of the project's value
// ===========================================================================

/// Every adjusted station's coordinates as RAW BITS, keyed by station.
///
/// Bits rather than a tolerance on purpose: the claim under test is that a
/// solve over one unchanging input is a FUNCTION, and a function that returns
/// two different answers is not one at any tolerance. The magnitude is reported
/// separately, so the failure says both "not a function" and "by this much".
fn adjusted_bits(state: &AppState) -> Vec<(String, [u64; 3])> {
    let mut rows: Vec<(String, [u64; 3])> = state
        .get_adjusted_stations()
        .expect("no adjusted stations")
        .iter()
        .map(|station| {
            (
                format!(
                    "{}:{}",
                    station.station_ref.section_id, station.station_ref.station_index
                ),
                [
                    station.coordinates.x.to_bits(),
                    station.coordinates.y.to_bits(),
                    station.coordinates.z.to_bits(),
                ],
            )
        })
        .collect();
    rows.sort();
    rows
}

/// FINDING 21: re-solving the SAME project gives a different answer almost every
/// time, because the least-squares adjustment numbers its unknowns in `HashMap`
/// iteration order.
///
/// `Project::adjust_least_squares` (`models/project/lsq.rs`) builds the solver's
/// node numbering with
///
/// ```text
/// let mut unknown_index: HashMap<StationRef, usize> = HashMap::new();
/// for root in groups.keys() { ... unknown_index.insert(*root, next); }
/// ```
///
/// (`lsq.rs:403-409`), where `groups` is a `HashMap` built fresh inside the
/// call - so its `RandomState` differs on every invocation and the numbering is
/// a fresh random permutation each time. The numbering is not cosmetic: the
/// reduction peels nodes in ascending index order (`lsq.rs:72`), the
/// neighbour sets it sums over are themselves `HashMap`s (`lsq.rs:84-85`,
/// `lsq.rs:148-155`, `lsq.rs:200-208`), and floating-point addition is not
/// associative. The conjugate-gradient stop is RELATIVE (`lsq.rs:253`), so a
/// different summation order can also change the iteration count.
///
/// Why it matters beyond the last bit: the adjusted stations are what the map
/// draws, what every export writes, and what the undo fuzzer's fourth oracle
/// compares per undo depth. A derived view that is not a function of the state
/// cannot be compared against a recorded one without a tolerance, and a
/// tolerance is exactly what hides a real regression.
///
/// The magnitude here is small (femtometres on this five-shot loop) because the
/// system is tiny and well conditioned. It is NOT bounded by anything: the
/// amplification is the condition number of the network, and the fuzzer's own
/// adjusted-geometry oracle recorded a station 2.2 km out moving 28 microns
/// between two solves of a state whose stored project roundtripped byte for
/// byte.
///
/// The input is proven not to move: the canonical project snapshot is captured
/// before and after the whole loop and asserted equal, so "the same project"
/// is a measurement here rather than an assumption.
#[test]
#[ignore = "open finding 21: adjust_least_squares numbers its unknowns in HashMap order, so the adjusted solve is not a function of the project - see src-tauri/src/core/state/fuzz_undo_tests.rs"]
fn the_adjusted_solve_is_a_function_of_the_project() {
    let state = state_with_project();
    let a = create_section(
        &state,
        "A",
        vec![shot(0.0, 5.0), shot(0.0, 5.0), shot(10.0, 4.0)],
    );
    let b = create_section(&state, "B", vec![shot(90.0, 5.0), shot(95.0, 6.0)]);
    let datum = state.execute(Command::SetZeroDatum {
        station_ref: StationRef::new(a, 0),
        coordinates: GpsCoordinates::new(10.0, 20.0, 0.0).unwrap(),
    });
    assert!(datum.success, "SetZeroDatum failed: {:?}", datum.error);
    let merged = state.execute(Command::MergeStations {
        station_a: StationRef::new(a, 3),
        station_b: StationRef::new(b, 0),
    });
    assert!(merged.success, "MergeStations failed: {:?}", merged.error);
    // A least-squares closure is the precondition: without one,
    // `plan_adjustment_anchors` never enters `adjust_least_squares` at all and
    // the solve reduces to a deterministic coordinate walk.
    let closure = state.execute(Command::CreateLoopClosure {
        station_a: StationRef::new(a, 0),
        station_b: StationRef::new(b, 2),
        closure_strategy: ClosureStrategy::LeastSquaresWeighted,
    });
    assert!(
        closure.success,
        "CreateLoopClosure failed: {:?}",
        closure.error
    );

    let project_before = state
        .capture_project_snapshot()
        .expect("capture_project_snapshot failed");
    let base = adjusted_bits(&state);
    let mut differing = 0;
    let mut worst = 0.0_f64;
    for _ in 0..64 {
        state.invalidate_adjusted_cache();
        let again = adjusted_bits(&state);
        if again == base {
            continue;
        }
        differing += 1;
        for ((_, left), (_, right)) in base.iter().zip(again.iter()) {
            for axis in 0..3 {
                worst = worst.max((f64::from_bits(left[axis]) - f64::from_bits(right[axis])).abs());
            }
        }
    }
    let project_after = state
        .capture_project_snapshot()
        .expect("capture_project_snapshot failed");
    assert_eq!(
        project_before, project_after,
        "the project itself changed during the measurement, so the re-solves did not share an input"
    );

    assert_eq!(
        differing, 0,
        "{differing} of 64 re-solves of the SAME project returned different coordinates \
         (worst {worst:e} m): the adjusted geometry the map draws and every export writes \
         depends on HashMap iteration order, not only on the project"
    );
}

// ===========================================================================
// Finding 22: a range delete is not the single deletes it says it generalizes
// ===========================================================================

/// Every `section_offsets` entry, by section, ascending.
fn section_offsets(state: &AppState) -> Vec<(SectionId, (f64, f64))> {
    let project = state.get_project_state().expect("no project open");
    let mut out: Vec<(SectionId, (f64, f64))> = project
        .section_offsets
        .iter()
        .map(|(id, offset)| (*id, (offset.0, offset.1)))
        .collect();
    out.sort_by_key(|entry| entry.0);
    out
}

/// A four-shot section merged at its far end to a one-shot section, anchored by
/// nothing. Returns `(a, b)`.
fn merged_chain_for_range_delete(state: &AppState) -> (SectionId, SectionId) {
    let a = create_section(
        state,
        "A",
        vec![
            shot(0.0, 5.0),
            shot(30.0, 6.0),
            shot(60.0, 7.0),
            shot(90.0, 8.0),
        ],
    );
    let b = create_section(state, "B", vec![shot(120.0, 5.0)]);
    let merged = state.execute(Command::MergeStations {
        station_a: StationRef::new(a, 4),
        station_b: StationRef::new(b, 0),
    });
    assert!(merged.success, "MergeStations failed: {:?}", merged.error);
    (a, b)
}

/// FINDING 22: `execute_delete_shot_range_shift` and the single deletes its own
/// doc comment says it generalizes put the survey in two different places.
///
/// `command_delete_split.rs:503-509` states the contract in as many words:
///
/// > Delete a contiguous range of shots by gap-closing (shifting) [...]
/// > Generalizes the single-shot `delete_shot` (`remove_shot_with_rewire`) to a
/// > range by deleting the range's shots in forward order within ONE
/// > `ProjectSnapshotPair` undo unit
///
/// It does not. Deleting the last two shots of a section whose far station is
/// merged to another section leaves the PARTNER section in a different place
/// depending on which entry point the user reached for: the range path leaves it
/// with no `section_offsets` entry at all, the two single deletes leave it seven
/// metres away at `(-6.06, -3.50)`.
///
/// Mechanism. The two routes differ in WHEN geometry is reconciled, not in what
/// they delete. `Command::DeleteShot` goes through `AppState::execute`, whose
/// epilogue runs `convert_orphan_closures_in_open_project()` and
/// `reconcile_geometry()` after EVERY command (`core/state/commands.rs:646-655`),
/// so the merged partner is re-anchored against the section as it shrinks, one
/// shot at a time. The range path does the whole range inside one project lock
/// and calls `reconcile_geometry()` once at the end
/// (`core/state/command_delete_split.rs:642`) - by which time the station the
/// merge was anchored to is already gone, so there is nothing left to re-anchor
/// the partner against and its offset is dropped instead of carried.
///
/// The range is a SUFFIX one on purpose, and that is the whole reduction: the
/// interior and prefix cases agree to the last bit. Measured, on this exact
/// topology:
///
/// | range | ranged | singles |
/// |---|---|---|
/// | prefix `[0..=1]`, plain | `[(0, (3.00, 10.20))]` | identical |
/// | prefix `[0..=1]`, merged | `[(0, (-14.06, -3.50)), (1, (0.00, 0.00))]` | identical |
/// | interior `[1..=2]`, merged | `[(0, ..), (1, (-9.06, -8.70))]` | identical |
/// | suffix `[2..=3]`, plain | `[]` | identical |
/// | **suffix `[2..=3]`, merged** | `[(0, (-17.06, -13.70))]` | **plus `(1, (-6.06, -3.50))`** |
///
/// Found by the metamorphic engine (`metamorphic_undo_tests.rs`), which drives
/// two `AppState`s loaded from ONE `.stalx` down the two routes and compares
/// them - seed 3, where the same divergence reads as a station moving 10.26 m
/// in the adjusted solve.
#[test]
#[ignore = "open finding 22: a range shift-delete is not the single deletes it generalizes - see src-tauri/src/core/state/metamorphic_undo_tests.rs"]
fn a_range_shift_delete_is_its_single_deletes() {
    let ranged_state = state_with_project();
    let (ranged_a, _) = merged_chain_for_range_delete(&ranged_state);
    let ids = shot_ids(&ranged_state, ranged_a);
    // The SUFFIX range: the last two shots, so the station the merge is anchored
    // to is one of the ones that goes.
    let ranged = ranged_state.execute_delete_shot_range_shift(ranged_a, ids[2], ids[3]);
    assert!(
        ranged.success,
        "execute_delete_shot_range_shift failed: {:?}",
        ranged.error
    );

    let singles_state = state_with_project();
    let (singles_a, _) = merged_chain_for_range_delete(&singles_state);
    // "in forward order": delete the shot at the range's start position, twice.
    for step in 0..2 {
        let live = shot_ids(&singles_state, singles_a);
        let single = singles_state.execute(Command::DeleteShot {
            section_id: singles_a,
            shot_id: live[2],
        });
        assert!(
            single.success,
            "single delete {step} failed: {:?}",
            single.error
        );
    }

    assert_eq!(
        section_offsets(&ranged_state),
        section_offsets(&singles_state),
        "deleting a suffix range in one call and deleting the same shots one at a time put the \
         merged partner section in two different places, so where the survey ends up depends on \
         which menu item the user reached for"
    );
}

// ===========================================================================
// Finding 24: describing a command with an out-of-range shot id overflows
// ===========================================================================

/// FINDING 24: `Command::description()` panics on a shot id near `u32::MAX`,
/// before any validation has had a chance to refuse it.
///
/// `shot_display_position` (`models/shot.rs:15-22`) converts a raw `ShotId` to
/// a 1-indexed display position:
///
/// ```text
/// let base = section_id.saturating_mul(FEATURE_ID_STRIDE);
/// if shot_id >= base { shot_id - base + 1 } else { shot_id + 1 }
/// ```
///
/// The multiply saturates; neither add does. `shot_id == u32::MAX` with a
/// section whose base is 0 takes the first arm and computes `u32::MAX + 1`.
///
/// It is reached from `Command::description()` (`core/command.rs:702`, `:710`,
/// `:717`), which `AppState::execute` calls on EVERY command to label the undo
/// entry and to build the corruption guard's message - so the panic happens
/// before the id is ever checked against the section. A debug or test build
/// aborts; a release build wraps and shows the user a nonsense position.
///
/// Found by the adversarial engine (`adversarial_tests.rs`), seeds 4 and 7.
#[test]
#[ignore = "open finding 24: shot_display_position overflows on a shot id near u32::MAX, and Command::description() calls it before validation - see src-tauri/src/core/state/adversarial_tests.rs"]
fn describing_a_command_with_an_out_of_range_shot_id_does_not_overflow() {
    let state = state_with_project();
    let section_id = create_section(&state, "A", vec![shot(0.0, 5.0)]);

    // No section holds this shot. The command must be REFUSED, not fatal.
    let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        state.execute(Command::SetShotKind {
            section_id,
            shot_id: ShotId::MAX,
            kind: ShotKind::Jump,
        })
    }));
    let message = match outcome {
        Ok(result) => {
            assert!(
                !result.success,
                "SetShotKind with a shot id no section holds reported success"
            );
            String::new()
        }
        Err(payload) => payload
            .downcast_ref::<String>()
            .cloned()
            .or_else(|| {
                payload
                    .downcast_ref::<&str>()
                    .map(|text| (*text).to_string())
            })
            .unwrap_or_else(|| "<non-string panic>".to_string()),
    };
    assert!(
        message.is_empty(),
        "describing a command with an out-of-range shot id panicked before the id was validated: \
         {message}"
    );
}

// ===========================================================================
// Finding 25: removing the PRIMARY zero datum silently redefines the origin
// every other datum is expressed in, and nothing re-anchors - so the next
// unrelated shot edit teleports a whole connected component
// ===========================================================================

/// Every zero datum after the first is stored as a GPS position and RESOLVED
/// against the first one: `set_zero_datum` places it at
/// `gps_to_local(gps, zero_datums.first().gps)` and only the first datum sits at
/// the local origin (models/project/mutations.rs:727-760). The same rule is
/// re-applied, from scratch, by `realign_after_shot_edit`
/// (models/project/mutations.rs:945-956) after any geometry-changing shot edit:
///
/// ```text
/// let is_first = self.zero_datums.first().map(|d| d.station_ref == datum.station_ref) ...
/// let (target_x, target_y) = if is_first { (0.0, 0.0) }
///                            else if let Some(first) = self.zero_datums.first() {
///                                gps_to_local(&datum.gps, &first.gps)
///                            } ...
/// ```
///
/// So `zero_datums[0]` IS the project's coordinate origin, and removing it moves
/// the origin onto whichever datum is now first - a change of frame for every
/// other anchored component in the project.
///
/// Nothing re-solves for it. `remove_zero_datum` (core/state/command_station.rs:191)
/// does call `resolve_offsets()`, but that solver deliberately never touches an
/// anchor's own offset - "only the genuinely non-derivable anchors (datum
/// sections and free-placed floating components) keep their stored offset,
/// because the cascade never seed-adjusts them" (models/project/offsets.rs:289-296).
/// A datum section IS such an anchor, so the surviving datum keeps the offset it
/// was given while it was still a SECONDARY datum, and the project is left
/// holding a placement its own rule no longer produces.
///
/// The bill arrives on the next unrelated edit. `realign_after_shot_edit` re-runs
/// the rule with the CURRENT first datum, so an `UpdateShot` on a shot in (or
/// merged to) that section rigidly translates the whole connected component onto
/// the new origin in one move - kilometres, for two datums a few hundred metres
/// apart in latitude/longitude.
///
/// Found by the Rust fuzzer's HORIZON mode, seed 2, at undo depth 1189: sections
/// 65 and 81 both off by exactly `(22230.0946076, -10480.744175)` with 81 landing
/// on `[0, 0]` - the offset a section gets when the surviving datum is its own
/// station 0. `fuzz_shrink_tests.rs` minimized that 1770-move trace to seven
/// moves, of which this is the reduction.
#[test]
#[ignore = "open finding 25: removing the primary zero datum leaves every other datum on a stale origin until an unrelated shot edit teleports it - see src-tauri/src/core/state/fuzz_undo_tests.rs"]
fn removing_the_primary_zero_datum_re_anchors_the_datums_it_leaves_behind() {
    let state = state_with_project();
    let origin = create_section(&state, "Origin", vec![shot(10.0, 3.0), shot(20.0, 4.0)]);
    let anchored = create_section(&state, "Anchored", vec![shot(70.0, 7.0), shot(100.0, 8.0)]);

    // The FIRST datum is the project's local origin.
    let first = state.execute(Command::SetZeroDatum {
        station_ref: StationRef::new(origin, 0),
        coordinates: GpsCoordinates::new(20.4, -87.3, 0.0).unwrap(),
    });
    assert!(
        first.success,
        "SetZeroDatum (first) failed: {:?}",
        first.error
    );
    // The SECOND is placed relative to it - about 6.4 km away.
    let second = state.execute(Command::SetZeroDatum {
        station_ref: StationRef::new(anchored, 1),
        coordinates: GpsCoordinates::new(20.4358, -87.3479, 0.0).unwrap(),
    });
    assert!(
        second.success,
        "SetZeroDatum (second) failed: {:?}",
        second.error
    );
    let far = section_offset(&state, anchored).expect("the second datum should place its section");
    assert!(
        far.0.abs() > 1000.0,
        "setup: the second datum should sit kilometres from the first, got {far:?}"
    );

    // The primary datum goes away. `remove_zero_datum` re-solves offsets, so
    // whatever the project holds after this is what it believes.
    let removed = state.execute(Command::RemoveZeroDatum {
        station_ref: StationRef::new(origin, 0),
    });
    assert!(
        removed.success,
        "RemoveZeroDatum failed: {:?}",
        removed.error
    );
    let settled = section_offset(&state, anchored);

    // An edit that has nothing to do with the datum, several moves later.
    let target = shot_ids(&state, anchored)[0];
    let edited = state.execute(Command::UpdateShot {
        section_id: anchored,
        shot_id: target,
        updates: ShotUpdates {
            length: Some(9.0),
            ..Default::default()
        },
    });
    assert!(edited.success, "UpdateShot failed: {:?}", edited.error);

    let after = section_offset(&state, anchored).expect("the anchored section lost its offset");
    let moved = settled.map_or(f64::INFINITY, |before| {
        (after.0 - before.0).hypot(after.1 - before.1)
    });
    assert!(
        moved < 1.0,
        "an UpdateShot moved the anchored section {moved:.1} m (from {settled:?} to {after:?}): \
         removing the primary zero datum promoted this one to the origin without re-solving, so \
         the whole component sat on a stale frame until an unrelated shot edit re-anchored it"
    );
}

/// The undo half, and the one the fuzzer's roundtrip oracle actually reports:
/// the teleport is not undone.
///
/// `UndoData::PreviousValues` restores the shot's fields, and the geometry
/// epilogue then runs `realign_after_shot_edit` AGAIN - against the same
/// (already promoted) first datum. So the undo re-derives the NEW frame rather
/// than restoring the offsets the edit found, and one `undo()` leaves the
/// project's geometry kilometres from where it was before the edit it undid.
///
/// This is what makes it an undo/redo finding rather than only a geometry one: a
/// single `undo` of a single `UpdateShot` is not a no-op on `section_offsets`.
#[test]
#[ignore = "open finding 25 (undo half): the component translation an edit performs after the primary datum was removed survives its own undo - see src-tauri/src/core/state/fuzz_undo_tests.rs"]
fn undoing_the_edit_that_re_anchored_a_component_puts_it_back() {
    let state = state_with_project();
    let origin = create_section(&state, "Origin", vec![shot(10.0, 3.0), shot(20.0, 4.0)]);
    let anchored = create_section(&state, "Anchored", vec![shot(70.0, 7.0), shot(100.0, 8.0)]);

    assert!(
        state
            .execute(Command::SetZeroDatum {
                station_ref: StationRef::new(origin, 0),
                coordinates: GpsCoordinates::new(20.4, -87.3, 0.0).unwrap(),
            })
            .success,
        "SetZeroDatum (first) failed"
    );
    assert!(
        state
            .execute(Command::SetZeroDatum {
                station_ref: StationRef::new(anchored, 1),
                coordinates: GpsCoordinates::new(20.4358, -87.3479, 0.0).unwrap(),
            })
            .success,
        "SetZeroDatum (second) failed"
    );
    assert!(
        state
            .execute(Command::RemoveZeroDatum {
                station_ref: StationRef::new(origin, 0),
            })
            .success,
        "RemoveZeroDatum failed"
    );

    let before = section_offset(&state, anchored);
    let target = shot_ids(&state, anchored)[0];
    assert!(
        state
            .execute(Command::UpdateShot {
                section_id: anchored,
                shot_id: target,
                updates: ShotUpdates {
                    length: Some(9.0),
                    ..Default::default()
                },
            })
            .success,
        "UpdateShot failed"
    );
    assert!(state.undo().success, "undo of UpdateShot failed");

    assert_eq!(
        section_offset(&state, anchored),
        before,
        "undoing the UpdateShot did not restore the section offset it found: the edit re-anchored \
         the component onto the datum that the primary datum's removal had promoted, and the undo \
         re-derives the same new frame instead of putting the old one back"
    );
}

/// The same defect reached the way a user reaches it, and the way the fuzzer did:
/// nobody removed a datum, they deleted a SHOT.
///
/// `DeleteShot` on the first shot of a section removes that section's station 0,
/// and the reference cleanup drops every stored ref anchored there - including a
/// zero datum keyed `StationAnchor::SectionStart`. If that datum was the primary
/// one, the project's origin has just moved and no command was issued that says
/// so. Everything after is finding 25 exactly as above.
///
/// This is the shape the shrinker minimized the horizon failure to: an empty
/// section, one appended shot, a second datum, `deleteShot`, a merge, and one
/// `updateShot`.
#[test]
#[ignore = "open finding 25 (via DeleteShot): deleting the shot that carries the primary datum's station moves the project origin with no re-solve - see src-tauri/src/core/state/fuzz_undo_tests.rs"]
fn deleting_the_primary_datums_station_does_not_silently_move_the_origin() {
    let state = state_with_project();
    let origin = create_section(&state, "Origin", vec![shot(10.0, 3.0), shot(20.0, 4.0)]);
    let anchored = create_section(&state, "Anchored", vec![shot(70.0, 7.0), shot(100.0, 8.0)]);

    assert!(
        state
            .execute(Command::SetZeroDatum {
                station_ref: StationRef::new(origin, 0),
                coordinates: GpsCoordinates::new(20.4, -87.3, 0.0).unwrap(),
            })
            .success,
        "SetZeroDatum (first) failed"
    );
    assert!(
        state
            .execute(Command::SetZeroDatum {
                station_ref: StationRef::new(anchored, 1),
                coordinates: GpsCoordinates::new(20.4358, -87.3479, 0.0).unwrap(),
            })
            .success,
        "SetZeroDatum (second) failed"
    );

    // Deleting the first shot removes station 0, and with it the datum anchored
    // to `SectionStart`.
    let first_shot = shot_ids(&state, origin)[0];
    let deleted = state.execute(Command::DeleteShot {
        section_id: origin,
        shot_id: first_shot,
    });
    assert!(deleted.success, "DeleteShot failed: {:?}", deleted.error);
    let settled = section_offset(&state, anchored);

    let target = shot_ids(&state, anchored)[0];
    assert!(
        state
            .execute(Command::UpdateShot {
                section_id: anchored,
                shot_id: target,
                updates: ShotUpdates {
                    length: Some(9.0),
                    ..Default::default()
                },
            })
            .success,
        "UpdateShot failed"
    );

    let after = section_offset(&state, anchored).expect("the anchored section lost its offset");
    let moved = settled.map_or(f64::INFINITY, |before| {
        (after.0 - before.0).hypot(after.1 - before.1)
    });
    assert!(
        moved < 1.0,
        "a DeleteShot that removed the primary datum's station left the survey on a stale origin, \
         and the next UpdateShot moved the anchored section {moved:.1} m (from {settled:?} to \
         {after:?}) with no command in between that asked for it"
    );
}

// ===========================================================================
// Finding 12, CASCADING: the shot the stale id edited by mistake still carries
// the edit several undos later, when the entry being consumed is unrelated and
// its own persisted id is FRESH
// ===========================================================================

/// Finding 12 is a single move going wrong; this is what a user sees, and it is
/// why the Rust fuzzer reported it as something else for a while.
///
/// After a reload, the undo of `UpdateShot` names its shot by an id the loader
/// has since reassigned, so it writes the pre-edit values onto a NEIGHBOUR and
/// leaves the edited shot as it was (finding 12). Nothing puts either half back:
/// the corruption sits in the PROJECT, not in the entry, so every undo below it
/// restores a state that still carries it - including undos of entries pushed on
/// a completely different section, whose own persisted ids resolve perfectly.
///
/// That last part is what made this look like a new defect. The fuzzer measures
/// staleness on the entry it is consuming NOW, so at the depth this fails the
/// measurement reads `target=Fresh`: the `SetShotKind` entry below the
/// `UpdateShot` names a shot on another section whose id did not move. The
/// damage was done one move earlier, by an entry that measured `Collides`.
///
/// Root-caused from `fuzz_shrink_tests.rs`, which minimized the 59-move seed 10
/// run (`PERSISTENCE=1 CROSSINGS=3 ITERATIONS=60`) to three moves - reproduced
/// here directly. The insert-BEFORE is the whole setup: it makes the allocator's
/// ids disagree with positional order, and the loader renumbers to
/// `section_id * FEATURE_ID_STRIDE + sequence_order`
/// (persistence/sqlite/read.rs), which swaps the two.
///
/// Pinned separately from the two finding 12 tests above because they assert the
/// FIRST undo and this asserts that the second one cannot clean up after it -
/// exactly the relationship finding 15 has to finding 3.
#[test]
#[ignore = "open finding 12 (cascading): the shot a stale id edited by mistake still carries the edit after later, unrelated undos - see src-tauri/src/core/state/fuzz_undo_tests.rs"]
fn unwinding_past_a_stale_id_edit_leaves_no_shot_holding_it() {
    let temp = TempDir::new().unwrap();
    let save_path: PathBuf = temp.path().join("stale-cascade.stalx");

    let edited_section;
    let other_section;
    let inserted_uuid;
    let neighbour_uuid;
    let inserted_length;
    let neighbour_length;
    {
        let state = state_with_project();
        edited_section = create_section(&state, "Edited", vec![shot(0.0, 5.0)]);
        other_section = create_section(&state, "Other", vec![shot(90.0, 6.0)]);

        // Move 1: insert BEFORE the existing shot, so position 0 holds the
        // HIGHEST id the allocator handed out.
        let existing = shot_ids(&state, edited_section)[0];
        let created = state.execute(Command::CreateShot {
            section_id: edited_section,
            shot: shot(180.0, 7.0),
            after_shot_id: None,
            before_shot_id: Some(existing),
        });
        assert!(created.success, "CreateShot failed: {:?}", created.error);
        let uuids = shot_uuids(&state, edited_section);
        inserted_uuid = uuids[0].clone().expect("inserted shot has no uuid");
        neighbour_uuid = uuids[1].clone().expect("neighbour shot has no uuid");
        let lengths = shot_lengths(&state, edited_section);
        inserted_length = lengths[0];
        neighbour_length = lengths[1];

        // Move 2: an edit on a DIFFERENT section, so the entry below the one
        // that goes wrong is one whose persisted id will still be correct.
        let other_shot = shot_ids(&state, other_section)[0];
        let marked = state.execute(Command::SetShotKind {
            section_id: other_section,
            shot_id: other_shot,
            kind: ShotKind::Jump,
        });
        assert!(marked.success, "SetShotKind failed: {:?}", marked.error);

        // Move 3: the edit whose undo will use the stale id.
        let target = shot_ids(&state, edited_section)[0];
        let updated = state.execute(Command::UpdateShot {
            section_id: edited_section,
            shot_id: target,
            updates: ShotUpdates {
                length: Some(42.5),
                ..Default::default()
            },
        });
        assert!(updated.success, "UpdateShot failed: {:?}", updated.error);

        let saved = state.save_project(Some(save_path.clone()));
        assert!(saved.success, "save failed: {:?}", saved.error);
    }

    let reopened = AppState::new().unwrap();
    let opened = reopened.execute(Command::OpenProject { path: save_path });
    assert!(opened.success, "reopen failed: {:?}", opened.error);

    // Undo the UpdateShot (finding 12 fires here) and then the SetShotKind,
    // which is on the other section entirely.
    assert!(reopened.undo().success, "undo of UpdateShot failed");
    assert!(reopened.undo().success, "undo of SetShotKind failed");

    let project = reopened.get_project_state().expect("no project after undo");
    let section = project
        .sections
        .iter()
        .find(|s| s.id == edited_section)
        .expect("section missing");
    let length_of = |uuid: &str| -> f64 {
        section
            .shots
            .iter()
            .find(|s| s.uuid.as_deref() == Some(uuid))
            .expect("shot vanished")
            .length
    };

    assert!(
        (length_of(&inserted_uuid) - inserted_length).abs() < 1e-9
            && (length_of(&neighbour_uuid) - neighbour_length).abs() < 1e-9,
        "unwinding two entries past the stale-id edit left section {edited_section} holding \
         {:?} instead of {:?}: the undo of UpdateShot wrote the pre-edit length onto the \
         NEIGHBOUR (finding 12) and the undo below it - a SetShotKind on section \
         {other_section}, whose own persisted id is fresh - restores a state that still carries \
         the swap",
        (length_of(&inserted_uuid), length_of(&neighbour_uuid)),
        (inserted_length, neighbour_length)
    );
}

// ===========================================================================
// Finding 5, on the COMMAND side: a reloaded UpdateSectionMetadata no longer
// knows it was clearing a field - so the entry mis-describes itself, and its
// redo silently under-applies
// ===========================================================================

/// `SectionUpdates::name` / `surveyor` / `date` are `Option<Option<T>>` behind a
/// plain `#[serde(default)]` with no `double_option` (models/section.rs:122).
/// `Some(None)` ("clear it") and `None` ("leave it alone") therefore BOTH
/// serialize to `null`, and `null` reads back as `None` - so the distinction
/// survives the write and dies on the read.
///
/// Finding 5 already pins that gap on the entry's `values_json`, where it costs
/// an UNDO. This is the same gap on the entry's stored COMMAND, where it costs a
/// REDO: `redo_inner` re-executes `entry.command` for a `PreviousValues` entry
/// (its catch-all arm, core/state/undo.rs), and a reloaded command that says
/// "leave the surveyor alone" leaves it alone.
///
/// The previous value here is deliberately NON-null ("Ferreira"), so the undo in
/// the middle is one finding 5 does not touch: what this isolates is the redo.
/// Nothing in the sequence is unusual - clear a field, save, reopen, undo, redo -
/// and the survey silently keeps a surveyor the user removed.
///
/// Found by `fuzz_undo_tests.rs`'s entry-content oracle, which sees the harmless
/// half of the same defect first: the reloaded entry's history-dropdown preview
/// stops listing the Surveyor row (`the_history_preview_still_reports_a_cleared_field`).
#[test]
#[ignore = "open finding 5 (command side): a reloaded UpdateSectionMetadata cannot clear a field, so its redo under-applies - see src-tauri/src/core/state/fuzz_undo_tests.rs"]
fn redo_after_reload_clears_the_section_field_it_cleared() {
    let temp = TempDir::new().unwrap();
    let save_path: PathBuf = temp.path().join("cleared-field.stalx");

    let section_id;
    {
        let state = state_with_project();
        let created = state.execute(Command::CreateSection {
            name: Some("Sump".to_string()),
            surveyor: Some("Ferreira".to_string()),
            date: None,
            color: "#3388FF".to_string(),
            direction: None,
            shots: vec![shot(0.0, 5.0)],
        });
        assert!(created.success, "CreateSection failed: {:?}", created.error);
        section_id = created.section_id.expect("CreateSection returned no id");

        // The edit under test: CLEAR the surveyor. `Some(None)`, not `None`.
        let cleared = state.execute(Command::UpdateSectionMetadata {
            section_id,
            updates: SectionUpdates {
                surveyor: Some(None),
                ..Default::default()
            },
        });
        assert!(cleared.success, "clearing failed: {:?}", cleared.error);
        assert_eq!(
            surveyor_of(&state, section_id),
            CLEARED,
            "setup: the clear did not take effect before the save"
        );

        let saved = state.save_project(Some(save_path.clone()));
        assert!(saved.success, "save failed: {:?}", saved.error);
    }

    let reopened = AppState::new().unwrap();
    let opened = reopened.execute(Command::OpenProject { path: save_path });
    assert!(opened.success, "reopen failed: {:?}", opened.error);

    let undone = reopened.undo();
    assert!(
        undone.success,
        "undo after reopen failed: {:?}",
        undone.error
    );
    assert_eq!(
        surveyor_of(&reopened, section_id),
        "Ferreira",
        "setup: the undo did not put the surveyor back, so this test is measuring finding 5's \
         UNDO half rather than its command half"
    );

    let redone = reopened.redo();
    assert!(
        redone.success,
        "redo after reopen failed: {:?}",
        redone.error
    );

    assert_eq!(
        surveyor_of(&reopened, section_id),
        CLEARED,
        "the redo of a reloaded 'clear the surveyor' left the surveyor in place: the persisted \
         command's `Some(None)` came back as `None`, which `update_section` reads as 'leave it \
         alone'"
    );
}

/// The same defect, one step earlier and visible without touching the project:
/// the history dropdown stops saying the entry cleared anything.
///
/// `derive_preview_data` builds the `UpdateSectionMetadata` rows from
/// `updates.surveyor` (commands/history.rs), so an entry whose `Some(None)` has
/// decayed to `None` renders no Surveyor row at all - and when the cleared field
/// was the only thing the edit changed, `preview_data` becomes `null` and the
/// hover is empty. The entry still UNDOES correctly here; it just no longer says
/// what it did.
#[test]
#[ignore = "open finding 5 (command side): a reloaded entry's preview drops the field it cleared - see src-tauri/src/core/state/fuzz_undo_tests.rs"]
fn the_history_preview_still_reports_a_cleared_field() {
    let temp = TempDir::new().unwrap();
    let save_path: PathBuf = temp.path().join("cleared-preview.stalx");

    let before;
    {
        let state = state_with_project();
        let created = state.execute(Command::CreateSection {
            name: Some("Sump".to_string()),
            surveyor: Some("Ferreira".to_string()),
            date: None,
            color: "#3388FF".to_string(),
            direction: None,
            shots: vec![shot(0.0, 5.0)],
        });
        assert!(created.success, "CreateSection failed: {:?}", created.error);
        let section_id = created.section_id.expect("CreateSection returned no id");

        let cleared = state.execute(Command::UpdateSectionMetadata {
            section_id,
            updates: SectionUpdates {
                surveyor: Some(None),
                ..Default::default()
            },
        });
        assert!(cleared.success, "clearing failed: {:?}", cleared.error);
        before = preview_fields(&state);
        assert!(
            before.contains(&"Surveyor".to_string()),
            "setup: the preview did not list the Surveyor row before the save, it listed {before:?}"
        );

        let saved = state.save_project(Some(save_path.clone()));
        assert!(saved.success, "save failed: {:?}", saved.error);
    }

    let reopened = AppState::new().unwrap();
    let opened = reopened.execute(Command::OpenProject { path: save_path });
    assert!(opened.success, "reopen failed: {:?}", opened.error);

    assert_eq!(
        preview_fields(&reopened),
        before,
        "the reloaded entry's history preview no longer lists the field it cleared"
    );
}

/// The newest undo entry's preview rows, by field label.
fn preview_fields(state: &AppState) -> Vec<String> {
    state
        .get_undo_stack()
        .first()
        .and_then(|item| item.preview_data.as_ref())
        .map(|preview| {
            preview
                .changes
                .iter()
                .map(|change| change.field.clone())
                .collect()
        })
        .unwrap_or_default()
}

/// A section's surveyor, rendered so that a CLEARED field and a missing section
/// cannot read as the same thing.
fn surveyor_of(state: &AppState, section_id: SectionId) -> String {
    let project = state.get_project_state().expect("no project open");
    let section = project
        .sections
        .iter()
        .find(|section| section.id == section_id)
        .expect("section missing");
    section
        .surveyor
        .clone()
        .unwrap_or_else(|| CLEARED.to_string())
}

/// What [`surveyor_of`] renders for a field that has been cleared.
const CLEARED: &str = "<cleared>";

// ===========================================================================
// Finding 23, in the history dropdown: an f64 that serde_json writes and its own
// parser cannot read back
// ===========================================================================

/// `format_property_tests.rs` records finding 23 as "a save/load cycle is not a
/// fixpoint", with the gzipped `undo_stack` / `redo_stack` JSON blobs as one of
/// the two places the drift lives. This is that drift with its mechanism named
/// and a user-visible consequence attached.
///
/// `serde_json` writes an `f64` through ryu's shortest round-tripping form and
/// reads it back with a parser that is not correctly rounded past 16 significant
/// digits: `13.565000000000001` is written for the bits `0x402b2147ae147ae2`,
/// `str::parse::<f64>` returns exactly those bits, and `serde_json::from_str`
/// returns `0x402b2147ae147ae1` - one ULP low. (`serde_json`'s `float_roundtrip`
/// feature switches its parser to the correctly-rounded one; this crate is built
/// without it, so every persisted undo command carrying a 17-digit float comes
/// back changed.)
///
/// One ULP is invisible until it crosses a rendering boundary. The history
/// preview renders a shot length at two decimals, and this value sits exactly on
/// one: `13.57` before the save, `13.56` after it, on an entry nobody touched.
///
/// Found by `fuzz_undo_tests.rs`'s entry-content oracle
/// (`finding-23-history-float-dust-moves-a-displayed-value`).
#[test]
#[ignore = "open finding 23 (history payloads): serde_json reads back an f64 it wrote one ULP low, changing what a reloaded undo entry displays - see src-tauri/src/core/state/format_property_tests.rs"]
fn a_reloaded_entry_displays_the_length_it_was_given() {
    let temp = TempDir::new().unwrap();
    let save_path: PathBuf = temp.path().join("ulp.stalx");

    // The bits ryu renders as `13.565000000000001`, one ULP above the f64
    // nearest to 13.565 - which is what serde_json's parser returns for it.
    let length = f64::from_bits(0x402b_2147_ae14_7ae2);
    let before;
    {
        let state = state_with_project();
        let section_id = create_section(&state, "Traverse", vec![shot(0.0, 5.0)]);
        let shot_id = shot_ids(&state, section_id)[0];
        let updated = state.execute(Command::UpdateShot {
            section_id,
            shot_id,
            updates: ShotUpdates {
                length: Some(length),
                ..Default::default()
            },
        });
        assert!(updated.success, "UpdateShot failed: {:?}", updated.error);
        before = preview_values(&state);
        assert_eq!(
            before,
            vec!["13.57".to_string()],
            "setup: the preview did not render the length as expected before the save"
        );

        let saved = state.save_project(Some(save_path.clone()));
        assert!(saved.success, "save failed: {:?}", saved.error);
    }

    let reopened = AppState::new().unwrap();
    let opened = reopened.execute(Command::OpenProject { path: save_path });
    assert!(opened.success, "reopen failed: {:?}", opened.error);

    assert_eq!(
        preview_values(&reopened),
        before,
        "the reloaded entry displays a different length than the one it was created with; the \
         value moved by one ULP on the way through serde_json's own parser"
    );
}

/// The newest undo entry's preview rows, by rendered new value.
fn preview_values(state: &AppState) -> Vec<String> {
    state
        .get_undo_stack()
        .first()
        .and_then(|item| item.preview_data.as_ref())
        .map(|preview| {
            preview
                .changes
                .iter()
                .map(|change| change.new_value.clone())
                .collect()
        })
        .unwrap_or_default()
}
