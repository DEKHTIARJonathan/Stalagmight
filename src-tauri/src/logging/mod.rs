use anyhow::Result;
use std::path::PathBuf;
use tracing_appender::non_blocking::WorkerGuard;
use tracing_subscriber::{fmt, layer::SubscriberExt, util::SubscriberInitExt, EnvFilter};

/// Initialize the logging system
/// Returns a guard that must be kept alive for the duration of the application
pub fn init() -> WorkerGuard {
    let log_dir = log_directory().unwrap_or_else(|_| PathBuf::from("."));

    // Create log directory if it doesn't exist
    let _ = std::fs::create_dir_all(&log_dir);

    // Create a rolling file appender
    let file_appender = tracing_appender::rolling::daily(&log_dir, "cavechef.log");
    let (non_blocking, guard) = tracing_appender::non_blocking(file_appender);

    // Build the subscriber
    let filter = EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| EnvFilter::new("info,cavechef=debug"));

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
        .init();

    tracing::info!("Logging initialized");
    tracing::debug!(log_dir = ?log_dir, "Log directory");

    guard
}

/// Get the log directory path
pub fn log_directory() -> Result<PathBuf> {
    let dirs = directories::ProjectDirs::from("com", "cavechef", "CaveChef")
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
