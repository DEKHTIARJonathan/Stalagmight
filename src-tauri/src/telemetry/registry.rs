//! String-to-numeric ID registries for packed telemetry payloads.
//!
//! Keep in sync with `telemetry-worker/src/registry.ts`.

use std::collections::HashMap;
use std::sync::OnceLock;

/// Source names indexed by ID. Index = source_id (u8).
pub(super) const SOURCE_NAMES: &[&str] = &[
    "",              // 0: no source suffix present
    "keyboard",      // 1
    "toolbar",       // 2
    "map",           // 3
    "data-table",    // 4
    "sections-panel", // 5
    "detail-panel",  // 6
    "display-menu",  // 7
    "context-menu",  // 8
    "dialog",        // 9
    "unknown",       // 10
    "mouse",         // 11
    "touch",         // 12
    "dblclick",      // 13
];

/// Event base names indexed by ID. Index = event_id (u16).
/// Keep in sync with `telemetry-worker/src/registry.ts`.
pub(super) const EVENT_NAMES: &[&str] = &[
    // ── Commands (0-92) ──
    "command.adjust_loop_closures",
    "command.attempt_repair",
    "command.calculate_file_hash",
    "command.can_redo",
    "command.can_undo",
    "command.cancel_loading",
    "command.check_duplicate_import",
    "command.check_merge_connectivity",
    "command.check_section_hashes",
    "command.clear_tile_cache",
    "command.close_project",
    "command.create_loop_closure",
    "command.create_project",
    "command.create_project_full",
    "command.create_section",
    "command.create_section_and_merge",
    "command.create_shot",
    "command.delete_last_shot_and_section",
    "command.delete_section",
    "command.delete_shot",
    "command.delete_shot_and_split",
    "command.execute_batch",
    "command.execute_gpx_import",
    "command.execute_tml_import",
    "command.export_csv",
    "command.export_image",
    "command.export_json",
    "command.export_salvageable_data",
    "command.export_tml",
    "command.fetch_tile",
    "command.get_anchored_section_ids",
    "command.get_cache_stats",
    "command.get_config",
    "command.get_connected_section_ids",
    "command.get_depth_preset_colors",
    "command.get_display_setting",
    "command.get_network_status",
    "command.get_project_state",
    "command.get_project_warnings",
    "command.get_recent_logs",
    "command.get_redo_stack",
    "command.get_rigid_connected_section_ids",
    "command.get_section",
    "command.get_section_relationships",
    "command.get_segment_geometry",
    "command.get_survey_geometry",
    "command.get_survey_geometry_for_file",
    "command.get_tile_fetch_stats",
    "command.get_tile_providers",
    "command.get_undo_stack",
    "command.import_dmp",
    "command.import_sections",
    "command.list_backups",
    "command.list_recent_projects",
    "command.load_display_settings",
    "command.load_project_full",
    "command.merge_projects",
    "command.merge_stations",
    "command.move_comment",
    "command.move_section",
    "command.move_segment",
    "command.move_station",
    "command.open_project",
    "command.parse_gpx",
    "command.parse_tml",
    "command.preview_delete_shot",
    "command.push_frontend_log",
    "command.redo",
    "command.redo_to",
    "command.reload_config",
    "command.remove_from_recent_projects",
    "command.remove_loop_closure",
    "command.remove_zero_datum",
    "command.resolve_all_warnings",
    "command.resolve_warning",
    "command.restore_from_backup",
    "command.save_display_setting",
    "command.save_project",
    "command.set_shot_reference",
    "command.set_station_comment",
    "command.set_zero_datum",
    "command.suggest_all_import_placements",
    "command.suggest_import_placement",
    "command.suggest_orphan_placements",
    "command.undo",
    "command.undo_to",
    "command.unmerge_station_pair",
    "command.unmerge_stations",
    "command.unresolve_warning",
    "command.update_config",
    "command.update_panel_sizes",
    "command.update_section",
    "command.update_shot",
    // ── Action: tools (93-104) ──
    "action.tool.comment",
    "action.tool.delete",
    "action.tool.draw",
    "action.tool.measure",
    "action.tool.merge",
    "action.tool.move_comment",
    "action.tool.move_segment",
    "action.tool.move_shot",
    "action.tool.move_station",
    "action.tool.pan",
    "action.tool.select",
    "action.tool.zoom",
    // ── Action: navigation (105-113) ──
    "action.nav.center-on-shot",
    "action.nav.center-on-station",
    "action.nav.fit-to-bounds",
    "action.nav.pan",
    "action.nav.pan-to-shot",
    "action.nav.zoom",
    "action.nav.zoom-in",
    "action.nav.zoom-out",
    "action.nav.zoom-to-section",
    // ── Action: display toggles (114-128) ──
    "action.toggle.gridSpacing",
    "action.toggle.showDepthGradient",
    "action.toggle.showDevStats",
    "action.toggle.showGrid",
    "action.toggle.showReferenceShots",
    "action.toggle.showScaleBar",
    "action.toggle.showSatellite",
    "action.toggle.showSectionNames",
    "action.toggle.showShotComments",
    "action.toggle.showShotData",
    "action.toggle.showShots",
    "action.toggle.showStationComments",
    "action.toggle.showStationLabels",
    "action.toggle.showStations",
    "action.toggle.showZeroDatum",
    // ── Action: selection (129-133) ──
    "action.select.section",
    "action.select.shot",
    "action.select.station",
    "action.select-add.shot",
    "action.select-add.station",
    // ── Action: dialogs (134-167) ──
    "action.dialog.adjust-closures",
    "action.dialog.closure",
    "action.dialog.confirm-delete",
    "action.dialog.confirm-overwrite",
    "action.dialog.context-menu",
    "action.dialog.corruption-recovery",
    "action.dialog.debug",
    "action.dialog.dmp-import-new",
    "action.dialog.dmp-selection",
    "action.dialog.draw-shot",
    "action.dialog.edit-section",
    "action.dialog.edit-shot",
    "action.dialog.edit-station",
    "action.dialog.error",
    "action.dialog.export",
    "action.dialog.gpx-placement",
    "action.dialog.gpx-selection",
    "action.dialog.import",
    "action.dialog.keyboard-shortcuts",
    "action.dialog.merge",
    "action.dialog.merge-projects",
    "action.dialog.new-project",
    "action.dialog.new-project-for-import",
    "action.dialog.orphan-placement",
    "action.dialog.remove-closure",
    "action.dialog.section-adjust",
    "action.dialog.settings",
    "action.dialog.split-section",
    "action.dialog.swap-comments",
    "action.dialog.tml-import",
    "action.dialog.unmerge-stations",
    "action.dialog.unsaved-changes",
    "action.dialog.zero-datum-config",
    "action.dialog.zero-datum-selection",
    // ── Action: panels (168-173) ──
    "action.panel-close.data-table",
    "action.panel-close.detail",
    "action.panel-close.sections",
    "action.panel-open.data-table",
    "action.panel-open.detail",
    "action.panel-open.sections",
    // ── Action: context menu (174-176) ──
    "action.remove-closure",
    "action.toggle-reference",
    "action.unmerge",
    // ── Dialog cancellations (177-210) ──
    "dialog-cancel.adjust-closures",
    "dialog-cancel.closure",
    "dialog-cancel.confirm-delete",
    "dialog-cancel.confirm-overwrite",
    "dialog-cancel.context-menu",
    "dialog-cancel.corruption-recovery",
    "dialog-cancel.debug",
    "dialog-cancel.dmp-import-new",
    "dialog-cancel.dmp-selection",
    "dialog-cancel.draw-shot",
    "dialog-cancel.edit-section",
    "dialog-cancel.edit-shot",
    "dialog-cancel.edit-station",
    "dialog-cancel.error",
    "dialog-cancel.export",
    "dialog-cancel.gpx-placement",
    "dialog-cancel.gpx-selection",
    "dialog-cancel.import",
    "dialog-cancel.keyboard-shortcuts",
    "dialog-cancel.merge",
    "dialog-cancel.merge-projects",
    "dialog-cancel.new-project",
    "dialog-cancel.new-project-for-import",
    "dialog-cancel.orphan-placement",
    "dialog-cancel.remove-closure",
    "dialog-cancel.section-adjust",
    "dialog-cancel.settings",
    "dialog-cancel.split-section",
    "dialog-cancel.swap-comments",
    "dialog-cancel.tml-import",
    "dialog-cancel.unmerge-stations",
    "dialog-cancel.unsaved-changes",
    "dialog-cancel.zero-datum-config",
    "dialog-cancel.zero-datum-selection",
    // ── Undo regret (211-237) ──
    "undo-after.adjust_loop_closures",
    "undo-after.create_loop_closure",
    "undo-after.create_section",
    "undo-after.create_section_and_merge",
    "undo-after.create_shot",
    "undo-after.delete_last_shot_and_section",
    "undo-after.delete_section",
    "undo-after.delete_shot",
    "undo-after.delete_shot_and_split",
    "undo-after.execute_batch",
    "undo-after.execute_gpx_import",
    "undo-after.execute_tml_import",
    "undo-after.import_sections",
    "undo-after.merge_stations",
    "undo-after.move_comment",
    "undo-after.move_section",
    "undo-after.move_segment",
    "undo-after.move_station",
    "undo-after.remove_loop_closure",
    "undo-after.remove_zero_datum",
    "undo-after.set_shot_reference",
    "undo-after.set_station_comment",
    "undo-after.set_zero_datum",
    "undo-after.unmerge_station_pair",
    "undo-after.unmerge_stations",
    "undo-after.update_section",
    "undo-after.update_shot",
    // ── Dwell: tools (238-249) ──
    "dwell.tool.comment",
    "dwell.tool.delete",
    "dwell.tool.draw",
    "dwell.tool.measure",
    "dwell.tool.merge",
    "dwell.tool.move_comment",
    "dwell.tool.move_segment",
    "dwell.tool.move_shot",
    "dwell.tool.move_station",
    "dwell.tool.pan",
    "dwell.tool.select",
    "dwell.tool.zoom",
    // ── Dwell: dialogs (250-283) ──
    "dwell.dialog.adjust-closures",
    "dwell.dialog.closure",
    "dwell.dialog.confirm-delete",
    "dwell.dialog.confirm-overwrite",
    "dwell.dialog.context-menu",
    "dwell.dialog.corruption-recovery",
    "dwell.dialog.debug",
    "dwell.dialog.dmp-import-new",
    "dwell.dialog.dmp-selection",
    "dwell.dialog.draw-shot",
    "dwell.dialog.edit-section",
    "dwell.dialog.edit-shot",
    "dwell.dialog.edit-station",
    "dwell.dialog.error",
    "dwell.dialog.export",
    "dwell.dialog.gpx-placement",
    "dwell.dialog.gpx-selection",
    "dwell.dialog.import",
    "dwell.dialog.keyboard-shortcuts",
    "dwell.dialog.merge",
    "dwell.dialog.merge-projects",
    "dwell.dialog.new-project",
    "dwell.dialog.new-project-for-import",
    "dwell.dialog.orphan-placement",
    "dwell.dialog.remove-closure",
    "dwell.dialog.section-adjust",
    "dwell.dialog.settings",
    "dwell.dialog.split-section",
    "dwell.dialog.swap-comments",
    "dwell.dialog.tml-import",
    "dwell.dialog.unmerge-stations",
    "dwell.dialog.unsaved-changes",
    "dwell.dialog.zero-datum-config",
    "dwell.dialog.zero-datum-selection",
    // ── Dwell: other (284-285) ──
    "dwell.global-view",
    "dwell.placement",
    // ── Appended after v2 baseline (286+) ──
    "command.track_imported_file",
    "action.dialog.delete-shot-choice",
    "dialog-cancel.delete-shot-choice",
    "dwell.dialog.delete-shot-choice",
    "action.select-add.section",
];

