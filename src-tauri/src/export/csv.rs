use anyhow::{Context, Result};
use std::io::Write;
use std::path::Path;

use crate::models::Project;

/// Export project data to CSV format
pub fn export_csv(project: &Project, path: &Path) -> Result<()> {
    let mut file = std::fs::File::create(path).context("Failed to create CSV file")?;

    // Write header
    writeln!(
        file,
        "section_id,section_name,shot_id,length,azimuth_in,azimuth_out,depth_in,depth_out,left,right,up,down,is_virtual,comment"
    )?;

    // Write shots
    for section in &project.sections {
        let section_name = section.name.as_deref().unwrap_or("");

        for shot in &section.shots {
            writeln!(
                file,
                "{},{},{},{:.2},{:.1},{:.1},{:.2},{:.2},{},{},{},{},{},{}",
                section.id,
                escape_csv(section_name),
                shot.id,
                shot.length,
                shot.azimuth_in,
                shot.azimuth_out,
                shot.depth_in,
                shot.depth_out,
                format_optional(shot.left),
                format_optional(shot.right),
                format_optional(shot.up),
                format_optional(shot.down),
                shot.is_virtual,
                escape_csv(shot.comment.as_deref().unwrap_or(""))
            )?;
        }
    }

    tracing::info!(path = ?path, "Exported CSV");
    Ok(())
}

/// Escape a string for CSV
fn escape_csv(s: &str) -> String {
    if s.contains(',') || s.contains('"') || s.contains('\n') {
        format!("\"{}\"", s.replace('"', "\"\""))
    } else {
        s.to_string()
    }
}

/// Format an optional f64 value
fn format_optional(value: Option<f64>) -> String {
    value.map(|v| format!("{:.2}", v)).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::{SectionData, ShotData};
    use tempfile::NamedTempFile;

    #[test]
    fn test_export_csv() {
        let mut project = Project::new("Test".to_string(), None);
        project.add_section(SectionData {
            name: Some("Main".to_string()),
            surveyor: None,
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
                ..Default::default()
            }],
        });

        let file = NamedTempFile::new().unwrap();
        let result = export_csv(&project, file.path());
        assert!(result.is_ok());

        let contents = std::fs::read_to_string(file.path()).unwrap();
        assert!(contents.contains("section_id,section_name"));
        assert!(contents.contains("Main"));
        assert!(contents.contains("10.00"));
    }

    #[test]
    fn test_escape_csv_handles_commas_quotes_and_newlines() {
        assert_eq!(escape_csv("plain"), "plain");
        assert_eq!(escape_csv("a,b"), "\"a,b\"");
        assert_eq!(escape_csv("a\"b"), "\"a\"\"b\"");
        assert_eq!(escape_csv("a\nb"), "\"a\nb\"");
        assert_eq!(escape_csv("a,\"b\""), "\"a,\"\"b\"\"\"");
    }

    #[test]
    fn test_format_optional_outputs_two_decimals_or_empty() {
        assert_eq!(format_optional(Some(1.234)), "1.23");
        assert_eq!(format_optional(Some(1.235)), "1.24");
        assert_eq!(format_optional(None), "");
    }
}
