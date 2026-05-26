//! Compass (`.DAT` / `.MAK`) survey import.
//!
//! Parsing is delegated to the vendored [`compass_data`] fork (see
//! `vendor/compass_data`); this module converts Compass's inclination-based,
//! feet/magnetic-degree survey model into Stalagmight's depth-based import
//! configs:
//!
//! - declination + UTM convergence + per-survey correction factors are baked
//!   into the stored azimuth/length so the imported geometry matches what
//!   Compass plots;
//! - feet are converted to meters;
//! - station elevations are integrated from `length * sin(inclination)` along the
//!   station graph (anchored at the `.MAK` fixed station's UTM elevation, or 0)
//!   and stored as Stalagmight absolute depth (positive = down);
//! - the station-name graph is split into linear sections joined by
//!   `FromImporting` merges + loop closures;
//! - a `.MAK` fixed station becomes a GPS zero datum (UTM → WGS84 via `proj4rs`).

use std::collections::{HashMap, VecDeque};
use std::path::Path;

use anyhow::{Context, Result, anyhow};
use chrono::Datelike;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

use compass_data::{
    CorrectionFactors, Datum, DeclinationMode, InclinationUnits, LengthUnits, Project, Shot, Survey,
};

use crate::models::section::{ImportClosure, ImportPlacement, ImportSectionConfig};
use crate::models::shot::ShotData;
use crate::models::station::GpsCoordinates;

const FEET_TO_METERS: f64 = 0.3048;
/// Distances/LRUD at or above this are Compass "missing data" sentinels.
const MISSING_VALUE_THRESHOLD: f64 = 990.0;
/// Angles at or below this are Compass "missing data" sentinels.
const MISSING_ANGLE_THRESHOLD: f64 = -900.0;

/// Section colors cycled across imported sections (matches the app palette feel).
const SECTION_COLORS: &[&str] = &[
    "#4ecdc4", "#ff6b6b", "#ffd93d", "#6bcB77", "#4d96ff", "#c780fa", "#ff9f45", "#9bdeac",
];

// ---------------------------------------------------------------------------
// IPC preview payload
// ---------------------------------------------------------------------------

/// Lightweight summary of a parsed Compass file, returned to the import dialog.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct CompassFile {
    pub cave_name: String,
    pub survey_count: u32,
    pub shot_count: u32,
    pub has_backsights: bool,
    pub datum: Option<String>,
    pub utm_zone: Option<i32>,
    pub has_georeference: bool,
    pub declination_mode: String,
    pub surveys: Vec<CompassSurveySummary>,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct CompassSurveySummary {
    pub name: String,
    pub date: String,
    pub team: Option<String>,
    pub shot_count: u32,
    pub declination: f64,
}

/// Options controlling how a Compass file is converted into import configs.
#[derive(Debug, Clone)]
pub struct CompassImportOptions {
    /// Include shots flagged `X` (total exclusion); they import as reference shots.
    pub include_excluded: bool,
    /// Apply the per-survey CORRECTIONS / CORRECTIONS2 factors to readings.
    pub apply_corrections: bool,
}

impl Default for CompassImportOptions {
    fn default() -> Self {
        Self {
            include_excluded: false,
            apply_corrections: true,
        }
    }
}

// ---------------------------------------------------------------------------
// Internal parsed representation
// ---------------------------------------------------------------------------

/// A `.MAK` fixed station with a known UTM location (meters).
#[derive(Debug, Clone)]
struct FixedStation {
    name: String,
    easting: f64,
    northing: f64,
    elevation: f64,
}

/// Fully parsed Compass data plus the project-level georeference state.
pub struct ParsedCompass {
    cave_name: String,
    datum: Option<Datum>,
    utm_zone: Option<u8>,
    convergence: f64,
    convergence_applied: bool,
    declination_mode: DeclinationMode,
    fixed_stations: Vec<FixedStation>,
    surveys: Vec<Survey>,
    warnings: Vec<String>,
}

/// Parse a Compass `.MAK` project (following its `#file` links) or a single
/// `.DAT` survey file.
pub fn parse_compass(path: &Path) -> Result<ParsedCompass> {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .map(str::to_ascii_lowercase);
    match ext.as_deref() {
        Some("mak") => parse_mak(path),
        Some("dat") => parse_dat(path),
        _ => Err(anyhow!(
            "Unsupported Compass file '{}' (expected .mak or .dat)",
            path.display()
        )),
    }
}

