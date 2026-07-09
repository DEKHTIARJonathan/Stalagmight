pub mod panic_hook;

use anyhow::Result;
use serde::Serialize;
use std::collections::VecDeque;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use tracing_appender::non_blocking::WorkerGuard;
use tracing_subscriber::{fmt, layer::SubscriberExt, util::SubscriberInitExt, EnvFilter};
use ts_rs::TS;

/// Maximum number of log entries kept in the ring buffer.
const RING_BUFFER_CAPACITY: usize = 500;

/// Monotonic sequence counter for ring-buffer entries. Lets a caller ask for
/// "everything after seq N" (`get_recent_logs_since`) so a checkpoint-based
/// consumer (the agent harness) can detect new lines without content-diffing.
static LOG_SEQ: AtomicU64 = AtomicU64::new(0);

/// One entry in the in-memory ring buffer: a formatted log line plus a
/// monotonic sequence number and a wall-clock timestamp (ms since the epoch).
#[derive(Clone, Debug, Serialize, TS)]
pub struct RingLogEntry {
    pub seq: u64,
    pub ts_ms: i64,
    pub line: String,
}

/// Result of `get_recent_logs_since`: ring entries newer than the requested
/// checkpoint, the newest sequence number now present, and whether the ring
/// rotated past the checkpoint (so some entries were lost between checks).
#[derive(Clone, Debug, Default, Serialize, TS)]
pub struct LogsSince {
    pub entries: Vec<RingLogEntry>,
    pub latest_seq: u64,
    pub dropped: bool,
}

/// Global ring buffer for recent log entries, readable by the `get_recent_logs` command.
static LOG_BUFFER: OnceLock<Arc<Mutex<VecDeque<RingLogEntry>>>> = OnceLock::new();

/// Append a formatted line to a ring buffer, minting a fresh sequence number and
/// timestamp and evicting the oldest entry when full. Shared by the tracing
/// layer and the frontend-log bridge so both paths stay consistent.
fn push_line_to(buffer: &Mutex<VecDeque<RingLogEntry>>, line: String) {
    if let Ok(mut buf) = buffer.lock() {
        let seq = LOG_SEQ.fetch_add(1, Ordering::Relaxed) + 1;
        let ts_ms = chrono::Utc::now().timestamp_millis();
        if buf.len() >= RING_BUFFER_CAPACITY {
            buf.pop_front();
        }
        buf.push_back(RingLogEntry { seq, ts_ms, line });
    }
}

/// A tracing `Layer` that captures formatted log lines into a shared ring buffer.
struct RingBufferLayer {
    buffer: Arc<Mutex<VecDeque<RingLogEntry>>>,
}

impl<S> tracing_subscriber::Layer<S> for RingBufferLayer
where
    S: tracing::Subscriber,
{
    fn on_event(
        &self,
        event: &tracing::Event<'_>,
        _ctx: tracing_subscriber::layer::Context<'_, S>,
    ) {
        use std::fmt::Write;
        use tracing::field::{Field, Visit};

        /// Collects the message and all other fields from a tracing event.
        struct FieldVisitor {
            message: String,
            fields: Vec<(String, String)>,
        }

        impl Visit for FieldVisitor {
            fn record_debug(&mut self, field: &Field, value: &dyn std::fmt::Debug) {
                let s = format!("{value:?}");
                if field.name() == "message" {
                    self.message = s;
                } else {
                    self.fields.push((field.name().to_string(), s));
                }
            }
            fn record_str(&mut self, field: &Field, value: &str) {
                if field.name() == "message" {
                    self.message = value.to_string();
                } else {
                    self.fields
                        .push((field.name().to_string(), value.to_string()));
                }
            }
            fn record_i64(&mut self, field: &Field, value: i64) {
                self.fields
                    .push((field.name().to_string(), value.to_string()));
            }
            fn record_u64(&mut self, field: &Field, value: u64) {
                self.fields
                    .push((field.name().to_string(), value.to_string()));
            }
            fn record_f64(&mut self, field: &Field, value: f64) {
                self.fields
                    .push((field.name().to_string(), value.to_string()));
            }
            fn record_bool(&mut self, field: &Field, value: bool) {
                self.fields
                    .push((field.name().to_string(), value.to_string()));
            }
        }

        let metadata = event.metadata();
        let mut visitor = FieldVisitor {
            message: String::new(),
            fields: Vec::new(),
        };
        event.record(&mut visitor);

        let mut line = format!(
            "{} {}: {}",
            metadata.level(),
            metadata.target(),
            visitor.message
        );

        // Append structured fields as key=value pairs
        if !visitor.fields.is_empty() {
            line.push_str(" {");
            for (i, (key, val)) in visitor.fields.iter().enumerate() {
                if i > 0 {
                    line.push_str(", ");
                }
                write!(&mut line, "{key}={val}").ok();
            }
            line.push('}');
        }

        push_line_to(&self.buffer, line);
    }
}

