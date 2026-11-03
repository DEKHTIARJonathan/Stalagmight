//! The reader's public survey model and its conversion from the app's `Project`.
//!
//! These types are deliberately separate from `stalagmight_models`: the app's
//! model changes often, and every change there must not become a breaking
//! change for a consumer. Each struct is `#[non_exhaustive]` so fields can be
//! added in a minor release.

use serde::Serialize;
use stalagmight_models::station::{StationKey, StationRef};
use stalagmight_models::{NorthReference, Project, ShotKind as ModelShotKind, SurveyDirection};

/// One project, read from a `.stalx` file.
///
/// Conventions, for every field below:
/// - Lengths and depths are metres. Angles are degrees.
/// - Depth and pitch are positive DOWN.
/// - Azimuths are as stored; add the section's [`Section::azimuth_correction_deg`]
///   to get a true-north bearing.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[non_exhaustive]
pub struct Survey {
    /// `PRAGMA user_version` of the file as read, before any in-memory migration.
    pub schema_version: i32,
    pub name: String,
    pub location: Option<String>,
    /// RFC 3339.
    pub created_at: String,
    /// RFC 3339.
    pub modified_at: String,
    pub sections: Vec<Section>,
    pub station_merges: Vec<StationMerge>,
    pub zero_datums: Vec<ZeroDatum>,
    pub loop_closures: Vec<LoopClosure>,
    /// Sorted by station.
    pub station_comments: Vec<StationComment>,
    /// Measured (unadjusted) station positions; `None` unless requested in
    /// [`crate::ReadOptions`].
    pub stations: Option<Vec<StationPosition>>,
    /// Cross-references (merges, datums, closures, comments) whose station no
    /// longer exists in the file. They are dropped, and counted here.
    pub unresolved_references: usize,
}

