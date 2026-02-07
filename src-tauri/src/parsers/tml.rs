//! Ariane TML/TMLU file parser
//!
//! TML files are ZIP archives containing `Data.xml`; TMLU files are plain XML.
//! Both use the same schema but TML uses long element names while TMLU uses
//! short abbreviations.

use std::collections::HashMap;
use std::fs;
use std::io::Read as _;
use std::path::Path;

use anyhow::{anyhow, bail, Context, Result};
use chrono::NaiveDate;
use quick_xml::events::Event;
use quick_xml::Reader;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::models::{ImportPlacement, ImportSectionConfig, ShotData};

// ============================================================================
// IPC-visible types
// ============================================================================

/// Parsed Ariane TML/TMLU file.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct TmlFile {
    pub cave_name: String,
    pub unit: TmlUnit,
    pub use_magnetic_azimuth: bool,
    pub first_start_absolute_elevation: f64,
    pub geo_coding: Option<TmlGeoCoding>,
    pub sections: Vec<TmlSection>,
    pub closures: Vec<TmlClosure>,
}

/// Measurement unit in the TML file.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub enum TmlUnit {
    Metric,
    Imperial,
}

/// GPS reference from the TML file.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct TmlGeoCoding {
    pub latitude: f64,
    pub longitude: f64,
    pub altitude: f64,
}

/// A linearized survey section.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct TmlSection {
    pub name: String,
    pub shots: Vec<TmlShot>,
    pub surveyor: Option<String>,
    #[ts(type = "string | null")]
    pub date: Option<NaiveDate>,
    pub color: String,
    pub is_branch_split: bool,
    /// Ariane ID of the first shot's FromID (for topology linking).
    pub start_ariane_id: i64,
    /// Ariane ID of the last shot in this section.
    pub end_ariane_id: i64,
}

/// A single survey shot.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct TmlShot {
    pub id: i64,
    pub from_id: i64,
    pub shot_type: TmlShotType,
    pub azimuth: f64,
    pub length: f64,
    pub depth: f64,
    pub depth_in: f64,
    pub inclination: f64,
    pub left: f64,
    pub right: f64,
    pub up: f64,
    pub down: f64,
    pub comment: Option<String>,
    pub explorer: Option<String>,
    #[ts(type = "string | null")]
    pub date: Option<NaiveDate>,
    pub color: String,
    pub excluded: bool,
    pub latitude: f64,
    pub longitude: f64,
    pub closure_to_id: i64,
    pub section: String,
}

/// Shot type in Ariane.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub enum TmlShotType {
    Real,
    Virtual,
    Start,
    Closure,
}

/// A closure linking two stations across sections.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct TmlClosure {
    pub from_section_index: usize,
    pub from_station_index: usize,
    pub to_section_index: usize,
    pub to_station_index: usize,
}

// ============================================================================
// Internal raw shot for parsing
// ============================================================================

#[derive(Debug, Clone)]
struct RawShot {
    id: i64,
    from_id: i64,
    closure_to_id: i64,
    shot_type: TmlShotType,
    section: String,
    azimuth: f64,
    length: f64,
    depth: f64,
    depth_in: f64,
    inclination: f64,
    left: f64,
    right: f64,
    up: f64,
    down: f64,
    comment: Option<String>,
    explorer: Option<String>,
    date: Option<NaiveDate>,
    color: String,
    excluded: bool,
    latitude: f64,
    longitude: f64,
}

// ============================================================================
// Dual key mapping (TML long names ↔ TMLU short names)
// ============================================================================

/// Normalize an XML element name to a canonical key.
fn normalize_key(name: &str) -> Option<&'static str> {
    match name {
        "ID" | "Id" => Some("id"),
        "FromID" | "FRID" => Some("from_id"),
        "ClosureToID" | "CID" => Some("closure_to_id"),
        "Type" | "TY" => Some("type"),
        "Section" | "SC" => Some("section"),
        "Azimut" | "AZ" => Some("azimuth"),
        "Length" | "LG" => Some("length"),
        "Depth" | "DP" => Some("depth"),
        "DepthIn" | "DPI" => Some("depth_in"),
        "Inclination" | "INC" => Some("inclination"),
        "Left" | "L" => Some("left"),
        "Right" | "R" => Some("right"),
        "Up" | "U" => Some("up"),
        "Down" | "D" => Some("down"),
        "Comment" | "CM" => Some("comment"),
        "Explorer" | "EX" => Some("explorer"),
        "Date" | "DT" => Some("date"),
        "Color" | "CL" => Some("color"),
        "Excluded" | "EXC" => Some("excluded"),
        "Latitude" | "LT" => Some("latitude"),
        "Longitude" | "LGT" => Some("longitude"),
        "Name" | "NM" => Some("name"),
        _ => None,
    }
}

// ============================================================================
// XML loading
// ============================================================================

/// Load XML content from a `.tml` (ZIP) or `.tmlu` (plain XML) file.
fn load_xml(path: &Path) -> Result<String> {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .map(str::to_lowercase)
        .unwrap_or_default();

    match ext.as_str() {
        "tml" => load_xml_from_zip(path),
        "tmlu" => fs::read_to_string(path).context("Failed to read TMLU file"),
        _ => bail!("Unsupported file extension '.{ext}'. Expected .tml or .tmlu"),
    }
}

/// Extract `Data.xml` from a ZIP archive.
fn load_xml_from_zip(path: &Path) -> Result<String> {
    let file = fs::File::open(path).context("Failed to open TML file")?;
    let mut archive = zip::ZipArchive::new(file).context("Failed to read TML as ZIP archive")?;

    let mut data_file = archive
        .by_name("Data.xml")
        .context("TML archive does not contain 'Data.xml'")?;

    let mut xml = String::new();
    data_file
        .read_to_string(&mut xml)
        .context("Failed to read Data.xml from archive")?;
    Ok(xml)
}

// ============================================================================
// XML parsing
// ============================================================================

