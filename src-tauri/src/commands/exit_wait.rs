//! The app's exit never cuts a user-visible SpeleoDB transfer (lock#6, frontend#4).
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
//!    X, an OS close, the update restart. While a transfer is in flight it keeps
//!    the window, toasts that the app will close when the work finishes, shows
//!    progress, and quits once it is done. "Quit now" is an explicit in-app
//!    choice behind a warning; it arms [`arm_forced_exit`].
//! 2. This hook is the backstop for a transfer that is still running when the
//!    exit arrives anyway (the window destroyed without the listener): with one
//!    in flight and no forced quit armed, it PREVENTS the exit, waits for it off
//!    the main thread, runs the bounded release, and then exits.
//!
//! Only the transfers the frontend gate itself waits on hold the exit: the IPC
//! commands that upload, acquire, download, release or change the account, and
//! the exit / sign-out actions (`close_project`, the cached-copy discard). Each
//! registers with [`user_transfer`] for its whole run. Backend-internal work the
//! user never sees (the background lock re-verify, the stranded-claim cleanup, a
//! detached release from a project switch) never keeps a windowless process
//! alive: the exit keeps the old bounded behaviour for it - the release waits at
//! most [`crate::EXIT_LOCK_RELEASE_TIMEOUT`] behind it, then the app exits.
//!
//! The update restart (`app.restart()`) cannot be prevented by Tauri; it only
//! ever runs after the frontend gate has let the quit through.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

use tauri::{AppHandle, Manager, State};

use crate::core::AppState;

/// How long an armed forced quit stays valid. It covers one hop - the frontend
/// arms it right before it destroys the window - so a stale arm can never let a
/// later, ordinary quit cut a transfer.
const FORCED_EXIT_TTL: Duration = Duration::from_secs(10);

/// The user-visible transfers running right now.
#[derive(Default)]
struct Transfers {
    count: Mutex<usize>,
    idle: Condvar,
}

impl Transfers {
    fn count(&self) -> std::sync::MutexGuard<'_, usize> {
        self.count
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }
}

/// One user-visible transfer, registered for as long as this lives.
#[must_use = "the transfer holds the exit only while this guard lives"]
pub struct UserTransfer(Arc<Transfers>);

impl Drop for UserTransfer {
    fn drop(&mut self) {
        let mut count = self.0.count();
        *count = count.saturating_sub(1);
        if *count == 0 {
            self.0.idle.notify_all();
        }
    }
}

/// Managed exit state.
#[derive(Default)]
pub struct ExitWait {
    /// Until when the user's explicit "Quit now" may cut an in-flight transfer.
    forced_until: Mutex<Option<Instant>>,
    /// A background wait is already running for this exit.
    waiting: AtomicBool,
    /// The background wait finished and released: the exit it re-issues goes on.
    drained: AtomicBool,
    transfers: Arc<Transfers>,
}

impl ExitWait {
    fn phase(&self) -> WaitPhase {
        if self.drained.load(Ordering::SeqCst) {
            WaitPhase::Drained
        } else if self.waiting.load(Ordering::SeqCst) {
            WaitPhase::Waiting
        } else {
            WaitPhase::Idle
        }
    }

    fn forced(&self) -> bool {
        self.forced_until
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .is_some_and(|until| Instant::now() < until)
    }

    /// Register a user-visible transfer (see [`user_transfer`]).
    pub fn begin_transfer(&self) -> UserTransfer {
        *self.transfers.count() += 1;
        UserTransfer(Arc::clone(&self.transfers))
    }

    fn transfers_in_flight(&self) -> bool {
        *self.transfers.count() > 0
    }

    /// Block until no user-visible transfer is running. Bounded only by the
    /// transfers' own network timeouts, so never call this on the main thread.
    fn wait_for_transfers(&self) {
        let mut count = self.transfers.count();
        while *count > 0 {
            count = self
                .transfers
                .idle
                .wait(count)
                .unwrap_or_else(std::sync::PoisonError::into_inner);
        }
    }

    /// What to do with one `ExitRequested` carrying `code`.
    fn step(&self, code: Option<i32>) -> ExitStep {
        exit_step(
            self.phase(),
            self.forced() || code == Some(tauri::RESTART_EXIT_CODE),
            self.transfers_in_flight(),
        )
    }
}

