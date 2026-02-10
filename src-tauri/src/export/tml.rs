//! Ariane TML/TMLU export.
//!
//! `.tml` files are ZIP archives containing `Data.xml`; `.tmlu` files are plain
//! XML.  TML uses long element names (`SurveyData`, `Azimut`, …) while TMLU
//! uses short abbreviations (`SRVD`, `AZ`, …).  This module faithfully
//! reproduces the naming convention used by Ariane.
//!
//! Key Ariane format rules learned from real files:
//! - Only **one** START shot exists (the root of the entire survey graph).
//!   Branch sections connect via `FromID` on their first REAL/VIRTUAL shot
//!   pointing directly to the parent station — no extra START nodes.
//! - The ID element uses all-caps `<ID>` (not `<Id>`).
//! - Every shot carries `<Locked>`, `<Name>`, and `<Profiletype>` fields.

use std::collections::HashMap;
use std::io::{Cursor, Write as _};
use std::path::Path;

use anyhow::{Context, Result};
use quick_xml::events::{BytesDecl, BytesEnd, BytesStart, BytesText, Event};
use quick_xml::Writer;

use crate::models::{Project, SectionId, StationRef};

// ============================================================================
// Element‐name map (long vs. short)
// ============================================================================

/// Provides XML element names matching the target format.
struct Names {
    cave_file: &'static str,
    cave_name: &'static str,
    unit: &'static str,
    use_magnetic_azimuth: &'static str,
    first_start_absolute_elevation: &'static str,
    data: &'static str,
    survey_data: &'static str,
    id: &'static str,
    from_id: &'static str,
    shot_type: &'static str,
    section: &'static str,
    azimuth: &'static str,
    length: &'static str,
    depth: &'static str,
    depth_in: &'static str,
    inclination: &'static str,
    left: &'static str,
    right: &'static str,
    up: &'static str,
    down: &'static str,
    comment: &'static str,
    explorer: &'static str,
    date: &'static str,
    color: &'static str,
    excluded: &'static str,
    latitude: &'static str,
    longitude: &'static str,
    closure_to_id: &'static str,
    locked: &'static str,
    name: &'static str,
    profiletype: &'static str,
}

/// Long names (used by `.tml` ZIP files).
const LONG: Names = Names {
    cave_file: "CaveFile",
    cave_name: "caveName",
    unit: "unit",
    use_magnetic_azimuth: "useMagneticAzimuth",
    first_start_absolute_elevation: "firstStartAbsoluteElevation",
    data: "Data",
    survey_data: "SurveyData",
    id: "ID",
    from_id: "FromID",
    shot_type: "Type",
    section: "Section",
    azimuth: "Azimut",
    length: "Length",
    depth: "Depth",
    depth_in: "DepthIn",
    inclination: "Inclination",
    left: "Left",
    right: "Right",
    up: "Up",
    down: "Down",
    comment: "Comment",
    explorer: "Explorer",
    date: "Date",
    color: "Color",
    excluded: "Excluded",
    latitude: "Latitude",
    longitude: "Longitude",
    closure_to_id: "ClosureToID",
    locked: "Locked",
    name: "Name",
    profiletype: "Profiletype",
};

/// Short names (used by `.tmlu` plain-XML files).
const SHORT: Names = Names {
    cave_file: "CaveFile",
    cave_name: "caveName",
    unit: "unit",
    use_magnetic_azimuth: "useMagneticAzimuth",
    first_start_absolute_elevation: "firstStartAbsoluteElevation",
    data: "Data",
    survey_data: "SRVD",
    id: "ID",
    from_id: "FRID",
    shot_type: "TY",
    section: "SC",
    azimuth: "AZ",
    length: "LG",
    depth: "DP",
    depth_in: "DPI",
    inclination: "INC",
    left: "L",
    right: "R",
    up: "U",
    down: "D",
    comment: "CM",
    explorer: "EX",
    date: "DT",
    color: "CL",
    excluded: "EXC",
    latitude: "LT",
    longitude: "LGT",
    closure_to_id: "CID",
    locked: "LCK",
    name: "NM",
    profiletype: "PT",
};

