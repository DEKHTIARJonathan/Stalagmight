//! Panic observability: route panics through tracing (ring buffer + JSON log
//! file + stderr) and write a structured crash-marker file that a crash oracle
//! (the agent harness) can detect, then delegate to the previously installed
//! hook so stderr printing and unwind/abort behaviour are unchanged.

use std::path::Path;

/// Install the panic hook. Call once from `run()`, immediately after
/// `logging::init()` so the tracing subscriber is live. Chains to the
/// previously installed hook.
///
/// The crash marker is the durable signal: the JSON file layer is non-blocking
/// and can lose its last lines on abort, whereas the marker's `fs::write` and
/// the ring-buffer layer are synchronous.
pub fn install() {
    let marker_dir = super::log_directory().ok();
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let message = payload_str(info);
        let location = info.location().map_or_else(
            || "unknown".to_string(),
            |l| format!("{}:{}:{}", l.file(), l.line(), l.column()),
        );
        let thread = std::thread::current()
            .name()
            .unwrap_or("unnamed")
            .to_string();
        // force_capture ignores RUST_BACKTRACE so the marker always carries a trace.
        let backtrace = std::backtrace::Backtrace::force_capture().to_string();

        // Write the durable marker FIRST, before any blocking log write. The
        // stderr tracing layer below is synchronous, so if the harness stalls
        // draining the child's stderr pipe, `tracing::error!` could block; doing
        // the marker's synchronous `fs::write` first guarantees the crash signal
        // lands regardless.
        if let Some(dir) = marker_dir.as_deref() {
            write_crash_marker(dir, &message, &location, &thread, &backtrace);
        }

        tracing::error!(
            panic_message = %message,
            panic_location = %location,
            panic_thread = %thread,
            "PANIC: backend thread panicked"
        );

        previous(info);
    }));
}

/// Extract the panic payload as a string, handling the common `&str` / `String`
/// payload types and falling back for anything else.
fn payload_str(info: &std::panic::PanicHookInfo<'_>) -> String {
    if let Some(s) = info.payload().downcast_ref::<&str>() {
        (*s).to_string()
    } else if let Some(s) = info.payload().downcast_ref::<String>() {
        s.clone()
    } else {
        "non-string panic payload".to_string()
    }
}

/// Best-effort, synchronous, non-panicking crash-marker writer. Separate fn so
/// it is unit-testable with a temp dir without installing the global hook.
fn write_crash_marker(dir: &Path, message: &str, location: &str, thread: &str, backtrace: &str) {
    let now = chrono::Utc::now();
    let marker = serde_json::json!({
        "ts": now.to_rfc3339(),
        "pid": std::process::id(),
        "message": message,
        "location": location,
        "thread": thread,
        "backtrace": backtrace,
    });
    let path = dir.join(format!(
        "crash-{}-{}.json",
        std::process::id(),
        now.timestamp_millis()
    ));
    let _ = std::fs::create_dir_all(dir);
    if let Ok(bytes) = serde_json::to_vec_pretty(&marker) {
        let _ = std::fs::write(path, bytes);
    }
}

#[cfg(test)]
#[expect(clippy::expect_used)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn write_crash_marker_creates_readable_json() {
        let dir = TempDir::new().expect("temp dir");
        write_crash_marker(dir.path(), "boom", "file.rs:1:2", "worker", "bt-here");

        let entries: Vec<_> = std::fs::read_dir(dir.path())
            .expect("read dir")
            .filter_map(Result::ok)
            .collect();
        assert_eq!(entries.len(), 1, "exactly one crash marker written");

        let name = entries[0].file_name();
        let name = name.to_string_lossy();
        assert!(name.starts_with("crash-"), "marker name: {name}");
        assert!(name.ends_with(".json"), "marker name: {name}");

        let content = std::fs::read_to_string(entries[0].path()).expect("read marker");
        let parsed: serde_json::Value = serde_json::from_str(&content).expect("parse json");
        assert_eq!(parsed["message"], "boom");
        assert_eq!(parsed["location"], "file.rs:1:2");
        assert_eq!(parsed["thread"], "worker");
        assert_eq!(parsed["backtrace"], "bt-here");
        assert!(parsed["ts"].is_string());
        assert!(parsed["pid"].is_number());
    }
}
