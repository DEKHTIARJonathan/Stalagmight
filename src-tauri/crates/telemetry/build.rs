//! Owns the telemetry build-time contract, moved here with the telemetry code:
//! the APP_VERSION embedded in every payload's `app_version` / User-Agent, and
//! the TELEMETRY_ENDPOINT validation that keeps forks from accidentally
//! reporting to our server. The root crate's build script keeps only what is
//! app-specific (tauri_build, the Windows test-harness link workaround).

fn main() -> Result<(), Box<dyn std::error::Error>> {
    // Re-run build script when these env vars change.
    println!("cargo::rerun-if-env-changed=CI");
    println!("cargo::rerun-if-env-changed=GITHUB_REF_TYPE");
    // Both halves matter: the version comes from the tag NAME, so a build that
    // saw a different tag must not serve a cached APP_VERSION.
    println!("cargo::rerun-if-env-changed=GITHUB_REF_NAME");
    println!("cargo::rerun-if-env-changed=TELEMETRY_ENDPOINT");

    // A released build reports its tag: the tag already pins the commit, and a
    // candidate says so (0.5.0-rc1) rather than passing for the final release.
    // Every other build keeps the hash, because that is its only identity -
    // `x.y.z-<shorthash>` for CI builds and `x.y.z-dev-<shorthash>` locally.
    // Mirrors vite.config.ts so the UI's About version and telemetry's
    // app_version agree. Falls back to `unknown` when git is unavailable (e.g. a
    // source tarball).
    let pkg_version = app_pkg_version()?;
    let short_hash = git_short_hash();
    let app_version = if let Some(tag) = release_tag(&pkg_version) {
        tag.trim_start_matches('v').to_string()
    } else if std::env::var("CI").is_ok() {
        format!("{pkg_version}-{short_hash}")
    } else {
        format!("{pkg_version}-dev-{short_hash}")
    };
    println!("cargo::rustc-env=APP_VERSION={app_version}");
    // Re-run build.rs when the checked-out commit changes so the hash stays current.
    emit_git_rerun();

    // When the telemetry feature is enabled, TELEMETRY_ENDPOINT must be set.
    // This prevents forks from accidentally reporting to our server.
    //
    // "Set" has to mean non-empty, not merely present. An undefined GitHub
    // Actions secret expands to the empty string rather than being omitted, so
    // `${{ secrets.TELEMETRY_ENDPOINT }}` on a repo that never had the secret
    // still puts TELEMETRY_ENDPOINT="" in the build environment. A presence-only
    // check passes, `ENDPOINT_URL` becomes "", and the release ships telemetry
    // that posts to nowhere - with nothing anywhere reporting a problem. Requiring
    // a scheme as well keeps a hostname pasted in without one from failing the
    // same silent way, at the one point where it is still cheap to catch.
    if std::env::var("CARGO_FEATURE_TELEMETRY").is_ok() {
        let endpoint = std::env::var("TELEMETRY_ENDPOINT").map_err(|_| {
            "TELEMETRY_ENDPOINT must be set when building with --features telemetry"
        })?;
        let endpoint = endpoint.trim();
        if endpoint.is_empty() {
            return Err(
                "TELEMETRY_ENDPOINT is empty or whitespace-only when building \
                 with --features telemetry (an undefined CI secret expands to \"\") - \
                 set it to the full events URL"
                    .into(),
            );
        }
        // Schemes are case-insensitive per RFC 3986, and `HTTPS://host/path` is a
        // legal URL - rejecting it with "must include the scheme" would be telling
        // the developer their scheme is missing while they are looking at it.
        let scheme = endpoint.to_ascii_lowercase();
        if !scheme.starts_with("https://") && !scheme.starts_with("http://") {
            return Err(format!(
                "TELEMETRY_ENDPOINT must start with http:// or https://, got {endpoint:?}"
            )
            .into());
        }
        // `trim` clears surrounding whitespace but not an interior newline, and
        // the value is about to be interpolated into a cargo directive that is
        // parsed one line at a time - so a newline in it would emit a second
        // directive of the attacker's choosing. Weak threat model (setting the
        // variable already means controlling the build), but the check is one
        // line and the failure would be silent.
        if endpoint.contains(['\n', '\r']) {
            return Err("TELEMETRY_ENDPOINT must be a single line".into());
        }
        println!("cargo::rustc-env=TELEMETRY_ENDPOINT={endpoint}");
    }

    Ok(())
}

