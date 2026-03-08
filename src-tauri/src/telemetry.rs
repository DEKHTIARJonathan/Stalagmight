//! Anonymous telemetry for tool usage counting.
//!
//! Always compiled, but the real implementation is behind the `telemetry` Cargo
//! feature flag. When disabled, all public methods are empty no-ops that the
//! compiler eliminates entirely — zero runtime cost.
//!
//! Design:
//! - Session-level anonymous counters only — no PII
//! - Opt-in via config (`general.telemetry_enabled`)
//! - Buffers to disk when offline, retries on next flush
//! - Periodic flush every 5 minutes + flush on app close

use std::collections::HashMap;

// ── Feature-gated imports ────────────────────────────────────────────

#[cfg(feature = "telemetry")]
use std::fs;
#[cfg(feature = "telemetry")]
use std::io::Read;
#[cfg(feature = "telemetry")]
use std::path::PathBuf;
#[cfg(feature = "telemetry")]
use std::sync::{Arc, Mutex};
#[cfg(feature = "telemetry")]
use std::time::Instant;

#[cfg(feature = "telemetry")]
use serde::{Deserialize, Serialize};

// ── Constants (feature-gated) ────────────────────────────────────────

#[cfg(feature = "telemetry")]
const PAYLOAD_VERSION: u32 = 1;

#[cfg(feature = "telemetry")]
const ENDPOINT_URL: &str = "https://telemetry.stalagmight.com/v1/events";

#[cfg(feature = "telemetry")]
const HTTP_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(5);

// ── Payload type ─────────────────────────────────────────────────────

#[cfg(feature = "telemetry")]
#[derive(Debug, Serialize, Deserialize)]
struct TelemetryPayload {
    v: u32,
    app_version: String,
    os: String,
    session_id: String,
    duration_secs: u64,
    project_seq: u32,
    events: HashMap<String, u64>,
}

// ── Inner state ──────────────────────────────────────────────────────

#[cfg(feature = "telemetry")]
#[derive(Debug)]
struct TelemetryInner {
    /// Events bucketed by project_seq (0 = global/Rust-originated).
    events: HashMap<u32, HashMap<String, u64>>,
    session_id: String,
    session_start: Instant,
    enabled: bool,
}

// ══════════════════════════════════════════════════════════════════════
// TelemetryCollector — real implementation (feature = "telemetry")
// ══════════════════════════════════════════════════════════════════════

#[cfg(feature = "telemetry")]
#[derive(Debug, Clone)]
pub struct TelemetryCollector {
    inner: Arc<Mutex<TelemetryInner>>,
}

#[cfg(feature = "telemetry")]
impl TelemetryCollector {
    /// Create a new collector. If `enabled` is false, all tracking is a no-op.
    pub fn new(enabled: bool) -> Self {
        Self {
            inner: Arc::new(Mutex::new(TelemetryInner {
                events: HashMap::new(),
                session_id: generate_session_id(),
                session_start: Instant::now(),
                enabled,
            })),
        }
    }

    /// Track a single event by name (Rust-originated, always project_seq 0).
    pub fn track(&self, event: &str) {
        if let Ok(mut inner) = self.inner.lock() {
            if !inner.enabled {
                return;
            }
            *inner.events.entry(0).or_default().entry(event.to_string()).or_insert(0) += 1;
        }
    }

    /// Track multiple events at once (batch from frontend), bucketed by project_seq.
    pub fn track_batch(&self, events: &HashMap<String, u64>, project_seq: u32) {
        if let Ok(mut inner) = self.inner.lock() {
            if !inner.enabled {
                return;
            }
            let bucket = inner.events.entry(project_seq).or_default();
            for (name, count) in events {
                *bucket.entry(name.clone()).or_insert(0) += count;
            }
        }
    }

    /// Set whether telemetry is enabled (user toggled in settings).
    pub fn set_enabled(&self, enabled: bool) {
        if let Ok(mut inner) = self.inner.lock() {
            inner.enabled = enabled;
        }
    }

    /// Check if telemetry is currently enabled.
    pub fn is_enabled(&self) -> bool {
        self.inner.lock().map_or(false, |inner| inner.enabled)
    }

    /// Flush current events to the telemetry backend.
    ///
    /// Sends one payload per project_seq bucket. On network failure, buffers
    /// each payload individually to disk for later retry.
    pub fn flush(&self) {
        let payloads = {
            let Ok(mut inner) = self.inner.lock() else {
                return;
            };
            if !inner.enabled || inner.events.is_empty() {
                return;
            }
            let app_version = env!("CARGO_PKG_VERSION").to_string();
            let os = std::env::consts::OS.to_string();
            let session_id = inner.session_id.clone();
            let duration_secs = inner.session_start.elapsed().as_secs();

            let payloads: Vec<TelemetryPayload> = inner
                .events
                .drain()
                .map(|(project_seq, events)| TelemetryPayload {
                    v: PAYLOAD_VERSION,
                    app_version: app_version.clone(),
                    os: os.clone(),
                    session_id: session_id.clone(),
                    duration_secs,
                    project_seq,
                    events,
                })
                .collect();
            payloads
        };

        for payload in &payloads {
            if let Err(e) = send_payload(payload) {
                tracing::debug!(error = %e, "Telemetry flush failed, buffering to disk");
                buffer_to_disk(payload);
            }
        }
    }

