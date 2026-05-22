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

use std::collections::{HashMap, HashSet, VecDeque};
use std::io::{Cursor, Write as _};
use std::path::Path;

use anyhow::{Context, Result};
use quick_xml::events::{BytesDecl, BytesEnd, BytesStart, BytesText, Event};
use quick_xml::Writer;

use sha2::{Digest, Sha256};

use crate::models::{geo_key, Project, Section, SectionId, ShotBaselineEntry, StationRef};

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
    uuid: &'static str,
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
    uuid: "UUID",
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
    uuid: "UU",
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
    depth: f64,    // absolute station depth (cumulative)
    depth_in: f64, // -1.0 if same as previous depth
    inclination: f64,
    left: f64,
    right: f64,
    up: f64,
    down: f64,
    comment: Option<String>,
    explorer: Option<String>,
    date: Option<String>,
    color: String, // "0xRRGGBBff"
    latitude: f64,
    longitude: f64,
    closure_to_id: i64,
    locked: bool,
}

// ============================================================================
// Public API
// ============================================================================

/// Export a project to Ariane TML (`.tml` = ZIP) or TMLU (`.tmlu` = plain XML).
pub fn export_tml(project: &Project, path: &Path) -> Result<()> {
    let names = names_for_path(path);
    let (xml, _baseline) = build_xml(project, names)?;
    write_output(path, &xml)
}

/// Export for collaboration mode: writes the file AND returns the per-shot
/// baseline (for diffing a returned file) plus the sha256 of the inner XML
/// content (for detecting external edits on open — independent of zip framing).
pub fn export_tml_with_baseline(
    project: &Project,
    path: &Path,
) -> Result<(Vec<ShotBaselineEntry>, String)> {
    let names = names_for_path(path);
    let (xml, baseline) = build_xml(project, names)?;
    write_output(path, &xml)?;
    let sha = sha256_hex(&xml);
    Ok((baseline, sha))
}

fn names_for_path(path: &Path) -> &'static Names {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .map(str::to_lowercase)
        .unwrap_or_default();
    if ext == "tml" { &LONG } else { &SHORT }
}

fn write_output(path: &Path, xml: &[u8]) -> Result<()> {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .map(str::to_lowercase)
        .unwrap_or_default();
    match ext.as_str() {
        "tml" => write_zip(path, xml),
        "tmlu" => std::fs::write(path, xml).context("Failed to write TMLU file"),
        _ => std::fs::write(path, xml).context("Failed to write TML export file"),
    }
}

/// Hex-encoded sha256 of the given bytes.
pub fn sha256_hex(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    format!("{:x}", hasher.finalize())
}

// ============================================================================
// XML generation
// ============================================================================

fn build_xml(project: &Project, n: &Names) -> Result<(Vec<u8>, Vec<ShotBaselineEntry>)> {
    let (shots, baseline) = build_export_shots(project);
    // Map Ariane shot ID -> UUID so write_shot can emit <UUID> only for real
    // (baseline-tracked) forward shots; synthesized START/CLOSURE/reverse legs
    // have no entry and emit no UUID.
    let uuid_by_ariane: HashMap<i64, &str> =
        baseline.iter().map(|e| (e.ariane_id, e.uuid.as_str())).collect();

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
        let uuid = uuid_by_ariane.get(&shot.id).copied().unwrap_or("");
        write_shot(&mut writer, n, shot, uuid)?;
    }

    // </Data>
    writer.write_event(Event::End(BytesEnd::new(n.data)))?;

    // Remaining metadata after Data (matching Ariane's ordering)
    write_text_element(&mut writer, n.unit, "m")?;
    write_text_element(&mut writer, n.use_magnetic_azimuth, "true")?;

    // </CaveFile>
    writer.write_event(Event::End(BytesEnd::new(n.cave_file)))?;

    drop(writer);
    Ok((buf, baseline))
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
    uuid: &str,
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
    write_text_element(writer, n.latitude, &format_f64(shot.latitude))?;
    write_text_element(writer, n.left, &format_f64(shot.left))?;
    write_text_element(writer, n.length, &format_f64(shot.length))?;
    write_text_element(writer, n.locked, if shot.locked { "true" } else { "false" })?;
    write_text_element(writer, n.longitude, &format_f64(shot.longitude))?;

    // Ariane conventions: START has START name, CLOSURE uses CLOSURE:CLOSURE.
    let name_str = match shot.shot_type {
        "START" => "START",
        "CLOSURE" => "CLOSURE:CLOSURE",
        _ => "",
    };
    write_text_element(writer, n.name, name_str)?;

    write_text_element(writer, n.profiletype, "VERTICAL")?;
    write_text_element(writer, n.right, &format_f64(shot.right))?;
    write_text_element(writer, n.section, &shot.section)?;
    write_text_element(writer, n.shot_type, shot.shot_type)?;
    write_text_element(writer, n.up, &format_f64(shot.up))?;

    // Stable per-shot UUID (collaboration identity). Only emitted for real
    // forward shots; Ariane 26+ preserves it across edits, ≤25 ignores it.
    if !uuid.is_empty() {
        write_text_element(writer, n.uuid, uuid)?;
    }

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

/// Reuse the existing baseline UUID for a shot if present, else mint a new one,
/// so UUIDs stay stable across repeated exports of the same project.
fn pick_uuid(existing: &HashMap<(SectionId, u32), String>, section_id: SectionId, idx: u32) -> String {
    existing
        .get(&(section_id, idx))
        .filter(|u| !u.is_empty())
        .cloned()
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string())
}