// ============================================================================
// Internal shot representation for export
// ============================================================================

#[derive(Debug)]
struct ExportShot {
    id: i64,
    from_id: i64,
    shot_type: &'static str, // "START", "REAL", "VIRTUAL", "CLOSURE"
    section: String,
    azimuth: f64,
    length: f64,
    depth: f64,       // absolute station depth (cumulative)
    depth_in: f64,    // -1.0 if same as previous depth
    inclination: f64,
    left: f64,
    right: f64,
    up: f64,
    down: f64,
    comment: Option<String>,
    explorer: Option<String>,
    date: Option<String>,
    color: String, // "0xRRGGBBff"
    closure_to_id: i64,
    locked: bool,
}

// ============================================================================
// Public API
// ============================================================================

/// Export a project to Ariane TML (`.tml` = ZIP) or TMLU (`.tmlu` = plain XML).
pub fn export_tml(project: &Project, path: &Path) -> Result<()> {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .map(str::to_lowercase)
        .unwrap_or_default();

    let use_long = ext == "tml";
    let names = if use_long { &LONG } else { &SHORT };

    let xml = build_xml(project, names)?;

    match ext.as_str() {
        "tml" => write_zip(path, &xml),
        "tmlu" => std::fs::write(path, &xml).context("Failed to write TMLU file"),
        _ => std::fs::write(path, &xml).context("Failed to write TML export file"),
    }
}

// ============================================================================
// XML generation
// ============================================================================

fn build_xml(project: &Project, n: &Names) -> Result<Vec<u8>> {
    let shots = build_export_shots(project);

    let mut buf = Vec::new();
    let mut writer = Writer::new_with_indent(Cursor::new(&mut buf), b' ', 4);

    // <?xml version="1.0" encoding="UTF-8" standalone="yes"?>
    writer.write_event(Event::Decl(BytesDecl::new(
        "1.0",
        Some("UTF-8"),
        Some("yes"),
    )))?;

    // <CaveFile>
    writer.write_event(Event::Start(BytesStart::new(n.cave_file)))?;

    // Metadata elements
    write_text_element(&mut writer, n.cave_name, &project.name)?;
    write_text_element(
        &mut writer,
        n.first_start_absolute_elevation,
        &format_f64(
            project
                .zero_datums
                .first()
                .map(|zd| zd.gps.depth_reference)
                .unwrap_or(0.0),
        ),
    )?;

    // <Data>
    writer.write_event(Event::Start(BytesStart::new(n.data)))?;

    for shot in &shots {
        write_shot(&mut writer, n, shot)?;
    }

    // </Data>
    writer.write_event(Event::End(BytesEnd::new(n.data)))?;

    // Remaining metadata after Data (matching Ariane's ordering)
    write_text_element(&mut writer, n.unit, "m")?;
    write_text_element(&mut writer, n.use_magnetic_azimuth, "true")?;

    // </CaveFile>
    writer.write_event(Event::End(BytesEnd::new(n.cave_file)))?;

    drop(writer);
    Ok(buf)
}

fn write_text_element<W: std::io::Write>(
    writer: &mut Writer<W>,
    tag: &str,
    text: &str,
) -> Result<()> {
    writer.write_event(Event::Start(BytesStart::new(tag)))?;
    writer.write_event(Event::Text(BytesText::new(text)))?;
    writer.write_event(Event::End(BytesEnd::new(tag)))?;
    Ok(())
}

