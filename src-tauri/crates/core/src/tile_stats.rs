//! Tile-fetch statistics. Tauri-free on purpose: `AppState` owns the shared
//! instance, so the type has to live below the app crate - the app keeps the
//! actual event emission (`tile-transport-error` / `tile-transport-success`)
//! and drives it off the transition latch here.

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};

/// Lock-free tile fetch statistics using atomic counters.
///
/// Shared across the protocol handler and IPC commands via `Arc`.
/// All methods use `Relaxed` ordering since we only need approximate
/// monotonic counters, not cross-field consistency.
pub struct TileFetchStats {
    total_fetched: AtomicU64,
    total_errors: AtomicU64,
    /// Cumulative sum of all successful fetch latencies (ms)
    total_latency_ms: AtomicU64,
    last_latency_ms: AtomicU64,
    in_flight: AtomicU64,
    /// true = we've notified the frontend that tiles are failing
    notified_offline: AtomicBool,
}

/// Snapshot of tile fetch statistics at a point in time.
pub struct TileFetchStatsSnapshot {
    pub in_flight: u64,
    pub total_fetched: u64,
    pub total_errors: u64,
    pub total_latency_ms: u64,
    pub last_latency_ms: u64,
}

impl Default for TileFetchStats {
    fn default() -> Self {
        Self::new()
    }
}

impl TileFetchStats {
    pub fn new() -> Self {
        Self {
            total_fetched: AtomicU64::new(0),
            total_errors: AtomicU64::new(0),
            total_latency_ms: AtomicU64::new(0),
            last_latency_ms: AtomicU64::new(0),
            in_flight: AtomicU64::new(0),
            notified_offline: AtomicBool::new(false),
        }
    }

    /// Call before starting a network fetch.
    pub fn record_start(&self) {
        self.in_flight.fetch_add(1, Ordering::Relaxed);
    }

    /// Call after a successful network fetch.
    pub fn record_success(&self, latency_ms: u64) {
        self.in_flight.fetch_sub(1, Ordering::Relaxed);
        self.total_fetched.fetch_add(1, Ordering::Relaxed);
        self.total_latency_ms
            .fetch_add(latency_ms, Ordering::Relaxed);
        self.last_latency_ms.store(latency_ms, Ordering::Relaxed);
    }

    /// Call after a failed network fetch (all retries exhausted).
    pub fn record_error(&self) {
        self.in_flight.fetch_sub(1, Ordering::Relaxed);
        self.total_errors.fetch_add(1, Ordering::Relaxed);
    }

    /// Take a snapshot of the current counters.
    pub fn snapshot(&self) -> TileFetchStatsSnapshot {
        TileFetchStatsSnapshot {
            in_flight: self.in_flight.load(Ordering::Relaxed),
            total_fetched: self.total_fetched.load(Ordering::Relaxed),
            total_errors: self.total_errors.load(Ordering::Relaxed),
            total_latency_ms: self.total_latency_ms.load(Ordering::Relaxed),
            last_latency_ms: self.last_latency_ms.load(Ordering::Relaxed),
        }
    }

    /// Latch the online→offline transition: `true` exactly once per
    /// transition, until [`Self::transition_to_online`] re-arms it. The app
    /// crate emits `tile-transport-error` on `true` - the emission is Tauri's,
    /// but the once-per-transition bookkeeping belongs with the counters.
    pub fn transition_to_offline(&self) -> bool {
        self.notified_offline
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .is_ok()
    }

    /// Latch the offline→online transition (the mirror of
    /// [`Self::transition_to_offline`]); the app crate emits
    /// `tile-transport-success` on `true`.
    pub fn transition_to_online(&self) -> bool {
        self.notified_offline
            .compare_exchange(true, false, Ordering::SeqCst, Ordering::SeqCst)
            .is_ok()
    }
}
