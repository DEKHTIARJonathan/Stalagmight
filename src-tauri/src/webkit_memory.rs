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
//! constructor, so we apply them via a small patched wry fork
//! (<https://github.com/Stalagmight/wry>) that reads the `STALAGMIGHT_WEBKIT_MEM_*`
//! environment variables. This module sets those variables from
//! [`crate::config::WebkitMemoryConfig`] at the very top of `run()`, before the
//! Tauri builder starts (the config-defined window's WebContext is built inside
//! Tauri's setup step, *before* our `.setup()` hook runs, so this is the only
//! point early enough).
//!
//! Alongside the pressure settings we also export `JSC_forceRAMSize`
//! (`jsc_force_ram_size_mb`, in bytes): JavaScriptCore reads this environment
//! variable directly in the web process (no wry change needed) and sizes its
//! heap as if the machine had that much RAM, which means much more aggressive
//! GC thresholds. Measured ~800 MB RSS reduction on a 75k-shot project with
//! negligible interactivity cost on the debug build.

use crate::config::{Config, WebkitMemoryConfig};

const LIMIT_MB: &str = "STALAGMIGHT_WEBKIT_MEM_LIMIT_MB";
const CONSERVATIVE: &str = "STALAGMIGHT_WEBKIT_MEM_CONSERVATIVE";
const STRICT: &str = "STALAGMIGHT_WEBKIT_MEM_STRICT";
const KILL: &str = "STALAGMIGHT_WEBKIT_MEM_KILL";
const POLL: &str = "STALAGMIGHT_WEBKIT_MEM_POLL";
const JSC_FORCE_RAM_SIZE: &str = "JSC_forceRAMSize";

/// Translate a [`WebkitMemoryConfig`] into the environment pairs the web
/// process reads: the `STALAGMIGHT_WEBKIT_MEM_*` pressure settings (via the
/// vendored wry) plus `JSC_forceRAMSize` (read by JavaScriptCore directly).
///
/// When the master switch is off (or the limit is `0`) this yields a single
/// `LIMIT_MB=0`, which the wry patch treats as "off" (identical to upstream
/// behavior), and `JSC_forceRAMSize` is not emitted at all. With the feature
/// on, `jsc_force_ram_size_mb == 0` omits just the JSC pair (JSC's off state
/// is the variable being absent).
fn env_pairs(cfg: &WebkitMemoryConfig) -> Vec<(&'static str, String)> {
    if !cfg.enabled || cfg.memory_limit_mb == 0 {
        return vec![(LIMIT_MB, "0".to_string())];
    }
    let mut pairs = vec![
        (LIMIT_MB, cfg.memory_limit_mb.to_string()),
        (CONSERVATIVE, cfg.conservative_threshold.to_string()),
        (STRICT, cfg.strict_threshold.to_string()),
        (KILL, cfg.kill_threshold.to_string()),
        (POLL, cfg.poll_interval_seconds.to_string()),
    ];
    if cfg.jsc_force_ram_size_mb > 0 {
        let bytes = u64::from(cfg.jsc_force_ram_size_mb) * 1024 * 1024;
        pairs.push((JSC_FORCE_RAM_SIZE, bytes.to_string()));
    }
    pairs
}

