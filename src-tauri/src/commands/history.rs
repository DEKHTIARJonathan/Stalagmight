use serde::Serialize;
use tauri::State;

use crate::core::{AppState, Command, CommandResult, UndoData, UndoEntry};

/// DTO for undo history item sent to frontend
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UndoHistoryItem {
    /// Index in the stack (0 = most recent)
    pub index: usize,
    /// Human-readable description of the action
    pub description: String,
    /// ISO 8601 timestamp or null for legacy entries
    pub timestamp: Option<String>,
    /// Command type for icon mapping (e.g., "create_section", "update_shot")
    pub command_type: String,
    /// Preview data showing what changed (null for commands without meaningful diff)
    pub preview_data: Option<PreviewData>,
}

/// Preview data showing field changes
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewData {
    /// List of field changes (up to 3)
    pub changes: Vec<FieldChange>,
    /// Count of additional fields beyond the shown 3
    pub additional_changes: usize,
}

/// A single field change
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FieldChange {
    /// Field name (e.g., "length", "azimuth")
    pub field: String,
    /// Old value as string
    pub old_value: String,
    /// New value as string
    pub new_value: String,
}

/// Undo the last command
#[tauri::command]
pub fn undo(state: State<AppState>) -> CommandResult {
    undo_impl(state.inner())
}

pub(crate) fn undo_impl(state: &AppState) -> CommandResult {
    state.undo()
}

/// Redo the last undone command
#[tauri::command]
pub fn redo(state: State<AppState>) -> CommandResult {
    redo_impl(state.inner())
}

pub(crate) fn redo_impl(state: &AppState) -> CommandResult {
    state.redo()
}

/// Check if undo is available
#[tauri::command]
pub fn can_undo(state: State<AppState>) -> bool {
    can_undo_impl(state.inner())
}

pub(crate) fn can_undo_impl(state: &AppState) -> bool {
    state.can_undo()
}

/// Check if redo is available
#[tauri::command]
pub fn can_redo(state: State<AppState>) -> bool {
    can_redo_impl(state.inner())
}

pub(crate) fn can_redo_impl(state: &AppState) -> bool {
    state.can_redo()
}

/// Get the undo stack as a list of history items
/// Index 0 = most recent action (first to undo)
#[tauri::command]
pub fn get_undo_stack(state: State<AppState>) -> Vec<UndoHistoryItem> {
    get_undo_stack_impl(state.inner())
}

pub(crate) fn get_undo_stack_impl(state: &AppState) -> Vec<UndoHistoryItem> {
    state.get_undo_stack()
}

/// Get the redo stack as a list of history items
/// Index 0 = most recent undone action (first to redo)
#[tauri::command]
pub fn get_redo_stack(state: State<AppState>) -> Vec<UndoHistoryItem> {
    get_redo_stack_impl(state.inner())
}

pub(crate) fn get_redo_stack_impl(state: &AppState) -> Vec<UndoHistoryItem> {
    state.get_redo_stack()
}

/// Undo to a specific index in the undo stack
/// Index 0 = most recent action, so undo_to(N) executes (N+1) undos
#[tauri::command]
pub fn undo_to(index: usize, state: State<AppState>) -> CommandResult {
    undo_to_impl(index, state.inner())
}

pub(crate) fn undo_to_impl(index: usize, state: &AppState) -> CommandResult {
    state.undo_to(index)
}

/// Redo to a specific index in the redo stack
/// Index 0 = most recent undone action, so redo_to(N) executes (N+1) redos
#[tauri::command]
pub fn redo_to(index: usize, state: State<AppState>) -> CommandResult {
    redo_to_impl(index, state.inner())
}

pub(crate) fn redo_to_impl(index: usize, state: &AppState) -> CommandResult {
    state.redo_to(index)
}

/// Get the command type string for icon mapping
fn get_command_type(command: &Command) -> String {
    match command {
        Command::CreateProject { .. } => "create_project".to_string(),
        Command::OpenProject { .. } => "open_project".to_string(),
        Command::SaveProject { .. } => "save_project".to_string(),
        Command::CloseProject => "close_project".to_string(),
        Command::CreateSection { .. } => "create_section".to_string(),
        Command::DeleteSection { .. } => "delete_section".to_string(),
        Command::UpdateSectionMetadata { .. } => "update_section_metadata".to_string(),
        Command::CreateShot { .. } => "create_shot".to_string(),
        Command::UpdateShot { .. } => "update_shot".to_string(),
        Command::DeleteShot { .. } => "delete_shot".to_string(),
        Command::SetShotVirtual { .. } => "set_shot_virtual".to_string(),
        Command::MergeStations { .. } => "merge_stations".to_string(),
        Command::UnmergeStations { .. } => "unmerge_stations".to_string(),
        Command::CreateLoopClosure { .. } => "create_loop_closure".to_string(),
        Command::SetZeroDatum { .. } => "set_zero_datum".to_string(),
        Command::RemoveZeroDatum { .. } => "remove_zero_datum".to_string(),
        Command::MoveSection { .. } => "move_section".to_string(),
        Command::MoveStation { .. } => "move_station".to_string(),
        Command::Batch { .. } => "batch".to_string(),
        Command::MergeProjects { .. } => "merge_projects".to_string(),
    }
}