fn parse_mak(path: &Path) -> Result<ParsedCompass> {
    let project = Project::read(path).map_err(|e| anyhow!("Failed to read Compass project: {e}"))?;
    let loaded = project
        .load_survey_files()
        .map_err(|e| anyhow!("Failed to load Compass survey files: {e}"))?;

    let mut datum = None;
    let mut utm_zone = None;
    let mut convergence = 0.0;
    let mut convergence_applied = false;
    let mut declination_mode = DeclinationMode::default();
    let mut fixed_stations = Vec::new();
    let mut surveys = Vec::new();

    for (i, dat) in loaded.survey_files.iter().enumerate() {
        let state = &dat.file_state;
        if i == 0 {
            datum = Some(state.datum);
            utm_zone = state.utm_zone.or(Some(state.base_location.zone));
            convergence = state.base_location.convergence_angle;
            if let Some(fc) = &state.file_convergence {
                convergence = fc.angle;
                convergence_applied = fc.enabled;
            }
            if let Some(pp) = &state.project_parameters {
                declination_mode = pp.declination_mode;
                convergence_applied = pp.utm_convergence_applied;
            }
        }
        for station in &dat.project_stations {
            if let Some(loc) = station.location {
                fixed_stations.push(FixedStation {
                    name: station.name.clone(),
                    easting: loc.easting,
                    northing: loc.northing,
                    elevation: loc.up,
                });
            }
        }
        for survey in dat.surveys() {
            surveys.push(survey.clone());
        }
    }

    let cave_name = surveys
        .first()
        .map_or_else(String::new, |s| s.cave_name.clone());

    Ok(ParsedCompass {
        cave_name,
        datum,
        utm_zone,
        convergence,
        convergence_applied,
        declination_mode,
        fixed_stations,
        surveys,
        warnings: Vec::new(),
    })
}

fn parse_dat(path: &Path) -> Result<ParsedCompass> {
    let contents = read_latin1(path)?;
    let surveys = Survey::parse_dat_file(&contents)
        .map_err(|e| anyhow!("Failed to parse Compass .DAT file: {e}"))?;
    let cave_name = surveys
        .first()
        .map_or_else(String::new, |s| s.cave_name.clone());
    Ok(ParsedCompass {
        cave_name,
        datum: None,
        utm_zone: None,
        convergence: 0.0,
        convergence_applied: false,
        declination_mode: DeclinationMode::default(),
        fixed_stations: Vec::new(),
        surveys,
        warnings: Vec::new(),
    })
}

/// Read a Compass file as Windows-1252/latin1 (Compass's encoding); decoding each
/// byte as a code point avoids panics on accented surveyor names and comments.
fn read_latin1(path: &Path) -> Result<String> {
    let bytes = std::fs::read(path).with_context(|| format!("reading {}", path.display()))?;
    Ok(bytes.iter().map(|&b| b as char).collect())
}

/// Build the import-dialog preview from parsed data.
pub fn build_preview(parsed: &ParsedCompass) -> CompassFile {
    let shot_count = parsed
        .surveys
        .iter()
        .map(|s| s.shots.len())
        .sum::<usize>() as u32;
    let has_backsights = parsed
        .surveys
        .iter()
        .any(|s| s.parameters.format_parameters.has_backsights());
    let surveys = parsed
        .surveys
        .iter()
        .map(|s| CompassSurveySummary {
            name: s.name.clone(),
            date: s.date.to_string(),
            team: non_empty(&s.team),
            shot_count: s.shots.len() as u32,
            declination: s.parameters.declination,
        })
        .collect();
    CompassFile {
        cave_name: parsed.cave_name.clone(),
        survey_count: parsed.surveys.len() as u32,
        shot_count,
        has_backsights,
        datum: parsed.datum.map(|d| format!("{d:?}")),
        utm_zone: parsed.utm_zone.map(i32::from),
        has_georeference: !parsed.fixed_stations.is_empty() && parsed.utm_zone.is_some(),
        declination_mode: format!("{:?}", parsed.declination_mode),
        surveys,
        warnings: parsed.warnings.clone(),
    }
}

