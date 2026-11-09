//! The app's exit never cuts an in-flight SpeleoDB operation (lock#6, frontend#4).
//!
//! Before, `RunEvent::ExitRequested` ran the bounded lock release, which queued
//! behind the upload holding the lock-ops span for 5 seconds and then let the
//! process exit anyway: the upload was killed mid-transfer with an unknown
//! outcome, and the lock stayed held (SpeleoDB has no lock timeout).
//!
//! Now the exit is the LAST step of one "quit after in-flight work" path:
//!
//! 1. The frontend's close listener (`src/utils/quitAfterWork.ts`) is the first
//!    gate for every quit route that has a window - menu Quit, Ctrl+Q, the window
//!    X, an OS close, the update restart. While an operation is in flight it
//!    keeps the window, toasts that the app will close when the work finishes,
//!    shows progress, and quits once it is done. "Quit now" is an explicit
//!    in-app choice behind a warning; it arms [`arm_forced_exit`].
//! 2. This hook is the backstop for whatever reaches the exit anyway (a backend
//!    operation the frontend does not see, a window destroyed without the
//!    listener): with an operation in flight and no forced quit armed, it
//!    PREVENTS the exit, waits for the operation off the main thread, runs the
//!    bounded release, and then exits.
//!
//! The update restart (`app.restart()`) cannot be prevented by Tauri; it only
//! ever runs after the frontend gate has let the quit through.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::{AppHandle, Manager, State};

use crate::core::AppState;

/// How long an armed forced quit stays valid. It covers one hop - the frontend
/// arms it right before it destroys the window - so a stale arm can never let a
/// later, ordinary quit cut a transfer.
const FORCED_EXIT_TTL: Duration = Duration::from_secs(10);

/// Managed exit state.
#[derive(Default)]
pub struct ExitWait {
    /// Until when the user's explicit "Quit now" may cut an in-flight operation.
    forced_until: Mutex<Option<Instant>>,
    /// A background wait is already running for this exit.
    waiting: AtomicBool,
    /// The background wait finished and released: the exit it re-issues goes on.
    drained: AtomicBool,
}

impl ExitWait {
    fn forced(&self) -> bool {
        self.forced_until
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .is_some_and(|until| Instant::now() < until)
    }
}

/// What the exit hook does with one `ExitRequested`.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum ExitStep {
    /// Our own re-issued exit after the wait: everything is already done.
    Proceed,
    /// Nothing to wait for (or the user chose to cut it): release, bounded, and exit.
    ReleaseAndExit,
    /// Keep the process, wait for the operation off the main thread, then exit.
    WaitThenExit,
    /// A wait for this exit is already running; keep the process.
    KeepWaiting,
}

/// The decision, kept pure so it is testable without a running app.
pub(crate) fn exit_step(
    drained: bool,
    forced: bool,
    restart: bool,
    in_flight: bool,
    already_waiting: bool,
) -> ExitStep {
    if drained {
        ExitStep::Proceed
    } else if forced || restart || !in_flight {
        // A restart cannot be prevented (Tauri ignores `prevent_exit` for it).
        ExitStep::ReleaseAndExit
    } else if already_waiting {
        ExitStep::KeepWaiting
    } else {
        ExitStep::WaitThenExit
    }
}

/// The `RunEvent::ExitRequested` hook (see the module doc).
pub fn on_exit_requested(app: &AppHandle, code: Option<i32>, api: &tauri::ExitRequestApi) {
    let Some(state) = app.try_state::<AppState>() else {
        return;
    };
    let wait = app.state::<ExitWait>();
    let step = exit_step(
        wait.drained.load(Ordering::SeqCst),
        wait.forced(),
        code == Some(tauri::RESTART_EXIT_CODE),
        state.speleodb_operation_in_flight(),
        wait.waiting.load(Ordering::SeqCst),
    );
    match step {
        ExitStep::Proceed => {}
        ExitStep::ReleaseAndExit => {
            state.speleodb_release_held_lock_bounded(crate::EXIT_LOCK_RELEASE_TIMEOUT);
        }
        ExitStep::KeepWaiting => api.prevent_exit(),
        ExitStep::WaitThenExit => {
            api.prevent_exit();
            wait.waiting.store(true, Ordering::SeqCst);
            tracing::info!(
                purpose = "let an in-flight SpeleoDB operation finish before exiting",
                "exit deferred until the SpeleoDB operation in flight has finished"
            );
            let app = app.clone();
            std::thread::spawn(move || {
                let state = app.state::<AppState>();
                state.speleodb_wait_for_in_flight_operation();
                state.speleodb_release_held_lock_bounded(crate::EXIT_LOCK_RELEASE_TIMEOUT);
                app.state::<ExitWait>()
                    .drained
                    .store(true, Ordering::SeqCst);
                app.exit(0);
            });
        }
    }
}

/// The user's explicit "Quit now" from the in-app waiting prompt: the exit that
/// follows within [`FORCED_EXIT_TTL`] may cut the operation in flight instead of
/// waiting for it.
#[tauri::command]
pub fn arm_forced_exit(wait: State<'_, ExitWait>) {
    *wait
        .forced_until
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner) =
        Some(Instant::now() + FORCED_EXIT_TTL);
    tracing::warn!(
        purpose = "quit without waiting for an in-flight SpeleoDB operation (user chose it)",
        "forced exit armed"
    );
}

#[cfg(test)]
#[expect(
    clippy::expect_used,
    reason = "test module: panics on a failed assumption are the point"
)]
mod tests {
    use super::*;

    #[test]
    fn an_operation_in_flight_holds_the_exit_until_it_has_finished() {
        assert_eq!(
            exit_step(false, false, false, true, false),
            ExitStep::WaitThenExit
        );
        // A second request while waiting keeps waiting; it never spawns a second wait.
        assert_eq!(
            exit_step(false, false, false, true, true),
            ExitStep::KeepWaiting
        );
        // The exit the wait re-issues goes straight through.
        assert_eq!(exit_step(true, false, false, true, true), ExitStep::Proceed);
    }

    #[test]
    fn nothing_in_flight_releases_and_exits_as_before() {
        assert_eq!(
            exit_step(false, false, false, false, false),
            ExitStep::ReleaseAndExit
        );
    }

    #[test]
    fn only_the_users_explicit_quit_now_or_a_restart_cuts_the_operation() {
        assert_eq!(
            exit_step(false, true, false, true, false),
            ExitStep::ReleaseAndExit
        );
        assert_eq!(
            exit_step(false, false, true, true, false),
            ExitStep::ReleaseAndExit
        );
    }

    #[test]
    fn a_forced_quit_arm_expires() {
        let wait = ExitWait::default();
        assert!(!wait.forced());
        *wait.forced_until.lock().expect("lock") = Some(Instant::now() + FORCED_EXIT_TTL);
        assert!(wait.forced());
        *wait.forced_until.lock().expect("lock") = Some(Instant::now() - Duration::from_millis(1));
        assert!(!wait.forced());
    }
}