/// Initialize the logging system.
///
/// Returns a guard that must be kept alive for the duration of the application.
/// On platforms where file logging is unavailable (e.g. Android before setup),
/// only stderr and the in-memory ring buffer are used — no panic.
pub fn init() -> Option<WorkerGuard> {
    // Create the in-memory ring buffer
    let buffer = Arc::new(Mutex::new(VecDeque::with_capacity(RING_BUFFER_CAPACITY)));
    LOG_BUFFER.set(Arc::clone(&buffer)).ok();
    let ring_layer = RingBufferLayer { buffer };

    let filter = EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| EnvFilter::new("info,stalagmight=debug"));

    // Try to set up file logging; skip gracefully if the directory is
    // unavailable or read-only (common on Android before Tauri setup).
    let (file_layer, guard) = match log_directory() {
        Ok(log_dir) if std::fs::create_dir_all(&log_dir).is_ok() => {
            let file_appender = tracing_appender::rolling::daily(&log_dir, "stalagmight.log");
            let (non_blocking, guard) = tracing_appender::non_blocking(file_appender);
            let layer = fmt::layer()
                .with_writer(non_blocking)
                .with_ansi(false)
                .json();
            (Some(layer), Some(guard))
        }
        _ => (None, None),
    };

    tracing_subscriber::registry()
        .with(filter)
        .with(file_layer)
        .with(
            fmt::layer()
                .with_writer(std::io::stderr)
                .with_ansi(true)
                .pretty(),
        )
        .with(ring_layer)
        .init();

    tracing::info!("Logging initialized");

    guard
}

/// Return recent log entries from the in-memory ring buffer.
///
/// Signature preserved (bare lines) so the in-app debug dialog is unaffected;
/// checkpoint-aware consumers use `get_recent_logs_since`.
pub fn get_recent_logs() -> Vec<String> {
    LOG_BUFFER
        .get()
        .and_then(|buf| buf.lock().ok())
        .map(|buf| buf.iter().map(|e| e.line.clone()).collect())
        .unwrap_or_default()
}

/// Pure core of `get_recent_logs_since`, split out so the checkpoint/`dropped`
/// logic can be unit-tested against a hand-built buffer (the real one is a
/// process-global `OnceLock` that cannot be re-initialised in tests).
fn logs_since_from(buf: &VecDeque<RingLogEntry>, after_seq: u64) -> LogsSince {
    let latest_seq = buf.back().map_or(0, |e| e.seq);
    let oldest_seq = buf.front().map_or(0, |e| e.seq);
    // If the oldest entry we still hold is newer than after_seq + 1, the ring
    // rotated past the checkpoint and some entries were lost between checks.
    let dropped = after_seq > 0 && oldest_seq > after_seq + 1;
    let entries: Vec<RingLogEntry> = buf.iter().filter(|e| e.seq > after_seq).cloned().collect();
    LogsSince {
        entries,
        latest_seq,
        dropped,
    }
}