fn write_shot<W: std::io::Write>(
    writer: &mut Writer<W>,
    n: &Names,
    shot: &ExportShot,
) -> Result<()> {
    writer.write_event(Event::Start(BytesStart::new(n.survey_data)))?;

    // Write fields in alphabetical order (matching Ariane's output)
    write_text_element(writer, n.azimuth, &format_f64(shot.azimuth))?;
    write_text_element(writer, n.closure_to_id, &shot.closure_to_id.to_string())?;
    write_text_element(writer, n.color, &shot.color)?;

    let comment_str = shot.comment.as_deref().unwrap_or("");
    write_text_element(writer, n.comment, comment_str)?;

    let date_str = shot.date.as_deref().unwrap_or("2000-01-01");
    write_text_element(writer, n.date, date_str)?;

    write_text_element(writer, n.depth, &format_f64(shot.depth))?;
    write_text_element(writer, n.depth_in, &format_f64(shot.depth_in))?;
    write_text_element(writer, n.down, &format_f64(shot.down))?;
    write_text_element(writer, n.excluded, "false")?;

    let explorer_str = shot.explorer.as_deref().unwrap_or("unknown");
    write_text_element(writer, n.explorer, explorer_str)?;

    write_text_element(writer, n.from_id, &shot.from_id.to_string())?;
    write_text_element(writer, n.id, &shot.id.to_string())?;
    write_text_element(writer, n.inclination, &format_f64(shot.inclination))?;
    write_text_element(writer, n.latitude, "0.0")?;
    write_text_element(writer, n.left, &format_f64(shot.left))?;
    write_text_element(writer, n.length, &format_f64(shot.length))?;
    write_text_element(
        writer,
        n.locked,
        if shot.locked { "true" } else { "false" },
    )?;
    write_text_element(writer, n.longitude, "0.0")?;

    // Name field: START shots get "START", others get empty
    let name_str = if shot.shot_type == "START" {
        "START"
    } else {
        ""
    };
    write_text_element(writer, n.name, name_str)?;

    write_text_element(writer, n.profiletype, "VERTICAL")?;
    write_text_element(writer, n.right, &format_f64(shot.right))?;
    write_text_element(writer, n.section, &shot.section)?;
    write_text_element(writer, n.shot_type, shot.shot_type)?;
    write_text_element(writer, n.up, &format_f64(shot.up))?;

    writer.write_event(Event::End(BytesEnd::new(n.survey_data)))?;
    Ok(())
}

/// Format an f64 without unnecessary trailing zeros but preserving at least one
/// decimal place (Ariane convention).
fn format_f64(v: f64) -> String {
    if v == 0.0 {
        return "0.0".to_string();
    }
    // Use enough precision to round-trip, then strip trailing zeros
    let s = format!("{v:.6}");
    let s = s.trim_end_matches('0');
    // Ensure at least one digit after the decimal point
    if s.ends_with('.') {
        format!("{s}0")
    } else {
        s.to_string()
    }
}

// ============================================================================
// ZIP wrapper
// ============================================================================

fn write_zip(path: &Path, xml: &[u8]) -> Result<()> {
    let file = std::fs::File::create(path).context("Failed to create TML file")?;
    let mut zip = zip::ZipWriter::new(file);

    let options = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated);

    zip.start_file("Data.xml", options)
        .context("Failed to start Data.xml in ZIP")?;
    zip.write_all(xml)
        .context("Failed to write Data.xml to ZIP")?;
    zip.finish().context("Failed to finalize TML ZIP")?;

    Ok(())
}

// ============================================================================
// Build flat shot list from project model
// ============================================================================

