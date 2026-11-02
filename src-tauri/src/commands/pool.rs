//! [#576 C2] Where a command body runs: on Tauri's blocking thread pool, never on
//! the main thread.
//!
//! Tauri runs a plain (non-`async`) `#[tauri::command]` inline in its IPC handler,
//! and that handler runs on the main thread (tauri-macros `body_blocking`): the
//! window cannot repaint, scroll or deliver an event until the command returns,
//! and a second IPC call - `cancel_loading` among them - is only dispatched after
//! it. A command therefore hands its body to [`run`], which moves it onto the
//! blocking pool and awaits it, so the main thread only parses
//! the arguments and spawns.
//!
//! The commands are generic over the [`Runtime`] so the tests call the registered
//! command itself with a `tauri::test` app (`MockRuntime`), not a hand-written
//! twin of its body (#576 C9).
//!
//! A panic in a body becomes the command's failure ([`PanicReply`]) instead of
//! unwinding through the IPC handler.

use tauri::{AppHandle, Manager, Runtime};

use crate::core::{AppState, CommandResult};

/// How a command's answer says its body panicked on the pool.
pub(crate) trait PanicReply {
    fn panicked(message: String) -> Self;
}

impl PanicReply for CommandResult {
    fn panicked(message: String) -> Self {
        CommandResult::failure(message)
    }
}

impl<T> PanicReply for Result<T, String> {
    fn panicked(message: String) -> Self {
        Err(message)
    }
}

/// Run `f` against the app's [`AppState`] on the blocking pool.
pub(crate) async fn run<R, T>(
    app: AppHandle<R>,
    f: impl FnOnce(&AppState) -> T + Send + 'static,
) -> T
where
    R: Runtime,
    T: PanicReply + Send + 'static,
{
    match spawn(move || f(app.state::<AppState>().inner())).await {
        Ok(answer) => answer,
        Err(crash) => T::panicked(crash_message(&crash)),
    }
}

/// Spawn `f` on the blocking pool.
///
/// Test builds hand the calling thread's config-file resolution to the worker:
/// tests isolate the config per thread (`test_helpers::with_isolated_config`), and
/// a body that reads or writes the config must see the test's file, not a fresh
/// one of the pool thread's own.
fn spawn<T: Send + 'static>(
    f: impl FnOnce() -> T + Send + 'static,
) -> tauri::async_runtime::JoinHandle<T> {
    #[cfg(test)]
    let config = crate::test_helpers::ConfigHandoff::capture();
    tauri::async_runtime::spawn_blocking(move || {
        #[cfg(test)]
        let _config = config.adopt();
        f()
    })
}

fn crash_message(crash: &tauri::Error) -> String {
    tracing::error!(
        reason = %crash,
        purpose = "report a command that failed on the blocking pool",
        "Command body did not complete"
    );
    format!("The operation failed unexpectedly ({crash})")
}