/// Return ring-buffer entries newer than `after_seq`, the newest sequence number
/// now present, and a `dropped` flag set when the ring rotated past the
/// checkpoint. Pass `after_seq = 0` to get everything currently buffered.
pub fn get_recent_logs_since(after_seq: u64) -> LogsSince {
    LOG_BUFFER
        .get()
        .and_then(|buf| buf.lock().ok())
        .map(|buf| logs_since_from(&buf, after_seq))
        .unwrap_or_default()
}

/// Push a pre-formatted log line into the ring buffer (used for frontend console logs).
pub fn push_to_buffer(line: String) {
    if let Some(buf) = LOG_BUFFER.get() {
        push_line_to(buf, line);
    }
}

/// Get the log directory path.
///
/// Prefers `app_dirs` (Tauri path resolver, works on Android). Falls back to
/// the `directories` crate for the pre-setup logging call on desktop where
/// `app_dirs` has not been initialised yet.
pub fn log_directory() -> Result<PathBuf> {
    if let Some(dir) = crate::app_dirs::data_local_dir() {
        return Ok(dir.join("logs"));
    }
    // Pre-setup fallback (desktop only — `directories` returns None on Android)
    let dirs = directories::ProjectDirs::from("com", "stalagmight", "Stalagmight")
        .ok_or_else(|| anyhow::anyhow!("No home directory"))?;
    Ok(dirs.data_local_dir().join("logs"))
}

/// Clean up old log files if directory size exceeds max
pub fn cleanup_logs(max_size_mb: u32) -> Result<()> {
    let log_dir = log_directory()?;
    let max_size_bytes = u64::from(max_size_mb) * 1024 * 1024;
    cleanup_logs_in_dir(&log_dir, max_size_bytes)
}

/// Clean up old `.log` files and `crash-*.json` panic markers in `log_dir` if
/// their total size exceeds `max_size_bytes`. Deletes oldest files first.
/// Crash markers are included because the panic hook writes one per backend
/// panic in ALL builds; without this sweep they accumulate unbounded in the
/// user's data dir (nothing else ever deletes them). Extracted for
/// cross-platform testability (`log_directory()` relies on platform paths).
fn cleanup_logs_in_dir(log_dir: &std::path::Path, max_size_bytes: u64) -> Result<()> {
    if !log_dir.exists() {
        return Ok(());
    }

    let is_crash_marker = |p: &std::path::Path| {
        p.extension().is_some_and(|ext| ext == "json")
            && p.file_name()
                .and_then(|n| n.to_str())
                .is_some_and(|n| n.starts_with("crash-"))
    };
    let mut entries: Vec<_> = std::fs::read_dir(log_dir)?
        .filter_map(std::result::Result::ok)
        .filter(|e| {
            let p = e.path();
            p.extension().is_some_and(|ext| ext == "log") || is_crash_marker(&p)
        })
        .collect();

    // Sort by modification time, oldest first
    entries.sort_by_key(|e| {
        e.metadata()
            .and_then(|m| m.modified())
            .unwrap_or(std::time::SystemTime::UNIX_EPOCH)
    });

    // Calculate total size and delete oldest files if over limit
    let mut total_size: u64 = entries
        .iter()
        .filter_map(|e| e.metadata().ok())
        .map(|m| m.len())
        .sum();

    for entry in entries {
        if total_size <= max_size_bytes {
            break;
        }

        if let Ok(metadata) = entry.metadata() {
            let file_size = metadata.len();
            if std::fs::remove_file(entry.path()).is_ok() {
                total_size -= file_size;
                tracing::debug!(path = ?entry.path(), "Deleted old log file");
            }
        }
    }

    Ok(())
}

#[cfg(test)]
#[expect(clippy::expect_used)]
mod tests {
    use super::*;

