//! Quitting never cuts an in-flight SpeleoDB operation (lock#6, frontend#4).
//!
//! Every lock, upload, publish and release holds the lock-ops span
//! (`speleodb_lock_ops`) for its whole network round trip. The exit-time release
//! used to queue behind that span with a 5-second deadline and then let the
//! process exit anyway, killing the upload mid-transfer: its outcome unknown, the
//! lock still held, and SpeleoDB has no lock timeout.
//!
//! These are the two questions the app's exit hook (`exit_wait` in the app crate)
//! asks instead: is such an operation running, and - off the main thread - wait
//! until it has finished. Only then does the bounded release run. The frontend
//! waits first, with visible progress, before it lets the window go; this is the
//! backstop for anything that reaches the exit without the window (and for
//! backend-internal operations the frontend cannot see).

use super::AppState;

impl AppState {
    /// A SpeleoDB lock, upload, publish or release operation is in flight right
    /// now (something holds the lock-ops span). A poisoned span is treated as
    /// free: its value is `()`, so only the serialization ever mattered.
    pub fn speleodb_operation_in_flight(&self) -> bool {
        matches!(
            self.speleodb_lock_ops.try_lock(),
            Err(std::sync::TryLockError::WouldBlock)
        )
    }

    /// Block until the operation in flight (if any) has left the lock-ops span.
    /// Bounded only by that operation's own network timeouts, so never call this
    /// on the main thread.
    pub fn speleodb_wait_for_in_flight_operation(&self) {
        drop(self.speleodb_lock_ops_guard());
    }
}

#[cfg(test)]
#[expect(
    clippy::expect_used,
    reason = "test module: panics on a failed assumption are the point"
)]
mod tests {
    use std::sync::mpsc;
    use std::time::Duration;

    use super::AppState;
    use crate::test_helpers::with_isolated_config;

    #[test]
    fn an_operation_holding_the_span_is_in_flight_until_it_ends() {
        with_isolated_config(|| {
            let state = AppState::new().expect("state");
            assert!(!state.speleodb_operation_in_flight());
            let upload = state.speleodb_lock_ops_guard();
            assert!(state.speleodb_operation_in_flight());
            drop(upload);
            assert!(!state.speleodb_operation_in_flight());
        });
    }

    #[test]
    fn the_exit_wait_returns_only_once_the_operation_has_finished() {
        with_isolated_config(|| {
            let state = AppState::new().expect("state");
            let upload = state.speleodb_lock_ops_guard();
            let (done, finished) = mpsc::channel();
            std::thread::scope(|scope| {
                scope.spawn(|| {
                    state.speleodb_wait_for_in_flight_operation();
                    done.send(()).expect("report");
                });
                // Still uploading: the wait must not give up on a deadline.
                assert!(finished.recv_timeout(Duration::from_millis(300)).is_err());
                drop(upload);
                finished
                    .recv_timeout(Duration::from_secs(5))
                    .expect("the wait ends with the operation");
            });
            assert!(!state.speleodb_operation_in_flight());
        });
    }
}
