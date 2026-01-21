//! DMP file parser for mNemo device data
//!
//! Ported from pytool_mnemo_lib Python implementation.
//! Supports DMP versions 2-5.

use anyhow::{anyhow, bail, Context, Result};
use chrono::{NaiveDate, NaiveDateTime};
use serde::{Deserialize, Serialize};
use std::path::Path;

// ============================================================================
// Constants
// ============================================================================

/// Supported DMP file versions
const SUPPORTED_VERSIONS: &[u8] = &[2, 3, 4, 5];

/// Section start magic bytes (version > 2)
const SECTION_MAGIC: [u8; 3] = [68, 89, 101];

/// Shot start magic bytes (version >= 5)
const SHOT_START_MAGIC: [u8; 3] = [57, 67, 77];

/// Shot end magic bytes (version >= 5)
const SHOT_END_MAGIC: [u8; 3] = [95, 25, 35];

/// Get shot size in bytes for a given version
fn shot_size(version: u8) -> usize {
    match version {
        2 => 16,
        3 => 21,
        4 => 29,
        5 => 35,
        _ => 0,
    }
}

/// End-of-section patterns for splitting sections
fn end_of_section_patterns(version: u8) -> Vec<Vec<u8>> {
    match version {
        2 => vec![vec![3, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]],
        5 => {
            // Normal end sequence: shot_start_magic + type(3) + zeros + shot_end_magic
            let mut normal = vec![57, 67, 77, 3];
            normal.extend(vec![0u8; 28]);
            normal.extend(&[95, 25, 35]);

            // Buggy end sequence (sometimes legal)
            let mut buggy = vec![57, 67, 77, 3, 7, 8, 7, 8];
            buggy.extend(vec![0u8; 24]);
            buggy.extend(&[95, 25, 35]);

            vec![normal, buggy]
        }
        3 | 4 => {
            // Versions 3 and 4 use similar pattern to v2 but with different shot sizes
            let size = shot_size(version);
            let mut pattern = vec![3];
            pattern.extend(vec![0u8; size - 1]);
            vec![pattern]
        }
        _ => vec![],
    }
}

// ============================================================================
// IntBuffer - Sequential binary reading
// ============================================================================

/// Buffer for sequential reading of integer data
struct IntBuffer {
    data: Vec<u8>,
    cursor: usize,
}

impl IntBuffer {
    fn new(data: Vec<u8>) -> Self {
        Self { data, cursor: 0 }
    }

    /// Read a single byte and advance cursor
    fn read(&mut self) -> Result<u8> {
        if self.cursor >= self.data.len() {
            bail!("Reading beyond buffer at position {}", self.cursor);
        }
        let value = self.data[self.cursor];
        self.cursor += 1;
        Ok(value)
    }

    /// Read n bytes and advance cursor
    fn read_n(&mut self, n: usize) -> Result<Vec<u8>> {
        if self.cursor + n > self.data.len() {
            bail!(
                "Reading {} bytes beyond buffer at position {}",
                n,
                self.cursor
            );
        }
        let values = self.data[self.cursor..self.cursor + n].to_vec();
        self.cursor += n;
        Ok(values)
    }

    /// Read big-endian signed 16-bit integer (matches Python readInt16BE)
    /// Format: first byte is LSB * 256, second byte is MSB masked
    fn read_int16_be(&mut self) -> Result<i32> {
        let lsb = self.read()? as i32;
        let msb = self.read()? as i32;
        // Matches Python: (lsb * 2**8) + (msb & 0xFF)
        Ok((lsb << 8) + (msb & 0xFF))
    }

    /// Check if we have at least n bytes remaining
    fn has_remaining(&self, n: usize) -> bool {
        self.cursor + n <= self.data.len()
    }
}

// ============================================================================
// Data Types
// ============================================================================

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
    /// DMP version for this section
    pub version: u8,
    /// 3-character section identifier
    pub name: String,
    /// Survey direction
    pub direction: DmpDirection,
    /// Survey date and time
    pub date: NaiveDateTime,
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

impl TryFrom<u8> for DmpDirection {
    type Error = anyhow::Error;

    fn try_from(value: u8) -> Result<Self> {
        match value {
            0 => Ok(DmpDirection::In),
            1 => Ok(DmpDirection::Out),
            _ => bail!("Invalid direction value: {}", value),
        }
    }
}

/// Shot type from mNemo
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub enum DmpShotType {
    /// Cross-section A
    CsA,
    /// Cross-section B
    CsB,
    /// Standard shot
    Standard,
    /// End of survey marker
    EndOfSurvey,
}

impl TryFrom<u8> for DmpShotType {
    type Error = anyhow::Error;