/// The application's version, read from the root package manifest two levels
/// up. Workspace member crates are versioned 0.0.0 on purpose, so this crate's
/// own CARGO_PKG_VERSION is useless here - APP_VERSION must carry the version
/// the app releases under (scripts/release.sh asserts on that manifest line).
fn app_pkg_version() -> Result<String, Box<dyn std::error::Error>> {
    let manifest_dir = std::env::var("CARGO_MANIFEST_DIR")?;
    let root_manifest = std::path::Path::new(&manifest_dir).join("../../Cargo.toml");
    // A root version bump must re-derive APP_VERSION.
    println!("cargo::rerun-if-changed=../../Cargo.toml");
    let contents = std::fs::read_to_string(&root_manifest)?;
    contents
        .lines()
        // First bare `version = "..."` line: the root [package] table. The
        // deliberate absence of a [workspace.package] version (see the root
        // manifest) keeps this unambiguous; dependency `{ version = ... }`
        // entries never start the line with `version`.
        .find_map(|line| line.strip_prefix("version = \""))
        .and_then(|rest| rest.split('"').next())
        .map(str::to_string)
        .ok_or_else(|| format!("no `version = \"...\"` line in {}", root_manifest.display()).into())
}

/// The release tag on the checked-out commit, or `None`.
///
/// Must match `pkg_version` - `v0.5.0` or a candidate for it like `v0.5.0-rc1` -
/// so an unrelated tag sitting on the same commit cannot rename the build. In
/// Actions on a tag push `GITHUB_REF_TYPE` is authoritative and needs no git
/// state; otherwise ask git, so a release built by hand identifies itself the
/// same way. Anything unreadable yields `None`, which only means the build keeps
/// its commit hash - the safe direction.
fn release_tag(pkg_version: &str) -> Option<String> {
    let exact = format!("v{pkg_version}");
    let candidate_prefix = format!("v{pkg_version}-");
    let matches = |t: &str| t == exact || t.starts_with(&candidate_prefix);

    if std::env::var("GITHUB_REF_TYPE").as_deref() == Ok("tag") {
        let name = std::env::var("GITHUB_REF_NAME").unwrap_or_default();
        return matches(&name).then_some(name);
    }
    std::process::Command::new("git")
        .args(["tag", "--points-at", "HEAD"])
        .output()
        .ok()
        .filter(|out| out.status.success())
        .and_then(|out| String::from_utf8(out.stdout).ok())
        .and_then(|tags| {
            tags.lines()
                .map(str::trim)
                .find(|t| matches(t))
                .map(str::to_string)
        })
}

/// Short hash of the checked-out commit, or `unknown` when git is unavailable
/// (e.g. building from a source tarball with no `.git`).
fn git_short_hash() -> String {
    std::process::Command::new("git")
        .args(["rev-parse", "--short", "HEAD"])
        .output()
        .ok()
        .filter(|out| out.status.success())
        .and_then(|out| String::from_utf8(out.stdout).ok())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "unknown".to_string())
}

/// Ask cargo to re-run build.rs when HEAD - or the branch it points to - changes,
/// so `APP_VERSION`'s embedded hash tracks the checked-out commit instead of going
/// stale across commits. Best-effort: emits nothing when git/`.git` is unavailable.
fn emit_git_rerun() {
    let Some(git_dir) = std::process::Command::new("git")
        .args(["rev-parse", "--absolute-git-dir"])
        .output()
        .ok()
        .filter(|out| out.status.success())
        .and_then(|out| String::from_utf8(out.stdout).ok())
        .map(|s| std::path::PathBuf::from(s.trim()))
    else {
        return;
    };
    let head = git_dir.join("HEAD");
    if !head.exists() {
        return;
    }
    println!("cargo::rerun-if-changed={}", head.display());
    // HEAD is normally a symbolic ref (`ref: refs/heads/<branch>`) - also watch that
    // ref file so a new commit on the current branch retriggers the build.
    if let Ok(contents) = std::fs::read_to_string(&head) {
        if let Some(reference) = contents.strip_prefix("ref: ") {
            println!(
                "cargo::rerun-if-changed={}",
                git_dir.join(reference.trim()).display()
            );
        }
    }
}