/// Lazy source name → source_id map (excludes empty string at index 0).
pub(super) fn source_map() -> &'static HashMap<&'static str, u8> {
    static MAP: OnceLock<HashMap<&str, u8>> = OnceLock::new();
    MAP.get_or_init(|| {
        SOURCE_NAMES
            .iter()
            .enumerate()
            .filter(|(_, name)| !name.is_empty())
            .map(|(i, &name)| (name, i as u8))
            .collect()
    })
}

/// Lazy event name → event_id map.
pub(super) fn event_map() -> &'static HashMap<&'static str, u16> {
    static MAP: OnceLock<HashMap<&str, u16>> = OnceLock::new();
    MAP.get_or_init(|| {
        EVENT_NAMES
            .iter()
            .enumerate()
            .map(|(i, &name)| (name, i as u16))
            .collect()
    })
}

/// Split an event key on the last `:`. If the suffix is a known source,
/// returns `(base, source_id)`. Otherwise returns `(full_key, 0)`.
///
/// This correctly handles keys like `display-state.showGrid:true` where
/// `:true` is not a known source — the whole string becomes the event name.
pub(super) fn split_event_key(key: &str) -> (&str, u8) {
    if let Some(colon_pos) = key.rfind(':') {
        let suffix = &key[colon_pos + 1..];
        if let Some(&source_id) = source_map().get(suffix) {
            return (&key[..colon_pos], source_id);
        }
    }
    (key, 0)
}