// ---------------------------------------------------------------------------
// Conversion
// ---------------------------------------------------------------------------

/// Per-survey geometry context (corrections, units, declination, convergence).
struct SurveyCtx {
    declination: f64,
    convergence_angle: f64,
    length_to_m: f64,
    apply_corrections: bool,
    corrections: Option<CorrectionFactors>,
}

/// Resolved georeference anchor for the project.
struct AnchorGeo {
    coordinates: GpsCoordinates,
    name: String,
    elevation: f64,
    lat_lng: (f64, f64),
}

#[derive(Default)]
struct ShotFlags {
    exclude_all: bool,
}

fn parse_flags(flags: Option<&String>) -> ShotFlags {
    let mut parsed = ShotFlags::default();
    if let Some(text) = flags {
        for c in text.chars() {
            if c.eq_ignore_ascii_case(&'X') {
                parsed.exclude_all = true;
            }
        }
    }
    parsed
}

fn angle_missing(raw: f64) -> bool {
    raw <= MISSING_ANGLE_THRESHOLD || raw >= MISSING_VALUE_THRESHOLD
}

fn lrud_meters(raw: f64, length_to_m: f64) -> Option<f64> {
    if raw <= -1.0 || raw >= MISSING_VALUE_THRESHOLD {
        return None;
    }
    let value = raw * length_to_m;
    if value.abs() < f64::EPSILON {
        None
    } else {
        Some(value)
    }
}