fn build_export_shots(project: &Project) -> Vec<ExportShot> {
    if project.sections.is_empty() {
        return Vec::new();
    }

    // Build a merge lookup: for each section, find which station in another
    // section it is connected to (child → parent).
    let parent_map = build_parent_map(project);

    // Find the root section (the one with no parent in parent_map).
    // If multiple roots exist, pick the one with the lowest ID.
    let root_section_id = project
        .sections
        .iter()
        .map(|s| s.id)
        .find(|id| !parent_map.contains_key(id))
        .unwrap_or(project.sections[0].id);

    let mut next_id: i64 = 0;

    struct SectionBlock {
        section_id: SectionId,
        /// Index of the first shot in `shots` that needs its from_id resolved
        /// (for child sections, the first REAL/VIRTUAL shot).
        needs_parent_link: bool,
        shots: Vec<ExportShot>,
    }

    let mut blocks: Vec<SectionBlock> = Vec::new();
    // Map: (section_id, station_index) → ariane_id
    let mut station_to_ariane: HashMap<(SectionId, u32), i64> = HashMap::new();

    for section in &project.sections {
        let is_root = section.id == root_section_id;

        let section_name = section
            .name
            .as_deref()
            .unwrap_or(&format!("Section {}", section.id))
            .to_string();
        let color = color_to_ariane(&section.color);
        let explorer = section.surveyor.clone();
        let date = section.date.map(|d| d.format("%Y-%m-%d").to_string());

        let mut shots = Vec::new();

        if is_root {
            // Only the root section gets a START shot
            let start_id = next_id;
            next_id += 1;

            let start_depth = if let Some(first_shot) = section.shots.first() {
                first_shot.depth_in
            } else {
                0.0
            };

            shots.push(ExportShot {
                id: start_id,
                from_id: -1,
                shot_type: "START",
                section: section_name.clone(),
                azimuth: 0.0,
                length: 0.0,
                depth: start_depth,
                depth_in: start_depth,
                inclination: 0.0,
                left: 0.0,
                right: 0.0,
                up: 0.0,
                down: 0.0,
                comment: Some("START".to_string()),
                explorer: explorer.clone(),
                date: date.clone(),
                color: color.clone(),
                closure_to_id: -1,
                locked: true,
            });

            station_to_ariane.insert((section.id, 0), start_id);
        }
        // For non-root sections, station 0 will be mapped when we assign
        // the first shot's ariane ID (handled below after the loop).

        let mut cumulative_depth: f64 = if let Some(first_shot) = section.shots.first() {
            first_shot.depth_in
        } else {
            0.0
        };

        for (i, shot) in section.shots.iter().enumerate() {
            let shot_ariane_id = next_id;
            next_id += 1;

            // Chain from_id: first shot chains from START (root) or placeholder (child)
            let prev_id = if i == 0 {
                if is_root {
                    // Chain from the START shot
                    shots[0].id
                } else {
                    // Placeholder — will be resolved in second pass
                    -1
                }
            } else {
                shot_ariane_id - 1
            };

            let prev_depth = cumulative_depth;
            cumulative_depth = shot.depth_out;
            let depth_in_val = if (shot.depth_in - prev_depth).abs() < 1e-9 {
                -1.0
            } else {
                shot.depth_in
            };

            shots.push(ExportShot {
                id: shot_ariane_id,
                from_id: prev_id,
                shot_type: if shot.is_reference { "VIRTUAL" } else { "REAL" },
                section: section_name.clone(),
                azimuth: shot.azimuth_in,
                length: shot.length,
                depth: shot.depth_out,
                depth_in: depth_in_val,
                inclination: shot.pitch_in.unwrap_or(0.0),
                left: shot.left.unwrap_or(0.0),
                right: shot.right.unwrap_or(0.0),
                up: shot.up.unwrap_or(0.0),
                down: shot.down.unwrap_or(0.0),
                comment: shot.comment.clone(),
                explorer: explorer.clone(),
                date: date.clone(),
                color: color.clone(),
                closure_to_id: -1,
                locked: false,
            });

            // Station (i+1) is after this shot
            station_to_ariane.insert((section.id, (i + 1) as u32), shot_ariane_id);
        }

        // For non-root sections, map station 0 to the first shot's ariane ID.
        // The first shot itself represents the connection from the parent station.
        if !is_root {
            if let Some(first_real) = shots.first() {
                station_to_ariane.insert((section.id, 0), first_real.id);
            }
        }

        blocks.push(SectionBlock {
            section_id: section.id,
            needs_parent_link: !is_root && !shots.is_empty(),
            shots,
        });
    }

    // Second pass: for child sections, resolve the first shot's from_id
    // to point to the parent station's ariane ID.
    for block in &mut blocks {
        if !block.needs_parent_link {
            continue;
        }
        if let Some((parent_station, _child_station_idx)) = parent_map.get(&block.section_id) {
            if let Some(&parent_ariane_id) =
                station_to_ariane.get(&(parent_station.section_id, parent_station.station_index))
            {
                // First shot in block is the first REAL/VIRTUAL shot
                block.shots[0].from_id = parent_ariane_id;
            }
        }
    }

    // Third pass: generate CLOSURE shots from loop_closures
    let mut closure_shots = Vec::new();
    for closure in &project.loop_closures {
        let from_ariane = station_to_ariane
            .get(&(closure.station_a.section_id, closure.station_a.station_index));
        let to_ariane = station_to_ariane
            .get(&(closure.station_b.section_id, closure.station_b.station_index));

        if let (Some(&from_id), Some(&to_id)) = (from_ariane, to_ariane) {
            let closure_id = next_id;
            next_id += 1;

            let section_name = project
                .sections
                .iter()
                .find(|s| s.id == closure.station_a.section_id)
                .and_then(|s| s.name.clone())
                .unwrap_or_else(|| format!("Section {}", closure.station_a.section_id));

            let color = project
                .sections
                .iter()
                .find(|s| s.id == closure.station_a.section_id)
                .map(|s| color_to_ariane(&s.color))
                .unwrap_or_else(|| "0x4ecdc4ff".to_string());

            closure_shots.push(ExportShot {
                id: closure_id,
                from_id,
                shot_type: "CLOSURE",
                section: section_name,
                azimuth: 0.0,
                length: 0.0,
                depth: 0.0,
                depth_in: -1.0,
                inclination: 0.0,
                left: 0.0,
                right: 0.0,
                up: 0.0,
                down: 0.0,
                comment: None,
                explorer: None,
                date: None,
                color,
                closure_to_id: to_id,
                locked: false,
            });
        }
    }

    // Flatten all blocks + closure shots
    let mut all_shots: Vec<ExportShot> = blocks.into_iter().flat_map(|b| b.shots).collect();
    all_shots.extend(closure_shots);

    all_shots
}

