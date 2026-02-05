use std::collections::HashMap;

use serde::Serialize;
use ts_rs::TS;
use tauri::State;

use crate::core::{AppState, Command, CommandResult, UndoData, UndoEntry};
use crate::models::SectionId;

/// DTO for undo history item sent to frontend
#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
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
#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub struct PreviewData {
    /// List of field changes (up to 3)
    pub changes: Vec<FieldChange>,
    /// Count of additional fields beyond the shown 3
    pub additional_changes: usize,
}

/// A single field change
#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
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
        Command::AdjustLoopClosures { .. } => "adjust_loop_closures".to_string(),
        Command::SetZeroDatum { .. } => "set_zero_datum".to_string(),
        Command::RemoveZeroDatum { .. } => "remove_zero_datum".to_string(),
        Command::MoveSection { .. } => "move_section".to_string(),
        Command::MoveSegment { .. } => "move_segment".to_string(),
        Command::MoveStation { .. } => "move_station".to_string(),
        Command::Batch { .. } => "batch".to_string(),
        Command::MergeProjects { .. } => "merge_projects".to_string(),
    }
}

/// Helper to format a station ref with its section name when available
fn format_station_with_name(
    station_ref: &crate::models::StationRef,
    section_names: &HashMap<SectionId, Option<String>>,
) -> String {
    if let Some(Some(name)) = section_names.get(&station_ref.section_id) {
        format!("{} ({})", station_ref, name)
    } else {
        station_ref.to_string()
    }
}

/// Derive a compact detail string from just the command data (for batch sub-commands).
/// Returns None for commands where no useful details can be extracted from the command alone.
fn derive_command_details(
    cmd: &Command,
    section_names: &HashMap<SectionId, Option<String>>,
) -> Option<String> {
    match cmd {
        Command::MoveSection { section_id, offset } => {
            let mut parts = Vec::new();
            if let Some(Some(name)) = section_names.get(section_id) {
                parts.push(name.clone());
            }
            parts.push(offset.display_offset());
            Some(parts.join(", "))
        }
        Command::MoveStation { offset, .. } | Command::MoveSegment { offset, .. } => {
            Some(offset.display_offset())
        }
        Command::MergeStations { station_a, station_b } => {
            Some(format!(
                "{} \u{2194} {}",
                format_station_with_name(station_a, section_names),
                format_station_with_name(station_b, section_names),
            ))
        }
        Command::CreateLoopClosure { station_a, station_b, closure_strategy } => {
            Some(format!("{} \u{2194} {}, {}", station_a, station_b, closure_strategy.as_str()))
        }
        Command::AdjustLoopClosures { method, .. } => {
            Some(format!("Method: {}", method.as_str()))
        }
        Command::SetShotVirtual { is_virtual, .. } => {
            Some(format!("Virtual: {}", is_virtual))
        }
        Command::CreateShot { shot, .. } => {
            Some(format!("Length: {:.2}, Azimuth: {:.1}", shot.length, shot.azimuth_in))
        }
        Command::CreateSection { name, .. } => {
            name.as_ref().map(|n| format!("Name: {}", n))
        }
        Command::UpdateShot { updates, .. } => {
            let mut parts = Vec::new();
            if let Some(l) = updates.length {
                parts.push(format!("Length: {:.2}", l));
            }
            if let Some(a) = updates.azimuth_in {
                parts.push(format!("Azimuth: {:.1}", a));
            }
            if let Some(d) = updates.depth_in {
                parts.push(format!("Depth: {:.2}", d));
            }
            if parts.is_empty() { None } else { Some(parts.join(", ")) }
        }
        Command::SetZeroDatum { coordinates, .. } => {
            Some(format!("Lat: {:.6}, Lon: {:.6}", coordinates.latitude, coordinates.longitude))
        }
        _ => None,
    }
}