/// A station: `index` 0 is the section's start, index `i` is the end of shot `i - 1`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize)]
#[non_exhaustive]
pub struct StationId {
    pub section_id: u32,
    pub index: u32,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[non_exhaustive]
pub struct Section {
    pub id: u32,
    pub name: Option<String>,
    pub surveyor: Option<String>,
    /// ISO 8601 date (`YYYY-MM-DD`).
    pub date: Option<String>,
    pub direction: Direction,
    pub quality: f64,
    /// `#rrggbb`.
    pub color: String,
    /// What the stored azimuths are measured against.
    pub north: North,
    /// Degrees to ADD to a stored azimuth for a true-north bearing (east positive).
    pub azimuth_correction_deg: f64,
    pub shots: Vec<Shot>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[non_exhaustive]
pub struct Shot {
    /// Stable identity across revisions, when the file has one.
    pub uuid: Option<String>,
    pub kind: ShotKind,
    pub length: f64,
    pub azimuth_in: f64,
    pub azimuth_out: f64,
    pub depth_in: f64,
    pub depth_out: f64,
    pub pitch_in: Option<f64>,
    pub pitch_out: Option<f64>,
    pub left: Option<f64>,
    pub right: Option<f64>,
    pub up: Option<f64>,
    pub down: Option<f64>,
    pub temperature: Option<f64>,
    pub marker_index: Option<u32>,
    pub comment: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
#[non_exhaustive]
pub enum ShotKind {
    /// A surveyed leg of the cave line.
    Normal,
    /// A swum shortcut between two lines.
    Jump,
    /// A non-swimmable survey tie.
    Reference,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
#[non_exhaustive]
pub enum Direction {
    In,
    Out,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
#[non_exhaustive]
pub enum North {
    Magnetic,
    True,
    Grid,
}

/// Two stations that are the same physical point.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[non_exhaustive]
pub struct StationMerge {
    pub a: StationId,
    pub b: StationId,
}

/// A station with a known GPS position.
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[non_exhaustive]
pub struct ZeroDatum {
    pub station: StationId,
    pub latitude: f64,
    pub longitude: f64,
    /// Depth of the datum station, metres, positive down.
    pub depth: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[non_exhaustive]
pub struct LoopClosure {
    pub id: u64,
    pub a: StationId,
    pub b: StationId,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[non_exhaustive]
pub struct StationComment {
    pub station: StationId,
    pub text: String,
}

/// Local position in metres: x east, y north, z depth (positive down).
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[non_exhaustive]
pub struct StationPosition {
    pub station: StationId,
    pub x: f64,
    pub y: f64,
    pub z: f64,
}

impl From<StationRef> for StationId {
    fn from(r: StationRef) -> Self {
        Self {
            section_id: r.section_id,
            index: r.station_index,
        }
    }
}

impl Survey {
    pub(crate) fn from_project(
        project: &Project,
        schema_version: i32,
        with_stations: bool,
    ) -> Self {
        let mut unresolved = 0;
        let mut resolve = |key: &StationKey| {
            let id = project.resolve_key(key).map(StationId::from);
            if id.is_none() {
                unresolved += 1;
            }
            id
        };

        let station_merges = project
            .station_merges
            .iter()
            .filter_map(|m| {
                Some(StationMerge {
                    a: resolve(&m.station_a)?,
                    b: resolve(&m.station_b)?,
                })
            })
            .collect();
        let zero_datums = project
            .zero_datums
            .iter()
            .filter_map(|z| {
                Some(ZeroDatum {
                    station: resolve(&z.station_ref)?,
                    latitude: z.gps.latitude,
                    longitude: z.gps.longitude,
                    depth: z.gps.depth_reference,
                })
            })
            .collect();
        let loop_closures = project
            .loop_closures
            .iter()
            .filter_map(|c| {
                Some(LoopClosure {
                    id: c.id,
                    a: resolve(&c.station_a)?,
                    b: resolve(&c.station_b)?,
                })
            })
            .collect();
        let mut station_comments: Vec<StationComment> = project
            .station_comments
            .iter()
            .filter_map(|(key, text)| {
                Some(StationComment {
                    station: resolve(key)?,
                    text: text.clone(),
                })
            })
            .collect();
        station_comments.sort_by_key(|c| c.station);

        let stations = with_stations.then(|| {
            project
                .compute_station_coordinates()
                .into_iter()
                .map(|s| StationPosition {
                    station: s.station_ref.into(),
                    x: s.coordinates.x,
                    y: s.coordinates.y,
                    z: s.coordinates.z,
                })
                .collect()
        });

        Self {
            schema_version,
            name: project.name.clone(),
            location: project.location.clone(),
            created_at: project.created_at.to_rfc3339(),
            modified_at: project.modified_at.to_rfc3339(),
            sections: project
                .sections
                .iter()
                .map(|section| {
                    let reference = project.azimuth_reference_for(section);
                    Section {
                        id: section.id,
                        name: section.name.clone(),
                        surveyor: section.surveyor.clone(),
                        date: section.date.map(|d| d.format("%Y-%m-%d").to_string()),
                        direction: match section.direction {
                            SurveyDirection::In => Direction::In,
                            SurveyDirection::Out => Direction::Out,
                        },
                        quality: section.quality,
                        color: section.color.clone(),
                        north: match reference.north {
                            NorthReference::Magnetic => North::Magnetic,
                            NorthReference::True => North::True,
                            NorthReference::Grid => North::Grid,
                        },
                        azimuth_correction_deg: reference.correction,
                        shots: section.shots.iter().map(Shot::from_model).collect(),
                    }
                })
                .collect(),
            station_merges,
            zero_datums,
            loop_closures,
            station_comments,
            stations,
            unresolved_references: unresolved,
        }
    }
}

impl Shot {
    fn from_model(shot: &stalagmight_models::Shot) -> Self {
        Self {
            uuid: shot.uuid.clone(),
            kind: match shot.kind {
                ModelShotKind::Normal => ShotKind::Normal,
                ModelShotKind::Jump => ShotKind::Jump,
                ModelShotKind::Reference => ShotKind::Reference,
            },
            length: shot.length,
            azimuth_in: shot.azimuth_in,
            azimuth_out: shot.azimuth_out,
            depth_in: shot.depth_in,
            depth_out: shot.depth_out,
            pitch_in: shot.pitch_in,
            pitch_out: shot.pitch_out,
            left: shot.left,
            right: shot.right,
            up: shot.up,
            down: shot.down,
            temperature: shot.temperature,
            marker_index: shot.marker_index,
            comment: shot.comment.clone(),
        }
    }
}