fn non_empty(text: &str) -> Option<String> {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

/// Corrected azimuth (grid, 0..360), slope length (m), inclination (deg, +up),
/// and elevation gain (m, +up) for a shot.
fn shot_geometry(shot: &Shot, ctx: &SurveyCtx) -> (f64, f64, f64) {
    let mut azimuth = if angle_missing(shot.azimuth) {
        0.0
    } else {
        shot.azimuth
    };
    let mut inclination = if angle_missing(shot.inclination) {
        0.0
    } else {
        shot.inclination
    };
    let mut length = if shot.length >= MISSING_VALUE_THRESHOLD {
        0.0
    } else {
        shot.length
    };
    if ctx.apply_corrections {
        if let Some(cf) = &ctx.corrections {
            azimuth += cf.azimuth;
            inclination += cf.inclination;
            length += cf.length;
        }
    }
    let azimuth_final = (azimuth + ctx.declination - ctx.convergence_angle).rem_euclid(360.0);
    let length_m = length * ctx.length_to_m;
    (azimuth_final, length_m, inclination)
}

fn elevation_gain(length_m: f64, inclination_deg: f64) -> f64 {
    length_m * inclination_deg.to_radians().sin()
}

/// Convert a single Compass shot to a Stalagmight `ShotData`, given the absolute
/// depths (meters, +down) already resolved for its endpoints.
fn shot_to_shot_data(
    shot: &Shot,
    ctx: &SurveyCtx,
    depth_in: f64,
    depth_out: f64,
    is_reference: bool,
) -> ShotData {
    let (azimuth, length_m, inclination) = shot_geometry(shot, ctx);
    ShotData {
        azimuth_in: azimuth,
        azimuth_out: azimuth,
        length: length_m,
        depth_in,
        depth_out,
        // Stalagmight pitch is positive downward; Compass inclination is positive up.
        pitch_in: Some(-inclination),
        pitch_out: None,
        left: lrud_meters(shot.left, ctx.length_to_m),
        right: lrud_meters(shot.right, ctx.length_to_m),
        up: lrud_meters(shot.up, ctx.length_to_m),
        down: lrud_meters(shot.down, ctx.length_to_m),
        comment: shot.comment.as_deref().and_then(non_empty),
        is_reference,
        marker_index: None,
        temperature: None,
    }
}

fn build_ctx(
    survey: &Survey,
    parsed: &ParsedCompass,
    anchor_lat_lng: Option<(f64, f64)>,
    opts: &CompassImportOptions,
    warnings: &mut Vec<String>,
) -> SurveyCtx {
    let format = &survey.parameters.format_parameters;
    let length_to_m = match format.length_units() {
        Some(LengthUnits::Meters) => 1.0,
        _ => FEET_TO_METERS,
    };
    match format.inclination_units() {
        Some(InclinationUnits::Degrees | InclinationUnits::DepthGauge) | None => {}
        Some(other) => warnings.push(format!(
            "Survey '{}': inclination unit {other:?} is unsupported; treated as degrees",
            survey.name
        )),
    }
    let declination = survey_declination(parsed.declination_mode, survey, anchor_lat_lng, warnings);
    let convergence_angle = if parsed.convergence_applied {
        parsed.convergence
    } else {
        0.0
    };
    SurveyCtx {
        declination,
        convergence_angle,
        length_to_m,
        apply_corrections: opts.apply_corrections,
        corrections: survey.parameters.correction_factors.clone(),
    }
}

fn survey_declination(
    mode: DeclinationMode,
    survey: &Survey,
    anchor_lat_lng: Option<(f64, f64)>,
    warnings: &mut Vec<String>,
) -> f64 {
    match mode {
        DeclinationMode::Ignore => 0.0,
        DeclinationMode::Entered => survey.parameters.declination,
        DeclinationMode::Auto => match anchor_lat_lng {
            Some((lat, lng)) => match igrf_declination(lat, lng, survey.date) {
                Ok(value) => value,
                Err(reason) => {
                    warnings.push(format!(
                        "Survey '{}': auto declination failed ({reason}); using entered value",
                        survey.name
                    ));
                    survey.parameters.declination
                }
            },
            None => {
                warnings.push(format!(
                    "Survey '{}': auto declination needs a georeference; using entered value",
                    survey.name
                ));
                survey.parameters.declination
            }
        },
    }
}

fn igrf_declination(lat: f64, lng: f64, date: chrono::NaiveDate) -> Result<f64, String> {
    let ordinal = u16::try_from(date.ordinal()).map_err(|_| "invalid day-of-year".to_string())?;
    let date = time::Date::from_ordinal_date(date.year(), ordinal)
        .map_err(|e| format!("invalid date: {e}"))?;
    igrf::declination(lat, lng, 0, date)
        .map(|field| field.d)
        .map_err(|e| format!("{e:?}"))
}

/// Map a Compass datum to a proj4rs datum/ellipsoid token, warning when only an
/// approximate (WGS84) fallback is available.
fn datum_proj_token(datum: Datum, warnings: &mut Vec<String>) -> String {
    match datum {
        Datum::WGS1984 => "datum=WGS84".to_string(),
        Datum::NorthAmerican1983 => "datum=NAD83".to_string(),
        Datum::NorthAmerican1927 => "datum=NAD27".to_string(),
        Datum::WGS1972 => "ellps=WGS72".to_string(),
        other => {
            warnings.push(format!(
                "Datum {other:?} is not directly supported; approximating as WGS84 (the GPS anchor may be offset)"
            ));
            "datum=WGS84".to_string()
        }
    }
}

/// Convert a UTM easting/northing (meters, northern hemisphere) to WGS84
/// longitude/latitude in degrees.
fn utm_to_wgs84(
    easting: f64,
    northing: f64,
    zone: u8,
    datum: Datum,
    warnings: &mut Vec<String>,
) -> Option<(f64, f64)> {
    let token = datum_proj_token(datum, warnings);
    let from = proj4rs::Proj::from_proj_string(&format!(
        "+proj=utm +zone={zone} +{token} +units=m +no_defs"
    ))
    .ok()?;
    let to = proj4rs::Proj::from_proj_string("+proj=longlat +datum=WGS84 +no_defs").ok()?;
    let (lon, lat, _) = proj4rs::adaptors::transform_xyz(&from, &to, easting, northing, 0.0).ok()?;
    Some((lon.to_degrees(), lat.to_degrees()))
}

fn resolve_anchor(parsed: &ParsedCompass, warnings: &mut Vec<String>) -> Option<AnchorGeo> {
    let station = parsed.fixed_stations.first()?;
    let zone = parsed.utm_zone?;
    let datum = parsed.datum.unwrap_or(Datum::WGS1984);
    let (lon, lat) = utm_to_wgs84(station.easting, station.northing, zone, datum, warnings)?;
    let coordinates = GpsCoordinates::new(lat, lon, 0.0)
        .map_err(|e| warnings.push(format!("Ignoring invalid GPS anchor: {e}")))
        .ok()?;
    Some(AnchorGeo {
        coordinates,
        name: station.name.clone(),
        elevation: station.elevation,
        lat_lng: (lat, lon),
    })
}

/// Kept shot with its survey context, retained for graph + section building.
struct KeptSurvey<'a> {
    survey: &'a Survey,
    ctx: SurveyCtx,
    shots: Vec<&'a Shot>,
}