    fn try_from(value: u8) -> Result<Self> {
        match value {
            0 => Ok(DmpShotType::CsA),
            1 => Ok(DmpShotType::CsB),
            2 => Ok(DmpShotType::Standard),
            3 => Ok(DmpShotType::EndOfSurvey),
            _ => bail!("Invalid shot type value: {}", value),
        }
    }
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
    /// Left passage dimension (meters), v4+
    pub left: f64,
    /// Right passage dimension (meters), v4+
    pub right: f64,
    /// Up passage dimension (meters), v4+
    pub up: f64,
    /// Down passage dimension (meters), v4+
    pub down: f64,
    /// Water temperature (celsius), v3+
    pub temperature: f64,
    /// Time: hour, v4+
    pub hour: u8,
    /// Time: minute, v4+
    pub minute: u8,
    /// Time: second, v4+
    pub second: u8,
    /// Physical marker index
    pub marker_index: u8,
    /// User comment (not parsed from DMP format; defaults to None)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub comment: Option<String>,
}

// ============================================================================
// Parsing Functions
// ============================================================================

/// Split DMP data into sections by end-of-section markers
fn split_into_sections(data: &[u8], version: u8) -> Vec<Vec<u8>> {
    let patterns = end_of_section_patterns(version);
    if patterns.is_empty() {
        return vec![];
    }

    let pattern_len = patterns[0].len();

    // If data is shorter than pattern, no sections can be found
    if data.len() < pattern_len {
        return vec![];
    }

    let mut sections = Vec::new();
    let mut start_idx = 0;

    for current_idx in 0..=data.len() - pattern_len {
        let window = &data[current_idx..current_idx + pattern_len];

        // Check if window matches any end pattern
        if patterns.iter().any(|p| p.as_slice() == window) {
            let end_idx = current_idx + pattern_len;
            sections.push(data[start_idx..end_idx].to_vec());
            start_idx = end_idx;
        }
    }

    sections
}

/// Parse a shot from buffer based on version
fn parse_shot(buffer: &mut IntBuffer, version: u8) -> Result<DmpShot> {
    // Magic values check (version >= 5)
    if version >= 5 {
        let magic = buffer.read_n(3)?;
        if magic != SHOT_START_MAGIC {
            bail!(
                "Invalid shot start magic: {:?}, expected {:?}",
                magic,
                SHOT_START_MAGIC
            );
        }
    }

    // Shot type
    let shot_type = DmpShotType::try_from(buffer.read()?)?;

    // Core shot data (all versions)
    let heading_in = buffer.read_int16_be()? as f64 / 10.0;
    let heading_out = buffer.read_int16_be()? as f64 / 10.0;
    let length = (buffer.read_int16_be()? as f64 / 100.0).max(0.0);
    let depth_in = (buffer.read_int16_be()? as f64 / 100.0).max(0.0);
    let depth_out = (buffer.read_int16_be()? as f64 / 100.0).max(0.0);
    let pitch_in = buffer.read_int16_be()? as f64 / 10.0;
    let pitch_out = buffer.read_int16_be()? as f64 / 10.0;

    // LRUD (version >= 4)
    let (left, right, up, down) = if version >= 4 {
        (
            buffer.read_int16_be()? as f64 / 100.0,
            buffer.read_int16_be()? as f64 / 100.0,
            buffer.read_int16_be()? as f64 / 100.0,
            buffer.read_int16_be()? as f64 / 100.0,
        )
    } else {
        (0.0, 0.0, 0.0, 0.0)
    };

    // Temperature and time (version >= 4 for time, >= 3 for temp in _generate but >= 4 in from_dmp)
    let (temperature, hour, minute, second) = if version >= 4 {
        (
            buffer.read_int16_be()? as f64 / 10.0,
            buffer.read()?,
            buffer.read()?,
            buffer.read()?,
        )
    } else {
        (0.0, 0, 0, 0)
    };

    // Marker index (all versions)
    let marker_index = buffer.read()?;

    // Magic values check end (version >= 5)
    if version >= 5 {
        let magic = buffer.read_n(3)?;
        if magic != SHOT_END_MAGIC {
            bail!(
                "Invalid shot end magic: {:?}, expected {:?}",
                magic,
                SHOT_END_MAGIC
            );
        }
    }

    Ok(DmpShot {
        shot_type,
        heading_in,
        heading_out,
        length,
        depth_in,
        depth_out,
        pitch_in,
        pitch_out,
        left,
        right,
        up,
        down,
        temperature,
        hour,
        minute,
        second,
        marker_index,
        comment: None,
    })
}