fn build_export_shots(project: &Project) -> (Vec<ExportShot>, Vec<ShotBaselineEntry>) {
    if project.sections.is_empty() {
        return (Vec::new(), Vec::new());
    }

    // Per-shot baseline accumulated only for forward REAL/VIRTUAL shots that map
    // 1:1 to a Stalagmight shot (START/CLOSURE/reverse legs are excluded).
    let mut baseline: Vec<ShotBaselineEntry> = Vec::new();
    // Existing UUIDs from the last export (so they stay stable across exports).
    let existing_uuids: HashMap<(SectionId, u32), String> = project
        .collab
        .as_ref()
        .map(|c| {
            c.shot_baseline
                .iter()
                .map(|e| ((e.section_id, e.shot_index), e.uuid.clone()))
                .collect()
        })
        .unwrap_or_default();

    // Ariane supports one START; when a primary zero datum exists, root the
    // topology from that section so GPS can be placed on START without remapping.
    let root_section_id = project
        .zero_datums
        .first()
        .map(|d| d.station_ref.section_id)
        .filter(|sid| project.sections.iter().any(|s| s.id == *sid))
        .unwrap_or_else(|| choose_default_root_section_id(project));

    // Build rooted parent links from station merges.
    let parent_map = build_parent_map(project, root_section_id);
    let primary_datum = project.zero_datums.first();

    let mut next_id: i64 = 0;

    struct SectionBlock {
        section_id: SectionId,
        apply_parent_link: bool,
        merge_station_index_override: Option<u32>,
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

        let split_root_at = if is_root {
            primary_datum
                .filter(|datum| datum.station_ref.section_id == section.id)
                .and_then(|datum| {
                    let idx = datum.station_ref.station_index as usize;
                    if idx > section.shots.len() {
                        tracing::warn!(
                            section_id = section.id,
                            station_index = datum.station_ref.station_index,
                            shot_count = section.shots.len(),
                            "Zero datum station is out of bounds; exporting section without split"
                        );
                        None
                    } else if idx > 0 {
                        Some(idx)
                    } else {
                        None
                    }
                })
        } else {
            None
        };

        if let Some(split_idx) = split_root_at {
            let start_id = next_id;
            next_id += 1;
            let start_depth = station_depth(section, split_idx);

            let mut root_shots = Vec::new();
            root_shots.push(ExportShot {
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
                latitude: 0.0,
                longitude: 0.0,
                closure_to_id: -1,
                locked: true,
            });
            station_to_ariane.insert((section.id, split_idx as u32), start_id);

            // Forward segment: datum station -> original section end.
            let mut cumulative_depth = start_depth;
            for shot_idx in split_idx..section.shots.len() {
                let shot = &section.shots[shot_idx];
                let shot_ariane_id = next_id;
                next_id += 1;

                let prev_id = if shot_idx == split_idx {
                    start_id
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

                root_shots.push(ExportShot {
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
                    latitude: 0.0,
                    longitude: 0.0,
                    closure_to_id: -1,
                    locked: false,
                });

                station_to_ariane.insert((section.id, (shot_idx + 1) as u32), shot_ariane_id);
                baseline.push(ShotBaselineEntry {
                    section_id: section.id,
                    shot_index: shot_idx as u32,
                    ariane_id: shot_ariane_id,
                    uuid: pick_uuid(&existing_uuids, section.id, shot_idx as u32),
                    geo_key: geo_key(shot.azimuth_in, shot.length, shot.depth_in, shot.depth_out),
                    section_name: section_name.clone(),
                });
            }

            blocks.push(SectionBlock {
                section_id: section.id,
                apply_parent_link: false,
                merge_station_index_override: None,
                shots: root_shots,
            });

            // Reverse segment: datum station -> original section start.
            if split_idx > 0 {
                let split_name = format!("{section_name} (pre-zero-datum)");
                let mut reverse_shots = Vec::new();
                let mut cumulative_depth = start_depth;

                for shot_idx in (0..split_idx).rev() {
                    let shot = &section.shots[shot_idx];
                    let shot_ariane_id = next_id;
                    next_id += 1;

                    let prev_id = if shot_idx == split_idx - 1 {
                        start_id
                    } else {
                        shot_ariane_id - 1
                    };

                    let reversed_depth_in = shot.depth_out;
                    let reversed_depth_out = shot.depth_in;
                    let prev_depth = cumulative_depth;
                    cumulative_depth = reversed_depth_out;
                    let depth_in_val = if (reversed_depth_in - prev_depth).abs() < 1e-9 {
                        -1.0
                    } else {
                        reversed_depth_in
                    };

                    reverse_shots.push(ExportShot {
                        id: shot_ariane_id,
                        from_id: prev_id,
                        shot_type: if shot.is_reference { "VIRTUAL" } else { "REAL" },
                        section: split_name.clone(),
                        // Ariane carries a single forward azimuth per shot. The reverse
                        // pre-zero leg must therefore be synthesized as reciprocal heading.
                        azimuth: reverse_pre_zero_azimuth(shot.azimuth_in),
                        length: shot.length,
                        depth: reversed_depth_out,
                        depth_in: depth_in_val,
                        inclination: shot
                            .pitch_out
                            .or_else(|| shot.pitch_in.map(|p| -p))
                            .unwrap_or(0.0),
                        left: shot.right.unwrap_or(0.0),
                        right: shot.left.unwrap_or(0.0),
                        up: shot.up.unwrap_or(0.0),
                        down: shot.down.unwrap_or(0.0),
                        comment: shot.comment.clone(),
                        explorer: explorer.clone(),
                        date: date.clone(),
                        color: color.clone(),
                        latitude: 0.0,
                        longitude: 0.0,
                        closure_to_id: -1,
                        locked: false,
                    });

                    // Reversed shot from station (shot_idx + 1) to shot_idx:
                    // it ends at the original station shot_idx.
                    station_to_ariane.insert((section.id, shot_idx as u32), shot_ariane_id);
                }

                blocks.push(SectionBlock {
                    section_id: section.id,
                    apply_parent_link: false,
                    merge_station_index_override: None,
                    shots: reverse_shots,
                });
            }

            continue;
        }

        // Non-root child sections merged at a non-zero station need splitting
        // or reversal so the merge point becomes the first shot in each block.
        if !is_root {
            if let Some(parent_link) = parent_map.get(&section.id) {
                let child_merge_idx = parent_link.child_station_index as usize;

                if child_merge_idx > 0 && child_merge_idx < section.shots.len() {
                    // Mid-section merge: split into forward + reverse blocks.

                    // Forward block: shots from child_merge_idx to end.
                    let mut fwd_shots = Vec::new();
                    let mut cumulative_depth = station_depth(section, child_merge_idx);
                    for shot_idx in child_merge_idx..section.shots.len() {
                        let shot = &section.shots[shot_idx];
                        let shot_ariane_id = next_id;
                        next_id += 1;

                        let prev_id = if shot_idx == child_merge_idx {
                            -1 // placeholder — resolved in second pass
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

                        fwd_shots.push(ExportShot {
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
                            latitude: 0.0,
                            longitude: 0.0,
                            closure_to_id: -1,
                            locked: false,
                        });

                        station_to_ariane
                            .insert((section.id, (shot_idx + 1) as u32), shot_ariane_id);
                        baseline.push(ShotBaselineEntry {
                            section_id: section.id,
                            shot_index: shot_idx as u32,
                            ariane_id: shot_ariane_id,
                            uuid: pick_uuid(&existing_uuids, section.id, shot_idx as u32),
                            geo_key: geo_key(shot.azimuth_in, shot.length, shot.depth_in, shot.depth_out),
                            section_name: section_name.clone(),
                        });
                    }

                    blocks.push(SectionBlock {
                        section_id: section.id,
                        apply_parent_link: true,
                        merge_station_index_override: Some(0),
                        shots: fwd_shots,
                    });

                    // Reverse block: shots from child_merge_idx-1 down to 0, reversed.
                    let rev_name = format!("{section_name} (reversed)");
                    let mut rev_shots = Vec::new();
                    let mut cumulative_depth = station_depth(section, child_merge_idx);

                    for shot_idx in (0..child_merge_idx).rev() {
                        let shot = &section.shots[shot_idx];
                        let shot_ariane_id = next_id;
                        next_id += 1;

                        let prev_id = if shot_idx == child_merge_idx - 1 {
                            -1 // placeholder — resolved in second pass
                        } else {
                            shot_ariane_id - 1
                        };

                        let reversed_depth_in = shot.depth_out;
                        let reversed_depth_out = shot.depth_in;
                        let prev_depth = cumulative_depth;
                        cumulative_depth = reversed_depth_out;
                        let depth_in_val =
                            if (reversed_depth_in - prev_depth).abs() < 1e-9 {
                                -1.0
                            } else {
                                reversed_depth_in
                            };

                        rev_shots.push(ExportShot {
                            id: shot_ariane_id,
                            from_id: prev_id,
                            shot_type: if shot.is_reference { "VIRTUAL" } else { "REAL" },
                            section: rev_name.clone(),
                            azimuth: reverse_pre_zero_azimuth(shot.azimuth_in),
                            length: shot.length,
                            depth: reversed_depth_out,
                            depth_in: depth_in_val,
                            inclination: shot
                                .pitch_out
                                .or_else(|| shot.pitch_in.map(|p| -p))
                                .unwrap_or(0.0),
                            left: shot.right.unwrap_or(0.0),
                            right: shot.left.unwrap_or(0.0),
                            up: shot.up.unwrap_or(0.0),
                            down: shot.down.unwrap_or(0.0),
                            comment: shot.comment.clone(),
                            explorer: explorer.clone(),
                            date: date.clone(),
                            color: color.clone(),
                            latitude: 0.0,
                            longitude: 0.0,
                            closure_to_id: -1,
                            locked: false,
                        });

                        // Reversed shot ends at original station shot_idx.
                        station_to_ariane
                            .insert((section.id, shot_idx as u32), shot_ariane_id);
                    }

                    blocks.push(SectionBlock {
                        section_id: section.id,
                        apply_parent_link: true,
                        merge_station_index_override: Some(0),
                        shots: rev_shots,
                    });

                    continue;
                } else if child_merge_idx > 0 && child_merge_idx >= section.shots.len() {
                    // End-of-section merge: reverse the entire section.
                    let rev_name = format!("{section_name} (reversed)");
                    let mut rev_shots = Vec::new();
                    let mut cumulative_depth =
                        station_depth(section, section.shots.len());

                    for shot_idx in (0..section.shots.len()).rev() {
                        let shot = &section.shots[shot_idx];
                        let shot_ariane_id = next_id;
                        next_id += 1;

                        let prev_id = if shot_idx == section.shots.len() - 1 {
                            -1 // placeholder — resolved in second pass
                        } else {
                            shot_ariane_id - 1
                        };

                        let reversed_depth_in = shot.depth_out;
                        let reversed_depth_out = shot.depth_in;
                        let prev_depth = cumulative_depth;
                        cumulative_depth = reversed_depth_out;
                        let depth_in_val =
                            if (reversed_depth_in - prev_depth).abs() < 1e-9 {
                                -1.0
                            } else {
                                reversed_depth_in
                            };

                        rev_shots.push(ExportShot {
                            id: shot_ariane_id,
                            from_id: prev_id,
                            shot_type: if shot.is_reference { "VIRTUAL" } else { "REAL" },
                            section: rev_name.clone(),
                            azimuth: reverse_pre_zero_azimuth(shot.azimuth_in),
                            length: shot.length,
                            depth: reversed_depth_out,
                            depth_in: depth_in_val,
                            inclination: shot
                                .pitch_out
                                .or_else(|| shot.pitch_in.map(|p| -p))
                                .unwrap_or(0.0),
                            left: shot.right.unwrap_or(0.0),
                            right: shot.left.unwrap_or(0.0),
                            up: shot.up.unwrap_or(0.0),
                            down: shot.down.unwrap_or(0.0),
                            comment: shot.comment.clone(),
                            explorer: explorer.clone(),
                            date: date.clone(),
                            color: color.clone(),
                            latitude: 0.0,
                            longitude: 0.0,
                            closure_to_id: -1,
                            locked: false,
                        });

                        // Reversed shot ends at original station shot_idx.
                        station_to_ariane
                            .insert((section.id, shot_idx as u32), shot_ariane_id);
                    }

                    blocks.push(SectionBlock {
                        section_id: section.id,
                        apply_parent_link: true,
                        merge_station_index_override: Some(0),
                        shots: rev_shots,
                    });

                    continue;
                }
            }
        }

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
                latitude: 0.0,
                longitude: 0.0,
                closure_to_id: -1,
                locked: true,
            });

            station_to_ariane.insert((section.id, 0), start_id);
        }

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
                latitude: 0.0,
                longitude: 0.0,
                closure_to_id: -1,
                locked: false,
            });

            // Station (i+1) is after this shot
            station_to_ariane.insert((section.id, (i + 1) as u32), shot_ariane_id);
            baseline.push(ShotBaselineEntry {
                section_id: section.id,
                shot_index: i as u32,
                ariane_id: shot_ariane_id,
                uuid: pick_uuid(&existing_uuids, section.id, i as u32),
                geo_key: geo_key(shot.azimuth_in, shot.length, shot.depth_in, shot.depth_out),
                section_name: section_name.clone(),
            });
        }

        blocks.push(SectionBlock {
            section_id: section.id,
            apply_parent_link: !is_root && !shots.is_empty(),
            merge_station_index_override: None,
            shots,
        });
    }

    // Second pass: resolve parent links from station merges.
    for block in &mut blocks {
        if !block.apply_parent_link || block.shots.is_empty() {
            continue;
        }

        let Some(parent_link) = parent_map.get(&block.section_id) else {
            continue;
        };

        let Some(&parent_ariane_id) = station_to_ariane.get(&(
            parent_link.parent_station.section_id,
            parent_link.parent_station.station_index,
        )) else {
            tracing::warn!(
                child_section_id = block.section_id,
                parent_section_id = parent_link.parent_station.section_id,
                parent_station_index = parent_link.parent_station.station_index,
                "Skipping parent link: parent station is not representable in Ariane export"
            );
            continue;
        };

        let child_station_idx = block
            .merge_station_index_override
            .unwrap_or(parent_link.child_station_index) as usize;
        if child_station_idx < block.shots.len() {
            block.shots[child_station_idx].from_id = parent_ariane_id;
        } else {
            tracing::warn!(
                child_section_id = block.section_id,
                child_station_index = parent_link.child_station_index,
                shot_count = block.shots.len(),
                "Skipping parent from_id rewrite: child merge station has no outgoing shot"
            );
        }

        // Treat merged stations as the same Ariane node ID so closures and GPS
        // references resolve to the parent-attached node.
        station_to_ariane.insert(
            (block.section_id, parent_link.child_station_index),
            parent_ariane_id,
        );
    }

    // Third pass: generate CLOSURE shots from loop_closures
    let mut closure_shots = Vec::new();
    for closure in &project.loop_closures {
        let Some(&from_id) = station_to_ariane.get(&(
            closure.station_a.section_id,
            closure.station_a.station_index,
        )) else {
            tracing::warn!(
                closure_id = closure.id,
                from_section_id = closure.station_a.section_id,
                from_station_index = closure.station_a.station_index,
                to_section_id = closure.station_b.section_id,
                to_station_index = closure.station_b.station_index,
                "Skipping closure export: from station is not representable in Ariane topology"
            );
            continue;
        };

        let Some(&to_id) = station_to_ariane.get(&(
            closure.station_b.section_id,
            closure.station_b.station_index,
        )) else {
            tracing::warn!(
                closure_id = closure.id,
                from_section_id = closure.station_a.section_id,
                from_station_index = closure.station_a.station_index,
                to_section_id = closure.station_b.section_id,
                to_station_index = closure.station_b.station_index,
                "Skipping closure export: target station is not representable in Ariane topology"
            );
            continue;
        };

        if from_id == to_id {
            tracing::warn!(
                closure_id = closure.id,
                section_id = closure.station_a.section_id,
                station_index = closure.station_a.station_index,
                "Skipping closure export: closure endpoints collapse to the same Ariane node"
            );
            continue;
        }

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
            depth_in: 0.0,
            inclination: 0.0,
            left: 0.0,
            right: 0.0,
            up: 0.0,
            down: 0.0,
            comment: None,
            explorer: None,
            date: None,
            color,
            latitude: 0.0,
            longitude: 0.0,
            closure_to_id: to_id,
            locked: false,
        });
    }

    // Flatten all blocks + closure shots
    let mut all_shots: Vec<ExportShot> = blocks.into_iter().flat_map(|b| b.shots).collect();
    all_shots.extend(closure_shots);

    // Final pass: Ariane stores GPS on the single START shot.
    let start_idx = all_shots.iter().position(|s| s.shot_type == "START");
    if let Some(start_idx) = start_idx {
        if let Some(primary_datum) = primary_datum {
            all_shots[start_idx].latitude = primary_datum.gps.latitude;
            all_shots[start_idx].longitude = primary_datum.gps.longitude;

            if project.zero_datums.len() > 1 {
                tracing::warn!(
                    datum_count = project.zero_datums.len(),
                    "Ariane export supports only one GPS anchor; using the first zero datum"
                );
            }
        }
    }

    (all_shots, baseline)
}