/// Build a parent map from station_merges.
///
/// Returns: child_section_id → (parent_station_ref, child_station_index)
///
/// For each merge, the section with the lower ID is considered the parent.
fn build_parent_map(project: &Project) -> HashMap<SectionId, (StationRef, u32)> {
    let mut map: HashMap<SectionId, (StationRef, u32)> = HashMap::new();

    for merge in &project.station_merges {
        let (parent, child, child_station_idx) =
            if merge.station_a.section_id <= merge.station_b.section_id {
                (
                    merge.station_a,
                    merge.station_b,
                    merge.station_b.station_index,
                )
            } else {
                (
                    merge.station_b,
                    merge.station_a,
                    merge.station_a.station_index,
                )
            };

        // Only set parent once per child section
        map.entry(child.section_id)
            .or_insert((parent, child_station_idx));
    }

    map
}

/// Convert `#RRGGBB` to Ariane's `0xRRGGBBff` format.
fn color_to_ariane(hex: &str) -> String {
    let hex = hex.trim_start_matches('#');
    if hex.len() == 6 && hex.chars().all(|c| c.is_ascii_hexdigit()) {
        format!("0x{hex}ff")
    } else {
        "0x4ecdc4ff".to_string()
    }
}

// ============================================================================
// Tests
// ============================================================================

#[cfg(test)]
#[expect(clippy::unwrap_used)]
mod tests {
    use super::*;
    use crate::models::{SectionData, ShotData};
    use tempfile::NamedTempFile;

    fn simple_project() -> Project {
        let mut project = Project::new("Test Cave".to_string(), None);
        project.add_section(SectionData {
            name: Some("Main".to_string()),
            surveyor: Some("Alice".to_string()),
            date: chrono::NaiveDate::from_ymd_opt(2025, 6, 15),
            color: "#ff0000".to_string(),
            shots: vec![
                ShotData {
                    azimuth_in: 45.0,
                    azimuth_out: 225.0,
                    length: 10.0,
                    depth_in: 0.0,
                    depth_out: 3.0,
                    pitch_in: Some(5.0),
                    left: Some(1.0),
                    right: Some(2.0),
                    up: Some(3.0),
                    down: Some(0.5),
                    comment: Some("first shot".to_string()),
                    ..Default::default()
                },
                ShotData {
                    azimuth_in: 90.0,
                    azimuth_out: 270.0,
                    length: 8.0,
                    depth_in: 3.0,
                    depth_out: 5.0,
                    ..Default::default()
                },
            ],
            ..Default::default()
        });
        project
    }

