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
    ClosureStrategy, GpsCoordinates, SectionId, SectionUpdates, ShotData, ShotId, StationRef,
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
// Bug 7: REAL, but not reproducible by a minimal construction - no test
// ===========================================================================
//
// `undo()`/`redo()` call `invalidate_adjusted_cache()` and
// `reconcile_geometry()`; `undo_to()`/`redo_to()` loop the `*_inner` variants
// and call NEITHER (core/state/undo.rs). That is verified in the source, and the
// fuzzer reproduces the consequence twice - a 2.4 m `section_offsets` divergence
// (fractal seed 12 x40) and a merge left 5.00 m out of alignment that only the
// integrity oracle caught (fractal seed 15 x40).
//
// It resists a minimal synthetic repro because the divergence only appears when
// a jump walks past drift that `realign_merges` would otherwise heal, and the
// only drift source small enough to build here is bug 3 - whose `pos == 0`
// branch DROPS the merge keyed to station 0 in the same breath as displacing the
// section. An empty section has no other station to merge on, so the very undo
// that creates the drift also removes the merge that would have been misaligned,
// and both unwind strategies then agree.
//
// A test that passes would claim to pin this and does not, so there is none.
// Reproduce with the fuzzer seeds above.
//
// ===========================================================================
// Finding 10: NOT reproduced by a minimal construction - deliberately no test
// ===========================================================================
//
// The fuzzer saw a loop closure come back from a save/reopen as a station merge
// (naharon seed 26 x40): `redrive_offsets_after_load` calls
// `convert_orphan_closures_to_merges` unconditionally
// (models/project/offsets.rs), reclassifying a closure whose endpoints are no
// longer independently connected.
//
// Every minimal construction tried here - create a closure, then remove the
// merge that provided the loop's other path, save, reopen - comes back
// PRESERVED, because `execute`'s epilogue runs the same conversion for removal
// commands, so the in-memory state is already normalized before the save. In
// other words the simple paths are consistent, and whatever reaches the
// divergent state does so through a path that skips that epilogue.
//
// A test asserting preservation would therefore PASS and quietly claim to pin a
// bug it does not, which is worse than no test. Left uncovered on purpose; the
// only known reproduction is the fuzzer seed named above.