    use tempfile::TempDir;

    #[cfg(target_os = "linux")]
    use std::env;
    #[cfg(target_os = "linux")]
    use std::sync::Mutex;

    #[cfg(target_os = "linux")]
    static ENV_LOCK: Mutex<()> = Mutex::new(());

    #[cfg(target_os = "linux")]
    fn with_temp_data_home<T>(f: impl FnOnce(&TempDir) -> T) -> T {
        let _guard = ENV_LOCK.lock().expect("env lock");
        let dir = TempDir::new().expect("temp dir");
        let key = "XDG_DATA_HOME";
        let original = env::var_os(key);
        env::set_var(key, dir.path());
        let result = f(&dir);
        match original {
            Some(value) => env::set_var(key, value),
            None => env::remove_var(key),
        }
        result
    }

    #[test]
    #[cfg(target_os = "linux")]
    fn log_directory_uses_xdg_data_home() {
        with_temp_data_home(|temp| {
            let log_dir = log_directory().expect("log dir");
            assert!(log_dir.starts_with(temp.path()));
            assert_eq!(log_dir.file_name().and_then(|s| s.to_str()), Some("logs"));
        });
    }

    #[test]
    #[cfg(target_os = "linux")]
    fn cleanup_logs_removes_all_when_limit_zero() {
        with_temp_data_home(|_temp| {
            let log_dir = log_directory().expect("log dir");
            std::fs::create_dir_all(&log_dir).expect("create log dir");

            let first = log_dir.join("first.log");
            let second = log_dir.join("second.log");
            std::fs::write(&first, b"abc").expect("write log");
            std::fs::write(&second, b"defg").expect("write log");

            cleanup_logs(0).expect("cleanup logs");

            assert!(!first.exists());
            assert!(!second.exists());
        });
    }

    #[test]
    #[cfg(target_os = "macos")]
    fn log_directory_uses_macos_library_path() {
        let log_dir = log_directory().expect("log dir");
        let home = std::env::var("HOME").expect("HOME must be set");
        let expected_prefix = format!("{home}/Library/Application Support");
        assert!(
            log_dir.starts_with(&expected_prefix),
            "Expected log dir under {expected_prefix}, got {log_dir:?}"
        );
        assert_eq!(log_dir.file_name().and_then(|s| s.to_str()), Some("logs"));
    }

    #[test]
    fn cleanup_logs_in_dir_removes_all_when_limit_zero() {
        let dir = TempDir::new().expect("temp dir");
        let log_dir = dir.path().join("logs");
        std::fs::create_dir_all(&log_dir).expect("create log dir");

        let first = log_dir.join("first.log");
        let second = log_dir.join("second.log");
        std::fs::write(&first, b"abc").expect("write log");
        std::fs::write(&second, b"defg").expect("write log");

        cleanup_logs_in_dir(&log_dir, 0).expect("cleanup logs");

        assert!(!first.exists());
        assert!(!second.exists());
    }

    #[test]
    fn push_line_mints_monotonic_seq_and_line() {
        let buffer = Mutex::new(VecDeque::new());
        push_line_to(&buffer, "a".to_string());
        push_line_to(&buffer, "b".to_string());
        let buf = buffer.lock().expect("lock");
        assert_eq!(buf.len(), 2);
        assert!(buf[1].seq > buf[0].seq, "seq must be strictly increasing");
        assert_eq!(buf[0].line, "a");
        assert_eq!(buf[1].line, "b");
    }

    #[test]
    fn logs_since_returns_only_newer_entries() {
        let mut buf = VecDeque::new();
        for seq in 3..=6 {
            buf.push_back(RingLogEntry {
                seq,
                ts_ms: 0,
                line: format!("l{seq}"),
            });
        }
        let since = logs_since_from(&buf, 4);
        assert_eq!(
            since.entries.iter().map(|e| e.seq).collect::<Vec<_>>(),
            vec![5, 6]
        );
        assert_eq!(since.latest_seq, 6);
        assert!(!since.dropped);
    }