/// Derive preview data from an undo entry based on command type and undo data
fn derive_preview_data(entry: &UndoEntry) -> Option<PreviewData> {
    match (&entry.command, &entry.undo_data) {
        // UpdateShot - show changed fields from PreviousValues
        (Command::UpdateShot { updates, .. }, UndoData::PreviousValues { values_json, .. }) => {
            let mut changes = Vec::new();

            // Parse the previous values JSON to extract old values
            if let Ok(prev) = serde_json::from_str::<serde_json::Value>(values_json) {
                // Check each field that was updated
                if let Some(new_len) = updates.length {
                    if let Some(old_len) = prev.get("length").and_then(|v| v.as_f64()) {
                        changes.push(FieldChange {
                            field: "length".to_string(),
                            old_value: format!("{:.2}", old_len),
                            new_value: format!("{:.2}", new_len),
                        });
                    }
                }
                if let Some(new_az) = updates.azimuth_in {
                    if let Some(old_az) = prev.get("azimuth_in").and_then(|v| v.as_f64()) {
                        changes.push(FieldChange {
                            field: "azimuth".to_string(),
                            old_value: format!("{:.1}", old_az),
                            new_value: format!("{:.1}", new_az),
                        });
                    }
                }
                if let Some(new_depth) = updates.depth_in {
                    if let Some(old_depth) = prev.get("depth_in").and_then(|v| v.as_f64()) {
                        changes.push(FieldChange {
                            field: "depth".to_string(),
                            old_value: format!("{:.2}", old_depth),
                            new_value: format!("{:.2}", new_depth),
                        });
                    }
                }
                // Handle comment field (Option<Option<String>>)
                if let Some(ref new_comment_opt) = updates.comment {
                    let old_comment = prev.get("comment")
                        .and_then(|v| if v.is_null() { None } else { v.as_str() })
                        .unwrap_or("");
                    let new_comment = new_comment_opt.as_deref().unwrap_or("");
                    changes.push(FieldChange {
                        field: "comment".to_string(),
                        old_value: old_comment.to_string(),
                        new_value: new_comment.to_string(),
                    });
                }
            }

            if changes.is_empty() {
                None
            } else {
                let total = changes.len();
                let shown: Vec<_> = changes.into_iter().take(3).collect();
                let additional = if total > 3 { total - 3 } else { 0 };
                Some(PreviewData {
                    changes: shown,
                    additional_changes: additional,
                })
            }
        }

        // UpdateSectionMetadata - show changed fields from PreviousValues
        (Command::UpdateSectionMetadata { updates, .. }, UndoData::PreviousValues { values_json, .. }) => {
            let mut changes = Vec::new();

            if let Ok(prev) = serde_json::from_str::<serde_json::Value>(values_json) {
                if let Some(Some(new_name)) = &updates.name {
                    let old_name = prev.get("name")
                        .and_then(|v| v.as_str())
                        .unwrap_or("unnamed");
                    changes.push(FieldChange {
                        field: "name".to_string(),
                        old_value: old_name.to_string(),
                        new_value: new_name.clone(),
                    });
                }
                if let Some(Some(new_surveyor)) = &updates.surveyor {
                    let old_surveyor = prev.get("surveyor")
                        .and_then(|v| v.as_str())
                        .unwrap_or("");
                    changes.push(FieldChange {
                        field: "surveyor".to_string(),
                        old_value: old_surveyor.to_string(),
                        new_value: new_surveyor.clone(),
                    });
                }
                if let Some(Some(new_date)) = &updates.date {
                    let old_date = prev.get("date")
                        .and_then(|v| v.as_str())
                        .unwrap_or("");
                    changes.push(FieldChange {
                        field: "date".to_string(),
                        old_value: old_date.to_string(),
                        new_value: new_date.to_string(),
                    });
                }
            }

            if changes.is_empty() {
                None
            } else {
                let total = changes.len();
                let shown: Vec<_> = changes.into_iter().take(3).collect();
                let additional = if total > 3 { total - 3 } else { 0 };
                Some(PreviewData {
                    changes: shown,
                    additional_changes: additional,
                })
            }
        }

        // CreateSection - show name from command
        (Command::CreateSection { name, .. }, _) => {
            Some(PreviewData {
                changes: vec![FieldChange {
                    field: "name".to_string(),
                    old_value: String::new(),
                    new_value: name.clone().unwrap_or_else(|| "unnamed".to_string()),
                }],
                additional_changes: 0,
            })
        }

        // CreateShot - show length and azimuth from command
        (Command::CreateShot { shot, .. }, _) => {
            Some(PreviewData {
                changes: vec![
                    FieldChange {
                        field: "length".to_string(),
                        old_value: String::new(),
                        new_value: format!("{:.2}", shot.length),
                    },
                    FieldChange {
                        field: "azimuth".to_string(),
                        old_value: String::new(),
                        new_value: format!("{:.1}", shot.azimuth_in),
                    },
                ],
                additional_changes: 0,
            })
        }

        // DeleteSection - show name and shot count from SectionSnapshot
        (Command::DeleteSection { .. }, UndoData::SectionSnapshot { section_data, .. }) => {
            Some(PreviewData {
                changes: vec![
                    FieldChange {
                        field: "name".to_string(),
                        old_value: section_data.name.clone().unwrap_or_else(|| "unnamed".to_string()),
                        new_value: String::new(),
                    },
                    FieldChange {
                        field: "shots".to_string(),
                        old_value: section_data.shots.len().to_string(),
                        new_value: "0".to_string(),
                    },
                ],
                additional_changes: 0,
            })
        }

        // DeleteShot - show length and azimuth from ShotSnapshot
        (Command::DeleteShot { .. }, UndoData::ShotSnapshot { shot_data, .. }) => {
            Some(PreviewData {
                changes: vec![
                    FieldChange {
                        field: "length".to_string(),
                        old_value: format!("{:.2}", shot_data.length),
                        new_value: String::new(),
                    },
                    FieldChange {
                        field: "azimuth".to_string(),
                        old_value: format!("{:.1}", shot_data.azimuth_in),
                        new_value: String::new(),
                    },
                ],
                additional_changes: 0,
            })
        }

        // SetZeroDatum - show coordinates from command
        (Command::SetZeroDatum { coordinates, .. }, _) => {
            Some(PreviewData {
                changes: vec![
                    FieldChange {
                        field: "latitude".to_string(),
                        old_value: String::new(),
                        new_value: format!("{:.6}", coordinates.latitude),
                    },
                    FieldChange {
                        field: "longitude".to_string(),
                        old_value: String::new(),
                        new_value: format!("{:.6}", coordinates.longitude),
                    },
                ],
                additional_changes: 0,
            })
        }

        // Batch - show summary of operations count (human-readable)
        (Command::Batch { commands }, _) => {
            let count = commands.len();
            let label = if count == 1 { "operation" } else { "operations" };
            Some(PreviewData {
                changes: vec![FieldChange {
                    field: "count".to_string(),
                    old_value: String::new(),
                    new_value: format!("{} {}", count, label),
                }],
                additional_changes: 0,
            })
        }

        // Commands without meaningful diff
        (Command::MergeStations { .. }, _) |
        (Command::UnmergeStations { .. }, _) |
        (Command::RemoveZeroDatum { .. }, _) |
        (Command::MoveSection { .. }, _) |
        (Command::MoveStation { .. }, _) => None,

        // Default: no preview data
        _ => None,
    }
}

