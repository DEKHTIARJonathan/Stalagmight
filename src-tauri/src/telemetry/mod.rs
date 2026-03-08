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
//! - Periodic flush every 60s (dwell-only batches every 10 min) + flush on app close
//! - On network failure, retries every 60s until success

use std::collections::HashMap;

#[cfg(feature = "telemetry")]
mod registry;

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
const ENDPOINT_URL: &str = env!("TELEMETRY_ENDPOINT");

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

// ── Packed payload (v2 msgpack wire format) ─────────────────────────

#[cfg(feature = "telemetry")]
const PACKED_PAYLOAD_VERSION: u32 = 2;

#[cfg(feature = "telemetry")]
#[derive(Debug, Serialize)]
struct PackedPayload {
    v: u32,
    a: String,
    o: String,
    #[serde(with = "serde_bytes")]
    s: Vec<u8>,
    d: u64,
    p: u32,
    e: Vec<u64>,
    /// Display-state overrides (e.g. "showGrid:true"). These are dynamic
    /// key:value pairs that don't fit the fixed event registry.
    #[serde(skip_serializing_if = "HashMap::is_empty")]
    ds: HashMap<String, u64>,
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
    /// Builds packed msgpack payloads (v2) for the wire. On network failure,
    /// buffers the original JSON payload (v1) to disk for later retry.
    pub fn flush(&self) {
        let payloads = {
            let Ok(mut inner) = self.inner.lock() else {
                return;
            };
            if !inner.enabled || inner.events.is_empty() {
                return;
            }
            let app_version = env!("APP_VERSION").to_string();
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
            let packed = to_packed(payload);
            if let Err(e) = send_packed(&packed) {
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

            let packed = to_packed(&payload);
            if send_packed(&packed).is_ok() {
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

/// Convert a JSON `TelemetryPayload` to a packed wire-format payload.
#[cfg(feature = "telemetry")]
fn to_packed(payload: &TelemetryPayload) -> PackedPayload {
    let event_map = registry::event_map();
    let mut packed_events: Vec<u64> = Vec::new();
    let mut display_state: HashMap<String, u64> = HashMap::new();

    for (key, &count) in &payload.events {
        // display-state.* events have dynamic values — keep as strings
        if let Some(rest) = key.strip_prefix("display-state.") {
            display_state.insert(rest.to_string(), count);
            continue;
        }
        let (base, source_id) = registry::split_event_key(key);
        if let Some(&event_id) = event_map.get(base) {
            packed_events.push(u64::from(event_id));
            packed_events.push(u64::from(source_id));
            packed_events.push(count);
        }
        // Unregistered events are silently dropped — update the registry
        // to add new event names rather than relying on overflow.
    }

    PackedPayload {
        v: PACKED_PAYLOAD_VERSION,
        a: payload.app_version.clone(),
        o: payload.os.clone(),
        s: session_id_to_bytes(&payload.session_id),
        d: payload.duration_secs,
        p: payload.project_seq,
        e: packed_events,
        ds: display_state,
    }
}

/// Convert UUID string (with dashes) to 16 raw bytes.
#[cfg(feature = "telemetry")]
fn session_id_to_bytes(session_id: &str) -> Vec<u8> {
    let hex: String = session_id.chars().filter(|c| *c != '-').collect();
    let mut bytes = Vec::with_capacity(16);
    let mut i = 0;
    while i + 1 < hex.len() && bytes.len() < 16 {
        if let Ok(b) = u8::from_str_radix(&hex[i..i + 2], 16) {
            bytes.push(b);
        }
        i += 2;
    }
    bytes.resize(16, 0);
    bytes
}

/// Serialize packed payload as msgpack and POST to the telemetry endpoint.
#[cfg(feature = "telemetry")]
fn send_packed(packed: &PackedPayload) -> Result<(), String> {
    let body = rmp_serde::to_vec(packed).map_err(|e| e.to_string())?;

    let agent = ureq::Agent::config_builder()
        .timeout_global(Some(HTTP_TIMEOUT))
        .build()
        .new_agent();

    let response = agent
        .post(ENDPOINT_URL)
        .content_type("application/msgpack")
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
///
/// Flush policy:
/// - Every 60s: flush if there are action events (non-dwell) to send
/// - Every 10 min: flush even if only dwell-time events are pending
/// - On flush failure (no internet): retry every 60s until success,
///   then resume normal schedule
pub fn start_periodic_flush(collector: TelemetryCollector) {
    #[cfg(feature = "telemetry")]
    {
        std::thread::Builder::new()
            .name("telemetry-flush".to_string())
            .spawn(move || {
                const TICK_SECS: u64 = 60;
                const DWELL_ONLY_TICKS: u64 = 10; // 10 * 60s = 10 min
                let mut ticks_since_flush: u64 = 0;
                let mut has_buffered_failure = false;

                loop {
                    std::thread::sleep(std::time::Duration::from_secs(TICK_SECS));
                    ticks_since_flush += 1;

                    // Retry buffered payloads from previous failures
                    if has_buffered_failure {
                        collector.send_buffered();
                    }

                    let should_flush = {
                        let Ok(inner) = collector.inner.lock() else {
                            continue;
                        };
                        if !inner.enabled || inner.events.is_empty() {
                            false
                        } else {
                            let has_action_events = inner.events.values().any(|bucket| {
                                bucket.keys().any(|k| !k.starts_with("dwell."))
                            });
                            has_action_events
                                || ticks_since_flush >= DWELL_ONLY_TICKS
                                || has_buffered_failure
                        }
                    };

                    if should_flush {
                        collector.flush();

                        // Check if any payloads were buffered (flush failure)
                        has_buffered_failure = telemetry_buffer_dir()
                            .and_then(|d| fs::read_dir(d).ok())
                            .map_or(false, |mut entries| entries.next().is_some());

                        if !has_buffered_failure {
                            ticks_since_flush = 0;
                        }
                        // If flush failed, keep ticks_since_flush to avoid
                        // dwell-only delays on retry
                    }
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
    fn session_id_to_bytes_roundtrip() {
        let uuid = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";
        let bytes = session_id_to_bytes(uuid);
        assert_eq!(bytes.len(), 16);
        assert_eq!(
            bytes,
            vec![0xa1, 0xb2, 0xc3, 0xd4, 0xe5, 0xf6, 0x78, 0x90, 0xab, 0xcd, 0xef, 0x12, 0x34, 0x56, 0x78, 0x90]
        );
    }

    #[test]
    fn session_id_to_bytes_pads_short_input() {
        let bytes = session_id_to_bytes("abcd");
        assert_eq!(bytes.len(), 16);
        assert_eq!(bytes[0], 0xab);
        assert_eq!(bytes[1], 0xcd);
        assert_eq!(bytes[2..], [0u8; 14]);
    }

    #[test]
    fn to_packed_known_events() {
        let mut events = HashMap::new();
        events.insert("command.create_shot:keyboard".to_string(), 5);
        events.insert("command.save_project".to_string(), 3);

        let payload = TelemetryPayload {
            v: 1,
            app_version: "0.1.0".to_string(),
            os: "linux".to_string(),
            session_id: "a1b2c3d4-e5f6-7890-abcd-ef1234567890".to_string(),
            duration_secs: 300,
            project_seq: 1,
            events,
        };

        let packed = to_packed(&payload);
        assert_eq!(packed.v, 2);
        assert_eq!(packed.a, "0.1.0");
        assert_eq!(packed.o, "linux");
        assert_eq!(packed.s.len(), 16);
        assert_eq!(packed.d, 300);
        assert_eq!(packed.p, 1);
        // 2 events * 3 fields each = 6 entries in flat array
        assert_eq!(packed.e.len(), 6);

        // Verify the flat array contains expected (eid, sid, count) triples
        let mut found_create_shot = false;
        let mut found_save = false;
        for triple in packed.e.chunks_exact(3) {
            let eid = triple[0] as u16;
            let sid = triple[1] as u8;
            let count = triple[2];
            let event_name = registry::EVENT_NAMES[eid as usize];
            if event_name == "command.create_shot" && sid == 1 && count == 5 {
                found_create_shot = true;
            }
            if event_name == "command.save_project" && sid == 0 && count == 3 {
                found_save = true;
            }
        }
        assert!(found_create_shot, "command.create_shot:keyboard not found");
        assert!(found_save, "command.save_project not found");
    }

    #[test]
    fn to_packed_display_state_and_drops() {
        let mut events = HashMap::new();
        events.insert("display-state.showGrid:true".to_string(), 1);
        events.insert("completely.unknown.event".to_string(), 7);
        events.insert("command.undo".to_string(), 2);

        let payload = TelemetryPayload {
            v: 1,
            app_version: "0.1.0".to_string(),
            os: "linux".to_string(),
            session_id: "00000000-0000-0000-0000-000000000000".to_string(),
            duration_secs: 60,
            project_seq: 0,
            events,
        };

        let packed = to_packed(&payload);
        // command.undo is registered → 1 triple
        assert_eq!(packed.e.len(), 3);
        // display-state goes to dedicated ds map (prefix stripped)
        assert_eq!(packed.ds.len(), 1);
        assert_eq!(packed.ds.get("showGrid:true"), Some(&1));
        // completely.unknown.event is silently dropped
    }

    #[test]
    fn packed_msgpack_roundtrip() {
        let mut events = HashMap::new();
        events.insert("command.create_shot:keyboard".to_string(), 10);

        let payload = TelemetryPayload {
            v: 1,
            app_version: "0.1.0".to_string(),
            os: "linux".to_string(),
            session_id: "a1b2c3d4-e5f6-7890-abcd-ef1234567890".to_string(),
            duration_secs: 120,
            project_seq: 0,
            events,
        };

        let packed = to_packed(&payload);
        let bytes = rmp_serde::to_vec(&packed).unwrap();
        assert!(!bytes.is_empty());
        // Verify it's smaller than the JSON equivalent
        let json_bytes = serde_json::to_vec(&payload).unwrap();
        assert!(
            bytes.len() < json_bytes.len(),
            "msgpack ({}) should be smaller than JSON ({})",
            bytes.len(),
            json_bytes.len()
        );
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
