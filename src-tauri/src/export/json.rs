use anyhow::{Context, Result};
use chrono::Utc;
use serde::Serialize;
use std::path::Path;

use crate::models::Project;

/// Export project data to JSON format
pub fn export_json(project: &Project, path: &Path) -> Result<()> {
    let export_data = JsonExport::from_project(project);

    let json = serde_json::to_string_pretty(&export_data).context("Failed to serialize JSON")?;

    std::fs::write(path, json).context("Failed to write JSON file")?;

    tracing::info!(path = ?path, "Exported JSON");
    Ok(())
}

/// JSON export format
#[derive(Debug, Serialize)]
pub struct JsonExport {
    pub project: JsonProjectMeta,
    pub sections: Vec<JsonSection>,
}

#[derive(Debug, Serialize)]
pub struct JsonProjectMeta {
    pub name: String,
    pub location: Option<String>,
    pub exported_at: String,
}

#[derive(Debug, Serialize)]
pub struct JsonSection {
    pub id: u32,
    pub name: Option<String>,
    pub surveyor: Option<String>,
    pub date: Option<String>,
    pub color: String,
    pub shots: Vec<JsonShot>,
}

#[derive(Debug, Serialize)]
pub struct JsonShot {
    pub id: u32,
    pub length: f64,
    pub azimuth_in: f64,
    pub azimuth_out: f64,
    pub depth_in: f64,
    pub depth_out: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lrud: Option<[f64; 4]>,
    pub is_virtual: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub comment: Option<String>,
}

impl JsonExport {
    pub fn from_project(project: &Project) -> Self {
        Self {
            project: JsonProjectMeta {
                name: project.name.clone(),
                location: project.location.clone(),
                exported_at: Utc::now().to_rfc3339(),
            },
            sections: project
                .sections
                .iter()
                .map(|s| JsonSection {
                    id: s.id,
                    name: s.name.clone(),
                    surveyor: s.surveyor.clone(),
                    date: s.date.map(|d| d.to_string()),
                    color: s.color.clone(),
                    shots: s
                        .shots
                        .iter()
                        .map(|shot| JsonShot {
                            id: shot.id,
                            length: shot.length,
                            azimuth_in: shot.azimuth_in,
                            azimuth_out: shot.azimuth_out,
                            depth_in: shot.depth_in,
                            depth_out: shot.depth_out,
                            lrud: if shot.left.is_some()
                                || shot.right.is_some()
                                || shot.up.is_some()
                                || shot.down.is_some()
                            {
                                Some([
                                    shot.left.unwrap_or(0.0),
                                    shot.right.unwrap_or(0.0),
                                    shot.up.unwrap_or(0.0),
                                    shot.down.unwrap_or(0.0),
                                ])
                            } else {
                                None
                            },
                            is_virtual: shot.is_virtual,
                            comment: shot.comment.clone(),
                        })
                        .collect(),
                })
                .collect(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::{SectionData, ShotData};
    use tempfile::NamedTempFile;

    #[test]
    fn test_export_json() {
        let mut project = Project::new("Test".to_string(), None);
        project.add_section(SectionData {
            name: Some("Main".to_string()),
            surveyor: Some("Tester".to_string()),
            date: None,
            color: "#4ecdc4".to_string(),
            direction: None,
            quality: 1.0,
            shots: vec![ShotData {
                azimuth_in: 45.0,
                azimuth_out: 225.0,
                length: 10.0,
                depth_in: 5.0,
                depth_out: 6.0,
                left: Some(1.0),
                right: Some(2.0),
                up: Some(3.0),
                down: Some(4.0),
                ..Default::default()
            }],
        });

        let file = NamedTempFile::new().unwrap();
        let result = export_json(&project, file.path());
        assert!(result.is_ok());

        let contents = std::fs::read_to_string(file.path()).unwrap();
        let parsed: serde_json::Value = serde_json::from_str(&contents).unwrap();
        assert_eq!(parsed["project"]["name"], "Test");
        assert_eq!(parsed["sections"][0]["name"], "Main");
    }
}