/// Derive preview data from an undo entry based on command type and undo data
fn derive_preview_data(
    entry: &UndoEntry,
    section_names: &HashMap<SectionId, Option<String>>,
) -> Option<PreviewData> {
    match (&entry.command, &entry.undo_data) {
        // UpdateShot - show changed fields from PreviousValues
        (Command::UpdateShot { updates, .. }, UndoData::PreviousValues { values_json, .. }) => {
            let mut changes = Vec::new();

            // Parse the previous values JSON to extract old values
            if let Ok(prev) = serde_json::from_str::<serde_json::Value>(values_json) {
                // f64 fields: check if updated and show old → new
                let f64_fields: &[(&str, Option<f64>, &str, &str)] = &[
                    ("Length", updates.length, "length", "{:.2}"),
                    ("Azimuth In", updates.azimuth_in, "azimuth_in", "{:.1}"),
                    ("Azimuth Out", updates.azimuth_out, "azimuth_out", "{:.1}"),
                    ("Depth In", updates.depth_in, "depth_in", "{:.2}"),
                    ("Depth Out", updates.depth_out, "depth_out", "{:.2}"),
                ];
                for &(label, new_val, json_key, _) in f64_fields {
                    if let Some(new_v) = new_val {
                        let old_v = prev.get(json_key).and_then(|v| v.as_f64());
                        let fmt = if label.contains("Azimuth") { 1usize } else { 2 };
                        changes.push(FieldChange {
                            field: label.to_string(),
                            old_value: old_v.map(|v| format!("{:.prec$}", v, prec = fmt)).unwrap_or_default(),
                            new_value: format!("{:.prec$}", new_v, prec = fmt),
                        });
                    }
                }

                // Option<Option<f64>> fields (nullable measurements)
                let opt_f64_fields: &[(&str, &Option<Option<f64>>, &str)] = &[
                    ("Pitch In", &updates.pitch_in, "pitch_in"),
                    ("Pitch Out", &updates.pitch_out, "pitch_out"),
                    ("Left", &updates.left, "left"),
                    ("Right", &updates.right, "right"),
                    ("Up", &updates.up, "up"),
                    ("Down", &updates.down, "down"),
                ];
                for &(label, update_val, json_key) in opt_f64_fields {
                    if let Some(ref new_opt) = update_val {
                        let old_v = prev.get(json_key).and_then(|v| v.as_f64());
                        changes.push(FieldChange {
                            field: label.to_string(),
                            old_value: old_v.map(|v| format!("{:.2}", v)).unwrap_or_default(),
                            new_value: new_opt.map(|v| format!("{:.2}", v)).unwrap_or_default(),
                        });
                    }
                }

                // Comment (Option<Option<String>>)
                if let Some(ref new_comment_opt) = updates.comment {
                    let old_comment = prev.get("comment")
                        .and_then(|v| if v.is_null() { None } else { v.as_str() })
                        .unwrap_or("");
                    let new_comment = new_comment_opt.as_deref().unwrap_or("");
                    changes.push(FieldChange {
                        field: "Comment".to_string(),
                        old_value: old_comment.to_string(),
                        new_value: new_comment.to_string(),
                    });
                }

                // is_virtual
                if let Some(new_virtual) = updates.is_virtual {
                    let old_virtual = prev.get("is_virtual").and_then(|v| v.as_bool()).unwrap_or(false);
                    changes.push(FieldChange {
                        field: "Virtual".to_string(),
                        old_value: old_virtual.to_string(),
                        new_value: new_virtual.to_string(),
                    });
                }

                // Temperature (Option<Option<f64>>)
                if let Some(ref new_temp) = updates.temperature {
                    let old_temp = prev.get("temperature").and_then(|v| v.as_f64());
                    changes.push(FieldChange {
                        field: "Temperature".to_string(),
                        old_value: old_temp.map(|v| format!("{:.1}", v)).unwrap_or_default(),
                        new_value: new_temp.map(|v| format!("{:.1}", v)).unwrap_or_default(),
                    });
                }
            }

            if changes.is_empty() {
                None
            } else {
                let total = changes.len();
                let shown: Vec<_> = changes.into_iter().take(5).collect();
                let additional = if total > 5 { total - 5 } else { 0 };
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
                if let Some(new_name_opt) = &updates.name {
                    let new_name = new_name_opt.as_deref().unwrap_or("");
                    let old_name = prev.get("name")
                        .and_then(|v| v.as_str())
                        .unwrap_or("");
                    if old_name != new_name {
                        let old_display = if old_name.is_empty() { "unnamed" } else { old_name };
                        let new_display = if new_name.is_empty() { "unnamed" } else { new_name };
                        changes.push(FieldChange {
                            field: "Name".to_string(),
                            old_value: old_display.to_string(),
                            new_value: new_display.to_string(),
                        });
                    }
                }
                if let Some(new_surveyor_opt) = &updates.surveyor {
                    let new_surveyor = new_surveyor_opt.as_deref().unwrap_or("");
                    let old_surveyor = prev.get("surveyor")
                        .and_then(|v| v.as_str())
                        .unwrap_or("");
                    if old_surveyor != new_surveyor {
                        changes.push(FieldChange {
                            field: "Surveyor".to_string(),
                            old_value: old_surveyor.to_string(),
                            new_value: new_surveyor.to_string(),
                        });
                    }
                }
                if let Some(new_date_opt) = &updates.date {
                    let new_date = new_date_opt.as_ref().map(|date| date.to_string()).unwrap_or_default();
                    let old_date = prev.get("date")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string();
                    if old_date != new_date {
                        changes.push(FieldChange {
                            field: "Date".to_string(),
                            old_value: old_date,
                            new_value: new_date,
                        });
                    }
                }
                if let Some(new_color) = &updates.color {
                    let old_color = prev.get("color")
                        .and_then(|v| v.as_str())
                        .unwrap_or("");
                    if old_color != new_color {
                        changes.push(FieldChange {
                            field: "Color".to_string(),
                            old_value: old_color.to_string(),
                            new_value: new_color.clone(),
                        });
                    }
                }
                if let Some(new_direction) = updates.direction {
                    let new_direction_str = new_direction.to_string();
                    let old_direction = prev.get("direction")
                        .and_then(|v| v.as_str())
                        .unwrap_or("");
                    if old_direction != new_direction_str {
                        changes.push(FieldChange {
                            field: "Direction".to_string(),
                            old_value: old_direction.to_string(),
                            new_value: new_direction_str,
                        });
                    }
                }
                if let Some(new_quality) = updates.quality {
                    let old_quality = prev.get("quality").and_then(|v| v.as_f64());
                    let differs = old_quality
                        .map(|old| (old - new_quality).abs() > 1e-6)
                        .unwrap_or(true);
                    if differs {
                        let old_value = old_quality.map(|v| format!("{:.2}", v)).unwrap_or_default();
                        let new_value = format!("{:.2}", new_quality);
                        changes.push(FieldChange {
                            field: "Closure Adj. Weight".to_string(),
                            old_value,
                            new_value,
                        });
                    }
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
                    field: "Name".to_string(),
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
                        field: "Length".to_string(),
                        old_value: String::new(),
                        new_value: format!("{:.2}", shot.length),
                    },
                    FieldChange {
                        field: "Azimuth".to_string(),
                        old_value: String::new(),
                        new_value: format!("{:.1}", shot.azimuth_in),
                    },
                ],
                additional_changes: 0,
            })
        }

        // DeleteSection - extract section info from ProjectSnapshotPair before snapshot
        (Command::DeleteSection { section_id }, UndoData::ProjectSnapshotPair { before, .. }) => {
            if let Ok(project) = serde_json::from_str::<crate::models::Project>(before) {
                if let Some(section) = project.get_section(*section_id) {
                    Some(PreviewData {
                        changes: vec![
                            FieldChange {
                                field: "Name".to_string(),
                                old_value: section.name.clone().unwrap_or_else(|| "unnamed".to_string()),
                                new_value: String::new(),
                            },
                            FieldChange {
                                field: "Shots".to_string(),
                                old_value: section.shots.len().to_string(),
                                new_value: "0".to_string(),
                            },
                        ],
                        additional_changes: 0,
                    })
                } else {
                    None
                }
            } else {
                None
            }
        }

        // DeleteShot - show length and azimuth from ShotSnapshot
        (Command::DeleteShot { .. }, UndoData::ShotSnapshot { shot_data, .. }) => {
            Some(PreviewData {
                changes: vec![
                    FieldChange {
                        field: "Length".to_string(),
                        old_value: format!("{:.2}", shot_data.length),
                        new_value: String::new(),
                    },
                    FieldChange {
                        field: "Azimuth".to_string(),
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
                        field: "Latitude".to_string(),
                        old_value: String::new(),
                        new_value: format!("{:.6}", coordinates.latitude),
                    },
                    FieldChange {
                        field: "Longitude".to_string(),
                        old_value: String::new(),
                        new_value: format!("{:.6}", coordinates.longitude),
                    },
                ],
                additional_changes: 0,
            })
        }

        // SetShotVirtual - show the toggle
        (Command::SetShotVirtual { is_virtual, .. }, _) => {
            Some(PreviewData {
                changes: vec![FieldChange {
                    field: "Virtual".to_string(),
                    old_value: (!is_virtual).to_string(),
                    new_value: is_virtual.to_string(),
                }],
                additional_changes: 0,
            })
        }

        // MoveSection - show offset and section name
        (Command::MoveSection { section_id, offset }, _) => {
            let mut changes = vec![FieldChange {
                field: "Offset".to_string(),
                old_value: String::new(),
                new_value: offset.display_offset(),
            }];
            if let Some(Some(name)) = section_names.get(section_id) {
                changes.insert(0, FieldChange {
                    field: "Section".to_string(),
                    old_value: String::new(),
                    new_value: name.clone(),
                });
            }
            Some(PreviewData { changes, additional_changes: 0 })
        }

        // MoveStation - show offset
        (Command::MoveStation { offset, .. }, _) => {
            Some(PreviewData {
                changes: vec![FieldChange {
                    field: "Offset".to_string(),
                    old_value: String::new(),
                    new_value: offset.display_offset(),
                }],
                additional_changes: 0,
            })
        }

        // MoveSegment - show offset and affected section count
        (Command::MoveSegment { offset, .. }, UndoData::SegmentMoveInfo { affected_sections, .. }) => {
            Some(PreviewData {
                changes: vec![
                    FieldChange {
                        field: "Offset".to_string(),
                        old_value: String::new(),
                        new_value: offset.display_offset(),
                    },
                    FieldChange {
                        field: "Affected sections".to_string(),
                        old_value: String::new(),
                        new_value: affected_sections.len().to_string(),
                    },
                ],
                additional_changes: 0,
            })
        }

        // MoveSegment fallback (other undo data variants)
        (Command::MoveSegment { offset, .. }, _) => {
            Some(PreviewData {
                changes: vec![FieldChange {
                    field: "Offset".to_string(),
                    old_value: String::new(),
                    new_value: offset.display_offset(),
                }],
                additional_changes: 0,
            })
        }

        // MergeStations - show station identifiers with section names
        (Command::MergeStations { station_a, station_b }, _) => {
            Some(PreviewData {
                changes: vec![
                    FieldChange {
                        field: "Station A".to_string(),
                        old_value: String::new(),
                        new_value: format_station_with_name(station_a, section_names),
                    },
                    FieldChange {
                        field: "Station B".to_string(),
                        old_value: String::new(),
                        new_value: format_station_with_name(station_b, section_names),
                    },
                ],
                additional_changes: 0,
            })
        }

        // UnmergeStations - show station identifier with section name
        (Command::UnmergeStations { station_ref }, _) => {
            Some(PreviewData {
                changes: vec![FieldChange {
                    field: "Station".to_string(),
                    old_value: String::new(),
                    new_value: format_station_with_name(station_ref, section_names),
                }],
                additional_changes: 0,
            })
        }

        // CreateLoopClosure - show stations and strategy
        (Command::CreateLoopClosure { station_a, station_b, closure_strategy }, _) => {
            Some(PreviewData {
                changes: vec![
                    FieldChange {
                        field: "Stations".to_string(),
                        old_value: String::new(),
                        new_value: format!("{} \u{2194} {}", station_a, station_b),
                    },
                    FieldChange {
                        field: "Strategy".to_string(),
                        old_value: String::new(),
                        new_value: closure_strategy.as_str().to_string(),
                    },
                ],
                additional_changes: 0,
            })
        }

        // RemoveZeroDatum - show station and previous GPS if available
        (Command::RemoveZeroDatum { station_ref }, UndoData::ZeroDatumInfo { previous_gps, .. }) => {
            let mut changes = vec![FieldChange {
                field: "Station".to_string(),
                old_value: String::new(),
                new_value: station_ref.to_string(),
            }];
            if let Some(gps) = previous_gps {
                changes.push(FieldChange {
                    field: "Latitude".to_string(),
                    old_value: format!("{:.6}", gps.latitude),
                    new_value: String::new(),
                });
                changes.push(FieldChange {
                    field: "Longitude".to_string(),
                    old_value: format!("{:.6}", gps.longitude),
                    new_value: String::new(),
                });
            }
            Some(PreviewData { changes, additional_changes: 0 })
        }

        // RemoveZeroDatum fallback
        (Command::RemoveZeroDatum { station_ref }, _) => {
            Some(PreviewData {
                changes: vec![FieldChange {
                    field: "Station".to_string(),
                    old_value: String::new(),
                    new_value: station_ref.to_string(),
                }],
                additional_changes: 0,
            })
        }

        // Batch - list all sub-commands with their details
        (Command::Batch { commands }, _) => {
            let changes: Vec<FieldChange> = commands.iter()
                .map(|cmd| {
                    let details = derive_command_details(cmd, section_names)
                        .unwrap_or_default();
                    FieldChange {
                        field: cmd.description(),
                        old_value: String::new(),
                        new_value: details,
                    }
                })
                .collect();
            Some(PreviewData { changes, additional_changes: 0 })
        }

        // Default catch-all: show command description so hover is never empty
        _ => {
            Some(PreviewData {
                changes: vec![FieldChange {
                    field: "Action".to_string(),
                    old_value: String::new(),
                    new_value: entry.command.description(),
                }],
                additional_changes: 0,
            })
        }
    }
}