/// Split a survey's kept shots into head-to-tail connected chains, breaking
/// whenever a shot's `from` station doesn't continue the previous shot's `to`.
fn split_into_chains(shots: &[&Shot]) -> Vec<Vec<usize>> {
    let mut chains: Vec<Vec<usize>> = Vec::new();
    let mut current: Vec<usize> = Vec::new();
    let mut prev_to: Option<&str> = None;
    for (i, shot) in shots.iter().enumerate() {
        let continues = prev_to == Some(shot.from.as_str());
        if !continues && !current.is_empty() {
            chains.push(std::mem::take(&mut current));
        }
        current.push(i);
        prev_to = Some(shot.to.as_str());
    }
    if !current.is_empty() {
        chains.push(current);
    }
    chains
}

/// Walk the station graph (built from elevation gains) assigning each station an
/// absolute elevation. The anchor (if any) seeds its component; other components
/// seed at zero.
fn build_elevation(
    edges: &[(String, String, f64)],
    anchor_name: Option<&str>,
    anchor_elevation: f64,
) -> HashMap<String, f64> {
    let mut adjacency: HashMap<&str, Vec<(&str, f64)>> = HashMap::new();
    for (from, to, gain) in edges {
        adjacency
            .entry(from.as_str())
            .or_default()
            .push((to.as_str(), *gain));
        adjacency
            .entry(to.as_str())
            .or_default()
            .push((from.as_str(), -*gain));
    }

    let mut elevation: HashMap<String, f64> = HashMap::new();
    let mut queue: VecDeque<&str> = VecDeque::new();

    if let Some(anchor) = anchor_name {
        if adjacency.contains_key(anchor) {
            elevation.insert(anchor.to_string(), anchor_elevation);
            queue.push_back(anchor);
        }
    }

    // Collect node names for deterministic component seeding.
    let mut nodes: Vec<&str> = adjacency.keys().copied().collect();
    nodes.sort_unstable();

    let mut node_cursor = 0;
    loop {
        // Drain the current BFS frontier.
        while let Some(node) = queue.pop_front() {
            let current = elevation.get(node).copied().unwrap_or(0.0);
            if let Some(neighbors) = adjacency.get(node) {
                for (neighbor, gain) in neighbors {
                    if !elevation.contains_key(*neighbor) {
                        elevation.insert((*neighbor).to_string(), current + gain);
                        queue.push_back(neighbor);
                    }
                }
            }
        }
        // Seed the next unvisited component at zero.
        while node_cursor < nodes.len() && elevation.contains_key(nodes[node_cursor]) {
            node_cursor += 1;
        }
        if node_cursor >= nodes.len() {
            break;
        }
        let seed = nodes[node_cursor];
        elevation.insert(seed.to_string(), 0.0);
        queue.push_back(seed);
    }

    elevation
}

