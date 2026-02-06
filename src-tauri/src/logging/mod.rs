use anyhow::Result;
use std::collections::VecDeque;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, OnceLock};
use tracing_appender::non_blocking::WorkerGuard;
use tracing_subscriber::{fmt, layer::SubscriberExt, util::SubscriberInitExt, EnvFilter};

/// Maximum number of log entries kept in the ring buffer.
const RING_BUFFER_CAPACITY: usize = 500;

/// Global ring buffer for recent log entries, readable by the `get_recent_logs` command.
static LOG_BUFFER: OnceLock<Arc<Mutex<VecDeque<String>>>> = OnceLock::new();

/// A tracing `Layer` that captures formatted log lines into a shared ring buffer.
struct RingBufferLayer {
    buffer: Arc<Mutex<VecDeque<String>>>,
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
                let s = format!("{:?}", value);
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
                write!(&mut line, "{}={}", key, val).ok();
            }
            line.push('}');
        }

        if let Ok(mut buf) = self.buffer.lock() {
            if buf.len() >= RING_BUFFER_CAPACITY {
                buf.pop_front();
            }
            buf.push_back(line);
        }
    }
}

/// Initialize the logging system
/// Returns a guard that must be kept alive for the duration of the application
pub fn init() -> WorkerGuard {
    let log_dir = log_directory().unwrap_or_else(|_| PathBuf::from("."));

    // Create log directory if it doesn't exist
    let _ = std::fs::create_dir_all(&log_dir);

    // Create a rolling file appender
    let file_appender = tracing_appender::rolling::daily(&log_dir, "stalagmight.log");
    let (non_blocking, guard) = tracing_appender::non_blocking(file_appender);

    // Create the in-memory ring buffer
    let buffer = Arc::new(Mutex::new(VecDeque::with_capacity(RING_BUFFER_CAPACITY)));
    LOG_BUFFER.set(Arc::clone(&buffer)).ok();
    let ring_layer = RingBufferLayer { buffer };

    // Build the subscriber
    let filter = EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| EnvFilter::new("info,stalagmight=debug"));

    tracing_subscriber::registry()
        .with(filter)
        .with(
            fmt::layer()
                .with_writer(non_blocking)
                .with_ansi(false)
                .json(),
        )
        .with(
            fmt::layer()
                .with_writer(std::io::stderr)
                .with_ansi(true)
                .pretty(),
        )
        .with(ring_layer)
        .init();

    tracing::info!("Logging initialized");
    tracing::debug!(log_dir = ?log_dir, "Log directory");

    guard
}

/// Return recent log entries from the in-memory ring buffer.
pub fn get_recent_logs() -> Vec<String> {
    LOG_BUFFER
        .get()
        .and_then(|buf| buf.lock().ok())
        .map(|buf| buf.iter().cloned().collect())
        .unwrap_or_default()
}

/// Push a pre-formatted log line into the ring buffer (used for frontend console logs).
pub fn push_to_buffer(line: String) {
    if let Some(buf) = LOG_BUFFER.get() {
        if let Ok(mut buf) = buf.lock() {
            if buf.len() >= RING_BUFFER_CAPACITY {
                buf.pop_front();
            }
            buf.push_back(line);
        }
    }
}

/// Get the log directory path
pub fn log_directory() -> Result<PathBuf> {
    let dirs = directories::ProjectDirs::from("com", "stalagmight", "Stalagmight")
        .ok_or_else(|| anyhow::anyhow!("No home directory"))?;
    Ok(dirs.data_local_dir().join("logs"))
}

/// Clean up old log files if directory size exceeds max
pub fn cleanup_logs(max_size_mb: u32) -> Result<()> {
    let log_dir = log_directory()?;
    if !log_dir.exists() {
        return Ok(());
    }

    let max_size_bytes = (max_size_mb as u64) * 1024 * 1024;
    let mut entries: Vec<_> = std::fs::read_dir(&log_dir)?
        .filter_map(|e| e.ok())
        .filter(|e| e.path().extension().map(|ext| ext == "log").unwrap_or(false))
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
    use std::env;
    use std::sync::Mutex;
    use tempfile::TempDir;

    static ENV_LOCK: Mutex<()> = Mutex::new(());

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
    fn log_directory_uses_xdg_data_home() {
        with_temp_data_home(|temp| {
            let log_dir = log_directory().expect("log dir");
            assert!(log_dir.starts_with(temp.path()));
            assert_eq!(log_dir.file_name().and_then(|s| s.to_str()), Some("logs"));
        });
    }

    #[test]
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
}
