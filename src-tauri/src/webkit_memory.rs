//! Linux-only: give the WebKit web process a soft memory budget so it returns
//! freed memory to the OS.
//!
//! On Linux (webkitgtk) the `WebKitWebProcess` grows its RSS far above its live
//! memory and never reclaims it without a pressure signal. WebKit's own
//! `MemoryPressureHandler` knows how to release caches and compact its allocator,
//! but on a normal desktop nothing ever signals pressure, so it never fires. We
//! give it an explicit budget via `WebKitMemoryPressureSettings` (a construct-only
//! property on the `WebContext`) so it reclaims on our terms, with GC-style pauses
//! and no kernel cgroup throttling.
//!
//! The settings are a construct-only property read when the web process spawns, so
//! they must be installed before the `WebContext` is built. wry owns that
//! constructor, so we apply them via a small vendored patch to wry
//! (`vendor/wry/MODIFICATIONS.md`) that reads the `STALAGMIGHT_WEBKIT_MEM_*`
//! environment variables. This module sets those variables from
//! [`crate::config::WebkitMemoryConfig`] at the very top of `run()`, before the
//! Tauri builder starts (the config-defined window's WebContext is built inside
//! Tauri's setup step, *before* our `.setup()` hook runs, so this is the only
//! point early enough).

use crate::config::{Config, WebkitMemoryConfig};

const LIMIT_MB: &str = "STALAGMIGHT_WEBKIT_MEM_LIMIT_MB";
const CONSERVATIVE: &str = "STALAGMIGHT_WEBKIT_MEM_CONSERVATIVE";
const STRICT: &str = "STALAGMIGHT_WEBKIT_MEM_STRICT";
const KILL: &str = "STALAGMIGHT_WEBKIT_MEM_KILL";
const POLL: &str = "STALAGMIGHT_WEBKIT_MEM_POLL";

/// Translate a [`WebkitMemoryConfig`] into the `STALAGMIGHT_WEBKIT_MEM_*`
/// environment pairs the vendored wry reads. When the feature is disabled (or the
/// limit is `0`) this yields a single `LIMIT_MB=0`, which the wry patch treats as
/// "off" (identical to upstream behavior).
fn env_pairs(cfg: &WebkitMemoryConfig) -> Vec<(&'static str, String)> {
    if !cfg.enabled || cfg.memory_limit_mb == 0 {
        return vec![(LIMIT_MB, "0".to_string())];
    }
    vec![
        (LIMIT_MB, cfg.memory_limit_mb.to_string()),
        (CONSERVATIVE, cfg.conservative_threshold.to_string()),
        (STRICT, cfg.strict_threshold.to_string()),
        (KILL, cfg.kill_threshold.to_string()),
        (POLL, cfg.poll_interval_seconds.to_string()),
    ]
}

/// Resolve the config path the way Tauri does on Linux:
/// `<XDG config base>/<bundle identifier>/config.toml`.
///
/// This runs before Tauri's `.setup()` (and thus before `app_dirs::init()`), so
/// the resolved config dir is not available yet. Keep the identifier in sync with
/// `identifier` in `tauri.conf.json`.
fn config_path() -> Option<std::path::PathBuf> {
    let base = directories::BaseDirs::new()?;
    Some(
        base.config_dir()
            .join("com.stalagmight.desktop")
            .join("config.toml"),
    )
}

/// Load the WebKit memory config (falling back to defaults when the file is
/// missing or unreadable) and export the corresponding environment variables so
/// the vendored wry can install the pressure settings on the web process.
///
/// Any variable already present in the environment is left untouched, so a
/// caller can force values (e.g. `STALAGMIGHT_WEBKIT_MEM_LIMIT_MB=0` to disable)
/// without editing `config.toml`.
pub(crate) fn apply_env_from_config() {
    let cfg = config_path()
        .and_then(|p| Config::load_from_path(&p).ok())
        .unwrap_or_default()
        .webkit_memory;

    for (key, value) in env_pairs(&cfg) {
        if std::env::var_os(key).is_some() {
            continue;
        }
        // Sound because this runs single-threaded at the top of `run()`, before
        // the Tauri builder or any event loop / worker threads exist.
        std::env::set_var(key, &value);
    }

    tracing::info!(
        enabled = cfg.enabled,
        memory_limit_mb = cfg.memory_limit_mb,
        conservative_threshold = cfg.conservative_threshold,
        strict_threshold = cfg.strict_threshold,
        poll_interval_seconds = cfg.poll_interval_seconds,
        "Configured WebKit memory-pressure environment for the web process"
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_config_emits_all_five_pairs() {
        let cfg = WebkitMemoryConfig::default();
        assert_eq!(
            env_pairs(&cfg),
            vec![
                (LIMIT_MB, "900".to_string()),
                (CONSERVATIVE, "0.33".to_string()),
                (STRICT, "0.5".to_string()),
                (KILL, "0".to_string()),
                (POLL, "3".to_string()),
            ]
        );
    }

    #[test]
    fn disabled_config_emits_off_sentinel() {
        let cfg = WebkitMemoryConfig {
            enabled: false,
            ..WebkitMemoryConfig::default()
        };
        assert_eq!(env_pairs(&cfg), vec![(LIMIT_MB, "0".to_string())]);
    }

    #[test]
    fn zero_limit_emits_off_sentinel() {
        let cfg = WebkitMemoryConfig {
            memory_limit_mb: 0,
            ..WebkitMemoryConfig::default()
        };
        assert_eq!(env_pairs(&cfg), vec![(LIMIT_MB, "0".to_string())]);
    }

    #[test]
    fn custom_values_are_stringified() {
        let cfg = WebkitMemoryConfig {
            enabled: true,
            memory_limit_mb: 1200,
            conservative_threshold: 0.25,
            strict_threshold: 0.6,
            kill_threshold: 0.9,
            poll_interval_seconds: 5.0,
        };
        assert_eq!(
            env_pairs(&cfg),
            vec![
                (LIMIT_MB, "1200".to_string()),
                (CONSERVATIVE, "0.25".to_string()),
                (STRICT, "0.6".to_string()),
                (KILL, "0.9".to_string()),
                (POLL, "5".to_string()),
            ]
        );
    }
}