/// Parse a section from raw section data
fn parse_section(data: Vec<u8>) -> Result<DmpSection> {
    let mut buffer = IntBuffer::new(data);

    // Version byte
    let version = buffer.read()?;
    if !SUPPORTED_VERSIONS.contains(&version) {
        bail!("Unsupported DMP version: {}", version);
    }

    // Magic values (version > 2)
    if version > 2 {
        let magic = buffer.read_n(3)?;
        if magic != SECTION_MAGIC {
            bail!(
                "Invalid section magic: {:?}, expected {:?}",
                magic,
                SECTION_MAGIC
            );
        }
    }

    // Date: year (offset from 2000), month, day, hour, minute
    let year = buffer.read()? as i32 + 2000;
    let month = buffer.read()? as u32;
    let day = buffer.read()? as u32;
    let hour = buffer.read()? as u32;
    let minute = buffer.read()? as u32;

    // Validate date components
    if !(2016..2100).contains(&year) {
        bail!("Invalid year: {}", year);
    }
    if !(1..=12).contains(&month) {
        bail!("Invalid month: {}", month);
    }
    if !(1..=31).contains(&day) {
        bail!("Invalid day: {}", day);
    }
    if hour >= 24 {
        bail!("Invalid hour: {}", hour);
    }
    if minute >= 60 {
        bail!("Invalid minute: {}", minute);
    }

    let date = NaiveDate::from_ymd_opt(year, month, day)
        .ok_or_else(|| anyhow!("Invalid date: {}-{}-{}", year, month, day))?
        .and_hms_opt(hour, minute, 0)
        .ok_or_else(|| anyhow!("Invalid time: {}:{}", hour, minute))?;

    // Name: 3 ASCII characters
    let name_bytes = buffer.read_n(3)?;
    let name = String::from_utf8(name_bytes.clone())
        .unwrap_or_else(|_| format!("{}{}{}", name_bytes[0], name_bytes[1], name_bytes[2]));

    // Direction
    let direction = DmpDirection::try_from(buffer.read()?)?;

    // Parse shots
    let shot_len = shot_size(version);
    let mut shots = Vec::new();

    while buffer.has_remaining(shot_len) {
        match parse_shot(&mut buffer, version) {
            Ok(shot) => shots.push(shot),
            Err(e) => {
                tracing::debug!("Shot parsing ended: {}", e);
                break;
            }
        }
    }

    if shots.is_empty() {
        bail!("Section has no shots");
    }

    Ok(DmpSection {
        version,
        name,
        direction,
        date,
        shots,
    })
}

/// Parse a DMP file
///
/// DMP files are text files with semicolon-separated integers.
pub fn parse_dmp(path: &Path) -> Result<DmpFile> {
    // Verify the file exists
    if !path.exists() {
        bail!("File not found: {}", path.display());
    }

    // Verify extension
    let extension = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("");

    if extension.to_lowercase() != "dmp" {
        bail!("File is not a DMP file: {}", path.display());
    }

    // Read and parse file content
    let content = std::fs::read_to_string(path).context("Failed to read DMP file")?;

    // Parse semicolon-separated integers
    let data: Vec<u8> = content
        .trim()
        .split(';')
        .filter(|s| !s.is_empty())
        .map(|s| {
            s.trim()
                .parse::<i32>()
                .map(|v| v as u8)
                .with_context(|| format!("Invalid integer in DMP file: '{}'", s))
        })
        .collect::<Result<Vec<_>>>()?;

    if data.is_empty() {
        bail!("DMP file is empty");
    }

    // Get version from first byte
    let version = data[0];
    if !SUPPORTED_VERSIONS.contains(&version) {
        bail!(
            "Unsupported DMP version: {}. Supported: {:?}",
            version,
            SUPPORTED_VERSIONS
        );
    }

    tracing::info!(path = ?path, version = version, "Parsing DMP file");

    // Split into sections
    let section_data = split_into_sections(&data, version);
    if section_data.is_empty() {
        bail!("No sections found in DMP file");
    }

    // Parse each section
    let mut sections = Vec::new();
    for (i, section_bytes) in section_data.into_iter().enumerate() {
        match parse_section(section_bytes) {
            Ok(section) => {
                tracing::debug!(
                    section_name = %section.name,
                    shot_count = section.shots.len(),
                    "Parsed section {}",
                    i
                );
                sections.push(section);
            }
            Err(e) => {
                tracing::warn!("Failed to parse section {}: {}", i, e);
            }
        }
    }

    if sections.is_empty() {
        bail!("No valid sections found in DMP file");
    }

    tracing::info!(
        section_count = sections.len(),
        total_shots = sections.iter().map(|s| s.shots.len()).sum::<usize>(),
        "DMP file parsed successfully"
    );

    Ok(DmpFile { version, sections })
}

// ============================================================================
// Conversions to internal types
// ============================================================================

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
            comment: self.comment.clone(),
            is_virtual: false,
            marker_index: Some(self.marker_index as u32),
            temperature: Some(self.temperature),
        }
    }
}

impl DmpDirection {
    /// Convert to internal SurveyDirection
    pub fn to_survey_direction(&self) -> crate::models::SurveyDirection {
        match self {
            DmpDirection::In => crate::models::SurveyDirection::In,
            DmpDirection::Out => crate::models::SurveyDirection::Out,
        }
    }
}