    #[test]
    fn test_export_tmlu_creates_valid_xml() {
        let project = simple_project();
        let file = NamedTempFile::with_suffix(".tmlu").unwrap();
        let result = export_tml(&project, file.path());
        assert!(result.is_ok(), "export_tml failed: {result:?}");

        let content = std::fs::read_to_string(file.path()).unwrap();
        assert!(content.contains("<?xml"));
        assert!(content.contains("<CaveFile>"));
        assert!(content.contains("Test Cave"));
        // TMLU uses short names
        assert!(content.contains("<SRVD>"));
        assert!(content.contains("<AZ>"));
        assert!(content.contains("<LG>"));
    }

    #[test]
    fn test_export_tml_creates_zip() {
        let project = simple_project();
        let file = NamedTempFile::with_suffix(".tml").unwrap();
        let result = export_tml(&project, file.path());
        assert!(result.is_ok(), "export_tml failed: {result:?}");

        // Verify it's a valid ZIP containing Data.xml
        let zip_file = std::fs::File::open(file.path()).unwrap();
        let mut archive = zip::ZipArchive::new(zip_file).unwrap();
        assert!(archive.by_name("Data.xml").is_ok());

        let mut data_xml = String::new();
        std::io::Read::read_to_string(&mut archive.by_name("Data.xml").unwrap(), &mut data_xml)
            .unwrap();
        // TML uses long names — verify ID is all-caps
        assert!(data_xml.contains("<SurveyData>"));
        assert!(data_xml.contains("<ID>"));
        assert!(data_xml.contains("<Azimut>"));
        assert!(data_xml.contains("<Length>"));
        assert!(data_xml.contains("<Locked>"));
        assert!(data_xml.contains("<Name>"));
        assert!(data_xml.contains("<Profiletype>"));
    }

    #[test]
    fn test_export_empty_project() {
        let project = Project::new("Empty".to_string(), None);
        let file = NamedTempFile::with_suffix(".tmlu").unwrap();
        let result = export_tml(&project, file.path());
        assert!(result.is_ok());

        let content = std::fs::read_to_string(file.path()).unwrap();
        assert!(content.contains("<CaveFile>"));
        assert!(content.contains("<Data>"));
        // No survey data elements
        assert!(!content.contains("<SRVD>"));
    }

    #[test]
    fn test_color_to_ariane() {
        assert_eq!(color_to_ariane("#ff0000"), "0xff0000ff");
        assert_eq!(color_to_ariane("#4ecdc4"), "0x4ecdc4ff");
        assert_eq!(color_to_ariane("invalid"), "0x4ecdc4ff");
        assert_eq!(color_to_ariane("#abc"), "0x4ecdc4ff"); // too short
    }

    #[test]
    fn test_format_f64() {
        assert_eq!(format_f64(0.0), "0.0");
        assert_eq!(format_f64(10.0), "10.0");
        assert_eq!(format_f64(3.14159), "3.14159");
        assert_eq!(format_f64(1.5), "1.5");
        assert_eq!(format_f64(-2.0), "-2.0");
    }

    #[test]
    fn test_single_start_shot_at_root() {
        let project = simple_project();
        let shots = build_export_shots(&project);

        // Only one START shot should exist
        let start_count = shots.iter().filter(|s| s.shot_type == "START").count();
        assert_eq!(start_count, 1, "expected exactly 1 START shot");

        // First shot should be START with from_id = -1
        assert_eq!(shots[0].shot_type, "START");
        assert_eq!(shots[0].from_id, -1);
        assert!(shots[0].locked, "START shot should be locked");

        // Next shots should be REAL
        assert_eq!(shots[1].shot_type, "REAL");
        assert_eq!(shots[2].shot_type, "REAL");
    }

    #[test]
    fn test_sequential_ids() {
        let project = simple_project();
        let shots = build_export_shots(&project);

        for (i, shot) in shots.iter().enumerate() {
            assert_eq!(shot.id, i as i64, "shot {i} should have id {i}");
        }
    }

    #[test]
    fn test_from_id_chain() {
        let project = simple_project();
        let shots = build_export_shots(&project);

        // START has from_id = -1
        assert_eq!(shots[0].from_id, -1);
        // First real shot chains from START
        assert_eq!(shots[1].from_id, shots[0].id);
        // Second real shot chains from first
        assert_eq!(shots[2].from_id, shots[1].id);
    }

