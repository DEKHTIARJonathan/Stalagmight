use chrono::NaiveDate;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use ts_rs::TS;

use crate::models::{
    shot_display_position, ClosureStrategy, Coordinates, GpsCoordinates, SectionId,
    SectionUpdates, ShotData, ShotId, ShotUpdates, StationRef, SurveyDirection,
};

/// Identifies either a station or a shot as a comment holder
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum CommentHolder {
    Station { station_ref: StationRef },
    Shot { section_id: SectionId, shot_id: ShotId },
}

impl std::fmt::Display for CommentHolder {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            CommentHolder::Station { station_ref } => write!(f, "station {station_ref}"),
            CommentHolder::Shot { section_id, shot_id } => {
                let pos = shot_display_position(*shot_id, *section_id);
                write!(f, "shot {section_id}:{pos}")
            }
        }
    }
}

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
        #[serde(default)]
        direction: Option<SurveyDirection>,
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
        #[serde(default)]
        before_shot_id: Option<ShotId>,
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
    #[serde(alias = "set_shot_virtual")]
    SetShotReference {
        section_id: SectionId,
        shot_id: ShotId,
        is_reference: bool,
    },

    // Station commands
    MergeStations {
        station_a: StationRef,
        station_b: StationRef,
    },
    UnmergeStations {
        station_ref: StationRef,
    },
    CreateLoopClosure {
        station_a: StationRef,
        station_b: StationRef,
        closure_strategy: ClosureStrategy,
    },
    AdjustLoopClosures {
        anchor_station: StationRef,
        method: ClosureStrategy,
    },
    SetZeroDatum {
        station_ref: StationRef,
        coordinates: GpsCoordinates,
    },
    RemoveZeroDatum {
        station_ref: StationRef,
    },

    // Station comment commands
    SetStationComment {
        station_ref: StationRef,
        comment: Option<String>,
    },

    // Move commands
    MoveSection {
        section_id: SectionId,
        offset: Coordinates,
    },
    MoveSegment {
        section_id: SectionId,
        offset: Coordinates,
    },
    MoveStation {
        station_ref: StationRef,
        offset: Coordinates,
    },

    // Comment move commands
    MoveComment {
        source: CommentHolder,
        target: CommentHolder,
        swap: bool,
    },

    // Batch commands
    Batch {
        commands: Vec<Command>,
    },

    // Project merge command
    MergeProjects {
        /// Paths to the source projects to merge
        source_paths: Vec<PathBuf>,
        /// Path for the merged output project
        output_path: PathBuf,
        /// Name for the merged project
        output_name: String,
        /// Whether to archive (rename) the original files
        archive_originals: bool,
    },
}

/// Result of command execution
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct CommandResult {
    pub success: bool,
    pub warnings: Vec<ValidationWarning>,
    pub error: Option<String>,
    /// ID of the created section (for CreateSection command)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub section_id: Option<u32>,
    /// IDs of created sections (for Batch commands containing CreateSection)
    #[serde(skip_serializing_if = "Vec::is_empty", default)]
    pub section_ids: Vec<u32>,
    /// ID of the created shot (for CreateShot command)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub shot_id: Option<u32>,
    /// Path the project was saved to (for SaveProject command)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub saved_path: Option<String>,
}

/// Validation warning from command execution
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct ValidationWarning {
    pub code: String,
    pub message: String,
    pub severity: WarningSeverity,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, TS)]
#[serde(rename_all = "lowercase")]
#[ts(rename_all = "lowercase")]
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
            section_id: None,
            section_ids: Vec::new(),
            shot_id: None,
            saved_path: None,
        }
    }

    pub fn failure(error: String) -> Self {
        Self {
            success: false,
            warnings: Vec::new(),
            error: Some(error),
            section_id: None,
            section_ids: Vec::new(),
            shot_id: None,
            saved_path: None,
        }
    }

    /// Attach validation warnings to this result.
    pub fn with_warnings(mut self, warnings: Vec<ValidationWarning>) -> Self {
        self.warnings = warnings;
        self
    }

    /// Attach a created section ID to this result.
    pub fn with_section_id(mut self, section_id: u32) -> Self {
        self.section_id = Some(section_id);
        self
    }

    /// Attach multiple section IDs to this result (for batch operations).
    pub fn with_section_ids(mut self, section_ids: Vec<u32>) -> Self {
        self.section_ids = section_ids;
        self
    }

    /// Attach a created shot ID to this result.
    pub fn with_shot_id(mut self, shot_id: u32) -> Self {
        self.shot_id = Some(shot_id);
        self
    }

    /// Attach the saved file path to this result.
    pub fn with_path(mut self, path: String) -> Self {
        self.saved_path = Some(path);
        self
    }
}