    #[test]
    fn logs_since_flags_dropped_when_ring_rotated_past_checkpoint() {
        // Oldest retained seq is 7, but the caller last saw seq 4, so seqs 5 and
        // 6 were evicted before this read: report the gap.
        let mut buf = VecDeque::new();
        for seq in 7..=9 {
            buf.push_back(RingLogEntry {
                seq,
                ts_ms: 0,
                line: format!("l{seq}"),
            });
        }
        let since = logs_since_from(&buf, 4);
        assert!(since.dropped);
        assert_eq!(since.latest_seq, 9);
    }

    #[test]
    fn logs_since_zero_checkpoint_never_flags_dropped() {
        let mut buf = VecDeque::new();
        buf.push_back(RingLogEntry {
            seq: 100,
            ts_ms: 0,
            line: "x".to_string(),
        });
        let since = logs_since_from(&buf, 0);
        assert!(!since.dropped);
        assert_eq!(since.entries.len(), 1);
    }

    #[test]
    fn cleanup_logs_in_dir_keeps_files_under_limit() {
        let dir = TempDir::new().expect("temp dir");
        let log_dir = dir.path().join("logs");
        std::fs::create_dir_all(&log_dir).expect("create log dir");

        // 3 bytes + 4 bytes = 7 bytes total
        std::fs::write(log_dir.join("first.log"), b"abc").expect("write log");
        std::fs::write(log_dir.join("second.log"), b"defg").expect("write log");

        // Limit of 10 bytes — both files fit
        cleanup_logs_in_dir(&log_dir, 10).expect("cleanup logs");

        assert!(log_dir.join("first.log").exists());
        assert!(log_dir.join("second.log").exists());
    }

    #[test]
    fn cleanup_logs_in_dir_sweeps_crash_markers_but_not_other_json() {
        let dir = TempDir::new().expect("temp dir");
        let log_dir = dir.path().join("logs");
        std::fs::create_dir_all(&log_dir).expect("create log dir");

        // The panic hook writes crash-<pid>-<ts>.json beside the logs in ALL
        // builds; the sweep must bound them (they used to accumulate forever).
        // An unrelated .json in the same dir must be left alone.
        let marker = log_dir.join("crash-1234-1751970000000.json");
        let other = log_dir.join("settings-backup.json");
        std::fs::write(&marker, b"{\"message\":\"panic\"}").expect("write marker");
        std::fs::write(&other, b"{}").expect("write other");

        cleanup_logs_in_dir(&log_dir, 0).expect("cleanup logs");

        assert!(!marker.exists(), "crash marker must be swept");
        assert!(other.exists(), "unrelated json must be untouched");
    }

    #[test]
    fn ring_buffer_evicts_oldest_at_capacity() {
        // Push past capacity: the ring must stay bounded and retain the NEWEST
        // entries with seq order intact (the eviction path was untested).
        let buffer = Mutex::new(VecDeque::new());
        let total = RING_BUFFER_CAPACITY + 25;
        for i in 0..total {
            push_line_to(&buffer, format!("line-{i}"));
        }
        let buf = buffer.lock().expect("lock");
        assert_eq!(buf.len(), RING_BUFFER_CAPACITY, "ring must be bounded");
        assert_eq!(
            buf.back().expect("newest").line,
            format!("line-{}", total - 1),
            "newest entry retained"
        );
        assert_eq!(
            buf.front().expect("oldest").line,
            format!("line-{}", total - RING_BUFFER_CAPACITY),
            "oldest entries evicted in order"
        );
        assert!(
            buf.back().expect("newest").seq - buf.front().expect("oldest").seq
                == (RING_BUFFER_CAPACITY as u64) - 1,
            "seq stays dense across eviction"
        );
    }
}