    #[test]
    fn test_virtual_shot_type() {
        let mut project = Project::new("Virtual Test".to_string(), None);
        project.add_section(SectionData {
            name: Some("Sec".to_string()),
            color: "#000000".to_string(),
            shots: vec![
                ShotData {
                    is_reference: true,
                    length: 5.0,
                    ..Default::default()
                },
                ShotData {
                    is_reference: false,
                    length: 3.0,
                    ..Default::default()
                },
            ],
            ..Default::default()
        });

        let shots = build_export_shots(&project);
        // shots[0] = START, shots[1] = VIRTUAL, shots[2] = REAL
        assert_eq!(shots[1].shot_type, "VIRTUAL");
        assert_eq!(shots[2].shot_type, "REAL");
    }

    #[test]
    fn test_multi_section_no_extra_starts() {
        use crate::models::StationMerge;

        let mut project = Project::new("Multi".to_string(), None);

        // Section 0: 2 shots (root)
        project.add_section(SectionData {
            name: Some("Sec A".to_string()),
            color: "#ff0000".to_string(),
            shots: vec![
                ShotData {
                    length: 10.0,
                    depth_out: 5.0,
                    ..Default::default()
                },
                ShotData {
                    length: 8.0,
                    depth_in: 5.0,
                    depth_out: 7.0,
                    ..Default::default()
                },
            ],
            ..Default::default()
        });

        // Section 1: 1 shot (child, connected to station 1 of section 0)
        project.add_section(SectionData {
            name: Some("Sec B".to_string()),
            color: "#00ff00".to_string(),
            shots: vec![ShotData {
                length: 6.0,
                depth_out: 2.0,
                ..Default::default()
            }],
            ..Default::default()
        });

        // Merge: section 1, station 0 → section 0, station 1
        project.station_merges.push(StationMerge {
            station_a: StationRef {
                section_id: 0,
                station_index: 1,
            },
            station_b: StationRef {
                section_id: 1,
                station_index: 0,
            },
            merged_at: chrono::Utc::now(),
        });

        let shots = build_export_shots(&project);

        // Only ONE start shot should exist (for root section A)
        let start_count = shots.iter().filter(|s| s.shot_type == "START").count();
        assert_eq!(start_count, 1, "expected exactly 1 START shot");

        // Section A: START(0), REAL(1), REAL(2)
        // Section B: REAL(3) — no START, first shot links to parent
        assert_eq!(shots.len(), 4);

        assert_eq!(shots[0].shot_type, "START");
        assert_eq!(shots[1].shot_type, "REAL");
        assert_eq!(shots[2].shot_type, "REAL");
        assert_eq!(shots[3].shot_type, "REAL"); // Sec B's shot, NOT a START

        // Section B's first shot should reference ariane ID of section A station 1
        // Station 1 in section A = ariane ID 1 (first real shot)
        assert_eq!(shots[3].from_id, 1);
    }

    #[test]
    fn test_round_trip_tmlu() {
        let project = simple_project();
        let file = NamedTempFile::with_suffix(".tmlu").unwrap();
        export_tml(&project, file.path()).unwrap();

        // Re-import
        let parsed = crate::parsers::tml::parse_tml(file.path()).unwrap();

        assert_eq!(parsed.cave_name, "Test Cave");
        assert_eq!(parsed.unit, crate::parsers::tml::TmlUnit::Metric);
        assert!(parsed.use_magnetic_azimuth);

        // Should have one section with 2 shots
        assert_eq!(
            parsed.sections.len(),
            1,
            "expected 1 section, got {}",
            parsed.sections.len()
        );
        let sec = &parsed.sections[0];
        assert_eq!(
            sec.shots.len(),
            2,
            "expected 2 shots, got {}",
            sec.shots.len()
        );

        // Verify shot data round-trips
        let s0 = &sec.shots[0];
        assert!((s0.azimuth - 45.0).abs() < 0.01);
        assert!((s0.length - 10.0).abs() < 0.01);

        let s1 = &sec.shots[1];
        assert!((s1.azimuth - 90.0).abs() < 0.01);
        assert!((s1.length - 8.0).abs() < 0.01);
    }

