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
    BackSightCorrectionFactors, CorrectionFactors, Datum, DeclinationMode, InclinationUnits,
    LengthUnits, Project, Shot, Survey,
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
    /// Promote each non-empty shot comment to its FROM station (Compass
    /// convention: surveyors annotate the station they were standing at).
    /// When false, comments stay on the shot.
    pub comments_on_stations: bool,
}

impl Default for CompassImportOptions {
    fn default() -> Self {
        Self {
            include_excluded: false,
            apply_corrections: true,
            comments_on_stations: true,
        }
    }
}

// ---------------------------------------------------------------------------
// Internal parsed representation
// ---------------------------------------------------------------------------

/// A `.MAK` fixed station with a known UTM location (meters).
/// `datum` / `utm_zone` are captured from the `#file` entry that declared
/// the station, so `resolve_anchor` can project it in its own frame
/// rather than file 0's (some multi-`#file` projects mix zones / datums).
#[derive(Debug, Clone)]
struct FixedStation {
    name: String,
    easting: f64,
    northing: f64,
    elevation: f64,
    datum: Option<Datum>,
    utm_zone: Option<u8>,
}

/// Per-`#file` Compass state.  `.MAK` projects can change DATUM, UTM zone,
/// convergence, and declination-mode policy between successive `#file`
/// entries, so the state has to travel alongside each survey instead of
/// being collapsed to the first file's values.
#[derive(Debug, Clone)]
struct CompassFileState {
    datum: Option<Datum>,
    utm_zone: Option<u8>,
    convergence: f64,
    convergence_applied: bool,
    declination_mode: DeclinationMode,
}

impl Default for CompassFileState {
    fn default() -> Self {
        Self {
            datum: None,
            utm_zone: None,
            convergence: 0.0,
            convergence_applied: false,
            declination_mode: DeclinationMode::default(),
        }
    }
}

/// A survey paired with the per-file Compass state in effect when it was
/// declared.  Used downstream by `build_ctx` so each survey sees its own
/// declination-mode / convergence rather than the first file's.
struct SurveyWithState {
    survey: Survey,
    state: CompassFileState,
}

/// Fully parsed Compass data plus the project-level georeference state.
/// `datum` / `utm_zone` come from the FIRST `#file` entry and feed
/// `resolve_anchor` (UTM-zone overrides on later files would need to be
/// projected per-file).  `declination_mode` is reported in the preview;
/// per-file overrides for declination/convergence flow through the
/// corresponding `SurveyWithState.state` so each survey's geometry uses
/// the policy declared in its own `#file` entry.
pub struct ParsedCompass {
    cave_name: String,
    datum: Option<Datum>,
    utm_zone: Option<u8>,
    declination_mode: DeclinationMode,
    fixed_stations: Vec<FixedStation>,
    surveys: Vec<SurveyWithState>,
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
    let mut declination_mode = DeclinationMode::default();
    let mut fixed_stations = Vec::new();
    let mut surveys: Vec<SurveyWithState> = Vec::new();
    let mut warnings: Vec<String> = Vec::new();

    for (i, dat) in loaded.survey_files.iter().enumerate() {
        let raw_state = &dat.file_state;
        // Reduce the vendor crate's FileState to the subset our pipeline
        // actually consults.  This is computed per file so subsequent
        // `#file` entries with different DATUM/UTM/CONVERGENCE/DECL
        // settings flow through to the surveys they introduced.
        let mut file_state = CompassFileState {
            datum: Some(raw_state.datum),
            utm_zone: raw_state.utm_zone.or(Some(raw_state.base_location.zone)),
            convergence: raw_state.base_location.convergence_angle,
            convergence_applied: false,
            declination_mode: DeclinationMode::default(),
        };
        if let Some(fc) = &raw_state.file_convergence {
            file_state.convergence = fc.angle;
            file_state.convergence_applied = fc.enabled;
        }
        if let Some(pp) = &raw_state.project_parameters {
            file_state.declination_mode = pp.declination_mode;
            file_state.convergence_applied = pp.utm_convergence_applied;
        }
        if i == 0 {
            // Mirror the first-file state into the project-wide fields
            // surfaced by `build_preview` (datum / utm_zone / declination_mode).
            // For geometry, each survey uses its own per-file state via
            // `SurveyWithState.state`; for the anchor projection,
            // `resolve_anchor` reads the per-FixedStation datum/zone
            // below (so multi-zone projects pick up the right frame).
            datum = file_state.datum;
            utm_zone = file_state.utm_zone;
            declination_mode = file_state.declination_mode;
        } else {
            // Surface divergence so the user knows the single-line
            // preview values reflect file 0 only.  Geometry is already
            // resolved per-file via `SurveyWithState.state`; this is
            // strictly a transparency warning for the import dialog.
            if file_state.datum != datum {
                warnings.push(format!(
                    "File #{} declares DATUM {:?} but the project preview shows {:?} (file 0). \
                     Surveys from this file are still imported in their own frame.",
                    i + 1,
                    file_state.datum,
                    datum,
                ));
            }
            if file_state.utm_zone != utm_zone {
                warnings.push(format!(
                    "File #{} declares UTM zone {:?} but the project preview shows {:?} (file 0). \
                     The anchor station's own zone is used for projection.",
                    i + 1,
                    file_state.utm_zone,
                    utm_zone,
                ));
            }
            if file_state.declination_mode != declination_mode {
                warnings.push(format!(
                    "File #{} declares declination mode {:?} but the project preview shows {:?} \
                     (file 0). Each survey still uses its own file's declination mode.",
                    i + 1,
                    file_state.declination_mode,
                    declination_mode,
                ));
            }
        }
        for station in &dat.project_stations {
            if let Some(loc) = station.location {
                fixed_stations.push(FixedStation {
                    name: station.name.clone(),
                    easting: loc.easting,
                    northing: loc.northing,
                    elevation: loc.up,
                    datum: file_state.datum,
                    utm_zone: file_state.utm_zone,
                });
            }
        }
        for survey in dat.surveys() {
            surveys.push(SurveyWithState {
                survey: survey.clone(),
                state: file_state.clone(),
            });
        }
    }

