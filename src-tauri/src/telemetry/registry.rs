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
        assert_eq!(EVENT_NAMES.len(), 286);
    }

    #[test]
    fn source_count() {
        assert_eq!(SOURCE_NAMES.len(), 14);
    }
}