/// Register a user-visible transfer for as long as the returned guard lives, so
/// the app's exit waits for it. `None` before the state is managed (nothing can
/// exit then either).
pub fn user_transfer(app: &AppHandle) -> Option<UserTransfer> {
    app.try_state::<ExitWait>()
        .map(|wait| wait.begin_transfer())
}

/// What the exit hook does with one `ExitRequested`.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum ExitStep {
    /// Our own re-issued exit after the wait: everything is already done.
    Proceed,
    /// Nothing the user started is running (or the user chose to cut it): the
    /// bounded release, then exit.
    ReleaseAndExit,
    /// Keep the process, wait for the transfer off the main thread, then exit.
    WaitThenExit,
    /// A wait for this exit is already running; keep the process.
    KeepWaiting,
}

/// Where this process's exit wait stands.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum WaitPhase {
    Idle,
    Waiting,
    /// The wait finished and released; the exit it re-issued goes on.
    Drained,
}

/// The decision, kept pure so it is testable without a running app. `may_cut`:
/// the user chose "Quit now", or this is a restart (Tauri ignores
/// `prevent_exit` for one). `in_flight`: a user-visible transfer is running.
pub(crate) fn exit_step(phase: WaitPhase, may_cut: bool, in_flight: bool) -> ExitStep {
    match phase {
        WaitPhase::Drained => ExitStep::Proceed,
        _ if may_cut || !in_flight => ExitStep::ReleaseAndExit,
        WaitPhase::Waiting => ExitStep::KeepWaiting,
        WaitPhase::Idle => ExitStep::WaitThenExit,
    }
}

/// The `RunEvent::ExitRequested` hook (see the module doc).
pub fn on_exit_requested(app: &AppHandle, code: Option<i32>, api: &tauri::ExitRequestApi) {
    let Some(state) = app.try_state::<AppState>() else {
        return;
    };
    let wait = app.state::<ExitWait>();
    match wait.step(code) {
        ExitStep::Proceed => {}
        ExitStep::ReleaseAndExit => {
            state.speleodb_release_held_lock_bounded(crate::EXIT_LOCK_RELEASE_TIMEOUT);
        }
        ExitStep::KeepWaiting => api.prevent_exit(),
        ExitStep::WaitThenExit => {
            api.prevent_exit();
            wait.waiting.store(true, Ordering::SeqCst);
            tracing::info!(
                purpose = "let an in-flight SpeleoDB transfer finish before exiting",
                "exit deferred until the SpeleoDB transfer in flight has finished"
            );
            let app = app.clone();
            std::thread::spawn(move || {
                let wait = app.state::<ExitWait>();
                wait.wait_for_transfers();
                app.state::<AppState>()
                    .speleodb_release_held_lock_bounded(crate::EXIT_LOCK_RELEASE_TIMEOUT);
                wait.drained.store(true, Ordering::SeqCst);
                app.exit(0);
            });
        }
    }
}

/// The user's explicit "Quit now" from the in-app waiting prompt: the exit that
/// follows within [`FORCED_EXIT_TTL`] may cut the transfer in flight instead of
/// waiting for it.
#[tauri::command]
pub fn arm_forced_exit(wait: State<'_, ExitWait>) {
    *wait
        .forced_until
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner) =
        Some(Instant::now() + FORCED_EXIT_TTL);
    tracing::warn!(
        purpose = "quit without waiting for an in-flight SpeleoDB transfer (user chose it)",
        "forced exit armed"
    );
}

#[cfg(test)]
#[expect(
    clippy::expect_used,
    clippy::panic,
    reason = "test module: panics on a failed assumption are the point"
)]
mod tests {
    use super::*;
    use std::sync::mpsc;

    #[test]
    fn a_user_transfer_in_flight_holds_the_exit_until_it_has_finished() {
        let wait = ExitWait::default();
        let upload = wait.begin_transfer();
        assert_eq!(wait.step(None), ExitStep::WaitThenExit);
        // A second request while waiting keeps waiting; it never spawns a second wait.
        wait.waiting.store(true, Ordering::SeqCst);
        assert_eq!(wait.step(Some(0)), ExitStep::KeepWaiting);
        // The exit the wait re-issues goes straight through.
        wait.drained.store(true, Ordering::SeqCst);
        assert_eq!(wait.step(Some(0)), ExitStep::Proceed);
        drop(upload);
    }