/// Convert an UndoEntry to an UndoHistoryItem
pub fn entry_to_history_item(entry: &UndoEntry, index: usize) -> UndoHistoryItem {
    UndoHistoryItem {
        index,
        description: entry.command.description(),
        timestamp: entry.timestamp.map(|t| t.to_rfc3339()),
        command_type: get_command_type(&entry.command),
        preview_data: derive_preview_data(entry),
    }
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use super::*;
    use crate::models::{SectionData, ShotData, ShotUpdates, GpsCoordinates, StationRef};
    use chrono::Utc;

    #[test]
    fn test_get_command_type() {
        assert_eq!(get_command_type(&Command::CreateSection {
            name: Some("Test".to_string()),
            surveyor: None,
            date: None,
            color: "#fff".to_string(),
            direction: None,
            shots: vec![],
        }), "create_section");

        assert_eq!(get_command_type(&Command::UpdateShot {
            section_id: 0,
            shot_id: 0,
            updates: ShotUpdates::default(),
        }), "update_shot");

        assert_eq!(get_command_type(&Command::Batch {
            commands: vec![Command::CloseProject, Command::CloseProject],
        }), "batch");
    }

    #[test]
    fn test_entry_to_history_item_with_timestamp() {
        let entry = UndoEntry {
            command: Command::CreateSection {
                name: Some("Test Section".to_string()),
                surveyor: None,
                date: None,
                color: "#ff0000".to_string(),
                direction: None,
                shots: vec![],
            },
            undo_data: UndoData::None,
            timestamp: Some(Utc::now()),
        };

        let item = entry_to_history_item(&entry, 0);
        assert_eq!(item.index, 0);
        assert_eq!(item.description, "Create section 'Test Section'");
        assert!(item.timestamp.is_some());
        assert_eq!(item.command_type, "create_section");
        assert!(item.preview_data.is_some());
    }

    #[test]
    fn test_entry_to_history_item_without_timestamp() {
        let entry = UndoEntry {
            command: Command::DeleteSection { section_id: 5 },
            undo_data: UndoData::SectionSnapshot {
                section_id: 5,
                section_data: SectionData {
                    name: Some("Deleted Section".to_string()),
                    surveyor: None,
                    date: None,
                    color: "#000".to_string(),
                    direction: None,
                    shots: vec![
                        ShotData::default(),
                        ShotData::default(),
                    ],
                },
            },
            timestamp: None,
        };

        let item = entry_to_history_item(&entry, 3);
        assert_eq!(item.index, 3);
        assert!(item.timestamp.is_none());
        assert_eq!(item.command_type, "delete_section");

        let preview = item.preview_data.unwrap();
        assert_eq!(preview.changes.len(), 2);
        assert_eq!(preview.changes[0].field, "name");
        assert_eq!(preview.changes[0].old_value, "Deleted Section");
        assert_eq!(preview.changes[1].field, "shots");
        assert_eq!(preview.changes[1].old_value, "2");
    }

    #[test]
    fn test_derive_preview_data_update_shot() {
        let entry = UndoEntry {
            command: Command::UpdateShot {
                section_id: 0,
                shot_id: 0,
                updates: ShotUpdates {
                    length: Some(15.0),
                    azimuth_in: Some(90.0),
                    ..Default::default()
                },
            },
            undo_data: UndoData::PreviousValues {
                section_id: 0,
                shot_id: Some(0),
                values_json: r#"{"length": 10.0, "azimuth_in": 45.0}"#.to_string(),
            },
            timestamp: None,
        };

        let preview = derive_preview_data(&entry).unwrap();
        assert_eq!(preview.changes.len(), 2);
        assert_eq!(preview.changes[0].field, "length");
        assert_eq!(preview.changes[0].old_value, "10.00");
        assert_eq!(preview.changes[0].new_value, "15.00");
        assert_eq!(preview.changes[1].field, "azimuth");
        assert_eq!(preview.changes[1].old_value, "45.0");
        assert_eq!(preview.changes[1].new_value, "90.0");
    }

    #[test]
    fn test_derive_preview_data_merge_stations_none() {
        let entry = UndoEntry {
            command: Command::MergeStations {
                station_a: StationRef::new(0, 0),
                station_b: StationRef::new(1, 0),
            },
            undo_data: UndoData::MergeInfo {
                station_a: StationRef::new(0, 0),
                station_b: StationRef::new(1, 0),
                removed_closures: Vec::new(),
                previous_offsets: std::collections::HashMap::new(),
            },
            timestamp: None,
        };

        let preview = derive_preview_data(&entry);
        assert!(preview.is_none());
    }

    #[test]
    fn test_derive_preview_data_set_zero_datum() {
        let entry = UndoEntry {
            command: Command::SetZeroDatum {
                station_ref: StationRef::new(0, 0),
                coordinates: GpsCoordinates::new(45.123456, -73.654321, 100.0).unwrap(),
            },
            undo_data: UndoData::ZeroDatumInfo {
                station_ref: StationRef::new(0, 0),
                previous_gps: None,
                previous_offsets: HashMap::new(),
            },
            timestamp: None,
        };

        let preview = derive_preview_data(&entry).unwrap();
        assert_eq!(preview.changes.len(), 2);
        assert_eq!(preview.changes[0].field, "latitude");
        assert_eq!(preview.changes[0].new_value, "45.123456");
        assert_eq!(preview.changes[1].field, "longitude");
        assert_eq!(preview.changes[1].new_value, "-73.654321");
    }
}
