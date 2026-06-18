fn main() {
    tauri_build::build();

    // Re-run build script when these env vars change.
    println!("cargo::rerun-if-env-changed=CI");
    println!("cargo::rerun-if-env-changed=TELEMETRY_ENDPOINT");

    // Embed the exact commit in the version: `x.y.z-<shorthash>` for CI/release
    // builds and `x.y.z-dev-<shorthash>` for local builds (CI env var not set).
    // Falls back to `unknown` when git is unavailable (e.g. a source tarball).
    let pkg_version = std::env::var("CARGO_PKG_VERSION").unwrap();
    let short_hash = git_short_hash();
    let app_version = if std::env::var("CI").is_ok() {
        format!("{pkg_version}-{short_hash}")
    } else {
        format!("{pkg_version}-dev-{short_hash}")
    };
    println!("cargo::rustc-env=APP_VERSION={app_version}");
    // Re-run build.rs when the checked-out commit changes so the hash stays current.
    emit_git_rerun();

    // Windows: let `cargo test` harness binaries start up.
    //
    // tauri_build embeds a Common-Controls v6 manifest into the app exe, but not
    // into `cargo test` harness binaries. Without it the loader binds to the
    // legacy comctl32 v5 (System32), which lacks `TaskDialogIndirect` — pulled in
    // as a static import via rfd / tauri-plugin-dialog — so the test binary
    // aborts at startup with STATUS_ENTRYPOINT_NOT_FOUND (0xC0000139) before any
    // test runs. (We can't just embed the manifest into test binaries: the only
    // link-arg category that reaches the lib unit-test harness is the broad one,
    // which also hits the app bin and collides with tauri's manifest resource.)
    //
    // Instead, delay-load comctl32: `TaskDialogIndirect` then isn't resolved at
    // startup, so the test binary launches. Tests never open a TaskDialog, so the
    // import is never actually called. This adds no manifest resource, so it
    // doesn't conflict with the app bin that `cargo test` also links. Gated behind
    // STALAGMIGHT_TEST_MANIFEST (set by scripts/test.ps1) so normal `cargo build`
    // / `cargo run` and the shipping app are byte-for-byte unchanged.
    #[cfg(windows)]
    {
        println!("cargo::rerun-if-env-changed=STALAGMIGHT_TEST_MANIFEST");
        if std::env::var_os("STALAGMIGHT_TEST_MANIFEST").is_some() {
            println!("cargo::rustc-link-arg=/DELAYLOAD:comctl32.dll");
            // /DELAYLOAD needs the delay-load helper from delayimp.lib.
            println!("cargo::rustc-link-arg=delayimp.lib");
        }
    }

    // When the telemetry feature is enabled, TELEMETRY_ENDPOINT must be set.
    // This prevents forks from accidentally reporting to our server.
    if std::env::var("CARGO_FEATURE_TELEMETRY").is_ok() {
        let endpoint = std::env::var("TELEMETRY_ENDPOINT")
            .expect("TELEMETRY_ENDPOINT must be set when building with --features telemetry");
        println!("cargo::rustc-env=TELEMETRY_ENDPOINT={endpoint}");
    }
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

/// Ask cargo to re-run build.rs when HEAD — or the branch it points to — changes,
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
    // HEAD is normally a symbolic ref (`ref: refs/heads/<branch>`) — also watch that
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
