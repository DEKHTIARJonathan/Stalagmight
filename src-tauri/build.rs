// APP_VERSION derivation and the TELEMETRY_ENDPOINT validation moved to the
// build script of `crates/telemetry` (stalagmight-telemetry) with their only
// consumers; what remains here is app-specific.

fn main() {
    tauri_build::build();

    // Windows: let `cargo test` harness binaries start up.
    //
    // tauri_build embeds a Common-Controls v6 manifest into the app exe, but not
    // into `cargo test` harness binaries. Without it the loader binds to the
    // legacy comctl32 v5 (System32), which lacks `TaskDialogIndirect` - pulled in
    // as a static import via rfd / tauri-plugin-dialog - so the test binary
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
}