/// The env pairs to export, honoring an ENV master-disable override.
///
/// `env_limit` is the current value of `STALAGMIGHT_WEBKIT_MEM_LIMIT_MB` in the
/// environment (if any). The documented way to disable the feature without
/// editing `config.toml` is to force that variable to `0`. But `env_pairs` only
/// sees the CONFIG, so on its own the override would leave `JSC_forceRAMSize`
/// (derived from `jsc_force_ram_size_mb`) still exported - and JavaScriptCore
/// reads it directly, independent of the wry pressure handler that `LIMIT_MB=0`
/// disables. The result would be "pressure off, but JSC still sizes itself as a
/// 700 MB machine", i.e. the advertised override does NOT restore upstream
/// behavior. So when the env forces the limit off we emit only the `LIMIT_MB=0`
/// sentinel and suppress JSC tuning (and the other pressure pairs) too.
fn resolve_env_pairs(
    cfg: &WebkitMemoryConfig,
    env_limit: Option<&str>,
) -> Vec<(&'static str, String)> {
    let env_forces_off = env_limit.and_then(|v| v.trim().parse::<u64>().ok()) == Some(0);
    if env_forces_off {
        return vec![(LIMIT_MB, "0".to_string())];
    }
    env_pairs(cfg)
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
/// Returns the loaded [`WebkitMemoryConfig`] so the caller can log a summary via
/// [`log_applied_config`] AFTER the logger is initialized. This runs as the very
/// first statement of `run()` - before `logging::init()` - so emitting a
/// `tracing` event here would be dropped (no subscriber exists yet); it also
/// must run there so the `set_var` calls below are genuinely single-threaded.
///
/// Any variable already present in the environment is left untouched, so a
/// caller can force values (e.g. `STALAGMIGHT_WEBKIT_MEM_LIMIT_MB=0` to disable)
/// without editing `config.toml`.
pub(crate) fn apply_env_from_config() -> WebkitMemoryConfig {
    let cfg = config_path()
        .and_then(|p| Config::load_from_path(&p).ok())
        .unwrap_or_default()
        .webkit_memory;

    let env_limit = std::env::var(LIMIT_MB).ok();
    for (key, value) in resolve_env_pairs(&cfg, env_limit.as_deref()) {
        if std::env::var_os(key).is_some() {
            continue;
        }
        // Sound because this is the FIRST statement of `run()`, before
        // `logging::init()` spawns the `tracing_appender` writer thread or the
        // Tauri builder starts any event loop / worker thread. The process is
        // genuinely single-threaded here, so there is no concurrent
        // getenv/setenv (the POSIX data race this would otherwise be).
        std::env::set_var(key, &value);
    }

    cfg
}

/// Emit the applied WebKit memory-pressure summary. Split out of
/// [`apply_env_from_config`] (which runs before any logging subscriber exists)
/// so the diagnostic is logged right AFTER `logging::init()` instead of being
/// silently dropped.
pub(crate) fn log_applied_config(cfg: &WebkitMemoryConfig) {
    tracing::info!(
        enabled = cfg.enabled,
        memory_limit_mb = cfg.memory_limit_mb,
        conservative_threshold = cfg.conservative_threshold,
        strict_threshold = cfg.strict_threshold,
        poll_interval_seconds = cfg.poll_interval_seconds,
        jsc_force_ram_size_mb = cfg.jsc_force_ram_size_mb,
        "Configured WebKit memory-pressure environment for the web process"
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_config_emits_all_six_pairs() {
        let cfg = WebkitMemoryConfig::default();
        assert_eq!(
            env_pairs(&cfg),
            vec![
                (LIMIT_MB, "550".to_string()),
                (CONSERVATIVE, "0.25".to_string()),
                (STRICT, "0.4".to_string()),
                (KILL, "0".to_string()),
                (POLL, "1".to_string()),
                // 700 MB in bytes.
                (JSC_FORCE_RAM_SIZE, "734003200".to_string()),
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
            jsc_force_ram_size_mb: 1024,
        };
        assert_eq!(
            env_pairs(&cfg),
            vec![
                (LIMIT_MB, "1200".to_string()),
                (CONSERVATIVE, "0.25".to_string()),
                (STRICT, "0.6".to_string()),
                (KILL, "0.9".to_string()),
                (POLL, "5".to_string()),
                // 1024 MB = 1 GiB in bytes.
                (JSC_FORCE_RAM_SIZE, "1073741824".to_string()),
            ]
        );
    }

    #[test]
    fn zero_jsc_ram_size_omits_the_jsc_pair() {
        let cfg = WebkitMemoryConfig {
            jsc_force_ram_size_mb: 0,
            ..WebkitMemoryConfig::default()
        };
        let pairs = env_pairs(&cfg);
        assert_eq!(pairs.len(), 5);
        assert!(pairs.iter().all(|(key, _)| *key != JSC_FORCE_RAM_SIZE));
    }

    #[test]
    fn disabled_config_omits_the_jsc_pair_too() {
        let cfg = WebkitMemoryConfig {
            enabled: false,
            ..WebkitMemoryConfig::default()
        };
        // Master switch off: only the LIMIT_MB=0 sentinel, no JSC_forceRAMSize.
        assert_eq!(env_pairs(&cfg), vec![(LIMIT_MB, "0".to_string())]);
    }

    #[test]
    fn env_limit_zero_override_suppresses_jsc_even_when_config_enables_it() {
        // Config would export the full pressure set incl. JSC, but the documented
        // env master-disable (LIMIT_MB=0) must restore upstream behavior fully:
        // only the sentinel, no JSC_forceRAMSize sizing JavaScriptCore.
        let cfg = WebkitMemoryConfig::default();
        assert!(env_pairs(&cfg)
            .iter()
            .any(|(k, _)| *k == JSC_FORCE_RAM_SIZE));
        assert_eq!(
            resolve_env_pairs(&cfg, Some("0")),
            vec![(LIMIT_MB, "0".to_string())]
        );
        // Whitespace tolerated (env values can carry stray spacing).
        assert_eq!(
            resolve_env_pairs(&cfg, Some(" 0 ")),
            vec![(LIMIT_MB, "0".to_string())]
        );
    }

    #[test]
    fn no_env_override_keeps_config_derived_pairs() {
        let cfg = WebkitMemoryConfig::default();
        assert_eq!(resolve_env_pairs(&cfg, None), env_pairs(&cfg));
    }

    #[test]
    fn nonzero_env_override_keeps_config_derived_pairs() {
        // A non-zero override tweaks the limit (handled by the per-key skip in
        // apply_env_from_config) but is NOT a master-disable, so JSC stays.
        let cfg = WebkitMemoryConfig::default();
        assert_eq!(resolve_env_pairs(&cfg, Some("500")), env_pairs(&cfg));
    }
}