#[derive(Debug, Clone, Copy)]
struct ParentLink {
    parent_station: StationRef,
    child_station_index: u32,
}

/// Pick a deterministic root using the legacy "lowest section ID wins parent"
/// heuristic so exports without zero datums remain stable.
fn choose_default_root_section_id(project: &Project) -> SectionId {
    let mut child_sections: HashSet<SectionId> = HashSet::new();
    for merge in &project.station_merges {
        let child = if merge.station_a.section_id <= merge.station_b.section_id {
            merge.station_b.section_id
        } else {
            merge.station_a.section_id
        };
        child_sections.insert(child);
    }

    project
        .sections
        .iter()
        .map(|s| s.id)
        .find(|id| !child_sections.contains(id))
        .unwrap_or(project.sections[0].id)
}

fn station_depth(section: &Section, station_index: usize) -> f64 {
    if section.shots.is_empty() {
        return 0.0;
    }
    if station_index == 0 {
        section.shots[0].depth_in
    } else if station_index >= section.shots.len() {
        section.shots[section.shots.len() - 1].depth_out
    } else {
        section.shots[station_index].depth_in
    }
}

fn normalize_azimuth(azimuth: f64) -> f64 {
    azimuth.rem_euclid(360.0)
}

/// Compute azimuth for the generated pre-zero-datum reverse segment.
///
/// Ariane does not provide a backsight field, so `azimuth_out` from Stalagmight
/// must not be interpreted as an Ariane backsight during export.
fn reverse_pre_zero_azimuth(azimuth_in: f64) -> f64 {
    normalize_azimuth(azimuth_in + 180.0)
}