/// Parse all raw shots from XML content.
fn parse_raw_shots(xml: &str) -> Result<(Vec<RawShot>, FileMetadata)> {
    let mut reader = Reader::from_str(xml);

    let mut metadata = FileMetadata::default();
    let mut shots = Vec::new();

    // Parsing state
    let mut in_cave_file = false;
    let mut in_data = false;
    let mut in_shot = false;
    let mut in_shape = false; // skip Shape/SH subtrees
    let mut current_fields: HashMap<&'static str, String> = HashMap::new();
    let mut current_element: Option<String> = None;
    let mut depth: u32 = 0; // track depth inside Shape to skip nested elements

    let mut buf = Vec::new();

    loop {
        match reader.read_event_into(&mut buf) {
            Ok(Event::Start(e)) => {
                let name = String::from_utf8_lossy(e.name().as_ref()).to_string();

                if in_shape {
                    depth += 1;
                    continue;
                }

                match name.as_str() {
                    "CaveFile" => in_cave_file = true,
                    "Data" => in_data = true,
                    "SurveyData" | "SRVD" => {
                        in_shot = true;
                        current_fields.clear();
                    }
                    "Shape" | "SH" => {
                        in_shape = true;
                        depth = 1;
                    }
                    _ => {
                        if in_shot {
                            current_element = Some(name);
                        } else if in_cave_file && !in_data {
                            current_element = Some(name);
                        }
                    }
                }
            }
            Ok(Event::End(e)) => {
                let name = String::from_utf8_lossy(e.name().as_ref()).to_string();

                if in_shape {
                    depth -= 1;
                    if depth == 0 {
                        in_shape = false;
                    }
                    continue;
                }

                match name.as_str() {
                    "SurveyData" | "SRVD" => {
                        if in_shot {
                            match build_raw_shot(&current_fields) {
                                Ok(shot) => shots.push(shot),
                                Err(e) => {
                                    tracing::warn!(
                                        reason = %e,
                                        "Skipping malformed shot element"
                                    );
                                }
                            }
                            in_shot = false;
                        }
                    }
                    "Data" => in_data = false,
                    "CaveFile" => in_cave_file = false,
                    _ => {
                        current_element = None;
                    }
                }
            }
            Ok(Event::Text(e)) => {
                if in_shape {
                    continue;
                }
                if let Some(ref elem_name) = current_element {
                    let text = e
                        .unescape()
                        .unwrap_or_default()
                        .trim()
                        .to_string();
                    if !text.is_empty() {
                        if in_shot {
                            if let Some(key) = normalize_key(elem_name) {
                                current_fields.insert(key, text);
                            }
                        } else if in_cave_file && !in_data {
                            // File-level metadata
                            match elem_name.as_str() {
                                "caveName" => metadata.cave_name = text,
                                "unit" => metadata.unit = text,
                                "useMagneticAzimuth" => {
                                    metadata.use_magnetic_azimuth = text == "true";
                                }
                                "firstStartAbsoluteElevation" => {
                                    metadata.first_start_absolute_elevation =
                                        text.parse().unwrap_or(0.0);
                                }
                                _ => {}
                            }
                        }
                    }
                }
            }
            Ok(Event::Empty(e)) => {
                let name = String::from_utf8_lossy(e.name().as_ref()).to_string();
                // Handle self-closing shot elements like <CM/> (empty comment)
                if in_shot && !in_shape {
                    if let Some(key) = normalize_key(&name) {
                        current_fields.insert(key, String::new());
                    }
                }
            }
            Ok(Event::Eof) => break,
            Err(e) => bail!("XML parse error at position {}: {e}", reader.error_position()),
            _ => {}
        }
        buf.clear();
    }

    Ok((shots, metadata))
}

#[derive(Debug, Default)]
struct FileMetadata {
    cave_name: String,
    unit: String,
    use_magnetic_azimuth: bool,
    first_start_absolute_elevation: f64,
}

/// Build a `RawShot` from parsed field map.
fn build_raw_shot(fields: &HashMap<&str, String>) -> Result<RawShot> {
    let id = parse_i64(fields, "id").context("Missing or invalid ID")?;
    let from_id = parse_i64(fields, "from_id").unwrap_or(-1);

    let shot_type = match fields.get("type").map(String::as_str) {
        Some("REAL") => TmlShotType::Real,
        Some("VIRTUAL") => TmlShotType::Virtual,
        Some("START") => TmlShotType::Start,
        Some("CLOSURE") => TmlShotType::Closure,
        Some(other) => {
            tracing::warn!(shot_type = other, id, "Unknown shot type, treating as Real");
            TmlShotType::Real
        }
        None => TmlShotType::Real,
    };

    let section = fields
        .get("section")
        .cloned()
        .unwrap_or_default();

    let color = convert_ariane_color(fields.get("color").map(String::as_str));

    let date = fields
        .get("date")
        .and_then(|d| NaiveDate::parse_from_str(d, "%Y-%m-%d").ok());

    let comment = fields.get("comment").filter(|c| !c.is_empty()).cloned();
    let explorer = fields.get("explorer").filter(|e| !e.is_empty()).cloned();

    Ok(RawShot {
        id,
        from_id,
        closure_to_id: parse_i64(fields, "closure_to_id").unwrap_or(-1),
        shot_type,
        section,
        azimuth: parse_f64(fields, "azimuth"),
        length: parse_f64(fields, "length"),
        depth: parse_f64(fields, "depth"),
        depth_in: parse_f64_default(fields, "depth_in", -1.0),
        inclination: parse_f64(fields, "inclination"),
        left: parse_f64(fields, "left"),
        right: parse_f64(fields, "right"),
        up: parse_f64(fields, "up"),
        down: parse_f64(fields, "down"),
        comment,
        explorer,
        date,
        color,
        excluded: fields.get("excluded").map(String::as_str) == Some("true"),
        latitude: parse_f64(fields, "latitude"),
        longitude: parse_f64(fields, "longitude"),
    })
}

fn parse_f64(fields: &HashMap<&str, String>, key: &str) -> f64 {
    fields
        .get(key)
        .and_then(|v| v.parse::<f64>().ok())
        .unwrap_or(0.0)
}

fn parse_f64_default(fields: &HashMap<&str, String>, key: &str, default: f64) -> f64 {
    fields
        .get(key)
        .and_then(|v| v.parse::<f64>().ok())
        .unwrap_or(default)
}

fn parse_i64(fields: &HashMap<&str, String>, key: &str) -> Result<i64> {
    fields
        .get(key)
        .ok_or_else(|| anyhow!("Missing field '{key}'"))?
        .parse::<i64>()
        .map_err(|e| anyhow!("Invalid integer for '{key}': {e}"))
}

// ============================================================================
// Color conversion
// ============================================================================

/// Convert Ariane color `0xRRGGBBAA` → `#RRGGBB`. Falls back to default teal.
fn convert_ariane_color(color_str: Option<&str>) -> String {
    const DEFAULT_COLOR: &str = "#4ecdc4";

    let Some(s) = color_str else {
        return DEFAULT_COLOR.to_string();
    };
    let s = s.trim();
    if s.is_empty() {
        return DEFAULT_COLOR.to_string();
    }

    // Strip "0x" prefix
    let hex = if let Some(stripped) = s.strip_prefix("0x") {
        stripped
    } else if let Some(stripped) = s.strip_prefix("0X") {
        stripped
    } else {
        return DEFAULT_COLOR.to_string();
    };

    // Expect 8 hex chars (RRGGBBAA)
    if hex.len() != 8 || !hex.chars().all(|c| c.is_ascii_hexdigit()) {
        return DEFAULT_COLOR.to_string();
    }

    // Take first 6 chars (RRGGBB), skip alpha
    format!("#{}", &hex[..6])
}

// ============================================================================
// Sectioning and topology
// ============================================================================