    /// Send any payloads buffered from previous failed flushes.
    pub fn send_buffered(&self) {
        let enabled = self.inner.lock().map_or(false, |inner| inner.enabled);
        if !enabled {
            return;
        }

        let Some(buffer_dir) = telemetry_buffer_dir() else {
            return;
        };

        let entries = match fs::read_dir(&buffer_dir) {
            Ok(entries) => entries,
            Err(_) => return,
        };

        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) != Some("json") {
                continue;
            }

            let content = match fs::read_to_string(&path) {
                Ok(c) => c,
                Err(_) => continue,
            };

            let payload: TelemetryPayload = match serde_json::from_str(&content) {
                Ok(p) => p,
                Err(_) => {
                    // Corrupt file — remove it
                    let _ = fs::remove_file(&path);
                    continue;
                }
            };

            if send_payload(&payload).is_ok() {
                let _ = fs::remove_file(&path);
            }
        }
    }
}

// ══════════════════════════════════════════════════════════════════════
// TelemetryCollector — no-op stub (feature != "telemetry")
// ══════════════════════════════════════════════════════════════════════

#[cfg(not(feature = "telemetry"))]
#[derive(Debug, Clone)]
pub struct TelemetryCollector;

#[cfg(not(feature = "telemetry"))]
impl TelemetryCollector {
    pub fn new(_enabled: bool) -> Self {
        Self
    }
    pub fn track(&self, _event: &str) {}
    pub fn track_batch(&self, _events: &HashMap<String, u64>, _project_seq: u32) {}
    pub fn set_enabled(&self, _enabled: bool) {}
    pub fn is_enabled(&self) -> bool {
        false
    }
    pub fn flush(&self) {}
    pub fn send_buffered(&self) {}
}

// ── Helper functions (feature-gated) ─────────────────────────────────

