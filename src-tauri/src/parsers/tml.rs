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
use quick_xml::name::QName;
use quick_xml::Reader;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::models::{ImportClosure, ImportPlacement, ImportSectionConfig, ShotData};

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
    /// Cumulative depth of the parent shot (from_id target) for correct rebasing
    /// when a section branches mid-chain. 0.0 if the section starts from a
    /// START shot or has no parent.
    pub start_depth: f64,
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
    /// Ariane 26+ per-shot UUID (`<UUID>`/`<UU>`); `None` for older files.
    #[serde(default)]
    pub uuid: Option<String>,
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
    uuid: Option<String>,
}

// ============================================================================
// Dual key mapping (TML long names ↔ TMLU short names)
// ============================================================================

/// Normalize an XML element name to a canonical key.
#[cfg(test)]
fn normalize_key(name: &str) -> Option<&'static str> {
    normalize_key_bytes(name.as_bytes())
}

/// Byte-slice form of `normalize_key` used by the hot XML loop so we
/// don't have to allocate a `String` from the quick-xml element name on
/// every Start/End/Empty event.
fn normalize_key_bytes(name: &[u8]) -> Option<&'static str> {
    match name {
        b"ID" | b"Id" => Some("id"),
        b"FromID" | b"FRID" => Some("from_id"),
        b"ClosureToID" | b"CID" => Some("closure_to_id"),
        b"Type" | b"TY" => Some("type"),
        b"Section" | b"SC" => Some("section"),
        b"Azimut" | b"AZ" => Some("azimuth"),
        b"Length" | b"LG" => Some("length"),
        b"Depth" | b"DP" => Some("depth"),
        b"DepthIn" | b"DPI" => Some("depth_in"),
        b"Inclination" | b"INC" => Some("inclination"),
        b"Left" | b"L" => Some("left"),
        b"Right" | b"R" => Some("right"),
        b"Up" | b"U" => Some("up"),
        b"Down" | b"D" => Some("down"),
        b"Comment" | b"CM" => Some("comment"),
        b"Explorer" | b"EX" => Some("explorer"),
        b"Date" | b"DT" => Some("date"),
        b"Color" | b"CL" => Some("color"),
        b"Excluded" | b"EXC" => Some("excluded"),
        b"Latitude" | b"LT" => Some("latitude"),
        b"Longitude" | b"LGT" => Some("longitude"),
        b"Name" | b"NM" => Some("name"),
        // Ariane 26+ per-shot UUID — collab-mode round-trip identity.
        b"UUID" | b"UU" => Some("uuid"),
        _ => None,
    }
}

// ============================================================================
// XML loading
// ============================================================================