    #[test]
    fn test_round_trip_tml_zip() {
        let project = simple_project();
        let file = NamedTempFile::with_suffix(".tml").unwrap();
        export_tml(&project, file.path()).unwrap();

        // Re-import
        let parsed = crate::parsers::tml::parse_tml(file.path()).unwrap();

        assert_eq!(parsed.cave_name, "Test Cave");
        assert_eq!(parsed.sections.len(), 1);
        assert_eq!(parsed.sections[0].shots.len(), 2);
    }

    #[test]
    fn test_unicode_section_name() {
        let mut project = Project::new("Grotte de l'Ours".to_string(), None);
        project.add_section(SectionData {
            name: Some("Galería Principal".to_string()),
            surveyor: Some("José García".to_string()),
            color: "#ff0000".to_string(),
            shots: vec![ShotData {
                length: 5.0,
                ..Default::default()
            }],
            ..Default::default()
        });

        let file = NamedTempFile::with_suffix(".tmlu").unwrap();
        export_tml(&project, file.path()).unwrap();

        let content = std::fs::read_to_string(file.path()).unwrap();
        // quick_xml escapes apostrophes to &apos;
        assert!(content.contains("Grotte de l") && content.contains("Ours"));
        assert!(content.contains("Galería Principal"));
        assert!(content.contains("José García"));
    }

    #[test]
    fn test_depth_in_sentinel() {
        // When depth_in equals the previous depth_out, export should use -1.0
        let mut project = Project::new("Depth".to_string(), None);
        project.add_section(SectionData {
            name: Some("Sec".to_string()),
            color: "#ff0000".to_string(),
            shots: vec![
                ShotData {
                    depth_in: 0.0,
                    depth_out: 5.0,
                    length: 10.0,
                    ..Default::default()
                },
                ShotData {
                    depth_in: 5.0, // equals previous depth_out → should be -1.0
                    depth_out: 8.0,
                    length: 7.0,
                    ..Default::default()
                },
                ShotData {
                    depth_in: 6.0, // different from previous depth_out (8.0) → should be 6.0
                    depth_out: 10.0,
                    length: 5.0,
                    ..Default::default()
                },
            ],
            ..Default::default()
        });

        let shots = build_export_shots(&project);
        // shots[0] = START, shots[1..3] = REAL
        assert!(
            (shots[1].depth_in - (-1.0)).abs() < 1e-9,
            "first shot depth_in should be -1.0 (same as start)"
        );
        assert!(
            (shots[2].depth_in - (-1.0)).abs() < 1e-9,
            "second shot depth_in should be -1.0 (same as prev depth_out)"
        );
        assert!(
            (shots[3].depth_in - 6.0).abs() < 1e-9,
            "third shot depth_in should be 6.0 (differs from prev depth_out)"
        );
    }

    #[test]
    fn test_id_element_is_all_caps() {
        let project = simple_project();
        let file = NamedTempFile::with_suffix(".tml").unwrap();
        export_tml(&project, file.path()).unwrap();

        let zip_file = std::fs::File::open(file.path()).unwrap();
        let mut archive = zip::ZipArchive::new(zip_file).unwrap();
        let mut data_xml = String::new();
        std::io::Read::read_to_string(&mut archive.by_name("Data.xml").unwrap(), &mut data_xml)
            .unwrap();

        // Must be <ID>, never <Id>
        assert!(data_xml.contains("<ID>"), "ID element must be all-caps");
        assert!(!data_xml.contains("<Id>"), "must not use <Id> casing");
    }

    #[test]
    fn test_required_fields_present() {
        let project = simple_project();
        let file = NamedTempFile::with_suffix(".tmlu").unwrap();
        export_tml(&project, file.path()).unwrap();

        let content = std::fs::read_to_string(file.path()).unwrap();
        // Every shot must have Locked, Name, and Profiletype (short names: LCK, NM, PT)
        assert!(content.contains("<LCK>"));
        assert!(content.contains("<NM>"));
        assert!(content.contains("<PT>VERTICAL</PT>"));
    }
}