impl DmpSection {
    /// Convert to our internal SectionData format
    pub fn to_section_data(&self, color: String) -> crate::models::SectionData {
        crate::models::SectionData {
            name: Some(self.name.clone()),
            surveyor: None,
            date: Some(self.date.date()),
            color,
            direction: Some(self.direction.to_survey_direction()),
            shots: self
                .shots
                .iter()
                .filter(|s| s.shot_type == DmpShotType::Standard)
                .map(|s| s.to_shot_data())
                .collect(),
        }
    }
}

// ============================================================================
// Tests
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::Datelike;
    use std::io::Write;
    use tempfile::NamedTempFile;

    #[test]
    fn test_int_buffer_read() {
        let mut buffer = IntBuffer::new(vec![1, 2, 3, 4, 5]);
        assert_eq!(buffer.read().unwrap(), 1);
        assert_eq!(buffer.read().unwrap(), 2);
        assert_eq!(buffer.read_n(2).unwrap(), vec![3, 4]);
        assert_eq!(buffer.read().unwrap(), 5);
        assert!(buffer.read().is_err());
    }

    #[test]
    fn test_int_buffer_read_int16_be() {
        // Test big-endian reading: (lsb << 8) + (msb & 0xFF)
        let mut buffer = IntBuffer::new(vec![0, 100]); // 0 * 256 + 100 = 100
        assert_eq!(buffer.read_int16_be().unwrap(), 100);

        let mut buffer = IntBuffer::new(vec![1, 0]); // 1 * 256 + 0 = 256
        assert_eq!(buffer.read_int16_be().unwrap(), 256);

        let mut buffer = IntBuffer::new(vec![14, 16]); // 14 * 256 + 16 = 3600
        assert_eq!(buffer.read_int16_be().unwrap(), 3600);
    }

    #[test]
    fn test_shot_type_conversion() {
        assert_eq!(DmpShotType::try_from(0).unwrap(), DmpShotType::CsA);
        assert_eq!(DmpShotType::try_from(1).unwrap(), DmpShotType::CsB);
        assert_eq!(DmpShotType::try_from(2).unwrap(), DmpShotType::Standard);
        assert_eq!(DmpShotType::try_from(3).unwrap(), DmpShotType::EndOfSurvey);
        assert!(DmpShotType::try_from(4).is_err());
    }

    #[test]
    fn test_direction_conversion() {
        assert_eq!(DmpDirection::try_from(0).unwrap(), DmpDirection::In);
        assert_eq!(DmpDirection::try_from(1).unwrap(), DmpDirection::Out);
        assert!(DmpDirection::try_from(2).is_err());
    }

    #[test]
    fn test_split_into_sections_v2() {
        // Create minimal v2 section data with end-of-section marker
        let mut data = vec![2]; // version
        data.extend(vec![0u8; 20]); // padding/header
        data.extend(vec![3, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]); // end marker

        let sections = split_into_sections(&data, 2);
        assert_eq!(sections.len(), 1);
    }

    #[test]
    fn test_non_existent_file() {
        let result = parse_dmp(Path::new("/nonexistent/file.dmp"));
        assert!(result.is_err());
    }

    #[test]
    fn test_empty_dmp_file() {
        let mut file = NamedTempFile::new().unwrap();
        file.write_all(b"").unwrap();

        let path = file.path().with_extension("dmp");
        std::fs::copy(file.path(), &path).unwrap();

        let result = parse_dmp(&path);
        assert!(result.is_err());

        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn test_shot_size() {
        assert_eq!(shot_size(2), 16);
        assert_eq!(shot_size(3), 21);
        assert_eq!(shot_size(4), 29);
        assert_eq!(shot_size(5), 35);
        assert_eq!(shot_size(1), 0);
    }

    #[test]
    fn test_dmp_shot_comment_serialization() {
        // Test that None comment is omitted from JSON (not serialized as null)
        let shot_no_comment = DmpShot {
            shot_type: DmpShotType::Standard,
            heading_in: 45.0,
            heading_out: 46.0,
            length: 10.0,
            depth_in: 2.0,
            depth_out: 3.0,
            pitch_in: 0.0,
            pitch_out: 0.0,
            left: 1.0,
            right: 1.0,
            up: 1.0,
            down: 1.0,
            temperature: 18.0,
            hour: 10,
            minute: 30,
            second: 0,
            marker_index: 0,
            comment: None,
        };

        let json = serde_json::to_string(&shot_no_comment).unwrap();
        // With skip_serializing_if, None should be omitted entirely
        assert!(!json.contains("comment"), "None comment should be omitted from JSON");

        // Test that Some comment is serialized
        let shot_with_comment = DmpShot {
            comment: Some("Test comment".to_string()),
            ..shot_no_comment.clone()
        };

        let json = serde_json::to_string(&shot_with_comment).unwrap();
        assert!(json.contains(r#""comment":"Test comment""#), "Some comment should be serialized");
    }

    // Integration tests with real DMP files
    #[test]
    fn test_parse_v2_dmp() {
        let test_file = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../e2e/fixtures/test_v2.dmp");
        assert!(
            test_file.exists(),
            "Fixture missing: {}",
            test_file.display()
        );

        let result = parse_dmp(&test_file);
        assert!(result.is_ok(), "Failed to parse v2 DMP: {:?}", result.err());

        let dmp = result.unwrap();
        assert_eq!(dmp.version, 2);
        assert!(!dmp.sections.is_empty(), "No sections found");

        // Check first section has shots
        let first_section = &dmp.sections[0];
        assert!(!first_section.shots.is_empty(), "First section has no shots");

        // Print summary for debugging
        println!(
            "v2 DMP: {} sections, {} total shots",
            dmp.sections.len(),
            dmp.sections.iter().map(|s| s.shots.len()).sum::<usize>()
        );
        for (i, section) in dmp.sections.iter().enumerate() {
            let standard_shots = section.shots.iter().filter(|s| s.shot_type == DmpShotType::Standard).count();
            println!(
                "  Section {}: name='{}', dir={:?}, shots={} (standard={})",
                i, section.name, section.direction, section.shots.len(), standard_shots
            );
        }
    }

    #[test]
    fn test_parse_v5_dmp() {
        let test_file = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../e2e/fixtures/test_v5.dmp");
        assert!(
            test_file.exists(),
            "Fixture missing: {}",
            test_file.display()
        );

        let result = parse_dmp(&test_file);
        assert!(result.is_ok(), "Failed to parse v5 DMP: {:?}", result.err());

        let dmp = result.unwrap();
        assert_eq!(dmp.version, 5);
        assert!(!dmp.sections.is_empty(), "No sections found");

        // Check first section has shots
        let first_section = &dmp.sections[0];
        assert!(!first_section.shots.is_empty(), "First section has no shots");

        // Print summary for debugging
        println!(
            "v5 DMP: {} sections, {} total shots",
            dmp.sections.len(),
            dmp.sections.iter().map(|s| s.shots.len()).sum::<usize>()
        );
        for (i, section) in dmp.sections.iter().enumerate() {
            let standard_shots = section.shots.iter().filter(|s| s.shot_type == DmpShotType::Standard).count();
            println!(
                "  Section {}: name='{}', dir={:?}, shots={} (standard={})",
                i, section.name, section.direction, section.shots.len(), standard_shots
            );
        }
    }

    // ============================================================================
    // Edge Case Tests (fn-37-rxr.1)
    // ============================================================================

    /// Helper to create a DMP file with given content
    fn create_dmp_file(content: &str) -> (NamedTempFile, std::path::PathBuf) {
        let mut file = NamedTempFile::new().unwrap();
        file.write_all(content.as_bytes()).unwrap();
        let path = file.path().with_extension("dmp");
        std::fs::copy(file.path(), &path).unwrap();
        (file, path)
    }

    /// Helper to build v3 format section data as semicolon-separated string
    /// V3 format: version(1) + magic(3) + date(5) + name(3) + direction(1) + shots(21 bytes each) + EOS marker
    fn build_v3_section_data() -> String {
        let mut values: Vec<i32> = Vec::new();

        // Version 3
        values.push(3);

        // Section magic (version > 2)
        values.extend(&[68, 89, 101]);

        // Date: year offset from 2000 (24 = 2024), month, day, hour, minute
        values.extend(&[24, 6, 15, 10, 30]);

        // Name: "TST" as ASCII
        values.extend(&[84, 83, 84]);

        // Direction: 0 = In
        values.push(0);

        // Shot 1 (v3 = 21 bytes: type + 7*int16 + marker)
        // type=2 (standard), heading_in=450 (45.0°), heading_out=460 (46.0°)
        // length=1000 (10.00m), depth_in=200 (2.00m), depth_out=300 (3.00m)
        // pitch_in=0, pitch_out=0, marker=1
        // int16 BE format: (val >> 8, val & 0xFF)
        values.push(2); // shot type
        values.extend(&[1, 194]); // heading_in 450: (1 << 8) + 194 = 450
        values.extend(&[1, 204]); // heading_out 460
        values.extend(&[3, 232]); // length 1000: (3 << 8) + 232 = 1000
        values.extend(&[0, 200]); // depth_in 200
        values.extend(&[1, 44]);  // depth_out 300: (1 << 8) + 44 = 300
        values.extend(&[0, 0]);   // pitch_in 0
        values.extend(&[0, 0]);   // pitch_out 0
        values.push(1); // marker_index

        // End-of-section marker for v3 (type=3 followed by zeros, total 21 bytes)
        values.push(3); // EOS type
        values.extend(vec![0; 20]); // zeros to complete 21-byte shot

        values.iter().map(|v| v.to_string()).collect::<Vec<_>>().join(";")
    }

    /// Helper to build v4 format section data as semicolon-separated string
    /// V4 format: version(1) + magic(3) + date(5) + name(3) + direction(1) + shots(29 bytes each) + EOS marker
    fn build_v4_section_data() -> String {
        let mut values: Vec<i32> = Vec::new();

        // Version 4
        values.push(4);

        // Section magic (version > 2)
        values.extend(&[68, 89, 101]);

        // Date: year offset from 2000 (24 = 2024), month, day, hour, minute
        values.extend(&[24, 8, 20, 14, 45]);

        // Name: "V4S" as ASCII
        values.extend(&[86, 52, 83]);

        // Direction: 1 = Out
        values.push(1);

        // Shot 1 (v4 = 29 bytes: type + 7*int16 + 4*int16 LRUD + int16 temp + 3 time bytes + marker)
        // type=2 (standard)
        values.push(2);

        // heading_in=900 (90.0°)
        values.extend(&[3, 132]); // 900 = (3 << 8) + 132
        // heading_out=910 (91.0°)
        values.extend(&[3, 142]); // 910
        // length=500 (5.00m)
        values.extend(&[1, 244]); // 500 = (1 << 8) + 244
        // depth_in=100 (1.00m)
        values.extend(&[0, 100]);
        // depth_out=150 (1.50m)
        values.extend(&[0, 150]);
        // pitch_in=50 (5.0°)
        values.extend(&[0, 50]);
        // pitch_out=-50 (-5.0°) - signed as two's complement
        values.extend(&[255, 206]); // -50 in BE int16

        // LRUD values (v4+): left=100 (1.00m), right=150 (1.50m), up=200 (2.00m), down=80 (0.80m)
        values.extend(&[0, 100]); // left
        values.extend(&[0, 150]); // right
        values.extend(&[0, 200]); // up
        values.extend(&[0, 80]);  // down

        // Temperature: 185 (18.5°C)
        values.extend(&[0, 185]);

        // Time: hour=14, minute=45, second=30
        values.extend(&[14, 45, 30]);

        // Marker index
        values.push(2);

        // End-of-section marker for v4 (type=3 followed by zeros, total 29 bytes)
        values.push(3); // EOS type
        values.extend(vec![0; 28]); // zeros to complete 29-byte shot

        values.iter().map(|v| v.to_string()).collect::<Vec<_>>().join(";")
    }

    /// Test 4.1: Verify DMP version 3 files (21-byte shots) are correctly parsed without LRUD data
    #[test]
    fn test_parse_dmp_v3_format() {
        let content = build_v3_section_data();
        let (_file, path) = create_dmp_file(&content);

        let result = parse_dmp(&path);
        std::fs::remove_file(&path).ok();

        assert!(result.is_ok(), "Failed to parse v3 DMP: {:?}", result.err());

        let dmp = result.unwrap();
        assert_eq!(dmp.version, 3, "Version should be 3");
        assert_eq!(dmp.sections.len(), 1, "Should have 1 section");

        let section = &dmp.sections[0];
        assert_eq!(section.version, 3, "Section version should be 3");
        assert_eq!(section.name, "TST", "Section name should be TST");
        assert_eq!(section.direction, DmpDirection::In, "Direction should be In");

        // Check date parsing
        assert_eq!(section.date.year(), 2024, "Year should be 2024");
        assert_eq!(section.date.month(), 6, "Month should be 6");
        assert_eq!(section.date.day(), 15, "Day should be 15");

        // Should have at least one shot (excluding EOS)
        assert!(!section.shots.is_empty(), "Should have shots");

        // V3 does not have LRUD data - check that LRUD values are zero
        let shot = &section.shots[0];
        assert_eq!(shot.left, 0.0, "V3 should have no left LRUD");
        assert_eq!(shot.right, 0.0, "V3 should have no right LRUD");
        assert_eq!(shot.up, 0.0, "V3 should have no up LRUD");
        assert_eq!(shot.down, 0.0, "V3 should have no down LRUD");

        // But basic shot data should be parsed
        assert!(shot.heading_in > 0.0, "Should have heading_in");
        assert!(shot.length > 0.0, "Should have length");
    }

    /// Test 4.2: Verify DMP version 4 files (29-byte shots) correctly extract LRUD data and direction field
    #[test]
    fn test_parse_dmp_v4_with_lrud() {
        let content = build_v4_section_data();
        let (_file, path) = create_dmp_file(&content);

        let result = parse_dmp(&path);
        std::fs::remove_file(&path).ok();

        assert!(result.is_ok(), "Failed to parse v4 DMP: {:?}", result.err());

        let dmp = result.unwrap();
        assert_eq!(dmp.version, 4, "Version should be 4");
        assert_eq!(dmp.sections.len(), 1, "Should have 1 section");

        let section = &dmp.sections[0];
        assert_eq!(section.version, 4, "Section version should be 4");
        assert_eq!(section.name, "V4S", "Section name should be V4S");
        assert_eq!(section.direction, DmpDirection::Out, "Direction should be Out");

        // Check date parsing
        assert_eq!(section.date.year(), 2024, "Year should be 2024");
        assert_eq!(section.date.month(), 8, "Month should be 8");
        assert_eq!(section.date.day(), 20, "Day should be 20");

        // Should have at least one shot
        assert!(!section.shots.is_empty(), "Should have shots");

        let shot = &section.shots[0];

        // V4 should have LRUD data
        assert_eq!(shot.left, 1.0, "Left LRUD should be 1.0m");
        assert_eq!(shot.right, 1.5, "Right LRUD should be 1.5m");
        assert_eq!(shot.up, 2.0, "Up LRUD should be 2.0m");
        assert_eq!(shot.down, 0.8, "Down LRUD should be 0.8m");

        // V4 should have temperature
        assert!((shot.temperature - 18.5).abs() < 0.1, "Temperature should be 18.5°C");

        // V4 should have time
        assert_eq!(shot.hour, 14, "Hour should be 14");
        assert_eq!(shot.minute, 45, "Minute should be 45");
        assert_eq!(shot.second, 30, "Second should be 30");

        // Basic shot data
        assert_eq!(shot.heading_in, 90.0, "Heading in should be 90.0°");
        assert_eq!(shot.length, 5.0, "Length should be 5.0m");
        assert_eq!(shot.pitch_in, 5.0, "Pitch in should be 5.0°");
    }

    /// Test 4.3: Verify graceful error handling for files with invalid magic bytes or corrupted headers
    #[test]
    fn test_parse_dmp_corrupted_header() {
        // Test case 1: Wrong magic bytes
        let mut values: Vec<i32> = Vec::new();
        values.push(3); // Version 3 (expects magic)
        values.extend(&[99, 99, 99]); // Wrong magic (should be [68, 89, 101])
        values.extend(&[24, 6, 15, 10, 30]); // Valid date
        values.extend(&[84, 83, 84]); // Name "TST"
        values.push(0); // Direction
        let content = values.iter().map(|v| v.to_string()).collect::<Vec<_>>().join(";");

        let (_file1, path1) = create_dmp_file(&content);
        let result1 = parse_dmp(&path1);
        std::fs::remove_file(&path1).ok();

        // Should fail with invalid magic
        assert!(result1.is_err(), "Should fail with wrong magic bytes");
        let err_msg = result1.unwrap_err().to_string();
        assert!(
            err_msg.contains("magic") || err_msg.contains("section"),
            "Error should mention magic or section issue: {}",
            err_msg
        );

        // Test case 2: Truncated magic (not enough bytes)
        let content2 = "3;68;89"; // Version + incomplete magic
        let (_file2, path2) = create_dmp_file(content2);
        let result2 = parse_dmp(&path2);
        std::fs::remove_file(&path2).ok();

        assert!(result2.is_err(), "Should fail with truncated magic");

        // Test case 3: Invalid version (unsupported version 1)
        let content3 = "1;0;0;0;0;0;0;0;0;0";
        let (_file3, path3) = create_dmp_file(content3);
        let result3 = parse_dmp(&path3);
        std::fs::remove_file(&path3).ok();

        assert!(result3.is_err(), "Should fail with unsupported version");
        let err_msg3 = result3.unwrap_err().to_string();
        assert!(
            err_msg3.contains("version") || err_msg3.contains("Unsupported"),
            "Error should mention version issue: {}",
            err_msg3
        );

        // Test case 4: Version 0 (completely invalid)
        let content4 = "0;0;0;0;0;0;0;0;0;0";
        let (_file4, path4) = create_dmp_file(content4);
        let result4 = parse_dmp(&path4);
        std::fs::remove_file(&path4).ok();

        assert!(result4.is_err(), "Should fail with version 0");
    }

    /// Test 4.4: Verify graceful handling when file ends unexpectedly mid-section or mid-shot
    #[test]
    fn test_parse_dmp_truncated_file() {
        // Test case 1: Mid-header truncation (version present but header incomplete)
        let content1 = "3;68;89;101;24;6"; // Version + magic + partial date
        let (_file1, path1) = create_dmp_file(content1);
        let result1 = parse_dmp(&path1);
        std::fs::remove_file(&path1).ok();

        assert!(result1.is_err(), "Should fail with truncated header");

        // Test case 2: Header complete but no shots (missing EOS marker too)
        let mut values2: Vec<i32> = Vec::new();
        values2.push(3); // Version 3
        values2.extend(&[68, 89, 101]); // Magic
        values2.extend(&[24, 6, 15, 10, 30]); // Date
        values2.extend(&[84, 83, 84]); // Name "TST"
        values2.push(0); // Direction
        // No shots, no EOS marker
        let content2 = values2.iter().map(|v| v.to_string()).collect::<Vec<_>>().join(";");

        let (_file2, path2) = create_dmp_file(&content2);
        let result2 = parse_dmp(&path2);
        std::fs::remove_file(&path2).ok();

        // Should fail because no sections found (no EOS marker to split on)
        assert!(result2.is_err(), "Should fail with no sections/shots");

        // Test case 3: Mid-shot truncation (partial shot data)
        let mut values3: Vec<i32> = Vec::new();
        values3.push(3); // Version 3
        values3.extend(&[68, 89, 101]); // Magic
        values3.extend(&[24, 6, 15, 10, 30]); // Date
        values3.extend(&[84, 83, 84]); // Name "TST"
        values3.push(0); // Direction
        // Partial shot - only type and first heading bytes
        values3.push(2); // Shot type
        values3.extend(&[1, 194]); // heading_in
        values3.extend(&[1, 204]); // heading_out
        // Missing the rest of shot data and EOS marker
        let content3 = values3.iter().map(|v| v.to_string()).collect::<Vec<_>>().join(";");

        let (_file3, path3) = create_dmp_file(&content3);
        let result3 = parse_dmp(&path3);
        std::fs::remove_file(&path3).ok();

        // Should fail because incomplete data won't find EOS marker
        assert!(result3.is_err(), "Should fail with truncated shot data");
    }

    /// Test 4.5: Verify no panic and graceful handling when date fields contain invalid values
    ///
    /// Note: The parser catches section-level errors and logs them as warnings, then continues.
    /// If all sections fail to parse (due to invalid dates), the overall parse fails with
    /// "No valid sections found". The key requirement is that invalid dates don't cause panics.
    #[test]
    fn test_parse_dmp_invalid_date_values() {
        // Helper to create section data with specific date values
        fn make_section_with_date(year_offset: i32, month: i32, day: i32, hour: i32, minute: i32) -> String {
            let mut values: Vec<i32> = Vec::new();
            values.push(3); // Version 3
            values.extend(&[68, 89, 101]); // Magic
            values.extend(&[year_offset, month, day, hour, minute]); // Date
            values.extend(&[84, 83, 84]); // Name "TST"
            values.push(0); // Direction
            // Valid shot
            values.push(2); // type
            values.extend(&[1, 194, 1, 204, 3, 232, 0, 200, 1, 44, 0, 0, 0, 0]); // shot data
            values.push(1); // marker
            // EOS marker
            values.push(3);
            values.extend(vec![0; 20]);
            values.iter().map(|v| v.to_string()).collect::<Vec<_>>().join(";")
        }

        // Test case 1: Month 13 (invalid)
        let content1 = make_section_with_date(24, 13, 15, 10, 30);
        let (_file1, path1) = create_dmp_file(&content1);
        let result1 = parse_dmp(&path1);
        std::fs::remove_file(&path1).ok();

        // Should not panic, and should return error (either specific or "no valid sections")
        assert!(result1.is_err(), "Should fail with month 13");
        // Just verify we got an error without panicking - the actual message depends on implementation

        // Test case 2: Day 32 (invalid for any month)
        let content2 = make_section_with_date(24, 6, 32, 10, 30);
        let (_file2, path2) = create_dmp_file(&content2);
        let result2 = parse_dmp(&path2);
        std::fs::remove_file(&path2).ok();

        assert!(result2.is_err(), "Should fail with day 32");

        // Test case 3: February 30 (invalid - Feb never has 30 days)
        let content3 = make_section_with_date(24, 2, 30, 10, 30);
        let (_file3, path3) = create_dmp_file(&content3);
        let result3 = parse_dmp(&path3);
        std::fs::remove_file(&path3).ok();

        assert!(result3.is_err(), "Should fail with Feb 30");

        // Test case 4: Year 0 (year offset of -200 would be year 1800, but we validate 2016-2100)
        // Using year offset 10 = year 2010, which is outside 2016-2100 range
        let content4 = make_section_with_date(10, 6, 15, 10, 30); // year 2010 - before 2016
        let (_file4, path4) = create_dmp_file(&content4);
        let result4 = parse_dmp(&path4);
        std::fs::remove_file(&path4).ok();

        assert!(result4.is_err(), "Should fail with year outside valid range");

        // Test case 5: Hour 25 (invalid)
        let content5 = make_section_with_date(24, 6, 15, 25, 30);
        let (_file5, path5) = create_dmp_file(&content5);
        let result5 = parse_dmp(&path5);
        std::fs::remove_file(&path5).ok();

        assert!(result5.is_err(), "Should fail with hour 25");

        // Test case 6: Minute 60 (invalid)
        let content6 = make_section_with_date(24, 6, 15, 10, 60);
        let (_file6, path6) = create_dmp_file(&content6);
        let result6 = parse_dmp(&path6);
        std::fs::remove_file(&path6).ok();

        assert!(result6.is_err(), "Should fail with minute 60");

        // All tests completed without panicking - that's the key requirement
        println!("All invalid date tests completed without panicking");
    }
}
