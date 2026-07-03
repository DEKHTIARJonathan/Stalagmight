//! Harness-only debug hooks. Every command here is inert unless
//! `STALAGMIGHT_TEST_HOOKS=1` is set in the process environment. The agent
//! test harness sets it; normal builds never do, so shipping these commands is
//! a no-op for real users.

/// Trigger a deliberate backend panic on a background thread so the agent
/// harness can self-test its crash oracle ("harness doctor"). The panic is
/// isolated to the spawned thread, so the main app keeps running (runtime is
/// unwind) while the panic hook fires and writes a crash marker. Returns `Err`
/// (a no-op) unless `STALAGMIGHT_TEST_HOOKS=1`.
#[tauri::command]
pub fn debug_trigger_panic(delay_ms: Option<u64>) -> Result<(), String> {
    if std::env::var("STALAGMIGHT_TEST_HOOKS").as_deref() != Ok("1") {
        return Err("test hooks disabled (set STALAGMIGHT_TEST_HOOKS=1)".to_string());
    }
    let delay = delay_ms.unwrap_or(50);
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(delay));
        trigger_test_panic();
    });
    Ok(())
}

/// The deliberate crash, isolated into its own function so the per-site
/// `#[expect(clippy::panic)]` stays tightly scoped. `#[expect]` (not `#[allow]`,
/// which the crate denies) is the sanctioned way to permit a lint at a single
/// justified site; see docs/linting.md.
#[expect(clippy::panic)]
fn trigger_test_panic() -> ! {
    panic!("deliberate harness self-test panic");
}
