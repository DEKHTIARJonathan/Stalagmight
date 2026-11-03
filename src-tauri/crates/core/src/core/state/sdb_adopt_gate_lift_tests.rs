//! [#576 RV5-F4-6] The Ariane adoption lifts its hold on the edit gate when it
//! returns - on every exit.
//!
//! `adopt_import_and_save` shuts the gate at the end of its local span, and
//! `speleodb_adopt_ariane` lifts it through an `AdoptionEditGate` guard built
//! before that span. `sdb_adopt_edit_gate_tests` lifts the gate by hand, so
//! removing the guard from the verb passed every adoption test, and the gate would
//! then stay shut over a still-open adopted project (after a Failed hand-over, for
//! one) until the next session commit.
//!
//! Two halves, because reaching the verb's lift for real needs a server that
//! accepts the lock, serves the dump and takes the push (the same reason the
//! verb's other ordering rules are guarded by source in `speleodb_pull`'s tests):
//!
//! 1. the guard lifts the gate on a normal return, an early error return and a panic;
//! 2. the verb binds that guard to a NAME (a `let _ =` would drop it on the spot)
//!    before it calls `adopt_import_and_save`, and never drops it early.
//!
//! All data is synthetic, built in memory.

use std::panic::{catch_unwind, AssertUnwindSafe};

use super::speleodb_pull::AdoptionEditGate;
use super::AppState;
use crate::core::Command;

/// An open project whose gate an adoption has shut.
fn gate_shut_by_an_adoption() -> AppState {
    let state = AppState::new().unwrap();
    assert!(
        state
            .execute(Command::CreateProject {
                name: "CaveA".to_string(),
                location: None,
            })
            .success
    );
    state.speleodb_shut_gate_for_adoption();
    assert!(state.speleodb_adoption_holds_gate());
    state
}

/// The adoption's shape: the guard first, then a step that may fail early.
fn adoption_like(state: &AppState, fail: bool) -> Result<(), String> {
    let _edit_gate = AdoptionEditGate(state);
    if fail {
        return Err("the hand-over failed".to_string());
    }
    Ok(())
}

#[test]
fn the_adoption_guard_lifts_the_gate_on_every_exit() {
    let returned = gate_shut_by_an_adoption();
    let ok = adoption_like(&returned, false);
    let after_return = returned.speleodb_adoption_holds_gate();

    let failed = gate_shut_by_an_adoption();
    let err = adoption_like(&failed, true);
    let after_error = failed.speleodb_adoption_holds_gate();

    let crashed = gate_shut_by_an_adoption();
    let panicked = catch_unwind(AssertUnwindSafe(|| {
        let _edit_gate = AdoptionEditGate(&crashed);
        panic!("synthetic panic inside an adoption (#576 RV5-F4-6 test)");
    }));
    let after_panic = crashed.speleodb_adoption_holds_gate();

    println!(
        "gate still held after: a return ({ok:?}) -> {after_return}; an early error \
         ({err:?}) -> {after_error}; a panic ({}) -> {after_panic}",
        panicked.is_err()
    );
    assert!(!after_return && !after_error && !after_panic);
}

/// The production half of `speleodb_pull.rs` (its test module follows it).
fn pull_prod_source() -> &'static str {
    crate::models::source_scan::prod_region(
        include_str!("speleodb_pull.rs"),
        "pub fn speleodb_adopt_ariane(",
    )
}

#[test]
fn the_adoption_verb_holds_the_guard_across_its_local_span() {
    let src = pull_prod_source();
    let start = src.find("pub fn speleodb_adopt_ariane(").unwrap();
    let body = &src[start..];
    let body = &body[..body.find("\n    }\n").unwrap()];

    let guard = body.find("= AdoptionEditGate(self);");
    let binding = guard.map(|at| {
        let line_start = body[..at].rfind('\n').map_or(0, |n| n + 1);
        body[line_start..at].trim().to_string()
    });
    let span = body.find("self.adopt_import_and_save(");
    println!(
        "speleodb_adopt_ariane: guard at {guard:?} bound as {binding:?}; local span at \
         {span:?}; early drops of the guard: {}",
        body.matches("drop(_edit_gate)").count()
    );
    let (Some(guard), Some(span)) = (guard, span) else {
        panic!("the adoption verb must build an AdoptionEditGate and call the local span");
    };
    assert!(
        guard < span,
        "the guard is built before the span that shuts the gate"
    );
    let binding = binding.unwrap();
    assert!(
        binding.starts_with("let _") && binding != "let _",
        "the guard is bound to a name for the whole call (`let _ =` drops it at once), \
         got `{binding}`"
    );
    assert_eq!(
        body.matches("drop(_edit_gate)").count(),
        0,
        "and is never dropped early"
    );
}