impl Command {
    /// Get a human-readable description of this command
    pub fn description(&self) -> String {
        match self {
            Command::CreateProject { name, .. } => format!("Create project '{name}'"),
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
                format!("Delete section {section_id}")
            }
            Command::UpdateSectionMetadata { section_id, .. } => {
                format!("Update section {section_id} metadata")
            }
            Command::CreateShot { section_id, .. } => {
                format!("Create shot in section {section_id}")
            }
            Command::UpdateShot {
                section_id,
                shot_id,
                ..
            } => format!("Update shot {}:{}", section_id, shot_display_position(*shot_id, *section_id)),
            Command::DeleteShot {
                section_id,
                shot_id,
            } => format!("Delete shot {}:{}", section_id, shot_display_position(*shot_id, *section_id)),
            Command::SetShotReference {
                section_id,
                shot_id,
                is_reference,
            } => {
                let pos = shot_display_position(*shot_id, *section_id);
                if *is_reference {
                    format!("Mark shot {section_id}:{pos} as reference")
                } else {
                    format!("Mark shot {section_id}:{pos} as permanent")
                }
            }
            Command::MergeStations {
                station_a,
                station_b,
                ..
            } => format!("Merge stations {station_a} and {station_b}"),
            Command::UnmergeStations { station_ref } => {
                format!("Unmerge station {station_ref}")
            }
            Command::CreateLoopClosure {
                station_a,
                station_b,
                ..
            } => format!("Create loop closure between {station_a} and {station_b}"),
            Command::AdjustLoopClosures { method, .. } => {
                format!("Adjust loop closures ({})", method.as_str())
            }
            Command::SetZeroDatum { station_ref, .. } => {
                format!("Set zero datum at {station_ref}")
            }
            Command::RemoveZeroDatum { station_ref } => {
                format!("Remove zero datum from {station_ref}")
            }
            Command::SetStationComment { station_ref, comment } => {
                if comment.is_some() {
                    format!("Set comment on station {station_ref}")
                } else {
                    format!("Remove comment from station {station_ref}")
                }
            }
            Command::MoveSection { section_id, .. } => {
                format!("Move section {section_id}")
            }
            Command::MoveSegment { section_id, .. } => {
                format!("Move segment (section {section_id})")
            }
            Command::MoveStation { station_ref, .. } => {
                format!("Move station {station_ref}")
            }
            Command::MoveComment { source, target, swap } => {
                if *swap {
                    format!("Swap comments between {source} and {target}")
                } else {
                    format!("Move comment from {source} to {target}")
                }
            }
            Command::Batch { commands } => {
                format!("Batch of {} commands", commands.len())
            }
            Command::MergeProjects {
                source_paths,
                output_name,
                ..
            } => {
                format!(
                    "Merge {} projects into '{}'",
                    source_paths.len(),
                    output_name
                )
            }
        }
    }
}

#[cfg(test)]
#[expect(clippy::unwrap_used)]
mod tests {
    use super::*;
    use crate::models::{
        ClosureStrategy, Coordinates, GpsCoordinates, SectionUpdates, ShotData, ShotUpdates,
        StationRef,
    };
    use chrono::NaiveDate;
    use std::path::PathBuf;

    // Re-import CommentHolder so tests can use it without qualification
    use super::CommentHolder;