    #[test]
    fn backend_internal_work_never_holds_the_exit() {
        // The background re-verify, the stranded-claim cleanup and a detached
        // switch release never register a user transfer, so whatever they hold,
        // the exit keeps the old bounded release-then-exit (the release's own
        // budget is pinned in `speleodb_lock_release`'s tests).
        let wait = ExitWait::default();
        assert_eq!(wait.step(None), ExitStep::ReleaseAndExit);
        // And a finished transfer no longer counts.
        drop(wait.begin_transfer());
        assert_eq!(wait.step(None), ExitStep::ReleaseAndExit);
    }

    #[test]
    fn only_the_users_explicit_quit_now_or_a_restart_cuts_a_transfer() {
        let wait = ExitWait::default();
        let _upload = wait.begin_transfer();
        assert_eq!(
            wait.step(Some(tauri::RESTART_EXIT_CODE)),
            ExitStep::ReleaseAndExit
        );
        *wait.forced_until.lock().expect("lock") = Some(Instant::now() + FORCED_EXIT_TTL);
        assert_eq!(wait.step(None), ExitStep::ReleaseAndExit);
    }

    #[test]
    fn the_exit_wait_returns_only_once_every_transfer_has_finished() {
        let wait = ExitWait::default();
        let upload = wait.begin_transfer();
        let acquire = wait.begin_transfer();
        let (done, finished) = mpsc::channel();
        std::thread::scope(|scope| {
            scope.spawn(|| {
                wait.wait_for_transfers();
                done.send(()).expect("report");
            });
            drop(upload);
            // One still running: the wait must not give up on a deadline.
            assert!(finished.recv_timeout(Duration::from_millis(300)).is_err());
            drop(acquire);
            finished
                .recv_timeout(Duration::from_secs(5))
                .expect("the wait ends with the last transfer");
        });
        assert!(!wait.transfers_in_flight());
    }

    #[test]
    fn a_forced_quit_arm_expires() {
        let wait = ExitWait::default();
        assert!(!wait.forced());
        *wait.forced_until.lock().expect("lock") = Some(Instant::now() + FORCED_EXIT_TTL);
        assert!(wait.forced());
        *wait.forced_until.lock().expect("lock") = Some(Instant::now());
        assert!(!wait.forced());
    }

    /// The commands that register a user transfer are exactly the SpeleoDB calls
    /// the frontend gate counts as exclusive (`speleoNetworkCommands.ts`), plus the
    /// exit / sign-out actions; no read ever holds the exit.
    #[test]
    fn exactly_the_frontend_gates_transfers_hold_the_exit() {
        let table = include_str!("../../../src/utils/speleoNetworkCommands.ts");
        // The SpeleoDB commands live in these two modules: the network ones, and
        // the cached copies on this machine (which the gate counts as exclusive).
        let speleodb = concat!(
            include_str!("speleodb.rs"),
            include_str!("speleodb_cache.rs")
        );
        let project = include_str!("project.rs");
        let body = |src: &'static str, name: &str| -> &'static str {
            let start = src
                .find(&format!("pub async fn {name}("))
                .unwrap_or_else(|| panic!("command {name} is defined"));
            let rest = &src[start..];
            &rest[..rest.find("\n}\n").expect("command body ends")]
        };
        let mut checked = 0;
        for line in table.lines() {
            let line = line.trim();
            let Some((name, kind)) = line.split_once(':') else {
                continue;
            };
            if !name.starts_with("speleodb_") || name.contains(' ') {
                continue;
            }
            let command = body(speleodb, name);
            let holds =
                command.contains("run_transfer(") || command.contains("user_transfer(&app)");
            match kind.trim() {
                "'exclusive'," => assert!(holds, "{name} is exclusive: it must hold the exit"),
                "'read'," => assert!(!holds, "{name} is a read: it must never hold the exit"),
                _ => continue,
            }
            checked += 1;
        }
        assert!(
            checked > 10,
            "the frontend table was read ({checked} commands)"
        );
        for name in ["close_project", "speleodb_discard_cached_copy"] {
            assert!(
                body(project, name).contains("user_transfer(&app)"),
                "{name} is an exit / sign-out action: it must hold the exit"
            );
        }
    }
}