/// Build topology and linearize into sections.
fn build_sections(raw_shots: Vec<RawShot>) -> (Vec<TmlSection>, Vec<TmlClosure>) {
    if raw_shots.is_empty() {
        return (Vec::new(), Vec::new());
    }

    // Index shots by ID
    let shot_by_id: HashMap<i64, &RawShot> = raw_shots.iter().map(|s| (s.id, s)).collect();

    // Build adjacency: from_id → list of successor shot IDs
    let mut successors: HashMap<i64, Vec<i64>> = HashMap::new();
    for shot in &raw_shots {
        if shot.from_id >= 0 {
            successors.entry(shot.from_id).or_default().push(shot.id);
        }
    }

    // Group non-START shots by section name, preserving FromID chain order
    let mut section_groups: Vec<(String, Vec<&RawShot>)> = Vec::new();
    let mut section_map: HashMap<String, usize> = HashMap::new();

    // Sort shots topologically: walk from each START shot
    let mut visited: std::collections::HashSet<i64> = std::collections::HashSet::new();
    let mut ordered_ids: Vec<i64> = Vec::new();

    // Find START shots as roots
    let mut roots: Vec<i64> = raw_shots
        .iter()
        .filter(|s| s.shot_type == TmlShotType::Start)
        .map(|s| s.id)
        .collect();
    roots.sort_unstable();

    // BFS from each root
    for root_id in &roots {
        let mut queue = std::collections::VecDeque::new();
        queue.push_back(*root_id);
        while let Some(current_id) = queue.pop_front() {
            if !visited.insert(current_id) {
                continue;
            }
            ordered_ids.push(current_id);
            if let Some(succs) = successors.get(&current_id) {
                for &succ_id in succs {
                    if !visited.contains(&succ_id) {
                        queue.push_back(succ_id);
                    }
                }
            }
        }
    }

    // Also add any unvisited shots (disconnected)
    for shot in &raw_shots {
        if visited.insert(shot.id) {
            ordered_ids.push(shot.id);
        }
    }

    // Now group ordered non-START shots by section name
    for &shot_id in &ordered_ids {
        let Some(shot) = shot_by_id.get(&shot_id) else {
            continue;
        };
        // Skip START shots - they carry no measurements
        if shot.shot_type == TmlShotType::Start {
            continue;
        }

        let section_name = if shot.section.is_empty() {
            "Unnamed".to_string()
        } else {
            shot.section.clone()
        };

        if let Some(&idx) = section_map.get(&section_name) {
            section_groups[idx].1.push(shot);
        } else {
            let idx = section_groups.len();
            section_map.insert(section_name.clone(), idx);
            section_groups.push((section_name, vec![shot]));
        }
    }

    // Within each group, linearize by walking FromID chains.
    // If branching detected (shot has multiple successors within the same section),
    // split into separate linear sections.
    let mut sections: Vec<TmlSection> = Vec::new();

    for (section_name, group_shots) in &section_groups {
        let linearized = linearize_section(section_name, group_shots, &successors);
        sections.extend(linearized);
    }

    // Extract closures: find CLOSURE shots and map to section:station indices
    let closures = extract_closures(&sections, &shot_by_id);

    (sections, closures)
}

/// Linearize a group of shots belonging to one section name.
/// Splits into multiple sub-sections if branching is detected.
fn linearize_section(
    section_name: &str,
    shots: &[&RawShot],
    successors: &HashMap<i64, Vec<i64>>,
) -> Vec<TmlSection> {
    if shots.is_empty() {
        return Vec::new();
    }

    let shot_ids: std::collections::HashSet<i64> = shots.iter().map(|s| s.id).collect();
    let shot_by_id: HashMap<i64, &&RawShot> = shots.iter().map(|s| (s.id, s)).collect();

    // Find chain roots: shots whose from_id is not in this section's shot set
    let mut roots: Vec<i64> = shots
        .iter()
        .filter(|s| !shot_ids.contains(&s.from_id))
        .map(|s| s.id)
        .collect();
    roots.sort_unstable();

    if roots.is_empty() {
        // Fallback: use first shot
        roots.push(shots[0].id);
    }

    let mut result = Vec::new();
    let mut visited: std::collections::HashSet<i64> = std::collections::HashSet::new();
    let needs_split = roots.len() > 1 || has_branching_within(shots, successors);

    for (branch_idx, root_id) in roots.iter().enumerate() {
        let mut chain = Vec::new();
        let mut current = *root_id;

        loop {
            if !visited.insert(current) {
                break;
            }
            if let Some(&&shot) = shot_by_id.get(&current) {
                chain.push(shot.clone());
            }
            // Find next shot in this section
            let next = successors
                .get(&current)
                .into_iter()
                .flatten()
                .find(|id| shot_ids.contains(id) && !visited.contains(id));
            match next {
                Some(&next_id) => {
                    // Check for branching: if there are multiple unvisited successors
                    // in this section, we'll come back to them via roots or later passes
                    current = next_id;
                }
                None => break,
            }
        }

        if chain.is_empty() {
            continue;
        }

        let name = if needs_split {
            format!("{section_name} (branch {branch})", branch = branch_idx + 1)
        } else {
            section_name.to_string()
        };

        let first_shot = &chain[0];
        let last_shot = &chain[chain.len() - 1];
        let surveyor = first_shot.explorer.clone();
        let date = first_shot.date;
        let color = first_shot.color.clone();

        let tml_shots: Vec<TmlShot> = chain
            .iter()
            .map(|s| TmlShot {
                id: s.id,
                from_id: s.from_id,
                shot_type: s.shot_type,
                azimuth: s.azimuth,
                length: s.length,
                depth: s.depth,
                depth_in: s.depth_in,
                inclination: s.inclination,
                left: s.left,
                right: s.right,
                up: s.up,
                down: s.down,
                comment: s.comment.clone(),
                explorer: s.explorer.clone(),
                date: s.date,
                color: s.color.clone(),
                excluded: s.excluded,
                latitude: s.latitude,
                longitude: s.longitude,
                closure_to_id: s.closure_to_id,
                section: s.section.clone(),
            })
            .collect();

        result.push(TmlSection {
            name,
            start_ariane_id: first_shot.from_id,
            end_ariane_id: last_shot.id,
            shots: tml_shots,
            surveyor,
            date,
            color,
            is_branch_split: needs_split,
        });
    }

    // Catch any shots not reachable from roots
    let remaining: Vec<&RawShot> = shots
        .iter()
        .filter(|s| !visited.contains(&s.id))
        .copied()
        .collect();

    if !remaining.is_empty() {
        let name = if needs_split || !result.is_empty() {
            let n = result.len() + 1;
            format!("{section_name} (branch {n})")
        } else {
            section_name.to_string()
        };

        let first_shot = remaining[0];
        let last_shot = remaining[remaining.len() - 1];

        let tml_shots: Vec<TmlShot> = remaining
            .iter()
            .map(|s| TmlShot {
                id: s.id,
                from_id: s.from_id,
                shot_type: s.shot_type,
                azimuth: s.azimuth,
                length: s.length,
                depth: s.depth,
                depth_in: s.depth_in,
                inclination: s.inclination,
                left: s.left,
                right: s.right,
                up: s.up,
                down: s.down,
                comment: s.comment.clone(),
                explorer: s.explorer.clone(),
                date: s.date,
                color: s.color.clone(),
                excluded: s.excluded,
                latitude: s.latitude,
                longitude: s.longitude,
                closure_to_id: s.closure_to_id,
                section: s.section.clone(),
            })
            .collect();

        result.push(TmlSection {
            name,
            start_ariane_id: first_shot.from_id,
            end_ariane_id: last_shot.id,
            shots: tml_shots,
            surveyor: first_shot.explorer.clone(),
            date: first_shot.date,
            color: first_shot.color.clone(),
            is_branch_split: true,
        });
    }

    result
}

/// Check if any shot in the group has multiple successors within the same group.
fn has_branching_within(
    shots: &[&RawShot],
    successors: &HashMap<i64, Vec<i64>>,
) -> bool {
    let shot_ids: std::collections::HashSet<i64> = shots.iter().map(|s| s.id).collect();
    for shot in shots {
        if let Some(succs) = successors.get(&shot.id) {
            let in_section = succs.iter().filter(|id| shot_ids.contains(id)).count();
            if in_section > 1 {
                return true;
            }
        }
    }
    false
}