#[cfg(feature = "telemetry")]
fn send_payload(payload: &TelemetryPayload) -> Result<(), String> {
    let body = serde_json::to_vec(payload).map_err(|e| e.to_string())?;

    let agent = ureq::Agent::config_builder()
        .timeout_global(Some(HTTP_TIMEOUT))
        .build()
        .new_agent();

    let response = agent
        .post(ENDPOINT_URL)
        .content_type("application/json")
        .send(&body[..]);

    match response {
        Ok(_) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

#[cfg(feature = "telemetry")]
fn buffer_to_disk(payload: &TelemetryPayload) {
    let Some(dir) = telemetry_buffer_dir() else {
        return;
    };
    let _ = fs::create_dir_all(&dir);

    let filename = format!(
        "{}.json",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |d| d.as_millis())
    );
    let path = dir.join(filename);

    if let Ok(json) = serde_json::to_string(payload) {
        let _ = fs::write(path, json);
    }
}

#[cfg(feature = "telemetry")]
fn telemetry_buffer_dir() -> Option<PathBuf> {
    directories::ProjectDirs::from("com", "stalagmight", "Stalagmight")
        .map(|dirs| dirs.data_local_dir().join("telemetry-buffer"))
}

#[cfg(feature = "telemetry")]
fn generate_session_id() -> String {
    let mut bytes = [0u8; 16];

    if let Ok(mut f) = fs::File::open("/dev/urandom") {
        if f.read_exact(&mut bytes).is_ok() {
            return format_session_id(&bytes);
        }
    }

    // Fallback: use hash of current time + thread id for entropy
    use std::hash::{Hash, Hasher};
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    std::time::SystemTime::now().hash(&mut hasher);
    std::thread::current().id().hash(&mut hasher);
    let h1 = hasher.finish();
    bytes[..8].copy_from_slice(&h1.to_le_bytes());

    h1.hash(&mut hasher);
    let h2 = hasher.finish();
    bytes[8..].copy_from_slice(&h2.to_le_bytes());

    format_session_id(&bytes)
}

#[cfg(feature = "telemetry")]
fn format_session_id(bytes: &[u8; 16]) -> String {
    format!(
        "{:02x}{:02x}{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}{:02x}{:02x}{:02x}{:02x}",
        bytes[0], bytes[1], bytes[2], bytes[3],
        bytes[4], bytes[5],
        bytes[6], bytes[7],
        bytes[8], bytes[9],
        bytes[10], bytes[11], bytes[12], bytes[13], bytes[14], bytes[15]
    )
}

/// Start a background thread that periodically flushes telemetry.
pub fn start_periodic_flush(collector: TelemetryCollector) {
    #[cfg(feature = "telemetry")]
    {
        std::thread::Builder::new()
            .name("telemetry-flush".to_string())
            .spawn(move || {
                loop {
                    std::thread::sleep(std::time::Duration::from_secs(300));
                    collector.flush();
                }
            })
            .ok();
    }
    #[cfg(not(feature = "telemetry"))]
    {
        let _ = collector;
    }
}

/// Returns true when the telemetry feature is compiled in.
pub fn is_feature_enabled() -> bool {
    cfg!(feature = "telemetry")
}

// ── Tests (only with feature enabled) ────────────────────────────────

#[cfg(all(test, feature = "telemetry"))]
#[expect(clippy::unwrap_used)]
mod tests {
    use super::*;

    #[test]
    fn track_increments_counter() {
        let collector = TelemetryCollector::new(true);
        collector.track("command.create_project");
        collector.track("command.create_project");
        collector.track("command.save_project");

        let inner = collector.inner.lock().unwrap();
        let bucket = inner.events.get(&0).expect("project_seq 0 bucket");
        assert_eq!(bucket.get("command.create_project"), Some(&2));
        assert_eq!(bucket.get("command.save_project"), Some(&1));
    }

    #[test]
    fn track_disabled_is_noop() {
        let collector = TelemetryCollector::new(false);
        collector.track("command.create_project");

        let inner = collector.inner.lock().unwrap();
        assert!(inner.events.is_empty());
    }

    #[test]
    fn track_batch_merges_counts() {
        let collector = TelemetryCollector::new(true);
        // track() goes into project_seq 0
        collector.track("command.save_project");

        // Batch into project_seq 0 to merge with single-event track
        let mut batch = HashMap::new();
        batch.insert("command.save_project".to_string(), 3);
        batch.insert("command.undo".to_string(), 5);
        collector.track_batch(&batch, 0);

        let inner = collector.inner.lock().unwrap();
        let bucket = inner.events.get(&0).expect("project_seq 0 bucket");
        assert_eq!(bucket.get("command.save_project"), Some(&4));
        assert_eq!(bucket.get("command.undo"), Some(&5));
    }

    #[test]
    fn track_batch_separates_project_seqs() {
        let collector = TelemetryCollector::new(true);

        let mut batch1 = HashMap::new();
        batch1.insert("command.create_shot".to_string(), 2);
        collector.track_batch(&batch1, 1);

        let mut batch2 = HashMap::new();
        batch2.insert("command.create_shot".to_string(), 3);
        collector.track_batch(&batch2, 2);

        let inner = collector.inner.lock().unwrap();
        assert_eq!(
            inner.events.get(&1).and_then(|b| b.get("command.create_shot")),
            Some(&2)
        );
        assert_eq!(
            inner.events.get(&2).and_then(|b| b.get("command.create_shot")),
            Some(&3)
        );
    }

    #[test]
    fn set_enabled_toggles_tracking() {
        let collector = TelemetryCollector::new(false);
        collector.track("event.a");
        assert!(collector.inner.lock().unwrap().events.is_empty());

        collector.set_enabled(true);
        collector.track("event.a");
        let inner = collector.inner.lock().unwrap();
        let bucket = inner.events.get(&0).expect("project_seq 0 bucket");
        assert_eq!(bucket.get("event.a"), Some(&1));
    }

    #[test]
    fn session_id_format() {
        let id = generate_session_id();
        assert_eq!(id.len(), 36);
        assert_eq!(id.chars().nth(8), Some('-'));
        assert_eq!(id.chars().nth(13), Some('-'));
        assert_eq!(id.chars().nth(18), Some('-'));
        assert_eq!(id.chars().nth(23), Some('-'));
    }

    #[test]
    fn flush_clears_events_even_on_network_failure() {
        let collector = TelemetryCollector::new(true);
        collector.track("event.test");

        // Flush will fail (no real server) but should still clear events
        collector.flush();

        let inner = collector.inner.lock().unwrap();
        assert!(inner.events.is_empty());
    }

    #[test]
    fn buffer_to_disk_and_cleanup() {
        let payload = TelemetryPayload {
            v: 1,
            app_version: "0.1.0".to_string(),
            os: "test".to_string(),
            session_id: "test-session".to_string(),
            duration_secs: 60,
            project_seq: 0,
            events: HashMap::new(),
        };

        buffer_to_disk(&payload);

        let dir = telemetry_buffer_dir().unwrap();
        let files: Vec<_> = fs::read_dir(&dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| e.path().extension().and_then(|x| x.to_str()) == Some("json"))
            .collect();

        assert!(!files.is_empty());

        // Clean up
        for f in files {
            let _ = fs::remove_file(f.path());
        }
    }
}
