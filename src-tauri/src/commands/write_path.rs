//! [#576 C11-D1] The one check every command that writes, replaces or deletes a
//! file at a path the webview hands it runs first.
//!
//! The real boundary is that only the app's bundled frontend runs in the webview
//! (a strict CSP, `script-src 'self'`; see docs/architecture.md, "IPC trust
//! boundary"). The custom commands take arbitrary paths from it - Tauri's fs
//! capability scope does not apply to them - so this check is defence in depth for
//! the day that boundary fails: a script that got into the page could otherwise
//! export over `config.toml`, the stored API key or a system file, or delete or
//! "repair" any file it names. Three rules, deliberately narrow so no place a user
//! saves to is refused:
//!
//! - the file has the extension of what is being written (`.stalx` for a project,
//!   the export format's own for an export);
//! - it is not inside the app's own directories (configuration, data, cache) -
//!   except the SpeleoDB managed-project cache, where projects legitimately live;
//! - it is not inside a system directory (`/etc`, `/usr`, `C:\Windows`,
//!   `C:\Program Files`, ...). `/home`, `/var`, `/run/media`, `/mnt`, `/media`,
//!   `/opt` and `/tmp` are not system directories here: users save there.

use std::path::{Component, Path, PathBuf};

use crate::export::{ImageFormat, ProfileFormat};

/// What a command is about to write, which decides the extension it must have.
#[derive(Debug, Clone, Copy)]
pub(crate) enum WriteTarget {
    /// A project database (`.stalx`).
    Project,
    Csv,
    Json,
    /// Ariane `.tml` / `.tmlu`.
    Ariane,
    Image(ImageFormat),
    DiveProfile(ProfileFormat),
}

impl WriteTarget {
    fn extensions(self) -> &'static [&'static str] {
        match self {
            Self::Project => &["stalx"],
            Self::Csv => &["csv"],
            Self::Json => &["json"],
            Self::Ariane => &["tml", "tmlu"],
            Self::Image(ImageFormat::Png) => &["png"],
            Self::Image(ImageFormat::Svg) => &["svg"],
            Self::Image(ImageFormat::Pdf) => &["pdf"],
            Self::DiveProfile(ProfileFormat::SubsurfaceXml) => &["xml"],
            Self::DiveProfile(ProfileFormat::PlainText) => &["txt"],
        }
    }
}

/// The app's own directories, and the one place inside them projects may live.
pub(crate) struct AppDirs {
    /// Configuration, data (logs, telemetry) and cache directories.
    pub(crate) internal: Vec<PathBuf>,
    /// The SpeleoDB managed-project cache (inside the cache directory).
    pub(crate) managed_projects: Option<PathBuf>,
}

impl AppDirs {
    /// The directories this process resolved at startup. A directory that did not
    /// resolve (the `"."` fallback, or any relative path) is left out: guarding the
    /// working directory would refuse wherever the app happened to be started.
    pub(crate) fn current() -> Self {
        let usable = |dir: Option<&Path>| dir.filter(|d| d.is_absolute()).map(Path::to_path_buf);
        let cache = usable(crate::app_dirs::cache_dir());
        Self {
            internal: [
                usable(crate::app_dirs::config_dir()),
                usable(crate::app_dirs::data_local_dir()),
                cache.clone(),
            ]
            .into_iter()
            .flatten()
            .collect(),
            managed_projects: cache.map(|c| c.join("speleodb")),
        }
    }
}

/// Check `path` before a command writes `target` to it, replaces it or deletes it.
/// `Err` is the user-facing reason, naming the file.
pub(crate) fn check_write_path(path: &Path, target: WriteTarget) -> Result<(), String> {
    check_write_path_with(path, target, &AppDirs::current())
}

/// [`check_write_path`] against given app directories (the testable core).
pub(crate) fn check_write_path_with(
    path: &Path,
    target: WriteTarget,
    dirs: &AppDirs,
) -> Result<(), String> {
    let name = path.file_name().map_or_else(
        || path.display().to_string(),
        |n| n.to_string_lossy().into_owned(),
    );
    let refuse = |why: String| {
        tracing::warn!(
            path = ?path,
            target = ?target,
            reason = %why,
            purpose = "refuse a write outside where the app writes (#576 C11-D1)",
            "Refused a file write"
        );
        Err(format!("Refused to change {name}: {why}"))
    };

    let extensions = target.extensions();
    let has_expected = path
        .extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| extensions.iter().any(|x| e.eq_ignore_ascii_case(x)));
    if !has_expected {
        let expected: Vec<String> = extensions.iter().map(|e| format!(".{e}")).collect();
        return refuse(format!("the file must end in {}", expected.join(" or ")));
    }

    let forms = path_forms(path);
    let inside = |dir: &Path| {
        let dir_forms = path_forms(dir);
        forms
            .iter()
            .any(|p| dir_forms.iter().any(|d| starts_with_dir(p, d)))
    };
    let managed = matches!(target, WriteTarget::Project)
        && dirs.managed_projects.as_deref().is_some_and(inside);
    if !managed && dirs.internal.iter().any(|d| inside(d)) {
        return refuse("that is inside the app's own settings, data or cache folder".to_owned());
    }
    if system_dirs().iter().any(|d| inside(d)) {
        return refuse("that is inside a system folder".to_owned());
    }
    Ok(())
}

/// The forms of `path` to compare: as given (made absolute), and with its deepest
/// existing ancestor resolved (symlinks, `..`), so `/etc` reached as `/private/etc`
/// or through a link is still recognised. The file itself need not exist.
fn path_forms(path: &Path) -> Vec<PathBuf> {
    let absolute = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir().map_or_else(|_| path.to_path_buf(), |cwd| cwd.join(path))
    };
    let mut forms = vec![lexical(&absolute)];
    let mut existing = absolute.as_path();
    let mut rest: Vec<&std::ffi::OsStr> = Vec::new();
    loop {
        if let Ok(canonical) = std::fs::canonicalize(existing) {
            let mut resolved = canonical;
            for part in rest.iter().rev() {
                resolved.push(part);
            }
            forms.push(resolved);
            break;
        }
        match (existing.parent(), existing.file_name()) {
            (Some(parent), Some(name)) => {
                rest.push(name);
                existing = parent;
            }
            _ => break,
        }
    }
    forms
}

/// `path` with `.` and `..` folded away, without touching the disk.
fn lexical(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                out.pop();
            }
            other => out.push(other),
        }
    }
    out
}

/// Whether `path` is `dir` or inside it - case-insensitively on Windows, whose
/// file system is.
fn starts_with_dir(path: &Path, dir: &Path) -> bool {
    if cfg!(windows) {
        let lower = |p: &Path| PathBuf::from(p.to_string_lossy().to_lowercase());
        lower(path).starts_with(lower(dir))
    } else {
        path.starts_with(dir)
    }
}

/// The system directories no command may write into.
fn system_dirs() -> Vec<PathBuf> {
    if cfg!(windows) {
        [
            "SystemRoot",
            "windir",
            "ProgramFiles",
            "ProgramFiles(x86)",
            "ProgramW6432",
        ]
        .iter()
        .filter_map(|var| std::env::var_os(var))
        .map(PathBuf::from)
        .filter(|p| p.is_absolute())
        .collect()
    } else {
        [
            "/bin",
            "/boot",
            "/dev",
            "/etc",
            "/lib",
            "/lib32",
            "/lib64",
            "/libx32",
            "/proc",
            "/sbin",
            "/sys",
            "/usr",
            "/System",
            "/private/etc",
        ]
        .iter()
        .map(PathBuf::from)
        .collect()
    }
}