/// Extract closure information from CLOSURE-type shots.
fn extract_closures(
    sections: &[TmlSection],
    shot_by_id: &HashMap<i64, &RawShot>,
) -> Vec<TmlClosure> {
    // Build reverse index: shot ID → (section_index, station_index)
    let mut id_to_location: HashMap<i64, (usize, usize)> = HashMap::new();
    for (si, section) in sections.iter().enumerate() {
        for (shot_idx, shot) in section.shots.iter().enumerate() {
            id_to_location.insert(shot.id, (si, shot_idx));
        }
    }

    let mut closures = Vec::new();

    for (si, section) in sections.iter().enumerate() {
        for (shot_idx, shot) in section.shots.iter().enumerate() {
            if shot.shot_type == TmlShotType::Closure && shot.closure_to_id >= 0 {
                // The closure shot itself is the "from" location
                let from_section_index = si;
                let from_station_index = shot_idx;

                // closure_to_id points to the target shot
                if let Some(&(to_si, to_shot_idx)) = id_to_location.get(&shot.closure_to_id) {
                    closures.push(TmlClosure {
                        from_section_index,
                        from_station_index,
                        to_section_index: to_si,
                        to_station_index: to_shot_idx,
                    });
                } else {
                    // Target might be a START shot (not in sections). Try finding
                    // the first shot whose from_id matches the closure target.
                    if let Some(target_raw) = shot_by_id.get(&shot.closure_to_id) {
                        if target_raw.shot_type == TmlShotType::Start {
                            // Find the first shot that has from_id == closure_to_id
                            // (i.e., the first real shot after the START)
                            let target = id_to_location.iter().find(|(&_id, _)| {
                                sections
                                    .get(id_to_location.get(&_id).map_or(usize::MAX, |l| l.0))
                                    .and_then(|s| s.shots.first())
                                    .map_or(false, |first_shot| {
                                        first_shot.from_id == shot.closure_to_id
                                    })
                            });
                            if let Some((&_, &(to_si, _))) = target {
                                // Station 0 of the target section (first station after START)
                                closures.push(TmlClosure {
                                    from_section_index,
                                    from_station_index,
                                    to_section_index: to_si,
                                    to_station_index: 0,
                                });
                            }
                        }
                    }
                }
            }
        }
    }

    closures
}

// ============================================================================
// Unit conversion
// ============================================================================

const FEET_TO_METERS: f64 = 0.3048;

/// Apply imperial→metric conversion in place if the file uses imperial units.
fn apply_unit_conversion(sections: &mut [TmlSection], unit: TmlUnit) {
    if unit != TmlUnit::Imperial {
        return;
    }

    for section in sections.iter_mut() {
        for shot in &mut section.shots {
            shot.length *= FEET_TO_METERS;
            shot.depth *= FEET_TO_METERS;
            if shot.depth_in != -1.0 {
                shot.depth_in *= FEET_TO_METERS;
            }
            shot.left *= FEET_TO_METERS;
            shot.right *= FEET_TO_METERS;
            shot.up *= FEET_TO_METERS;
            shot.down *= FEET_TO_METERS;
        }
    }
}

// ============================================================================
// Public parse entry point
// ============================================================================

/// Parse a TML or TMLU file into a `TmlFile`.
pub fn parse_tml(path: &Path) -> Result<TmlFile> {
    tracing::info!(path = ?path, "Parsing Ariane TML/TMLU file");

    let xml = load_xml(path)?;
    let (raw_shots, metadata) = parse_raw_shots(&xml)?;

    tracing::debug!(
        shot_count = raw_shots.len(),
        cave_name = %metadata.cave_name,
        unit = %metadata.unit,
        "Parsed raw shots from XML"
    );

    let unit = match metadata.unit.to_lowercase().as_str() {
        "ft" | "imperial" => TmlUnit::Imperial,
        _ => TmlUnit::Metric,
    };

    let (mut sections, closures) = build_sections(raw_shots);

    // Apply unit conversion before returning
    apply_unit_conversion(&mut sections, unit);

    // Extract geo coding from first shot with non-zero lat/lng
    let geo_coding = sections
        .iter()
        .flat_map(|s| &s.shots)
        .find(|shot| shot.latitude.abs() > f64::EPSILON || shot.longitude.abs() > f64::EPSILON)
        .map(|shot| TmlGeoCoding {
            latitude: shot.latitude,
            longitude: shot.longitude,
            altitude: metadata.first_start_absolute_elevation,
        });

    tracing::info!(
        sections = sections.len(),
        closures = closures.len(),
        unit = ?unit,
        "TML parsing complete"
    );

    Ok(TmlFile {
        cave_name: metadata.cave_name,
        unit,
        use_magnetic_azimuth: metadata.use_magnetic_azimuth,
        first_start_absolute_elevation: metadata.first_start_absolute_elevation,
        geo_coding,
        sections,
        closures,
    })
}

// ============================================================================
// Conversion to ImportSectionConfig
// ============================================================================

/// Convert a parsed TML file into `ImportSectionConfig` values ready for
/// `execute_import_sections`.
pub fn convert_tml_to_import_configs(tml: &TmlFile) -> Result<Vec<ImportSectionConfig>> {
    if tml.sections.is_empty() {
        return Ok(Vec::new());
    }

    // Build a mapping from Ariane shot ID → (section_index, station_index)
    // to resolve topology connections between sections.
    let mut id_to_import_loc: HashMap<i64, (u32, u32)> = HashMap::new();
    for (si, section) in tml.sections.iter().enumerate() {
        for (shot_idx, shot) in section.shots.iter().enumerate() {
            id_to_import_loc.insert(shot.id, (si as u32, shot_idx as u32));
        }
    }

    // Also track which section contains a shot whose from_id == X
    // (i.e., which section "starts from" shot X)
    let mut start_from_id: HashMap<i64, u32> = HashMap::new();
    for (si, section) in tml.sections.iter().enumerate() {
        if let Some(first_shot) = section.shots.first() {
            if first_shot.from_id >= 0 {
                start_from_id.insert(first_shot.from_id, si as u32);
            }
        }
    }

    let mut configs: Vec<ImportSectionConfig> = Vec::new();

    for (si, section) in tml.sections.iter().enumerate() {
        let section_index = si as u32;

        // Convert shots to ShotData
        let shot_data = convert_shots_to_shot_data(&section.shots);

        // Determine placement
        let placement = determine_placement(
            section,
            section_index,
            &id_to_import_loc,
            tml.geo_coding.as_ref(),
        );

        configs.push(ImportSectionConfig {
            section_index,
            name: Some(section.name.clone()),
            surveyor: section.surveyor.clone(),
            date: section.date,
            color: section.color.clone(),
            direction: None, // Ariane doesn't distinguish in/out direction
            quality: 1.0,
            shots: shot_data,
            placement,
        });
    }

    Ok(configs)
}

