fn main() {
    tauri_build::build();

    // Re-run build script when these env vars change.
    println!("cargo::rerun-if-env-changed=CI");
    println!("cargo::rerun-if-env-changed=TELEMETRY_ENDPOINT");

    // Append "-dev" to the version for local builds (CI env var is not set).
    let pkg_version = std::env::var("CARGO_PKG_VERSION").unwrap();
    let suffix = if std::env::var("CI").is_ok() { "" } else { "-dev" };
    println!("cargo::rustc-env=APP_VERSION={pkg_version}{suffix}");

    // When the telemetry feature is enabled, TELEMETRY_ENDPOINT must be set.
    // This prevents forks from accidentally reporting to our server.
    if std::env::var("CARGO_FEATURE_TELEMETRY").is_ok() {
        let endpoint = std::env::var("TELEMETRY_ENDPOINT")
            .expect("TELEMETRY_ENDPOINT must be set when building with --features telemetry");
        println!("cargo::rustc-env=TELEMETRY_ENDPOINT={endpoint}");
    }
}