/// Convert parsed Compass data into Stalagmight import configs + loop closures.
/// Returns `(configs, closures, warnings)`.
pub fn convert_compass_to_import_configs(
    parsed: &ParsedCompass,
    opts: &CompassImportOptions,
) -> Result<(Vec<ImportSectionConfig>, Vec<ImportClosure>, Vec<String>)> {
    let mut warnings = parsed.warnings.clone();

    let anchor = resolve_anchor(parsed, &mut warnings);
    let anchor_name = anchor.as_ref().map(|a| a.name.clone());
    let anchor_elevation = anchor.as_ref().map_or(0.0, |a| a.elevation);
    let anchor_lat_lng = anchor.as_ref().map(|a| a.lat_lng);
    let anchor_coordinates = anchor.as_ref().map(|a| a.coordinates);

    // Pass 1: per-survey contexts, kept shots, and elevation graph edges.
    let mut kept: Vec<KeptSurvey> = Vec::new();
    let mut edges: Vec<(String, String, f64)> = Vec::new();
    for survey in &parsed.surveys {
        let ctx = build_ctx(survey, parsed, anchor_lat_lng, opts, &mut warnings);
        let mut shots = Vec::new();
        for shot in &survey.shots {
            let flags = parse_flags(shot.flags.as_ref());
            if flags.exclude_all && !opts.include_excluded {
                continue;
            }
            let (_, length_m, inclination) = shot_geometry(shot, &ctx);
            if length_m <= 0.0 {
                // Zero-length connectors can't be stored as section shots.
                continue;
            }
            edges.push((
                shot.from.clone(),
                shot.to.clone(),
                elevation_gain(length_m, inclination),
            ));
            shots.push(shot);
        }
        kept.push(KeptSurvey {
            survey,
            ctx,
            shots,
        });
    }

    let elevation = build_elevation(&edges, anchor_name.as_deref(), anchor_elevation);
    let depth_ref = anchor_name
        .as_deref()
        .and_then(|a| elevation.get(a))
        .copied()
        .unwrap_or(0.0);
    let depth_of = |station: &str| depth_ref - elevation.get(station).copied().unwrap_or(0.0);

    // Pass 2: split into chains, build sections, resolve placement + closures.
    let mut configs: Vec<ImportSectionConfig> = Vec::new();
    let mut closures: Vec<ImportClosure> = Vec::new();
    let mut global_map: HashMap<String, (u32, u32)> = HashMap::new();
    let mut next_section: u32 = 0;

    for kept_survey in &kept {
        let chains = split_into_chains(&kept_survey.shots);
        let multi = chains.len() > 1;
        for (chain_idx, chain) in chains.iter().enumerate() {
            if chain.is_empty() {
                continue;
            }
            let section_index = next_section;
            next_section += 1;

            // Station names: chain start, then each shot's `to`.
            let mut names: Vec<String> = Vec::with_capacity(chain.len() + 1);
            names.push(kept_survey.shots[chain[0]].from.clone());
            for &idx in chain {
                names.push(kept_survey.shots[idx].to.clone());
            }

            // Shot data.
            let mut shots_data = Vec::with_capacity(chain.len());
            for &idx in chain {
                let shot = kept_survey.shots[idx];
                let flags = parse_flags(shot.flags.as_ref());
                shots_data.push(shot_to_shot_data(
                    shot,
                    &kept_survey.ctx,
                    depth_of(&shot.from),
                    depth_of(&shot.to),
                    flags.exclude_all,
                ));
            }

            // Stations already placed in earlier sections.
            let shared: Vec<(u32, u32, u32)> = names
                .iter()
                .enumerate()
                .filter_map(|(k, name)| {
                    global_map
                        .get(name)
                        .map(|&(sec, st)| (k as u32, sec, st))
                })
                .collect();

            let anchor_idx = anchor_name
                .as_deref()
                .and_then(|a| names.iter().position(|n| n == a));

            let mut placement_merge: Option<u32> = None;
            let placement = match (anchor_idx, anchor_coordinates) {
                (Some(idx), Some(coordinates)) => ImportPlacement::ZeroDatum {
                    coordinates,
                    station_index: idx as u32,
                },
                _ => {
                    if let Some(&(k, sec, st)) = shared.first() {
                        placement_merge = Some(k);
                        ImportPlacement::FromImporting {
                            import_station: k,
                            target_section_index: sec,
                            target_station_index: st,
                        }
                    } else {
                        if !configs.is_empty() {
                            warnings.push(format!(
                                "Section '{}' is not connected to the rest of the survey; placed at origin",
                                section_label(kept_survey.survey, multi, chain_idx)
                            ));
                        }
                        ImportPlacement::Origin
                    }
                }
            };

            // Any other shared station becomes a loop closure to keep connectivity.
            for &(k, sec, st) in &shared {
                if Some(k) == placement_merge {
                    continue;
                }
                closures.push(ImportClosure {
                    from_section_index: section_index,
                    from_station_index: k,
                    to_section_index: sec,
                    to_station_index: st,
                });
            }

            // Register first occurrences of this section's stations.
            for (k, name) in names.iter().enumerate() {
                global_map
                    .entry(name.clone())
                    .or_insert((section_index, k as u32));
            }

            configs.push(ImportSectionConfig {
                section_index,
                name: Some(section_label(kept_survey.survey, multi, chain_idx)),
                surveyor: non_empty(&kept_survey.survey.team),
                date: Some(kept_survey.survey.date),
                color: SECTION_COLORS[section_index as usize % SECTION_COLORS.len()].to_string(),
                direction: None,
                quality: 1.0,
                shots: shots_data,
                placement,
                station_comments: Vec::new(),
            });
        }
    }

    topological_sort_configs(&mut configs);

    Ok((configs, closures, warnings))
}