    #[test]
    fn command_result_builder_sets_fields() {
        let warning = ValidationWarning {
            code: "test".to_string(),
            message: "warn".to_string(),
            severity: WarningSeverity::Warning,
        };

        let success = CommandResult::success();
        assert!(success.success);
        assert!(success.warnings.is_empty());
        assert!(success.error.is_none());
        assert!(success.section_id.is_none());
        assert!(success.section_ids.is_empty());
        assert!(success.shot_id.is_none());
        assert!(success.saved_path.is_none());

        let with_path = CommandResult::success().with_path("/tmp/test.stalx".to_string());
        assert!(with_path.success);
        assert_eq!(with_path.saved_path.as_deref(), Some("/tmp/test.stalx"));

        let with_warnings = CommandResult::success().with_warnings(vec![warning.clone()]);
        assert!(with_warnings.success);
        assert_eq!(with_warnings.warnings.len(), 1);
        assert!(with_warnings.error.is_none());
        assert!(with_warnings.section_id.is_none());
        assert!(with_warnings.section_ids.is_empty());
        assert!(with_warnings.shot_id.is_none());

        let with_section = CommandResult::success().with_section_id(7);
        assert!(with_section.success);
        assert_eq!(with_section.section_id, Some(7));
        assert!(with_section.section_ids.is_empty());
        assert!(with_section.shot_id.is_none());

        let with_section_and_warnings = CommandResult::success()
            .with_section_id(8)
            .with_warnings(vec![warning.clone()]);
        assert!(with_section_and_warnings.success);
        assert_eq!(with_section_and_warnings.section_id, Some(8));
        assert_eq!(with_section_and_warnings.warnings.len(), 1);
        assert!(with_section_and_warnings.shot_id.is_none());

        let with_sections = CommandResult::success().with_section_ids(vec![1, 2, 3]);
        assert!(with_sections.success);
        assert!(with_sections.section_id.is_none());
        assert_eq!(with_sections.section_ids, vec![1, 2, 3]);
        assert!(with_sections.shot_id.is_none());

        let with_sections_and_warnings = CommandResult::success()
            .with_section_ids(vec![4, 5])
            .with_warnings(vec![warning.clone()]);
        assert!(with_sections_and_warnings.success);
        assert_eq!(with_sections_and_warnings.section_ids, vec![4, 5]);
        assert_eq!(with_sections_and_warnings.warnings.len(), 1);
        assert!(with_sections_and_warnings.shot_id.is_none());

        let with_shot = CommandResult::success().with_shot_id(42);
        assert!(with_shot.success);
        assert_eq!(with_shot.shot_id, Some(42));
        assert!(with_shot.section_id.is_none());
        assert!(with_shot.section_ids.is_empty());

        let with_shot_and_warnings = CommandResult::success()
            .with_shot_id(99)
            .with_warnings(vec![warning]);
        assert!(with_shot_and_warnings.success);
        assert_eq!(with_shot_and_warnings.shot_id, Some(99));
        assert_eq!(with_shot_and_warnings.warnings.len(), 1);

        let failure = CommandResult::failure("boom".to_string());
        assert!(!failure.success);
        assert!(failure.warnings.is_empty());
        assert_eq!(failure.error.as_deref(), Some("boom"));
        assert!(failure.section_id.is_none());
        assert!(failure.section_ids.is_empty());
        assert!(failure.shot_id.is_none());
    }

