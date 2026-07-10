//! Linux-only WebKit memory-pressure configuration ([`WebkitMemoryConfig`]),
//! split out of `types.rs` for the file-size ratchet (#157). The runtime
//! consumer is `crate::webkit_memory`, which exports the corresponding
//! environment variables at startup.

use serde::{Deserialize, Serialize};

/// Linux-only WebKit memory-pressure tuning.
///
/// On Linux (webkitgtk) the WebKit web process never returns freed memory to the
/// OS without a pressure signal, so its RSS drifts far above live memory. These
/// settings give the web process a soft memory budget so WebKit's own
/// `MemoryPressureHandler` reclaims memory (GC-style pauses), with no kernel
/// cgroup throttling. Applied via the vendored, patched `wry`
/// (`src-tauri/vendor/wry/MODIFICATIONS.md`), which reads the
/// `STALAGMIGHT_WEBKIT_MEM_*` environment variables that `lib.rs` `run()` sets
/// from this config at startup.
///
/// Backend-only: the `Config` field is `#[ts(skip)]`, so this never reaches the
/// frontend. Tune it in `config.toml` or via the environment variables directly.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WebkitMemoryConfig {
    /// Master switch. When `false`, no pressure settings are applied and wry
    /// behaves exactly like upstream.
    #[serde(default = "default_true")]
    pub enabled: bool,
    /// Soft memory budget for the web process, in MB. The thresholds below are
    /// fractions of this. `0` disables the feature (same as `enabled = false`).
    #[serde(default = "default_webkit_mem_limit_mb")]
    pub memory_limit_mb: u32,
    /// Fraction of the limit at which WebKit starts a gentle cache release.
    #[serde(default = "default_webkit_mem_conservative")]
    pub conservative_threshold: f64,
    /// Fraction of the limit at which WebKit runs an aggressive, synchronous
    /// release.
    #[serde(default = "default_webkit_mem_strict")]
    pub strict_threshold: f64,
    /// Fraction of the limit at which the web process is killed. `0.0` = never.
    #[serde(default)]
    pub kill_threshold: f64,
    /// Poll interval in seconds for the pressure handler.
    #[serde(default = "default_webkit_mem_poll")]
    pub poll_interval_seconds: f64,
    /// Tell JavaScriptCore to size its heap for a machine with this much RAM,
    /// in MB (exported as `JSC_forceRAMSize`, in bytes, to the web process; JSC
    /// reads the variable directly, no wry patch involved). Yields much more
    /// aggressive GC thresholds; measured ~800 MB RSS reduction on a 75k-shot
    /// project with negligible interactivity cost. `0` = off (the variable is
    /// not set).
    #[serde(default = "default_webkit_jsc_force_ram_size_mb")]
    pub jsc_force_ram_size_mb: u32,
}

impl Default for WebkitMemoryConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            memory_limit_mb: default_webkit_mem_limit_mb(),
            conservative_threshold: default_webkit_mem_conservative(),
            strict_threshold: default_webkit_mem_strict(),
            kill_threshold: 0.0,
            poll_interval_seconds: default_webkit_mem_poll(),
            jsc_force_ram_size_mb: default_webkit_jsc_force_ram_size_mb(),
        }
    }
}

/// Serde default for `enabled` (module-local copy, same idiom as `gas.rs` -
/// `types.rs`'s `default_true` is private to that module).
fn default_true() -> bool {
    true
}

pub fn default_webkit_mem_limit_mb() -> u32 {
    550
}

pub fn default_webkit_mem_conservative() -> f64 {
    0.25
}

pub fn default_webkit_mem_strict() -> f64 {
    0.4
}

pub fn default_webkit_mem_poll() -> f64 {
    1.0
}

pub fn default_webkit_jsc_force_ram_size_mb() -> u32 {
    700
}