/// Build a parent map from station_merges.
///
/// Returns: child_section_id → (parent_station_ref, child_station_index)
///
/// Parent links are chosen by traversing the merge graph from `root_section_id`.
fn build_parent_map(project: &Project, root_section_id: SectionId) -> HashMap<SectionId, ParentLink> {
    #[derive(Debug, Clone, Copy)]
    struct NeighborLink {
        neighbor_section_id: SectionId,
        parent_station: StationRef,
        child_station_index: u32,
    }

    let mut adjacency: HashMap<SectionId, Vec<NeighborLink>> = HashMap::new();
    for merge in &project.station_merges {
        adjacency
            .entry(merge.station_a.section_id)
            .or_default()
            .push(NeighborLink {
                neighbor_section_id: merge.station_b.section_id,
                parent_station: merge.station_a,
                child_station_index: merge.station_b.station_index,
            });
        adjacency
            .entry(merge.station_b.section_id)
            .or_default()
            .push(NeighborLink {
                neighbor_section_id: merge.station_a.section_id,
                parent_station: merge.station_b,
                child_station_index: merge.station_a.station_index,
            });
    }

    for links in adjacency.values_mut() {
        links.sort_by_key(|l| {
            (
                l.neighbor_section_id,
                l.child_station_index,
                l.parent_station.station_index,
            )
        });
    }

    let mut map: HashMap<SectionId, ParentLink> = HashMap::new();
    let mut visited: HashSet<SectionId> = HashSet::new();
    let mut queue = VecDeque::new();
    visited.insert(root_section_id);
    queue.push_back(root_section_id);

    while let Some(parent_section_id) = queue.pop_front() {
        let Some(links) = adjacency.get(&parent_section_id) else {
            continue;
        };
        for link in links {
            if visited.insert(link.neighbor_section_id) {
                map.insert(
                    link.neighbor_section_id,
                    ParentLink {
                        parent_station: link.parent_station,
                        child_station_index: link.child_station_index,
                    },
                );
                queue.push_back(link.neighbor_section_id);
            }
        }
    }

    for section in &project.sections {
        if section.id == root_section_id || map.contains_key(&section.id) {
            continue;
        }
        if adjacency.contains_key(&section.id) {
            tracing::warn!(
                section_id = section.id,
                root_section_id,
                "Section has merges but is disconnected from export root; leaving section without parent link"
            );
        }
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
    use crate::models::{
        ClosureStrategy, GpsCoordinates, LoopClosure, SectionData, ShotData, StationMerge,
        ZeroDatum,
    };
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
    fn test_export_emits_uuid_and_baseline() {
        let project = simple_project();
        let total_shots: usize = project.sections.iter().map(|s| s.shots.len()).sum();
        let dir = tempfile::TempDir::new().unwrap();
        let path = dir.path().join("out.tmlu");

        let (baseline, sha) = export_tml_with_baseline(&project, &path).unwrap();
        assert!(!sha.is_empty(), "sha256 should be returned");
        assert_eq!(baseline.len(), total_shots, "one baseline entry per real shot");
        for e in &baseline {
            assert!(!e.uuid.is_empty(), "baseline entry must carry a UUID");
            assert!(!e.geo_key.is_empty(), "baseline entry must carry a geo_key");
            assert_eq!(e.section_name, "Main");
        }

        // The .tmlu uses short tag names, so each real shot emits a <UU> element.
        let content = std::fs::read_to_string(&path).unwrap();
        assert_eq!(content.matches("<UU>").count(), total_shots);
        // START shot carries no UUID.
        assert!(content.contains("START"));
    }

    #[test]
    fn test_uuid_roundtrips_through_parse() {
        let project = simple_project();
        let dir = tempfile::TempDir::new().unwrap();
        let path = dir.path().join("rt.tmlu");
        let (baseline, _) = export_tml_with_baseline(&project, &path).unwrap();

        let parsed = crate::parsers::tml::parse_tml(&path).unwrap();
        let parsed_uuids: HashSet<String> = parsed
            .sections
            .iter()
            .flat_map(|s| s.shots.iter())
            .filter_map(|sh| sh.uuid.clone())
            .collect();

        assert_eq!(parsed_uuids.len(), baseline.len(), "all UUIDs survive export->parse");
        for e in &baseline {
            assert!(parsed_uuids.contains(&e.uuid), "uuid {} lost in round-trip", e.uuid);
        }
    }

    #[test]
    fn test_export_reuses_existing_uuids() {
        let mut project = simple_project();
        let dir = tempfile::TempDir::new().unwrap();
        let path = dir.path().join("out.tmlu");

        let (b1, _) = export_tml_with_baseline(&project, &path).unwrap();
        // Feed the baseline back as collab state and re-export.
        let mut collab = crate::models::CollabState::new("out.tmlu".to_string());
        collab.shot_baseline = b1.clone();
        project.collab = Some(collab);
        let (b2, _) = export_tml_with_baseline(&project, &path).unwrap();

        let u1: Vec<&String> = b1.iter().map(|e| &e.uuid).collect();
        let u2: Vec<&String> = b2.iter().map(|e| &e.uuid).collect();
        assert_eq!(u1, u2, "UUIDs must stay stable across exports");
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
    fn test_reverse_pre_zero_azimuth_is_reciprocal() {
        assert!((reverse_pre_zero_azimuth(42.0) - 222.0).abs() < 1e-9);
        assert!((reverse_pre_zero_azimuth(350.0) - 170.0).abs() < 1e-9);
    }

    #[test]
    fn test_single_start_shot_at_root() {
        let project = simple_project();
        let (shots, _baseline) = build_export_shots(&project);

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
        let (shots, _baseline) = build_export_shots(&project);

        for (i, shot) in shots.iter().enumerate() {
            assert_eq!(shot.id, i as i64, "shot {i} should have id {i}");
        }
    }

    #[test]
    fn test_from_id_chain() {
        let project = simple_project();
        let (shots, _baseline) = build_export_shots(&project);

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

        let (shots, _baseline) = build_export_shots(&project);
        // shots[0] = START, shots[1] = VIRTUAL, shots[2] = REAL
        assert_eq!(shots[1].shot_type, "VIRTUAL");
        assert_eq!(shots[2].shot_type, "REAL");
    }

    #[test]
    fn test_multi_section_no_extra_starts() {
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

        let (shots, _baseline) = build_export_shots(&project);

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
    fn test_child_merge_station_index_rewrites_matching_shot() {
        let mut project = Project::new("Child Merge Index".to_string(), None);

        // Root section with 3 shots: station IDs become START(0), 1, 2, 3.
        project.add_section(SectionData {
            name: Some("Root".to_string()),
            color: "#ff0000".to_string(),
            shots: vec![
                ShotData {
                    length: 5.0,
                    ..Default::default()
                },
                ShotData {
                    length: 5.0,
                    ..Default::default()
                },
                ShotData {
                    length: 5.0,
                    ..Default::default()
                },
            ],
            ..Default::default()
        });

        // Child section with 3 shots.
        project.add_section(SectionData {
            name: Some("Child".to_string()),
            color: "#00ff00".to_string(),
            shots: vec![
                ShotData {
                    length: 2.0,
                    ..Default::default()
                },
                ShotData {
                    length: 2.0,
                    ..Default::default()
                },
                ShotData {
                    length: 2.0,
                    ..Default::default()
                },
            ],
            ..Default::default()
        });

        // Merge child station 1 to root station 2.
        project.station_merges.push(StationMerge {
            station_a: StationRef {
                section_id: 0,
                station_index: 2,
            },
            station_b: StationRef {
                section_id: 1,
                station_index: 1,
            },
            merged_at: chrono::Utc::now(),
        });

        let (shots, _baseline) = build_export_shots(&project);

        // With non-zero merge at station 1, child is split:
        // Forward block (shots 1,2): id=4 from_id=2 (parent), id=5 from_id=4
        // Reverse block (shot 0 reversed): id=6 from_id=2 (parent)
        let fwd_shot0 = shots.iter().find(|s| s.id == 4).unwrap();
        let fwd_shot1 = shots.iter().find(|s| s.id == 5).unwrap();
        let rev_shot0 = shots.iter().find(|s| s.id == 6).unwrap();
        assert_eq!(
            fwd_shot0.from_id, 2,
            "forward block first shot should link to parent (root station 2)"
        );
        assert_eq!(
            fwd_shot1.from_id, 4,
            "forward block second shot should chain from previous"
        );
        assert_eq!(
            rev_shot0.from_id, 2,
            "reverse block first shot should link to parent (root station 2)"
        );
    }

    #[test]
    fn test_child_station_zero_closure_resolves_to_parent_node() {
        let mut project = Project::new("Child Station Zero".to_string(), None);

        project.add_section(SectionData {
            name: Some("A".to_string()),
            color: "#ff0000".to_string(),
            shots: vec![
                ShotData {
                    length: 4.0,
                    ..Default::default()
                },
                ShotData {
                    length: 4.0,
                    ..Default::default()
                },
            ],
            ..Default::default()
        });

        project.add_section(SectionData {
            name: Some("B".to_string()),
            color: "#00ff00".to_string(),
            shots: vec![ShotData {
                length: 3.0,
                ..Default::default()
            }],
            ..Default::default()
        });

        // B:0 merges to A:1.
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

        // Closure from B:0 (merged) to A:2 should resolve to IDs 1 -> 2.
        project.loop_closures.push(LoopClosure {
            id: 42,
            station_a: StationRef {
                section_id: 1,
                station_index: 0,
            },
            station_b: StationRef {
                section_id: 0,
                station_index: 2,
            },
            path_length: 10.0,
            misclosure_distance: 0.4,
            error_percentage: 4.0,
            horizontal_misclosure: 0.4,
            vertical_misclosure: 0.0,
            strategy: ClosureStrategy::Batch,
            is_aligned: false,
        });

        let (shots, _baseline) = build_export_shots(&project);
        let closure = shots.iter().find(|s| s.shot_type == "CLOSURE").unwrap();
        assert_eq!(
            closure.from_id, 1,
            "B:0 should map to merged parent Ariane ID"
        );
        assert_eq!(closure.closure_to_id, 2, "A:2 should map to Ariane ID 2");
    }

    #[test]
    fn test_closure_export_uses_ariane_name_and_depth_in() {
        let mut project = Project::new("Closure Name".to_string(), None);
        project.add_section(SectionData {
            name: Some("Main".to_string()),
            color: "#ff0000".to_string(),
            shots: vec![
                ShotData {
                    length: 4.0,
                    ..Default::default()
                },
                ShotData {
                    length: 4.0,
                    ..Default::default()
                },
            ],
            ..Default::default()
        });

        project.loop_closures.push(LoopClosure {
            id: 7,
            station_a: StationRef {
                section_id: 0,
                station_index: 1,
            },
            station_b: StationRef {
                section_id: 0,
                station_index: 2,
            },
            path_length: 8.0,
            misclosure_distance: 0.2,
            error_percentage: 2.5,
            horizontal_misclosure: 0.2,
            vertical_misclosure: 0.0,
            strategy: ClosureStrategy::Batch,
            is_aligned: false,
        });

        let (shots, _baseline) = build_export_shots(&project);
        let closure = shots.iter().find(|s| s.shot_type == "CLOSURE").unwrap();
        assert!(
            closure.depth_in.abs() < f64::EPSILON,
            "closure DepthIn should be exported as 0.0"
        );

        let file = NamedTempFile::with_suffix(".tmlu").unwrap();
        export_tml(&project, file.path()).unwrap();
        let content = std::fs::read_to_string(file.path()).unwrap();
        assert!(content.contains("<TY>CLOSURE</TY>"));
        assert!(content.contains("<DPI>0.0</DPI>"));
        assert!(content.contains("<NM>CLOSURE:CLOSURE</NM>"));
    }

    #[test]
    fn test_zero_datum_coordinates_export_to_start_shot() {
        let mut project = Project::new("Datum Node".to_string(), None);
        project.add_section(SectionData {
            name: Some("Main".to_string()),
            color: "#ff0000".to_string(),
            shots: vec![
                ShotData {
                    length: 3.0,
                    ..Default::default()
                },
                ShotData {
                    length: 3.0,
                    ..Default::default()
                },
                ShotData {
                    length: 3.0,
                    ..Default::default()
                },
            ],
            ..Default::default()
        });

        project.zero_datums.push(ZeroDatum {
            station_ref: StationRef {
                section_id: 0,
                station_index: 2,
            },
            gps: GpsCoordinates::new(20.25, -87.5, 12.0).unwrap(),
        });

        let (shots, _baseline) = build_export_shots(&project);

        let start = shots.iter().find(|s| s.id == 0).unwrap();
        assert!((start.latitude - 20.25).abs() < f64::EPSILON);
        assert!((start.longitude - (-87.5)).abs() < f64::EPSILON);

        let shot_for_station_2 = shots.iter().find(|s| s.id == 2).unwrap();
        assert!(shot_for_station_2.latitude.abs() < f64::EPSILON);
        assert!(shot_for_station_2.longitude.abs() < f64::EPSILON);
    }

    #[test]
    fn test_nonzero_root_datum_splits_section_into_two_branches() {
        let mut project = Project::new("Split Root".to_string(), None);
        project.add_section(SectionData {
            name: Some("Main".to_string()),
            color: "#ff0000".to_string(),
            shots: vec![
                ShotData {
                    azimuth_in: 10.0,
                    azimuth_out: 210.0,
                    length: 1.0,
                    depth_in: 0.0,
                    depth_out: 1.0,
                    ..Default::default()
                },
                ShotData {
                    azimuth_in: 20.0,
                    azimuth_out: 15.0,
                    length: 1.0,
                    depth_in: 1.0,
                    depth_out: 2.0,
                    ..Default::default()
                },
                ShotData {
                    azimuth_in: 30.0,
                    azimuth_out: 230.0,
                    length: 1.0,
                    depth_in: 2.0,
                    depth_out: 3.0,
                    ..Default::default()
                },
            ],
            ..Default::default()
        });
        project.zero_datums.push(ZeroDatum {
            station_ref: StationRef {
                section_id: 0,
                station_index: 2,
            },
            gps: GpsCoordinates::new(20.0, -87.0, 0.0).unwrap(),
        });

        let (shots, _baseline) = build_export_shots(&project);
        let start = shots.iter().find(|s| s.shot_type == "START").unwrap();

        // Split produces two first shots from START: forward segment and reversed prefix.
        let from_start: Vec<&ExportShot> = shots
            .iter()
            .filter(|s| s.shot_type != "START" && s.from_id == start.id)
            .collect();
        assert_eq!(from_start.len(), 2);
        assert!(
            from_start.iter().any(|s| (s.azimuth - 30.0).abs() < f64::EPSILON),
            "forward branch should keep original azimuth at datum"
        );
        assert!(
            from_start.iter().any(|s| (s.azimuth - 200.0).abs() < f64::EPSILON),
            "reverse branch should invert forward azimuth of prefix shot"
        );
    }

    #[test]
    fn test_parent_links_reoriented_when_datum_forces_root() {
        let mut project = Project::new("Datum Root Orientation".to_string(), None);
        project.add_section(SectionData {
            name: Some("A".to_string()),
            color: "#ff0000".to_string(),
            shots: vec![
                ShotData {
                    length: 2.0,
                    ..Default::default()
                },
                ShotData {
                    length: 2.0,
                    ..Default::default()
                },
            ],
            ..Default::default()
        });
        project.add_section(SectionData {
            name: Some("B".to_string()),
            color: "#00ff00".to_string(),
            shots: vec![
                ShotData {
                    length: 2.0,
                    ..Default::default()
                },
                ShotData {
                    length: 2.0,
                    ..Default::default()
                },
                ShotData {
                    length: 2.0,
                    ..Default::default()
                },
            ],
            ..Default::default()
        });
        project.station_merges.push(StationMerge {
            station_a: StationRef {
                section_id: 0,
                station_index: 1,
            },
            station_b: StationRef {
                section_id: 1,
                station_index: 2,
            },
            merged_at: chrono::Utc::now(),
        });
        project.zero_datums.push(ZeroDatum {
            station_ref: StationRef {
                section_id: 1,
                station_index: 2,
            },
            gps: GpsCoordinates::new(20.0, -87.0, 0.0).unwrap(),
        });

        let (shots, _baseline) = build_export_shots(&project);
        let start = shots.iter().find(|s| s.shot_type == "START").unwrap();
        assert_eq!(start.section, "B");

        // Section A should now link into the forced-root section B.
        let link_into_root = shots
            .iter()
            .find(|s| s.section == "A" && s.from_id == start.id);
        assert!(
            link_into_root.is_some(),
            "expected a section A shot to link to B START after rooting at datum"
        );
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

        let (shots, _baseline) = build_export_shots(&project);
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

    #[test]
    fn test_child_nonzero_merge_splits_section() {
        let mut project = Project::new("Split Child".to_string(), None);

        // Root: 2 shots → stations 0,1,2
        project.add_section(SectionData {
            name: Some("Root".to_string()),
            color: "#ff0000".to_string(),
            shots: vec![
                ShotData {
                    length: 5.0,
                    azimuth_in: 90.0,
                    ..Default::default()
                },
                ShotData {
                    length: 5.0,
                    azimuth_in: 90.0,
                    ..Default::default()
                },
            ],
            ..Default::default()
        });

        // Child: 4 shots → stations 0,1,2,3,4. Merge at station 2.
        project.add_section(SectionData {
            name: Some("Branch".to_string()),
            color: "#00ff00".to_string(),
            shots: vec![
                ShotData {
                    length: 3.0,
                    azimuth_in: 10.0,
                    ..Default::default()
                },
                ShotData {
                    length: 4.0,
                    azimuth_in: 20.0,
                    ..Default::default()
                },
                ShotData {
                    length: 5.0,
                    azimuth_in: 30.0,
                    ..Default::default()
                },
                ShotData {
                    length: 6.0,
                    azimuth_in: 40.0,
                    ..Default::default()
                },
            ],
            ..Default::default()
        });

        // Merge child station 2 → root station 1.
        project.station_merges.push(StationMerge {
            station_a: StationRef {
                section_id: 0,
                station_index: 1,
            },
            station_b: StationRef {
                section_id: 1,
                station_index: 2,
            },
            merged_at: chrono::Utc::now(),
        });

        let (shots, _baseline) = build_export_shots(&project);

        // Root: START(0), shot0(1), shot1(2). parent station 1 → ariane id 1.
        // Forward block (child shots 2,3): id=3 from_id=1, id=4 from_id=3
        // Reverse block (child shots 1,0 reversed): id=5 from_id=1, id=6 from_id=5

        // Forward block shots chain from parent
        let fwd0 = shots.iter().find(|s| s.id == 3).unwrap();
        let fwd1 = shots.iter().find(|s| s.id == 4).unwrap();
        assert_eq!(fwd0.from_id, 1, "forward first shot links to parent");
        assert_eq!(fwd0.section, "Branch");
        assert_eq!(fwd1.from_id, 3, "forward second shot chains from previous");

        // Reverse block shots chain from parent
        let rev0 = shots.iter().find(|s| s.id == 5).unwrap();
        let rev1 = shots.iter().find(|s| s.id == 6).unwrap();
        assert_eq!(rev0.from_id, 1, "reverse first shot links to parent");
        assert_eq!(rev0.section, "Branch (reversed)");
        assert_eq!(rev1.from_id, 5, "reverse second shot chains from previous");

        // Verify reversal: reverse shots should have reciprocal azimuths
        // Shot 1 (azimuth_in=20) reversed → 200
        assert!(
            (rev0.azimuth - 200.0).abs() < 1e-9,
            "first reversed shot should have reciprocal azimuth of shot 1"
        );
        // Shot 0 (azimuth_in=10) reversed → 190
        assert!(
            (rev1.azimuth - 190.0).abs() < 1e-9,
            "second reversed shot should have reciprocal azimuth of shot 0"
        );

        // No orphaned from_id = -1 in any non-START shot
        for s in &shots {
            if s.shot_type != "START" {
                assert_ne!(s.from_id, -1, "shot id={} has orphaned from_id", s.id);
            }
        }
    }

    #[test]
    fn test_child_end_merge_reverses_section() {
        let mut project = Project::new("End Merge".to_string(), None);

        // Root: 2 shots
        project.add_section(SectionData {
            name: Some("Root".to_string()),
            color: "#ff0000".to_string(),
            shots: vec![
                ShotData {
                    length: 5.0,
                    azimuth_in: 90.0,
                    ..Default::default()
                },
                ShotData {
                    length: 5.0,
                    azimuth_in: 90.0,
                    ..Default::default()
                },
            ],
            ..Default::default()
        });

        // Child: 3 shots → stations 0,1,2,3. Merge at station 3 (= shots.len()).
        project.add_section(SectionData {
            name: Some("Tail".to_string()),
            color: "#00ff00".to_string(),
            shots: vec![
                ShotData {
                    length: 3.0,
                    azimuth_in: 10.0,
                    ..Default::default()
                },
                ShotData {
                    length: 4.0,
                    azimuth_in: 20.0,
                    ..Default::default()
                },
                ShotData {
                    length: 5.0,
                    azimuth_in: 30.0,
                    ..Default::default()
                },
            ],
            ..Default::default()
        });

        // Merge child station 3 (end) → root station 2.
        project.station_merges.push(StationMerge {
            station_a: StationRef {
                section_id: 0,
                station_index: 2,
            },
            station_b: StationRef {
                section_id: 1,
                station_index: 3,
            },
            merged_at: chrono::Utc::now(),
        });

        let (shots, _baseline) = build_export_shots(&project);

        // Root: START(0), shot0(1), shot1(2).
        // Reversed child: shots 2,1,0 reversed → id=3 from_id=2, id=4 from_id=3, id=5 from_id=4
        let rev0 = shots.iter().find(|s| s.id == 3).unwrap();
        let rev1 = shots.iter().find(|s| s.id == 4).unwrap();
        let rev2 = shots.iter().find(|s| s.id == 5).unwrap();
        assert_eq!(rev0.from_id, 2, "first reversed shot links to parent");
        assert_eq!(rev0.section, "Tail (reversed)");
        assert_eq!(rev1.from_id, 3, "second reversed shot chains");
        assert_eq!(rev2.from_id, 4, "third reversed shot chains");

        // Verify reciprocal azimuths
        assert!(
            (rev0.azimuth - 210.0).abs() < 1e-9,
            "shot 2 (az=30) reversed → 210"
        );
        assert!(
            (rev1.azimuth - 200.0).abs() < 1e-9,
            "shot 1 (az=20) reversed → 200"
        );
        assert!(
            (rev2.azimuth - 190.0).abs() < 1e-9,
            "shot 0 (az=10) reversed → 190"
        );

        // No orphaned from_id = -1 in non-START shots
        for s in &shots {
            if s.shot_type != "START" {
                assert_ne!(s.from_id, -1, "shot id={} has orphaned from_id", s.id);
            }
        }
    }

    #[test]
    fn test_downstream_of_split_child_resolves() {
        let mut project = Project::new("Downstream".to_string(), None);

        // Section A (root): 2 shots → stations 0,1,2
        project.add_section(SectionData {
            name: Some("A".to_string()),
            color: "#ff0000".to_string(),
            shots: vec![
                ShotData {
                    length: 5.0,
                    ..Default::default()
                },
                ShotData {
                    length: 5.0,
                    ..Default::default()
                },
            ],
            ..Default::default()
        });

        // Section B: 3 shots → stations 0,1,2,3. Merge at station 1 (non-zero).
        project.add_section(SectionData {
            name: Some("B".to_string()),
            color: "#00ff00".to_string(),
            shots: vec![
                ShotData {
                    length: 3.0,
                    ..Default::default()
                },
                ShotData {
                    length: 4.0,
                    ..Default::default()
                },
                ShotData {
                    length: 5.0,
                    ..Default::default()
                },
            ],
            ..Default::default()
        });

        // Section C: 1 shot → stations 0,1. Merge at station 0 (standard child).
        project.add_section(SectionData {
            name: Some("C".to_string()),
            color: "#0000ff".to_string(),
            shots: vec![ShotData {
                length: 2.0,
                ..Default::default()
            }],
            ..Default::default()
        });

        // B:1 merges to A:1
        project.station_merges.push(StationMerge {
            station_a: StationRef {
                section_id: 0,
                station_index: 1,
            },
            station_b: StationRef {
                section_id: 1,
                station_index: 1,
            },
            merged_at: chrono::Utc::now(),
        });

        // C:0 merges to B:3 (end of B's forward block)
        project.station_merges.push(StationMerge {
            station_a: StationRef {
                section_id: 1,
                station_index: 3,
            },
            station_b: StationRef {
                section_id: 2,
                station_index: 0,
            },
            merged_at: chrono::Utc::now(),
        });

        let (shots, _baseline) = build_export_shots(&project);

        // A: START(0), shot0(1), shot1(2)
        // B forward (shots 1,2): id=3 from_id→1, id=4 from_id=3
        //   station_to_ariane: (1,2)→3, (1,3)→4
        // B reverse (shot 0 reversed): id=5 from_id→1
        //   station_to_ariane: (1,0)→5
        // C: shot0(id=6). C merges at station 0 → normal child block.
        //   parent is B:3 → station_to_ariane[(1,3)] = 4
        //   second pass: child_station_idx=0, shots[0].from_id = 4

        let c_shot = shots.iter().find(|s| s.id == 6).unwrap();
        assert_eq!(
            c_shot.from_id, 4,
            "C's first shot should chain from B's forward block station 3"
        );
        assert_eq!(c_shot.section, "C");

        // No orphaned from_id = -1 in non-START shots
        for s in &shots {
            if s.shot_type != "START" {
                assert_ne!(s.from_id, -1, "shot id={} has orphaned from_id", s.id);
            }
        }
    }
}
