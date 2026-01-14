//! DMP file parser for mNemo device data
//!
//! This is a stub implementation. The actual binary format parsing
//! will be implemented when the format specification is available.

use anyhow::{Context, Result};
use chrono::NaiveDate;
use serde::{Deserialize, Serialize};
use std::path::Path;

/// Parsed DMP file
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DmpFile {
    /// File format version (2-5)
    pub version: u8,
    /// Sections in the file
    pub sections: Vec<DmpSection>,
}

/// A section from a DMP file
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DmpSection {
    /// 3-character section identifier
    pub name: String,
    /// Survey direction
    pub direction: DmpDirection,
    /// Survey date
    pub date: NaiveDate,
    /// Shots in this section
    pub shots: Vec<DmpShot>,
}

/// Survey direction
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum DmpDirection {
    In,
    Out,
}

/// Shot type from mNemo
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub enum DmpShotType {
    /// Standard shot
    Standard,
    /// Cross-section A
    CsA,
    /// Cross-section B
    CsB,
    /// End of survey marker
    EndOfSurvey,
}

/// A shot from a DMP file
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DmpShot {
    /// Shot type
    pub shot_type: DmpShotType,
    /// Heading when entering (degrees)
    pub heading_in: f64,
    /// Heading when exiting (degrees)
    pub heading_out: f64,
    /// Length in meters
    pub length: f64,
    /// Depth at start (meters)
    pub depth_in: f64,
    /// Depth at end (meters)
    pub depth_out: f64,
    /// Pitch when entering (degrees)
    pub pitch_in: f64,
    /// Pitch when exiting (degrees)
    pub pitch_out: f64,
    /// Left passage dimension (meters)
    pub left: f64,
    /// Right passage dimension (meters)
    pub right: f64,
    /// Up passage dimension (meters)
    pub up: f64,
    /// Down passage dimension (meters)
    pub down: f64,
    /// Water temperature (celsius)
    pub temperature: f64,
    /// Time: hour
    pub hour: u8,
    /// Time: minute
    pub minute: u8,
    /// Time: second
    pub second: u8,
    /// Physical marker index
    pub marker_index: u8,
}

/// Parse a DMP file
///
/// This is a stub implementation that returns an empty file.
/// The actual binary parsing will be implemented when the format
/// specification becomes available.
pub fn parse_dmp(path: &Path) -> Result<DmpFile> {
    tracing::warn!(
        path = ?path,
        "DMP parser is a stub - real implementation pending format specification"
    );

    // Verify the file exists and has .dmp extension
    if !path.exists() {
        anyhow::bail!("File not found: {}", path.display());
    }

    let extension = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("");

    if extension.to_lowercase() != "dmp" {
        anyhow::bail!("File is not a DMP file: {}", path.display());
    }

    // Read file to verify it's readable
    let _data = std::fs::read(path).context("Failed to read DMP file")?;

    // TODO: Implement actual binary parsing
    // The format includes:
    // - Header with version info
    // - Section headers with 3-char names
    // - Shot records with compass/depth/LRUD data
    // Reference: pytool_mnemo_lib

    Ok(DmpFile {
        version: 0,
        sections: Vec::new(),
    })
}

impl DmpShot {
    /// Convert to our internal ShotData format
    pub fn to_shot_data(&self) -> crate::models::ShotData {
        crate::models::ShotData {
            azimuth_in: self.heading_in,
            azimuth_out: self.heading_out,
            length: self.length,
            depth_in: self.depth_in,
            depth_out: self.depth_out,
            pitch_in: Some(self.pitch_in),
            pitch_out: Some(self.pitch_out),
            left: Some(self.left),
            right: Some(self.right),
            up: Some(self.up),
            down: Some(self.down),
            comment: None,
            is_virtual: false,
            marker_index: Some(self.marker_index as u32),
            temperature: Some(self.temperature),
        }
    }
}

impl DmpSection {
    /// Convert to our internal SectionData format
    pub fn to_section_data(&self, color: String) -> crate::models::SectionData {
        crate::models::SectionData {
            name: Some(self.name.clone()),
            surveyor: None,
            date: Some(self.date),
            color,
            shots: self
                .shots
                .iter()
                .filter(|s| s.shot_type == DmpShotType::Standard)
                .map(|s| s.to_shot_data())
                .collect(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use tempfile::NamedTempFile;

    #[test]
    fn test_stub_parser_returns_empty() {
        // Create a temporary .dmp file
        let mut file = NamedTempFile::new().unwrap();
        file.write_all(b"dummy dmp content").unwrap();

        let path = file.path().with_extension("dmp");
        std::fs::copy(file.path(), &path).unwrap();

        let result = parse_dmp(&path);
        assert!(result.is_ok());

        let dmp = result.unwrap();
        assert_eq!(dmp.version, 0);
        assert!(dmp.sections.is_empty());

        // Cleanup
        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn test_non_existent_file() {
        let result = parse_dmp(Path::new("/nonexistent/file.dmp"));
        assert!(result.is_err());
    }
}
