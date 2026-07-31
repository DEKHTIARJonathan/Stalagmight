//! Crash-safe replacement of `config.toml`, and cleanup of what an interrupted
//! replacement leaves behind.
//!
//! Split out of `types.rs` rather than rebaselined when the pair outgrew the
//! file-size ratchet (#157). The two functions here are one concern: the write
//! creates the temp files, and the sweep is the only thing that collects them.

use anyhow::{Context, Result};
use std::io::Write;
use std::path::Path;

/// How old an abandoned `config.toml.<pid>.<n>.tmp` must be before
/// [`sweep_stale_temp_files`] will delete it.
///
/// The sweep races live writers by construction, so this is a safety margin, not
/// a tuning knob: another process - or another `AppState` in this one - can be
/// between `File::create` and `fs::rename` at this instant, and deleting *that*
/// file reintroduces the exact "Failed to replace config file: No such file or
/// directory" the unique temp name exists to prevent. A real write holds the
/// temp file open for microseconds, so an hour is far past any live write while
/// still collecting leaked files within one session.
const STALE_TEMP_AGE: std::time::Duration = std::time::Duration::from_secs(60 * 60);

/// Write `contents` to `path` via a sibling temp file and a rename, the same
/// shape the project save uses (`core::state::project_io`).
///
/// `fs::write` truncates the destination before it writes a byte, so a crash or
/// a full disk part-way through left `config.toml` empty or holding half a TOML
/// document. Neither is recoverable by the load path and the failure is SILENT
/// in the worst direction: `Config::load()` is called through
/// `unwrap_or_default()` (`AppState::new`), so a truncated file reads back as
/// "no config" and every setting the user ever changed is reset without an error
/// anywhere. The rename is atomic, so a reader sees the whole old file or the
/// whole new one.
///
/// The temp file is a SIBLING rather than one in `$TMPDIR`: a rename across
/// filesystems is not atomic and on most platforms fails outright, and the
/// config directory is the one place we have just confirmed is writable.
///
/// `sync_all` before the rename is the durability half, and it is not redundant
/// with the atomicity half: without it the rename can reach the disk ahead of
/// the data, which on a crash leaves a correctly-named file full of zeroes -
/// i.e. exactly the silent reset above, reintroduced.
pub(super) fn write_atomically(path: &Path, contents: &str) -> Result<()> {
    // The temp name is UNIQUE PER WRITE, and that is load-bearing rather than
    // tidiness. A fixed `config.toml.tmp` is itself a shared resource: two
    // writers racing on the same config directory both create that one path,
    // and the first to finish renames it away, leaving the second's rename to
    // fail with ENOENT over a config it believed it had written.
    //
    // `AppState::config_write_lock` does NOT cover this. That lock is per
    // AppState INSTANCE, and the collision is between processes and between
    // independent instances: every tree on this machine shares one app-data
    // directory, so two running copies of Stalagmight write the same
    // `config.toml`. Caught by the full Rust suite, where the failure is a
    // real "Failed to replace config file: No such file or directory" from
    // unrelated tests saving concurrently - master is green, so this was
    // introduced with the atomic write itself.
    //
    // pid plus a monotonic counter distinguishes both axes: the pid separates
    // processes, the counter separates concurrent writers inside one process.
    static WRITE_SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let unique = format!(
        "{}.{}",
        std::process::id(),
        WRITE_SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
    );
    // `with_extension` replaces `.toml`, so this is `config.toml.<pid>.<n>.tmp`.
    // It is removed on every failure path below, but those only cover errors
    // this function can observe: a crash, a power loss or a SIGKILL between
    // `File::create` and the rename leaves one behind, and because the name is
    // unique per write it is never overwritten - so they ACCUMULATE, one per
    // interrupted write. `Config::load_from_path` age-sweeps them; see
    // `sweep_stale_temp_files`. Nothing else collects them - in particular
    // `sqlite::repair::list_backups` only LISTS, never deletes, and only beside
    // a project file, never in the app-data config directory.
    let temp_path = path.with_extension(format!("toml.{unique}.tmp"));

    let write = || -> Result<()> {
        // `create_new` (O_CREAT|O_EXCL), NOT `create`. The temp name is fully
        // predictable - the counter starts at 0, so the first write of a process
        // is at `config.toml.<pid>.0.tmp` - and plain `create` is O_CREAT|O_TRUNC
        // WITHOUT O_EXCL, which follows symlinks. Anything able to write to the
        // config dir could pre-plant that name as a symlink: the write would
        // truncate and fill the link's target, and the rename below would then
        // move the symlink itself over `config.toml`, leaving the live config
        // path an attacker-controlled link for every later write. O_EXCL fails
        // outright on an existing name, symlink included.
        let mut file = std::fs::File::create_new(&temp_path)
            .context("Failed to create temporary config file")?;
        file.write_all(contents.as_bytes())
            .context("Failed to write temporary config file")?;
        file.sync_all()
            .context("Failed to flush temporary config file")?;
        Ok(())
    };
    if let Err(e) = write() {
        let _ = std::fs::remove_file(&temp_path);
        return Err(e);
    }

    if let Err(e) = std::fs::rename(&temp_path, path) {
        // The destination is untouched, which is the recoverable direction:
        // the user keeps the settings they had rather than losing all of them.
        let _ = std::fs::remove_file(&temp_path);
        return Err(anyhow::Error::new(e).context("Failed to replace config file"));
    }
    Ok(())
}

/// Delete abandoned temp files left beside `config.toml` by an interrupted
/// [`write_atomically`].
///
/// Best-effort by design: every failure here (unreadable directory, a file
/// deleted by another sweeper mid-loop, a permission error) is ignored, because
/// failing to collect a stale temp file must never stop the config from loading.
pub(super) fn sweep_stale_temp_files(dir: &Path) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let Some(name) = name.to_str() else {
            continue;
        };
        // Matches what `write_atomically` produces, and nothing else: the live
        // `config.toml` has no `.tmp` suffix, and a project's own `.stalx.tmp`
        // does not start with `config.toml.`.
        if !name.starts_with("config.toml.") || !name.ends_with(".tmp") {
            continue;
        }
        let stale = entry
            .metadata()
            .ok()
            .and_then(|meta| meta.modified().ok())
            .and_then(|modified| modified.elapsed().ok())
            .is_some_and(|age| age >= STALE_TEMP_AGE);
        if stale {
            let _ = std::fs::remove_file(entry.path());
            tracing::debug!(temp_file = ?entry.path(), "Swept stale config temp file");
        }
    }
}
