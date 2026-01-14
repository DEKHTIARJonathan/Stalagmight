use chrono::NaiveDate;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

use crate::models::{
    ClosureStrategy, GpsCoordinates, SectionData, SectionId, SectionUpdates, ShotData, ShotId,
    ShotUpdates, StationRef,
};

/// All persistent commands that modify project state
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Command {
    // Project commands
    CreateProject {
        name: String,
        location: Option<String>,
    },
    OpenProject {
        path: PathBuf,
    },
    SaveProject {
        path: Option<PathBuf>,
    },
    CloseProject,

    // Section commands
    CreateSection {
        name: Option<String>,
        surveyor: Option<String>,
        date: Option<NaiveDate>,
        color: String,
        shots: Vec<ShotData>,
    },
    DeleteSection {
        section_id: SectionId,
    },
    UpdateSectionMetadata {
        section_id: SectionId,
        updates: SectionUpdates,
    },

    // Shot commands
    CreateShot {
        section_id: SectionId,
        shot: ShotData,
        after_shot_id: Option<ShotId>,
    },
    UpdateShot {
        section_id: SectionId,
        shot_id: ShotId,
        updates: ShotUpdates,
    },
    DeleteShot {
        section_id: SectionId,
        shot_id: ShotId,
    },
    SetShotVirtual {
        section_id: SectionId,
        shot_id: ShotId,
        is_virtual: bool,
    },

    // Station commands
    MergeStations {
        station_a: StationRef,
        station_b: StationRef,
        closure_strategy: ClosureStrategy,
    },
    UnmergeStations {
        station_ref: StationRef,
    },
    SetZeroDatum {
        station_ref: StationRef,
        coordinates: GpsCoordinates,
    },
    RemoveZeroDatum {
        station_ref: StationRef,
    },

    // Batch commands
    Batch {
        commands: Vec<Command>,
    },
}

/// Result of command execution
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CommandResult {
    pub success: bool,
    pub warnings: Vec<ValidationWarning>,
    pub error: Option<String>,
}

/// Validation warning from command execution
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ValidationWarning {
    pub code: String,
    pub message: String,
    pub severity: WarningSeverity,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum WarningSeverity {
    Warning,
    Error,
}

impl CommandResult {
    pub fn success() -> Self {
        Self {
            success: true,
            warnings: Vec::new(),
            error: None,
        }
    }

    pub fn success_with_warnings(warnings: Vec<ValidationWarning>) -> Self {
        Self {
            success: true,
            warnings,
            error: None,
        }
    }

    pub fn failure(error: String) -> Self {
        Self {
            success: false,
            warnings: Vec::new(),
            error: Some(error),
        }
    }
}

impl Command {
    /// Get a human-readable description of this command
    pub fn description(&self) -> String {
        match self {
            Command::CreateProject { name, .. } => format!("Create project '{}'", name),
            Command::OpenProject { path } => {
                format!("Open project '{}'", path.display())
            }
            Command::SaveProject { path } => match path {
                Some(p) => format!("Save project to '{}'", p.display()),
                None => "Save project".to_string(),
            },
            Command::CloseProject => "Close project".to_string(),
            Command::CreateSection { name, .. } => {
                format!("Create section '{}'", name.as_deref().unwrap_or("unnamed"))
            }
            Command::DeleteSection { section_id } => {
                format!("Delete section {}", section_id)
            }
            Command::UpdateSectionMetadata { section_id, .. } => {
                format!("Update section {} metadata", section_id)
            }
            Command::CreateShot { section_id, .. } => {
                format!("Create shot in section {}", section_id)
            }
            Command::UpdateShot {
                section_id,
                shot_id,
                ..
            } => format!("Update shot {}:{}", section_id, shot_id),
            Command::DeleteShot {
                section_id,
                shot_id,
            } => format!("Delete shot {}:{}", section_id, shot_id),
            Command::SetShotVirtual {
                section_id,
                shot_id,
                is_virtual,
            } => {
                if *is_virtual {
                    format!("Mark shot {}:{} as virtual", section_id, shot_id)
                } else {
                    format!("Mark shot {}:{} as real", section_id, shot_id)
                }
            }
            Command::MergeStations {
                station_a,
                station_b,
                ..
            } => format!("Merge stations {} and {}", station_a, station_b),
            Command::UnmergeStations { station_ref } => {
                format!("Unmerge station {}", station_ref)
            }
            Command::SetZeroDatum { station_ref, .. } => {
                format!("Set zero datum at {}", station_ref)
            }
            Command::RemoveZeroDatum { station_ref } => {
                format!("Remove zero datum from {}", station_ref)
            }
            Command::Batch { commands } => {
                format!("Batch of {} commands", commands.len())
            }
        }
    }
}