    #[test]
    fn command_description_covers_all_variants() {
        let shot_data = ShotData {
            azimuth_in: 10.0,
            azimuth_out: 20.0,
            length: 3.0,
            depth_in: 1.0,
            depth_out: 2.0,
            ..Default::default()
        };
        let section_updates = SectionUpdates {
            name: Some(Some("Updated".to_string())),
            ..Default::default()
        };
        let shot_updates = ShotUpdates {
            length: Some(4.0),
            ..Default::default()
        };
        let station_a = StationRef::new(1, 0);
        let station_b = StationRef::new(1, 1);
        let gps = GpsCoordinates::new(10.0, 20.0, 5.0).unwrap();

        let cases = vec![
            (
                Command::CreateProject {
                    name: "Alpha".to_string(),
                    location: None,
                },
                "Create project 'Alpha'",
            ),
            (
                Command::OpenProject {
                    path: PathBuf::from("alpha.stalx"),
                },
                "Open project 'alpha.stalx'",
            ),
            (
                Command::SaveProject { path: None },
                "Save project",
            ),
            (
                Command::SaveProject {
                    path: Some(PathBuf::from("alpha.stalx")),
                },
                "Save project to 'alpha.stalx'",
            ),
            (Command::CloseProject, "Close project"),
            (
                Command::CreateSection {
                    name: Some("Main".to_string()),
                    surveyor: None,
                    date: Some(NaiveDate::from_ymd_opt(2025, 1, 1).unwrap()),
                    color: "#fff".to_string(),
                    direction: Some(SurveyDirection::In),
                    shots: vec![shot_data.clone()],
                },
                "Create section 'Main'",
            ),
            (
                Command::DeleteSection { section_id: 3 },
                "Delete section 3",
            ),
            (
                Command::UpdateSectionMetadata {
                    section_id: 3,
                    updates: section_updates,
                },
                "Update section 3 metadata",
            ),
            (
                Command::CreateShot {
                    section_id: 4,
                    shot: shot_data,
                    after_shot_id: None,
                    before_shot_id: None,
                },
                "Create shot in section 4",
            ),
            (
                Command::UpdateShot {
                    section_id: 4,
                    shot_id: 2,
                    updates: shot_updates,
                },
                "Update shot 4:3",
            ),
            (
                Command::DeleteShot {
                    section_id: 4,
                    shot_id: 2,
                },
                "Delete shot 4:3",
            ),
            (
                Command::SetShotReference {
                    section_id: 4,
                    shot_id: 2,
                    is_reference: true,
                },
                "Mark shot 4:3 as reference",
            ),
            (
                Command::SetShotReference {
                    section_id: 4,
                    shot_id: 2,
                    is_reference: false,
                },
                "Mark shot 4:3 as permanent",
            ),
            (
                Command::MergeStations {
                    station_a,
                    station_b,
                },
                "Merge stations 1:0 and 1:1",
            ),
            (
                Command::CreateLoopClosure {
                    station_a,
                    station_b,
                    closure_strategy: ClosureStrategy::ProportionalByLength,
                },
                "Create loop closure between 1:0 and 1:1",
            ),
            (
                Command::UnmergeStations {
                    station_ref: station_a,
                },
                "Unmerge station 1:0",
            ),
            (
                Command::SetZeroDatum {
                    station_ref: station_b,
                    coordinates: gps,
                },
                "Set zero datum at 1:1",
            ),
            (
                Command::RemoveZeroDatum {
                    station_ref: station_b,
                },
                "Remove zero datum from 1:1",
            ),
            (
                Command::MoveSection {
                    section_id: 2,
                    offset: Coordinates::new(1.0, 2.0, 3.0),
                },
                "Move section 2",
            ),
            (
                Command::MoveSegment {
                    section_id: 2,
                    offset: Coordinates::new(1.0, 2.0, 3.0),
                },
                "Move segment (section 2)",
            ),
            (
                Command::SetStationComment {
                    station_ref: station_a,
                    comment: Some("Test comment".to_string()),
                },
                "Set comment on station 1:0",
            ),
            (
                Command::SetStationComment {
                    station_ref: station_a,
                    comment: None,
                },
                "Remove comment from station 1:0",
            ),
            (
                Command::MoveStation {
                    station_ref: station_a,
                    offset: Coordinates::new(1.0, 0.0, 0.0),
                },
                "Move station 1:0",
            ),
            (
                Command::MoveComment {
                    source: CommentHolder::Station { station_ref: station_a },
                    target: CommentHolder::Shot { section_id: 1, shot_id: 0 },
                    swap: false,
                },
                "Move comment from station 1:0 to shot 1:1",
            ),
            (
                Command::MoveComment {
                    source: CommentHolder::Station { station_ref: station_a },
                    target: CommentHolder::Station { station_ref: station_b },
                    swap: true,
                },
                "Swap comments between station 1:0 and station 1:1",
            ),
            (
                Command::Batch {
                    commands: vec![Command::CloseProject],
                },
                "Batch of 1 commands",
            ),
            (
                Command::MergeProjects {
                    source_paths: vec![PathBuf::from("a.stalx"), PathBuf::from("b.stalx")],
                    output_path: PathBuf::from("out.stalx"),
                    output_name: "Merged".to_string(),
                    archive_originals: false,
                },
                "Merge 2 projects into 'Merged'",
            ),
        ];

        for (command, expected) in cases {
            assert_eq!(command.description(), expected);
        }
    }
}