/// Convert an UndoEntry to an UndoHistoryItem
pub fn entry_to_history_item(
    entry: &UndoEntry,
    index: usize,
    section_names: &HashMap<SectionId, Option<String>>,
) -> UndoHistoryItem {
    UndoHistoryItem {
        index,
        description: entry.command.description(),
        timestamp: entry.timestamp.map(|t| t.to_rfc3339()),
        command_type: get_command_type(&entry.command),
        preview_data: derive_preview_data(entry, section_names),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::{
        ClosureStrategy, Coordinates, SectionData, ShotData, ShotUpdates, GpsCoordinates,
        StationRef,
    };
    use chrono::Utc;
    use std::collections::HashMap;

    fn empty_names() -> HashMap<SectionId, Option<String>> {
        HashMap::new()
    }

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

        let item = entry_to_history_item(&entry, 0, &empty_names());
        assert_eq!(item.index, 0);
        assert_eq!(item.description, "Create section 'Test Section'");
        assert!(item.timestamp.is_some());
        assert_eq!(item.command_type, "create_section");
        assert!(item.preview_data.is_some());
    }

    #[test]
    fn test_entry_to_history_item_without_timestamp() {
        // Build a Project with section_id=5 containing 2 shots for the "before" snapshot
        let mut project = crate::models::Project::new("Test".to_string(), None);
        // Advance next_section_id to 5
        project.next_section_id = 5;
        project.add_section(SectionData {
            name: Some("Deleted Section".to_string()),
            surveyor: None,
            date: None,
            color: "#000".to_string(),
            direction: None,
            quality: 1.0,
            shots: vec![
                ShotData::default(),
                ShotData::default(),
            ],
        });
        let before_json = serde_json::to_string(&project).unwrap();

        let entry = UndoEntry {
            command: Command::DeleteSection { section_id: 5 },
            undo_data: UndoData::ProjectSnapshotPair {
                before: before_json,
                after: String::new(),
            },
            timestamp: None,
        };

        let item = entry_to_history_item(&entry, 3, &empty_names());
        assert_eq!(item.index, 3);
        assert!(item.timestamp.is_none());
        assert_eq!(item.command_type, "delete_section");

        let preview = item.preview_data.unwrap();
        assert_eq!(preview.changes.len(), 2);
        assert_eq!(preview.changes[0].field, "Name");
        assert_eq!(preview.changes[0].old_value, "Deleted Section");
        assert_eq!(preview.changes[1].field, "Shots");
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

        let preview = derive_preview_data(&entry, &empty_names()).unwrap();
        assert_eq!(preview.changes.len(), 2);
        assert_eq!(preview.changes[0].field, "Length");
        assert_eq!(preview.changes[0].old_value, "10.00");
        assert_eq!(preview.changes[0].new_value, "15.00");
        assert_eq!(preview.changes[1].field, "Azimuth In");
        assert_eq!(preview.changes[1].old_value, "45.0");
        assert_eq!(preview.changes[1].new_value, "90.0");
    }

    #[test]
    fn test_derive_preview_data_merge_stations_with_names() {
        let mut names = HashMap::new();
        names.insert(0, Some("Main Passage".to_string()));
        names.insert(1, Some("Side Tunnel".to_string()));

        let entry = UndoEntry {
            command: Command::MergeStations {
                station_a: StationRef::new(0, 0),
                station_b: StationRef::new(1, 0),
            },
            undo_data: UndoData::MergeInfo {
                station_a: StationRef::new(0, 0),
                station_b: StationRef::new(1, 0),
                removed_closures: Vec::new(),
                previous_offsets: HashMap::new(),
            },
            timestamp: None,
        };

        let preview = derive_preview_data(&entry, &names).unwrap();
        assert_eq!(preview.changes.len(), 2);
        assert_eq!(preview.changes[0].field, "Station A");
        assert_eq!(preview.changes[0].new_value, "0:0 (Main Passage)");
        assert_eq!(preview.changes[1].field, "Station B");
        assert_eq!(preview.changes[1].new_value, "1:0 (Side Tunnel)");
    }

    #[test]
    fn test_derive_preview_data_merge_stations_without_names() {
        let entry = UndoEntry {
            command: Command::MergeStations {
                station_a: StationRef::new(0, 0),
                station_b: StationRef::new(1, 0),
            },
            undo_data: UndoData::MergeInfo {
                station_a: StationRef::new(0, 0),
                station_b: StationRef::new(1, 0),
                removed_closures: Vec::new(),
                previous_offsets: HashMap::new(),
            },
            timestamp: None,
        };

        let preview = derive_preview_data(&entry, &empty_names()).unwrap();
        assert_eq!(preview.changes[0].new_value, "0:0");
        assert_eq!(preview.changes[1].new_value, "1:0");
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

        let preview = derive_preview_data(&entry, &empty_names()).unwrap();
        assert_eq!(preview.changes.len(), 2);
        assert_eq!(preview.changes[0].field, "Latitude");
        assert_eq!(preview.changes[0].new_value, "45.123456");
        assert_eq!(preview.changes[1].field, "Longitude");
        assert_eq!(preview.changes[1].new_value, "-73.654321");
    }

    #[test]
    fn test_derive_preview_data_move_section() {
        let mut names = HashMap::new();
        names.insert(2, Some("East Wing".to_string()));

        let entry = UndoEntry {
            command: Command::MoveSection {
                section_id: 2,
                offset: Coordinates::new(0.0, 5.0, 0.0),
            },
            undo_data: UndoData::None,
            timestamp: None,
        };

        let preview = derive_preview_data(&entry, &names).unwrap();
        assert_eq!(preview.changes[0].field, "Section");
        assert_eq!(preview.changes[0].new_value, "East Wing");
        assert_eq!(preview.changes[1].field, "Offset");
        assert_eq!(preview.changes[1].new_value, "5.0m N");
    }

    #[test]
    fn test_derive_preview_data_move_station() {
        let entry = UndoEntry {
            command: Command::MoveStation {
                station_ref: StationRef::new(1, 3),
                offset: Coordinates::new(5.0, 0.0, -2.0),
            },
            undo_data: UndoData::None,
            timestamp: None,
        };

        let preview = derive_preview_data(&entry, &empty_names()).unwrap();
        assert_eq!(preview.changes[0].field, "Offset");
        assert_eq!(preview.changes[0].new_value, "5.0m E, 2.0m up");
    }

    #[test]
    fn test_derive_preview_data_set_shot_virtual() {
        let entry = UndoEntry {
            command: Command::SetShotVirtual {
                section_id: 1,
                shot_id: 2,
                is_virtual: true,
            },
            undo_data: UndoData::None,
            timestamp: None,
        };

        let preview = derive_preview_data(&entry, &empty_names()).unwrap();
        assert_eq!(preview.changes[0].field, "Virtual");
        assert_eq!(preview.changes[0].old_value, "false");
        assert_eq!(preview.changes[0].new_value, "true");
    }

    #[test]
    fn test_derive_preview_data_create_loop_closure() {
        let entry = UndoEntry {
            command: Command::CreateLoopClosure {
                station_a: StationRef::new(1, 0),
                station_b: StationRef::new(2, 3),
                closure_strategy: ClosureStrategy::ProportionalByLength,
            },
            undo_data: UndoData::None,
            timestamp: None,
        };

        let preview = derive_preview_data(&entry, &empty_names()).unwrap();
        assert_eq!(preview.changes[0].field, "Stations");
        assert!(preview.changes[0].new_value.contains("1:0"));
        assert!(preview.changes[0].new_value.contains("2:3"));
        assert_eq!(preview.changes[1].field, "Strategy");
        assert_eq!(preview.changes[1].new_value, "ProportionalByLength");
    }

    #[test]
    fn test_derive_preview_data_remove_zero_datum_with_gps() {
        let entry = UndoEntry {
            command: Command::RemoveZeroDatum {
                station_ref: StationRef::new(0, 0),
            },
            undo_data: UndoData::ZeroDatumInfo {
                station_ref: StationRef::new(0, 0),
                previous_gps: Some(GpsCoordinates::new(45.0, -73.0, 0.0).unwrap()),
                previous_offsets: HashMap::new(),
            },
            timestamp: None,
        };

        let preview = derive_preview_data(&entry, &empty_names()).unwrap();
        assert_eq!(preview.changes.len(), 3);
        assert_eq!(preview.changes[0].field, "Station");
        assert_eq!(preview.changes[1].field, "Latitude");
        assert_eq!(preview.changes[1].old_value, "45.000000");
        assert_eq!(preview.changes[2].field, "Longitude");
    }

    #[test]
    fn test_derive_preview_data_batch_lists_subcommands_with_details() {
        let entry = UndoEntry {
            command: Command::Batch {
                commands: vec![
                    Command::DeleteShot { section_id: 1, shot_id: 2 },
                    Command::MergeStations {
                        station_a: StationRef::new(1, 0),
                        station_b: StationRef::new(2, 0),
                    },
                    Command::MoveSection {
                        section_id: 3,
                        offset: Coordinates::new(0.0, 5.0, 0.0),
                    },
                    Command::CloseProject,
                ],
            },
            undo_data: UndoData::None,
            timestamp: None,
        };

        let preview = derive_preview_data(&entry, &empty_names()).unwrap();
        // All 4 sub-commands shown (no truncation)
        assert_eq!(preview.changes.len(), 4);
        assert_eq!(preview.additional_changes, 0);
        // Each field is the sub-command description
        assert_eq!(preview.changes[0].field, "Delete shot 1:3");
        assert!(preview.changes[0].new_value.is_empty()); // no details for delete without undo data
        assert_eq!(preview.changes[1].field, "Merge stations 1:0 and 2:0");
        assert!(preview.changes[1].new_value.contains("1:0"));
        assert!(preview.changes[1].new_value.contains("2:0"));
        assert_eq!(preview.changes[2].field, "Move section 3");
        assert_eq!(preview.changes[2].new_value, "5.0m N");
        assert_eq!(preview.changes[3].field, "Close project");
        assert!(preview.changes[3].new_value.is_empty());
    }

    #[test]
    fn test_derive_preview_data_default_fallback_never_none() {
        // DeleteShot with non-matching undo data should still produce preview via fallback
        let entry = UndoEntry {
            command: Command::DeleteShot { section_id: 1, shot_id: 2 },
            undo_data: UndoData::None,
            timestamp: None,
        };

        let preview = derive_preview_data(&entry, &empty_names()).unwrap();
        assert_eq!(preview.changes[0].field, "Action");
        assert!(preview.changes[0].new_value.contains("Delete shot"));
    }
}