/// Convert TML shots to `ShotData` for import.
///
/// Depth handling: Ariane `DP` is cumulative station depth. For each shot,
/// `depth_in` = previous shot's DP (or DPI if != -1.0), `depth_out` = this shot's DP.
/// Depths are rebased relative to the first shot's starting depth.
fn convert_shots_to_shot_data(shots: &[TmlShot]) -> Vec<ShotData> {
    if shots.is_empty() {
        return Vec::new();
    }

    // The first shot's "incoming" depth reference
    let base_depth = if shots[0].depth_in != -1.0 {
        shots[0].depth_in
    } else {
        0.0
    };

    let mut result = Vec::with_capacity(shots.len());

    for (i, shot) in shots.iter().enumerate() {
        // depth_in for this shot
        let raw_depth_in = if shot.depth_in != -1.0 {
            shot.depth_in
        } else if i > 0 {
            shots[i - 1].depth
        } else {
            0.0
        };

        let depth_in = raw_depth_in - base_depth;
        let depth_out = shot.depth - base_depth;

        // LRUD: pass through, using None for zero values
        let lrud_opt = |v: f64| if v.abs() < f64::EPSILON { None } else { Some(v) };

        result.push(ShotData {
            azimuth_in: shot.azimuth,
            azimuth_out: shot.azimuth, // No backsight in Ariane
            length: shot.length,
            depth_in,
            depth_out,
            pitch_in: Some(shot.inclination),
            pitch_out: None, // No backsight inclination
            left: lrud_opt(shot.left),
            right: lrud_opt(shot.right),
            up: lrud_opt(shot.up),
            down: lrud_opt(shot.down),
            comment: shot.comment.clone(),
            is_virtual: shot.shot_type == TmlShotType::Virtual,
            marker_index: None,
            temperature: None,
        });
    }

    result
}

/// Determine placement for a section based on topology and GPS data.
fn determine_placement(
    section: &TmlSection,
    section_index: u32,
    id_to_import_loc: &HashMap<i64, (u32, u32)>,
    _geo_coding: Option<&TmlGeoCoding>,
) -> ImportPlacement {
    // First section → Origin
    if section_index == 0 {
        // Check if first shot has GPS data
        if let Some(first_shot) = section.shots.first() {
            if first_shot.latitude.abs() > f64::EPSILON
                || first_shot.longitude.abs() > f64::EPSILON
            {
                return ImportPlacement::ZeroDatum {
                    coordinates: crate::models::GpsCoordinates {
                        latitude: first_shot.latitude,
                        longitude: first_shot.longitude,
                        depth_reference: 0.0,
                    },
                    station_index: 0,
                };
            }
        }
        return ImportPlacement::Origin;
    }

    // Check if this section's first shot connects to a shot in an earlier section
    let first_shot_from_id = section.start_ariane_id;
    if first_shot_from_id >= 0 {
        if let Some(&(target_section, target_station)) = id_to_import_loc.get(&first_shot_from_id) {
            if target_section < section_index {
                return ImportPlacement::FromImporting {
                    import_station: 0, // First station of this section
                    target_section_index: target_section,
                    target_station_index: target_station,
                };
            }
        }
    }

    // Check for GPS data on first shot
    if let Some(first_shot) = section.shots.first() {
        if first_shot.latitude.abs() > f64::EPSILON || first_shot.longitude.abs() > f64::EPSILON {
            return ImportPlacement::ZeroDatum {
                coordinates: crate::models::GpsCoordinates {
                    latitude: first_shot.latitude,
                    longitude: first_shot.longitude,
                    depth_reference: 0.0,
                },
                station_index: 0,
            };
        }
    }

    // Disconnected section → Origin with warning
    tracing::warn!(
        section = %section.name,
        "Section has no topology link or GPS data, placing at origin"
    );
    ImportPlacement::Origin
}