fn section_label(survey: &Survey, multi: bool, chain_idx: usize) -> String {
    let base = if survey.name.trim().is_empty() {
        survey.cave_name.clone()
    } else {
        survey.name.clone()
    };
    if multi {
        format!("{base} (branch {})", chain_idx + 1)
    } else {
        base
    }
}

/// Reorder configs so that any section referenced by a `FromImporting` placement
/// is created before its dependent (Kahn's algorithm; cycles fall back to
/// original order).
fn topological_sort_configs(configs: &mut Vec<ImportSectionConfig>) {
    if configs.len() <= 1 {
        return;
    }
    let pos_of: HashMap<u32, usize> = configs
        .iter()
        .enumerate()
        .map(|(i, c)| (c.section_index, i))
        .collect();
    let dep: Vec<Option<usize>> = configs
        .iter()
        .map(|c| match &c.placement {
            ImportPlacement::FromImporting {
                target_section_index,
                ..
            } => pos_of.get(target_section_index).copied(),
            _ => None,
        })
        .collect();

    let mut placed = vec![false; configs.len()];
    let mut order: Vec<usize> = Vec::with_capacity(configs.len());
    // Repeatedly emit configs whose dependency is already placed.
    let mut progress = true;
    while order.len() < configs.len() && progress {
        progress = false;
        for i in 0..configs.len() {
            if placed[i] {
                continue;
            }
            let ready = match dep[i] {
                Some(target) => placed[target],
                None => true,
            };
            if ready {
                placed[i] = true;
                order.push(i);
                progress = true;
            }
        }
    }
    // Append any remaining (cyclic) configs in original order.
    for i in 0..configs.len() {
        if !placed[i] {
            order.push(i);
        }
    }

    let mut reordered: Vec<Option<ImportSectionConfig>> =
        configs.drain(..).map(Some).collect();
    for idx in order {
        if let Some(config) = reordered[idx].take() {
            configs.push(config);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn fixture(name: &str) -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("tests/fixtures/compass")
            .join(name)
    }

    fn total_shots(configs: &[ImportSectionConfig]) -> usize {
        configs.iter().map(|c| c.shots.len()).sum()
    }

    #[test]
    fn parse_minotauro_mak_reads_georeference() {
        let parsed = parse_compass(&fixture("Minotauro.MAK")).unwrap();
        assert!(!parsed.surveys.is_empty());
        assert_eq!(parsed.datum, Some(Datum::WGS1984));
        assert_eq!(parsed.utm_zone, Some(16));
        let anchor = parsed
            .fixed_stations
            .iter()
            .find(|f| f.name == "00")
            .expect("fixed station 00");
        assert!((anchor.easting - 471_750.0).abs() < 1.0);
        assert!((anchor.northing - 2_264_824.0).abs() < 1.0);
    }

    #[test]
    fn minotauro_first_shot_geometry_is_depth_based() {
        let parsed = parse_compass(&fixture("Minotauro.MAK")).unwrap();
        let (configs, _closures, _warnings) =
            convert_compass_to_import_configs(&parsed, &CompassImportOptions::default()).unwrap();
        assert!(!configs.is_empty());

        // The chain containing the anchor "00" gets a ZeroDatum placement; its
        // first shot is 00 -> MNUS1 (49.00 ft, 66.00 deg, -5.86 deg, decl 0).
        let anchor_config = configs
            .iter()
            .find(|c| matches!(c.placement, ImportPlacement::ZeroDatum { .. }))
            .expect("a section anchored by zero datum");
        if let ImportPlacement::ZeroDatum { station_index, .. } = anchor_config.placement {
            assert_eq!(station_index, 0);
        }
        let shot = &anchor_config.shots[0];
        assert!((shot.azimuth_in - 66.0).abs() < 0.01, "azimuth {}", shot.azimuth_in);
        assert!((shot.length - 14.9352).abs() < 0.01, "length {}", shot.length);
        assert!(shot.depth_in.abs() < 0.01, "depth_in {}", shot.depth_in);
        // Descending 5.86 deg over 14.9352 m -> +1.525 m deeper.
        assert!((shot.depth_out - 1.5252).abs() < 0.01, "depth_out {}", shot.depth_out);
        assert!((shot.pitch_in.unwrap() - 5.86).abs() < 0.01, "pitch {:?}", shot.pitch_in);

        // Exactly one zero datum for the whole project.
        let zero_datums = configs
            .iter()
            .filter(|c| matches!(c.placement, ImportPlacement::ZeroDatum { .. }))
            .count();
        assert_eq!(zero_datums, 1);
    }

    #[test]
    fn minotauro_zero_datum_projects_to_tulum() {
        let parsed = parse_compass(&fixture("Minotauro.MAK")).unwrap();
        let (configs, _closures, _warnings) =
            convert_compass_to_import_configs(&parsed, &CompassImportOptions::default()).unwrap();
        let coords = configs
            .iter()
            .find_map(|c| match c.placement {
                ImportPlacement::ZeroDatum { coordinates, .. } => Some(coordinates),
                _ => None,
            })
            .expect("zero datum coordinates");
        // Cenote Minotauro is near Tulum, Quintana Roo, Mexico.
        assert!(coords.latitude > 20.0 && coords.latitude < 21.0, "lat {}", coords.latitude);
        assert!(coords.longitude > -88.0 && coords.longitude < -87.0, "lng {}", coords.longitude);
    }

    #[test]
    fn excluded_shots_are_filtered_by_default() {
        let parsed = parse_compass(&fixture("Minotauro.MAK")).unwrap();
        let (default_configs, _, _) = convert_compass_to_import_configs(
            &parsed,
            &CompassImportOptions { include_excluded: false, apply_corrections: true },
        )
        .unwrap();
        let (included_configs, _, _) = convert_compass_to_import_configs(
            &parsed,
            &CompassImportOptions { include_excluded: true, apply_corrections: true },
        )
        .unwrap();
        // The MNEstrella survey is entirely #|X# flagged, so including excluded
        // shots must add shots, imported as reference shots.
        assert!(total_shots(&included_configs) > total_shots(&default_configs));
        assert!(
            included_configs
                .iter()
                .any(|c| c.shots.iter().any(|s| s.is_reference))
        );
    }

    #[test]
    fn parse_dat_captures_backsights_flags_and_comments() {
        // simple.dat has a backsight format and flag/comment columns.
        let parsed = parse_compass(&fixture("simple.dat")).unwrap();
        let survey = &parsed.surveys[0];
        assert!(survey.parameters.format_parameters.has_backsights());
        assert!(survey.shots[0].back_azimuth.is_some());
        assert!(survey.shots.iter().any(|s| s.flags.as_deref() == Some("PC")));
        assert!(survey.shots.iter().any(|s| s.comment.is_some()));
    }

    #[test]
    fn utm_to_wgs84_matches_expected_region() {
        let mut warnings = Vec::new();
        let (lon, lat) =
            utm_to_wgs84(471_750.0, 2_264_824.0, 16, Datum::WGS1984, &mut warnings).unwrap();
        // Reference: pyproj EPSG:32616 -> EPSG:4326 gives lat 20.481817, lon -87.270896.
        assert!((lat - 20.481817).abs() < 0.0005, "lat {lat}");
        assert!((lon - (-87.270896)).abs() < 0.0005, "lon {lon}");
    }

    #[test]
    fn corpus_minotauro_converts_without_error() {
        let parsed = parse_compass(&fixture("Minotauro.MAK")).unwrap();
        let preview = build_preview(&parsed);
        assert!(preview.has_georeference);
        assert!(preview.survey_count >= 3);
        let (configs, _closures, _warnings) =
            convert_compass_to_import_configs(&parsed, &CompassImportOptions::default()).unwrap();
        assert!(!configs.is_empty());
        // Every section is linear and non-empty.
        assert!(configs.iter().all(|c| !c.shots.is_empty()));
    }
}
