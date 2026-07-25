# Run the Rust test suite on Windows (PowerShell).
#
# Sets STALAGMIGHT_TEST_MANIFEST so `cargo test` harness binaries delay-load
# comctl32 (see src-tauri/build.rs). Without it those binaries abort at startup
# with STATUS_ENTRYPOINT_NOT_FOUND (0xC0000139) - the loader binds to comctl32
# v5, which lacks TaskDialogIndirect (imported via rfd / tauri-plugin-dialog),
# and no test gets to run. Mirrors the CI command (telemetry feature + endpoint).
#
# Extra args are forwarded to cargo, e.g.:  ./scripts/test.ps1 save_project
$ErrorActionPreference = 'Stop'

$env:STALAGMIGHT_TEST_MANIFEST = '1'
if (-not $env:TELEMETRY_ENDPOINT) { $env:TELEMETRY_ENDPOINT = 'http://localhost/dummy' }

cargo test --manifest-path src-tauri/Cargo.toml --features telemetry @args