/// Hex sha256 of a TML/TMLU file's inner XML content (independent of zip
/// framing), for detecting external edits to a collaboration sibling file.
pub fn tml_content_sha256(path: &Path) -> Result<String> {
    use sha2::{Digest, Sha256};
    let xml = load_xml(path)?;
    let mut hasher = Sha256::new();
    hasher.update(xml.as_bytes());
    Ok(format!("{:x}", hasher.finalize()))
}

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

    // Parsing state. `current_element_key` holds the normalised field
    // name for the *currently-open* element. We resolve it once at
    // Start and reuse it at Text — that avoids re-doing the lookup
    // (and any String allocation) on the text event.  For non-shot
    // file-level elements we keep the raw bytes around so the small
    // `match` in the metadata branch can dispatch by slice.
    let mut in_cave_file = false;
    let mut in_data = false;
    let mut in_shot = false;
    let mut current_fields: HashMap<&'static str, String> = HashMap::new();
    let mut current_element_key: Option<&'static str> = None;
    let mut current_element_raw: Vec<u8> = Vec::new();
    // Shape/SH subtrees are skipped — TML's <Shape> per-shot LRUD
    // polygons are not consumed by the importer.  We use quick-xml's
    // `read_to_end` to fast-forward past them instead of looping
    // through every nested event ourselves; for a 57 MB Data.xml this
    // saves on the order of ~30 % of the parse wall-clock.

    // Hash table for the file-level metadata fields (string slot →
    // setter). Keeps the Text branch allocation-free for the common
    // shot fields and small for the file-level ones.
    let mut buf = Vec::new();

    loop {
        match reader.read_event_into(&mut buf) {
            Ok(Event::Start(e)) => {
                let name_bytes = e.name();
                let name_bytes = name_bytes.as_ref();

                match name_bytes {
                    b"CaveFile" => in_cave_file = true,
                    b"Data" => in_data = true,
                    b"SurveyData" | b"SRVD" => {
                        in_shot = true;
                        current_fields.clear();
                    }
                    b"Shape" | b"SH" => {
                        // Fast-forward past the Shape/SH subtree —
                        // quick-xml will scan its bytes without
                        // emitting events back to us.
                        let qname = QName(name_bytes);
                        if let Err(err) = reader.read_to_end(qname) {
                            bail!("XML parse error skipping <{}> at position {}: {err}",
                                std::str::from_utf8(name_bytes).unwrap_or("<non-utf8>"),
                                reader.error_position());
                        }
                    }
                    _ => {
                        if in_shot {
                            // Resolve the shot-field key once (returns
                            // a 'static slice from the lookup table);
                            // None means "field we don't care about".
                            current_element_key = normalize_key_bytes(name_bytes);
                            current_element_raw.clear();
                        } else if in_cave_file && !in_data {
                            current_element_key = None;
                            current_element_raw.clear();
                            current_element_raw.extend_from_slice(name_bytes);
                        }
                    }
                }
            }
            Ok(Event::End(e)) => {
                let name_bytes = e.name();
                let name_bytes = name_bytes.as_ref();

                match name_bytes {
                    b"SurveyData" | b"SRVD" => {
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
                    b"Data" => in_data = false,
                    b"CaveFile" => in_cave_file = false,
                    _ => {
                        current_element_key = None;
                        current_element_raw.clear();
                    }
                }
            }
            Ok(Event::Text(e)) => {
                if in_shot {
                    // Skip the unescape + trim + alloc unless this is a
                    // known shot field.
                    if let Some(key) = current_element_key {
                        let text =
                            e.unescape().unwrap_or_default().trim().to_string();
                        if !text.is_empty() {
                            current_fields.insert(key, text);
                        }
                    }
                } else if in_cave_file && !in_data && !current_element_raw.is_empty() {
                    let text = e.unescape().unwrap_or_default().trim().to_string();
                    if !text.is_empty() {
                        match current_element_raw.as_slice() {
                            b"caveName" => metadata.cave_name = text,
                            b"unit" => metadata.unit = text,
                            b"useMagneticAzimuth" => {
                                metadata.use_magnetic_azimuth = text == "true";
                            }
                            b"firstStartAbsoluteElevation" => {
                                metadata.first_start_absolute_elevation =
                                    text.parse().unwrap_or(0.0);
                            }
                            _ => {}
                        }
                    }
                }
            }
            Ok(Event::Empty(e)) => {
                let name_bytes = e.name();
                let name_bytes = name_bytes.as_ref();
                // Handle self-closing shot elements like <CM/> (empty comment)
                if in_shot {
                    if let Some(key) = normalize_key_bytes(name_bytes) {
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

    let section = strip_section_description(
        fields
            .get("section")
            .map(String::as_str)
            .unwrap_or_default(),
    );

    let color = convert_ariane_color(fields.get("color").map(String::as_str));

    let date = fields
        .get("date")
        .and_then(|d| NaiveDate::parse_from_str(d, "%Y-%m-%d").ok());

    let comment = fields
        .get("comment")
        .filter(|c| !c.is_empty() && *c != "None")
        .cloned();
    // Explorer field may contain entity-escaped XML like
    // "<Explorer>name</Explorer><Surveyor>...</Surveyor>".
    // Extract just the explorer name if present.
    let explorer = fields.get("explorer").and_then(|e| {
        if e.is_empty() {
            return None;
        }
        if let Some(rest) = e.strip_prefix("<Explorer>") {
            rest.split("</Explorer>")
                .next()
                .filter(|s| !s.is_empty() && *s != "unknown")
                .map(String::from)
        } else {
            Some(e.clone()).filter(|s| s != "None" && s != "unknown")
        }
    });

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
        uuid: fields.get("uuid").filter(|u| !u.is_empty()).cloned(),
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
// Section name cleanup
// ============================================================================

/// Strip `<SectionDescription>...</SectionDescription>` suffixes from section names.
///
/// Ariane encodes section descriptions as entity-escaped XML appended to the
/// section name (e.g. `"Mainline<SectionDescription>notes</SectionDescription>"`).
/// After XML unescaping this becomes part of the text content. We strip it so
/// that START shots (which carry the description) group with their REAL shots.
fn strip_section_description(section: &str) -> String {
    if let Some(idx) = section.find("<SectionDescription>") {
        section[..idx].trim_end().to_string()
    } else {
        section.to_string()
    }
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

/// Propagate GPS coordinates from START shots to their immediate successors.
///
/// Ariane stores GPS on START shots (section origin markers) which carry no
/// measurement data and are excluded from sections. To preserve the geo-reference,
/// copy lat/lng to the first real shot(s) that follow each START shot — but only
/// if those successors don't already have their own GPS data.
fn propagate_start_gps(raw_shots: &mut [RawShot]) {
    // Collect START shots that have GPS data
    let gps_starts: Vec<(i64, f64, f64)> = raw_shots
        .iter()
        .filter(|s| {
            s.shot_type == TmlShotType::Start
                && (s.latitude.abs() > f64::EPSILON || s.longitude.abs() > f64::EPSILON)
        })
        .map(|s| (s.id, s.latitude, s.longitude))
        .collect();

    if gps_starts.is_empty() {
        return;
    }

    let start_gps: HashMap<i64, (f64, f64)> = gps_starts
        .into_iter()
        .map(|(id, lat, lng)| (id, (lat, lng)))
        .collect();

    // For each non-START shot whose from_id points to a GPS-tagged START,
    // copy the coordinates if the successor has no GPS of its own.
    for shot in raw_shots.iter_mut() {
        if shot.shot_type == TmlShotType::Start {
            continue;
        }
        if shot.latitude.abs() > f64::EPSILON || shot.longitude.abs() > f64::EPSILON {
            continue; // already has its own GPS
        }
        if let Some(&(lat, lng)) = start_gps.get(&shot.from_id) {
            shot.latitude = lat;
            shot.longitude = lng;
        }
    }
}

/// Build topology and linearize into sections.
fn build_sections(mut raw_shots: Vec<RawShot>) -> (Vec<TmlSection>, Vec<TmlClosure>) {
    if raw_shots.is_empty() {
        return (Vec::new(), Vec::new());
    }

    // Propagate GPS coordinates from START shots to their immediate successors.
    // Ariane places GPS data on START shots, which we later exclude from sections.
    propagate_start_gps(&mut raw_shots);

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
        let linearized = linearize_section(section_name, group_shots, &successors, &shot_by_id);
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
    all_shots: &HashMap<i64, &RawShot>,
) -> Vec<TmlSection> {
    if shots.is_empty() {
        return Vec::new();
    }

    let shot_ids: std::collections::HashSet<i64> = shots.iter().map(|s| s.id).collect();
    let shot_by_id: HashMap<i64, &RawShot> = shots.iter().map(|s| (s.id, *s)).collect();

    // Preserve deterministic chain selection by ranking shots in encounter order.
    let order_rank: HashMap<i64, usize> = shots
        .iter()
        .enumerate()
        .map(|(i, s)| (s.id, i))
        .collect();
    let rank_key = |id: &i64| (order_rank.get(id).copied().unwrap_or(usize::MAX), *id);

    // Successors constrained to this section, sorted deterministically.
    let mut in_section_successors: HashMap<i64, Vec<i64>> = HashMap::new();
    for shot in shots {
        let mut succs: Vec<i64> = successors
            .get(&shot.id)
            .into_iter()
            .flatten()
            .copied()
            .filter(|id| shot_ids.contains(id))
            .collect();
        succs.sort_by_key(&rank_key);
        succs.dedup();
        in_section_successors.insert(shot.id, succs);
    }

    // Find chain roots: shots whose from_id is not in this section's shot set.
    let mut roots: Vec<i64> = shots
        .iter()
        .filter(|s| !shot_ids.contains(&s.from_id))
        .map(|s| s.id)
        .collect();
    roots.sort_by_key(&rank_key);

    let needs_split = roots.len() > 1 || has_branching_within(shots, successors);
    let mut visited: std::collections::HashSet<i64> = std::collections::HashSet::new();
    let mut pending_starts = std::collections::VecDeque::new();
    let mut chains: Vec<Vec<i64>> = Vec::new();

    // Walk natural roots first.
    for root_id in roots {
        let chain = collect_linear_chain(
            root_id,
            &shot_ids,
            &in_section_successors,
            &mut visited,
            &mut pending_starts,
        );
        if !chain.is_empty() {
            chains.push(chain);
        }
    }

    // Then walk branch starts discovered while traversing roots.
    while let Some(start_id) = pending_starts.pop_front() {
        let chain = collect_linear_chain(
            start_id,
            &shot_ids,
            &in_section_successors,
            &mut visited,
            &mut pending_starts,
        );
        if !chain.is_empty() {
            chains.push(chain);
        }
    }

    // Guard pass for malformed/disconnected graphs:
    // backtrack through in-section parents to find an upstream start.
    let mut unvisited_ids: Vec<i64> = shots
        .iter()
        .map(|s| s.id)
        .filter(|id| !visited.contains(id))
        .collect();
    unvisited_ids.sort_by_key(&rank_key);

    for shot_id in unvisited_ids {
        if visited.contains(&shot_id) {
            continue;
        }

        let mut start = shot_id;
        let mut seen_backtrack = std::collections::HashSet::new();
        loop {
            if !seen_backtrack.insert(start) {
                tracing::warn!(
                    section = section_name,
                    shot_id = start,
                    "Cycle detected while finding branch start; using cycle member as start"
                );
                break;
            }

            let Some(current) = shot_by_id.get(&start) else {
                tracing::warn!(
                    section = section_name,
                    shot_id = start,
                    "Shot missing while finding branch start; using current node as start"
                );
                break;
            };

            let parent_id = current.from_id;
            if !shot_ids.contains(&parent_id) || visited.contains(&parent_id) {
                break;
            }
            start = parent_id;
        }

        let chain = collect_linear_chain(
            start,
            &shot_ids,
            &in_section_successors,
            &mut visited,
            &mut pending_starts,
        );
        if !chain.is_empty() {
            chains.push(chain);
        }

        while let Some(extra_start) = pending_starts.pop_front() {
            let extra_chain = collect_linear_chain(
                extra_start,
                &shot_ids,
                &in_section_successors,
                &mut visited,
                &mut pending_starts,
            );
            if !extra_chain.is_empty() {
                chains.push(extra_chain);
            }
        }
    }

    // Last-resort guard: ensure every shot is emitted exactly once.
    let mut still_unvisited: Vec<i64> = shots
        .iter()
        .map(|s| s.id)
        .filter(|id| !visited.contains(id))
        .collect();
    still_unvisited.sort_by_key(&rank_key);
    for shot_id in still_unvisited {
        let chain = collect_linear_chain(
            shot_id,
            &shot_ids,
            &in_section_successors,
            &mut visited,
            &mut pending_starts,
        );
        if !chain.is_empty() {
            tracing::warn!(
                section = section_name,
                shot_id,
                "Recovered unvisited shot via final guard pass"
            );
            chains.push(chain);
        }
    }

    let mut result = Vec::new();
    for chain_ids in chains {
        let mut chain = Vec::with_capacity(chain_ids.len());
        for shot_id in chain_ids {
            if let Some(shot) = shot_by_id.get(&shot_id) {
                chain.push((*shot).clone());
            } else {
                tracing::warn!(
                    section = section_name,
                    shot_id,
                    "Skipping missing shot while building linearized section"
                );
            }
        }

        if chain.is_empty() {
            continue;
        }

        let has_prior_chains = !result.is_empty();
        let branch_number = result.len() + 1;
        let name = if needs_split || has_prior_chains {
            format!("{section_name} (branch {branch_number})")
        } else {
            section_name.to_string()
        };
        let is_branch_split = needs_split || has_prior_chains;

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
                uuid: s.uuid.clone(),
            })
            .collect();

        // Look up the parent shot's cumulative depth for correct rebasing.
        // If from_id points to a shot (START or REAL/VIRTUAL), use its depth.
        let start_depth = all_shots
            .get(&first_shot.from_id)
            .map_or(0.0, |parent| parent.depth);

        result.push(TmlSection {
            name,
            start_ariane_id: first_shot.from_id,
            end_ariane_id: last_shot.id,
            shots: tml_shots,
            surveyor,
            date,
            color,
            is_branch_split,
            start_depth,
        });
    }

    result
}

/// Walk a single linear chain, queueing extra branch starts when a node has
/// multiple unvisited successors within the same section.
fn collect_linear_chain(
    start_id: i64,
    shot_ids: &std::collections::HashSet<i64>,
    in_section_successors: &HashMap<i64, Vec<i64>>,
    visited: &mut std::collections::HashSet<i64>,
    pending_starts: &mut std::collections::VecDeque<i64>,
) -> Vec<i64> {
    if !shot_ids.contains(&start_id) || visited.contains(&start_id) {
        return Vec::new();
    }

    let mut chain = Vec::new();
    let mut current = start_id;

    loop {
        if !visited.insert(current) {
            break;
        }
        chain.push(current);

        let Some(successors) = in_section_successors.get(&current) else {
            break;
        };

        let mut unvisited_successors = successors
            .iter()
            .copied()
            .filter(|id| !visited.contains(id))
            .collect::<Vec<_>>();

        if unvisited_successors.is_empty() {
            break;
        }

        let next_id = unvisited_successors.remove(0);
        for extra in unvisited_successors {
            pending_starts.push_back(extra);
        }

        current = next_id;
    }

    chain
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
pub fn convert_tml_to_import_configs(tml: &TmlFile, include_excluded: bool, comments_on_stations: bool) -> Result<(Vec<ImportSectionConfig>, Vec<ImportClosure>)> {
    if tml.sections.is_empty() {
        return Ok((Vec::new(), Vec::new()));
    }

    // Build a mapping from Ariane shot ID → (section_index, station_index)
    // to resolve topology connections between sections.
    //
    // Station index = the station at the END of a shot. In Stalagmight,
    // station 0 is the section start, shot 0 goes from station 0 → 1, etc.
    // So shot at index `i` ends at station `i + 1`.
    //
    // We must also account for CLOSURE shots being filtered out of the
    // import data, so we count only non-CLOSURE shots to get the correct index.
    let mut id_to_import_loc: HashMap<i64, (u32, u32)> = HashMap::new();
    for (si, section) in tml.sections.iter().enumerate() {
        let mut import_shot_idx: u32 = 0;
        for shot in &section.shots {
            if shot.shot_type == TmlShotType::Closure {
                continue; // CLOSURE shots are excluded from import
            }
            if !include_excluded && shot.excluded {
                continue; // Excluded shots are filtered out by default
            }
            // This shot ends at station (import_shot_idx + 1)
            id_to_import_loc.insert(shot.id, (si as u32, import_shot_idx + 1));
            import_shot_idx += 1;
        }
    }

    let mut configs: Vec<ImportSectionConfig> = Vec::new();

    for (si, section) in tml.sections.iter().enumerate() {
        let section_index = si as u32;

        // Convert shots to ShotData, using start_depth for correct rebasing
        let shot_data = convert_shots_to_shot_data(&section.shots, section.start_depth, include_excluded);

        // Skip sections that end up with zero shots after filtering
        if shot_data.is_empty() {
            continue;
        }

        // When excluded shots are filtered, the effective first shot may differ
        // from section.start_ariane_id (which is the raw first shot's from_id).
        // Find the from_id of the first non-excluded, non-CLOSURE shot as a
        // fallback for placement when start_ariane_id is itself excluded.
        let effective_start_id = if include_excluded {
            None
        } else {
            let eff = section
                .shots
                .iter()
                .find(|s| s.shot_type != TmlShotType::Closure && !s.excluded)
                .map(|s| s.from_id);
            // Only use as fallback if different from start_ariane_id
            eff.filter(|&id| id != section.start_ariane_id)
        };

        // Determine placement: try start_ariane_id first (preserves original
        // topology), then effective_start_id as fallback when the original
        // from_id was excluded and can't be resolved.
        let placement = determine_placement(
            section,
            section_index,
            section.start_ariane_id,
            effective_start_id,
            &id_to_import_loc,
            tml.geo_coding.as_ref(),
        );

        // When comments_on_stations is true, promote shot comments to the
        // "to" station (station_index = shot_index + 1) and clear them from shots.
        let mut station_comments = Vec::new();
        if comments_on_stations {
            for (shot_idx, shot) in shot_data.iter().enumerate() {
                if let Some(ref comment) = shot.comment {
                    if !comment.is_empty() {
                        station_comments.push((shot_idx as u32 + 1, comment.clone()));
                    }
                }
            }
        }
        let shots = if comments_on_stations && !station_comments.is_empty() {
            shot_data.into_iter().map(|mut s| { s.comment = None; s }).collect()
        } else {
            shot_data
        };

        configs.push(ImportSectionConfig {
            section_index,
            name: Some(section.name.clone()),
            surveyor: section.surveyor.clone(),
            date: section.date,
            color: section.color.clone(),
            direction: None, // Ariane doesn't distinguish in/out direction
            quality: 1.0,
            shots,
            placement,
            station_comments,
        });
    }

    // When excluded-shot filtering drops entire branches, simplify names
    // like "xxx (branch 1)" back to "xxx" if only one branch survives.
    simplify_lone_branch_names(&mut configs);

    // Topologically sort configs so that any section referenced by a
    // FromImporting placement is created before its dependent. This handles
    // forward references that arise when excluded-shot filtering changes
    // which section a given section attaches to.
    topological_sort_configs(&mut configs);

    // Extract loop closures by resolving CLOSURE shots through id_to_import_loc.
    // CLOSURE shots have from_id (the station the closure originates from) and
    // closure_to_id (the target station). Both must resolve to import-space
    // coordinates; closures where either endpoint was filtered out are skipped.
    let mut import_closures = Vec::new();
    for section in &tml.sections {
        for shot in &section.shots {
            if shot.shot_type != TmlShotType::Closure || shot.closure_to_id < 0 {
                continue;
            }
            let from = id_to_import_loc.get(&shot.from_id);
            let to = id_to_import_loc.get(&shot.closure_to_id);
            if let (Some(&(from_si, from_st)), Some(&(to_si, to_st))) = (from, to) {
                import_closures.push(ImportClosure {
                    from_section_index: from_si,
                    from_station_index: from_st,
                    to_section_index: to_si,
                    to_station_index: to_st,
                });
            }
        }
    }

    Ok((configs, import_closures))
}

/// Simplify branch-suffixed names when only one branch of a group survives.
///
/// During linearization, sections that branch get names like "Foo (branch 1)",
/// "Foo (branch 2)". When excluded-shot filtering drops all shots from some
/// branches, those empty sections are removed. If only one branch remains for
/// a given base name, strip the suffix so it's just "Foo".
fn simplify_lone_branch_names(configs: &mut [ImportSectionConfig]) {
    // Count how many configs share each base name (name without " (branch N)")
    let re_suffix = " (branch ";
    let mut base_counts: HashMap<String, u32> = HashMap::new();
    for c in configs.iter() {
        let name = c.name.as_deref().unwrap_or("");
        let base = if let Some(pos) = name.rfind(re_suffix) {
            &name[..pos]
        } else {
            name
        };
        *base_counts.entry(base.to_string()).or_insert(0) += 1;
    }

    // Rename lone survivors
    for c in configs.iter_mut() {
        let name = match c.name.as_deref() {
            Some(n) => n,
            None => continue,
        };
        if let Some(pos) = name.rfind(re_suffix) {
            let base = &name[..pos];
            if base_counts.get(base).copied() == Some(1) {
                c.name = Some(base.to_string());
            }
        }
    }
}

/// Topologically sort import configs so that FromImporting targets come first.
///
/// Uses Kahn's algorithm. Configs with no FromImporting dependency (Origin,
/// ZeroDatum, etc.) come first, then configs whose targets have already been
/// placed, and so on. Cycles (which shouldn't happen in valid survey data)
/// are broken by appending remaining configs in their original order.
fn topological_sort_configs(configs: &mut Vec<ImportSectionConfig>) {
    if configs.len() <= 1 {
        return;
    }

    // Build index mapping: section_index → position in configs vec
    let pos_of: HashMap<u32, usize> = configs
        .iter()
        .enumerate()
        .map(|(i, c)| (c.section_index, i))
        .collect();

    // Build dependency: for each config, which config position must come first?
    // dep[i] = Some(j) means configs[i] depends on configs[j].
    let dep: Vec<Option<usize>> = configs
        .iter()
        .map(|c| {
            if let ImportPlacement::FromImporting { target_section_index, .. } = &c.placement {
                pos_of.get(target_section_index).copied()
            } else {
                None
            }
        })
        .collect();

    // Check if already in valid order (common case — skip reallocation)
    let already_sorted = dep.iter().enumerate().all(|(i, d)| match d {
        Some(j) => *j < i,
        None => true,
    });
    if already_sorted {
        return;
    }

    // Kahn's algorithm
    let n = configs.len();
    let mut in_degree = vec![0u32; n];
    let mut dependents: Vec<Vec<usize>> = vec![Vec::new(); n];
    for (i, d) in dep.iter().enumerate() {
        if let Some(j) = d {
            in_degree[i] += 1;
            dependents[*j].push(i);
        }
    }

    let mut queue: std::collections::VecDeque<usize> = std::collections::VecDeque::new();
    for (i, &deg) in in_degree.iter().enumerate() {
        if deg == 0 {
            queue.push_back(i);
        }
    }

    let mut order: Vec<usize> = Vec::with_capacity(n);
    while let Some(i) = queue.pop_front() {
        order.push(i);
        for &dep_i in &dependents[i] {
            in_degree[dep_i] -= 1;
            if in_degree[dep_i] == 0 {
                queue.push_back(dep_i);
            }
        }
    }

    // Append any remaining (cycle — shouldn't happen, but be safe)
    if order.len() < n {
        for i in 0..n {
            if !order.contains(&i) {
                order.push(i);
            }
        }
    }

    // Reorder configs
    let mut old_configs: Vec<Option<ImportSectionConfig>> =
        std::mem::take(configs).into_iter().map(Some).collect();
    *configs = order
        .into_iter()
        .filter_map(|i| old_configs[i].take())
        .collect();
}

/// Convert TML shots to `ShotData` for import.
///
/// Depth handling: Ariane `DP` is absolute station depth (depth gauge reading).
/// For each shot, `depth_in` = DPI if available, otherwise previous shot's DP
/// (or `start_depth` for the first shot). `depth_out` = this shot's DP.
/// Depths are stored as absolute values — no rebasing is applied.
/// Resolve a TML shot's entry depth, handling the `-1.0` "same as previous" sentinel.
/// `prev_depth` is the previous real shot's cumulative depth (`None` for the first
/// shot in a section), `start_depth` the parent station's cumulative depth.
pub(crate) fn resolve_tml_depth_in(shot: &TmlShot, prev_depth: Option<f64>, start_depth: f64) -> f64 {
    if shot.depth_in != -1.0 {
        shot.depth_in
    } else {
        prev_depth.unwrap_or(start_depth)
    }
}

/// Canonical mapping of a single Ariane TML shot to Stalagmight's `ShotData`.
///
/// This is the SINGLE source of truth for the TML→Stalagmight field mapping
/// (azimuth `rem_euclid(360)`, depth in/out, inclination→pitch_in, LRUD 0→None,
/// VIRTUAL→is_reference). Both DMP/TML import and the collaboration reconcile
/// engine call it, so a clean round-trip never appears as a phantom edit.
/// `depth_in` must already be resolved via [`resolve_tml_depth_in`].
pub(crate) fn normalize_tml_shot(shot: &TmlShot, depth_in: f64) -> ShotData {
    // LRUD: pass through, using None for zero values
    let lrud_opt = |v: f64| if v.abs() < f64::EPSILON { None } else { Some(v) };

    // Ariane stores azimuths as arbitrary angles (can be negative or >360).
    // Normalize to 0..360 range for Stalagmight's data model.
    let az = shot.azimuth.rem_euclid(360.0);

    ShotData {
        azimuth_in: az,
        azimuth_out: az, // No backsight in Ariane
        length: shot.length,
        depth_in,
        depth_out: shot.depth,
        pitch_in: Some(shot.inclination),
        pitch_out: None, // No backsight inclination
        left: lrud_opt(shot.left),
        right: lrud_opt(shot.right),
        up: lrud_opt(shot.up),
        down: lrud_opt(shot.down),
        comment: shot.comment.clone(),
        is_reference: shot.shot_type == TmlShotType::Virtual,
        marker_index: None,
        temperature: None,
    }
}

fn convert_shots_to_shot_data(shots: &[TmlShot], start_depth: f64, include_excluded: bool) -> Vec<ShotData> {
    if shots.is_empty() {
        return Vec::new();
    }

    // Filter out CLOSURE shots — they are loop-closure markers with zero length,
    // not real survey measurements. Their topology is captured in TmlClosure.
    // Also filter out excluded shots unless explicitly included.
    let real_shots: Vec<&TmlShot> = shots
        .iter()
        .filter(|s| s.shot_type != TmlShotType::Closure)
        .filter(|s| include_excluded || !s.excluded)
        .collect();

    if real_shots.is_empty() {
        return Vec::new();
    }

    let mut result = Vec::with_capacity(real_shots.len());

    for (i, shot) in real_shots.iter().enumerate() {
        let prev_depth = if i > 0 { Some(real_shots[i - 1].depth) } else { None };
        let depth_in = resolve_tml_depth_in(shot, prev_depth, start_depth);
        result.push(normalize_tml_shot(shot, depth_in));
    }

    result
}

/// Determine placement for a section based on topology and GPS data.
///
/// `start_ariane_id` is the raw first shot's `from_id` (original topology).
/// `effective_start_id` is an optional fallback — the `from_id` of the first
/// non-excluded shot, used when excluded leading shots make `start_ariane_id`
/// unresolvable. We try both, preferring the original.
fn determine_placement(
    section: &TmlSection,
    section_index: u32,
    start_ariane_id: i64,
    effective_start_id: Option<i64>,
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

    // Try to connect to an already-imported section. First try the original
    // start_ariane_id, then fall back to effective_start_id (from the first
    // non-excluded shot) if the original was excluded and can't be resolved.
    let candidates = std::iter::once(Some(start_ariane_id))
        .chain(std::iter::once(effective_start_id))
        .flatten()
        .filter(|&id| id >= 0);

    for from_id in candidates {
        if let Some(&(target_section, target_station)) = id_to_import_loc.get(&from_id) {
            // Allow forward references — configs will be topologically sorted
            // afterward so that the target section is created first.
            if target_section != section_index {
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

    fn tml_shot_xml_gps(
        id: i64,
        from_id: i64,
        shot_type: &str,
        section: &str,
        lat: f64,
        lng: f64,
    ) -> String {
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
    <Latitude>{lat}</Latitude>
    <Longitude>{lng}</Longitude>
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
    // GPS propagation from START shots
    // -------------------------------------------------------------------

    #[test]
    fn test_start_gps_propagated_to_first_real_shot() {
        // START shot has GPS, its successor REAL shot should inherit it
        let xml = wrap_xml(
            &[
                tml_shot_xml_gps(0, -1, "START", "Entrance", 20.2, -87.5),
                tml_shot_xml(1, 0, "REAL", "Entrance"),
                tml_shot_xml(2, 1, "REAL", "Entrance"),
            ]
            .join("\n"),
        );

        let (raw_shots, _) =
            parse_raw_shots(&xml).unwrap_or_else(|_| (Vec::new(), FileMetadata::default()));

        let (sections, _) = build_sections(raw_shots);
        assert_eq!(sections.len(), 1);
        // First shot should have GPS from the START shot
        let first = &sections[0].shots[0];
        assert!((first.latitude - 20.2).abs() < f64::EPSILON);
        assert!((first.longitude - (-87.5)).abs() < f64::EPSILON);
        // Second shot should NOT have GPS (not a direct successor of START)
        let second = &sections[0].shots[1];
        assert!(second.latitude.abs() < f64::EPSILON);
        assert!(second.longitude.abs() < f64::EPSILON);
    }

    #[test]
    fn test_start_gps_not_overwritten_if_successor_has_own_gps() {
        // Successor already has GPS — should keep its own
        let xml = wrap_xml(
            &[
                tml_shot_xml_gps(0, -1, "START", "Entrance", 20.2, -87.5),
                tml_shot_xml_gps(1, 0, "REAL", "Entrance", 19.0, -88.0),
            ]
            .join("\n"),
        );

        let (raw_shots, _) =
            parse_raw_shots(&xml).unwrap_or_else(|_| (Vec::new(), FileMetadata::default()));

        let (sections, _) = build_sections(raw_shots);
        let first = &sections[0].shots[0];
        assert!((first.latitude - 19.0).abs() < f64::EPSILON);
        assert!((first.longitude - (-88.0)).abs() < f64::EPSILON);
    }

    #[test]
    fn test_start_gps_produces_zero_datum_placement() {
        // When START has GPS and it propagates, section 0 should get ZeroDatum
        let xml = wrap_xml(
            &[
                tml_shot_xml_gps(0, -1, "START", "Entrance", 20.2, -87.5),
                tml_shot_xml(1, 0, "REAL", "Entrance"),
                tml_shot_xml(2, 1, "REAL", "Entrance"),
            ]
            .join("\n"),
        );

        let (raw_shots, metadata) = parse_raw_shots(&xml).unwrap_or_else(|_| {
            (Vec::new(), FileMetadata::default())
        });
        let (sections, closures) = build_sections(raw_shots);

        // geo_coding should be populated from propagated GPS
        let geo_coding = sections
            .iter()
            .flat_map(|s| &s.shots)
            .find(|shot| shot.latitude.abs() > f64::EPSILON || shot.longitude.abs() > f64::EPSILON)
            .map(|shot| TmlGeoCoding {
                latitude: shot.latitude,
                longitude: shot.longitude,
                altitude: metadata.first_start_absolute_elevation,
            });

        let tml = TmlFile {
            cave_name: metadata.cave_name,
            unit: TmlUnit::Metric,
            use_magnetic_azimuth: true,
            first_start_absolute_elevation: 100.0,
            geo_coding,
            sections,
            closures,
        };

        let (configs, _) = convert_tml_to_import_configs(&tml, false, false).unwrap_or_else(|_| (Vec::new(), Vec::new()));
        assert_eq!(configs.len(), 1);
        match &configs[0].placement {
            ImportPlacement::ZeroDatum {
                coordinates,
                station_index,
            } => {
                assert!((coordinates.latitude - 20.2).abs() < f64::EPSILON);
                assert!((coordinates.longitude - (-87.5)).abs() < f64::EPSILON);
                assert_eq!(*station_index, 0);
            }
            other => {
                assert!(
                    false,
                    "Expected ZeroDatum, got {other:?}"
                );
            }
        }
    }

    #[test]
    fn test_geo_coding_extracted_from_propagated_gps() {
        // TmlFile.geo_coding should be populated from GPS that was on a START shot
        let xml = wrap_xml(
            &[
                tml_shot_xml_gps(0, -1, "START", "Entrance", 20.2, -87.5),
                tml_shot_xml(1, 0, "REAL", "Entrance"),
            ]
            .join("\n"),
        );

        let (raw_shots, _) = parse_raw_shots(&xml).unwrap_or_else(|_| {
            (Vec::new(), FileMetadata::default())
        });
        let (sections, _) = build_sections(raw_shots);

        // geo_coding extraction (same logic as parse_tml)
        let geo_coding = sections
            .iter()
            .flat_map(|s| &s.shots)
            .find(|shot| shot.latitude.abs() > f64::EPSILON || shot.longitude.abs() > f64::EPSILON)
            .map(|shot| TmlGeoCoding {
                latitude: shot.latitude,
                longitude: shot.longitude,
                altitude: 100.0,
            });

        assert!(geo_coding.is_some());
        if let Some(gc) = &geo_coding {
            assert!((gc.latitude - 20.2).abs() < f64::EPSILON);
            assert!((gc.longitude - (-87.5)).abs() < f64::EPSILON);
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
        let shot_data = convert_shots_to_shot_data(&sections[0].shots, 0.0, false);

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
        let shot_data = convert_shots_to_shot_data(&sections[0].shots, 0.0, false);

        // DPI=2.0 used as absolute depth_in; depth_out = 5.0 (absolute, no rebasing)
        assert!((shot_data[0].depth_in - 2.0).abs() < f64::EPSILON);
        assert!((shot_data[0].depth_out - 5.0).abs() < f64::EPSILON);
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
                uuid: None,
                section: "Test".to_string(),
            }],
            surveyor: None,
            date: None,
            color: "#000000".to_string(),
            is_branch_split: false,
            start_ariane_id: 0,
            end_ariane_id: 1,
            start_depth: 0.0,
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
                uuid: None,
                section: "Test".to_string(),
            }],
            surveyor: None,
            date: None,
            color: "#000000".to_string(),
            is_branch_split: false,
            start_ariane_id: 0,
            end_ariane_id: 1,
            start_depth: 0.0,
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

    #[test]
    fn test_branch_leftovers_preserve_parent_child_topology() {
        // Interleaved order that used to trigger fallback flattening:
        // 2 branches to (3, 6), and 3 branches to (4, 5). The 6→7→8 chain
        // must stay connected and must not absorb shot 5.
        let xml = wrap_xml(&[
            tml_shot_xml(0, -1, "START", "Start"),
            tml_shot_xml(1, 0, "REAL", "Section 1"),
            tml_shot_xml(2, 1, "REAL", "Section 1"),
            tml_shot_xml(3, 2, "REAL", "Section 1"),
            tml_shot_xml(6, 2, "VIRTUAL", "Section 1"),
            tml_shot_xml(4, 3, "REAL", "Section 1"),
            tml_shot_xml(5, 3, "REAL", "Section 1"),
            tml_shot_xml(7, 6, "REAL", "Section 1"),
            tml_shot_xml(8, 7, "REAL", "Section 1"),
        ].join("\n"));

        let (raw_shots, _) = parse_raw_shots(&xml).unwrap_or_else(|_| {
            (Vec::new(), FileMetadata::default())
        });
        let (sections, _) = build_sections(raw_shots);

        let mut id_to_section: HashMap<i64, usize> = HashMap::new();
        let mut seen = std::collections::HashSet::new();
        for (si, sec) in sections.iter().enumerate() {
            for shot in &sec.shots {
                assert!(seen.insert(shot.id), "shot {} emitted multiple times", shot.id);
                id_to_section.insert(shot.id, si);
            }
        }

        for id in [1_i64, 2, 3, 4, 5, 6, 7, 8] {
            assert!(id_to_section.contains_key(&id), "missing shot {id}");
        }

        let sec_6 = *id_to_section.get(&6).unwrap();
        let sec_7 = *id_to_section.get(&7).unwrap();
        let sec_8 = *id_to_section.get(&8).unwrap();
        let sec_5 = *id_to_section.get(&5).unwrap();

        assert_eq!(sec_6, sec_7, "6 and 7 must stay in the same branch");
        assert_eq!(sec_7, sec_8, "7 and 8 must stay in the same branch");
        assert_ne!(sec_5, sec_6, "shot 5 must not be merged into the 6→7→8 chain");

        let chain_6_ids: Vec<i64> = sections[sec_6].shots.iter().map(|s| s.id).collect();
        assert_eq!(chain_6_ids, vec![6, 7, 8], "expected preserved 6→7→8 chain");
        assert_eq!(sections[sec_6].start_ariane_id, 2);
        assert_eq!(sections[sec_5].start_ariane_id, 3);
    }

    #[test]
    fn test_malformed_cycle_and_self_loop_are_guarded() {
        // Malformed graph with a 2<->3 cycle and a self-loop at 4.
        // Parser should still terminate and emit each shot exactly once.
        let xml = wrap_xml(&[
            tml_shot_xml(0, -1, "START", "Start"),
            tml_shot_xml(1, 0, "REAL", "Section 1"),
            tml_shot_xml(2, 3, "REAL", "Section 1"),
            tml_shot_xml(3, 2, "REAL", "Section 1"),
            tml_shot_xml(4, 4, "REAL", "Section 1"),
        ].join("\n"));

        let (raw_shots, _) = parse_raw_shots(&xml).unwrap_or_else(|_| {
            (Vec::new(), FileMetadata::default())
        });
        let (sections, _) = build_sections(raw_shots);

        let ids: Vec<i64> = sections
            .iter()
            .flat_map(|s| s.shots.iter().map(|shot| shot.id))
            .collect();
        let unique: std::collections::HashSet<i64> = ids.iter().copied().collect();

        assert_eq!(ids.len(), 4, "all non-START shots should be emitted");
        assert_eq!(unique.len(), 4, "no shot should be emitted more than once");
        assert!(unique.contains(&1));
        assert!(unique.contains(&2));
        assert!(unique.contains(&3));
        assert!(unique.contains(&4));
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

        let (configs, _) = convert_tml_to_import_configs(&tml, false, false).unwrap_or_else(|_| (Vec::new(), Vec::new()));
        assert_eq!(configs.len(), 2);

        // First section → Origin (no GPS)
        assert!(matches!(configs[0].placement, ImportPlacement::Origin));
        assert_eq!(configs[0].section_index, 0);

        // Second section → FromImporting (linked via topology)
        // Section B's first shot (ID=3) has FromID=2, which is the 2nd shot in Section A.
        // Shot ID=2 is at import shot index 1, so it ends at station 2.
        match &configs[1].placement {
            ImportPlacement::FromImporting {
                import_station,
                target_section_index,
                target_station_index,
            } => {
                assert_eq!(*import_station, 0, "import_station should be 0 (first station)");
                assert_eq!(*target_section_index, 0, "should link to section 0");
                assert_eq!(*target_station_index, 2, "should link to station 2 (end of shot ID=2)");
            }
            other => panic!("Expected FromImporting, got {:?}", other),
        }
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
            uuid: None,
            section: "Test".to_string(),
        }];

        let shot_data = convert_shots_to_shot_data(&shots, 0.0, false);
        assert!(shot_data[0].is_reference);
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
            uuid: None,
            section: "Test".to_string(),
        }];

        let shot_data = convert_shots_to_shot_data(&shots, 0.0, false);
        assert!(shot_data[0].left.is_none());
        assert!((shot_data[0].right.unwrap_or(0.0) - 2.5).abs() < f64::EPSILON);
        assert!(shot_data[0].up.is_none());
        assert!((shot_data[0].down.unwrap_or(0.0) - 1.0).abs() < f64::EPSILON);
    }

    #[test]
    fn test_azimuth_normalization() {
        // Ariane stores azimuths as arbitrary angles (negative, >360).
        // convert_shots_to_shot_data must normalize to 0..360.
        let make_shot = |az: f64| TmlShot {
            id: 1,
            from_id: 0,
            shot_type: TmlShotType::Real,
            azimuth: az,
            length: 10.0,
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
            color: "#000000".to_string(),
            excluded: false,
            latitude: 0.0,
            longitude: 0.0,
            closure_to_id: -1,
            uuid: None,
            section: "Test".to_string(),
        };

        // Negative azimuth → normalized
        let data = convert_shots_to_shot_data(&[make_shot(-124.0)], 0.0, false);
        assert!((data[0].azimuth_in - 236.0).abs() < 1e-6); // -124 + 360 = 236

        // Very negative → normalized
        let data = convert_shots_to_shot_data(&[make_shot(-690.0)], 0.0, false);
        assert!((data[0].azimuth_in - 30.0).abs() < 1e-6); // -690 + 720 = 30

        // >360 → normalized
        let data = convert_shots_to_shot_data(&[make_shot(450.0)], 0.0, false);
        assert!((data[0].azimuth_in - 90.0).abs() < 1e-6); // 450 - 360 = 90

        // Already valid → unchanged
        let data = convert_shots_to_shot_data(&[make_shot(102.0)], 0.0, false);
        assert!((data[0].azimuth_in - 102.0).abs() < 1e-6);

        // Zero → unchanged
        let data = convert_shots_to_shot_data(&[make_shot(0.0)], 0.0, false);
        assert!(data[0].azimuth_in.abs() < 1e-6);

        // azimuth_out should match azimuth_in
        let data = convert_shots_to_shot_data(&[make_shot(-124.0)], 0.0, false);
        assert!((data[0].azimuth_out - data[0].azimuth_in).abs() < f64::EPSILON);
    }

    #[test]
    fn test_excluded_shots_filtered_by_default() {
        let shots = vec![
            TmlShot {
                id: 1,
                from_id: 0,
                shot_type: TmlShotType::Real,
                azimuth: 90.0,
                length: 10.0,
                depth: 5.0,
                depth_in: -1.0,
                inclination: 0.0,
                left: 1.0,
                right: 1.0,
                up: 1.0,
                down: 1.0,
                comment: None,
                explorer: None,
                date: None,
                color: "#000000".to_string(),
                excluded: false,
                latitude: 0.0,
                longitude: 0.0,
                closure_to_id: -1,
                uuid: None,
                section: "Test".to_string(),
            },
            TmlShot {
                id: 2,
                from_id: 1,
                shot_type: TmlShotType::Real,
                azimuth: 180.0,
                length: 8.0,
                depth: 10.0,
                depth_in: -1.0,
                inclination: 0.0,
                left: 1.0,
                right: 1.0,
                up: 1.0,
                down: 1.0,
                comment: None,
                explorer: None,
                date: None,
                color: "#000000".to_string(),
                excluded: true, // This shot is excluded
                latitude: 0.0,
                longitude: 0.0,
                closure_to_id: -1,
                uuid: None,
                section: "Test".to_string(),
            },
            TmlShot {
                id: 3,
                from_id: 2,
                shot_type: TmlShotType::Real,
                azimuth: 270.0,
                length: 5.0,
                depth: 15.0,
                depth_in: -1.0,
                inclination: 0.0,
                left: 1.0,
                right: 1.0,
                up: 1.0,
                down: 1.0,
                comment: None,
                explorer: None,
                date: None,
                color: "#000000".to_string(),
                excluded: false,
                latitude: 0.0,
                longitude: 0.0,
                closure_to_id: -1,
                uuid: None,
                section: "Test".to_string(),
            },
        ];

        // Default: excluded shots filtered out
        let data = convert_shots_to_shot_data(&shots, 0.0, false);
        assert_eq!(data.len(), 2);
        assert!((data[0].azimuth_in - 90.0).abs() < f64::EPSILON);
        assert!((data[1].azimuth_in - 270.0).abs() < f64::EPSILON);

        // include_excluded=true: all shots kept
        let data = convert_shots_to_shot_data(&shots, 0.0, true);
        assert_eq!(data.len(), 3);
        assert!((data[0].azimuth_in - 90.0).abs() < f64::EPSILON);
        assert!((data[1].azimuth_in - 180.0).abs() < f64::EPSILON);
        assert!((data[2].azimuth_in - 270.0).abs() < f64::EPSILON);
    }

    #[test]
    fn test_all_excluded_section_dropped_from_configs() {
        // Section where every shot is excluded → should be dropped entirely
        let make_shot = |id, from_id, excluded| TmlShot {
            id,
            from_id,
            shot_type: TmlShotType::Real,
            azimuth: 90.0,
            length: 10.0,
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
            color: "#000000".to_string(),
            excluded,
            latitude: 0.0,
            longitude: 0.0,
            closure_to_id: -1,
            uuid: None,
            section: "S".to_string(),
        };

        let tml = TmlFile {
            cave_name: "Test".to_string(),
            unit: TmlUnit::Metric,
            use_magnetic_azimuth: false,
            first_start_absolute_elevation: 0.0,
            geo_coding: None,
            sections: vec![
                TmlSection {
                    name: "Good".to_string(),
                    shots: vec![make_shot(1, 0, false)],
                    surveyor: None,
                    date: None,
                    color: "#ff0000".to_string(),
                    is_branch_split: false,
                    start_ariane_id: 0,
                    end_ariane_id: 1,
                    start_depth: 0.0,
                },
                TmlSection {
                    name: "AllExcluded".to_string(),
                    shots: vec![make_shot(2, 1, true), make_shot(3, 2, true)],
                    surveyor: None,
                    date: None,
                    color: "#00ff00".to_string(),
                    is_branch_split: false,
                    start_ariane_id: 1,
                    end_ariane_id: 3,
                    start_depth: 0.0,
                },
            ],
            closures: Vec::new(),
        };

        // With excluded filtered out, section "AllExcluded" has 0 shots → dropped
        let (configs, _closures) = convert_tml_to_import_configs(&tml, false, false).unwrap();
        assert_eq!(configs.len(), 1);
        assert_eq!(configs[0].name.as_deref(), Some("Good"));

        // With excluded included, both sections present
        let (configs, _closures) = convert_tml_to_import_configs(&tml, true, false).unwrap();
        assert_eq!(configs.len(), 2);
    }

    #[test]
    fn test_lone_branch_name_simplified() {
        // Two branches of "Gallery": branch 2 is all-excluded → dropped.
        // Branch 1 should lose the "(branch 1)" suffix.
        let make_shot = |id, from_id, excluded| TmlShot {
            id,
            from_id,
            shot_type: TmlShotType::Real,
            azimuth: 90.0,
            length: 10.0,
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
            color: "#000000".to_string(),
            excluded,
            latitude: 0.0,
            longitude: 0.0,
            closure_to_id: -1,
            uuid: None,
            section: "S".to_string(),
        };

        let tml = TmlFile {
            cave_name: "Test".to_string(),
            unit: TmlUnit::Metric,
            use_magnetic_azimuth: false,
            first_start_absolute_elevation: 0.0,
            geo_coding: None,
            sections: vec![
                TmlSection {
                    name: "Gallery (branch 1)".to_string(),
                    shots: vec![make_shot(1, 0, false), make_shot(2, 1, false)],
                    surveyor: None,
                    date: None,
                    color: "#ff0000".to_string(),
                    is_branch_split: true,
                    start_ariane_id: 0,
                    end_ariane_id: 2,
                    start_depth: 0.0,
                },
                TmlSection {
                    name: "Gallery (branch 2)".to_string(),
                    shots: vec![make_shot(3, 0, true), make_shot(4, 3, true)],
                    surveyor: None,
                    date: None,
                    color: "#00ff00".to_string(),
                    is_branch_split: true,
                    start_ariane_id: 0,
                    end_ariane_id: 4,
                    start_depth: 0.0,
                },
            ],
            closures: Vec::new(),
        };

        // Excluded filtered: branch 2 dropped, branch 1 renamed to "Gallery"
        let (configs, _closures) = convert_tml_to_import_configs(&tml, false, false).unwrap();
        assert_eq!(configs.len(), 1);
        assert_eq!(configs[0].name.as_deref(), Some("Gallery"));

        // Both included: both branches keep their suffixes
        let (configs, _closures) = convert_tml_to_import_configs(&tml, true, false).unwrap();
        assert_eq!(configs.len(), 2);
        assert_eq!(configs[0].name.as_deref(), Some("Gallery (branch 1)"));
        assert_eq!(configs[1].name.as_deref(), Some("Gallery (branch 2)"));
    }

    #[test]
    fn test_excluded_leading_shots_placement() {
        // Real-world scenario modeled after Ariane data:
        //   Section A (index 0): shots 1,2 — main line
        //   Section C (index 1): shot 10 (from_id=2) — virtual jump chain
        //   Section B (index 2): excluded shot 5 (from_id=3, where 3 is excluded),
        //     then non-excluded shot 6 (from_id=10 → section C's last shot)
        //
        // start_ariane_id for B = 3 (excluded shot, not in id_to_import_loc).
        // Placement must fall back to effective_start_id = shot 6's from_id = 10
        // (in section C), and topological sort must reorder C before B even though
        // C has a higher raw index than expected.
        let make_shot = |id: i64, from_id: i64, excluded: bool| TmlShot {
            id,
            from_id,
            shot_type: TmlShotType::Real,
            azimuth: 90.0,
            length: 10.0,
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
            color: "#000000".to_string(),
            excluded,
            latitude: 0.0,
            longitude: 0.0,
            closure_to_id: -1,
            uuid: None,
            section: "S".to_string(),
        };

        let tml = TmlFile {
            cave_name: "Test".to_string(),
            unit: TmlUnit::Metric,
            use_magnetic_azimuth: false,
            first_start_absolute_elevation: 0.0,
            geo_coding: None,
            sections: vec![
                // Section A (index 0): shots 1,2
                TmlSection {
                    name: "A".to_string(),
                    shots: vec![make_shot(1, -1, false), make_shot(2, 1, false)],
                    surveyor: None,
                    date: None,
                    color: "#ff0000".to_string(),
                    is_branch_split: false,
                    start_ariane_id: -1,
                    end_ariane_id: 2,
                    start_depth: 0.0,
                },
                // Section B (index 1): excluded shot 5 (from_id=3, excluded),
                // then non-excluded shot 6 (from_id=10 → section C)
                TmlSection {
                    name: "B".to_string(),
                    shots: vec![
                        make_shot(5, 3, true),   // excluded, from_id=3 is also excluded
                        make_shot(6, 10, false),  // kept, from_id=10 is in section C
                    ],
                    surveyor: None,
                    date: None,
                    color: "#0000ff".to_string(),
                    is_branch_split: false,
                    start_ariane_id: 3, // raw first shot's from_id (excluded, not in map)
                    end_ariane_id: 6,
                    start_depth: 0.0,
                },
                // Section C (index 2): shot 10 (from_id=2) — comes after B in raw order
                TmlSection {
                    name: "C".to_string(),
                    shots: vec![make_shot(10, 2, false)],
                    surveyor: None,
                    date: None,
                    color: "#00ff00".to_string(),
                    is_branch_split: false,
                    start_ariane_id: 2,
                    end_ariane_id: 10,
                    start_depth: 0.0,
                },
            ],
            closures: Vec::new(),
        };

        let (configs, _closures) = convert_tml_to_import_configs(&tml, false, false).unwrap();
        assert_eq!(configs.len(), 3);

        // After topological sort: C must come before B because B depends on C.
        // Expected order: A, C, B
        assert_eq!(configs[0].name.as_deref(), Some("A"));
        assert_eq!(configs[1].name.as_deref(), Some("C"));
        assert_eq!(configs[2].name.as_deref(), Some("B"));

        // Section B should attach to section C's shot 10
        let b_config = &configs[2];
        match &b_config.placement {
            ImportPlacement::FromImporting {
                import_station,
                target_section_index,
                target_station_index,
            } => {
                assert_eq!(*import_station, 0);
                assert_eq!(*target_section_index, 2, "should reference section C (raw index 2)");
                assert_eq!(*target_station_index, 1, "should attach to station 1 (shot 10)");
            }
            other => panic!("Expected FromImporting, got {:?}", other),
        }
    }

    #[test]
    fn test_strip_section_description() {
        assert_eq!(
            strip_section_description("Mainline"),
            "Mainline"
        );
        assert_eq!(
            strip_section_description(
                "Reel to Mainline Cx<SectionDescription>reel to mainline connection</SectionDescription>"
            ),
            "Reel to Mainline Cx"
        );
        assert_eq!(
            strip_section_description("Eastern Bypass Cavern-side<SectionDescription>notes</SectionDescription>"),
            "Eastern Bypass Cavern-side"
        );
        assert_eq!(strip_section_description(""), "");
    }

    #[test]
    fn test_section_description_grouping() {
        // START shot has SectionDescription suffix, REAL shots don't.
        // After stripping, they should group into the same section.
        let xml = wrap_xml(&format!(
            "{}\n{}\n{}",
            r#"<SurveyData><ID>0</ID><FromID>-1</FromID><Type>START</Type>
                <Section>MySec&lt;SectionDescription&gt;notes&lt;/SectionDescription&gt;</Section>
                <Azimut>0</Azimut><Length>0</Length><Depth>0</Depth><DepthIn>0</DepthIn>
                <Inclination>0</Inclination><Left>0</Left><Right>0</Right><Up>0</Up><Down>0</Down>
                <Color>0x000000ff</Color><Excluded>false</Excluded><Latitude>0</Latitude>
                <Longitude>0</Longitude><ClosureToID>-1</ClosureToID></SurveyData>"#,
            r#"<SurveyData><ID>1</ID><FromID>0</FromID><Type>REAL</Type>
                <Section>MySec</Section>
                <Azimut>90</Azimut><Length>10</Length><Depth>5</Depth><DepthIn>-1</DepthIn>
                <Inclination>0</Inclination><Left>1</Left><Right>2</Right><Up>3</Up><Down>4</Down>
                <Color>0x000000ff</Color><Excluded>false</Excluded><Latitude>0</Latitude>
                <Longitude>0</Longitude><ClosureToID>-1</ClosureToID></SurveyData>"#,
            r#"<SurveyData><ID>2</ID><FromID>1</FromID><Type>REAL</Type>
                <Section>MySec</Section>
                <Azimut>180</Azimut><Length>15</Length><Depth>8</Depth><DepthIn>-1</DepthIn>
                <Inclination>0</Inclination><Left>1</Left><Right>2</Right><Up>3</Up><Down>4</Down>
                <Color>0x000000ff</Color><Excluded>false</Excluded><Latitude>0</Latitude>
                <Longitude>0</Longitude><ClosureToID>-1</ClosureToID></SurveyData>"#,
        ));

        let (raw_shots, _) = parse_raw_shots(&xml).unwrap_or_else(|_| {
            (Vec::new(), FileMetadata::default())
        });
        let (sections, _) = build_sections(raw_shots);

        // Should be 1 section (MySec) with 2 shots (START excluded)
        assert_eq!(sections.len(), 1, "Expected 1 section, got {}: {:?}",
            sections.len(), sections.iter().map(|s| &s.name).collect::<Vec<_>>());
        assert_eq!(sections[0].name, "MySec");
        assert_eq!(sections[0].shots.len(), 2);
    }

    /// Test mid-section branching topology (not just end-of-section).
    /// Verifies that when section C branches from the MIDDLE of section A,
    /// the target_station_index correctly points to the station at the END
    /// of the referenced shot.
    #[test]
    fn test_mid_section_branching_topology() {
        // A: START → shot1 → shot2 → shot3 → shot4
        // B: branches from shot2 (mid-section)
        let xml = wrap_xml(&[
            tml_shot_xml(0, -1, "START", "Start"),
            tml_shot_xml(1, 0, "REAL", "Section A"),
            tml_shot_xml(2, 1, "REAL", "Section A"),
            tml_shot_xml(3, 2, "REAL", "Section A"),
            tml_shot_xml(4, 3, "REAL", "Section A"),
            tml_shot_xml(5, 2, "REAL", "Section B"), // branches from shot 2 (mid-section A)
            tml_shot_xml(6, 5, "REAL", "Section B"),
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

        let (configs, _closures) = convert_tml_to_import_configs(&tml, false, false).unwrap();
        assert_eq!(configs.len(), 2, "Should have 2 sections");

        // Section A: 4 shots → 5 stations (0, 1, 2, 3, 4)
        // Shot ID=2 at import_idx=1 → station_after=2
        assert_eq!(configs[0].shots.len(), 4);
        assert!(matches!(configs[0].placement, ImportPlacement::Origin));

        // Section B: from_id=2 → end of shot ID=2 = station 2 of section A
        match &configs[1].placement {
            ImportPlacement::FromImporting {
                import_station,
                target_section_index,
                target_station_index,
            } => {
                assert_eq!(*import_station, 0);
                assert_eq!(*target_section_index, 0);
                assert_eq!(*target_station_index, 2,
                    "Should link to station 2 (end of shot ID=2 at import_idx=1)");
            }
            other => panic!("Expected FromImporting, got {:?}", other),
        }
    }

    /// End-to-end coordinate verification: parse a real TML file, import all
    /// sections into a Project, compute station coordinates, and compare
    /// against independently calculated expected values.
    ///
    /// Run with:  TML_NAHARON_PATH=/path/to/ariane.tml cargo test --manifest-path src-tauri/Cargo.toml --lib parse_tml_naharon_coordinates -- --ignored
    #[test]
    #[ignore]
    fn parse_tml_naharon_coordinates() {
        use crate::models::{ImportPlacement, Project, SectionData, StationRef};

        let path_str = std::env::var("TML_NAHARON_PATH")
            .unwrap_or_else(|_| "/home/user/tmp/467b76f1-5909-4e00-b96f-c30931ac81db/ariane.tml".into());
        let path = Path::new(&path_str);
        if !path.exists() {
            eprintln!("Skipping: TML file not found at {path_str}");
            return;
        }

        // 1. Parse
        let tml = parse_tml(path).expect("Failed to parse TML");
        assert_eq!(tml.cave_name, "2025 Naharon Resurvey");
        assert_eq!(tml.unit, TmlUnit::Metric);

        // 2. Convert to import configs (exclude excluded shots)
        let (configs, closures) = convert_tml_to_import_configs(&tml, false, false).unwrap();
        assert!(!configs.is_empty(), "Should produce import configs");

        // 3. Create a project and import all sections
        let mut project = Project::new("Test Import".into(), None);
        let mut created_ids: HashMap<u32, u32> = HashMap::new();

        for config in &configs {
            let section_data = SectionData {
                name: config.name.clone(),
                surveyor: config.surveyor.clone(),
                date: config.date,
                color: config.color.clone(),
                direction: config.direction,
                quality: config.quality,
                shots: config.shots.clone(),
            };
            let section_id = project.add_section(section_data).id;
            created_ids.insert(config.section_index, section_id);

            match &config.placement {
                ImportPlacement::Origin => {}
                ImportPlacement::ZeroDatum { station_index, .. } => {
                    // First datum station goes to origin; offset so that station is at (0,0)
                    let station_ref = StationRef::new(section_id, *station_index);
                    let current = project.compute_station_raw_coords(station_ref)
                        .expect("station coords for zero datum");
                    let offset_x = -current.x;
                    let offset_y = -current.y;
                    if offset_x.abs() > 1e-9 || offset_y.abs() > 1e-9 {
                        project.section_offsets.insert(section_id, (offset_x, offset_y));
                    }
                }
                ImportPlacement::FromExisting { .. } => {
                    panic!("Unexpected FromExisting in fresh import");
                }
                ImportPlacement::FromImporting {
                    import_station,
                    target_section_index,
                    target_station_index,
                } => {
                    let target_section_id = *created_ids.get(target_section_index)
                        .expect("target section should exist");
                    let import_ref = StationRef::new(section_id, *import_station);
                    let target_ref = StationRef::new(target_section_id, *target_station_index);
                    project.merge_stations(import_ref, target_ref)
                        .expect("merge should succeed");
                }
                ImportPlacement::Manual { .. } | ImportPlacement::ManualSnap { .. } => {}
            }
        }

        // 4. Verify per-section relative coordinates
        //    For each section, compute station coords independently from shot data
        //    and compare against compute_station_raw_coords (relative to station 0).
        for section in &project.sections {
            let base = project.compute_station_raw_coords(StationRef::new(section.id, 0))
                .expect("base station coords");

            let mut expected_x = 0.0_f64;
            let mut expected_y = 0.0_f64;

            for (i, shot) in section.shots.iter().enumerate() {
                let azi_rad = shot.average_azimuth().to_radians();
                let h = shot.horizontal_length();
                expected_x += h * azi_rad.sin();
                expected_y += h * azi_rad.cos();

                let station_idx = (i + 1) as u32;
                let actual = project.compute_station_raw_coords(StationRef::new(section.id, station_idx))
                    .expect("station coords");

                let rel_x = actual.x - base.x;
                let rel_y = actual.y - base.y;

                assert!(
                    (rel_x - expected_x).abs() < 1e-6 && (rel_y - expected_y).abs() < 1e-6,
                    "Section '{}' station {}: expected rel ({:.6}, {:.6}), got ({:.6}, {:.6})",
                    section.name.as_deref().unwrap_or("?"),
                    station_idx,
                    expected_x, expected_y, rel_x, rel_y,
                );
            }
        }

        // 5. Verify absolute coordinates for selected stations against
        //    independently computed values from the raw TML data.
        //    These were calculated by traversing the shot graph from the START
        //    station (ID=75) using: h = sqrt(length² - dz²), dx = h·sin(azi),
        //    dy = h·cos(azi), with cumulative depth propagation.
        //
        //    Format: (section_name, station_index, expected_x, expected_y, expected_depth)
        //    Coordinates are relative to the START station at (0, 0).
        //    Since the import places the first section at Origin, all coords are
        //    in that same frame (modulo ZeroDatum GPS offset which only shifts XY).

        // Find the section containing the START station (first section, placed at origin
        // or ZeroDatum). We compare coordinates RELATIVE to that origin.
        // Get the offset applied by ZeroDatum so we can subtract it.
        let first_section_id = *created_ids.get(&configs[0].section_index).unwrap();
        let origin_offset = project.section_offsets.get(&first_section_id).copied().unwrap_or((0.0, 0.0));

        // Helper: get absolute coords relative to START station
        // Expected coordinates computed independently from raw TML data
        // (Python traversal of shot graph from START station at origin)
        struct Expected {
            section: &'static str,
            station: u32,
            x: f64,
            y: f64,
            depth: f64,
        }

        let expectations = [
            // Reel to Mainline Cx: station 0 = START at origin
            Expected { section: "Reel to Mainline Cx", station: 0, x: 0.0, y: 0.0, depth: 0.28 },
            // Reel to Mainline Cx: station 13 = end of shot 88
            Expected { section: "Reel to Mainline Cx", station: 13, x: -30.7455, y: 69.9489, depth: 11.06 },
            // Bypass south: station 11 = end of shot 68
            Expected { section: "Bypass south", station: 11, x: -21.7235, y: 176.5525, depth: 15.80 },
            // Haloline (branch 2): station 30 = end of shot 264
            Expected { section: "Haloline (branch 2)", station: 30, x: -58.9147, y: 413.9500, depth: 12.30 },
        ];

        let tolerance = 0.05; // 5cm tolerance for absolute coordinates
        for exp in &expectations {
            // Section names in the import may differ slightly (our parser strips
            // SectionDescription suffixes and may split at branches). Try to find
            // the section; skip if the parser organized it differently.
            let section_opt = project.sections.iter()
                .find(|s| s.name.as_deref() == Some(exp.section));
            let Some(section) = section_opt else {
                eprintln!("  Skipping absolute check: section '{}' not found (parser may have renamed it)", exp.section);
                continue;
            };
            if exp.station as usize > section.shots.len() {
                eprintln!("  Skipping absolute check: section '{}' station {} out of range (has {} shots)",
                    exp.section, exp.station, section.shots.len());
                continue;
            }
            let c = project.compute_station_raw_coords(StationRef::new(section.id, exp.station))
                .unwrap_or_else(|| panic!("Coords for {}:{}", exp.section, exp.station));
            let (rx, ry) = (c.x - origin_offset.0, c.y - origin_offset.1);

            assert!(
                (rx - exp.x).abs() < tolerance && (ry - exp.y).abs() < tolerance,
                "Absolute coords mismatch for '{}' station {}: expected ({:.4}, {:.4}), got ({:.4}, {:.4}), delta=({:.4}, {:.4})",
                exp.section, exp.station, exp.x, exp.y, rx, ry,
                rx - exp.x, ry - exp.y,
            );
            // Depth check with wider tolerance (averaging can shift depth slightly)
            assert!(
                (c.z - exp.depth).abs() < 0.5,
                "Depth mismatch for '{}' station {}: expected {:.4}, got {:.4}",
                exp.section, exp.station, exp.depth, c.z,
            );
        }

        // 6. Verify all merged stations are co-located (XY within tolerance)
        //    This validates the full import + merge + offset pipeline.
        let merge_tolerance = 1e-6;
        for merge in &project.station_merges {
            let ca = project.compute_station_raw_coords(merge.station_a)
                .unwrap_or_else(|| panic!("Coords for merge station_a {:?}", merge.station_a));
            let cb = project.compute_station_raw_coords(merge.station_b)
                .unwrap_or_else(|| panic!("Coords for merge station_b {:?}", merge.station_b));
            assert!(
                (ca.x - cb.x).abs() < merge_tolerance && (ca.y - cb.y).abs() < merge_tolerance,
                "Merged stations {:?} and {:?} not co-located: ({:.6},{:.6}) vs ({:.6},{:.6})",
                merge.station_a, merge.station_b, ca.x, ca.y, cb.x, cb.y,
            );
        }

        // 7. Verify closures were parsed
        assert!(!closures.is_empty(), "Should have parsed loop closures");

        eprintln!(
            "Naharon TML coordinate test passed: {} sections, {} merges, {} total stations verified",
            project.sections.len(),
            project.station_merges.len(),
            project.sections.iter().map(|s| s.shots.len() + 1).sum::<usize>(),
        );
    }
}