// ============================================================================
// Tests
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    // Helper to build minimal XML for testing
    fn wrap_xml(shots_xml: &str) -> String {
        format!(
            r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<CaveFile>
    <caveName>Test Cave</caveName>
    <unit>m</unit>
    <useMagneticAzimuth>true</useMagneticAzimuth>
    <firstStartAbsoluteElevation>100.0</firstStartAbsoluteElevation>
    <Data>
        {shots_xml}
    </Data>
</CaveFile>"#
        )
    }

    fn tml_shot_xml(id: i64, from_id: i64, shot_type: &str, section: &str) -> String {
        format!(
            r#"<SurveyData>
    <ID>{id}</ID>
    <FromID>{from_id}</FromID>
    <ClosureToID>-1</ClosureToID>
    <Type>{shot_type}</Type>
    <Section>{section}</Section>
    <Azimut>90.0</Azimut>
    <Length>10.0</Length>
    <Depth>5.0</Depth>
    <DepthIn>-1.0</DepthIn>
    <Inclination>2.0</Inclination>
    <Left>1.0</Left>
    <Right>2.0</Right>
    <Up>3.0</Up>
    <Down>4.0</Down>
    <Comment></Comment>
    <Explorer>Tester</Explorer>
    <Date>2024-06-15</Date>
    <Color>0x8f6112ff</Color>
    <Excluded>false</Excluded>
    <Latitude>0.0</Latitude>
    <Longitude>0.0</Longitude>
</SurveyData>"#
        )
    }

    fn tmlu_shot_xml(id: i64, from_id: i64, shot_type: &str, section: &str) -> String {
        format!(
            r#"<SRVD>
    <ID>{id}</ID>
    <FRID>{from_id}</FRID>
    <CID>-1</CID>
    <TY>{shot_type}</TY>
    <SC>{section}</SC>
    <AZ>45.0</AZ>
    <LG>5.0</LG>
    <DP>3.0</DP>
    <DPI>-1.0</DPI>
    <INC>1.0</INC>
    <L>0.5</L>
    <R>0.5</R>
    <U>1.5</U>
    <D>0.5</D>
    <CM></CM>
    <EX>Explorer1</EX>
    <DT>2025-01-01</DT>
    <CL>0x44aa88ff</CL>
    <EXC>false</EXC>
    <LT>0.0</LT>
    <LGT>0.0</LGT>
</SRVD>"#
        )
    }

    // -------------------------------------------------------------------
    // Color conversion tests
    // -------------------------------------------------------------------

    #[test]
    fn test_color_conversion_standard() {
        assert_eq!(convert_ariane_color(Some("0x8f6112ff")), "#8f6112");
        assert_eq!(convert_ariane_color(Some("0xFF0000FF")), "#FF0000");
    }

    #[test]
    fn test_color_conversion_fallback() {
        assert_eq!(convert_ariane_color(None), "#4ecdc4");
        assert_eq!(convert_ariane_color(Some("")), "#4ecdc4");
        assert_eq!(convert_ariane_color(Some("invalid")), "#4ecdc4");
        assert_eq!(convert_ariane_color(Some("0xZZZZZZZZ")), "#4ecdc4");
        assert_eq!(convert_ariane_color(Some("0x123")), "#4ecdc4"); // too short
    }

    // -------------------------------------------------------------------
    // XML parsing: TML long keys
    // -------------------------------------------------------------------

    #[test]
    fn test_parse_tml_long_keys() {
        let xml = wrap_xml(&[
            tml_shot_xml(0, -1, "START", "Start"),
            tml_shot_xml(1, 0, "REAL", "Section 1"),
        ].join("\n"));

        let (shots, meta) = parse_raw_shots(&xml).unwrap_or_else(|_| {
            std::process::abort(); // unreachable in tests
            #[allow(unreachable_code)]
            { (Vec::new(), FileMetadata::default()) }
        });

        // Must not panic-unwrap, use assert
        assert_eq!(meta.cave_name, "Test Cave");
        assert_eq!(meta.unit, "m");
        assert!(meta.use_magnetic_azimuth);
        assert!((meta.first_start_absolute_elevation - 100.0).abs() < f64::EPSILON);
        assert_eq!(shots.len(), 2);
        assert_eq!(shots[0].shot_type, TmlShotType::Start);
        assert_eq!(shots[1].shot_type, TmlShotType::Real);
        assert!((shots[1].azimuth - 90.0).abs() < f64::EPSILON);
        assert!((shots[1].length - 10.0).abs() < f64::EPSILON);
    }

    // -------------------------------------------------------------------
    // XML parsing: TMLU short keys
    // -------------------------------------------------------------------

    #[test]
    fn test_parse_tmlu_short_keys() {
        let xml = wrap_xml(&[
            tmlu_shot_xml(0, -1, "START", "Start"),
            tmlu_shot_xml(1, 0, "REAL", "Sec A"),
        ].join("\n"));

        let (shots, _) = parse_raw_shots(&xml).unwrap_or_else(|_| {
            (Vec::new(), FileMetadata::default())
        });

        assert_eq!(shots.len(), 2);
        assert_eq!(shots[1].section, "Sec A");
        assert!((shots[1].azimuth - 45.0).abs() < f64::EPSILON);
        assert!((shots[1].length - 5.0).abs() < f64::EPSILON);
    }

    // -------------------------------------------------------------------
    // START shot exclusion
    // -------------------------------------------------------------------

    #[test]
    fn test_start_shots_excluded_from_sections() {
        let xml = wrap_xml(&[
            tml_shot_xml(0, -1, "START", "Start"),
            tml_shot_xml(1, 0, "REAL", "Section 1"),
            tml_shot_xml(2, 1, "REAL", "Section 1"),
        ].join("\n"));

        let (raw_shots, _) = parse_raw_shots(&xml).unwrap_or_else(|_| {
            (Vec::new(), FileMetadata::default())
        });

        let (sections, _) = build_sections(raw_shots);
        assert_eq!(sections.len(), 1);
        assert_eq!(sections[0].shots.len(), 2);
        // No START shot in the section
        for shot in &sections[0].shots {
            assert_ne!(shot.shot_type, TmlShotType::Start);
        }
    }

    // -------------------------------------------------------------------
    // VIRTUAL shot marking
    // -------------------------------------------------------------------

    #[test]
    fn test_virtual_shot_detected() {
        let xml = wrap_xml(&[
            tml_shot_xml(0, -1, "START", "Start"),
            tml_shot_xml(1, 0, "VIRTUAL", "Section 1"),
        ].join("\n"));

        let (raw_shots, _) = parse_raw_shots(&xml).unwrap_or_else(|_| {
            (Vec::new(), FileMetadata::default())
        });

        let (sections, _) = build_sections(raw_shots);
        assert_eq!(sections[0].shots[0].shot_type, TmlShotType::Virtual);
    }

    // -------------------------------------------------------------------
    // Depth conversion
    // -------------------------------------------------------------------

    #[test]
    fn test_depth_conversion_linear_chain() {
        // 3 shots with cumulative depths 0, 5, 12
        let xml = wrap_xml(&format!(
            r#"
            <SurveyData>
                <ID>0</ID><FromID>-1</FromID><ClosureToID>-1</ClosureToID>
                <Type>START</Type><Section>Start</Section>
                <Azimut>0</Azimut><Length>0</Length><Depth>0</Depth><DepthIn>-1.0</DepthIn>
                <Inclination>0</Inclination><Left>0</Left><Right>0</Right><Up>0</Up><Down>0</Down>
                <Color>0x000000ff</Color><Excluded>false</Excluded><Latitude>0</Latitude><Longitude>0</Longitude>
            </SurveyData>
            <SurveyData>
                <ID>1</ID><FromID>0</FromID><ClosureToID>-1</ClosureToID>
                <Type>REAL</Type><Section>S1</Section>
                <Azimut>90</Azimut><Length>10</Length><Depth>5.0</Depth><DepthIn>-1.0</DepthIn>
                <Inclination>0</Inclination><Left>1</Left><Right>1</Right><Up>1</Up><Down>1</Down>
                <Color>0x000000ff</Color><Excluded>false</Excluded><Latitude>0</Latitude><Longitude>0</Longitude>
            </SurveyData>
            <SurveyData>
                <ID>2</ID><FromID>1</FromID><ClosureToID>-1</ClosureToID>
                <Type>REAL</Type><Section>S1</Section>
                <Azimut>180</Azimut><Length>8</Length><Depth>12.0</Depth><DepthIn>-1.0</DepthIn>
                <Inclination>-5</Inclination><Left>2</Left><Right>2</Right><Up>2</Up><Down>2</Down>
                <Color>0x000000ff</Color><Excluded>false</Excluded><Latitude>0</Latitude><Longitude>0</Longitude>
            </SurveyData>
            "#
        ));

        let (raw_shots, _) = parse_raw_shots(&xml).unwrap_or_else(|_| {
            (Vec::new(), FileMetadata::default())
        });
        let (sections, _) = build_sections(raw_shots);
        let shot_data = convert_shots_to_shot_data(&sections[0].shots);

        // Shot 1: depth_in=0 (from START, base=0), depth_out=5
        assert!((shot_data[0].depth_in - 0.0).abs() < f64::EPSILON);
        assert!((shot_data[0].depth_out - 5.0).abs() < f64::EPSILON);

        // Shot 2: depth_in=5 (prev shot's DP), depth_out=12
        assert!((shot_data[1].depth_in - 5.0).abs() < f64::EPSILON);
        assert!((shot_data[1].depth_out - 12.0).abs() < f64::EPSILON);
    }

    #[test]
    fn test_depth_conversion_explicit_dpi() {
        // Shot with explicit DepthIn != -1.0
        let xml = wrap_xml(&format!(
            r#"
            <SurveyData>
                <ID>0</ID><FromID>-1</FromID><ClosureToID>-1</ClosureToID>
                <Type>START</Type><Section>Start</Section>
                <Azimut>0</Azimut><Length>0</Length><Depth>0</Depth><DepthIn>-1.0</DepthIn>
                <Inclination>0</Inclination><Left>0</Left><Right>0</Right><Up>0</Up><Down>0</Down>
                <Color>0x000000ff</Color><Excluded>false</Excluded><Latitude>0</Latitude><Longitude>0</Longitude>
            </SurveyData>
            <SurveyData>
                <ID>1</ID><FromID>0</FromID><ClosureToID>-1</ClosureToID>
                <Type>REAL</Type><Section>S1</Section>
                <Azimut>90</Azimut><Length>10</Length><Depth>5.0</Depth><DepthIn>2.0</DepthIn>
                <Inclination>0</Inclination><Left>0</Left><Right>0</Right><Up>0</Up><Down>0</Down>
                <Color>0x000000ff</Color><Excluded>false</Excluded><Latitude>0</Latitude><Longitude>0</Longitude>
            </SurveyData>
            "#
        ));

        let (raw_shots, _) = parse_raw_shots(&xml).unwrap_or_else(|_| {
            (Vec::new(), FileMetadata::default())
        });
        let (sections, _) = build_sections(raw_shots);
        let shot_data = convert_shots_to_shot_data(&sections[0].shots);

        // DPI=2.0 used as base and as depth_in; depth_out = 5.0 - 2.0 = 3.0
        assert!((shot_data[0].depth_in - 0.0).abs() < f64::EPSILON);
        assert!((shot_data[0].depth_out - 3.0).abs() < f64::EPSILON);
    }

    // -------------------------------------------------------------------
    // Unit conversion
    // -------------------------------------------------------------------

    #[test]
    fn test_imperial_conversion() {
        let mut sections = vec![TmlSection {
            name: "Test".to_string(),
            shots: vec![TmlShot {
                id: 1,
                from_id: 0,
                shot_type: TmlShotType::Real,
                azimuth: 90.0,
                length: 10.0,   // feet
                depth: 5.0,     // feet
                depth_in: -1.0,
                inclination: 0.0,
                left: 3.0,
                right: 4.0,
                up: 2.0,
                down: 1.0,
                comment: None,
                explorer: None,
                date: None,
                color: "#000000".to_string(),
                excluded: false,
                latitude: 0.0,
                longitude: 0.0,
                closure_to_id: -1,
                section: "Test".to_string(),
            }],
            surveyor: None,
            date: None,
            color: "#000000".to_string(),
            is_branch_split: false,
            start_ariane_id: 0,
            end_ariane_id: 1,
        }];

        apply_unit_conversion(&mut sections, TmlUnit::Imperial);

        let shot = &sections[0].shots[0];
        assert!((shot.length - 10.0 * FEET_TO_METERS).abs() < 1e-6);
        assert!((shot.depth - 5.0 * FEET_TO_METERS).abs() < 1e-6);
        assert!((shot.left - 3.0 * FEET_TO_METERS).abs() < 1e-6);
        assert!((shot.right - 4.0 * FEET_TO_METERS).abs() < 1e-6);
        // depth_in == -1.0 should NOT be converted
        assert!((shot.depth_in - (-1.0)).abs() < f64::EPSILON);
    }

    #[test]
    fn test_metric_unchanged() {
        let mut sections = vec![TmlSection {
            name: "Test".to_string(),
            shots: vec![TmlShot {
                id: 1,
                from_id: 0,
                shot_type: TmlShotType::Real,
                azimuth: 90.0,
                length: 10.0,
                depth: 5.0,
                depth_in: -1.0,
                inclination: 0.0,
                left: 3.0,
                right: 4.0,
                up: 2.0,
                down: 1.0,
                comment: None,
                explorer: None,
                date: None,
                color: "#000000".to_string(),
                excluded: false,
                latitude: 0.0,
                longitude: 0.0,
                closure_to_id: -1,
                section: "Test".to_string(),
            }],
            surveyor: None,
            date: None,
            color: "#000000".to_string(),
            is_branch_split: false,
            start_ariane_id: 0,
            end_ariane_id: 1,
        }];

        apply_unit_conversion(&mut sections, TmlUnit::Metric);

        let shot = &sections[0].shots[0];
        assert!((shot.length - 10.0).abs() < f64::EPSILON);
        assert!((shot.depth - 5.0).abs() < f64::EPSILON);
    }

    // -------------------------------------------------------------------
    // Branching detection
    // -------------------------------------------------------------------

    #[test]
    fn test_linear_no_split() {
        let xml = wrap_xml(&[
            tml_shot_xml(0, -1, "START", "Start"),
            tml_shot_xml(1, 0, "REAL", "Section 1"),
            tml_shot_xml(2, 1, "REAL", "Section 1"),
            tml_shot_xml(3, 2, "REAL", "Section 1"),
        ].join("\n"));

        let (raw_shots, _) = parse_raw_shots(&xml).unwrap_or_else(|_| {
            (Vec::new(), FileMetadata::default())
        });
        let (sections, _) = build_sections(raw_shots);

        assert_eq!(sections.len(), 1);
        assert_eq!(sections[0].name, "Section 1");
        assert!(!sections[0].is_branch_split);
        assert_eq!(sections[0].shots.len(), 3);
    }

    #[test]
    fn test_branch_detection_and_split() {
        // Shot 1 has two successors (2 and 3) in the same section
        let xml = wrap_xml(&[
            tml_shot_xml(0, -1, "START", "Start"),
            tml_shot_xml(1, 0, "REAL", "Section 1"),
            tml_shot_xml(2, 1, "REAL", "Section 1"),
            tml_shot_xml(3, 1, "REAL", "Section 1"), // branches from same shot
        ].join("\n"));

        let (raw_shots, _) = parse_raw_shots(&xml).unwrap_or_else(|_| {
            (Vec::new(), FileMetadata::default())
        });
        let (sections, _) = build_sections(raw_shots);

        // Should split into 2 branches
        assert!(sections.len() >= 2);
        assert!(sections.iter().all(|s| s.is_branch_split));
        assert!(sections[0].name.contains("branch"));
    }

    // -------------------------------------------------------------------
    // Closure extraction
    // -------------------------------------------------------------------

    #[test]
    fn test_closure_mapping() {
        let xml = wrap_xml(&format!(
            r#"
            <SurveyData>
                <ID>0</ID><FromID>-1</FromID><ClosureToID>-1</ClosureToID>
                <Type>START</Type><Section>Start</Section>
                <Azimut>0</Azimut><Length>0</Length><Depth>0</Depth><DepthIn>-1.0</DepthIn>
                <Inclination>0</Inclination><Left>0</Left><Right>0</Right><Up>0</Up><Down>0</Down>
                <Color>0x000000ff</Color><Excluded>false</Excluded><Latitude>0</Latitude><Longitude>0</Longitude>
            </SurveyData>
            <SurveyData>
                <ID>1</ID><FromID>0</FromID><ClosureToID>-1</ClosureToID>
                <Type>REAL</Type><Section>Sec A</Section>
                <Azimut>90</Azimut><Length>10</Length><Depth>5</Depth><DepthIn>-1.0</DepthIn>
                <Inclination>0</Inclination><Left>1</Left><Right>1</Right><Up>1</Up><Down>1</Down>
                <Color>0x000000ff</Color><Excluded>false</Excluded><Latitude>0</Latitude><Longitude>0</Longitude>
            </SurveyData>
            <SurveyData>
                <ID>2</ID><FromID>1</FromID><ClosureToID>-1</ClosureToID>
                <Type>REAL</Type><Section>Sec B</Section>
                <Azimut>180</Azimut><Length>8</Length><Depth>3</Depth><DepthIn>-1.0</DepthIn>
                <Inclination>0</Inclination><Left>1</Left><Right>1</Right><Up>1</Up><Down>1</Down>
                <Color>0x000000ff</Color><Excluded>false</Excluded><Latitude>0</Latitude><Longitude>0</Longitude>
            </SurveyData>
            <SurveyData>
                <ID>3</ID><FromID>2</FromID><ClosureToID>1</ClosureToID>
                <Type>CLOSURE</Type><Section>Sec B</Section>
                <Azimut>270</Azimut><Length>5</Length><Depth>5</Depth><DepthIn>-1.0</DepthIn>
                <Inclination>0</Inclination><Left>0</Left><Right>0</Right><Up>0</Up><Down>0</Down>
                <Color>0x000000ff</Color><Excluded>false</Excluded><Latitude>0</Latitude><Longitude>0</Longitude>
            </SurveyData>
            "#
        ));

        let (raw_shots, _) = parse_raw_shots(&xml).unwrap_or_else(|_| {
            (Vec::new(), FileMetadata::default())
        });
        let (sections, closures) = build_sections(raw_shots);

        assert_eq!(closures.len(), 1);
        let cl = &closures[0];
        // Closure shot 3 is in Sec B, pointing to shot 1 in Sec A
        assert_eq!(
            sections[cl.to_section_index].shots[cl.to_station_index].id,
            1
        );
    }

    #[test]
    fn test_closure_to_id_negative_ignored() {
        let xml = wrap_xml(&[
            tml_shot_xml(0, -1, "START", "Start"),
            tml_shot_xml(1, 0, "REAL", "Section 1"),
        ].join("\n"));

        let (raw_shots, _) = parse_raw_shots(&xml).unwrap_or_else(|_| {
            (Vec::new(), FileMetadata::default())
        });
        let (_, closures) = build_sections(raw_shots);

        assert!(closures.is_empty());
    }

    // -------------------------------------------------------------------
    // Empty / error cases
    // -------------------------------------------------------------------

    #[test]
    fn test_empty_data() {
        let xml = wrap_xml("");
        let (raw_shots, _) = parse_raw_shots(&xml).unwrap_or_else(|_| {
            (Vec::new(), FileMetadata::default())
        });
        let (sections, closures) = build_sections(raw_shots);
        assert!(sections.is_empty());
        assert!(closures.is_empty());
    }

    #[test]
    fn test_invalid_xml() {
        // quick-xml is lenient; use unclosed tags to trigger an error
        let result = parse_raw_shots("<CaveFile><Data><SurveyData><ID>1</ID>");
        // Even if it doesn't error, it should produce no usable shots (missing fields)
        match result {
            Err(_) => {} // expected
            Ok((shots, _)) => {
                // If it tolerates truncated XML, we still shouldn't get valid shots
                assert!(shots.is_empty() || shots.iter().all(|s| s.id == 0));
            }
        }
    }

    #[test]
    fn test_nonexistent_file() {
        let result = parse_tml(Path::new("/nonexistent/file.tml"));
        assert!(result.is_err());
    }

    #[test]
    fn test_wrong_extension() {
        let result = load_xml(Path::new("/tmp/test.xyz"));
        assert!(result.is_err());
    }

    // -------------------------------------------------------------------
    // Multi-section topology
    // -------------------------------------------------------------------

    #[test]
    fn test_multi_section_topology() {
        let xml = wrap_xml(&[
            tml_shot_xml(0, -1, "START", "Start"),
            tml_shot_xml(1, 0, "REAL", "Section A"),
            tml_shot_xml(2, 1, "REAL", "Section A"),
            tml_shot_xml(3, 2, "REAL", "Section B"),
            tml_shot_xml(4, 3, "REAL", "Section B"),
        ].join("\n"));

        let (raw_shots, _) = parse_raw_shots(&xml).unwrap_or_else(|_| {
            (Vec::new(), FileMetadata::default())
        });
        let (sections, _) = build_sections(raw_shots);

        assert_eq!(sections.len(), 2);
        assert_eq!(sections[0].name, "Section A");
        assert_eq!(sections[0].shots.len(), 2);
        assert_eq!(sections[1].name, "Section B");
        assert_eq!(sections[1].shots.len(), 2);
    }

    // -------------------------------------------------------------------
    // Import config conversion
    // -------------------------------------------------------------------

    #[test]
    fn test_convert_to_import_configs() {
        let xml = wrap_xml(&[
            tml_shot_xml(0, -1, "START", "Start"),
            tml_shot_xml(1, 0, "REAL", "Section A"),
            tml_shot_xml(2, 1, "REAL", "Section A"),
            tml_shot_xml(3, 2, "REAL", "Section B"),
        ].join("\n"));

        let (raw_shots, metadata) = parse_raw_shots(&xml).unwrap_or_else(|_| {
            (Vec::new(), FileMetadata::default())
        });
        let (sections, closures) = build_sections(raw_shots);

        let tml = TmlFile {
            cave_name: metadata.cave_name,
            unit: TmlUnit::Metric,
            use_magnetic_azimuth: true,
            first_start_absolute_elevation: 100.0,
            geo_coding: None,
            sections,
            closures,
        };

        let configs = convert_tml_to_import_configs(&tml).unwrap_or_else(|_| Vec::new());
        assert_eq!(configs.len(), 2);

        // First section → Origin (no GPS)
        assert!(matches!(configs[0].placement, ImportPlacement::Origin));
        assert_eq!(configs[0].section_index, 0);

        // Second section → FromImporting (linked via topology)
        assert!(matches!(configs[1].placement, ImportPlacement::FromImporting { .. }));
    }

    // -------------------------------------------------------------------
    // File-level parsing (TML ZIP)
    // -------------------------------------------------------------------

    #[test]
    fn test_parse_tml_fixture() {
        let fixture = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/test_simple.tml");
        if !fixture.exists() {
            // Skip if fixture not yet available
            return;
        }
        let result = parse_tml(&fixture);
        assert!(result.is_ok(), "Failed to parse test_simple.tml: {:?}", result.err());
        let tml = result.unwrap_or_else(|_| TmlFile {
            cave_name: String::new(),
            unit: TmlUnit::Metric,
            use_magnetic_azimuth: false,
            first_start_absolute_elevation: 0.0,
            geo_coding: None,
            sections: Vec::new(),
            closures: Vec::new(),
        });
        assert!(!tml.cave_name.is_empty());
        assert!(!tml.sections.is_empty());
    }

    #[test]
    fn test_parse_tmlu_fixture() {
        let fixture = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/test_simple.tmlu");
        if !fixture.exists() {
            return;
        }
        let result = parse_tml(&fixture);
        assert!(result.is_ok(), "Failed to parse test_simple.tmlu: {:?}", result.err());
    }

    // -------------------------------------------------------------------
    // Shot data conversion details
    // -------------------------------------------------------------------

    #[test]
    fn test_virtual_shot_in_shot_data() {
        let shots = vec![TmlShot {
            id: 1,
            from_id: 0,
            shot_type: TmlShotType::Virtual,
            azimuth: 90.0,
            length: 10.0,
            depth: 5.0,
            depth_in: -1.0,
            inclination: 0.0,
            left: 0.0,
            right: 0.0,
            up: 0.0,
            down: 0.0,
            comment: None,
            explorer: None,
            date: None,
            color: "#000000".to_string(),
            excluded: false,
            latitude: 0.0,
            longitude: 0.0,
            closure_to_id: -1,
            section: "Test".to_string(),
        }];

        let shot_data = convert_shots_to_shot_data(&shots);
        assert!(shot_data[0].is_virtual);
    }

    #[test]
    fn test_lrud_zero_becomes_none() {
        let shots = vec![TmlShot {
            id: 1,
            from_id: 0,
            shot_type: TmlShotType::Real,
            azimuth: 90.0,
            length: 10.0,
            depth: 5.0,
            depth_in: -1.0,
            inclination: 0.0,
            left: 0.0,
            right: 2.5,
            up: 0.0,
            down: 1.0,
            comment: None,
            explorer: None,
            date: None,
            color: "#000000".to_string(),
            excluded: false,
            latitude: 0.0,
            longitude: 0.0,
            closure_to_id: -1,
            section: "Test".to_string(),
        }];

        let shot_data = convert_shots_to_shot_data(&shots);
        assert!(shot_data[0].left.is_none());
        assert!((shot_data[0].right.unwrap_or(0.0) - 2.5).abs() < f64::EPSILON);
        assert!(shot_data[0].up.is_none());
        assert!((shot_data[0].down.unwrap_or(0.0) - 1.0).abs() < f64::EPSILON);
    }
}
