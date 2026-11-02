//! [#576 W4-UNDO] Release-mode timing probes for the undo/import/cache
//! performance fixes. Every probe is `#[ignore]`d: they measure, they do not
//! gate. Run with
//! `cargo test --release --manifest-path src-tauri/crates/core/Cargo.toml --lib perf_probe -- --ignored --nocapture --test-threads=1`.

use std::time::Instant;

use crate::core::state::{AppState, VirtualShotMode};
use crate::core::Command;
use crate::models::{ImportPlacement, ImportSectionConfig, ShotData};

/// A straight-ish synthetic passage of `len` shots.
fn passage(seed: u32, len: usize) -> Vec<ShotData> {
    (0..len)
        .map(|i| ShotData {
            azimuth_in: f64::from((seed * 37 + i as u32 * 11) % 360),
            azimuth_out: f64::from((seed * 37 + i as u32 * 11) % 360),
            length: 3.0 + f64::from((seed + i as u32) % 5),
            depth_in: 10.0,
            depth_out: 10.0,
            ..Default::default()
        })
        .collect()
}

fn section_config(index: u32, shots: Vec<ShotData>) -> ImportSectionConfig {
    ImportSectionConfig {
        section_index: index,
        name: Some(format!("CaveA{index}")),
        surveyor: None,
        date: None,
        color: "#ff0000".to_string(),
        direction: None,
        quality: 1.0,
        shots,
        placement: ImportPlacement::Origin,
        station_comments: Vec::new(),
        reverse: false,
        azimuth_reference: None,
    }
}

/// An open project holding `sections` sections of `shots_per_section` shots.
pub(super) fn synthetic_state(sections: u32, shots_per_section: usize) -> AppState {
    let state = AppState::new().unwrap();
    state.execute(Command::CreateProject {
        name: "Probe".to_string(),
        location: None,
    });
    let configs = (0..sections)
        .map(|i| section_config(i, passage(i, shots_per_section)))
        .collect();
    let result = state.execute_import_sections(
        configs,
        Vec::new(),
        None,
        Vec::new(),
        Vec::new(),
        VirtualShotMode::Auto,
    );
    assert!(result.success, "seed import failed: {:?}", result.error);
    state
}

/// NF-AN6-5: an import whose sections declare no north reference used to
/// clone the whole project once per section to read the project default.
#[test]
#[ignore = "timing probe; run in release with --ignored --nocapture"]
fn import_without_declared_reference_probe() {
    for (sections, shots) in [(200_u32, 100_usize), (750, 100)] {
        let state = synthetic_state(sections, shots);
        let configs: Vec<ImportSectionConfig> = (0..200)
            .map(|i| section_config(i, passage(i + 7, 5)))
            .collect();
        let start = Instant::now();
        let result = state.execute_import_sections(
            configs,
            Vec::new(),
            None,
            Vec::new(),
            Vec::new(),
            VirtualShotMode::Auto,
        );
        let elapsed = start.elapsed();
        assert!(result.success, "{:?}", result.error);
        println!(
            "import 200 x 5-shot sections (no declared reference) into a {}-shot project: {:.1} ms",
            sections as usize * shots,
            elapsed.as_secs_f64() * 1000.0
        );
    }
}