#[cfg(test)]
#[expect(clippy::unwrap_used)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    #[test]
    fn no_duplicate_event_names() {
        let mut seen = HashSet::new();
        for (i, &name) in EVENT_NAMES.iter().enumerate() {
            assert!(
                seen.insert(name),
                "Duplicate event name at index {i}: {name}"
            );
        }
    }

    #[test]
    fn no_duplicate_source_names() {
        let mut seen = HashSet::new();
        for (i, &name) in SOURCE_NAMES.iter().enumerate() {
            if name.is_empty() {
                continue;
            }
            assert!(
                seen.insert(name),
                "Duplicate source name at index {i}: {name}"
            );
        }
    }

    #[test]
    fn split_known_source() {
        let (base, sid) = split_event_key("command.create_shot:keyboard");
        assert_eq!(base, "command.create_shot");
        assert_eq!(sid, 1);
    }

    #[test]
    fn split_unknown_suffix() {
        let (base, sid) = split_event_key("display-state.showGrid:true");
        assert_eq!(base, "display-state.showGrid:true");
        assert_eq!(sid, 0);
    }

    #[test]
    fn split_no_colon() {
        let (base, sid) = split_event_key("command.save_project");
        assert_eq!(base, "command.save_project");
        assert_eq!(sid, 0);
    }

    #[test]
    fn split_unknown_source_literal() {
        let (base, sid) = split_event_key("action.dialog.import:unknown");
        assert_eq!(base, "action.dialog.import");
        assert_eq!(sid, 10);
    }

    #[test]
    fn event_map_lookup() {
        let map = event_map();
        assert_eq!(map.get("command.adjust_loop_closures"), Some(&0));
        assert_eq!(map.get("command.update_shot"), Some(&92));
        assert_eq!(map.get("action.tool.select"), Some(&103));
        assert_eq!(map.get("dwell.placement"), Some(&285));
        assert_eq!(map.get("nonexistent.event"), None);
    }

    #[test]
    fn source_map_lookup() {
        let map = source_map();
        assert_eq!(map.get("keyboard"), Some(&1));
        assert_eq!(map.get("dblclick"), Some(&13));
        assert_eq!(map.get(""), None); // empty string excluded
        assert_eq!(map.get("nonexistent"), None);
    }

    #[test]
    fn event_count() {
        assert_eq!(EVENT_NAMES.len(), 291);
    }

    #[test]
    fn source_count() {
        assert_eq!(SOURCE_NAMES.len(), 14);
    }

    /// FNV-1a hash for deterministic, portable snapshots.
    fn fnv1a(data: &[u8]) -> u64 {
        let mut hash: u64 = 0xcbf29ce484222325;
        for &byte in data {
            hash ^= byte as u64;
            hash = hash.wrapping_mul(0x100000001b3);
        }
        hash
    }

    /// Frozen entry count for the current packed payload version (v2).
    /// The first V2_FROZEN_EVENTS entries must never change — their indices
    /// are baked into payloads already sent by older clients.
    ///
    /// New entries MUST be appended after this watermark. When a registry
    /// reorganization is needed (sort, remove, insert), bump
    /// `PACKED_PAYLOAD_VERSION` to v3, update the watermark and hashes,
    /// and keep the v2 lookup table in the worker until most users upgrade.
    const V2_FROZEN_EVENTS: usize = 286;
    const V2_FROZEN_SOURCES: usize = 14;

    #[test]
    fn registry_id_stability() {
        // Assert the frozen portion hasn't been mutated.
        assert!(
            EVENT_NAMES.len() >= V2_FROZEN_EVENTS,
            "EVENT_NAMES shrunk below v2 frozen watermark ({} < {V2_FROZEN_EVENTS})",
            EVENT_NAMES.len(),
        );
        assert!(
            SOURCE_NAMES.len() >= V2_FROZEN_SOURCES,
            "SOURCE_NAMES shrunk below v2 frozen watermark ({} < {V2_FROZEN_SOURCES})",
            SOURCE_NAMES.len(),
        );

        let event_hash = fnv1a(EVENT_NAMES[..V2_FROZEN_EVENTS].join("\n").as_bytes());
        let source_hash = fnv1a(SOURCE_NAMES[..V2_FROZEN_SOURCES].join("\n").as_bytes());

        assert_eq!(
            event_hash, 0xd8c5eaa036bd1155,
            "EVENT_NAMES v2 snapshot changed! The first {V2_FROZEN_EVENTS} entries are \
             frozen — their numeric IDs are baked into payloads from older clients. \
             Append new entries at the end instead. If a reorganization is intentional, \
             bump PACKED_PAYLOAD_VERSION and update V2_FROZEN_EVENTS / hash."
        );
        assert_eq!(
            source_hash, 0x17b26a8e3506beea,
            "SOURCE_NAMES v2 snapshot changed! The first {V2_FROZEN_SOURCES} entries are \
             frozen. Append new sources at the end instead, or bump PACKED_PAYLOAD_VERSION."
        );
    }

    /// Commands registered in `generate_handler![]` that are excluded from
    /// the `command.*` exhaustiveness check (they are telemetry internals).
    const TELEMETRY_COMMANDS: &[&str] = &[
        "track_events",
        "flush_telemetry",
        "is_telemetry_available",
        "set_telemetry_enabled",
    ];

    #[test]
    fn registry_covers_all_commands() {
        let manifest_dir = env!("CARGO_MANIFEST_DIR");
        let lib_path = format!("{manifest_dir}/src/lib.rs");
        let lib_src = std::fs::read_to_string(&lib_path)
            .unwrap_or_else(|e| panic!("Failed to read {lib_path}: {e}"));

        // Extract the generate_handler![...] block
        let start = lib_src
            .find("generate_handler![")
            .expect("generate_handler![ not found in lib.rs")
            + "generate_handler![".len();
        let end = start
            + lib_src[start..]
                .find(']')
                .expect("closing ] not found for generate_handler!");
        let block = &lib_src[start..end];

        // Parse command names from each line
        let mut handler_commands: HashSet<String> = HashSet::new();
        for line in block.lines() {
            let trimmed = line.trim();
            // Skip empty lines and comments
            if trimmed.is_empty() || trimmed.starts_with("//") {
                continue;
            }
            // Extract the last :: segment, e.g. "commands::project::create_project,"
            let name = trimmed
                .rsplit("::")
                .next()
                .unwrap()
                .trim_end_matches(',')
                .trim();
            if !TELEMETRY_COMMANDS.contains(&name) {
                handler_commands.insert(format!("command.{name}"));
            }
        }

        // Build set of command.* entries from EVENT_NAMES
        let registry_commands: HashSet<String> = EVENT_NAMES
            .iter()
            .filter(|n| n.starts_with("command."))
            .map(|n| n.to_string())
            .collect();

        let missing: Vec<_> = handler_commands.difference(&registry_commands).collect();
        let stale: Vec<_> = registry_commands.difference(&handler_commands).collect();

        assert!(
            missing.is_empty() && stale.is_empty(),
            "EVENT_NAMES command.* entries out of sync with generate_handler![]:\n  \
             Missing from registry: {missing:?}\n  \
             Stale in registry: {stale:?}"
        );
    }

    #[test]
    fn rust_ts_registry_in_sync() {
        let manifest_dir = env!("CARGO_MANIFEST_DIR");
        let ts_path = format!("{manifest_dir}/../telemetry-worker/src/registry.ts");
        let ts_src = std::fs::read_to_string(&ts_path)
            .unwrap_or_else(|e| panic!("Failed to read {ts_path}: {e}"));

        /// Extract single-quoted strings from lines between array open/close.
        fn extract_array(src: &str, array_name: &str) -> Vec<String> {
            let marker = format!("{array_name}:");
            let mut inside = false;
            let mut items = Vec::new();
            for line in src.lines() {
                let trimmed = line.trim();
                if !inside {
                    if trimmed.contains(&marker) && trimmed.contains('[') {
                        inside = true;
                    }
                    continue;
                }
                if trimmed == "];" || trimmed == "]" {
                    break;
                }
                // Extract single-quoted string from lines like:  'keyboard',  // 1
                if let Some(start) = trimmed.find('\'') {
                    if let Some(end) = trimmed[start + 1..].find('\'') {
                        items.push(trimmed[start + 1..start + 1 + end].to_string());
                    }
                }
            }
            items
        }

        let ts_sources = extract_array(&ts_src, "SOURCE_NAMES");
        let ts_events = extract_array(&ts_src, "EVENT_NAMES");

        // Compare element-by-element for exact order
        assert_eq!(
            SOURCE_NAMES.len(),
            ts_sources.len(),
            "SOURCE_NAMES length mismatch: Rust={} TS={}",
            SOURCE_NAMES.len(),
            ts_sources.len(),
        );
        for (i, (rust, ts)) in SOURCE_NAMES.iter().zip(ts_sources.iter()).enumerate() {
            assert_eq!(
                rust, ts,
                "SOURCE_NAMES mismatch at index {i}: Rust={rust:?} TS={ts:?}"
            );
        }

        assert_eq!(
            EVENT_NAMES.len(),
            ts_events.len(),
            "EVENT_NAMES length mismatch: Rust={} TS={}",
            EVENT_NAMES.len(),
            ts_events.len(),
        );
        for (i, (rust, ts)) in EVENT_NAMES.iter().zip(ts_events.iter()).enumerate() {
            assert_eq!(
                rust, ts,
                "EVENT_NAMES mismatch at index {i}: Rust={rust:?} TS={ts:?}"
            );
        }
    }

    /// Helper: read a frontend source file relative to the project root.
    fn read_frontend_file(rel_path: &str) -> String {
        let manifest_dir = env!("CARGO_MANIFEST_DIR");
        let path = format!("{manifest_dir}/../{rel_path}");
        std::fs::read_to_string(&path)
            .unwrap_or_else(|e| panic!("Failed to read {path}: {e}"))
    }

    #[test]
    fn registry_covers_all_tools() {
        let src = read_frontend_file("src/store/uiStore.ts");

        // Extract ToolType union members
        let start = src
            .find("type ToolType =")
            .expect("ToolType not found in uiStore.ts");
        let block = &src[start..];
        let mut tools: HashSet<String> = HashSet::new();
        for line in block.lines().skip(1) {
            let trimmed = line.trim();
            if !trimmed.starts_with('|') {
                break;
            }
            if let Some(q1) = trimmed.find('\'') {
                if let Some(q2) = trimmed[q1 + 1..].find('\'') {
                    tools.insert(trimmed[q1 + 1..q1 + 1 + q2].to_string());
                }
            }
        }
        assert!(!tools.is_empty(), "Failed to parse any ToolType variants");

        let code_action: HashSet<String> =
            tools.iter().map(|t| format!("action.tool.{t}")).collect();
        let code_dwell: HashSet<String> =
            tools.iter().map(|t| format!("dwell.tool.{t}")).collect();

        let reg_action: HashSet<String> = EVENT_NAMES
            .iter()
            .filter(|n| n.starts_with("action.tool."))
            .map(|n| n.to_string())
            .collect();
        let reg_dwell: HashSet<String> = EVENT_NAMES
            .iter()
            .filter(|n| n.starts_with("dwell.tool."))
            .map(|n| n.to_string())
            .collect();

        let missing_action: Vec<_> = code_action.difference(&reg_action).collect();
        let stale_action: Vec<_> = reg_action.difference(&code_action).collect();
        let missing_dwell: Vec<_> = code_dwell.difference(&reg_dwell).collect();
        let stale_dwell: Vec<_> = reg_dwell.difference(&code_dwell).collect();

        assert!(
            missing_action.is_empty()
                && stale_action.is_empty()
                && missing_dwell.is_empty()
                && stale_dwell.is_empty(),
            "Tool registry out of sync with ToolType:\n  \
             Missing action.tool.*: {missing_action:?}\n  \
             Stale action.tool.*: {stale_action:?}\n  \
             Missing dwell.tool.*: {missing_dwell:?}\n  \
             Stale dwell.tool.*: {stale_dwell:?}"
        );
    }

    #[test]
    fn registry_covers_all_undoable_commands() {
        let src = read_frontend_file("src/utils/telemetry.ts");

        // Extract UNDOABLE_COMMANDS set members
        let start = src
            .find("UNDOABLE_COMMANDS")
            .expect("UNDOABLE_COMMANDS not found");
        let bracket = src[start..]
            .find('[')
            .expect("[ not found after UNDOABLE_COMMANDS");
        let end_bracket = src[start + bracket..]
            .find(']')
            .expect("] not found after UNDOABLE_COMMANDS [");
        let block = &src[start + bracket..start + bracket + end_bracket];

        let mut commands: HashSet<String> = HashSet::new();
        for cap in block.split('\'').collect::<Vec<_>>().chunks(2) {
            if cap.len() == 2 && !cap[1].is_empty() {
                // cap[1] is the string between quotes
                commands.insert(cap[1].to_string());
            }
        }
        // Better approach: extract all single-quoted strings
        let mut commands2: HashSet<String> = HashSet::new();
        let mut chars = block.chars().peekable();
        while let Some(c) = chars.next() {
            if c == '\'' {
                let s: String = chars.by_ref().take_while(|&ch| ch != '\'').collect();
                if !s.is_empty() {
                    commands2.insert(s);
                }
            }
        }
        let commands = commands2;
        assert!(
            !commands.is_empty(),
            "Failed to parse any UNDOABLE_COMMANDS"
        );

        let code_undo: HashSet<String> = commands
            .iter()
            .map(|c| format!("undo-after.{c}"))
            .collect();

        let reg_undo: HashSet<String> = EVENT_NAMES
            .iter()
            .filter(|n| n.starts_with("undo-after."))
            .map(|n| n.to_string())
            .collect();

        let missing: Vec<_> = code_undo.difference(&reg_undo).collect();
        let stale: Vec<_> = reg_undo.difference(&code_undo).collect();

        assert!(
            missing.is_empty() && stale.is_empty(),
            "undo-after.* registry out of sync with UNDOABLE_COMMANDS:\n  \
             Missing: {missing:?}\n  \
             Stale: {stale:?}"
        );
    }

    #[test]
    fn registry_covers_all_display_toggles() {
        let src = read_frontend_file("src/store/displaySelectors.ts");

        // Extract DISPLAY_DEFAULTS keys
        let start = src
            .find("DISPLAY_DEFAULTS = {")
            .expect("DISPLAY_DEFAULTS not found");
        let brace = start + "DISPLAY_DEFAULTS = {".len();
        let end_brace = src[brace..]
            .find('}')
            .expect("} not found after DISPLAY_DEFAULTS");
        let block = &src[brace..brace + end_brace];

        let mut keys: HashSet<String> = HashSet::new();
        for line in block.lines() {
            let trimmed = line.trim();
            if let Some(colon_pos) = trimmed.find(':') {
                let key = trimmed[..colon_pos].trim();
                if !key.is_empty() && !key.starts_with("//") {
                    keys.insert(key.to_string());
                }
            }
        }
        assert!(!keys.is_empty(), "Failed to parse any DISPLAY_DEFAULTS keys");

        let code_toggles: HashSet<String> = keys
            .iter()
            .map(|k| format!("action.toggle.{k}"))
            .collect();

        let reg_toggles: HashSet<String> = EVENT_NAMES
            .iter()
            .filter(|n| n.starts_with("action.toggle."))
            .map(|n| n.to_string())
            .collect();

        let missing: Vec<_> = code_toggles.difference(&reg_toggles).collect();
        let stale: Vec<_> = reg_toggles.difference(&code_toggles).collect();

        assert!(
            missing.is_empty() && stale.is_empty(),
            "action.toggle.* registry out of sync with DISPLAY_DEFAULTS:\n  \
             Missing: {missing:?}\n  \
             Stale: {stale:?}"
        );
    }

    #[test]
    fn registry_covers_all_dialogs() {
        let src = read_frontend_file("src/App.tsx");

        // Extract all activeDialog === '...' patterns
        let re_pattern = "activeDialog === '";
        let mut dialogs: HashSet<String> = HashSet::new();
        for line in src.lines() {
            let mut search = line;
            while let Some(pos) = search.find(re_pattern) {
                let after = &search[pos + re_pattern.len()..];
                if let Some(end) = after.find('\'') {
                    dialogs.insert(after[..end].to_string());
                }
                search = &search[pos + re_pattern.len()..];
            }
        }
        assert!(!dialogs.is_empty(), "Failed to parse any dialogs from App.tsx");

        // Build expected sets
        let code_action: HashSet<String> = dialogs
            .iter()
            .map(|d| format!("action.dialog.{d}"))
            .collect();
        let code_cancel: HashSet<String> = dialogs
            .iter()
            .map(|d| format!("dialog-cancel.{d}"))
            .collect();
        let code_dwell: HashSet<String> = dialogs
            .iter()
            .map(|d| format!("dwell.dialog.{d}"))
            .collect();

        let reg_action: HashSet<String> = EVENT_NAMES
            .iter()
            .filter(|n| n.starts_with("action.dialog."))
            .map(|n| n.to_string())
            .collect();
        let reg_cancel: HashSet<String> = EVENT_NAMES
            .iter()
            .filter(|n| n.starts_with("dialog-cancel."))
            .map(|n| n.to_string())
            .collect();
        let reg_dwell: HashSet<String> = EVENT_NAMES
            .iter()
            .filter(|n| n.starts_with("dwell.dialog."))
            .map(|n| n.to_string())
            .collect();

        let missing_action: Vec<_> = code_action.difference(&reg_action).collect();
        let stale_action: Vec<_> = reg_action.difference(&code_action).collect();
        let missing_cancel: Vec<_> = code_cancel.difference(&reg_cancel).collect();
        let stale_cancel: Vec<_> = reg_cancel.difference(&code_cancel).collect();
        let missing_dwell: Vec<_> = code_dwell.difference(&reg_dwell).collect();
        let stale_dwell: Vec<_> = reg_dwell.difference(&code_dwell).collect();

        assert!(
            missing_action.is_empty()
                && stale_action.is_empty()
                && missing_cancel.is_empty()
                && stale_cancel.is_empty()
                && missing_dwell.is_empty()
                && stale_dwell.is_empty(),
            "Dialog registry out of sync with App.tsx activeDialog values:\n  \
             Missing action.dialog.*: {missing_action:?}\n  \
             Stale action.dialog.*: {stale_action:?}\n  \
             Missing dialog-cancel.*: {missing_cancel:?}\n  \
             Stale dialog-cancel.*: {stale_cancel:?}\n  \
             Missing dwell.dialog.*: {missing_dwell:?}\n  \
             Stale dwell.dialog.*: {stale_dwell:?}"
        );
    }

    #[test]
    fn registry_covers_all_sources() {
        let src = read_frontend_file("src/utils/telemetry.ts");
        let sources = extract_type_union(&src, "SourceName");

        // SourceName excludes "" (no source) and "unknown" (default fallback)
        // which are registry-only entries. Add them to get the full set.
        let excluded: HashSet<&str> = ["", "unknown"].into();

        let reg_sources: HashSet<String> = SOURCE_NAMES
            .iter()
            .filter(|s| !excluded.contains(*s))
            .map(|s| s.to_string())
            .collect();

        let code_sources: HashSet<String> = sources.into_iter().collect();

        let missing: Vec<_> = code_sources.difference(&reg_sources).collect();
        let stale: Vec<_> = reg_sources.difference(&code_sources).collect();

        assert!(
            missing.is_empty() && stale.is_empty(),
            "SOURCE_NAMES out of sync with SourceName type union:\n  \
             Missing from registry: {missing:?}\n  \
             Stale in registry: {stale:?}"
        );
    }

    /// Parse a TS type union like `type Foo = | 'a' | 'b' | 'c';`.
    /// Extracts single-quoted strings from `|`-prefixed lines after
    /// `type {name} =`.
    fn extract_type_union(src: &str, name: &str) -> Vec<String> {
        let marker = format!("type {name} =");
        let start = src
            .find(&marker)
            .unwrap_or_else(|| panic!("type {name} not found in source"));
        let block = &src[start + marker.len()..];
        let mut items = Vec::new();
        for line in block.lines() {
            let trimmed = line.trim();
            if !trimmed.starts_with('|') {
                if !items.is_empty() {
                    break; // end of union
                }
                continue; // skip the `=` line itself if no `|` yet
            }
            if let Some(q1) = trimmed.find('\'') {
                if let Some(q2) = trimmed[q1 + 1..].find('\'') {
                    items.push(trimmed[q1 + 1..q1 + 1 + q2].to_string());
                }
            }
        }
        assert!(!items.is_empty(), "Failed to parse any variants from type {name}");
        items
    }

    #[test]
    fn registry_covers_all_nav_events() {
        let src = read_frontend_file("src/utils/telemetry.ts");
        let navs = extract_type_union(&src, "NavigationAction");

        let code_action: HashSet<String> =
            navs.iter().map(|n| format!("action.nav.{n}")).collect();

        let reg_action: HashSet<String> = EVENT_NAMES
            .iter()
            .filter(|n| n.starts_with("action.nav."))
            .map(|n| n.to_string())
            .collect();

        let missing: Vec<_> = code_action.difference(&reg_action).collect();
        let stale: Vec<_> = reg_action.difference(&code_action).collect();

        assert!(
            missing.is_empty() && stale.is_empty(),
            "action.nav.* registry out of sync with NavigationAction:\n  \
             Missing: {missing:?}\n  \
             Stale: {stale:?}"
        );
    }

    #[test]
    fn registry_covers_all_panel_events() {
        let src = read_frontend_file("src/utils/telemetry.ts");
        let panels = extract_type_union(&src, "PanelName");

        let code_open: HashSet<String> = panels
            .iter()
            .map(|p| format!("action.panel-open.{p}"))
            .collect();
        let code_close: HashSet<String> = panels
            .iter()
            .map(|p| format!("action.panel-close.{p}"))
            .collect();

        let reg_open: HashSet<String> = EVENT_NAMES
            .iter()
            .filter(|n| n.starts_with("action.panel-open."))
            .map(|n| n.to_string())
            .collect();
        let reg_close: HashSet<String> = EVENT_NAMES
            .iter()
            .filter(|n| n.starts_with("action.panel-close."))
            .map(|n| n.to_string())
            .collect();

        let missing_open: Vec<_> = code_open.difference(&reg_open).collect();
        let stale_open: Vec<_> = reg_open.difference(&code_open).collect();
        let missing_close: Vec<_> = code_close.difference(&reg_close).collect();
        let stale_close: Vec<_> = reg_close.difference(&code_close).collect();

        assert!(
            missing_open.is_empty()
                && stale_open.is_empty()
                && missing_close.is_empty()
                && stale_close.is_empty(),
            "Panel registry out of sync with PanelName:\n  \
             Missing panel-open.*: {missing_open:?}\n  \
             Stale panel-open.*: {stale_open:?}\n  \
             Missing panel-close.*: {missing_close:?}\n  \
             Stale panel-close.*: {stale_close:?}"
        );
    }

    #[test]
    fn registry_covers_all_selections() {
        let src = read_frontend_file("src/utils/telemetry.ts");
        let types = extract_type_union(&src, "SelectionType");

        let code_select: HashSet<String> = types
            .iter()
            .map(|t| format!("action.select.{t}"))
            .collect();
        let code_add: HashSet<String> = types
            .iter()
            .map(|t| format!("action.select-add.{t}"))
            .collect();

        let reg_select: HashSet<String> = EVENT_NAMES
            .iter()
            .filter(|n| n.starts_with("action.select."))
            .map(|n| n.to_string())
            .collect();
        let reg_add: HashSet<String> = EVENT_NAMES
            .iter()
            .filter(|n| n.starts_with("action.select-add."))
            .map(|n| n.to_string())
            .collect();

        let missing_select: Vec<_> = code_select.difference(&reg_select).collect();
        let stale_select: Vec<_> = reg_select.difference(&code_select).collect();
        let missing_add: Vec<_> = code_add.difference(&reg_add).collect();
        let stale_add: Vec<_> = reg_add.difference(&code_add).collect();

        assert!(
            missing_select.is_empty()
                && stale_select.is_empty()
                && missing_add.is_empty()
                && stale_add.is_empty(),
            "Selection registry out of sync with SelectionType:\n  \
             Missing select.*: {missing_select:?}\n  \
             Stale select.*: {stale_select:?}\n  \
             Missing select-add.*: {missing_add:?}\n  \
             Stale select-add.*: {stale_add:?}"
        );
    }

    #[test]
    fn registry_covers_all_context_menu_actions() {
        let src = read_frontend_file("src/utils/telemetry.ts");
        let actions = extract_type_union(&src, "ContextMenuAction");

        let code_actions: HashSet<String> = actions
            .iter()
            .map(|a| format!("action.{a}"))
            .collect();

        let reg_actions: HashSet<String> = EVENT_NAMES
            .iter()
            .filter(|n| {
                n.starts_with("action.")
                    && !n.starts_with("action.tool.")
                    && !n.starts_with("action.nav.")
                    && !n.starts_with("action.toggle.")
                    && !n.starts_with("action.select")
                    && !n.starts_with("action.dialog.")
                    && !n.starts_with("action.panel-")
            })
            .map(|n| n.to_string())
            .collect();

        let missing: Vec<_> = code_actions.difference(&reg_actions).collect();
        let stale: Vec<_> = reg_actions.difference(&code_actions).collect();

        assert!(
            missing.is_empty() && stale.is_empty(),
            "Context-menu action registry out of sync with ContextMenuAction:\n  \
             Missing: {missing:?}\n  \
             Stale: {stale:?}"
        );
    }

    /// Helper: walk directory recursively collecting .ts/.tsx files.
    fn walk_ts_files(dir: &std::path::Path, files: &mut Vec<std::path::PathBuf>) {
        if let Ok(entries) = std::fs::read_dir(dir) {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.is_dir() {
                    walk_ts_files(&path, files);
                } else if let Some(ext) = path.extension() {
                    if ext == "ts" || ext == "tsx" {
                        files.push(path);
                    }
                }
            }
        }
    }

    #[test]
    fn dialog_complete_calls_match_dialogs() {
        let manifest_dir = env!("CARGO_MANIFEST_DIR");
        let src_dir = std::path::Path::new(manifest_dir).join("../src");
        let mut ts_files = Vec::new();
        walk_ts_files(&src_dir, &mut ts_files);
        assert!(!ts_files.is_empty(), "No .ts/.tsx files found in src/");

        // Collect all dialog names from trackDialogComplete('...') calls
        let pattern = "trackDialogComplete('";
        let mut complete_names: HashSet<String> = HashSet::new();
        for file in &ts_files {
            let content = std::fs::read_to_string(file).unwrap();
            let mut search = content.as_str();
            while let Some(pos) = search.find(pattern) {
                let after = &search[pos + pattern.len()..];
                if let Some(end) = after.find('\'') {
                    complete_names.insert(after[..end].to_string());
                }
                search = &search[pos + pattern.len()..];
            }
        }
        assert!(
            !complete_names.is_empty(),
            "No trackDialogComplete() calls found in src/"
        );

        // All dialog names from App.tsx (canonical list)
        let app_src = read_frontend_file("src/App.tsx");
        let dialog_pattern = "activeDialog === '";
        let mut app_dialogs: HashSet<String> = HashSet::new();
        let mut search = app_src.as_str();
        while let Some(pos) = search.find(dialog_pattern) {
            let after = &search[pos + dialog_pattern.len()..];
            if let Some(end) = after.find('\'') {
                app_dialogs.insert(after[..end].to_string());
            }
            search = &search[pos + dialog_pattern.len()..];
        }

        // Every trackDialogComplete name must be a real dialog
        let invalid: Vec<_> = complete_names.difference(&app_dialogs).collect();
        assert!(
            invalid.is_empty(),
            "trackDialogComplete() called with names not in App.tsx dialog list:\n  \
             {invalid:?}\n  \
             These would silently produce unregistered dialog-cancel events."
        );
    }
}