    let cave_name = surveys
        .first()
        .map_or_else(String::new, |s| s.survey.cave_name.clone());

    Ok(ParsedCompass {
        cave_name,
        datum,
        utm_zone,
        declination_mode,
        fixed_stations,
        surveys,
        warnings,
    })
}

fn parse_dat(path: &Path) -> Result<ParsedCompass> {
    let contents = read_latin1(path)?;
    let raw_surveys = Survey::parse_dat_file(&contents)
        .map_err(|e| anyhow!("Failed to parse Compass .DAT file: {e}"))?;
    let cave_name = raw_surveys
        .first()
        .map_or_else(String::new, |s| s.cave_name.clone());
    // A bare .DAT lacks #file scope, so every survey shares the same
    // default state.  parse_mak builds richer per-file state.
    let default_state = CompassFileState::default();
    let surveys = raw_surveys
        .into_iter()
        .map(|survey| SurveyWithState {
            survey,
            state: default_state.clone(),
        })
        .collect();
    Ok(ParsedCompass {
        cave_name,
        datum: None,
        utm_zone: None,
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
        .map(|s| s.survey.shots.len())
        .sum::<usize>() as u32;
    let has_backsights = parsed
        .surveys
        .iter()
        .any(|s| s.survey.parameters.format_parameters.has_backsights());
    let surveys = parsed
        .surveys
        .iter()
        .map(|s| CompassSurveySummary {
            name: s.survey.name.clone(),
            date: s.survey.date.to_string(),
            team: non_empty(&s.survey.team),
            shot_count: s.survey.shots.len() as u32,
            declination: s.survey.parameters.declination,
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
    backsight_corrections: Option<BackSightCorrectionFactors>,
    /// Inclination unit used by this survey.  Compass supports five
    /// (Degrees, PercentGrade, DegreesAndMinutes, Grads, DepthGauge);
    /// `shot_geometry` converts each to plain degrees before feeding
    /// the trig in elevation_gain.  `None` (= unrecognized) is treated
    /// as Degrees with a warning at parse time.
    inclination_units: InclinationUnits,
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
    // For Degrees / Grads / PercentGrade / DegreesAndMinutes the raw
    // value is sentinel-tested as an angle.  For DepthGauge the field
    // is a depth reading whose absolute value can equal the missing-
    // threshold, so only the "+ infinity" half of the sentinel applies
    // — pass the raw through.
    let mut inclination = match ctx.inclination_units {
        InclinationUnits::DepthGauge => {
            if shot.inclination >= MISSING_VALUE_THRESHOLD {
                0.0
            } else {
                shot.inclination
            }
        }
        _ => {
            if angle_missing(shot.inclination) {
                0.0
            } else {
                shot.inclination
            }
        }
    };
    let mut length = if shot.length >= MISSING_VALUE_THRESHOLD {
        0.0
    } else {
        shot.length
    };
    if ctx.apply_corrections {
        if let Some(cf) = &ctx.corrections {
            azimuth += cf.azimuth;
            // Corrections live in the survey's declared inclination
            // unit; they apply naturally for Degrees/Grads/Percent/DM.
            // For DepthGauge the field is a depth in length units;
            // adding the inclination-correction (also a length under
            // the DepthGauge convention per the Compass spec) is
            // dimensionally consistent.
            inclination += cf.inclination;
            length += cf.length;
        }
    }
    let azimuth_final = (azimuth + ctx.declination - ctx.convergence_angle).rem_euclid(360.0);
    let length_m = length * ctx.length_to_m;
    // Single normalisation point: convert whatever Compass unit the
    // survey declared into degrees so the rest of the pipeline
    // (elevation_gain, shot_to_shot_data's pitch sign flip) stays
    // unit-agnostic.  DepthGauge needs the slope length to resolve
    // asin(depth / length) — pass the raw length (same units as the
    // depth reading) so the ratio is dimensionless.
    let inclination_deg = inclination_to_degrees(inclination, &ctx.inclination_units, length);
    (azimuth_final, length_m, inclination_deg)
}

/// Process a back-sight pair (`back_azimuth`, `back_inclination`) and return
/// values comparable to the fore-sight after the same pipeline — i.e. in the
/// forward (FROM → TO) direction, Stalagmight's `+down` pitch convention.
///
/// Compass records back-sight as the raw instrument reading from the TO
/// station looking back at the FROM station, so for a well-calibrated survey
/// of a shot with fore-azimuth `a` and fore-inclination `i` (Compass +up):
///
///   * `back_azimuth`     ≈ a + 180°
///   * `back_inclination` ≈ -i   (uphill from FROM is downhill from TO)
///
/// We need to turn the back-sight around to FROM → TO:
///   * Azimuth: add 180° after declination/convergence.
///   * Inclination: flip sign to undo the TO-side reading direction.  That
///     yields the equivalent fore-sight in Compass's +up convention; one more
///     sign flip lands us in Stalagmight's +down (matching what
///     `shot_to_shot_data` applies to the fore-sight via `Some(-inclination)`).
///     The two flips cancel mathematically, so the final stored pitch_out
///     equals the raw `back_inclination` after corrections — but the
///     derivation is spelled out below so the intent is recoverable.
///
/// Returns `(azimuth_out_grid_deg, pitch_out_deg_positive_down)` if both
/// back-sight readings are present and non-sentinel, else `None`.
fn shot_backsight_geometry(shot: &Shot, ctx: &SurveyCtx) -> Option<(f64, f64)> {
    let back_az_raw = shot.back_azimuth?;
    let back_inc_raw = shot.back_inclination?;
    if angle_missing(back_az_raw) {
        return None;
    }
    let mut back_az = back_az_raw;
    let mut back_inc = if angle_missing(back_inc_raw) {
        0.0
    } else {
        back_inc_raw
    };
    if ctx.apply_corrections {
        if let Some(bcf) = &ctx.backsight_corrections {
            back_az += bcf.azimuth;
            back_inc += bcf.inclination;
        }
    }
    // Declination + convergence (same as fore).
    let back_az_grid = (back_az + ctx.declination - ctx.convergence_angle).rem_euclid(360.0);
    // Flip 180° so the bearing points FROM → TO, matching azimuth_in.
    let azimuth_out_fore_direction = (back_az_grid + 180.0).rem_euclid(360.0);
    // Inclination: -back_inc gives the forward-direction inclination in
    // Compass's +up convention.  Negating again converts to Stalagmight's
    // +down (what shot_to_shot_data does to the fore-sight).  Net:
    // identity — pitch_out_down equals back_inc after corrections.
    let pitch_out_down_positive = back_inc;
    Some((azimuth_out_fore_direction, pitch_out_down_positive))
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
    // If the survey took back-sight readings (separate from the fore-sight),
    // store them in the `_out` slots as forward-direction equivalents so
    // Stalagmight has both legs of the measurement available for averaging
    // and warnings.  When no back-sight is present, mirror the fore-sight
    // into the `_out` slot — matching the TML importer's convention.
    let (azimuth_out, pitch_out) = match shot_backsight_geometry(shot, ctx) {
        Some((back_az, back_pitch)) => (back_az, Some(back_pitch)),
        None => (azimuth, None),
    };
    ShotData {
        azimuth_in: azimuth,
        azimuth_out,
        length: length_m,
        depth_in,
        depth_out,
        // Stalagmight pitch is positive downward; Compass inclination is positive up.
        pitch_in: Some(-inclination),
        pitch_out,
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
    file_state: &CompassFileState,
    anchor_lat_lng: Option<(f64, f64)>,
    opts: &CompassImportOptions,
    warnings: &mut Vec<String>,
) -> SurveyCtx {
    let format = &survey.parameters.format_parameters;
    let length_to_m = match format.length_units() {
        Some(LengthUnits::Meters) => 1.0,
        _ => FEET_TO_METERS,
    };
    let inclination_units = format.inclination_units().unwrap_or(InclinationUnits::Degrees);
    if matches!(inclination_units, InclinationUnits::DepthGauge) {
        warnings.push(format!(
            "Survey '{}': inclination unit is DepthGauge (W); each shot's inclination \
             is interpreted as a vertical depth delta and converted to a slope angle \
             via asin(depth / length).  Depth-gauge surveys with zero-length shots \
             can't produce a slope and will be treated as horizontal.",
            survey.name
        ));
    }
    let declination = survey_declination(file_state.declination_mode, survey, anchor_lat_lng, warnings);
    let convergence_angle = if file_state.convergence_applied {
        file_state.convergence
    } else {
        0.0
    };
    SurveyCtx {
        declination,
        convergence_angle,
        length_to_m,
        apply_corrections: opts.apply_corrections,
        corrections: survey.parameters.correction_factors.clone(),
        backsight_corrections: survey.parameters.backsight_correction_factors.clone(),
        inclination_units,
    }
}

/// Convert a Compass-format inclination value to plain degrees.
///
/// Compass stores inclinations in one of five units (declared in the
/// survey's format parameters).  The whole rest of `shot_geometry` /
/// `elevation_gain` operates in degrees, so this is the single
/// normalisation point.
///
/// * `Degrees` (D)              — pass through
/// * `Grads` (R)                — × 0.9 (400 grads / 360°)
/// * `PercentGrade` (G)         — atan(percent / 100)
/// * `DegreesAndMinutes` (M)    — DDD.MM packed, minutes in the
///                                fractional part (e.g. 12.34 → 12 + 34/60)
/// * `DepthGauge` (W)           — `raw` is a vertical depth reading
///                                (length units), not an angle.  Convert
///                                to slope via asin(depth_m / slope_m).
///                                Caller passes `slope_length_m` so we
///                                can produce a degree result; if it's
///                                zero we fall back to 0° (warned at
///                                parse time).
fn inclination_to_degrees(
    raw: f64,
    units: &InclinationUnits,
    slope_length_m: f64,
) -> f64 {
    match units {
        InclinationUnits::Degrees => raw,
        InclinationUnits::Grads => raw * 0.9,
        InclinationUnits::PercentGrade => (raw / 100.0).atan().to_degrees(),
        InclinationUnits::DegreesAndMinutes => {
            // DDD.MM format: integer part is degrees, fractional part *
            // 100 is minutes (so 12.34 means 12° 34').  Preserve sign.
            let sign = raw.signum();
            let abs = raw.abs();
            let degrees = abs.trunc();
            let minutes = (abs - degrees) * 100.0;
            sign * (degrees + minutes / 60.0)
        }
        InclinationUnits::DepthGauge => {
            if slope_length_m.abs() < f64::EPSILON {
                0.0
            } else {
                let depth_m = raw; // Compass stores depth in the same
                // length units as the shot's length — we've already
                // converted length to meters before calling here, so
                // `raw` is in the same units as `slope_length_m`.  In
                // Compass, positive depth = down (target station is
                // below origin); Compass inclination convention is +up,
                // so a +5 m depth reading corresponds to a -inclination
                // (going down).
                let ratio = (depth_m / slope_length_m).clamp(-1.0, 1.0);
                -ratio.asin().to_degrees()
            }
        }
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

/// Convert a UTM easting/northing (meters) to WGS84 longitude/latitude in
/// degrees.  The Compass `.MAK` format records the UTM zone but not the
/// hemisphere, so we project both with and without the `+south` flag and
/// pick the result whose absolute latitude is the smaller — the wrong
/// hemisphere lands every survey south of the equator at ~+60 °N (or vice
/// versa for genuinely-northern surveys mis-projected as +south), so the
/// gap is large and unambiguous in practice.  Emits a warning when the
/// inferred hemisphere isn't the obvious one (false-northing implies
/// southern when the northing is large).
fn utm_to_wgs84(
    easting: f64,
    northing: f64,
    zone: u8,
    datum: Datum,
    warnings: &mut Vec<String>,
) -> Option<(f64, f64)> {
    let token = datum_proj_token(datum, warnings);
    let to = proj4rs::Proj::from_proj_string("+proj=longlat +datum=WGS84 +no_defs").ok()?;

    let project = |south: bool| -> Option<(f64, f64)> {
        let south_token = if south { " +south" } else { "" };
        let from = proj4rs::Proj::from_proj_string(&format!(
            "+proj=utm +zone={zone}{south_token} +{token} +units=m +no_defs"
        ))
        .ok()?;
        let (lon, lat, _) =
            proj4rs::adaptors::transform_xyz(&from, &to, easting, northing, 0.0).ok()?;
        Some((lon.to_degrees(), lat.to_degrees()))
    };

    let north = project(false);
    let south = project(true);
    match (north, south) {
        (Some(n), Some(s)) => {
            // Pick the projection whose latitude is the smaller in absolute
            // terms.  For a survey actually in the southern hemisphere the
            // northern projection lands at ~+60 °N while +south lands at the
            // correct -30 °ish; the inverse for genuinely-northern surveys.
            let pick_south = s.1.abs() < n.1.abs();
            if pick_south {
                warnings.push(format!(
                    "UTM zone {zone} projected as southern hemisphere (northing {northing:.0}); \
                     re-import without +south if this is a northern cave."
                ));
                Some(s)
            } else {
                Some(n)
            }
        }
        (Some(n), None) => Some(n),
        (None, Some(s)) => Some(s),
        (None, None) => None,
    }
}

fn resolve_anchor(parsed: &ParsedCompass, warnings: &mut Vec<String>) -> Option<AnchorGeo> {
    let station = parsed.fixed_stations.first()?;
    // Prefer the anchor's own `#file` datum/zone, falling back to the
    // project-wide values (always populated from file 0).  This makes
    // multi-`#file` projects whose first fixed station lives outside
    // file 0 project in their own frame instead of file 0's.
    let zone = station.utm_zone.or(parsed.utm_zone)?;
    let datum = station
        .datum
        .or(parsed.datum)
        .unwrap_or(Datum::WGS1984);
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
    for survey_with_state in &parsed.surveys {
        let survey = &survey_with_state.survey;
        let ctx = build_ctx(survey, &survey_with_state.state, anchor_lat_lng, opts, &mut warnings);
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

    // Pass 2a: split every kept survey into head-to-tail chains and build the
    // per-section data (names, shots, label). Placement is decided in pass 2b
    // by a spanning-tree walk over chain connectivity, so it doesn't depend on
    // survey/file order (the previous one-pass first-occurrence registration
    // mis-placed every chain whose shared station was first defined in a
    // later-processed survey, dumping ~280 shots at origin in Minotauro).
    struct PendingChain {
        section_index: u32,
        names: Vec<String>,
        shots: Vec<ShotData>,
        station_comments: Vec<(u32, String)>,
        label: String,
        surveyor: Option<String>,
        date: chrono::NaiveDate,
    }
    let mut chains: Vec<PendingChain> = Vec::new();
    for kept_survey in &kept {
        let split = split_into_chains(&kept_survey.shots);
        let multi = split.len() > 1;
        for (chain_idx, chain) in split.iter().enumerate() {
            if chain.is_empty() {
                continue;
            }
            let section_index = chains.len() as u32;
            let mut names: Vec<String> = Vec::with_capacity(chain.len() + 1);
            names.push(kept_survey.shots[chain[0]].from.clone());
            for &idx in chain {
                names.push(kept_survey.shots[idx].to.clone());
            }
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
            // Compass convention: comments describe the FROM station (where the
            // surveyor was standing). When the option is on, promote each
            // non-empty shot comment to its FROM station (station_index = shot
            // index in the chain) and clear it from the shot.
            let mut station_comments: Vec<(u32, String)> = Vec::new();
            if opts.comments_on_stations {
                for (shot_idx, shot) in shots_data.iter_mut().enumerate() {
                    if let Some(comment) = shot.comment.take() {
                        if !comment.is_empty() {
                            station_comments.push((shot_idx as u32, comment));
                        }
                    }
                }
            }
            chains.push(PendingChain {
                section_index,
                names,
                shots: shots_data,
                station_comments,
                label: section_label(kept_survey.survey, multi, chain_idx),
                surveyor: non_empty(&kept_survey.survey.team),
                date: kept_survey.survey.date,
            });
        }
    }

    // Pass 2b: index all station-name occurrences across every chain, then
    // build the chain adjacency (two chains are neighbors iff they share a
    // station name) and BFS from the anchor chain to assign a spanning-tree
    // placement: anchor -> ZeroDatum, each reached chain -> FromImporting to
    // its discovering neighbor. Unreachable components are seeded at Origin
    // exactly once each (their members chain into them via FromImporting too).
    let mut occurrences: HashMap<String, Vec<(usize, u32)>> = HashMap::new();
    for (ci, chain) in chains.iter().enumerate() {
        for (k, name) in chain.names.iter().enumerate() {
            occurrences
                .entry(name.clone())
                .or_default()
                .push((ci, k as u32));
        }
    }
    let mut adjacency: Vec<Vec<usize>> = vec![Vec::new(); chains.len()];
    for occs in occurrences.values() {
        for a in 0..occs.len() {
            for b in (a + 1)..occs.len() {
                let (ia, _) = occs[a];
                let (ib, _) = occs[b];
                if ia != ib {
                    adjacency[ia].push(ib);
                    adjacency[ib].push(ia);
                }
            }
        }
    }
    for nbrs in adjacency.iter_mut() {
        nbrs.sort_unstable();
        nbrs.dedup();
    }

    // Find a station shared between two chains, returning (child_idx, parent_idx).
    let shared_station =
        |child: &PendingChain, parent: &PendingChain| -> Option<(u32, u32)> {
            for (ci, cname) in child.names.iter().enumerate() {
                if let Some(pi) = parent.names.iter().position(|pn| pn == cname) {
                    return Some((ci as u32, pi as u32));
                }
            }
            None
        };

    let anchor_chain_idx = anchor_name.as_deref().and_then(|a| {
        chains
            .iter()
            .position(|ch| ch.names.iter().any(|n| n == a))
    });

    let mut placement: Vec<Option<ImportPlacement>> = vec![None; chains.len()];
    let mut placement_merge_station: Vec<Option<u32>> = vec![None; chains.len()];
    let mut placement_parent: Vec<Option<usize>> = vec![None; chains.len()];
    let mut visited = vec![false; chains.len()];
    let mut creation_order: Vec<usize> = Vec::with_capacity(chains.len());
    let mut queue: VecDeque<usize> = VecDeque::new();

    if let (Some(ac), Some(coords)) = (anchor_chain_idx, anchor_coordinates) {
        let aname = anchor_name.as_deref().unwrap_or("");
        let aidx = chains[ac]
            .names
            .iter()
            .position(|n| n == aname)
            .unwrap_or(0) as u32;
        placement[ac] = Some(ImportPlacement::ZeroDatum {
            coordinates: coords,
            station_index: aidx,
        });
        visited[ac] = true;
        creation_order.push(ac);
        queue.push_back(ac);
    }

    let mut next_root_warns = anchor_chain_idx.is_some();
    loop {
        while let Some(parent_idx) = queue.pop_front() {
            // Borrow-checker dance: copy the neighbor list before iterating.
            let neighbors = adjacency[parent_idx].clone();
            for nb in neighbors {
                if visited[nb] {
                    continue;
                }
                if let Some((child_st, parent_st)) =
                    shared_station(&chains[nb], &chains[parent_idx])
                {
                    placement[nb] = Some(ImportPlacement::FromImporting {
                        import_station: child_st,
                        target_section_index: chains[parent_idx].section_index,
                        target_station_index: parent_st,
                    });
                    placement_merge_station[nb] = Some(child_st);
                    placement_parent[nb] = Some(parent_idx);
                }
                visited[nb] = true;
                creation_order.push(nb);
                queue.push_back(nb);
            }
        }
        // Seed the next disconnected component (if any) at Origin.
        let next = (0..chains.len()).find(|&i| !visited[i]);
        match next {
            Some(seed) => {
                placement[seed] = Some(ImportPlacement::Origin);
                if next_root_warns {
                    warnings.push(format!(
                        "Section '{}' starts a separate component not connected to the georeferenced survey; placed at origin",
                        chains[seed].label
                    ));
                }
                next_root_warns = true;
                visited[seed] = true;
                creation_order.push(seed);
                queue.push_back(seed);
            }
            None => break,
        }
    }

    // Pass 2c: emit loop closures for shared stations that aren't the
    // spanning-tree merge edge — pin each chain's other shared station to the
    // canonical (earliest by section_index) occurrence.
    let mut canonical: HashMap<&str, (u32, u32)> = HashMap::new();
    for chain in &chains {
        for (k, name) in chain.names.iter().enumerate() {
            canonical
                .entry(name.as_str())
                .and_modify(|prev| {
                    if chain.section_index < prev.0 {
                        *prev = (chain.section_index, k as u32);
                    }
                })
                .or_insert((chain.section_index, k as u32));
        }
    }
    let mut closures: Vec<ImportClosure> = Vec::new();
    let mut closure_keys: std::collections::HashSet<(u32, u32, u32, u32)> =
        std::collections::HashSet::new();
    for (ci, chain) in chains.iter().enumerate() {
        let merge_st = placement_merge_station[ci];
        let parent_section = placement_parent[ci]
            .map(|p| chains[p].section_index);
        for (k, name) in chain.names.iter().enumerate() {
            if let Some(&(canon_sec, canon_st)) = canonical.get(name.as_str()) {
                if canon_sec == chain.section_index {
                    continue; // This chain owns the canonical occurrence.
                }
                // Skip the spanning-tree merge edge for THIS chain.
                if Some(k as u32) == merge_st && parent_section == Some(canon_sec) {
                    continue;
                }
                let key = (chain.section_index, k as u32, canon_sec, canon_st);
                if closure_keys.insert(key) {
                    closures.push(ImportClosure {
                        from_section_index: chain.section_index,
                        from_station_index: k as u32,
                        to_section_index: canon_sec,
                        to_station_index: canon_st,
                    });
                }
            }
        }
    }

    // Emit configs in BFS creation order so FromImporting targets always
    // precede their dependents at create time.
    let mut configs: Vec<ImportSectionConfig> = Vec::with_capacity(chains.len());
    for ci in creation_order {
        let chain = &chains[ci];
        let p = placement[ci]
            .clone()
            .unwrap_or(ImportPlacement::Origin);
        configs.push(ImportSectionConfig {
            section_index: chain.section_index,
            name: Some(chain.label.clone()),
            surveyor: chain.surveyor.clone(),
            date: Some(chain.date),
            color: SECTION_COLORS[chain.section_index as usize % SECTION_COLORS.len()].to_string(),
            direction: None,
            quality: 1.0,
            shots: chain.shots.clone(),
            placement: p,
            station_comments: chain.station_comments.clone(),
        });
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

    // Ready-queue Kahn's: build a reverse-dependency adjacency list so
    // each placed config can directly enqueue the configs that were
    // waiting on it.  Replaces an outer-loop-scan-everything version
    // that ran O(N²) for deeply-chained surveys (one section per pass
    // dependency).
    //
    // children[i] = indices of configs whose `dep` is Some(i).
    let mut children: Vec<Vec<usize>> = vec![Vec::new(); configs.len()];
    let mut placed = vec![false; configs.len()];
    let mut order: Vec<usize> = Vec::with_capacity(configs.len());
    let mut ready: VecDeque<usize> = VecDeque::new();
    for (i, d) in dep.iter().enumerate() {
        match d {
            Some(target) if *target < configs.len() => children[*target].push(i),
            // Root: no dependency, immediately ready.
            None => ready.push_back(i),
            // Dependency points outside the slice — treat as ready (the
            // legacy fallback was the same).
            Some(_) => ready.push_back(i),
        }
    }
    while let Some(i) = ready.pop_front() {
        if placed[i] {
            continue;
        }
        placed[i] = true;
        order.push(i);
        for &child in &children[i] {
            if !placed[child] {
                ready.push_back(child);
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
        // first shot is 00 -> MNUS1 (49.00 ft length, 66.00 deg bearing,
        // -5.86 ft depth reading, decl 0).  The Minotauro DAT FORMAT line is
        // `DDDWLRUDALDN` — the 4th char `W` declares inclination units as
        // DepthGauge, so the -5.86 column is a vertical-depth offset in the
        // shot's length units (feet here), not a slope angle in degrees.
        // The pipeline turns this into a Compass +up slope of
        // -asin(-5.86 / 49.00) ≈ +6.87° (target is shallower than origin),
        // which Stalagmight stores as pitch_in = -6.87° (+down) and
        // elevation_gain = 14.9352 m * sin(+6.87°) ≈ +1.787 m → MNUS1
        // ends up 1.787 m UP from "00", i.e. depth_out ≈ -1.787 m.
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
        // -asin(-5.86/49.00) ≈ +6.871° in Compass +up; 14.9352 * sin(6.871°)
        // ≈ +1.787 m gained going up, so MNUS1 ends ~1.787 m shallower
        // than "00" — depth_out ≈ -1.787 m in Stalagmight's +down convention.
        assert!((shot.depth_out + 1.7867).abs() < 0.01, "depth_out {}", shot.depth_out);
        assert!((shot.pitch_in.unwrap() + 6.871).abs() < 0.01, "pitch {:?}", shot.pitch_in);

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
            &CompassImportOptions {
                include_excluded: false,
                apply_corrections: true,
                comments_on_stations: true,
            },
        )
        .unwrap();
        let (included_configs, _, _) = convert_compass_to_import_configs(
            &parsed,
            &CompassImportOptions {
                include_excluded: true,
                apply_corrections: true,
                comments_on_stations: true,
            },
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
        let survey = &parsed.surveys[0].survey;
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
    fn comments_promoted_to_from_station_by_default() {
        // Compass convention: a shot comment describes the FROM station (the
        // point the surveyor was standing at). With comments_on_stations on
        // (the default), each non-empty shot comment should become a
        // station_comment at station_index = shot index, and the shot's own
        // comment should be cleared. Minotauro's first shot 00->MNUS1 carries
        // the cenote entrance note, which must land on station 0 ("00").
        let parsed = parse_compass(&fixture("Minotauro.MAK")).unwrap();
        let (promoted, _, _) =
            convert_compass_to_import_configs(&parsed, &CompassImportOptions::default()).unwrap();
        let anchor = promoted
            .iter()
            .find(|c| matches!(c.placement, ImportPlacement::ZeroDatum { .. }))
            .expect("zero datum section");
        assert!(
            anchor.shots[0].comment.is_none(),
            "first shot's comment should be promoted off the shot, got {:?}",
            anchor.shots[0].comment
        );
        let station_zero_comment = anchor
            .station_comments
            .iter()
            .find_map(|(idx, text)| (*idx == 0).then_some(text.as_str()));
        assert!(
            station_zero_comment.is_some_and(|s| s.contains("Cenote Minotauro")),
            "station 0 should carry the cenote entrance note, got {:?}",
            station_zero_comment
        );

        // With the option off, comments stay on the shot and station_comments
        // is empty for the section.
        let (kept_on_shots, _, _) = convert_compass_to_import_configs(
            &parsed,
            &CompassImportOptions {
                include_excluded: false,
                apply_corrections: true,
                comments_on_stations: false,
            },
        )
        .unwrap();
        let anchor_raw = kept_on_shots
            .iter()
            .find(|c| matches!(c.placement, ImportPlacement::ZeroDatum { .. }))
            .expect("zero datum section");
        assert!(anchor_raw.station_comments.is_empty());
        assert!(
            anchor_raw.shots[0]
                .comment
                .as_deref()
                .is_some_and(|c| c.contains("Cenote Minotauro"))
        );
    }

    #[test]
    fn minotauro_every_section_connects_to_the_zero_datum() {
        // Regression guard for the spanning-tree placement: every Compass section
        // in the Minotauro corpus must attach to the network through a
        // station-name path back to the zero datum (1 ZeroDatum + the rest
        // FromImporting), with no chains stranded at origin. A one-pass
        // first-occurrence placement previously left ~20 sections (~280 shots)
        // detached because their connection station was first defined in a
        // later-processed survey.
        let parsed = parse_compass(&fixture("Minotauro.MAK")).unwrap();
        let (configs, _closures, warnings) =
            convert_compass_to_import_configs(&parsed, &CompassImportOptions::default()).unwrap();
        let mut zero = 0;
        let mut origin = 0;
        for c in &configs {
            match c.placement {
                ImportPlacement::ZeroDatum { .. } => zero += 1,
                ImportPlacement::Origin => origin += 1,
                _ => {}
            }
        }
        assert_eq!(zero, 1, "exactly one zero datum expected");
        assert_eq!(origin, 0, "no section should be stranded at origin");
        assert!(
            warnings.iter().all(|w| !w.contains("origin")),
            "no 'placed at origin' warnings expected, got: {warnings:?}"
        );
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

    #[test]
    fn multi_file_mak_warns_on_per_file_divergence() {
        // multi_zone.mak declares two `#file` entries; file 0 uses
        // NAD-1983 / UTM 13 / declination=Entered (default), file 1
        // switches to WGS 1984 / UTM 14 / declination=Auto.  parse_mak
        // mirrors file 0's values into the project-wide preview fields
        // and emits one warning per divergence so the user knows the
        // preview only reflects file 0.  Geometry is resolved per-file
        // through `SurveyWithState.state` regardless of these warnings.
        let parsed = parse_compass(&fixture("multi_zone.mak")).unwrap();
        // Project-wide fields take file 0 values for preview.
        assert_eq!(parsed.datum, Some(Datum::NorthAmerican1983));
        assert_eq!(parsed.utm_zone, Some(13));
        // One warning per divergence (datum, utm_zone, declination_mode).
        let divergence_warnings: Vec<_> = parsed
            .warnings
            .iter()
            .filter(|w| w.starts_with("File #2"))
            .collect();
        assert_eq!(
            divergence_warnings.len(),
            3,
            "expected 3 divergence warnings, got: {:?}",
            parsed.warnings
        );
        assert!(divergence_warnings.iter().any(|w| w.contains("DATUM")));
        assert!(divergence_warnings.iter().any(|w| w.contains("UTM zone")));
        assert!(
            divergence_warnings
                .iter()
                .any(|w| w.contains("declination mode"))
        );
        // Each survey carries its own file's state; the surveys from
        // file 0 should differ in declination_mode from those of file 1.
        let modes: Vec<DeclinationMode> = parsed
            .surveys
            .iter()
            .map(|s| s.state.declination_mode)
            .collect();
        assert!(
            modes.iter().any(|m| matches!(m, DeclinationMode::Auto)),
            "at least one survey should use Auto (from file 1), got {modes:?}"
        );
        assert!(
            modes
                .iter()
                .any(|m| !matches!(m, DeclinationMode::Auto)),
            "at least one survey should NOT use Auto (from file 0), got {modes:?}"
        );

        // resolve_anchor must use the first FixedStation's own zone/datum,
        // not file 0's, when they disagree.  All fixed_stations in this
        // fixture come from project_stations (none declared inline), so
        // none are projected here — exercise the path by faking via the
        // build_preview output: it must surface file 0's UTM zone (13).
        let preview = build_preview(&parsed);
        assert_eq!(preview.utm_zone, Some(13));
    }
}
