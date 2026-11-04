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
use crate::persistence::UpgradeRefusal;

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
    /// Every target, for [`Self::of_path`].
    const ALL: [Self; 9] = [
        Self::Project,
        Self::Csv,
        Self::Json,
        Self::Ariane,
        Self::Image(ImageFormat::Png),
        Self::Image(ImageFormat::Svg),
        Self::Image(ImageFormat::Pdf),
        Self::DiveProfile(ProfileFormat::SubsurfaceXml),
        Self::DiveProfile(ProfileFormat::PlainText),
    ];

    /// [#576 HFI-2] What a file named `path` would be written as - the target
    /// whose extension it has - or `None` when the app writes no file of that
    /// type. For a check that serves every save and export alike (the
    /// existence probe, `commands::save_target`).
    pub(crate) fn of_path(path: &Path) -> Option<Self> {
        let extension = path.extension()?.to_str()?;
        Self::ALL.into_iter().find(|target| {
            target
                .extensions()
                .iter()
                .any(|x| extension.eq_ignore_ascii_case(x))
        })
    }

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
    location_refusal(path, matches!(target, WriteTarget::Project), dirs).map_or(Ok(()), refuse)
}

/// [#576 RV4-R-M3-OPEN] What a load of `path` may not write, as the message to
/// refuse it with - or `None` where a user keeps projects.
///
/// Opening a project only reads it, with one exception: an older-format file is
/// upgraded IN PLACE, and a `.pre-v<N>.backup` copy of it is written beside it
/// first. So a load anywhere opens the file (viewing and exporting a project kept
/// in the app's own folders or a system folder work as anywhere else), and the
/// location rules of [`check_write_path`] - not inside the app's own folders (the
/// SpeleoDB managed-project cache excepted), not inside a system folder - apply
/// to that upgrade alone: it is refused there with this message, before anything
/// is written, and the file is left as it was. The extension rule does not apply:
/// the open dialog offers "All Files", and a load creates no file of that name.
///
/// [#576 RV6b-R3] Two messages, one per write the open would make: the load
/// refuses with the one that fits the file. An unstamped file whose project row
/// claims this version is not an older file and gets no backup copy, so it is not
/// told either.
pub(crate) fn load_upgrade_refusal(path: &Path) -> Option<UpgradeRefusal> {
    load_upgrade_refusal_with(path, &AppDirs::current())
}

/// [`load_upgrade_refusal`] against given app directories (the testable core).
pub(crate) fn load_upgrade_refusal_with(path: &Path, dirs: &AppDirs) -> Option<UpgradeRefusal> {
    let why = location_refusal(path, true, dirs)?;
    let name = path.file_name().map_or_else(
        || path.display().to_string(),
        |n| n.to_string_lossy().into_owned(),
    );
    let what_to_do = "where Stalagmight does not write. The file was left as it was. Copy the \
                      project to a folder of your own (for example Documents) and open the copy.";
    Some(UpgradeRefusal {
        older_format: format!(
            "{name} was saved by an older version of Stalagmight, and opening it would upgrade \
             it to the current file format in place and keep a backup copy beside it - but \
             {why}, {what_to_do}"
        ),
        unstamped: format!(
            "{name} has no file-format version stamp, so opening it would bring its file \
             format up to date in place - but {why}, {what_to_do}"
        ),
    })
}

/// Why `path` is in a place no command may write, or `None`. `project` lets a
/// project live in the SpeleoDB managed-project cache.
fn location_refusal(path: &Path, project: bool, dirs: &AppDirs) -> Option<String> {
    let forms = path_forms(path);
    let inside = |dir: &Path| {
        let dir_forms = path_forms(dir);
        forms
            .iter()
            .any(|p| dir_forms.iter().any(|d| starts_with_dir(p, d)))
    };
    let managed = project && dirs.managed_projects.as_deref().is_some_and(inside);
    if !managed && dirs.internal.iter().any(|d| inside(d)) {
        return Some("that is inside the app's own settings, data or cache folder".to_owned());
    }
    if system_dirs().iter().any(|d| inside(d)) {
        return Some("that is inside a system folder".to_owned());
    }
    None
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

/// How a platform's file system compares paths (#576 RV6b-R4).
#[derive(Clone, Copy, Debug)]
pub(crate) struct PathRules {
    /// Windows path syntax: `\` and `/` both separate, and a verbatim prefix
    /// (`\\?\C:\..`, `\\?\UNC\server\share\..`) names the same place as the plain
    /// form (`C:\..`, `\\server\share\..`).
    pub(crate) windows: bool,
    /// Names match whatever their letter case: Windows (NTFS) and macOS, whose
    /// default file systems (APFS, HFS+) are case-insensitive. On a macOS volume
    /// formatted case-sensitive this refuses a differently-cased folder too - the
    /// conservative side for a check that only ever refuses.
    pub(crate) fold_case: bool,
}

impl PathRules {
    /// The rules of the platform this build runs on.
    pub(crate) const HOST: Self = Self {
        windows: cfg!(windows),
        fold_case: cfg!(any(windows, target_os = "macos")),
    };
}

/// Whether `path` is `dir` or inside it, under this platform's rules.
fn starts_with_dir(path: &Path, dir: &Path) -> bool {
    path_is_within(
        &path.to_string_lossy(),
        &dir.to_string_lossy(),
        PathRules::HOST,
    )
}

/// Whether `path` is `dir` or inside it, compared component by component as text
/// under `rules` - pure, so every platform's rules can be tested on any host.
/// Trailing and repeated separators are ignored; `.`/`..` are expected folded
/// already (`lexical`, or a canonical form).
pub(crate) fn path_is_within(path: &str, dir: &str, rules: PathRules) -> bool {
    let (path, dir) = (path_components(path, rules), path_components(dir, rules));
    !dir.is_empty() && path.len() >= dir.len() && path[..dir.len()] == dir[..]
}

/// `path` as the components [`path_is_within`] compares: a leading separator (the
/// root, or a UNC path's `\\`) is a component of its own - and under Windows rules
/// a UNC path's `\\` is a different one from a rooted path's `\` (#576 RV8a-F5):
/// `\\server\share\x` and `\server\share\x` (that folder on the current drive)
/// are different places, which split into the same names otherwise.
fn path_components(path: &str, rules: PathRules) -> Vec<String> {
    let mut text = if rules.windows {
        let text = path.replace('/', "\\");
        if let Some(rest) = text.strip_prefix(r"\\?\UNC\") {
            format!(r"\\{rest}")
        } else if let Some(rest) = text
            .strip_prefix(r"\\?\")
            .or_else(|| text.strip_prefix(r"\\.\"))
        {
            rest.to_owned()
        } else {
            text
        }
    } else {
        path.to_owned()
    };
    if rules.fold_case {
        text = text.to_lowercase();
    }
    let separator = if rules.windows { '\\' } else { '/' };
    let mut parts = Vec::new();
    if rules.windows && text.starts_with(r"\\") {
        parts.push(r"\\".to_owned());
    } else if text.starts_with(separator) {
        parts.push(separator.to_string());
    }
    parts.extend(
        text.split(separator)
            .filter(|part| !part.is_empty() && *part != ".")
            .map(str::to_owned),
    );
    parts
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
        .filter_map(std::env::var_os)
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
