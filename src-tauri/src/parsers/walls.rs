//! Walls (`.WPJ` / `.SRV`) cave-survey import.
//!
//! [Walls](https://texasspeleologicalsurvey.org/software/walls/) (David
//! McKenzie / Texas Speleological Survey) stores a project as a `.WPJ` tree of
//! books (folders) and surveys (leaves); each survey leaf points at a `.SRV`
//! survey-data file.  This module parses both and converts Walls's
//! inclination-or-depth-gauge, foresight/backsight survey model into
//! Stalagmight's depth-based import configs, mirroring [`crate::parsers::compass`]:
//!
//! - `.WPJ` is a flat, indented, ISO-8859-1 line file: `.BOOK`/`.ENDBOOK`
//!   nest, `.SURVEY` is a leaf, `.NAME` is the base filename (`.SRV` default
//!   extension), `.STATUS` is a bitfield (skip `DETACHED`/`TYPE_OTHER`), and
//!   `.OPTIONS` (`#units` args) + `.REF` (UTM/lat-long reference) inherit
//!   root → leaf.
//! - `.SRV` lines are `;`-commented, `#`-directive (`#Units`, `#Date`,
//!   `#Fix`, `#Prefix`, `#Segment`, `#Flag`, `#[`/`#]` block comments), or
//!   survey vectors.  Foresight/backsight pairs are written `fs/bs`; a Normal
//!   backsight is reversed 180° (azimuth) / negated (inclination) and
//!   averaged.  Underwater "depth-gauge" surveys (`#Units Order=DA Tape=SS`)
//!   carry two trailing columns that are station depths below the surface —
//!   these map straight onto Stalagmight's native `depth_in`/`depth_out`.
//! - CT inclinations are integrated (`length·sin(inc)`) along the station
//!   graph into absolute depths; the graph is split into linear sections
//!   joined by `FromImporting` merges + loop closures.
//! - A `#Fix`ed station with geographic coordinates becomes a GPS zero datum.
//!
//! Format references cross-validated against the dewalls
//! (`jedwards1211/dewalls`) and survex (`ojwb/survex` `src/datain.c`) Walls
//! parsers and the Walls manual.

use std::collections::{HashMap, HashSet, VecDeque};
use std::path::{Path, PathBuf};

use anyhow::{anyhow, Context, Result};
use chrono::{Datelike, NaiveDate};
use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::models::section::{ImportClosure, ImportPlacement, ImportSectionConfig};
use crate::models::shot::ShotData;
use crate::models::station::GpsCoordinates;
use crate::parsers::geo::{non_empty, FEET_TO_METERS};

/// Section colors cycled across imported sections (matches the app palette).
const SECTION_COLORS: &[&str] = &[
    "#4ecdc4", "#ff6b6b", "#ffd93d", "#6bcB77", "#4d96ff", "#c780fa", "#ff9f45", "#9bdeac",
];

// `.STATUS` bitfield (see module docs / dewalls `wallsprojectparser.cpp`).
const STATUS_DETACHED: u32 = 1 << 1; // entry skipped during compilation
const STATUS_TYPE_OTHER: u32 = 1 << 16; // attached non-survey file (svg, etc.)
const STATUS_DONT_DERIVE_DECL: u32 = 1 << 8;
const STATUS_DERIVE_DECL: u32 = 1 << 9;
const STATUS_NOT_GRID_RELATIVE: u32 = 1 << 10;
const STATUS_GRID_RELATIVE: u32 = 1 << 11;

// ---------------------------------------------------------------------------
// IPC preview payload
// ---------------------------------------------------------------------------

/// Lightweight summary of a parsed Walls project, returned to the import dialog.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct WallsFile {
    pub project_name: String,
    pub book_count: u32,
    pub survey_count: u32,
    /// Surveys whose `.SRV` file was found on disk and parsed.
    pub resolved_survey_count: u32,
    pub shot_count: u32,
    /// Anonymous-wall / splay shots that are excluded from `shot_count` but
    /// WOULD be imported with "Include splays" enabled. Lets the dialog allow
    /// import of a splay-only file (where `shot_count == 0`) once the user opts
    /// in, instead of leaving the button permanently disabled.
    pub splay_count: u32,
    /// True when the project carries a `.REF` projection reference (UTM/datum).
    /// This is the coordinate system, NOT a station anchor — see
    /// `fixed_station_count` for actual GPS anchors.
    pub has_georeference: bool,
    pub datum: Option<String>,
    pub utm_zone: Option<i32>,
    /// Number of `#Fix` stations with a resolvable geographic position. Each
    /// connected component containing one gets a GPS zero datum on import.
    pub fixed_station_count: u32,
    /// Referenced `.SRV` files that could not be found on disk.
    pub missing_file_count: u32,
    /// `.WPJ` entries skipped because they are non-survey attachments.
    pub skipped_attachment_count: u32,
    pub surveys: Vec<WallsSurveySummary>,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct WallsSurveySummary {
    pub name: String,
    pub title: String,
    pub date: String,
    pub segment: String,
    pub shot_count: u32,
    /// `false` when the referenced `.SRV` file was missing on disk.
    pub resolved: bool,
}

/// Options controlling how a Walls project is converted into import configs.
#[derive(Debug, Clone)]
pub struct WallsImportOptions {
    /// Promote each non-empty shot comment to its FROM station.
    pub comments_on_stations: bool,
    /// Include anonymous "wall" / splay shots (a `-` station) as reference shots.
    pub include_splays: bool,
    /// Survey indices (into `ParsedWalls::surveys`, matching the preview's
    /// `WallsFile::surveys` order 1:1) the user chose to import. `None` imports
    /// every survey; `Some(set)` imports only the listed indices (an empty set
    /// imports nothing). Filtering by the ORIGINAL index keeps synthetic splay
    /// names (`anon:{si}:…`) stable and lets a deselected survey's `#Fix`
    /// anchors drop out cleanly instead of becoming "unused anchor" warnings.
    pub selected_surveys: Option<HashSet<u32>>,
}

impl Default for WallsImportOptions {
    fn default() -> Self {
        Self {
            comments_on_stations: true,
            include_splays: false,
            selected_surveys: None,
        }
    }
}

impl WallsImportOptions {
    /// Whether survey index `si` (into `ParsedWalls::surveys`) is included by the
    /// current selection. `None` selection ⇒ all surveys.
    fn includes_survey(&self, si: usize) -> bool {
        match &self.selected_surveys {
            Some(sel) => sel.contains(&(si as u32)),
            None => true,
        }
    }
}

// ---------------------------------------------------------------------------
// Units state machine
// ---------------------------------------------------------------------------

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum LengthUnit {
    Meters,
    Feet,
}

impl LengthUnit {
    fn factor(self) -> f64 {
        match self {
            LengthUnit::Meters => 1.0,
            LengthUnit::Feet => FEET_TO_METERS,
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum AngleUnit {
    Degrees,
    Grads,
    Mils,
    Percent,
}

impl AngleUnit {
    /// Convert a raw reading in this unit to degrees.
    fn to_degrees(self, value: f64) -> f64 {
        match self {
            AngleUnit::Degrees => value,
            AngleUnit::Grads => value * 0.9, // 400 grad == 360°
            AngleUnit::Mils => value * (360.0 / 6400.0), // 6400 mil == 360°
            AngleUnit::Percent => (value / 100.0).atan().to_degrees(),
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum OrderElem {
    Dist,
    Azm,
    Inc,
    East,
    North,
    Up,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum VectorType {
    Ct,
    Rect,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Case {
    Upper,
    Lower,
    Mixed,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum LrudType {
    From,
    To,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum TapeEnd {
    Instrument,
    Station,
    Target,
}

/// The full `#Units` state, copied on `Save`/restored on `Restore`, reset by
/// `Reset`.  Defaults match the Walls manual / dewalls `WallsUnitsData`.
#[derive(Clone, Debug)]
struct WallsUnits {
    vector_type: VectorType,
    /// Measurement column order for compass-and-tape (CT) shots, e.g. D/A/V.
    ct_order: Vec<OrderElem>,
    /// Measurement column order for rectangular (RECT) shots, e.g. E/N/U. Kept
    /// independent of `ct_order` (matching Walls/dewalls' separate ctOrder /
    /// rectOrder) so a CT↔RECT switch never clobbers the other type's order.
    rect_order: Vec<OrderElem>,
    d_unit: LengthUnit,
    s_unit: LengthUnit,
    a_unit: AngleUnit,
    ab_unit: AngleUnit,
    v_unit: AngleUnit,
    vb_unit: AngleUnit,
    /// Explicit `Decl=` declination, degrees. `None` means unset — an explicit
    /// `Decl=0` (`Some(0.0)`) suppresses auto-derivation, a bare `Decl=` clears
    /// back to `None`.
    decl: Option<f64>,
    /// `#Units Grid=` grid convergence (degrees), subtracted from CT azimuths.
    grid: f64,
    /// `#Units RECT=<azimuth>`: bearing of the rectangular frame's +N axis
    /// (degrees), added to RECT vector bearings. Kept separate from `grid` so a
    /// `RECT=<angle>` → `CT` switch can't leak the frame angle into CT
    /// convergence (they are consumed with opposite signs).
    rect: f64,
    incd: f64,
    inca: f64,
    incab: f64,
    incv: f64,
    incvb: f64,
    incs: f64,
    inch: f64,
    type_ab_corrected: bool,
    type_vb_corrected: bool,
    type_ab_no_avg: bool,
    type_vb_no_avg: bool,
    case: Case,
    lrud_type: LrudType,
    lrud_order: [char; 4],
    tape_from: TapeEnd,
    tape_to: TapeEnd,
    prefix: [Option<String>; 3],
    flag: Option<String>,
}

impl Default for WallsUnits {
    fn default() -> Self {
        Self {
            vector_type: VectorType::Ct,
            ct_order: vec![OrderElem::Dist, OrderElem::Azm, OrderElem::Inc],
            rect_order: vec![OrderElem::East, OrderElem::North, OrderElem::Up],
            d_unit: LengthUnit::Meters,
            s_unit: LengthUnit::Meters,
            a_unit: AngleUnit::Degrees,
            ab_unit: AngleUnit::Degrees,
            v_unit: AngleUnit::Degrees,
            vb_unit: AngleUnit::Degrees,
            decl: None,
            grid: 0.0,
            rect: 0.0,
            incd: 0.0,
            inca: 0.0,
            incab: 0.0,
            incv: 0.0,
            incvb: 0.0,
            incs: 0.0,
            inch: 0.0,
            type_ab_corrected: false,
            type_vb_corrected: false,
            type_ab_no_avg: false,
            type_vb_no_avg: false,
            case: Case::Mixed,
            lrud_type: LrudType::From,
            lrud_order: ['L', 'R', 'U', 'D'],
            tape_from: TapeEnd::Instrument,
            tape_to: TapeEnd::Target,
            prefix: [None, None, None],
            flag: None,
        }
    }
}

impl WallsUnits {
    /// The measurement column order active for the current vector type.
    fn active_order(&self) -> &[OrderElem] {
        match self.vector_type {
            VectorType::Ct => &self.ct_order,
            VectorType::Rect => &self.rect_order,
        }
    }

    /// True when this survey records dive depth-gauge data: compass-and-tape,
    /// station-to-station taping, distance+azimuth order with no inclination
    /// column (`#Units Order=DA Tape=SS`).
    fn is_depth_gauge(&self) -> bool {
        self.vector_type == VectorType::Ct
            && self.tape_from == TapeEnd::Station
            && self.tape_to == TapeEnd::Station
            && self.ct_order.contains(&OrderElem::Dist)
            && self.ct_order.contains(&OrderElem::Azm)
            && !self.ct_order.contains(&OrderElem::Inc)
    }
}

// ---------------------------------------------------------------------------
// Georeference (.REF / #Fix)
// ---------------------------------------------------------------------------

/// A `.WPJ` `.REF` geographic reference (UTM zone/datum + lat-long origin).
///
/// The importer anchors on `#Fix` stations / the lat-long fields rather than the
/// UTM origin offset, so the `.REF` northing/easting columns are validated but
/// not retained.
#[derive(Clone, Debug)]
struct WallsRef {
    zone: i32,
    convergence: f64,
    latitude: f64,
    longitude: f64,
    datum: String,
}

// ---------------------------------------------------------------------------
// Parsed representation
// ---------------------------------------------------------------------------

/// A single normalized survey vector (post units / fs-bs averaging).  Azimuths
/// are forward-direction magnetic degrees (declination/convergence applied at
/// conversion time); inclinations are `+up` degrees; depths are `+down` meters.
#[derive(Clone, Debug)]
struct WallsVector {
    from: String,
    to: String,
    length_m: f64,
    /// Forward azimuth from the foresight (or reversed backsight), degrees.
    azimuth_in: Option<f64>,
    /// Forward azimuth from the reversed backsight (or foresight), degrees.
    azimuth_out: Option<f64>,
    /// Averaged inclination, `+up` degrees (`None` for depth-gauge / plumb-omitted).
    inc_deg: Option<f64>,
    /// Foresight inclination as `+down` pitch (model convention).
    pitch_in: Option<f64>,
    /// Backsight inclination as `+down` pitch.
    pitch_out: Option<f64>,
    from_depth: Option<f64>,
    to_depth: Option<f64>,
    is_depth_gauge: bool,
    left: Option<f64>,
    right: Option<f64>,
    up: Option<f64>,
    down: Option<f64>,
    comment: Option<String>,
    is_reference: bool,
    /// FROM / TO stations were the anonymous wall marker (`-`); these endpoints
    /// must be given unique synthetic names so unrelated splays never merge.
    from_anon: bool,
    to_anon: bool,
    date: Option<NaiveDate>,
    /// Explicit declination (`Decl=`) in effect for this vector, degrees.
    /// `None` when no explicit `Decl=` was set (auto-derive may apply).
    units_decl: Option<f64>,
    /// `IncH=` vertical adjustment (meters) added to the vertical of non-plumb
    /// CT shots.
    inch: f64,
    grid_relative: bool,
    /// `#Units Grid=` grid convergence (degrees) to subtract from a CT vector's
    /// azimuth (true → grid north). `0.0` for RECT vectors, whose `RECT=<angle>`
    /// frame rotation is baked into the computed bearing instead.
    grid_convergence: f64,
    /// Auto-derive declination from `#Date` (`.STATUS` derive-declination flag).
    derive_decl: bool,
    /// True for `#Units RECT` E/N/U vectors: the azimuth is already an absolute
    /// grid bearing, so magnetic declination must NOT be applied at conversion
    /// (only convergence, governed by `grid_relative`, may rotate it).
    is_rect: bool,
    /// `#Units LRUD=To`: the LRUD on this leg was measured at the TO station, not
    /// the FROM station. In this shot-based model a station's passage rides on the
    /// shot that leaves it, so a To-typed leg's LRUD is shifted onto the next shot
    /// in the chain at conversion.
    lrud_is_to: bool,
}

/// A fixed station with known coordinates (`#Fix`).
#[derive(Clone, Debug)]
struct WallsFix {
    name: String,
    /// Resolved geographic position, when the `#Fix` gave lat/long (or could be
    /// projected via the inherited `.REF`).
    lat_long: Option<(f64, f64)>,
    /// Up coordinate (meters) if supplied — used to seed the station's depth.
    up: Option<f64>,
    /// True when `lat_long` came from projecting UTM E/N through the inherited
    /// `.REF` datum (rather than explicit lat/long). Lets the survey emit ONE
    /// aggregated "unrecognized datum" warning instead of one per fixed point
    /// (surface terrain files carry thousands of `#Fix` rows).
    projected_from_utm: bool,
}

/// A resolved + parsed survey leaf.
struct ParsedSurvey {
    title: String,
    name: String,
    segment: String,
    date: Option<NaiveDate>,
    surveyor: Option<String>,
    vectors: Vec<WallsVector>,
    fixes: Vec<WallsFix>,
    /// The `.REF` inherited by this survey (nearest ancestor) — drives grid
    /// convergence + auto-declination for its shots.
    georef: Option<WallsRef>,
    resolved: bool,
}

/// Fully parsed Walls project.
pub struct ParsedWalls {
    project_name: String,
    book_count: u32,
    surveys: Vec<ParsedSurvey>,
    georef: Option<WallsRef>,
    missing_files: Vec<String>,
    skipped_attachments: u32,
    warnings: Vec<String>,
}

// ---------------------------------------------------------------------------
// Encoding
// ---------------------------------------------------------------------------

/// Read a Walls file as ISO-8859-1/Latin-1 (Walls's encoding); decoding each
/// byte as a code point avoids panics on accented surveyor names and comments.
fn read_latin1(path: &Path) -> Result<String> {
    let bytes = std::fs::read(path).with_context(|| format!("reading {}", path.display()))?;
    Ok(bytes.iter().map(|&b| b as char).collect())
}

// ---------------------------------------------------------------------------
// Public entry points
// ---------------------------------------------------------------------------

/// Parse a Walls `.WPJ` project (following its survey links) or a single
/// `.SRV` survey file.
pub fn parse_walls(path: &Path) -> Result<ParsedWalls> {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .map(str::to_ascii_lowercase);
    match ext.as_deref() {
        Some("wpj") => parse_wpj(path),
        Some("srv") => parse_single_srv(path),
        _ => Err(anyhow!(
            "Unsupported Walls file '{}' (expected .wpj or .srv)",
            path.display()
        )),
    }
}

/// Parse a bare `.SRV` file as a one-survey project (no `.WPJ` tree).
fn parse_single_srv(path: &Path) -> Result<ParsedWalls> {
    let contents = read_latin1(path)?;
    let name = path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("survey")
        .to_string();
    let mut warnings = Vec::new();
    let survey = parse_srv_contents(
        &contents,
        &name,
        &name,
        "",
        &WallsUnits::default(),
        &HashMap::new(),
        None,
        true,  // grid-relative inherit -> default on; harmless with no georef
        false, // no auto-declination for a bare .srv (no georef/status)
        &mut warnings,
    );
    Ok(ParsedWalls {
        project_name: name,
        book_count: 0,
        surveys: vec![survey],
        georef: None,
        missing_files: Vec::new(),
        skipped_attachments: 0,
        warnings,
    })
}

// ---------------------------------------------------------------------------
// .WPJ parsing
// ---------------------------------------------------------------------------

/// One entry while walking the `.WPJ` tree.
#[derive(Clone)]
struct WpjEntry {
    is_book: bool,
    title: String,
    name: Option<String>,
    status: u32,
    options: Option<String>,
    path: Option<String>,
    reference: Option<WallsRef>,
}

/// Inherited context accumulated down the book tree.
#[derive(Clone)]
struct WpjContext {
    dir: PathBuf,
    /// Concatenated `#units`-option strings from root to here.
    options: Vec<String>,
    reference: Option<WallsRef>,
    segment: String,
    derive_decl: bool,
    grid_relative: bool,
}

fn parse_wpj(path: &Path) -> Result<ParsedWalls> {
    let contents = read_latin1(path)?;
    let root_dir = path.parent().map(Path::to_path_buf).unwrap_or_default();

    let mut warnings: Vec<String> = Vec::new();
    let mut surveys: Vec<ParsedSurvey> = Vec::new();
    let mut missing_files: Vec<String> = Vec::new();
    let mut skipped_attachments: u32 = 0;
    let mut book_count: u32 = 0;
    let mut project_name = String::new();
    let mut project_ref: Option<WallsRef> = None;

    // Stack of book contexts. The context on top of the stack is the
    // currently-open book's; its values are what children inherit.
    let mut stack: Vec<WpjContext> = Vec::new();
    // The entry currently being described by the property directives that
    // follow a `.BOOK`/`.SURVEY` line.
    let mut pending: Option<WpjEntry> = None;

    let root_context = WpjContext {
        dir: root_dir.clone(),
        options: Vec::new(),
        reference: None,
        segment: String::new(),
        derive_decl: false,
        // Root default matches dewalls `WpjEntry::gridRelative()` (false when no
        // ancestor sets a grid STATUS bit) and our own `derive_decl: false`
        // default above. A `true` default would silently rotate every CT azimuth
        // by the `.REF` grid convergence on a project that carries a `.REF` but
        // sets no grid-relative bit.
        grid_relative: false,
    };

    // Flush `pending` (a fully-described entry) into the tree: push books onto
    // the stack, resolve+parse surveys.
    macro_rules! flush_pending {
        () => {
            if let Some(entry) = pending.take() {
                let parent_ctx = stack
                    .last()
                    .cloned()
                    .unwrap_or_else(|| root_context.clone());
                let ctx = derive_context(&parent_ctx, &entry);
                if entry.is_book {
                    book_count += 1;
                    if project_name.is_empty() {
                        project_name = entry.title.clone();
                    }
                    if project_ref.is_none() {
                        if let Some(r) = &ctx.reference {
                            project_ref = Some(r.clone());
                        }
                    }
                    stack.push(ctx);
                } else {
                    // Survey leaf.
                    if entry.status & STATUS_DETACHED != 0 {
                        // Detached: skipped during compilation.
                    } else if entry.status & STATUS_TYPE_OTHER != 0 {
                        skipped_attachments += 1;
                    } else {
                        match resolve_survey(&entry, &ctx) {
                            Some(file_path) if file_path.exists() => {
                                match read_latin1(&file_path) {
                                    Ok(contents) => {
                                        let (initial, initial_macros) =
                                            build_initial_units(&ctx, &mut warnings);
                                        let name = entry
                                            .name
                                            .clone()
                                            .unwrap_or_else(|| entry.title.clone());
                                        let survey = parse_srv_contents(
                                            &contents,
                                            &entry.title,
                                            &name,
                                            &ctx.segment,
                                            &initial,
                                            &initial_macros,
                                            ctx.reference.clone(),
                                            ctx.grid_relative,
                                            ctx.derive_decl,
                                            &mut warnings,
                                        );
                                        surveys.push(survey);
                                    }
                                    Err(e) => {
                                        warnings.push(format!(
                                            "Could not read survey '{}': {e}",
                                            file_path.display()
                                        ));
                                    }
                                }
                            }
                            other => {
                                let shown =
                                    other.map(|p| p.display().to_string()).unwrap_or_else(|| {
                                        entry.name.clone().unwrap_or_else(|| entry.title.clone())
                                    });
                                missing_files.push(shown);
                                surveys.push(ParsedSurvey {
                                    title: entry.title.clone(),
                                    name: entry.name.clone().unwrap_or_else(|| entry.title.clone()),
                                    segment: ctx.segment.clone(),
                                    date: None,
                                    surveyor: None,
                                    vectors: Vec::new(),
                                    fixes: Vec::new(),
                                    georef: ctx.reference.clone(),
                                    resolved: false,
                                });
                            }
                        }
                    }
                }
            }
        };
    }

    for raw in contents.lines() {
        let line = raw.trim();
        if line.is_empty() || line.starts_with(';') {
            continue;
        }
        let (directive, rest) = split_first_token(line);
        let dir_up = directive.to_ascii_uppercase();
        match dir_up.as_str() {
            ".BOOK" => {
                flush_pending!();
                pending = Some(WpjEntry {
                    is_book: true,
                    title: rest.trim().to_string(),
                    name: None,
                    status: 0,
                    options: None,
                    path: None,
                    reference: None,
                });
            }
            ".SURVEY" => {
                flush_pending!();
                pending = Some(WpjEntry {
                    is_book: false,
                    title: rest.trim().to_string(),
                    name: None,
                    status: 0,
                    options: None,
                    path: None,
                    reference: None,
                });
            }
            ".ENDBOOK" => {
                flush_pending!();
                stack.pop();
            }
            ".NAME" => {
                if let Some(e) = pending.as_mut() {
                    e.name = Some(rest.trim().to_string());
                }
            }
            ".STATUS" => {
                if let Some(e) = pending.as_mut() {
                    let raw = rest.trim();
                    match raw.parse() {
                        Ok(status) => e.status = status,
                        // An unparseable .STATUS would otherwise default to 0,
                        // which clears the DETACHED/TYPE_OTHER bits and imports an
                        // entry the author excluded. Keep the default but surface it.
                        Err(_) => warnings.push(format!(
                            "Unparseable .STATUS '{raw}'; treating as 0 (entry may import unexpectedly)"
                        )),
                    }
                }
            }
            ".OPTIONS" => {
                if let Some(e) = pending.as_mut() {
                    e.options = Some(rest.trim().to_string());
                }
            }
            ".PATH" => {
                if let Some(e) = pending.as_mut() {
                    e.path = Some(rest.trim().to_string());
                }
            }
            ".REF" => {
                if let Some(e) = pending.as_mut() {
                    match parse_ref(rest.trim()) {
                        Ok(r) => e.reference = Some(r),
                        Err(msg) => warnings.push(format!("Ignoring malformed .REF: {msg}")),
                    }
                }
            }
            _ => {
                // Unknown directive — ignore.
            }
        }
    }
    flush_pending!();

    Ok(ParsedWalls {
        project_name,
        book_count,
        surveys,
        georef: project_ref,
        missing_files,
        skipped_attachments,
        warnings,
    })
}

/// Derive a child entry's inherited context from its parent's.
fn derive_context(parent: &WpjContext, entry: &WpjEntry) -> WpjContext {
    let mut ctx = parent.clone();
    // Resolve `.PATH`.
    if let Some(p) = &entry.path {
        ctx.dir = resolve_path(&parent.dir, p);
    }
    // Accumulate `.OPTIONS`.
    if let Some(opts) = &entry.options {
        if !opts.trim().is_empty() {
            ctx.options.push(opts.clone());
        }
    }
    // Nearest `.REF` wins. An entry that opts out of a reference (the
    // reference-unspecified status bit 6) and declares none of its own does
    // NOT inherit the ancestor reference.
    if let Some(r) = &entry.reference {
        ctx.reference = Some(r.clone());
    } else if entry.status & (1 << 6) != 0 {
        ctx.reference = None;
    }
    // Segment: an entry whose NAME_DEFINES_SEGMENT bit (3) is set contributes
    // its own name as a segment level — for surveys as well as books
    // (dewalls `WpjEntry::segment()` semantics).
    if let Some(name) = &entry.name {
        if !name.trim().is_empty() && entry.status & (1 << 3) != 0 {
            if ctx.segment.is_empty() {
                ctx.segment = name.trim().to_string();
            } else {
                ctx.segment = format!("{}/{}", ctx.segment, name.trim());
            }
        }
    }
    // Tristate derive-declination / grid-relative (off/on/inherit).
    if entry.status & STATUS_DERIVE_DECL != 0 {
        ctx.derive_decl = true;
    } else if entry.status & STATUS_DONT_DERIVE_DECL != 0 {
        ctx.derive_decl = false;
    }
    if entry.status & STATUS_GRID_RELATIVE != 0 {
        ctx.grid_relative = true;
    } else if entry.status & STATUS_NOT_GRID_RELATIVE != 0 {
        ctx.grid_relative = false;
    }
    ctx
}

/// Resolve a `.SURVEY` entry to its `.SRV` file path.
fn resolve_survey(entry: &WpjEntry, ctx: &WpjContext) -> Option<PathBuf> {
    let name = entry.name.as_ref()?;
    let name = name.trim();
    if name.is_empty() {
        return None;
    }
    // Only a `.SRV` suffix (case-insensitive) marks the name as already
    // extended; any OTHER trailing extension still gets `.SRV` appended
    // (dewalls/survex: a `.NAME FOO.OLD` resolves to `FOO.OLD.SRV`).
    let already_srv = name.to_ascii_lowercase().ends_with(".srv");
    let candidates: Vec<String> = if already_srv {
        vec![name.to_string()]
    } else {
        vec![format!("{name}.SRV"), format!("{name}.srv")]
    };
    for cand in &candidates {
        let p = ctx.dir.join(cand);
        if p.exists() {
            return Some(p);
        }
    }
    // Default to the first candidate even if missing (caller reports missing).
    Some(ctx.dir.join(&candidates[0]))
}

/// Resolve a `.PATH` against a parent directory (absolute replaces, relative
/// concatenates; backslashes normalized).
fn resolve_path(parent: &Path, path: &str) -> PathBuf {
    let normalized = path.replace('\\', "/");
    let candidate = Path::new(&normalized);
    if candidate.is_absolute() || normalized.contains(':') {
        // Absolute or drive-qualified Windows path — keep parent (these paths
        // rarely resolve on the import machine; survey files usually sit next
        // to the .wpj).
        parent.to_path_buf()
    } else {
        let mut dir = parent.to_path_buf();
        for part in normalized.split('/') {
            match part {
                "" | "." => {}
                ".." => {
                    dir.pop();
                }
                other => dir.push(other),
            }
        }
        dir
    }
}

/// Parse a `.REF` line: `northing easting zone conv elev flags latDMS lonDMS
/// datumIdx "datum"`.
fn parse_ref(line: &str) -> Result<WallsRef, String> {
    // Pull the trailing quoted datum name first.
    let (head, datum) = match line.rfind('"') {
        Some(end) => {
            let start = line[..end].rfind('"').ok_or("unterminated datum quote")?;
            let datum = line[start + 1..end].to_string();
            (line[..start].trim().to_string(), datum)
        }
        None => (line.trim().to_string(), String::new()),
    };
    let f: Vec<f64> = head
        .split_whitespace()
        .map(|t| t.parse::<f64>().unwrap_or(f64::NAN))
        .collect();
    if f.len() < 12 || f[..12].iter().any(|v| !v.is_finite()) {
        return Err(format!(
            "expected >=12 finite numeric fields, got {}",
            f.len()
        ));
    }
    // Fields: 0 N, 1 E, 2 zone, 3 convergence, 4 elev, 5 flags,
    // 6-8 lat d/m/s, 9-11 lon d/m/s, [12 datum index].
    // Validate the integer-coded fields BEFORE casting: an `f64 as i32/u32` cast
    // saturates (negative → 0, huge → MAX), which would silently flip the
    // hemisphere flags or pick the wrong UTM meridian. Reject out-of-range.
    let zone_raw = f[2];
    if zone_raw.fract() != 0.0 || !(1.0..=60.0).contains(&zone_raw.abs()) {
        return Err(format!("invalid UTM zone '{zone_raw}'"));
    }
    let flags_raw = f[5];
    if flags_raw.fract() != 0.0 || !(0.0..=65535.0).contains(&flags_raw) {
        return Err(format!("invalid .REF flags field '{flags_raw}'"));
    }
    let flags = flags_raw as u32;
    let lat = dms(f[6], f[7], f[8]) * if flags & 0x08 != 0 { -1.0 } else { 1.0 };
    let lon = dms(f[9], f[10], f[11]) * if flags & 0x04 != 0 { -1.0 } else { 1.0 };
    Ok(WallsRef {
        zone: zone_raw as i32,
        convergence: f[3],
        latitude: lat,
        longitude: lon,
        datum,
    })
}

fn dms(d: f64, m: f64, s: f64) -> f64 {
    let sign = if d < 0.0 { -1.0 } else { 1.0 };
    sign * (d.abs() + m / 60.0 + s / 3600.0)
}

/// Build the initial `#Units` state and macro table for a survey from inherited
/// `.OPTIONS`. Macros defined in a parent/book/survey `.OPTIONS` string (e.g.
/// `$cave=ABC`) must be visible to the child `.SRV` body, so they are returned
/// alongside the units rather than discarded — otherwise any `$(cave)` reference
/// in the survey fails to expand and those shots are silently dropped.
fn build_initial_units(
    ctx: &WpjContext,
    warnings: &mut Vec<String>,
) -> (WallsUnits, HashMap<String, String>) {
    let mut units = WallsUnits::default();
    let mut macros: HashMap<String, String> = HashMap::new();
    let mut stack: Vec<WallsUnits> = Vec::new();
    for opts in &ctx.options {
        apply_units_options(&mut units, opts, &mut stack, &mut macros, warnings);
    }
    (units, macros)
}

// ---------------------------------------------------------------------------
// .SRV parsing
// ---------------------------------------------------------------------------

/// Parse the contents of one `.SRV` file into normalized vectors.
fn parse_srv_contents(
    contents: &str,
    title: &str,
    name: &str,
    inherited_segment: &str,
    initial_units: &WallsUnits,
    initial_macros: &HashMap<String, String>,
    georef: Option<WallsRef>,
    grid_relative: bool,
    derive_decl: bool,
    warnings: &mut Vec<String>,
) -> ParsedSurvey {
    let mut units = initial_units.clone();
    let mut unit_stack: Vec<WallsUnits> = Vec::new();
    // Seed with macros inherited from the project/book/survey `.OPTIONS`; inline
    // `#units $name=value` directives add to this same table as parsing proceeds.
    let mut macros: HashMap<String, String> = initial_macros.clone();
    let mut segment = inherited_segment.to_string();
    let mut date: Option<NaiveDate> = None;
    let mut surveyor: Option<String> = None;
    let mut first_comment_seen = false;
    let mut block_comment_depth: u32 = 0;

    let mut vectors: Vec<WallsVector> = Vec::new();
    let mut fixes: Vec<WallsFix> = Vec::new();

    for (line_no, raw) in contents.lines().enumerate() {
        let line = raw.trim_end_matches(['\r', '\n']);
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        // Block comments (#[ ... #]).
        if trimmed.starts_with("#[") {
            block_comment_depth += 1;
            continue;
        }
        if trimmed.starts_with("#]") {
            block_comment_depth = block_comment_depth.saturating_sub(1);
            continue;
        }
        if block_comment_depth > 0 {
            continue;
        }
        // Whole-line comment.
        if trimmed.starts_with(';') {
            let body = trimmed[1..].trim();
            if !first_comment_seen && !body.is_empty() {
                first_comment_seen = true;
            }
            // Heuristic: capture a team/surveyor annotation.
            if surveyor.is_none() {
                if let Some(team) = extract_team(body) {
                    surveyor = Some(team);
                }
            }
            continue;
        }
        first_comment_seen = true;

        // Directive line.
        if trimmed.starts_with('#') {
            let expanded = match expand_macros(trimmed, &macros) {
                Ok(s) => s,
                Err(e) => {
                    warnings.push(format!("{name}:{}: {e}", line_no + 1));
                    continue;
                }
            };
            handle_directive(
                &expanded,
                &mut units,
                &mut unit_stack,
                &mut macros,
                &mut segment,
                &mut date,
                &georef,
                &mut fixes,
                name,
                line_no + 1,
                warnings,
            );
            continue;
        }

        // Vector / data line.
        let expanded = match expand_macros(trimmed, &macros) {
            Ok(s) => s,
            Err(e) => {
                warnings.push(format!("{name}:{}: {e}", line_no + 1));
                continue;
            }
        };
        if let Some(vec) = parse_vector_line(&expanded, &units, date, grid_relative, derive_decl) {
            vectors.push(vec);
        }
    }

    // If this survey projected any UTM `#Fix` through an unrecognized datum,
    // warn ONCE (the datum is a `.REF` property shared by every fix, so a
    // per-fix warning would repeat identically across thousands of rows).
    if let Some(r) = &georef {
        if !r.datum.trim().is_empty() && !datum_recognized(&r.datum) {
            let projected = fixes.iter().filter(|f| f.projected_from_utm).count();
            if projected > 0 {
                warnings.push(format!(
                    "{name}: datum '{}' is not recognized; {projected} fixed station(s) given \
                     as UTM coordinates were projected as WGS84 and may be off by tens of meters.",
                    r.datum
                ));
            }
        }
    }

    let survey_date = vectors.iter().find_map(|v| v.date).or(date);
    ParsedSurvey {
        title: title.to_string(),
        name: name.to_string(),
        segment,
        date: survey_date,
        surveyor,
        vectors,
        fixes,
        georef,
        // A parsed survey is resolved by construction; the unresolved
        // placeholder is built directly in `parse_wpj`.
        resolved: true,
    }
}

fn extract_team(comment: &str) -> Option<String> {
    let lower = comment.to_ascii_lowercase();
    for key in ["team:", "surveyors:", "surveyor:", "survey:"] {
        if let Some(pos) = lower.find(key) {
            let after = comment[pos + key.len()..].trim();
            if !after.is_empty() {
                return Some(after.to_string());
            }
        }
    }
    None
}

fn handle_directive(
    line: &str,
    units: &mut WallsUnits,
    unit_stack: &mut Vec<WallsUnits>,
    macros: &mut HashMap<String, String>,
    segment: &mut String,
    date: &mut Option<NaiveDate>,
    georef: &Option<WallsRef>,
    fixes: &mut Vec<WallsFix>,
    name: &str,
    line_no: usize,
    warnings: &mut Vec<String>,
) {
    let (directive, rest) = split_first_token(line);
    // Strip any trailing `;` comment from the directive arguments (quote-aware).
    // Walls allows an inline comment after a directive (e.g. `#Date 2008-12-01
    // ;TODO`); without this the date/segment/prefix value would carry the note.
    let rest = strip_inline_comment(rest);
    let key = directive.trim_start_matches('#').to_ascii_lowercase();
    match key.as_str() {
        "units" | "u" => {
            apply_units_options(units, rest, unit_stack, macros, warnings);
        }
        "date" => {
            let raw = rest.trim();
            match parse_walls_date(raw) {
                Some(parsed) => *date = Some(parsed),
                // A later malformed `#Date` must NOT clobber a previously-set
                // valid date — that would silently drop the survey date and
                // force 0° auto-declination for the shots that follow. Keep the
                // prior value and warn instead.
                None if !raw.is_empty() => {
                    warnings.push(format!("{name}:{line_no}: unrecognized #Date '{raw}'"));
                }
                None => {}
            }
        }
        "segment" | "seg" | "s" => {
            apply_segment(segment, rest.trim());
        }
        "prefix" | "prefix1" => set_prefix(units, 0, rest.trim()),
        "prefix2" => set_prefix(units, 1, rest.trim()),
        "prefix3" => set_prefix(units, 2, rest.trim()),
        "fix" => {
            if let Some(fix) = parse_fix(rest, units, georef) {
                fixes.push(fix);
            }
        }
        "flag" | "f" | "note" | "n" | "symbol" | "sym" => {
            // Parsed but not modeled (flags/notes/symbols don't affect geometry).
        }
        _ => {
            // Unknown directive — ignore.
        }
    }
}

/// Split a `#Units` argument string into tokens on whitespace, treating a
/// double-quoted span as a single token (the quotes are retained so `unquote`
/// can strip them later). Walls permits quoted values with embedded spaces —
/// e.g. `Flag="loose rock"`, `Prefix="A B"`, `$name="meters decl"` — which a
/// plain `split_whitespace` would tear across tokens, corrupting the value and
/// emitting spurious "unknown option" warnings.
fn split_units_args(args: &str) -> Vec<String> {
    let mut tokens = Vec::new();
    let mut current = String::new();
    let mut in_quotes = false;
    for ch in args.chars() {
        match ch {
            '"' => {
                in_quotes = !in_quotes;
                current.push(ch);
            }
            c if c.is_whitespace() && !in_quotes => {
                if !current.is_empty() {
                    tokens.push(std::mem::take(&mut current));
                }
            }
            c => current.push(c),
        }
    }
    if !current.is_empty() {
        tokens.push(current);
    }
    tokens
}

/// Apply a `#Units` argument string to the running units state.
fn apply_units_options(
    units: &mut WallsUnits,
    args: &str,
    unit_stack: &mut Vec<WallsUnits>,
    macros: &mut HashMap<String, String>,
    warnings: &mut Vec<String>,
) {
    // Drop an inline `;` comment and glue values back onto keys split by stray
    // spaces around `=` (`Order =DAV` -> `Order=DAV`) before tokenizing.
    let cleaned = collapse_eq_spaces(strip_inline_comment(args));
    for token in split_units_args(&cleaned) {
        if token.is_empty() {
            continue;
        }
        // Macro definition: $name or $name=value.
        if let Some(stripped) = token.strip_prefix('$') {
            let (mname, mval) = match stripped.split_once('=') {
                Some((k, v)) => (k.to_string(), unquote(v).to_string()),
                None => (stripped.to_string(), String::new()),
            };
            macros.insert(mname, mval);
            continue;
        }
        let (key, value) = match token.split_once('=') {
            Some((k, v)) => (k.to_ascii_lowercase(), Some(v)),
            None => (token.to_ascii_lowercase(), None),
        };
        // A token like `=DAV` (a leading `=`, from a stray space that
        // `collapse_eq_spaces` couldn't reattach) has no key — skip it silently
        // rather than warn "Unknown #units option ''".
        if key.is_empty() {
            continue;
        }
        apply_units_option(units, &key, value, unit_stack, warnings);
    }
}

/// Parse a numeric `#Units` correction argument. A bare/empty value resets the
/// correction to `0`; a non-empty value that fails to parse leaves the current
/// correction UNCHANGED and records a warning, rather than silently zeroing a
/// real instrument correction.
fn parse_correction(
    value: Option<&str>,
    current: f64,
    key: &str,
    warnings: &mut Vec<String>,
    parse: impl Fn(&str) -> Option<f64>,
) -> f64 {
    match value.map(str::trim).filter(|v| !v.is_empty()) {
        None => 0.0,
        Some(v) => match parse(v) {
            Some(x) => x,
            None => {
                warnings.push(format!(
                    "Unparseable #Units {key}='{v}'; correction left unchanged"
                ));
                current
            }
        },
    }
}

fn apply_units_option(
    units: &mut WallsUnits,
    key: &str,
    value: Option<&str>,
    unit_stack: &mut Vec<WallsUnits>,
    warnings: &mut Vec<String>,
) {
    match key {
        "reset" => {
            // RESET reverts units/calibration/prefixes to defaults (but not the
            // active segment, which lives outside WallsUnits).
            *units = WallsUnits::default();
        }
        "save" => {
            // Push current units (max depth 10, matching Walls).
            if unit_stack.len() < 10 {
                unit_stack.push(units.clone());
            }
        }
        "restore" => {
            if let Some(saved) = unit_stack.pop() {
                *units = saved;
            }
        }
        "meters" | "meter" | "m" => {
            units.d_unit = LengthUnit::Meters;
            units.s_unit = LengthUnit::Meters;
        }
        "feet" | "f" => {
            units.d_unit = LengthUnit::Feet;
            units.s_unit = LengthUnit::Feet;
        }
        // CT/RECT only flip the active vector type — the per-type column orders
        // (`ct_order` / `rect_order`) are independent and untouched, matching
        // dewalls. This is what lets a bare `#Units CT` after a `#Units RECT`
        // block read shots with the CT order again instead of dropping them.
        "ct" => units.vector_type = VectorType::Ct,
        "rect" => {
            // `Rect` switches to rectangular E/N/U vectors; `Rect=<azimuth>` sets
            // the bearing of the +N (Y) axis (the grid rotation applied to the
            // computed bearing at conversion). Either way the rectangular column
            // order lives in `rect_order`, not here.
            units.vector_type = VectorType::Rect;
            if let Some(v) = value {
                units.rect = parse_signed_angle(v).unwrap_or(units.rect);
            }
        }
        "order" | "o" => {
            if let Some(v) = value {
                match parse_order(v) {
                    // Route by the element letters, not the current vector type
                    // (dewalls `order()` -> ctOrder/rectOrder): E/N/U is a
                    // rectangular order, anything else (D/A/V) is compass-and-tape.
                    Some(order) => {
                        if order.iter().any(|e| {
                            matches!(e, OrderElem::East | OrderElem::North | OrderElem::Up)
                        }) {
                            units.rect_order = order;
                        } else {
                            units.ct_order = order;
                        }
                    }
                    None => warnings.push(format!(
                        "Ignoring unparseable #Units Order='{v}'; keeping the previous order"
                    )),
                }
            }
        }
        "d" => {
            if let Some(v) = value {
                units.d_unit = parse_length_unit(v).unwrap_or(units.d_unit);
            }
        }
        "s" => {
            if let Some(v) = value {
                units.s_unit = parse_length_unit(v).unwrap_or(units.s_unit);
            }
        }
        "a" => {
            if let Some(v) = value {
                let u = parse_angle_unit(v).unwrap_or(units.a_unit);
                units.a_unit = u;
            }
        }
        "ab" => {
            if let Some(v) = value {
                units.ab_unit = parse_angle_unit(v).unwrap_or(units.ab_unit);
            }
        }
        "a/ab" => {
            if let Some(v) = value {
                let u = parse_angle_unit(v).unwrap_or(units.a_unit);
                units.a_unit = u;
                units.ab_unit = u;
            }
        }
        "v" => {
            if let Some(v) = value {
                units.v_unit = parse_angle_unit_incl(v).unwrap_or(units.v_unit);
            }
        }
        "vb" => {
            if let Some(v) = value {
                units.vb_unit = parse_angle_unit_incl(v).unwrap_or(units.vb_unit);
            }
        }
        "v/vb" => {
            if let Some(v) = value {
                let u = parse_angle_unit_incl(v).unwrap_or(units.v_unit);
                units.v_unit = u;
                units.vb_unit = u;
            }
        }
        // `Decl=<angle>` sets an explicit declination — including an explicit
        // `Decl=0`, which declares the azimuths already true/grid and suppresses
        // auto-derivation. A bare `Decl=` / `Decl` clears it back to the default
        // (derive when the .STATUS flag is on).
        "decl" => match value.map(str::trim).filter(|v| !v.is_empty()) {
            None => units.decl = None,
            Some(v) => match parse_signed_angle(v) {
                Some(d) => units.decl = Some(d),
                // Do NOT fabricate an explicit `Decl=0` on a parse error: that
                // would wrongly suppress IGRF auto-derivation. Warn and keep the
                // current declination state instead.
                None => warnings.push(format!(
                    "Unparseable #Units Decl='{v}'; declination left unchanged"
                )),
            },
        },
        "grid" => {
            units.grid = parse_correction(value, units.grid, "Grid", warnings, parse_signed_angle);
        }
        "incd" => {
            let u = units.d_unit;
            units.incd =
                parse_correction(value, units.incd, "IncD", warnings, |v| parse_length(v, u));
        }
        // Azimuth/inclination corrections carry the current instrument's angle
        // unit (a bare `IncV=2` under `V=Grads` means 2 grads).
        "inca" => {
            let u = units.a_unit;
            units.inca =
                parse_correction(value, units.inca, "IncA", warnings, |v| parse_angle(v, u));
        }
        "incab" => {
            let u = units.ab_unit;
            units.incab =
                parse_correction(value, units.incab, "IncAB", warnings, |v| parse_angle(v, u));
        }
        "incv" => {
            let u = units.v_unit;
            units.incv =
                parse_correction(value, units.incv, "IncV", warnings, |v| parse_angle(v, u));
        }
        "incvb" => {
            let u = units.vb_unit;
            units.incvb =
                parse_correction(value, units.incvb, "IncVB", warnings, |v| parse_angle(v, u));
        }
        "incs" => {
            let u = units.s_unit;
            units.incs =
                parse_correction(value, units.incs, "IncS", warnings, |v| parse_length(v, u));
        }
        "inch" => {
            let u = units.d_unit;
            units.inch =
                parse_correction(value, units.inch, "IncH", warnings, |v| parse_length(v, u));
        }
        "typeab" => apply_type_backsight(
            value,
            &mut units.type_ab_corrected,
            &mut units.type_ab_no_avg,
        ),
        "typevb" => apply_type_backsight(
            value,
            &mut units.type_vb_corrected,
            &mut units.type_vb_no_avg,
        ),
        "case" => {
            units.case = match value.map(|v| v.chars().next().unwrap_or(' ').to_ascii_uppercase()) {
                Some('U') => Case::Upper,
                Some('L') => Case::Lower,
                _ => Case::Mixed,
            }
        }
        "lrud" => apply_lrud_option(units, value, warnings),
        "tape" => apply_tape_option(units, value, warnings),
        "prefix" | "prefix1" => set_prefix(units, 0, value.unwrap_or("")),
        "prefix2" => set_prefix(units, 1, value.unwrap_or("")),
        "prefix3" => set_prefix(units, 2, value.unwrap_or("")),
        "flag" => {
            units.flag = value
                .map(|v| unquote(v).to_string())
                .filter(|s| !s.is_empty());
        }
        "uvh" | "uvv" | "uv" => {
            // Variance scaling — not modeled (we don't carry per-shot variance).
        }
        _ => {
            warnings.push(format!("Unknown #units option '{key}'"));
        }
    }
}

fn apply_type_backsight(value: Option<&str>, corrected: &mut bool, no_avg: &mut bool) {
    *corrected = false;
    *no_avg = false;
    let Some(v) = value else { return };
    let mut parts = v.split(',');
    if let Some(kind) = parts.next() {
        if kind
            .chars()
            .next()
            .map(|c| c.eq_ignore_ascii_case(&'c'))
            .unwrap_or(false)
        {
            *corrected = true;
        }
    }
    // Skip tolerance; last part may be X (use foresight only).
    for p in parts {
        if p.eq_ignore_ascii_case("x") {
            *no_avg = true;
        }
    }
}

fn apply_lrud_option(units: &mut WallsUnits, value: Option<&str>, warnings: &mut Vec<String>) {
    let Some(v) = value else { return };
    let (kind, order) = match v.split_once(':') {
        Some((k, o)) => (k, Some(o)),
        None => (v, None),
    };
    units.lrud_type = match kind.chars().next().map(|c| c.to_ascii_uppercase()) {
        Some('T') => LrudType::To,
        _ => LrudType::From,
    };
    if let Some(o) = order {
        let chars: Vec<char> = o.chars().map(|c| c.to_ascii_uppercase()).collect();
        if chars.len() == 4 && chars.iter().all(|c| "LRUD".contains(*c)) {
            units.lrud_order = [chars[0], chars[1], chars[2], chars[3]];
        } else {
            warnings.push(format!(
                "Ignoring #Units LRUD order '{o}' (expected 4 of L, R, U, D); keeping LRUD"
            ));
        }
    }
}

fn apply_tape_option(units: &mut WallsUnits, value: Option<&str>, warnings: &mut Vec<String>) {
    let Some(v) = value else { return };
    let chars: Vec<char> = v.chars().map(|c| c.to_ascii_uppercase()).collect();
    let end = |c: char| match c {
        'I' => Some(TapeEnd::Instrument),
        'S' => Some(TapeEnd::Station),
        'T' => Some(TapeEnd::Target),
        _ => None,
    };
    match (
        chars.first().copied().and_then(end),
        chars.get(1).copied().and_then(end),
    ) {
        (Some(from), Some(to)) => {
            units.tape_from = from;
            units.tape_to = to;
        }
        _ => warnings.push(format!(
            "Ignoring #Units Tape='{v}' (expected two of I/S/T, e.g. Tape=SS)"
        )),
    }
}

fn set_prefix(units: &mut WallsUnits, level: usize, value: &str) {
    let v = unquote(value);
    units.prefix[level] = if v.trim().is_empty() {
        None
    } else {
        Some(v.trim().to_string())
    };
}

fn apply_segment(segment: &mut String, arg: &str) {
    let arg = arg.trim();
    if arg.is_empty() {
        return;
    }
    let normalized = arg.replace('\\', "/");
    if let Some(stripped) = normalized.strip_prefix('/') {
        *segment = stripped.to_string();
        return;
    }
    for part in normalized.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                if let Some(pos) = segment.rfind('/') {
                    segment.truncate(pos);
                } else {
                    segment.clear();
                }
            }
            other => {
                if segment.is_empty() {
                    *segment = other.to_string();
                } else {
                    segment.push('/');
                    segment.push_str(other);
                }
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Vector line parsing
// ---------------------------------------------------------------------------

fn parse_vector_line(
    line: &str,
    units: &WallsUnits,
    date: Option<NaiveDate>,
    grid_relative: bool,
    derive_decl: bool,
) -> Option<WallsVector> {
    // Split off the comment (everything after the first ';').
    let (body, comment) = match line.find(';') {
        Some(pos) => (&line[..pos], non_empty(&line[pos + 1..])),
        None => (line, None),
    };

    // Extract delimited LRUD / variance spans and the leftover token stream.
    let extracted = extract_spans(body);
    let tokens = extracted.tokens;
    if tokens.len() < 2 {
        // Lone-station LRUD lines (passage dimensions) and stray fragments —
        // skip silently (we can't attach a station-only LRUD to a shot).
        return None;
    }

    let from_raw = &tokens[0];
    let to_raw = &tokens[1];
    let from = normalize_station(from_raw, units);
    let to = normalize_station(to_raw, units);

    // Anonymous wall point (`-`/`--`/`---`): a splay reading, not a connected leg.
    let from_anon = is_anonymous(from_raw);
    let to_anon = is_anonymous(to_raw);

    let meas = &tokens[2..];
    let mut cursor = 0usize;

    let mut length_m: Option<f64> = None;
    let mut az: FsBs = FsBs::default();
    let mut inc: FsBs = FsBs::default();
    let mut east = 0.0;
    let mut north = 0.0;
    let mut up_rect = 0.0;

    for elem in units.active_order() {
        let tok = meas.get(cursor);
        cursor += 1;
        let Some(tok) = tok else { break };
        match elem {
            OrderElem::Dist => {
                length_m = parse_length(tok, units.d_unit);
            }
            OrderElem::Azm => {
                az = parse_fsbs(tok, units.a_unit, units.ab_unit);
            }
            OrderElem::Inc => {
                inc = parse_fsbs(tok, units.v_unit, units.vb_unit);
            }
            OrderElem::East => east = parse_length(tok, units.d_unit).unwrap_or(0.0),
            OrderElem::North => north = parse_length(tok, units.d_unit).unwrap_or(0.0),
            OrderElem::Up => up_rect = parse_length(tok, units.d_unit).unwrap_or(0.0),
        }
    }

    // RECT vector: convert E/N/U deltas to a CT-style vector.
    if units.vector_type == VectorType::Rect {
        let horiz = (east * east + north * north).sqrt();
        let length = (horiz * horiz + up_rect * up_rect).sqrt();
        if length <= 0.0 {
            return None;
        }
        // `#Units RECT=<angle>` rotates the rectangular E/N frame clockwise from
        // true north; apply it to the computed bearing here (declination is then
        // skipped at conversion, while `.REF`/`#Units Grid=` convergence still
        // applies). A pure-vertical RECT shot (E=N=0) has no defined bearing, so
        // leave the azimuth unset rather than recording a spurious 0° (due north).
        let azimuth_deg = if horiz < 1e-9 {
            None
        } else {
            Some((east.atan2(north).to_degrees() + units.rect).rem_euclid(360.0))
        };
        let inc_up = up_rect.atan2(horiz).to_degrees();
        return Some(WallsVector {
            from,
            to,
            length_m: length,
            azimuth_in: azimuth_deg,
            azimuth_out: azimuth_deg,
            inc_deg: Some(inc_up),
            pitch_in: Some(-inc_up),
            pitch_out: None,
            from_depth: None,
            to_depth: None,
            is_depth_gauge: false,
            left: None,
            right: None,
            up: None,
            down: None,
            comment,
            is_reference: from_anon || to_anon,
            from_anon,
            to_anon,
            date,
            units_decl: units.decl,
            inch: 0.0,
            grid_relative,
            // `#Units Grid=` convergence rotates true→grid north for ALL vectors,
            // CT and RECT alike; the RECT frame angle (`units.rect`) is a separate
            // rotation already baked into the bearing above.
            grid_convergence: units.grid,
            derive_decl,
            is_rect: true,
            lrud_is_to: units.lrud_type == LrudType::To,
        });
    }

    let is_dive = units.is_depth_gauge();
    let mut from_depth = None;
    let mut to_depth = None;
    if is_dive {
        // Two trailing depth columns (station depths below surface).
        if let Some(tok) = meas.get(cursor) {
            from_depth = parse_depth(tok, units.s_unit);
            cursor += 1;
        }
        if let Some(tok) = meas.get(cursor) {
            to_depth = parse_depth(tok, units.s_unit);
        }
    }

    // Apply the `IncD=` distance correction only when a NON-ZERO distance was
    // given — genuine Walls guards this as `if (u->incD != 0.0 && d != 0.0)`
    // (`wall-srv.cpp`). Adding IncD to an exact-`0` leg would turn a deliberate
    // coincident-station tie (`A B 0 …`) into a spurious IncD-long shot.
    let length_m = length_m
        .map(|d| if d != 0.0 { d + units.incd } else { 0.0 })
        .unwrap_or(0.0);

    // Combine foresight/backsight azimuth into two forward readings.
    let (azimuth_in, azimuth_out) = combine_azimuth(&az, units);
    // Combine inclination.
    let (inc_deg, pitch_in, pitch_out) = if is_dive {
        (None, None, None)
    } else {
        combine_inclination(&inc, units)
    };

    // LRUD.
    let (left, right, up, down) = extracted
        .lrud
        .as_deref()
        .map(|l| parse_lrud(l, units))
        .unwrap_or((None, None, None, None));

    // A floated/`(?)` variance is a network-adjustment hint on a REAL measured
    // leg — it does not make the shot a splay, so it must not be dropped by the
    // splay filter. Only anonymous (`-`/`--`) wall endpoints are splays.
    let is_reference = from_anon || to_anon;

    // Pure station-equate (no distance, no depth, no bearing) — skip. A
    // zero-length leg that still carries a bearing (fore- OR back-sight) is a
    // coincident-station tie worth keeping, matching `is_importable_shot`.
    if length_m <= 0.0
        && from_depth.is_none()
        && to_depth.is_none()
        && az.fs.is_none()
        && az.bs.is_none()
    {
        if left.is_none() && right.is_none() && up.is_none() && down.is_none() {
            return None;
        }
    }

    Some(WallsVector {
        from,
        to,
        length_m,
        azimuth_in,
        azimuth_out,
        inc_deg,
        pitch_in,
        pitch_out,
        from_depth,
        to_depth,
        is_depth_gauge: is_dive,
        left,
        right,
        up,
        down,
        comment,
        is_reference,
        from_anon,
        to_anon,
        date,
        units_decl: units.decl,
        // IncH only adjusts the vertical of non-plumb CT shots; dive shots take
        // their vertical from the depth gauges, so it never applies there.
        inch: if is_dive { 0.0 } else { units.inch },
        grid_relative,
        // `#Units Grid=` convergence applies to CT azimuths (dive shots take it
        // too); RECT vectors apply it the same way on top of their frame rotation.
        grid_convergence: units.grid,
        derive_decl,
        is_rect: false,
        lrud_is_to: units.lrud_type == LrudType::To,
    })
}

#[derive(Default)]
struct FsBs {
    fs: Option<f64>,
    bs: Option<f64>,
}

struct ExtractedSpans {
    tokens: Vec<String>,
    lrud: Option<String>,
}

/// True when `close` occurs at or after `start` in `chars` AND that closer is at
/// end-of-body or immediately followed by whitespace — i.e. a *properly
/// terminated* span. Returns the closer's index. Genuine Walls only treats a
/// token-initial `<`/`*` as an LRUD when the matching `>`/`*` is followed by
/// whitespace or end-of-line (`wall-srv.cpp`: `!pNote[1] || isspace(pNote[1])`);
/// otherwise the delimiter is part of a station name.
fn find_span_end(chars: &[char], start: usize, close: char) -> Option<usize> {
    (start..chars.len())
        .find(|&j| chars[j] == close && chars.get(j + 1).is_none_or(|c| c.is_whitespace()))
}

/// Walk a vector line body, pulling out `<...>`/`*...*` (LRUD) and `(...)`
/// (variance) delimited spans, returning the remaining whitespace tokens.
fn extract_spans(body: &str) -> ExtractedSpans {
    let chars: Vec<char> = body.chars().collect();
    let mut tokens: Vec<String> = Vec::new();
    let mut current = String::new();
    let mut lrud: Option<String> = None;
    let mut i = 0;

    let flush = |current: &mut String, tokens: &mut Vec<String>| {
        if !current.is_empty() {
            tokens.push(std::mem::take(current));
        }
    };

    while i < chars.len() {
        let c = chars[i];
        match c {
            c if c.is_whitespace() => flush(&mut current, &mut tokens),
            '#' => {
                // Inline directive (segment) — stop collecting measurement
                // tokens; the rest of the line doesn't carry geometry.
                flush(&mut current, &mut tokens);
                break;
            }
            // LRUD/variance delimiters open a span ONLY at a token boundary
            // (`current` empty) AND only when properly terminated (closer at
            // end-of-body or before whitespace). Walls lays a shot out as
            // whitespace-separated fields `from to <measures…> [lrud] [(var)]`,
            // so a delimiter glued inside a token — e.g. the literal `*` in
            // `W-*/2/46` — or an UNTERMINATED `<`/`*` — e.g. a station named
            // `*8` — is a literal name character, not a span. Without this a
            // mid-name `*` tore `W-*/2/46 W-*/2/50` into a phantom `W-` hub, and
            // an unterminated `*8` swallowed the rest of the line as a bogus LRUD.
            '<' | '*' if current.is_empty() => {
                let close = if c == '<' { '>' } else { '*' };
                if let Some(end) = find_span_end(&chars, i + 1, close) {
                    lrud = Some(chars[i + 1..end].iter().collect());
                    i = end + 1;
                    continue;
                }
                current.push(c); // unterminated → literal name character
            }
            '(' if current.is_empty() => {
                // Variance override `(...)` — consume through the first `)` (or
                // to end of body if unterminated) and discard. We don't model
                // per-shot variance, and a floated `(?)` does NOT turn a real
                // measured leg into a splay.
                i = (i + 1..chars.len())
                    .find(|&j| chars[j] == ')')
                    .map_or(chars.len(), |e| e + 1);
                continue;
            }
            other => current.push(other),
        }
        i += 1;
    }
    flush(&mut current, &mut tokens);

    ExtractedSpans { tokens, lrud }
}

/// Combine an azimuth fs/bs pair into two forward-direction degree readings.
fn combine_azimuth(az: &FsBs, units: &WallsUnits) -> (Option<f64>, Option<f64>) {
    let fs = az.fs.map(|v| (v + units.inca).rem_euclid(360.0));
    let bs_forward = az.bs.map(|v| {
        let corrected = v + units.incab;
        if units.type_ab_corrected {
            corrected.rem_euclid(360.0)
        } else {
            (corrected + 180.0).rem_euclid(360.0)
        }
    });
    if units.type_ab_no_avg {
        // Use foresight only.
        return (fs.or(bs_forward), fs.or(bs_forward));
    }
    match (fs, bs_forward) {
        (Some(f), Some(b)) => (Some(f), Some(b)),
        (Some(f), None) => (Some(f), Some(f)),
        (None, Some(b)) => (Some(b), Some(b)),
        (None, None) => (None, None),
    }
}

/// Combine an inclination fs/bs pair: returns (avg `+up` deg, pitch_in `+down`,
/// pitch_out `+down`).
fn combine_inclination(inc: &FsBs, units: &WallsUnits) -> (Option<f64>, Option<f64>, Option<f64>) {
    let fs = inc.fs.map(|v| v + units.incv);
    let bs_forward = inc.bs.map(|v| {
        let corrected = v + units.incvb;
        if units.type_vb_corrected {
            corrected
        } else {
            -corrected
        }
    });
    if units.type_vb_no_avg {
        let chosen = fs.or(bs_forward);
        return (chosen, chosen.map(|v| -v), None);
    }
    match (fs, bs_forward) {
        (Some(f), Some(b)) => (Some((f + b) / 2.0), Some(-f), Some(-b)),
        (Some(f), None) => (Some(f), Some(-f), None),
        (None, Some(b)) => (Some(b), Some(-b), None),
        (None, None) => (None, None, None),
    }
}

fn parse_lrud(
    span: &str,
    units: &WallsUnits,
) -> (Option<f64>, Option<f64>, Option<f64>, Option<f64>) {
    let parts: Vec<&str> = span
        .split(|c: char| c == ',' || c.is_whitespace())
        .filter(|s| !s.is_empty())
        .collect();
    let mut vals: [Option<f64>; 4] = [None; 4];
    for (i, slot) in units.lrud_order.iter().enumerate() {
        let Some(tok) = parts.get(i) else { break };
        if is_omitted(tok) {
            continue;
        }
        // Trailing facing/C-flag tokens are ignored (positions >= 4).
        // IncS= corrects the "short" measurements (LRUDs + inst/target heights).
        let v = parse_length(tok, units.s_unit).map(|x| x + units.incs);
        let idx = match slot {
            'L' => 0,
            'R' => 1,
            'U' => 2,
            'D' => 3,
            _ => continue,
        };
        vals[idx] = v.filter(|x| *x >= 0.0);
    }
    (vals[0], vals[1], vals[2], vals[3])
}

// ---------------------------------------------------------------------------
// #Fix parsing
// ---------------------------------------------------------------------------

fn parse_fix(rest: &str, units: &WallsUnits, georef: &Option<WallsRef>) -> Option<WallsFix> {
    // #Fix <name> <E> <N> <U> [(var)] [/note] [#seg]
    // Strip a trailing `;` comment before tokenizing (the vector path does the
    // same); otherwise `467427 2258942;datum` swallows the northing token.
    let body = match rest.find(';') {
        Some(pos) => &rest[..pos],
        None => rest,
    };
    let extracted = extract_spans(body);
    let tokens = extracted.tokens;
    if tokens.is_empty() {
        return None;
    }
    let name = normalize_station(&tokens[0], units);
    let coords = &tokens[1..];
    // `#Fix` columns are E/N/U coordinates, independent of the vector
    // measurement order (a dive survey's CT `Order=DA` must NOT truncate the
    // elevation column). The rectangular `rect_order` is exactly that — an
    // explicit `Order=ENU…` if one was set, otherwise the E/N/U default. Each
    // column is a length or an N/S/E/W-prefixed geographic angle.
    let coord_order: &[OrderElem] = &units.rect_order;
    let mut east_val: Option<f64> = None;
    let mut north_val: Option<f64> = None;
    let mut up_val: Option<f64> = None;
    let mut lat: Option<f64> = None;
    let mut lon: Option<f64> = None;
    let mut idx = 0usize;
    for elem in coord_order {
        let Some(tok) = coords.get(idx) else { break };
        idx += 1;
        match elem {
            OrderElem::East | OrderElem::Dist => {
                // Place a geographic coordinate by the N/S/E/W prefix it carries,
                // not by the column, so a fix written latitude-first still
                // resolves correctly. A plain number is a UTM easting.
                if let Some((axis, geo)) = parse_geo_coord(tok) {
                    match axis {
                        GeoAxis::Lat => lat = Some(geo),
                        GeoAxis::Lon => lon = Some(geo),
                    }
                } else {
                    east_val = parse_length(tok, units.d_unit);
                }
            }
            OrderElem::North | OrderElem::Azm => {
                if let Some((axis, geo)) = parse_geo_coord(tok) {
                    match axis {
                        GeoAxis::Lat => lat = Some(geo),
                        GeoAxis::Lon => lon = Some(geo),
                    }
                } else {
                    north_val = parse_length(tok, units.d_unit);
                }
            }
            OrderElem::Up | OrderElem::Inc => {
                up_val = parse_length(tok, units.d_unit);
            }
        }
    }

    // The datum a UTM fix projects under is a property of the inherited `.REF`,
    // not of the individual fix, so any "unrecognized datum" warning is emitted
    // ONCE per survey (see `parse_srv_contents`) rather than here — otherwise a
    // surface file's thousands of `#Fix` rows each repeat the same message.
    let mut projected_from_utm = false;
    let lat_long = match (lat, lon) {
        (Some(la), Some(lo)) => Some((la, lo)),
        _ => match (east_val, north_val, georef) {
            (Some(e), Some(n), Some(r)) => {
                let projected = utm_to_wgs84(e, n, r.zone, &r.datum);
                projected_from_utm = projected.is_some();
                projected
            }
            _ => None,
        },
    };

    Some(WallsFix {
        name,
        lat_long,
        up: up_val,
        projected_from_utm,
    })
}

/// Which geographic axis an `N/S/E/W`-prefixed `#Fix` coordinate names.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum GeoAxis {
    Lat,
    Lon,
}

/// Parse a geographic coordinate token like `W97:43:52.5` / `N31:16:45`,
/// returning the axis (lat/long) named by the prefix so the caller can place it
/// correctly regardless of column order.
fn parse_geo_coord(tok: &str) -> Option<(GeoAxis, f64)> {
    let first = tok.chars().next()?;
    let (axis, sign) = match first.to_ascii_uppercase() {
        'N' => (GeoAxis::Lat, 1.0),
        'S' => (GeoAxis::Lat, -1.0),
        'E' => (GeoAxis::Lon, 1.0),
        'W' => (GeoAxis::Lon, -1.0),
        _ => return None,
    };
    // The matched prefix is ASCII, so byte index 1 is a char boundary even for
    // Latin-1-decoded (multibyte) text.
    let deg = parse_dms(&tok[1..])?;
    Some((axis, sign * deg.abs()))
}

// ---------------------------------------------------------------------------
// Numeric token parsers
// ---------------------------------------------------------------------------

fn is_omitted(tok: &str) -> bool {
    tok.len() >= 2 && tok.chars().all(|c| c == '-')
}

/// A from/to station of exactly one or two dashes (`-` or `--`) is an anonymous
/// wall/splay endpoint, not a real named station — matching genuine Walls'
/// `name_isnull` (`wall-srv.cpp`: `*p=='-'` and the next char is a space, or
/// `--` then a space). Three-or-more dashes (`---`, `----`) are NOT null in
/// Walls: they are stored as a real station name, so we must keep them too.
/// (dewalls' `optionalStationRx = "-+"` treats any dash run as anonymous, which
/// is the reverse-engineering being broader than McKenzie's source.) Each
/// anonymous endpoint is later given a globally-unique synthetic name so
/// unrelated splays never collapse onto a single phantom `--` node.
fn is_anonymous(tok: &str) -> bool {
    matches!(tok, "-" | "--")
}

fn unquote(s: &str) -> &str {
    let s = s.trim();
    s.strip_prefix('"')
        .and_then(|x| x.strip_suffix('"'))
        .unwrap_or(s)
}

fn split_first_token(line: &str) -> (&str, &str) {
    let trimmed = line.trim_start();
    match trimmed.find(char::is_whitespace) {
        Some(pos) => (&trimmed[..pos], trimmed[pos..].trim_start()),
        None => (trimmed, ""),
    }
}

/// Strip a trailing `;` line-comment from a directive argument, honoring
/// double-quoted spans so a quoted value containing `;` is preserved. Walls
/// treats `;` as a comment start anywhere outside quotes, so e.g.
/// `#Date 2008-12-01 ;TODO` and `#Date 2000-06-06; oraz 2000-06-30` carry the
/// date plus a trailing note — without stripping, the date fails to parse.
fn strip_inline_comment(s: &str) -> &str {
    let mut in_quotes = false;
    for (i, c) in s.char_indices() {
        match c {
            '"' => in_quotes = !in_quotes,
            ';' if !in_quotes => return &s[..i],
            _ => {}
        }
    }
    s
}

/// Collapse whitespace immediately around `=` (outside quotes) in a `#Units`
/// argument string, so a hand-edited `Order = DAV` / `Order =DAV` / `Order= DAV`
/// is read as `Order=DAV`. Walls keys bind tightly to `=`; stray spaces would
/// otherwise split the value into its own token and emit spurious
/// "unknown option" / empty-option warnings.
fn collapse_eq_spaces(args: &str) -> String {
    let mut out = String::with_capacity(args.len());
    let mut in_quotes = false;
    let mut chars = args.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '"' => {
                in_quotes = !in_quotes;
                out.push(c);
            }
            '=' if !in_quotes => {
                while out.ends_with([' ', '\t']) {
                    out.pop();
                }
                out.push('=');
                while matches!(chars.peek(), Some(' ' | '\t')) {
                    chars.next();
                }
            }
            _ => out.push(c),
        }
    }
    out
}

fn split_unit_suffix<'a>(t: &'a str, suffixes: &[char]) -> (&'a str, Option<char>) {
    if let Some(last) = t.chars().last() {
        if suffixes.contains(&last) {
            return (
                &t[..t.len() - last.len_utf8()],
                Some(last.to_ascii_lowercase()),
            );
        }
    }
    (t, None)
}

fn parse_length_unit(v: &str) -> Option<LengthUnit> {
    match v.chars().next()?.to_ascii_uppercase() {
        'M' => Some(LengthUnit::Meters),
        'F' => Some(LengthUnit::Feet),
        _ => None,
    }
}

fn parse_angle_unit(v: &str) -> Option<AngleUnit> {
    match v.chars().next()?.to_ascii_uppercase() {
        'D' => Some(AngleUnit::Degrees),
        'G' => Some(AngleUnit::Grads),
        'M' => Some(AngleUnit::Mils),
        _ => None,
    }
}

fn parse_angle_unit_incl(v: &str) -> Option<AngleUnit> {
    match v.chars().next()?.to_ascii_uppercase() {
        'D' => Some(AngleUnit::Degrees),
        'G' => Some(AngleUnit::Grads),
        'M' => Some(AngleUnit::Mils),
        'P' => Some(AngleUnit::Percent),
        _ => None,
    }
}

fn parse_order(v: &str) -> Option<Vec<OrderElem>> {
    let mut order = Vec::new();
    for c in v.chars() {
        let elem = match c.to_ascii_uppercase() {
            'D' => OrderElem::Dist,
            'A' => OrderElem::Azm,
            'V' => OrderElem::Inc,
            'E' => OrderElem::East,
            'N' => OrderElem::North,
            'U' => OrderElem::Up,
            _ => return None,
        };
        order.push(elem);
    }
    if order.is_empty() {
        None
    } else {
        Some(order)
    }
}

fn parse_signed_angle(v: &str) -> Option<f64> {
    parse_angle(v, AngleUnit::Degrees)
}

/// Parse a length token (with optional `m`/`f`/`i` suffix or feet-inches form)
/// into meters.
fn parse_length(tok: &str, default: LengthUnit) -> Option<f64> {
    let t = tok.trim();
    if t.is_empty() || is_omitted(t) {
        return None;
    }
    // Feet-and-inches: `<ft>i<in>`, `<ft>i`, or `i<in>` — 'i' separates feet
    // from inches. (Measurement columns are numeric, so a lone 'i' only ever
    // appears in this notation or in junk like "inf", which fails to parse.)
    let lower = t.to_ascii_lowercase();
    if let Some(ipos) = lower.find('i') {
        let fpart = &t[..ipos];
        let inches_str = &t[ipos + 1..];
        if fpart.is_empty() && inches_str.is_empty() {
            return None; // bare "i" is not a measurement
        }
        let feet: f64 = if fpart.is_empty() {
            0.0
        } else {
            fpart.parse().ok()?
        };
        let inches: f64 = if inches_str.is_empty() {
            0.0
        } else {
            inches_str.parse().ok()?
        };
        // A leading '-' applies to the whole feet-and-inches measurement, so
        // the inches must inherit the feet token's sign (`-2i6` = −2 ft 6 in,
        // `-0i7` = −7 in). Adding `inches` with a fixed positive sign would
        // flip `-0iN` and under-count `-FiI`.
        let sign = if t.starts_with('-') { -1.0 } else { 1.0 };
        let m = sign * (feet.abs() + inches / 12.0) * FEET_TO_METERS;
        return m.is_finite().then_some(m);
    }
    let (num_str, unit) = split_unit_suffix(t, &['m', 'M', 'f', 'F']);
    let v: f64 = num_str.parse().ok()?;
    if !v.is_finite() {
        return None; // reject NaN / inf / overflow literals
    }
    let u = match unit {
        Some('m') => LengthUnit::Meters,
        Some('f') => LengthUnit::Feet,
        _ => default,
    };
    Some(v * u.factor())
}

/// Parse a depth gauge reading (positive = below surface) into meters.
fn parse_depth(tok: &str, default: LengthUnit) -> Option<f64> {
    if is_omitted(tok) {
        return None;
    }
    parse_length(tok, default)
}

/// Parse a Walls quadrant bearing (`N79E`, `S30W`, `N12:30E`) into an absolute
/// azimuth in degrees. The magnitude is measured off the N/S meridian toward
/// E/W and carries the azimuth `unit`. Returns `None` for non-quadrant tokens.
fn parse_quadrant(t: &str, unit: AngleUnit) -> Option<f64> {
    let first = t.chars().next()?.to_ascii_uppercase();
    let last = t.chars().next_back()?.to_ascii_uppercase();
    if !matches!(first, 'N' | 'S') || !matches!(last, 'E' | 'W') {
        return None;
    }
    // N/S/E/W are single-byte ASCII, so trimming the ends by byte index is safe.
    let mid = t[1..t.len() - 1].trim();
    if mid.is_empty() {
        return None;
    }
    let mag = if mid.contains(':') {
        parse_dms(mid)?
    } else {
        unit.to_degrees(mid.parse::<f64>().ok()?)
    };
    if !mag.is_finite() {
        return None;
    }
    let az = match (first, last) {
        ('N', 'E') => mag,
        ('N', 'W') => 360.0 - mag,
        ('S', 'E') => 180.0 - mag,
        ('S', 'W') => 180.0 + mag,
        _ => return None,
    };
    Some(az.rem_euclid(360.0))
}

/// Parse an angle token (degrees) with optional `d`/`g`/`m`/`p` suffix, a
/// quadrant bearing, or `D:M:S` form.
fn parse_angle(tok: &str, default: AngleUnit) -> Option<f64> {
    let t = tok.trim();
    if t.is_empty() || is_omitted(t) {
        return None;
    }
    // Quadrant bearings (`N79E`) must be tried before the `:` / numeric paths
    // so `N12:30E` isn't misread as a bare D:M:S value.
    if let Some(az) = parse_quadrant(t, default) {
        return Some(az);
    }
    if t.contains(':') {
        return parse_dms(t);
    }
    let (num_str, unit) = split_unit_suffix(t, &['d', 'D', 'g', 'G', 'm', 'M', 'p', 'P']);
    let v: f64 = num_str.parse().ok()?;
    if !v.is_finite() {
        return None; // reject NaN / inf / overflow literals
    }
    let u = match unit {
        Some('d') => AngleUnit::Degrees,
        Some('g') => AngleUnit::Grads,
        Some('m') => AngleUnit::Mils,
        Some('p') => AngleUnit::Percent,
        _ => default,
    };
    let deg = u.to_degrees(v);
    deg.is_finite().then_some(deg)
}

/// Parse a `D:M:S` / `D:M` / `D` angle into decimal degrees.
fn parse_dms(t: &str) -> Option<f64> {
    let neg = t.starts_with('-');
    let body = t.trim_start_matches(['-', '+']);
    let mut parts = body.split(':');
    let d: f64 = parts.next()?.trim().parse().ok()?;
    let m: f64 = match parts.next() {
        Some(s) if !s.is_empty() => s.trim().parse().ok()?,
        _ => 0.0,
    };
    let s: f64 = match parts.next() {
        Some(x) if !x.is_empty() => x.trim().parse().ok()?,
        _ => 0.0,
    };
    if !d.is_finite() || !m.is_finite() || !s.is_finite() {
        return None;
    }
    // `body` is sign-stripped, so `dms` sees non-negative degrees and returns the
    // magnitude; apply the leading-sign here. Shares the one D:M:S formula.
    let val = dms(d, m, s);
    Some(if neg { -val } else { val })
}

fn parse_fsbs(tok: &str, fs_unit: AngleUnit, bs_unit: AngleUnit) -> FsBs {
    match tok.split_once('/') {
        Some((l, r)) => FsBs {
            fs: if l.is_empty() || is_omitted(l) {
                None
            } else {
                parse_angle(l, fs_unit)
            },
            bs: if r.is_empty() || is_omitted(r) {
                None
            } else {
                parse_angle(r, bs_unit)
            },
        },
        None => FsBs {
            fs: if is_omitted(tok) {
                None
            } else {
                parse_angle(tok, fs_unit)
            },
            bs: None,
        },
    }
}

fn parse_walls_date(s: &str) -> Option<NaiveDate> {
    let s = s.trim();
    if s.is_empty() {
        return None;
    }
    // Walls writes ISO `YYYY-MM-DD` (and `/`) plus US `MM-DD-YYYY` and 2-digit
    // `MM-DD-YY`. chrono's `%Y` greedily matches a 2-digit leading field, so the
    // ISO formats can NOT be tried first: `05/07/17` (May 7 2017) would wrongly
    // parse as year 0005. Disambiguate by field widths: a 4-digit FIRST field is
    // year-first (ISO); otherwise it is month-first, and a 4- vs 2-digit LAST
    // field selects `%Y` vs `%y` (chrono maps `%y` 00–69 → 2000–2069, 70–99 →
    // 1970–1999).
    let parts: Vec<&str> = s.split(['-', '/']).map(str::trim).collect();
    let first_len = parts.first().map_or(0, |f| f.len());
    let last_len = parts.last().map_or(0, |f| f.len());
    if first_len == 4 || last_len == 4 {
        let formats: &[&str] = if first_len == 4 {
            &["%Y-%m-%d", "%Y/%m/%d"]
        } else {
            &["%m-%d-%Y", "%m/%d/%Y"]
        };
        for fmt in formats {
            if let Ok(d) = NaiveDate::parse_from_str(s, fmt) {
                return Some(d);
            }
        }
        return None;
    }
    // 2-digit year. Genuine Walls maps EVERY 2-digit year into 1900–1999 with no
    // pivot — `if (y < 100) y += 1900;` in `wall-srv.cpp` `ParseDate`. We mirror
    // that exactly so the date (and any IGRF auto-declination Walls derived from
    // it) reproduces Walls' own interpretation. chrono's `%y` pivots 00–69 →
    // 2000s, so roll any 2000s result back a century. (This also keeps a 1960s
    // legacy survey, e.g. `64` → 1964, inside the IGRF range. Trade-off: a survey
    // actually done in 2025 but written `…-25` reads as 1925 — exactly as Walls
    // reads it; Walls itself warns that `yyyy-mm-dd` is preferred.)
    for fmt in &["%m-%d-%y", "%m/%d/%y"] {
        if let Ok(d) = NaiveDate::parse_from_str(s, fmt) {
            return Some(if d.year() >= 2000 {
                d.with_year(d.year() - 100).unwrap_or(d)
            } else {
                d
            });
        }
    }
    None
}

/// Normalize a station name: apply `Case=` folding and prefix levels.
fn normalize_station(raw: &str, units: &WallsUnits) -> String {
    let cased = match units.case {
        Case::Upper => raw.to_uppercase(),
        Case::Lower => raw.to_lowercase(),
        Case::Mixed => raw.to_string(),
    };
    // Combine the entered name with the active prefix levels exactly as Walls
    // does (dewalls `WallsUnits::processStationName`): the count of explicit
    // `:`-separated segments already typed suppresses that many of the LOWEST
    // inherited prefix levels, and each remaining level is prepended so the
    // outermost ends up at the front (Prefix3:Prefix2:Prefix1:name); leading
    // `:` (from unset/suppressed levels) are then stripped. `units.prefix` is
    // indexed [Prefix1, Prefix2, Prefix3] (innermost → outermost). A leading
    // colon therefore cancels the inherited Prefix1, e.g. `:A1` under
    // `Prefix=CAVE` resolves to bare `A1`, not `CAVE:A1`.
    let explicit_count = cased.matches(':').count();
    let mut name = cased;
    for level in explicit_count..units.prefix.len() {
        let p = units.prefix[level].as_deref().unwrap_or("");
        name = format!("{p}:{name}");
    }
    name.trim_start_matches(':').to_string()
}

/// Expand `$(name)` macro references in a line. Operates on `&str` slices
/// (`$(`, `)` are ASCII) so multibyte UTF-8 (decoded Latin-1) text is preserved
/// verbatim.
fn expand_macros(line: &str, macros: &HashMap<String, String>) -> Result<String, String> {
    if !line.contains("$(") {
        return Ok(line.to_string());
    }
    let mut out = String::new();
    let mut rest = line;
    while let Some(pos) = rest.find("$(") {
        out.push_str(&rest[..pos]);
        let after = &rest[pos + 2..];
        match after.find(')') {
            Some(close) => {
                let name = &after[..close];
                match macros.get(name) {
                    Some(val) => out.push_str(val),
                    None => return Err(format!("undefined macro $({name})")),
                }
                rest = &after[close + 1..];
            }
            None => {
                // Unterminated `$(` — emit the remainder literally.
                out.push_str(&rest[pos..]);
                rest = "";
                break;
            }
        }
    }
    out.push_str(rest);
    Ok(out)
}

// ---------------------------------------------------------------------------
// Coordinate projection
// ---------------------------------------------------------------------------

fn utm_to_wgs84(easting: f64, northing: f64, zone: i32, datum: &str) -> Option<(f64, f64)> {
    let token = datum_proj_token(datum);
    // Walls's `.REF` encodes a negative zone for the southern hemisphere.
    // `project_utm` returns (lon, lat); this importer carries (lat, lon).
    let (lon, lat) =
        crate::parsers::geo::project_utm(easting, northing, zone.unsigned_abs(), zone < 0, &token)?;
    Some((lat, lon))
}

/// Geodetic family of a Walls datum name that this importer can project with a
/// dedicated PROJ token. Walls stores datum *display* names (the first column
/// of its 28-entry datum table — e.g. `WGS 1984`, `NAD83`, `NAD27 CONUS`); the
/// long NIMA names (`North American 1983`/`1927`) also appear in the wild. Any
/// datum outside these four families is an obscure regional datum that PROJ's
/// simple `datum=`/`ellps=` tokens don't cover, so it is approximated as WGS84.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum DatumFamily {
    Wgs84,
    Wgs72,
    Nad83,
    Nad27,
    /// Unrecognized — projected as WGS84 and may be off by tens of meters.
    OtherApproxWgs84,
}

/// Classify a Walls `.REF`/`#Fix` datum name. Whitespace is stripped and case
/// folded so `WGS 1984` == `WGS1984` and `North American 1983` matches, then
/// the canonical names plus their common abbreviations are recognized. This is
/// the single source of truth for both [`datum_proj_token`] and
/// [`datum_recognized`], so the projection used can never disagree with whether
/// we consider the datum "recognized".
fn datum_family(datum: &str) -> DatumFamily {
    let key = datum
        .chars()
        .filter(|c| !c.is_whitespace())
        .collect::<String>()
        .to_ascii_uppercase();
    if key.contains("NAD83") || key.contains("NORTHAMERICAN1983") {
        DatumFamily::Nad83
    } else if key.contains("NAD27") || key.contains("NORTHAMERICAN1927") {
        DatumFamily::Nad27
    } else if key.contains("WGS1984") || key.contains("WGS84") {
        DatumFamily::Wgs84
    } else if key.contains("WGS1972") || key.contains("WGS72") {
        DatumFamily::Wgs72
    } else {
        DatumFamily::OtherApproxWgs84
    }
}

fn datum_proj_token(datum: &str) -> String {
    match datum_family(datum) {
        DatumFamily::Nad83 => "datum=NAD83",
        DatumFamily::Nad27 => "datum=NAD27",
        DatumFamily::Wgs72 => "ellps=WGS72",
        DatumFamily::Wgs84 | DatumFamily::OtherApproxWgs84 => "datum=WGS84",
    }
    .to_string()
}

/// Whether [`datum_proj_token`] maps this datum to a specific projection rather
/// than the WGS84 fallback. Used to warn when an unusual datum is silently
/// approximated as WGS84.
fn datum_recognized(datum: &str) -> bool {
    datum_family(datum) != DatumFamily::OtherApproxWgs84
}

// ---------------------------------------------------------------------------
// Preview
// ---------------------------------------------------------------------------

/// Whether a parsed vector becomes an imported shot. This is the single source
/// of truth for the keep/skip filter in `convert_walls_to_import_configs` and the
/// shot counts in `build_preview`, so the preview can never overstate the import.
/// `include_splays` controls whether anonymous wall-point (`-`) splay legs count.
fn is_importable_shot(v: &WallsVector, include_splays: bool) -> bool {
    if v.is_reference && !include_splays {
        return false;
    }
    // Dive legs are valid with a real depth change even at zero tape; a
    // zero-length non-dive leg that still carries a bearing is a coincident-
    // station tie worth keeping; every other zero-length leg is a degenerate
    // equate and is dropped.
    let depth_delta = match (v.from_depth, v.to_depth) {
        (Some(fd), Some(td)) => (td - fd).abs(),
        _ => 0.0,
    };
    let bearing_tie = !v.is_depth_gauge && v.azimuth_in.is_some();
    !(v.length_m <= 0.0 && !(v.is_depth_gauge && depth_delta > 0.0) && !bearing_tie)
}

/// Build the import-dialog preview from parsed data.
pub fn build_preview(parsed: &ParsedWalls) -> WallsFile {
    // Count shots the import would ACTUALLY produce under the default options
    // (splays excluded), not the raw vector count — otherwise the preview
    // overstates a file of splays/equates that converts to nothing.
    let shot_count = parsed
        .surveys
        .iter()
        .flat_map(|s| s.vectors.iter())
        .filter(|v| is_importable_shot(v, false))
        .count() as u32;
    // Splay/anonymous-wall shots not counted above but importable once the user
    // enables "Include splays" — so a splay-only file isn't reported as empty.
    let splay_count = parsed
        .surveys
        .iter()
        .flat_map(|s| s.vectors.iter())
        .filter(|v| is_importable_shot(v, true) && !is_importable_shot(v, false))
        .count() as u32;
    let resolved_survey_count = parsed.surveys.iter().filter(|s| s.resolved).count() as u32;
    // DISTINCT geographic `#Fix` stations the import would actually anchor on.
    // Reuse `resolve_anchors` (the importer's own logic) as the single source of
    // truth so the preview count can never drift from the anchors created.
    let fixed_station_count =
        resolve_anchors(parsed, &WallsImportOptions::default(), &mut Vec::new()).len() as u32;
    let surveys = parsed
        .surveys
        .iter()
        .map(|s| WallsSurveySummary {
            name: s.name.clone(),
            title: s.title.clone(),
            date: s.date.map(|d| d.to_string()).unwrap_or_default(),
            segment: s.segment.clone(),
            shot_count: s
                .vectors
                .iter()
                .filter(|v| is_importable_shot(v, false))
                .count() as u32,
            resolved: s.resolved,
        })
        .collect();
    WallsFile {
        project_name: parsed.project_name.clone(),
        book_count: parsed.book_count,
        survey_count: parsed.surveys.len() as u32,
        resolved_survey_count,
        shot_count,
        splay_count,
        has_georeference: parsed.georef.is_some(),
        datum: parsed.georef.as_ref().map(|r| r.datum.clone()),
        utm_zone: parsed.georef.as_ref().map(|r| r.zone),
        fixed_station_count,
        missing_file_count: parsed.missing_files.len() as u32,
        skipped_attachment_count: parsed.skipped_attachments,
        surveys,
        warnings: parsed.warnings.clone(),
    }
}

// ---------------------------------------------------------------------------
// Conversion to import configs
// ---------------------------------------------------------------------------

struct AnchorGeo {
    station: String,
    coordinates: GpsCoordinates,
    depth: f64,
}

/// Convert parsed Walls data into Stalagmight import configs + loop closures.
pub fn convert_walls_to_import_configs(
    parsed: &ParsedWalls,
    opts: &WallsImportOptions,
) -> Result<(Vec<ImportSectionConfig>, Vec<ImportClosure>, Vec<String>)> {
    let mut warnings = parsed.warnings.clone();

    // Every `#Fix` with a geographic position is a candidate GPS anchor. Each
    // connected survey component gets at most ONE of them as a zero datum (the
    // model forbids multiple datums per merge component); extra fixes in the
    // same component are tied in by the normal merges + loop closures.
    let anchors = resolve_anchors(parsed, opts, &mut warnings);

    // Pass 1: finalize per-survey vectors, collect graph edges + known depths.
    struct KeptSurvey {
        label: String,
        surveyor: Option<String>,
        date: Option<NaiveDate>,
        vectors: Vec<KeptVector>,
    }
    struct KeptVector {
        from: String,
        to: String,
        length_m: f64,
        azimuth_in: f64,
        azimuth_out: f64,
        pitch_in: Option<f64>,
        pitch_out: Option<f64>,
        left: Option<f64>,
        right: Option<f64>,
        up: Option<f64>,
        down: Option<f64>,
        comment: Option<String>,
        is_reference: bool,
        lrud_is_to: bool,
    }

    let mut kept: Vec<KeptSurvey> = Vec::new();
    let mut edges: Vec<(String, String, f64)> = Vec::new();
    let mut known_depth: HashMap<String, f64> = HashMap::new();

    for (si, survey) in parsed.surveys.iter().enumerate() {
        // Skip surveys the user deselected. `si` stays the ORIGINAL index so
        // synthetic splay names remain stable and match `resolve_anchors`.
        if !opts.includes_survey(si) {
            continue;
        }
        if survey.vectors.is_empty() {
            continue;
        }
        // Use THIS survey's inherited `.REF` (nearest ancestor) for grid
        // convergence + auto-declination, not the project's first reference.
        let survey_georef = &survey.georef;
        let mut kept_vectors = Vec::new();
        for (vi, v) in survey.vectors.iter().enumerate() {
            if !is_importable_shot(v, opts.include_splays) {
                continue;
            }
            // Give anonymous wall endpoints globally-unique names so unrelated
            // splays never collapse onto one shared station in the graph.
            let from = if v.from_anon {
                format!("\u{1}anon:{si}:{vi}:f")
            } else {
                v.from.clone()
            };
            let to = if v.to_anon {
                format!("\u{1}anon:{si}:{vi}:t")
            } else {
                v.to.clone()
            };
            // Finalize azimuth: + declination − convergence (grid-relative).
            // Convergence is the `.REF` grid convergence (when grid-relative)
            // plus any explicit `#Units Grid=` the survey set; both rotate true
            // north to grid north and so are subtracted from the azimuth.
            let convergence = if v.grid_relative {
                survey_georef.as_ref().map(|r| r.convergence).unwrap_or(0.0)
            } else {
                0.0
            } + v.grid_convergence;
            // RECT vectors already carry an absolute grid azimuth; magnetic
            // declination must NOT rotate Cartesian E/N/U deltas (only
            // convergence, via grid_relative, may apply).
            let declination = if v.is_rect {
                0.0
            } else {
                resolve_declination(v, survey_georef, &mut warnings)
            };
            let finalize = |a: Option<f64>| {
                a.map(|x| (x + declination - convergence).rem_euclid(360.0))
                    .unwrap_or(0.0)
            };
            let azimuth_in = finalize(v.azimuth_in);
            let azimuth_out = finalize(v.azimuth_out);

            // The model stores azimuth as a plain f64, so an omitted/unreadable
            // bearing collapses to 0° (due north). That is correct for a plumb
            // shot but silently wrong for anything else — surface it.
            if v.azimuth_in.is_none() && !v.is_depth_gauge {
                let plumb = v.inc_deg.map(|i| i.abs() >= 89.5).unwrap_or(false);
                if !plumb {
                    warnings.push(format!(
                        "Shot {}->{}: missing or unreadable azimuth; recorded as 0° (due north).",
                        v.from, v.to
                    ));
                }
            }

            // Edge elevation gain (+up).
            let gain = if v.is_depth_gauge {
                match (v.from_depth, v.to_depth) {
                    (Some(fd), Some(td)) => fd - td,
                    // Exactly one depth column was supplied (the other was `--` or
                    // absent). The leg's vertical change is unknown, so it is
                    // integrated as flat and the unmeasured station inherits its
                    // neighbour's depth — surface that rather than asserting a
                    // zero gain silently. (A genuine depth-gauge reading for that
                    // station from another leg still overrides the estimate.)
                    (Some(_), None) | (None, Some(_)) => {
                        warnings.push(format!(
                            "Shot {}->{}: dive leg is missing a depth reading; its \
                             vertical change was treated as zero.",
                            v.from, v.to
                        ));
                        0.0
                    }
                    (None, None) => 0.0,
                }
            } else {
                let inc = v.inc_deg.unwrap_or(0.0);
                let mut g = v.length_m * inc.to_radians().sin();
                // IncH adjusts the vertical of non-plumb CT shots. Require a real
                // measured distance: a zero-length coincident-station bearing tie
                // must not pick up a spurious IncH vertical offset.
                if inc.abs() < 89.5 && v.length_m > 0.0 {
                    g += v.inch;
                }
                g
            };
            edges.push((from.clone(), to.clone(), gain));

            if v.is_depth_gauge {
                if let Some(fd) = v.from_depth {
                    known_depth.entry(from.clone()).or_insert(fd);
                }
                if let Some(td) = v.to_depth {
                    known_depth.entry(to.clone()).or_insert(td);
                }
            }

            kept_vectors.push(KeptVector {
                from,
                to,
                length_m: v.length_m,
                azimuth_in,
                azimuth_out,
                pitch_in: v.pitch_in,
                pitch_out: v.pitch_out,
                left: v.left,
                right: v.right,
                up: v.up,
                down: v.down,
                comment: v.comment.clone(),
                is_reference: v.is_reference,
                lrud_is_to: v.lrud_is_to,
            });
        }
        if kept_vectors.is_empty() {
            continue;
        }
        kept.push(KeptSurvey {
            label: survey_label(survey),
            surveyor: survey.surveyor.clone(),
            date: survey.date,
            vectors: kept_vectors,
        });
    }

    // Resolve absolute station depths. Fixed stations seed the depth of their
    // component only where there is no depth-gauge reading to defer to.
    let anchor_depths: HashMap<&str, f64> = anchors
        .iter()
        .map(|a| (a.station.as_str(), a.depth))
        .collect();
    let depths = build_station_depths(&edges, &known_depth, &anchor_depths, &mut warnings);
    let depth_of = |s: &str| depths.get(s).copied().unwrap_or(0.0);

    // Pass 2a: split each survey into head-to-tail chains -> sections.
    struct PendingChain {
        section_index: u32,
        names: Vec<String>,
        shots: Vec<ShotData>,
        station_comments: Vec<(u32, String)>,
        label: String,
        surveyor: Option<String>,
        date: Option<NaiveDate>,
    }
    // The model has no zero-length shot (it can't place two stations at one
    // point as a leg), so a Walls zero-length coincident-station tie is nudged to
    // a negligible length and counted here for a single aggregated warning.
    const COINCIDENT_TIE_EPSILON_M: f64 = 0.001;
    let mut coincident_ties = 0usize;
    let mut chains: Vec<PendingChain> = Vec::new();
    for survey in &kept {
        let split = split_into_chains(&survey.vectors, |v| (v.from.as_str(), v.to.as_str()));
        let multi = split.len() > 1;
        for (chain_idx, chain) in split.iter().enumerate() {
            if chain.is_empty() {
                continue;
            }
            let section_index = chains.len() as u32;
            let mut names = Vec::with_capacity(chain.len() + 1);
            names.push(survey.vectors[chain[0]].from.clone());
            for &idx in chain {
                names.push(survey.vectors[idx].to.clone());
            }
            let mut shots = Vec::with_capacity(chain.len());
            for (pos, &idx) in chain.iter().enumerate() {
                let v = &survey.vectors[idx];
                let depth_in = depth_of(&v.from);
                let depth_out = depth_of(&v.to);
                // Slope length must be >= |Δdepth| or the model can't form the
                // triangle; clamp up (with a warning if the gap is material).
                let dz = (depth_out - depth_in).abs();
                let length = if v.length_m < dz {
                    if dz - v.length_m > 0.05 {
                        warnings.push(format!(
                            "Shot {}->{}: slope length {:.2} m < depth change {:.2} m; clamped",
                            v.from, v.to, v.length_m, dz
                        ));
                    }
                    dz
                } else {
                    v.length_m
                };
                // A zero-length leg that survived the keep filter is a
                // coincident-station tie (e.g. `A B 0 0 0` equating two names, or
                // a bearing with no tape). The model rejects length == 0, so nudge
                // it to a negligible length: the two stations stay connected and
                // effectively coincident instead of failing the whole import.
                let length = if length <= 0.0 {
                    coincident_ties += 1;
                    COINCIDENT_TIE_EPSILON_M
                } else {
                    length
                };
                // Resolve this shot's FROM-station LRUD honoring `#Units LRUD`. A
                // From-typed leg contributes its own LRUD; a To-typed leg's LRUD
                // belongs to its TO station — i.e. the FROM of the NEXT shot — so
                // it is adopted from the previous leg in the chain. (A To survey
                // thus shifts each cross-section one shot forward; the final To
                // station's LRUD has no outgoing shot and is dropped.)
                let own_lrud = if v.lrud_is_to {
                    (None, None, None, None)
                } else {
                    (v.left, v.right, v.up, v.down)
                };
                let (left, right, up, down) = match pos
                    .checked_sub(1)
                    .map(|p| &survey.vectors[chain[p]])
                {
                    Some(prev) if prev.lrud_is_to => (prev.left, prev.right, prev.up, prev.down),
                    _ => own_lrud,
                };
                shots.push(ShotData {
                    azimuth_in: v.azimuth_in,
                    azimuth_out: v.azimuth_out,
                    length,
                    depth_in,
                    depth_out,
                    pitch_in: v.pitch_in,
                    pitch_out: v.pitch_out,
                    left,
                    right,
                    up,
                    down,
                    comment: v.comment.clone(),
                    is_reference: v.is_reference,
                    marker_index: None,
                    temperature: None,
                });
            }
            let mut station_comments = Vec::new();
            if opts.comments_on_stations {
                for (shot_idx, shot) in shots.iter_mut().enumerate() {
                    if let Some(comment) = shot.comment.take() {
                        if !comment.is_empty() {
                            station_comments.push((shot_idx as u32, comment));
                        }
                    }
                }
            }
            let label = if multi {
                format!("{} (branch {})", survey.label, chain_idx + 1)
            } else {
                survey.label.clone()
            };
            chains.push(PendingChain {
                section_index,
                names,
                shots,
                station_comments,
                label,
                surveyor: survey.surveyor.clone(),
                date: survey.date,
            });
        }
    }

    if coincident_ties > 0 {
        warnings.push(format!(
            "{coincident_ties} zero-length coincident-station tie(s) were given a \
             negligible {COINCIDENT_TIE_EPSILON_M} m length so they import as valid shots \
             (the model has no zero-length shot)."
        ));
    }

    // Pass 2b: spanning-tree placement over chain connectivity. Each component
    // is rooted at a fixed station (ZeroDatum) when it contains one, else at
    // Origin; the rest of the component chains to its root via FromImporting.
    let placements = place_chains(
        &chains.iter().map(|c| c.names.clone()).collect::<Vec<_>>(),
        &anchors,
        &mut warnings,
        |idx| chains[idx].label.clone(),
    );

    // Pass 2c: loop closures for shared stations that aren't tree edges.
    let closures = build_closures(
        &chains
            .iter()
            .map(|c| (c.section_index, c.names.clone()))
            .collect::<Vec<_>>(),
        &placements,
    );

    // Emit configs in BFS creation order.
    let mut configs: Vec<ImportSectionConfig> = Vec::with_capacity(chains.len());
    for &ci in &placements.creation_order {
        let chain = &chains[ci];
        configs.push(ImportSectionConfig {
            section_index: chain.section_index,
            name: Some(chain.label.clone()),
            surveyor: chain.surveyor.clone(),
            date: chain.date,
            color: SECTION_COLORS[chain.section_index as usize % SECTION_COLORS.len()].to_string(),
            direction: None,
            quality: 1.0,
            shots: chain.shots.clone(),
            placement: placements.placement[ci]
                .clone()
                .unwrap_or(ImportPlacement::Origin),
            station_comments: chain.station_comments.clone(),
        });
    }
    topological_sort_configs(&mut configs);

    // Collapse identical warnings (e.g. the one-per-shot declination / missing-
    // azimuth notes) to a single line each, preserving first-seen order.
    {
        let mut seen: HashSet<String> = HashSet::new();
        warnings.retain(|w| seen.insert(w.clone()));
    }

    Ok((configs, closures, warnings))
}

fn resolve_declination(
    v: &WallsVector,
    georef: &Option<WallsRef>,
    warnings: &mut Vec<String>,
) -> f64 {
    // An explicit `Decl=` always wins — including an explicit `Decl=0`, which
    // declares the azimuths already true/grid and suppresses auto-derivation.
    if let Some(decl) = v.units_decl {
        return decl;
    }
    // Otherwise auto-derive from the IGRF model ONLY when the entry's
    // derive-declination flag is on AND a georeference + date are available.
    if !v.derive_decl {
        return 0.0;
    }
    match (georef, v.date) {
        (Some(r), Some(date)) => {
            match crate::parsers::geo::igrf_declination(r.latitude, r.longitude, date) {
                Ok(d) => d,
                // The bundled IGRF model only spans 1900–2025; a survey dated
                // outside that range (e.g. a current-year dive) would otherwise
                // import with a silent 0° correction. Surface it instead.
                // Identical per-shot lines collapse via the dedup at the end of
                // conversion.
                Err(_) => {
                    warnings.push(format!(
                        "Could not derive magnetic declination for {date} at {:.3}, {:.3} \
                         (date/location outside the IGRF model range 1900–2025); using 0°.",
                        r.latitude, r.longitude
                    ));
                    0.0
                }
            }
        }
        _ => 0.0,
    }
}

fn survey_label(survey: &ParsedSurvey) -> String {
    let title = survey.title.trim();
    if !title.is_empty() {
        title.to_string()
    } else if !survey.name.trim().is_empty() {
        survey.name.trim().to_string()
    } else {
        "Unnamed section".to_string()
    }
}

/// Collect every `#Fix` station that resolves to a geographic position, deduped
/// by station name (first declaration wins).
fn resolve_anchors(
    parsed: &ParsedWalls,
    opts: &WallsImportOptions,
    warnings: &mut Vec<String>,
) -> Vec<AnchorGeo> {
    let mut anchors: Vec<AnchorGeo> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    for (si, survey) in parsed.surveys.iter().enumerate() {
        // A deselected survey's fixes must not anchor (or warn as "unused") —
        // skip them so deselecting a fix-heavy surface mesh stays silent.
        if !opts.includes_survey(si) {
            continue;
        }
        for fix in &survey.fixes {
            let Some((lat, lon)) = fix.lat_long else {
                continue;
            };
            if seen.contains(&fix.name) {
                continue;
            }
            match GpsCoordinates::new(lat, lon, 0.0) {
                Ok(coordinates) => {
                    seen.insert(fix.name.clone());
                    anchors.push(AnchorGeo {
                        station: fix.name.clone(),
                        coordinates,
                        // A fixed station's `up` (elevation) maps to depth below
                        // the surface datum; absent it sits at depth 0.
                        depth: fix.up.map(|u| -u).unwrap_or(0.0),
                    });
                }
                Err(e) => warnings.push(format!("Ignoring invalid #Fix '{}': {e}", fix.name)),
            }
        }
    }
    anchors
}

/// Generic head-to-tail chain splitter.
fn split_into_chains<T>(items: &[T], ends: impl Fn(&T) -> (&str, &str)) -> Vec<Vec<usize>> {
    let mut chains: Vec<Vec<usize>> = Vec::new();
    let mut current: Vec<usize> = Vec::new();
    let mut prev_to: Option<String> = None;
    for (i, item) in items.iter().enumerate() {
        let (from, to) = ends(item);
        let continues = prev_to.as_deref() == Some(from);
        if !continues && !current.is_empty() {
            chains.push(std::mem::take(&mut current));
        }
        current.push(i);
        prev_to = Some(to.to_string());
    }
    if !current.is_empty() {
        chains.push(current);
    }
    chains
}

/// Walk the station graph assigning each station an absolute depth (+down),
/// seeding each component from a known depth-gauge reading, else a fixed-station
/// anchor depth, else 0. Gauge readings win because they are the authoritative
/// vertical for dive data.
fn build_station_depths(
    edges: &[(String, String, f64)],
    known: &HashMap<String, f64>,
    anchors: &HashMap<&str, f64>,
    warnings: &mut Vec<String>,
) -> HashMap<String, f64> {
    // adjacency carries depth deltas (Δdepth = -Δup).
    let mut adjacency: HashMap<&str, Vec<(&str, f64)>> = HashMap::new();
    for (from, to, gain) in edges {
        adjacency
            .entry(from)
            .or_default()
            .push((to.as_str(), -gain));
        adjacency
            .entry(to)
            .or_default()
            .push((from.as_str(), *gain));
    }
    let mut nodes: Vec<&str> = adjacency.keys().copied().collect();
    nodes.sort_unstable();

    let mut depth: HashMap<String, f64> = HashMap::new();
    for &start in &nodes {
        if depth.contains_key(start) {
            continue;
        }
        // Discover the component (BFS) to choose the best seed.
        let mut component: Vec<&str> = Vec::new();
        let mut seen: HashSet<&str> = HashSet::new();
        let mut stack = vec![start];
        seen.insert(start);
        while let Some(n) = stack.pop() {
            component.push(n);
            if let Some(nbrs) = adjacency.get(n) {
                for (m, _) in nbrs {
                    if seen.insert(*m) {
                        stack.push(*m);
                    }
                }
            }
        }
        // Choose seed station + absolute depth: gauge reading first (dive data
        // is authoritative), then a fixed-station anchor depth, else 0.
        let (seed, seed_depth) = if let Some(k) = component
            .iter()
            .filter(|n| known.contains_key(**n))
            .min()
            .copied()
        {
            (k, known[k])
        } else if let Some(a) = component
            .iter()
            .filter(|n| anchors.contains_key(**n))
            .min()
            .copied()
        {
            (a, anchors[a])
        } else {
            // `component` always contains `start`, so the fallback never fires;
            // expressed without `unwrap()` to satisfy the no-panic lint gate.
            (component.iter().min().copied().unwrap_or(start), 0.0)
        };

        // BFS from the seed propagating depth.
        let mut queue: VecDeque<&str> = VecDeque::new();
        depth.insert(seed.to_string(), seed_depth);
        queue.push_back(seed);
        while let Some(n) = queue.pop_front() {
            let current = depth[n];
            if let Some(nbrs) = adjacency.get(n) {
                for (m, delta) in nbrs {
                    if !depth.contains_key(*m) {
                        // A station's own depth-gauge reading is authoritative
                        // for dive data; only fall back to the integrated depth
                        // (seed + accumulated deltas) when it has none. When both
                        // exist and disagree materially, the gauge still wins but
                        // the discontinuity is surfaced rather than absorbed.
                        let integrated = current + delta;
                        let d = match known.get(*m) {
                            // Warn only on a gross discontinuity (well beyond
                            // normal depth-gauge noise), not a sub-meter wobble.
                            Some(&gauge) => {
                                if (gauge - integrated).abs() > 2.0 {
                                    warnings.push(format!(
                                        "Station {m}: depth-gauge reading {gauge:.2} m disagrees \
                                         with the integrated depth {integrated:.2} m; using the gauge."
                                    ));
                                }
                                gauge
                            }
                            // Only the seed anchor sets a component's depth datum
                            // (like the single horizontal zero-datum); a SECOND
                            // #Fix in the same component is a consistency check,
                            // not a second datum. Surface a material disagreement
                            // as a vertical misclosure but KEEP the integrated
                            // (measured-geometry) depth — overriding it would
                            // inject a fake vertical change and corrupt shot
                            // lengths, which Walls/dewalls never do.
                            None => {
                                if let Some(&anchor) = anchors.get(*m) {
                                    if (anchor - integrated).abs() > 2.0 {
                                        warnings.push(format!(
                                            "Station {m}: fixed-station depth {anchor:.2} m \
                                             disagrees with the integrated depth {integrated:.2} m; \
                                             keeping the integrated depth (vertical misclosure)."
                                        ));
                                    }
                                }
                                integrated
                            }
                        };
                        depth.insert((*m).to_string(), d);
                        queue.push_back(*m);
                    }
                }
            }
        }
    }
    depth
}

struct Placements {
    placement: Vec<Option<ImportPlacement>>,
    creation_order: Vec<usize>,
    /// For each chain: (parent chain index, merge station index) when joined.
    merge_station: Vec<Option<u32>>,
    parent: Vec<Option<usize>>,
}

/// Spanning-tree placement over chain connectivity. Each connected component is
/// rooted at a fixed station (ZeroDatum) when it contains one, else at Origin;
/// every other chain in the component merges to its discoverer via
/// FromImporting, and shared stations that aren't the tree edge become loop
/// closures (see [`build_closures`]). At most ONE zero datum is emitted per
/// component — the model forbids multiple datums per merge component — so extra
/// fixed stations in the same connected survey ride along via merges + closures
/// rather than becoming separate datums.
fn place_chains(
    chain_names: &[Vec<String>],
    anchors: &[AnchorGeo],
    warnings: &mut Vec<String>,
    label_of: impl Fn(usize) -> String,
) -> Placements {
    let n = chain_names.len();
    // Build chain adjacency: two chains neighbor iff they share a station name.
    let mut occurrences: HashMap<&str, Vec<usize>> = HashMap::new();
    for (ci, names) in chain_names.iter().enumerate() {
        for name in names {
            occurrences.entry(name.as_str()).or_default().push(ci);
        }
    }
    // Connect each station's occurrences as a star (hub = first chain) rather
    // than a full clique: O(k) edges instead of O(k²) for a station shared by k
    // chains. Every adjacency edge still corresponds to a shared station (so each
    // spanning-tree merge is valid) and the connected components are identical;
    // loop closures for the other shared occurrences are emitted separately in
    // `build_closures`.
    let mut adjacency: Vec<Vec<usize>> = vec![Vec::new(); n];
    for occ in occurrences.values() {
        let hub = occ[0];
        for &other in &occ[1..] {
            if other != hub {
                adjacency[hub].push(other);
                adjacency[other].push(hub);
            }
        }
    }
    for nbrs in adjacency.iter_mut() {
        nbrs.sort_unstable();
        nbrs.dedup();
    }

    // Per-chain station-name -> first index, so `shared_station` is O(child len)
    // instead of re-scanning the whole parent chain for every name.
    let chain_index: Vec<HashMap<&str, u32>> = chain_names
        .iter()
        .map(|names| {
            let mut m: HashMap<&str, u32> = HashMap::new();
            for (i, name) in names.iter().enumerate() {
                m.entry(name.as_str()).or_insert(i as u32);
            }
            m
        })
        .collect();
    let shared_station = |child: usize, parent: usize| -> Option<(u32, u32)> {
        for (ci, cname) in chain_names[child].iter().enumerate() {
            if let Some(&pi) = chain_index[parent].get(cname.as_str()) {
                return Some((ci as u32, pi));
            }
        }
        None
    };

    // Fixed-station name -> anchor index (first declaration wins per name).
    let anchor_by_name: HashMap<&str, usize> = {
        let mut m = HashMap::new();
        for (i, a) in anchors.iter().enumerate() {
            m.entry(a.station.as_str()).or_insert(i);
        }
        m
    };
    // A fixed station that no shot references can't be anchored to anything.
    for a in anchors {
        if !occurrences.contains_key(a.station.as_str()) {
            warnings.push(format!(
                "Fixed station '{}' isn't used by any shot; no zero datum created for it.",
                a.station
            ));
        }
    }
    // For each chain, the first station that is a fixed-station anchor.
    let chain_anchor: Vec<Option<(u32, usize)>> = chain_names
        .iter()
        .map(|names| {
            names
                .iter()
                .enumerate()
                .find_map(|(k, nm)| anchor_by_name.get(nm.as_str()).map(|&ai| (k as u32, ai)))
        })
        .collect();

    let mut placement: Vec<Option<ImportPlacement>> = vec![None; n];
    let mut merge_station: Vec<Option<u32>> = vec![None; n];
    let mut parent: Vec<Option<usize>> = vec![None; n];
    let mut visited = vec![false; n];
    let mut creation_order: Vec<usize> = Vec::with_capacity(n);
    let have_any_anchor = !anchors.is_empty();

    for start in 0..n {
        if visited[start] {
            continue;
        }
        // Discover the whole component first so it can be rooted at an anchor.
        let mut component: Vec<usize> = Vec::new();
        {
            let mut seen: HashSet<usize> = HashSet::new();
            let mut stack = vec![start];
            seen.insert(start);
            while let Some(c) = stack.pop() {
                component.push(c);
                for &nb in &adjacency[c] {
                    if seen.insert(nb) {
                        stack.push(nb);
                    }
                }
            }
        }
        component.sort_unstable();

        // Root at a fixed station if the component has one (smallest chain idx).
        let anchored_chains: Vec<usize> = component
            .iter()
            .copied()
            .filter(|&ci| chain_anchor[ci].is_some())
            .collect();
        let root = anchored_chains.first().copied().unwrap_or(component[0]);

        if let Some((st_idx, ai)) = chain_anchor[root] {
            placement[root] = Some(ImportPlacement::ZeroDatum {
                coordinates: anchors[ai].coordinates,
                station_index: st_idx,
            });
            if anchored_chains.len() > 1 {
                let extras: Vec<&str> = anchored_chains
                    .iter()
                    .skip(1)
                    .filter_map(|&ci| chain_anchor[ci].map(|(_, j)| anchors[j].station.as_str()))
                    .collect();
                warnings.push(format!(
                    "Component anchored at '{}'; {} other fixed station(s) in the same connected \
                     survey are kept via merges + loop closures, not as separate datums: {}.",
                    anchors[ai].station,
                    extras.len(),
                    extras.join(", "),
                ));
            }
        } else {
            placement[root] = Some(ImportPlacement::Origin);
            if have_any_anchor {
                warnings.push(format!(
                    "Section '{}' is a separate component with no fixed station; placed at origin.",
                    label_of(root)
                ));
            }
        }
        visited[root] = true;
        creation_order.push(root);

        // BFS the component from its root, merging via FromImporting.
        let mut queue: VecDeque<usize> = VecDeque::new();
        queue.push_back(root);
        while let Some(p) = queue.pop_front() {
            for nb in adjacency[p].clone() {
                if visited[nb] {
                    continue;
                }
                if let Some((child_st, parent_st)) = shared_station(nb, p) {
                    placement[nb] = Some(ImportPlacement::FromImporting {
                        import_station: child_st,
                        target_section_index: p as u32,
                        target_station_index: parent_st,
                    });
                    merge_station[nb] = Some(child_st);
                    parent[nb] = Some(p);
                }
                visited[nb] = true;
                creation_order.push(nb);
                queue.push_back(nb);
            }
        }
    }

    Placements {
        placement,
        creation_order,
        merge_station,
        parent,
    }
}

/// Emit loop closures for shared stations that aren't the spanning-tree edge.
fn build_closures(chains: &[(u32, Vec<String>)], placements: &Placements) -> Vec<ImportClosure> {
    let mut canonical: HashMap<&str, (u32, u32)> = HashMap::new();
    for (section_index, names) in chains {
        for (k, name) in names.iter().enumerate() {
            canonical
                .entry(name.as_str())
                .and_modify(|prev| {
                    if *section_index < prev.0 {
                        *prev = (*section_index, k as u32);
                    }
                })
                .or_insert((*section_index, k as u32));
        }
    }
    let mut closures = Vec::new();
    let mut seen: HashSet<(u32, u32, u32, u32)> = HashSet::new();
    for (ci, (section_index, names)) in chains.iter().enumerate() {
        let merge_st = placements.merge_station[ci];
        let parent_section = placements.parent[ci].map(|p| chains[p].0);
        for (k, name) in names.iter().enumerate() {
            if let Some(&(canon_sec, canon_st)) = canonical.get(name.as_str()) {
                // The canonical occurrence itself needs no closure.
                if canon_sec == *section_index && canon_st == k as u32 {
                    continue;
                }
                // A station revisited later within the SAME chain (a contiguous
                // intra-chain loop, e.g. A->B->C->A) is the same physical station
                // as its canonical occurrence and must be tied by an
                // intra-section closure — fall through to emit it. The
                // already-joined-by-merge shortcut only applies to cross-section
                // ties.
                if canon_sec != *section_index
                    && Some(k as u32) == merge_st
                    && parent_section == Some(canon_sec)
                {
                    continue;
                }
                let key = (*section_index, k as u32, canon_sec, canon_st);
                if seen.insert(key) {
                    closures.push(ImportClosure {
                        from_section_index: *section_index,
                        from_station_index: k as u32,
                        to_section_index: canon_sec,
                        to_station_index: canon_st,
                    });
                }
            }
        }
    }
    closures
}

/// Reorder configs so any `FromImporting` target precedes its dependent.
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
    let mut children: Vec<Vec<usize>> = vec![Vec::new(); configs.len()];
    let mut placed = vec![false; configs.len()];
    let mut order: Vec<usize> = Vec::with_capacity(configs.len());
    let mut ready: VecDeque<usize> = VecDeque::new();
    for (i, d) in dep.iter().enumerate() {
        match d {
            Some(target) if *target < configs.len() => children[*target].push(i),
            _ => ready.push_back(i),
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
    for i in 0..configs.len() {
        if !placed[i] {
            order.push(i);
        }
    }
    let mut reordered: Vec<Option<ImportSectionConfig>> = configs.drain(..).map(Some).collect();
    for idx in order {
        if let Some(config) = reordered[idx].take() {
            configs.push(config);
        }
    }
}

#[cfg(test)]
#[expect(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::print_stdout,
    clippy::print_stderr
)]
mod tests {
    use super::*;

    // ----- helpers ---------------------------------------------------------

    fn parse_srv(content: &str) -> ParsedSurvey {
        let mut warnings = Vec::new();
        parse_srv_contents(
            content,
            "Test Survey",
            "TEST",
            "",
            &WallsUnits::default(),
            &HashMap::new(),
            None,
            true,
            false,
            &mut warnings,
        )
    }

    fn convert_one(
        survey: ParsedSurvey,
    ) -> (Vec<ImportSectionConfig>, Vec<ImportClosure>, Vec<String>) {
        let parsed = ParsedWalls {
            project_name: "Test".to_string(),
            book_count: 0,
            surveys: vec![survey],
            georef: None,
            missing_files: Vec::new(),
            skipped_attachments: 0,
            warnings: Vec::new(),
        };
        convert_walls_to_import_configs(&parsed, &WallsImportOptions::default()).unwrap()
    }

    fn approx(a: f64, b: f64) -> bool {
        (a - b).abs() < 1e-6
    }

    fn temp_dir(tag: &str) -> PathBuf {
        let mut d = std::env::temp_dir();
        d.push(format!("walls_test_{tag}_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    // ----- datum recognition / projection ---------------------------------

    #[test]
    fn datum_family_classifies_canonical_walls_names() {
        // The authoritative Walls datum table (wallcss.cpp `sDatum[]`) writes
        // these display names into `.REF`; the long NIMA names also appear.
        for name in ["WGS 1984", "WGS1984", "wgs 84", "WGS84"] {
            assert_eq!(datum_family(name), DatumFamily::Wgs84, "{name}");
        }
        for name in ["WGS 1972", "WGS72"] {
            assert_eq!(datum_family(name), DatumFamily::Wgs72, "{name}");
        }
        for name in ["NAD83", "North American 1983"] {
            assert_eq!(datum_family(name), DatumFamily::Nad83, "{name}");
        }
        for name in [
            "NAD27 Alaska",
            "NAD27 CONUS",
            "NAD27 Mexico",
            "North American 1927",
        ] {
            assert_eq!(datum_family(name), DatumFamily::Nad27, "{name}");
        }
        // Obscure regional datums fall back to a WGS84 approximation.
        for name in ["Camp Area Astro", "European 1950", "Tokyo", ""] {
            assert_eq!(datum_family(name), DatumFamily::OtherApproxWgs84, "{name}");
        }
    }

    #[test]
    fn datum_proj_token_and_recognition_agree() {
        // The classifier is the single source of truth, so projection and
        // recognition can never disagree.
        assert_eq!(datum_proj_token("WGS 1984"), "datum=WGS84");
        assert_eq!(datum_proj_token("WGS 1972"), "ellps=WGS72");
        assert_eq!(datum_proj_token("North American 1983"), "datum=NAD83");
        assert_eq!(datum_proj_token("NAD27 Alaska"), "datum=NAD27");
        assert_eq!(datum_proj_token("Camp Area Astro"), "datum=WGS84");
        assert!(datum_recognized("WGS 1984"));
        assert!(datum_recognized("NAD27 Alaska"));
        assert!(!datum_recognized("Camp Area Astro"));
    }

    #[test]
    fn wgs1984_utm_fix_does_not_warn() {
        // Regression: "WGS 1984" is the standard Walls name for WGS84, so a
        // surface file of many UTM `#Fix` points under it must produce ZERO
        // datum warnings (previously one per fix — hundreds of them).
        let georef = Some(WallsRef {
            zone: 34,
            convergence: 0.0,
            latitude: 49.0,
            longitude: 20.0,
            datum: "WGS 1984".to_string(),
        });
        let srv = "#units rect order=ENU\n#units meters\n#prefix UTM3\n\
                   #fix 1 417727.726 5456614.566 970\n\
                   #fix 72 417753.428 5456614.566 980\n\
                   #fix 242 413813.448 5456614.566 990\n";
        let mut warnings = Vec::new();
        let survey = parse_srv_contents(
            srv,
            "t",
            "t",
            "",
            &WallsUnits::default(),
            &HashMap::new(),
            georef,
            true,
            false,
            &mut warnings,
        );
        assert_eq!(survey.fixes.len(), 3, "all three #Fix rows parsed");
        assert!(
            survey.fixes.iter().all(|f| f.lat_long.is_some()),
            "WGS 1984 UTM fixes project to lat/long"
        );
        assert!(
            warnings.iter().all(|w| !w.contains("not recognized")),
            "WGS 1984 must not warn, got {warnings:?}"
        );
    }

    #[test]
    fn unrecognized_datum_warns_once_per_survey() {
        // An unrecognized datum on many UTM fixes warns exactly ONCE, not once
        // per fixed point.
        let georef = Some(WallsRef {
            zone: 16,
            convergence: 0.0,
            latitude: 20.0,
            longitude: -87.0,
            datum: "Camp Area Astro".to_string(),
        });
        let srv = "#units rect order=ENU\n#units meters\n\
                   #fix A 467427 2258942 0\n\
                   #fix B 467500 2259000 0\n\
                   #fix C 467600 2259100 0\n";
        let mut warnings = Vec::new();
        parse_srv_contents(
            srv,
            "t",
            "t",
            "",
            &WallsUnits::default(),
            &HashMap::new(),
            georef,
            true,
            false,
            &mut warnings,
        );
        let datum_warnings = warnings
            .iter()
            .filter(|w| w.contains("not recognized"))
            .count();
        assert_eq!(
            datum_warnings, 1,
            "exactly one aggregated datum warning, got {warnings:?}"
        );
    }

    // ----- depth-gauge dive surveys ---------------------------------------

    #[test]
    fn depth_gauge_basic() {
        let srv = "#DATE 2017-05-07\n#UNITS meters ORDER=DA Tape=SS\n\
                   A\tB\t21.1\t339\t13\t13\n\
                   B\tC\t8.1\t62\t13\t11.9\t<--,3,2,1>\n";
        let survey = parse_srv(srv);
        assert_eq!(survey.vectors.len(), 2);
        let ab = &survey.vectors[0];
        assert_eq!(ab.from, "A");
        assert_eq!(ab.to, "B");
        assert!(ab.is_depth_gauge);
        assert!(approx(ab.length_m, 21.1));
        assert_eq!(ab.azimuth_in, Some(339.0));
        assert_eq!(ab.from_depth, Some(13.0));
        assert_eq!(ab.to_depth, Some(13.0));
        assert_eq!(ab.inc_deg, None);
        let bc = &survey.vectors[1];
        assert_eq!(bc.from_depth, Some(13.0));
        assert_eq!(bc.to_depth, Some(11.9));
        assert_eq!(bc.left, None); // "--" omitted
        assert_eq!(bc.right, Some(3.0));
        assert_eq!(bc.up, Some(2.0));
        assert_eq!(bc.down, Some(1.0));
        assert_eq!(
            survey.date,
            Some(NaiveDate::from_ymd_opt(2017, 5, 7).unwrap())
        );
    }

    #[test]
    fn depth_gauge_conversion_keeps_gauge_depths() {
        let srv = "#UNITS meters ORDER=DA Tape=SS\n\
                   A B 21.1 339 13 13\n\
                   B C 8.1 62 13 11.9\n";
        let (configs, closures, _w) = convert_one(parse_srv(srv));
        assert_eq!(configs.len(), 1);
        assert!(closures.is_empty());
        let sec = &configs[0];
        assert_eq!(sec.shots.len(), 2);
        assert!(approx(sec.shots[0].depth_in, 13.0));
        assert!(approx(sec.shots[0].depth_out, 13.0));
        assert!(approx(sec.shots[1].depth_in, 13.0));
        assert!(approx(sec.shots[1].depth_out, 11.9));
        assert!(approx(sec.shots[0].length, 21.1));
        assert!(approx(sec.shots[0].azimuth_in, 339.0));
        assert!(matches!(sec.placement, ImportPlacement::Origin));
    }

    // ----- foresight / backsight ------------------------------------------

    #[test]
    fn fsbs_azimuth_and_inclination_average() {
        let srv = "#UNITS meters order=DAV\nA B 10 30/210 5/-5\n";
        let v = &parse_srv(srv).vectors[0];
        assert_eq!(v.azimuth_in, Some(30.0)); // foresight
        assert_eq!(v.azimuth_out, Some(30.0)); // backsight reversed 180
        assert_eq!(v.inc_deg, Some(5.0)); // (+5, -(-5)) averaged
        assert_eq!(v.pitch_in, Some(-5.0)); // +down
        assert_eq!(v.pitch_out, Some(-5.0));
    }

    #[test]
    fn foresight_omitted_uses_backsight() {
        let srv = "#UNITS meters order=DAV\nA B 10 /200 /-17\n";
        let v = &parse_srv(srv).vectors[0];
        assert_eq!(v.azimuth_in, Some(20.0)); // 200 reversed
        assert_eq!(v.azimuth_out, Some(20.0));
        assert_eq!(v.inc_deg, Some(17.0)); // -(-17)
    }

    #[test]
    fn typeab_corrected_skips_reversal() {
        let srv = "#UNITS meters order=DAV TypeAB=C\nA B 10 30/30 0\n";
        let v = &parse_srv(srv).vectors[0];
        assert_eq!(v.azimuth_in, Some(30.0));
        assert_eq!(v.azimuth_out, Some(30.0)); // bs not reversed
    }

    // ----- units ----------------------------------------------------------

    #[test]
    fn grads_and_percent_units() {
        let srv = "#UNITS meters order=DAV A=Grads V=Percent\nA B 10 100 100\n";
        let v = &parse_srv(srv).vectors[0];
        assert!(approx(v.azimuth_in.unwrap(), 90.0)); // 100 grad
        assert!(approx(v.inc_deg.unwrap(), 45.0)); // 100% grade
    }

    #[test]
    fn feet_units_convert_to_meters() {
        let srv = "#UNITS feet order=DAV\nA B 10 0 0\n";
        let v = &parse_srv(srv).vectors[0];
        assert!(approx(v.length_m, 3.048));
    }

    #[test]
    fn save_restore_units_stack() {
        let srv = "#UNITS feet\n#UNITS Save Meters\nA B 10 0 0\n#UNITS Restore\nC D 10 0 0\n";
        let s = parse_srv(srv);
        assert!(approx(s.vectors[0].length_m, 10.0)); // meters
        assert!(approx(s.vectors[1].length_m, 3.048)); // back to feet
    }

    #[test]
    fn prefix_and_case_folding() {
        let srv = "#UNITS Prefix=ALU Case=Upper order=DAV\na1 b2 10 0 0\n";
        let v = &parse_srv(srv).vectors[0];
        assert_eq!(v.from, "ALU:A1");
        assert_eq!(v.to, "ALU:B2");
    }

    #[test]
    fn macro_expansion() {
        let srv = "#UNITS $sta=XY\nA$(sta) B 10 0 0\n";
        let v = &parse_srv(srv).vectors[0];
        assert_eq!(v.from, "AXY");
    }

    #[test]
    fn block_comment_skipped() {
        let srv = "#[\nA B 10 0 0\n#]\nC D 5 0 0\n";
        let s = parse_srv(srv);
        assert_eq!(s.vectors.len(), 1);
        assert_eq!(s.vectors[0].from, "C");
    }

    #[test]
    fn lrud_star_delimiters_and_order() {
        let srv = "#UNITS meters order=DAV LRUD=F:UDRL\nA B 10 0 0 *2 3 4 5*\n";
        let v = &parse_srv(srv).vectors[0];
        // order UDRL: up=2 down=3 right=4 left=5
        assert_eq!(v.up, Some(2.0));
        assert_eq!(v.down, Some(3.0));
        assert_eq!(v.right, Some(4.0));
        assert_eq!(v.left, Some(5.0));
    }

    #[test]
    fn star_in_station_name_is_literal_not_lrud() {
        // Regression: stations may contain a literal `*` (real corpus:
        // `W-*/2/46` in the Tatra KATASTER cave). The `*` is only an LRUD
        // delimiter at a token boundary; glued inside a station name it must be
        // kept verbatim. Previously `W-*/2/46  W-*/2/50` was torn into
        // from="W-", a bogus `*…*` span, and to="/2/50", collapsing every such
        // station onto a phantom "W-" hub (turning a chain into a star of
        // single-shot sections all sharing one point).
        let srv = "#UNITS meters order=DAV\n\
                   W-*/2/46 W-*/2/50 9.2 242 25\n\
                   W-*/2/50 W-*/2/51 7.3 262 8\n\
                   W-*/2/51 W-*/2/52 2.7 278 -6\n";
        let parsed = parse_srv(srv);
        assert_eq!(parsed.vectors.len(), 3);
        assert_eq!(parsed.vectors[0].from, "W-*/2/46");
        assert_eq!(parsed.vectors[0].to, "W-*/2/50");
        assert_eq!(parsed.vectors[1].from, "W-*/2/50");
        assert_eq!(parsed.vectors[2].to, "W-*/2/52");
        // No LRUD was leaked from the names.
        assert!(parsed
            .vectors
            .iter()
            .all(|v| v.left.is_none() && v.right.is_none() && v.up.is_none() && v.down.is_none()));
        // The three shots form ONE head-to-tail chain (one section), not three
        // fragments hanging off a phantom hub.
        let (configs, _closures, _w) = convert_one(parsed);
        assert_eq!(
            configs.len(),
            1,
            "star-named stations must chain into a single section, got {configs:?}"
        );
    }

    #[test]
    fn multi_dash_station_is_anonymous_not_named() {
        // Regression: a from/to station of two-or-more dashes (`--`, `---`) is an
        // anonymous wall/splay endpoint per Walls/dewalls (`optionalStationRx =
        // "-+"`), not a real station. Corpus: survex/walls.srv uses `U3 -- 7.8
        // 098.7`. Previously only a single `-` was anonymous, so `--` became a
        // real station literally named `--`, and every `... -- ...` leg merged
        // onto one phantom node.
        // Genuine Walls `name_isnull` only treats `-` and `--` as null/anonymous;
        // `---`+ is a REAL station name and must NOT be flagged anonymous.
        assert!(is_anonymous("-"));
        assert!(is_anonymous("--"));
        assert!(!is_anonymous("---"), "3+ dashes is a real station in Walls");
        assert!(!is_anonymous("----"));
        assert!(!is_anonymous("U3"));
        assert!(!is_anonymous(""));

        // Two distinct legs each ending at `--` must NOT share a station: with
        // splays included they get globally-unique synthetic anon names.
        let srv = "#UNITS meters order=DAV\n\
                   U3 -- 7.8 098.7 0\n\
                   U5 -- 4.2 120.0 0\n";
        let survey = parse_srv(srv);
        // Both legs parse with the dashed endpoint flagged anonymous.
        assert_eq!(survey.vectors.len(), 2);
        assert!(survey.vectors.iter().all(|v| v.to_anon && v.is_reference));
        let parsed = ParsedWalls {
            project_name: "T".to_string(),
            book_count: 0,
            surveys: vec![survey],
            georef: None,
            missing_files: Vec::new(),
            skipped_attachments: 0,
            warnings: Vec::new(),
        };
        let opts = WallsImportOptions {
            include_splays: true,
            ..Default::default()
        };
        let (configs, _closures, _w) = convert_walls_to_import_configs(&parsed, &opts).unwrap();
        // The two splays import as reference shots and stay independent — there
        // is no real shared station named after the dashes (the regression
        // produced a phantom `--` hub joining unrelated splays).
        let splay_shots: usize = configs.iter().map(|c| c.shots.len()).sum();
        assert_eq!(splay_shots, 2, "both splay legs import, got {configs:?}");
    }

    #[test]
    fn wpj_no_grid_bit_does_not_rotate_azimuth() {
        // Regression (root grid_relative defaulted to `true`): a .wpj that
        // carries a .REF with nonzero grid convergence but sets NO grid STATUS
        // bit must NOT rotate azimuths — matching dewalls
        // `WpjEntry::gridRelative()` (false at the root) and our own
        // `derive_decl: false` default. Convergence here is 5°; a 90° reading
        // must import as 90°, not 85°.
        let dir = temp_dir("wpjgrid");
        std::fs::write(dir.join("S.SRV"), "#UNITS meters order=DAV\nA B 10 90 0\n").unwrap();
        let wpj = ";WALLS Project File\n\
                   .BOOK Root\n.NAME ROOT\n.STATUS 8\n\
                   .REF 2258942.000 467427.000 16 5.0 30 6 20 25 42.950 87 18 44.073 19 \"NAD83\"\n\
                   .SURVEY S\n.NAME S\n.STATUS 8\n\
                   .ENDBOOK\n";
        let wpj_path = dir.join("T.wpj");
        std::fs::write(&wpj_path, wpj).unwrap();
        let parsed = parse_walls(&wpj_path).unwrap();
        let (configs, _c, _w) =
            convert_walls_to_import_configs(&parsed, &WallsImportOptions::default()).unwrap();
        assert!(!configs.is_empty(), "survey must resolve");
        assert!(
            approx(configs[0].shots[0].azimuth_in, 90.0),
            "no grid bit => convergence must not rotate the azimuth, got {}",
            configs[0].shots[0].azimuth_in
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn star_named_station_still_allows_real_lrud() {
        // A literal `*` in the station name AND a genuine `*…*` LRUD on the same
        // line: the name keeps its `*`, the space-delimited `*L R U D*` is read.
        let srv = "#UNITS meters order=DAV LRUD=F:LRUD\nA*1 B*2 10 90 0 *1 2 3 4*\n";
        let v = &parse_srv(srv).vectors[0];
        assert_eq!(v.from, "A*1");
        assert_eq!(v.to, "B*2");
        assert_eq!(v.left, Some(1.0));
        assert_eq!(v.right, Some(2.0));
        assert_eq!(v.up, Some(3.0));
        assert_eq!(v.down, Some(4.0));
    }

    #[test]
    fn unterminated_star_is_a_station_name_not_lrud() {
        // Genuine Walls only treats a token-initial `*` as an LRUD when a closing
        // `*` is followed by whitespace/EOL (wall-srv.cpp:1173). An unterminated
        // `*8` is a real to-station named `*8` (e.g. `U23 *8 5 15`), not an LRUD
        // that swallows the measurement columns.
        let srv = "#UNITS meters order=DAV\nU23 *8 5 15 0\n";
        let v = &parse_srv(srv).vectors[0];
        assert_eq!(v.from, "U23");
        assert_eq!(v.to, "*8", "unterminated `*8` is the to-station name");
        assert!((v.length_m - 5.0).abs() < 1e-9, "distance column read");
        // A REAL terminated LRUD still works (closer before whitespace).
        let v2 =
            &parse_srv("#UNITS meters order=DAV LRUD=F:LRUD\nA B 10 90 0 *1 2 3 4* x\n").vectors[0];
        assert_eq!(v2.left, Some(1.0));
        assert_eq!(v2.down, Some(4.0));
    }

    #[test]
    fn triple_dash_is_a_real_station_not_anonymous() {
        // Genuine Walls `name_isnull` flags only `-`/`--`; `---` is a real station
        // name. Two legs ending at `---` must therefore tie to the SAME station
        // (a real shared point), not become independent splays.
        let srv = "#UNITS meters order=DAV\nA --- 10 90 0\nB --- 8 180 0\n";
        let survey = parse_srv(srv);
        assert_eq!(survey.vectors.len(), 2);
        assert!(
            survey
                .vectors
                .iter()
                .all(|v| v.to == "---" && !v.to_anon && !v.is_reference),
            "`---` is a real, non-anonymous station"
        );
    }

    #[test]
    fn comment_stripped_from_vector() {
        let srv = "#UNITS meters ORDER=DA Tape=SS\nA B 10 90 5 5 ; tie in DM RED\n";
        let v = &parse_srv(srv).vectors[0];
        assert_eq!(v.comment.as_deref(), Some("tie in DM RED"));
    }

    // ----- conversion: chains, closures -----------------------------------

    #[test]
    fn branch_splits_into_sections_with_closure() {
        // A-B-C linear, then a branch D-B (shares B) plus a loop back C-A.
        let srv = "#UNITS meters order=DAV\n\
                   A B 10 90 0\n\
                   B C 10 0 0\n\
                   D B 10 45 0\n\
                   C A 14 200 0\n";
        let (configs, closures, _w) = convert_one(parse_srv(srv));
        // Three chains: [A,B,C], [D,B], [C,A].
        assert_eq!(configs.len(), 3);
        // Non-tree shared stations produce closures (B and the C/A loop).
        assert!(!closures.is_empty());
        // FromImporting targets precede dependents after topo-sort.
        let first = &configs[0];
        assert!(matches!(
            first.placement,
            ImportPlacement::Origin | ImportPlacement::FromImporting { .. }
        ));
    }

    // ----- .WPJ tree ------------------------------------------------------

    #[test]
    fn wpj_tree_status_inheritance_and_resolution() {
        let dir = temp_dir("wpj");
        std::fs::write(
            dir.join("SURV1.SRV"),
            "#UNITS meters ORDER=DA Tape=SS\nA B 10 90 5 5\n",
        )
        .unwrap();
        let wpj = format!(
            ";WALLS Project File\n\
             .BOOK Test Project\n.NAME TESTPROJ\n.STATUS 1051139\n\
             .REF 2258942.000 467427.000 16 -0.109 30 6 20 25 42.950 87 18 44.073 19 \"NAD83\"\n\
             .BOOK Area One\n.NAME AREA1\n.STATUS 8\n\
             .SURVEY First Survey\n.NAME SURV1\n.STATUS 8\n\
             .SURVEY An Attachment.svgz\n.NAME An Attachment.svgz\n.STATUS 65544\n\
             .SURVEY Detached Survey\n.NAME SURV2\n.STATUS 10\n\
             .SURVEY Missing One\n.NAME MISSING\n.STATUS 8\n\
             .ENDBOOK\n.ENDBOOK\n"
        );
        let wpj_path = dir.join("Test.wpj");
        std::fs::write(&wpj_path, wpj).unwrap();

        let parsed = parse_walls(&wpj_path).unwrap();
        assert_eq!(parsed.book_count, 2);
        // surveys vec: SURV1 (resolved) + MISSING (unresolved). Attachment +
        // detached are skipped.
        assert_eq!(parsed.surveys.len(), 2);
        assert_eq!(parsed.skipped_attachments, 1);
        assert_eq!(parsed.missing_files.len(), 1);
        let resolved: Vec<_> = parsed.surveys.iter().filter(|s| s.resolved).collect();
        assert_eq!(resolved.len(), 1);
        assert_eq!(resolved[0].vectors.len(), 1);
        // NAME_DEFINES_SEGMENT (bit 3) on the book AND the survey both
        // contribute a segment level (the root has bit 3 clear).
        assert_eq!(resolved[0].segment, "AREA1/SURV1");

        let preview = build_preview(&parsed);
        assert_eq!(preview.utm_zone, Some(16));
        assert_eq!(preview.datum.as_deref(), Some("NAD83"));
        assert!(preview.has_georeference);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn ref_line_decodes_lat_long() {
        let r = parse_ref(
            "2258942.000 467427.000 16 -0.109 30 6 20 25 42.950 87 18 44.073 19 \"NAD83\"",
        )
        .unwrap();
        assert_eq!(r.zone, 16);
        assert_eq!(r.datum, "NAD83");
        assert!(approx(r.convergence, -0.109));
        // lat 20 25 42.95 N (flags bit 0x08 not set -> +); lon West (0x04) -> negative
        assert!((r.latitude - 20.4286).abs() < 0.01);
        assert!((r.longitude - (-87.3122)).abs() < 0.01);
    }

    #[test]
    fn latin1_decoding() {
        let dir = temp_dir("latin1");
        let p = dir.join("name.srv");
        // 0xE4 == 'ä' in Latin-1.
        std::fs::write(&p, [b';', b' ', 0xE4, b'\n']).unwrap();
        let s = read_latin1(&p).unwrap();
        assert!(s.contains('\u{00E4}'));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn fix_geographic_anchor_becomes_zero_datum() {
        let srv = "#UNITS meters order=DAV\n\
                   #FIX A0 W87:18:44 N20:25:42 0\n\
                   A0 B 10 90 0\n";
        let mut warnings = Vec::new();
        let survey = parse_srv_contents(
            srv,
            "Fixed",
            "FIX",
            "",
            &WallsUnits::default(),
            &HashMap::new(),
            None,
            true,
            false,
            &mut warnings,
        );
        assert_eq!(survey.fixes.len(), 1);
        assert!(survey.fixes[0].lat_long.is_some());
        let (configs, _c, _w) = convert_one(survey);
        assert!(configs
            .iter()
            .any(|c| matches!(c.placement, ImportPlacement::ZeroDatum { .. })));
    }

    // ----- regression tests for adversarial-review fixes -------------------

    fn convert_survey_with(
        survey: ParsedSurvey,
        georef: Option<WallsRef>,
        opts: &WallsImportOptions,
    ) -> (Vec<ImportSectionConfig>, Vec<ImportClosure>, Vec<String>) {
        let parsed = ParsedWalls {
            project_name: "T".to_string(),
            book_count: 0,
            surveys: vec![survey],
            georef,
            missing_files: Vec::new(),
            skipped_attachments: 0,
            warnings: Vec::new(),
        };
        convert_walls_to_import_configs(&parsed, opts).unwrap()
    }

    #[test]
    fn selected_surveys_filters_conversion() {
        // Two surveys with disjoint station namespaces -> separate sections.
        let s0 = parse_srv("#UNITS meters order=DAV\nA0 A1 10 90 0\nA1 A2 10 90 0\n");
        let s1 = parse_srv("#UNITS meters order=DAV\nB0 B1 10 90 0\nB1 B2 10 90 0\n");
        let parsed = ParsedWalls {
            project_name: "T".to_string(),
            book_count: 0,
            surveys: vec![s0, s1],
            georef: None,
            missing_files: Vec::new(),
            skipped_attachments: 0,
            warnings: Vec::new(),
        };
        let conv = |sel: Option<HashSet<u32>>| {
            convert_walls_to_import_configs(
                &parsed,
                &WallsImportOptions {
                    selected_surveys: sel,
                    ..Default::default()
                },
            )
            .unwrap()
            .0
        };

        let all = conv(None);
        let only0 = conv(Some([0].into_iter().collect()));
        let only1 = conv(Some([1].into_iter().collect()));
        let none = conv(Some(HashSet::new()));

        assert!(!all.is_empty(), "all surveys produce sections");
        assert!(!only0.is_empty() && !only1.is_empty());
        // Selecting each survey alone partitions the full output exactly.
        assert_eq!(
            only0.len() + only1.len(),
            all.len(),
            "per-survey selections must partition the unfiltered conversion"
        );
        assert!(none.is_empty(), "empty selection imports nothing");
    }

    // ----- directive comment / stray-space robustness ---------------------

    #[test]
    fn strip_inline_comment_respects_quotes() {
        assert_eq!(strip_inline_comment("2008-12-01\t;TODO x"), "2008-12-01\t");
        assert_eq!(
            strip_inline_comment("2000-06-06; oraz 2000-06-30"),
            "2000-06-06"
        );
        assert_eq!(strip_inline_comment("2003-08-01;TODO"), "2003-08-01");
        assert_eq!(strip_inline_comment("flag=\"a;b\" x"), "flag=\"a;b\" x");
        assert_eq!(strip_inline_comment("no comment here"), "no comment here");
    }

    #[test]
    fn date_directive_ignores_trailing_comment() {
        // Real KATASTER lines: a valid date followed by a `;`-comment (tab- or
        // space-separated, or glued straight on) must still parse.
        for srv in [
            "#DATE 2008-12-01\t;TODO dzien nieznany\nA B 10 90 0\n",
            "#date 2000-06-06; oraz 2000-06-30\nA B 10 90 0\n",
            "#DATE 2003-08-01;TODO szacunkowa\nA B 10 90 0\n",
        ] {
            let mut warnings = Vec::new();
            let survey = parse_srv_contents(
                srv,
                "t",
                "t",
                "",
                &WallsUnits::default(),
                &HashMap::new(),
                None,
                true,
                false,
                &mut warnings,
            );
            assert!(
                survey.date.is_some(),
                "date must parse despite comment: {srv:?}"
            );
            assert!(
                !warnings.iter().any(|w| w.contains("unrecognized #Date")),
                "no #Date warning expected, got {warnings:?}"
            );
        }
    }

    #[test]
    fn collapse_eq_spaces_glues_values_outside_quotes() {
        assert_eq!(collapse_eq_spaces("order =DAV"), "order=DAV");
        assert_eq!(collapse_eq_spaces("order= DAV"), "order=DAV");
        assert_eq!(collapse_eq_spaces("order = DAV"), "order=DAV");
        assert_eq!(collapse_eq_spaces("meters decl=2"), "meters decl=2");
        assert_eq!(collapse_eq_spaces("flag=\"a b\""), "flag=\"a b\"");
        // A space inside a quoted value is preserved.
        assert_eq!(collapse_eq_spaces("f=\"a = b\""), "f=\"a = b\"");
    }

    #[test]
    fn units_tolerates_stray_spaces_around_equals() {
        // `order =ADV` (space before `=`) previously produced "Unknown #units
        // option ''"; `order= ADV` produced "Order=''" + "'adv'". Both must now
        // be read as `order=ADV` with no spurious warnings.
        for srv in [
            "#UNITS meters order =ADV\nA B 10 5 0\n",
            "#UNITS meters order= ADV\nA B 10 5 0\n",
        ] {
            let mut warnings = Vec::new();
            let survey = parse_srv_contents(
                srv,
                "t",
                "t",
                "",
                &WallsUnits::default(),
                &HashMap::new(),
                None,
                true,
                false,
                &mut warnings,
            );
            assert!(
                !warnings
                    .iter()
                    .any(|w| w.contains("Unknown #units option") || w.contains("Order=")),
                "stray spaces around = must not warn: {warnings:?}"
            );
            // order=ADV puts Distance in the 2nd column, so `A B 10 5 0` has
            // length 5 (not the default DAV's 10) — proving the order applied.
            assert_eq!(survey.vectors.len(), 1);
            assert!(
                (survey.vectors[0].length_m - 5.0).abs() < 1e-9,
                "order=ADV must apply (distance is column 2), got {}",
                survey.vectors[0].length_m
            );
        }
    }

    #[test]
    fn zero_length_tie_clamped_not_rejected() {
        // `A B 0 0 0` is a coincident-station tie; the model forbids 0 length, so
        // the importer must emit a positive (negligible) length instead of a
        // zero-length shot that execute_import_sections would reject outright.
        let srv = "#UNITS meters order=DAV\nA B 0 0 0\nB C 10 90 0\n";
        let (configs, _closures, warnings) = convert_one(parse_srv(srv));
        assert!(
            configs
                .iter()
                .all(|c| c.shots.iter().all(|s| s.length > 0.0)),
            "no zero-length shot may be emitted: {configs:?}"
        );
        assert!(
            warnings
                .iter()
                .any(|w| w.contains("coincident-station tie")),
            "expected an aggregated coincident-tie warning, got {warnings:?}"
        );
    }

    fn test_ref(convergence: f64, lat: f64, lon: f64) -> WallsRef {
        WallsRef {
            zone: 16,
            convergence,
            latitude: lat,
            longitude: lon,
            datum: "WGS84".to_string(),
        }
    }

    fn parse_srv_geo(content: &str, georef: Option<WallsRef>, derive_decl: bool) -> ParsedSurvey {
        let mut w = Vec::new();
        parse_srv_contents(
            content,
            "t",
            "t",
            "",
            &WallsUnits::default(),
            &HashMap::new(),
            georef,
            true,
            derive_decl,
            &mut w,
        )
    }

    #[test]
    fn splays_do_not_merge_unrelated_sections() {
        // Two geometrically unrelated sub-surveys, each with an anonymous wall
        // splay. Their "-" endpoints must NOT collapse to one shared station.
        let srv = "#UNITS meters order=DAV\n\
                   A1 A2 10 0 0\n\
                   A1 - 3 90 0\n\
                   B1 B2 10 0 0\n\
                   B1 - 3 90 0\n";
        let opts = WallsImportOptions {
            comments_on_stations: true,
            include_splays: true,
            ..Default::default()
        };
        let (configs, closures, _w) = convert_survey_with(parse_srv(srv), None, &opts);
        // The A-component and B-component are separate -> two Origin roots.
        let origins = configs
            .iter()
            .filter(|c| matches!(c.placement, ImportPlacement::Origin))
            .count();
        assert!(origins >= 2, "unrelated splay components must not merge");
        // No spurious closures from the shared anonymous marker.
        assert!(closures.is_empty(), "splays must not fabricate closures");
    }

    #[test]
    fn dive_shot_with_omitted_distance_kept_via_depth() {
        // Distance omitted (--) but the depth gauges give a real 5 -> 9 drop.
        let srv = "#UNITS meters ORDER=DA Tape=SS\n\
                   A B 10 90 5 5\n\
                   B C -- 90 5 9\n";
        let (configs, _c, _w) = convert_one(parse_srv(srv));
        let sec = &configs[0];
        assert_eq!(
            sec.shots.len(),
            2,
            "the zero-distance dive leg must survive"
        );
        assert!(approx(sec.shots[1].depth_out, 9.0));
        // Slope length clamped up to the depth change so the model can form it.
        assert!(sec.shots[1].length >= 4.0 - 1e-9);
    }

    #[test]
    fn auto_declination_gated_on_derive_flag() {
        // Alaska 2020 has a large (~16 deg E) declination.
        let georef = Some(test_ref(0.0, 60.0, -150.0));
        let srv = "#DATE 2020-01-01\n#UNITS meters order=DAV\nA B 10 90 0\n";

        let off = convert_survey_with(
            parse_srv_geo(srv, georef.clone(), false),
            georef.clone(),
            &WallsImportOptions::default(),
        )
        .0;
        assert!(
            approx(off[0].shots[0].azimuth_in, 90.0),
            "no flag -> no auto declination"
        );

        let on = convert_survey_with(
            parse_srv_geo(srv, georef.clone(), true),
            georef.clone(),
            &WallsImportOptions::default(),
        )
        .0;
        assert!(
            (on[0].shots[0].azimuth_in - 90.0).abs() > 1.0,
            "derive flag -> IGRF declination shifts the azimuth"
        );
    }

    #[test]
    fn convergence_applied_from_survey_georef() {
        // azimuth = reading(100) + decl(0) - convergence(2) = 98
        let georef = Some(test_ref(2.0, 0.0, 0.0));
        let (configs, _c, _w) = convert_survey_with(
            parse_srv_geo(
                "#UNITS meters order=DAV\nA B 10 100 0\n",
                georef.clone(),
                false,
            ),
            georef.clone(),
            &WallsImportOptions::default(),
        );
        assert!(approx(configs[0].shots[0].azimuth_in, 98.0));
    }

    #[test]
    fn explicit_decl_zero_suppresses_auto_derivation() {
        // Same large-declination georef as `auto_declination_gated_on_derive_flag`,
        // derive flag ON, but the survey pins `Decl=0` — auto-IGRF must NOT fire.
        let georef = Some(test_ref(0.0, 60.0, -150.0));
        let srv = "#DATE 2020-01-01\n#UNITS meters order=DAV Decl=0\nA B 10 90 0\n";
        let configs = convert_survey_with(
            parse_srv_geo(srv, georef.clone(), true),
            georef.clone(),
            &WallsImportOptions::default(),
        )
        .0;
        assert!(
            approx(configs[0].shots[0].azimuth_in, 90.0),
            "explicit Decl=0 must override the derive flag (no IGRF rotation)"
        );
    }

    #[test]
    fn fix_assigns_lat_long_by_prefix_not_column() {
        // Coordinates written latitude-first (N before W) under the default
        // East,North order must still resolve to the right hemisphere.
        let srv = "#UNITS meters order=DAV\n\
                   #FIX A0 N20:25:42 W87:18:44 0\n\
                   A0 B 10 90 0\n";
        let survey = parse_srv(srv);
        let (lat, lon) = survey.fixes[0].lat_long.expect("geographic fix");
        assert!(
            (lat - 20.4283).abs() < 0.01,
            "N20 must be latitude, got {lat}"
        );
        assert!(
            (lon - (-87.3122)).abs() < 0.01,
            "W87 must be longitude, got {lon}"
        );
    }

    #[test]
    fn unrecognized_datum_warns_on_utm_fix() {
        // A UTM #Fix under an unusual datum projects as WGS84 — warn about it.
        let georef = Some(WallsRef {
            zone: 16,
            convergence: 0.0,
            latitude: 20.0,
            longitude: -87.0,
            datum: "European 1950".to_string(),
        });
        let srv = "#UNITS meters order=DAV\n#FIX A0 467427 2258942 0\nA0 B 10 90 0\n";
        let mut warnings = Vec::new();
        parse_srv_contents(
            srv,
            "t",
            "t",
            "",
            &WallsUnits::default(),
            &HashMap::new(),
            georef,
            true,
            false,
            &mut warnings,
        );
        assert!(
            warnings.iter().any(|w| w.contains("not recognized")),
            "an unrecognized datum on a UTM #Fix should warn, got {warnings:?}"
        );
    }

    #[test]
    fn macro_preserves_non_ascii() {
        // 'Ä' (U+00C4) preceding a macro reference must survive expansion.
        let srv = "#UNITS $s=X\n\u{00C4}$(s) B 10 0 0\n";
        let v = &parse_srv(srv).vectors[0];
        assert_eq!(v.from, "\u{00C4}X");
    }

    #[test]
    fn non_finite_tokens_rejected() {
        assert_eq!(parse_length("nan", LengthUnit::Meters), None);
        assert_eq!(parse_length("inf", LengthUnit::Meters), None);
        assert_eq!(parse_length("1e999", LengthUnit::Meters), None);
        assert_eq!(parse_angle("nan", AngleUnit::Degrees), None);
        assert_eq!(parse_angle("1e999", AngleUnit::Degrees), None);
    }

    #[test]
    fn feet_inches_token_edges() {
        assert_eq!(parse_length("i", LengthUnit::Meters), None); // bare 'i'
        assert!(approx(
            parse_length("i6", LengthUnit::Meters).unwrap(),
            0.5 * FEET_TO_METERS
        ));
        assert!(approx(
            parse_length("5i", LengthUnit::Meters).unwrap(),
            5.0 * FEET_TO_METERS
        ));
        assert!(approx(
            parse_length("10i6", LengthUnit::Meters).unwrap(),
            10.5 * FEET_TO_METERS
        ));
    }

    #[test]
    fn resolve_survey_appends_srv_for_non_srv_extension() {
        let dir = temp_dir("ext");
        std::fs::write(dir.join("FOO.OLD.SRV"), "x").unwrap();
        let entry = WpjEntry {
            is_book: false,
            title: String::new(),
            name: Some("FOO.OLD".to_string()),
            status: 8,
            options: None,
            path: None,
            reference: None,
        };
        let ctx = WpjContext {
            dir: dir.clone(),
            options: Vec::new(),
            reference: None,
            segment: String::new(),
            derive_decl: false,
            grid_relative: true,
        };
        let resolved = resolve_survey(&entry, &ctx).unwrap();
        assert_eq!(
            resolved.file_name().unwrap().to_string_lossy(),
            "FOO.OLD.SRV"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    // ----- multiple-#Fix anchoring (one zero datum per component) ----------

    #[test]
    fn multiple_fixes_anchor_separate_components() {
        // Two unconnected sub-surveys, each with its own fixed station.
        let srv = "#UNITS meters order=DAV\n\
                   #FIX A0 W90:00:00 N30:00:00 0\n\
                   A0 A1 10 90 0\n\
                   #FIX B0 W91:00:00 N31:00:00 0\n\
                   B0 B1 10 90 0\n";
        let survey = parse_srv(srv);
        assert_eq!(
            survey.fixes.iter().filter(|f| f.lat_long.is_some()).count(),
            2
        );
        let (configs, _c, _w) = convert_one(survey);
        let datums = configs
            .iter()
            .filter(|c| matches!(c.placement, ImportPlacement::ZeroDatum { .. }))
            .count();
        assert_eq!(
            datums, 2,
            "each separate component with a #Fix gets its own datum"
        );
    }

    #[test]
    fn multiple_fixes_in_one_component_yield_single_datum() {
        // A0 ... J ... B0 — both fixed, but connected through J (one component).
        // The model forbids 2 datums in one merge component, so only ONE datum
        // is emitted and the other fixed station is merged + closed in.
        let srv = "#UNITS meters order=DAV\n\
                   #FIX A0 W90:00:00 N30:00:00 0\n\
                   #FIX B0 W91:00:00 N31:00:00 0\n\
                   A0 A1 10 90 0\n\
                   A1 J 10 90 0\n\
                   B0 J 10 270 0\n";
        let (configs, _closures, warnings) = convert_one(parse_srv(srv));
        let datums = configs
            .iter()
            .filter(|c| matches!(c.placement, ImportPlacement::ZeroDatum { .. }))
            .count();
        assert_eq!(datums, 1, "one zero datum per connected merge component");
        // The second fixed station rides in via a merge, not a second datum.
        assert!(configs
            .iter()
            .any(|c| matches!(c.placement, ImportPlacement::FromImporting { .. })));
        assert!(
            warnings.iter().any(|w| w.contains("other fixed station")),
            "should explain the extra fixed station"
        );
    }

    #[test]
    fn cross_section_loop_still_emits_closure() {
        // A-B-C, D-C, D-A: a loop spanning three legs must be closed.
        let srv = "#UNITS meters order=DAV\n\
                   A B 10 0 0\n\
                   B C 10 90 0\n\
                   D C 10 180 0\n\
                   D A 10 270 0\n";
        let (configs, closures, _w) = convert_one(parse_srv(srv));
        assert!(configs.len() >= 3);
        assert!(!closures.is_empty(), "a loop across survey legs must close");
    }

    #[test]
    fn unreferenced_fix_is_reported_not_anchored() {
        // GHOST is fixed but never appears in a shot -> no datum, with a warning.
        let srv = "#UNITS meters order=DAV\n\
                   #FIX GHOST W90:00:00 N30:00:00 0\n\
                   A B 10 90 0\n";
        let (configs, _c, warnings) = convert_one(parse_srv(srv));
        assert!(
            configs
                .iter()
                .all(|c| !matches!(c.placement, ImportPlacement::ZeroDatum { .. })),
            "an unreferenced #Fix anchors nothing"
        );
        assert!(warnings
            .iter()
            .any(|w| w.contains("isn't used by any shot")));
    }

    #[test]
    fn preview_reports_fixed_station_count() {
        let survey = parse_srv(
            "#UNITS meters order=DAV\n\
             #FIX A0 W90:00:00 N30:00:00 0\n\
             A0 A1 10 90 0\n",
        );
        let parsed = ParsedWalls {
            project_name: "T".to_string(),
            book_count: 0,
            surveys: vec![survey],
            georef: None,
            missing_files: Vec::new(),
            skipped_attachments: 0,
            warnings: Vec::new(),
        };
        let preview = build_preview(&parsed);
        assert_eq!(preview.fixed_station_count, 1);
    }

    #[test]
    fn end_to_end_import_respects_datum_invariants() {
        // Runs the REAL import (execute_import_sections enforces
        // `multiple_datums_per_merge_component`), so a successful result proves
        // the placement respects the model's one-datum-per-component invariant.
        use crate::core::state::AppState;
        use crate::core::Command;

        let run = |srv: &str| -> (bool, Option<String>, usize) {
            let (sections, closures, _w) = convert_one(parse_srv(srv));
            let state = AppState::new().unwrap();
            state.execute(Command::CreateProject {
                name: "T".to_string(),
                location: None,
            });
            let result =
                state.execute_import_sections(sections, closures, None, Vec::new(), Vec::new());
            let datums = state
                .get_project_state()
                .map(|p| p.zero_datums.len())
                .unwrap_or(0);
            (result.success, result.error, datums)
        };

        // Two separate components, each with its own #Fix -> 2 datums, OK.
        let (ok2, err2, d2) = run("#UNITS meters order=DAV\n\
             #FIX A0 W90:00:00 N30:00:00 0\n\
             A0 A1 10 90 0\n\
             #FIX B0 W91:00:00 N31:00:00 0\n\
             B0 B1 10 90 0\n");
        assert!(ok2, "two-datum import should succeed: {err2:?}");
        assert_eq!(d2, 2);

        // Two #Fix in ONE connected component -> exactly 1 datum, import still
        // succeeds (no multiple_datums_per_merge_component violation).
        let (ok1, err1, d1) = run("#UNITS meters order=DAV\n\
             #FIX A0 W90:00:00 N30:00:00 0\n\
             #FIX B0 W91:00:00 N31:00:00 0\n\
             A0 A1 10 90 0\n\
             A1 J 10 90 0\n\
             B0 J 10 270 0\n");
        assert!(
            ok1,
            "single-datum component import should succeed: {err1:?}"
        );
        assert_eq!(
            d1, 1,
            "exactly one datum survives in a single merge component"
        );
    }

    // ----- ignored real-data validation (no project files committed) -------

    #[test]
    #[ignore]
    fn real_qr_project_tree() {
        let wpj = match std::env::var_os("WALLS_WPJ") {
            Some(p) => PathBuf::from(p),
            None => {
                let home = std::env::var("HOME").unwrap_or_default();
                PathBuf::from(home).join("src/cave/data/qr/Quintana Roo.wpj")
            }
        };
        if !wpj.exists() {
            eprintln!("skip: {} not found", wpj.display());
            return;
        }
        let parsed = parse_walls(&wpj).unwrap();
        let resolved = parsed.surveys.iter().filter(|s| s.resolved).count();
        println!(
            "QR .wpj: books={} surveys={} resolved={} missing={} skipped_attachments={} warnings={}",
            parsed.book_count,
            parsed.surveys.len(),
            resolved,
            parsed.missing_files.len(),
            parsed.skipped_attachments,
            parsed.warnings.len(),
        );
        let preview = build_preview(&parsed);
        println!(
            "preview: zone={:?} datum={:?} georef={}",
            preview.utm_zone, preview.datum, preview.has_georeference
        );
        assert!(parsed.book_count >= 250);
        assert!(parsed.surveys.len() >= 1500);
        assert_eq!(preview.utm_zone, Some(16));
    }

    #[test]
    #[ignore]
    fn real_qr_srv_dir() {
        let Some(dir) = std::env::var_os("WALLS_SRV_DIR") else {
            eprintln!("skip: set WALLS_SRV_DIR to a folder of real .SRV files");
            return;
        };
        let dir = PathBuf::from(dir);
        let mut total_shots = 0usize;
        let mut files = 0usize;
        for entry in std::fs::read_dir(&dir).unwrap() {
            let p = entry.unwrap().path();
            let is_srv = p
                .extension()
                .and_then(|e| e.to_str())
                .map(|e| e.eq_ignore_ascii_case("srv"))
                .unwrap_or(false);
            if !is_srv {
                continue;
            }
            files += 1;
            let parsed = parse_walls(&p).unwrap();
            let shots: usize = parsed.surveys.iter().map(|s| s.vectors.len()).sum();
            let (configs, closures, warnings) =
                convert_walls_to_import_configs(&parsed, &WallsImportOptions::default()).unwrap();
            println!(
                "{}: {} shots -> {} sections, {} closures, {} warnings",
                p.file_name().unwrap().to_string_lossy(),
                shots,
                configs.len(),
                closures.len(),
                warnings.len(),
            );
            total_shots += shots;
        }
        println!("parsed {files} files, {total_shots} shots total");
        assert!(files > 0);
        assert!(total_shots > 0);
    }

    /// Recursively parse EVERY `.wpj` (full project) and `.srv` (standalone)
    /// under `WALLS_CORPUS`, catching panics, and report a summary. Used to
    /// sweep the public test corpus.
    #[test]
    #[ignore]
    fn corpus_sweep() {
        let Some(root) = std::env::var_os("WALLS_CORPUS") else {
            eprintln!("skip: set WALLS_CORPUS to a directory tree of Walls files");
            return;
        };
        fn walk(dir: &Path, out: &mut Vec<PathBuf>) {
            if let Ok(rd) = std::fs::read_dir(dir) {
                for e in rd.flatten() {
                    let p = e.path();
                    if p.is_dir() {
                        walk(&p, out);
                    } else if let Some(ext) = p.extension().and_then(|e| e.to_str()) {
                        let ext = ext.to_ascii_lowercase();
                        if ext == "wpj" || ext == "srv" {
                            out.push(p);
                        }
                    }
                }
            }
        }
        let mut files = Vec::new();
        walk(&PathBuf::from(root), &mut files);
        files.sort();

        let (mut wpj_ok, mut srv_ok) = (0usize, 0usize);
        let (
            mut total_shots,
            mut total_sections,
            mut total_closures,
            mut total_datums,
            mut total_warnings,
        ) = (0usize, 0usize, 0usize, 0usize, 0usize);
        let mut errored: Vec<String> = Vec::new();
        let mut panicked: Vec<String> = Vec::new();
        let mut by_shots: Vec<(usize, String)> = Vec::new();

        for f in &files {
            let is_wpj = f
                .extension()
                .and_then(|e| e.to_str())
                .map(|e| e.eq_ignore_ascii_case("wpj"))
                .unwrap_or(false);
            let outcome = std::panic::catch_unwind(|| {
                let parsed = parse_walls(f)?;
                let shots: usize = parsed.surveys.iter().map(|s| s.vectors.len()).sum();
                let (configs, closures, warnings) =
                    convert_walls_to_import_configs(&parsed, &WallsImportOptions::default())?;
                let datums = configs
                    .iter()
                    .filter(|c| matches!(c.placement, ImportPlacement::ZeroDatum { .. }))
                    .count();
                Ok::<_, anyhow::Error>((
                    shots,
                    configs.len(),
                    closures.len(),
                    warnings.len(),
                    datums,
                ))
            });
            match outcome {
                Ok(Ok((shots, sections, closures, warnings, datums))) => {
                    if is_wpj {
                        wpj_ok += 1;
                    } else {
                        srv_ok += 1;
                    }
                    total_shots += shots;
                    total_sections += sections;
                    total_closures += closures;
                    total_datums += datums;
                    total_warnings += warnings;
                    by_shots.push((shots, f.display().to_string()));
                }
                Ok(Err(e)) => errored.push(format!("{}: {e}", f.display())),
                Err(_) => panicked.push(f.display().to_string()),
            }
        }

        println!(
            "CORPUS SWEEP: {} files parsed ({} wpj, {} srv); errored {}, panicked {}",
            files.len(),
            wpj_ok,
            srv_ok,
            errored.len(),
            panicked.len()
        );
        println!(
            "  totals: {total_shots} shots, {total_sections} sections, {total_closures} closures, \
             {total_datums} zero-datums, {total_warnings} warnings"
        );
        by_shots.sort_by(|a, b| b.0.cmp(&a.0));
        println!("  top files by shot count:");
        for (shots, name) in by_shots.iter().take(12) {
            println!("    {shots:>8}  {name}");
        }
        for e in &errored {
            println!("  ERROR  {e}");
        }
        for p in &panicked {
            println!("  PANIC  {p}");
        }
        assert!(
            panicked.is_empty(),
            "parser panicked on {} file(s)",
            panicked.len()
        );
        assert!(
            errored.is_empty(),
            "parser errored on {} file(s)",
            errored.len()
        );
    }

    // ----- regression tests for review fixes -------------------------------

    #[test]
    fn quadrant_azimuth_parsed() {
        // Walls quadrant bearings must resolve, not silently fall through to 0.
        assert!(approx(
            parse_angle("N79E", AngleUnit::Degrees).unwrap(),
            79.0
        ));
        assert!(approx(
            parse_angle("S79W", AngleUnit::Degrees).unwrap(),
            259.0
        ));
        assert!(approx(
            parse_angle("N30W", AngleUnit::Degrees).unwrap(),
            330.0
        ));
        assert!(approx(
            parse_angle("S45E", AngleUnit::Degrees).unwrap(),
            135.0
        ));
        // DMS magnitude inside a quadrant bearing.
        assert!(approx(
            parse_angle("N12:30E", AngleUnit::Degrees).unwrap(),
            12.5
        ));
        // Magnitude honors the azimuth unit.
        assert!(approx(
            parse_angle("N100W", AngleUnit::Grads).unwrap(),
            270.0
        ));
        // Plain values and non-quadrant junk still behave.
        assert!(approx(parse_angle("90", AngleUnit::Degrees).unwrap(), 90.0));
        assert_eq!(parse_angle("NE", AngleUnit::Degrees), None);
        assert_eq!(parse_angle("N", AngleUnit::Degrees), None);
    }

    #[test]
    fn feet_inches_sign_preserved() {
        // The whole feet-and-inches token shares the leading sign.
        assert!(approx(
            parse_length("-0i7", LengthUnit::Meters).unwrap(),
            -(7.0 / 12.0) * FEET_TO_METERS
        ));
        assert!(approx(
            parse_length("-2i6", LengthUnit::Meters).unwrap(),
            -2.5 * FEET_TO_METERS
        ));
        assert!(approx(
            parse_length("2i6", LengthUnit::Meters).unwrap(),
            2.5 * FEET_TO_METERS
        ));
        assert!(approx(
            parse_length("i7", LengthUnit::Meters).unwrap(),
            (7.0 / 12.0) * FEET_TO_METERS
        ));
    }

    #[test]
    fn floated_variance_leg_is_kept() {
        // A real measured leg with a floated `(?)` variance is NOT a splay and
        // must survive the default import (include_splays = false).
        let srv = "#UNITS meters order=DAV\n\
                   A B 10 90 0 (?)\n";
        let (configs, _c, _w) = convert_one(parse_srv(srv));
        assert_eq!(configs.len(), 1);
        assert_eq!(
            configs[0].shots.len(),
            1,
            "floated-variance leg must not be dropped as a splay"
        );
        assert!(!configs[0].shots[0].is_reference);
    }

    #[test]
    fn fix_elevation_read_under_dive_order() {
        // `Order=DA` (no Up element) must NOT truncate the #Fix elevation column.
        let srv = "#UNITS meters ORDER=DA Tape=SS\n\
                   #FIX A0 5 10 100\n\
                   A0 B 8 90 5 5\n";
        let survey = parse_srv(srv);
        assert_eq!(survey.fixes.len(), 1);
        assert_eq!(
            survey.fixes[0].up,
            Some(100.0),
            "elevation column must be read regardless of vector Order="
        );
    }

    #[test]
    fn rect_vector_skips_declination() {
        // RECT E/N/U deltas already carry an absolute grid azimuth; an explicit
        // Decl must NOT rotate them.
        let srv = "#UNITS RECT order=ENU Decl=5\n\
                   A B 0 10 0\n";
        let (configs, _c, _w) = convert_one(parse_srv(srv));
        let shot = &configs[0].shots[0];
        assert!(
            approx(shot.azimuth_in, 0.0),
            "rect azimuth must stay grid-north, got {}",
            shot.azimuth_in
        );
    }

    #[test]
    fn rect_angle_rotates_bearing() {
        // `#Units RECT=90` rotates the E/N frame 90° clockwise from north, so a
        // vector along +N (E=0, N=10) reads 0° in-frame -> 90° after rotation.
        let srv = "#UNITS RECT=90 order=ENU\n\
                   A B 0 10 0\n";
        let (configs, _c, _w) = convert_one(parse_srv(srv));
        let shot = &configs[0].shots[0];
        assert!(
            approx(shot.azimuth_in, 90.0),
            "RECT=90 must rotate the bearing to 90°, got {}",
            shot.azimuth_in
        );
    }

    #[test]
    fn rect_frame_angle_does_not_leak_into_later_ct() {
        // `RECT=90` sets the rectangular frame bearing; switching to `CT` must NOT
        // carry that 90° in as a (negative) grid convergence on later CT shots —
        // `rect` and `grid` are distinct fields consumed with opposite signs.
        let srv = "#UNITS RECT=90 order=ENU\n\
                   A B 0 10 0\n\
                   #UNITS CT order=DAV\n\
                   B C 10 100 0\n";
        let (configs, _c, _w) = convert_one(parse_srv(srv));
        let azimuths: Vec<f64> = configs
            .iter()
            .flat_map(|c| c.shots.iter().map(|s| s.azimuth_in))
            .collect();
        assert!(
            azimuths.iter().any(|&a| approx(a, 100.0)),
            "CT azimuth must stay 100° (RECT frame angle must not leak as convergence), got {azimuths:?}"
        );
        assert!(
            !azimuths.iter().any(|&a| approx(a, 10.0)),
            "no shot should be rotated to 10° by a leaked RECT angle, got {azimuths:?}"
        );
    }

    #[test]
    fn units_grid_convergence_subtracted_from_ct() {
        // `#Units Grid=2` is a manual grid convergence: azimuth = reading(100) +
        // decl(0) - convergence(2) = 98, exactly like a `.REF` convergence.
        let srv = "#UNITS meters order=DAV Grid=2\n\
                   A B 10 100 0\n";
        let (configs, _c, _w) = convert_one(parse_srv(srv));
        assert!(
            approx(configs[0].shots[0].azimuth_in, 98.0),
            "#Units Grid=2 must subtract 2° of convergence, got {}",
            configs[0].shots[0].azimuth_in
        );
    }

    #[test]
    fn out_of_range_date_warns_on_declination_derive() {
        // The bundled IGRF model stops at 2025; a later survey date with the
        // derive flag on must warn instead of silently using 0° declination.
        let georef = Some(test_ref(0.0, 60.0, -150.0));
        let srv = "#DATE 2030-01-01\n#UNITS meters order=DAV\nA B 10 90 0\n";
        let (configs, _c, warnings) = convert_survey_with(
            parse_srv_geo(srv, georef.clone(), true),
            georef,
            &WallsImportOptions::default(),
        );
        assert!(
            approx(configs[0].shots[0].azimuth_in, 90.0),
            "out-of-range derive must fall back to 0° declination"
        );
        assert!(
            warnings
                .iter()
                .any(|w| w.contains("declination") && w.contains("IGRF")),
            "an out-of-range derive date must warn, got {warnings:?}"
        );
    }

    #[test]
    fn utm_to_wgs84_reference_lat_long_not_swapped() {
        // Zone 16N easting/northing from the `.REF` fixture -> lat ~20.43°N,
        // lon ~-87.31°. Confirms this importer returns (lat, lon) — a swap would
        // put lat at ~-87 (out of the [-90, 90] band) and be obviously wrong.
        let (lat, lon) = utm_to_wgs84(467427.0, 2258942.0, 16, "NAD83").unwrap();
        assert!((lat - 20.43).abs() < 0.1, "latitude {lat}");
        assert!((lon + 87.31).abs() < 0.1, "longitude {lon}");
    }

    #[test]
    fn unparseable_decl_warns_and_keeps_state() {
        // A garbage Decl must warn and leave the current declination state
        // untouched, NOT pin an explicit 0 (which would suppress auto-derive).
        let mut units = WallsUnits::default();
        let mut stack = Vec::new();
        let mut warns = Vec::new();
        apply_units_option(&mut units, "decl", Some("3"), &mut stack, &mut warns);
        assert_eq!(units.decl, Some(3.0));
        apply_units_option(&mut units, "decl", Some("oops"), &mut stack, &mut warns);
        assert_eq!(
            units.decl,
            Some(3.0),
            "unparseable Decl must not overwrite a real value"
        );
        assert!(warns.iter().any(|w| w.contains("Decl")));
        // A bare `Decl=` clears back to auto-derive (None).
        apply_units_option(&mut units, "decl", Some(""), &mut stack, &mut warns);
        assert_eq!(units.decl, None);
    }

    #[test]
    fn malformed_units_order_tape_lrud_warn() {
        // A rejected Order/Tape/LRUD value must warn (not silently keep defaults).
        let mut units = WallsUnits::default();
        let mut stack = Vec::new();
        let mut w = Vec::new();
        let default_order = units.ct_order.clone();
        apply_units_option(&mut units, "order", Some("DAX"), &mut stack, &mut w);
        apply_units_option(&mut units, "tape", Some("ZZ"), &mut stack, &mut w);
        apply_units_option(&mut units, "lrud", Some("F:XYZW"), &mut stack, &mut w);
        assert!(
            w.iter().any(|m| m.contains("Order")),
            "bad Order must warn: {w:?}"
        );
        assert!(
            w.iter().any(|m| m.contains("Tape")),
            "bad Tape must warn: {w:?}"
        );
        assert!(
            w.iter().any(|m| m.contains("LRUD")),
            "bad LRUD must warn: {w:?}"
        );
        // Rejected values leave the prior state intact.
        assert_eq!(units.ct_order, default_order);
        assert_eq!(units.lrud_order, ['L', 'R', 'U', 'D']);
        assert_eq!(units.tape_from, TapeEnd::Instrument);
        assert_eq!(units.tape_to, TapeEnd::Target);
    }

    #[test]
    fn zero_length_bearing_leg_kept() {
        // `A B 0 90 0`: zero tape but a real bearing — keep it as a tie so the
        // endpoints stay connected instead of splitting into components.
        let srv = "#UNITS meters order=DAV\n\
                   A B 0 90 0\n\
                   B C 10 90 0\n";
        let (configs, _c, _w) = convert_one(parse_srv(srv));
        assert_eq!(configs.len(), 1, "endpoints must stay in one component");
        let total: usize = configs.iter().map(|c| c.shots.len()).sum();
        assert_eq!(total, 2, "zero-length bearing leg must be kept");
    }

    #[test]
    fn fix_coordinates_survive_inline_comment() {
        // A `;` comment with no leading space must not swallow the northing.
        let georef = test_ref(0.0, 20.0, -90.0);
        let survey = parse_srv_geo(
            "#UNITS meters order=DAV\n#FIX A0 467427 2258942;datum tie\nA0 B 10 90 0\n",
            Some(georef),
            false,
        );
        assert_eq!(survey.fixes.len(), 1);
        assert!(
            survey.fixes[0].lat_long.is_some(),
            "both UTM coords must survive a `;`-comment with no leading space"
        );
    }

    #[test]
    fn preview_excludes_out_of_range_fix() {
        // An out-of-range geographic #Fix is rejected by resolve_anchors, so the
        // preview's fixed_station_count must not count it either.
        let srv = "#UNITS meters order=DAV\n\
                   #FIX GOOD N30:00:00 W90:00:00 0\n\
                   #FIX BAD N95:00:00 W30:00:00 0\n\
                   GOOD BAD 10 90 0\n";
        let parsed = ParsedWalls {
            project_name: "t".to_string(),
            book_count: 0,
            surveys: vec![parse_srv(srv)],
            georef: None,
            missing_files: Vec::new(),
            skipped_attachments: 0,
            warnings: Vec::new(),
        };
        let preview = build_preview(&parsed);
        assert_eq!(
            preview.fixed_station_count, 1,
            "only the in-range #Fix should be counted"
        );
    }

    #[test]
    fn dive_station_keeps_own_gauge_depth() {
        // S1 reads 5 on the first leg but 6 on the second (gauge noise). Each
        // station's own authoritative gauge reading wins over an integrated one.
        let srv = "#UNITS meters ORDER=DA Tape=SS\n\
                   S0 S1 10 90 0 5\n\
                   S1 S2 10 90 6 9\n";
        let (configs, _c, _w) = convert_one(parse_srv(srv));
        let sec = &configs[0];
        assert_eq!(sec.shots.len(), 2);
        assert!(approx(sec.shots[1].depth_in, 5.0));
        assert!(
            approx(sec.shots[1].depth_out, 9.0),
            "S2 must keep its own gauge depth (9), not an integrated value, got {}",
            sec.shots[1].depth_out
        );
    }

    // ----- regression tests for the second review round -------------------

    #[test]
    fn two_digit_year_dates_parse_to_full_year() {
        // chrono's `%Y` must NOT greedily eat a 2-digit leading field: `05/07/17`
        // is year 17, not year 0005. Genuine Walls maps every 2-digit year into
        // 1900-1999 (`y += 1900`), so `17` => 1917 (NOT 2017).
        assert_eq!(
            parse_walls_date("05/07/17"),
            NaiveDate::from_ymd_opt(1917, 5, 7)
        );
        assert_eq!(
            parse_walls_date("5-7-99"),
            NaiveDate::from_ymd_opt(1999, 5, 7)
        );
        // 4-digit ISO and US forms still parse.
        assert_eq!(
            parse_walls_date("2017-05-07"),
            NaiveDate::from_ymd_opt(2017, 5, 7)
        );
        assert_eq!(
            parse_walls_date("05/07/2017"),
            NaiveDate::from_ymd_opt(2017, 5, 7)
        );
    }

    #[test]
    fn rect_vector_honors_units_grid() {
        // `#Units RECT Grid=2`: the manual grid convergence applies to a RECT leg
        // exactly like CT — a bearing along +N (0°) becomes 0 - 2 = 358°.
        let srv = "#UNITS RECT order=ENU Grid=2\n\
                   A B 0 10 0\n";
        let (configs, _c, _w) = convert_one(parse_srv(srv));
        assert!(
            approx(configs[0].shots[0].azimuth_in, 358.0),
            "RECT must honor #Units Grid=, got {}",
            configs[0].shots[0].azimuth_in
        );
    }

    #[test]
    fn lrud_to_shifts_cross_section_forward() {
        // `#Units LRUD=To`: the LRUD on leg A->B is measured at B, so it must ride
        // on the next shot (B->C), not on A->B.
        let srv = "#UNITS meters order=DAV LRUD=To\n\
                   A B 10 90 0 <1,2,3,4>\n\
                   B C 10 90 0 <5,6,7,8>\n";
        let (configs, _c, _w) = convert_one(parse_srv(srv));
        let shots = &configs[0].shots;
        assert_eq!(shots.len(), 2);
        assert_eq!(
            shots[0].left, None,
            "A->B must not carry B's LRUD as its own"
        );
        assert_eq!(
            shots[1].left,
            Some(1.0),
            "B's measured LRUD must shift forward onto B->C"
        );
    }

    #[test]
    fn parse_ref_rejects_out_of_range_zone() {
        // A garbage UTM zone must be rejected, not silently saturated by `as i32`.
        let bad = "100 200 999 0 0 0 31 0 0 97 0 0 \"WGS84\"";
        assert!(parse_ref(bad).is_err(), "zone 999 must be rejected");
        let ok = "100 200 16 0 0 0 31 0 0 97 0 0 \"WGS84\"";
        assert!(parse_ref(ok).is_ok(), "a valid .REF must still parse");
    }

    #[test]
    fn inch_not_applied_to_zero_length_bearing_tie() {
        // `#Units IncH=5` plus a zero-length bearing tie (A B 0 90) must NOT push
        // a 5 m vertical offset onto the tied station.
        let srv = "#UNITS meters order=DAV IncH=5\n\
                   A B 0 90 0\n\
                   B C 10 90 0\n";
        let (configs, _c, _w) = convert_one(parse_srv(srv));
        assert!(
            approx(configs[0].shots[0].depth_out, 0.0),
            "zero-length tie must not pick up an IncH offset, got {}",
            configs[0].shots[0].depth_out
        );
    }

    #[test]
    fn rect_plumb_shot_has_no_spurious_bearing() {
        // A pure-vertical RECT shot (E=N=0, U=10) has no defined bearing; it must
        // be left unset, not recorded as 0° (due north).
        let srv = "#UNITS RECT order=ENU\n\
                   A B 0 0 10\n";
        let survey = parse_srv(srv);
        assert_eq!(survey.vectors.len(), 1);
        assert!(
            survey.vectors[0].azimuth_in.is_none(),
            "plumb RECT shot must have no azimuth"
        );
        assert!(
            survey.vectors[0]
                .inc_deg
                .map(|i| i.abs() > 89.0)
                .unwrap_or(false),
            "plumb RECT shot must be ~vertical"
        );
    }

    #[test]
    fn preview_shot_count_excludes_splays() {
        // A survey of only anonymous-wall splays imports nothing by default, so
        // the preview shot count must be 0 — not the raw vector count.
        let srv = "#UNITS meters order=DAV\n\
                   A - 3 90 0\n\
                   A - 4 180 0\n";
        let parsed = ParsedWalls {
            project_name: "t".to_string(),
            book_count: 0,
            surveys: vec![parse_srv(srv)],
            georef: None,
            missing_files: Vec::new(),
            skipped_attachments: 0,
            warnings: Vec::new(),
        };
        let preview = build_preview(&parsed);
        assert_eq!(
            preview.shot_count, 0,
            "a splay-only survey must preview 0 importable shots"
        );
        // ...but the splays are still importable with "Include splays" enabled,
        // so the dialog can offer import rather than greying the button out.
        assert_eq!(
            preview.splay_count, 2,
            "both anonymous-wall splays must be counted as opt-in importable"
        );
    }

    #[test]
    fn gross_gauge_contradiction_warns() {
        // S1's first gauge reading (5) and a later one (50) on the same station
        // disagree grossly; the gauge still wins but the discontinuity must warn.
        let srv = "#UNITS meters ORDER=DA Tape=SS\n\
                   S0 S1 10 90 0 5\n\
                   S1 S2 10 90 50 9\n";
        let (_configs, _c, warnings) = convert_one(parse_srv(srv));
        assert!(
            warnings.iter().any(|w| w.contains("disagrees")),
            "a gross gauge/integrated contradiction must warn, got {warnings:?}"
        );
    }

    // ----- regression tests for the second code-review pass -----------------

    #[test]
    fn prefix_leading_colon_and_level_order_match_walls() {
        // dewalls `processStationName`: the explicit ':' count suppresses that
        // many of the LOWEST inherited prefix levels, and remaining levels are
        // emitted outermost-first (Prefix2:Prefix1:name). A leading colon cancels
        // the inherited Prefix1.
        let mut u = WallsUnits::default();
        set_prefix(&mut u, 0, "CAVE"); // Prefix1
        assert_eq!(normalize_station("A1", &u), "CAVE:A1");
        assert_eq!(normalize_station(":A1", &u), "A1");
        set_prefix(&mut u, 1, "AREA"); // Prefix2
        assert_eq!(normalize_station("A1", &u), "AREA:CAVE:A1");
        // One explicit segment suppresses only Prefix1, keeping Prefix2.
        assert_eq!(normalize_station("X:STN", &u), "AREA:X:STN");
    }

    #[test]
    fn ct_after_rect_restores_order_and_keeps_shots() {
        // `#Units RECT` set order to E/N/U; a later bare `#Units CT` must restore
        // the CT order so the following compass-and-tape shot survives parsing.
        let srv = "#UNITS RECT\n#UNITS CT\nA B 10 90 0\n";
        let survey = parse_srv(srv);
        assert_eq!(
            survey.vectors.len(),
            1,
            "a CT shot after a RECT block must not be dropped"
        );
        assert!(approx(survey.vectors[0].length_m, 10.0));
    }

    #[test]
    fn custom_ct_order_survives_rect_round_trip() {
        // ct_order and rect_order are independent (dewalls): a custom CT
        // `Order=AVD` set while in RECT must still govern the CT shot, and must
        // NOT be clobbered back to the default by the CT switch.
        let srv = "#UNITS RECT\n#UNITS Order=AVD CT\nA B 90 0 10\n";
        let survey = parse_srv(srv);
        assert_eq!(survey.vectors.len(), 1);
        let v = &survey.vectors[0];
        // AVD => azimuth, inclination, distance columns.
        assert!(
            approx(v.length_m, 10.0),
            "distance must be the 3rd (D) column per AVD, got {}",
            v.length_m
        );
        assert_eq!(
            v.azimuth_in,
            Some(90.0),
            "azimuth must be the 1st (A) column per AVD"
        );
    }

    #[test]
    fn project_macros_available_to_srv_body() {
        // A macro defined in the project/book `.OPTIONS` must expand in the child
        // `.SRV` body (regression: it was parsed then discarded).
        let mut initial_macros = HashMap::new();
        initial_macros.insert("cave".to_string(), "ABC".to_string());
        let mut warnings = Vec::new();
        let survey = parse_srv_contents(
            "#UNITS meters order=DAV\n$(cave)1 $(cave)2 10 0 0\n",
            "t",
            "t",
            "",
            &WallsUnits::default(),
            &initial_macros,
            None,
            true,
            false,
            &mut warnings,
        );
        assert_eq!(
            survey.vectors.len(),
            1,
            "a shot referencing a project macro must import, warnings: {warnings:?}"
        );
        assert_eq!(survey.vectors[0].from, "ABC1");
        assert_eq!(survey.vectors[0].to, "ABC2");
    }

    #[test]
    fn malformed_date_keeps_previous_valid() {
        // A later unparseable `#Date` must not clobber an earlier valid one.
        let srv = "#DATE 2017-05-07\n#DATE 0000-99-99\n#UNITS meters order=DAV\nA B 10 0 0\n";
        let survey = parse_srv(srv);
        assert_eq!(survey.date, NaiveDate::from_ymd_opt(2017, 5, 7));
    }

    #[test]
    fn backsight_only_zero_length_tie_kept() {
        // A zero-length leg carrying only a backsight bearing is a coincident-
        // station tie and must not be dropped (the guard checked only foresight).
        let srv = "#UNITS meters order=DAV\nA B 0 /200\n";
        let survey = parse_srv(srv);
        assert_eq!(
            survey.vectors.len(),
            1,
            "a backsight-only zero-length tie must be kept"
        );
    }

    #[test]
    fn split_units_args_keeps_quoted_spans() {
        // Quoted `#Units` values with embedded spaces must stay single tokens.
        let toks = split_units_args("feet decl=0.0 $foo=\"meters decl\" Flag=\"loose rock\"");
        assert_eq!(
            toks,
            vec![
                "feet",
                "decl=0.0",
                "$foo=\"meters decl\"",
                "Flag=\"loose rock\""
            ]
        );
    }

    #[test]
    fn quoted_units_value_emits_no_spurious_warning() {
        let mut warnings = Vec::new();
        let survey = parse_srv_contents(
            "#UNITS meters order=DAV Flag=\"loose rock\"\nA B 10 0 0\n",
            "t",
            "t",
            "",
            &WallsUnits::default(),
            &HashMap::new(),
            None,
            true,
            false,
            &mut warnings,
        );
        assert!(
            !warnings.iter().any(|w| w.contains("Unknown #units option")),
            "a quoted value with a space must not trip the unknown-option arm: {warnings:?}"
        );
        assert_eq!(survey.vectors.len(), 1);
    }

    #[test]
    fn contiguous_self_loop_emits_closure() {
        // A->B->C->A in one survey is a single chain whose revisited station must
        // get an intra-section loop closure (regression: it was dropped).
        let srv = "#UNITS meters order=DAV\nA B 10 90 0\nB C 10 0 0\nC A 14 200 0\n";
        let (_configs, closures, _w) = convert_one(parse_srv(srv));
        assert!(
            closures
                .iter()
                .any(|c| c.from_section_index == c.to_section_index
                    && c.from_station_index == 3
                    && c.to_station_index == 0),
            "an intra-chain loop must emit a same-section closure, got {closures:?}"
        );
    }

    #[test]
    fn second_fix_anchor_depth_disagreement_warns() {
        // Two #Fix in one connected component whose elevations disagree with the
        // integrated geometry must warn (regression: the 2nd anchor was ignored).
        let srv = "#UNITS meters order=DAV\n\
                   #FIX AA W87:18:44 N20:25:42 100\n\
                   #FIX ZZ W87:18:44 N20:25:42 50\n\
                   AA ZZ 10 90 0\n";
        let (_c, _cl, warnings) = convert_one(parse_srv(srv));
        assert!(
            warnings.iter().any(|w| w.contains("fixed-station depth")),
            "a disagreeing second fixed-station depth must warn: {warnings:?}"
        );
        // ...but the measured shot geometry must be preserved (the 2nd anchor is
        // a consistency check, not a second datum) — a 10 m flat shot must not be
        // stretched by a fabricated 50 m vertical, so no length clamp fires.
        assert!(
            !warnings.iter().any(|w| w.contains("clamped")),
            "honoring the 2nd anchor must not corrupt shot length: {warnings:?}"
        );
    }

    #[test]
    fn dive_leg_missing_one_depth_warns() {
        // A depth-gauge leg with only one depth column integrates as flat; that
        // estimate must be surfaced, not asserted silently.
        let srv = "#UNITS meters ORDER=DA Tape=SS\nA B 21.1 339 13 --\n";
        let (_c, _cl, warnings) = convert_one(parse_srv(srv));
        assert!(
            warnings
                .iter()
                .any(|w| w.contains("missing a depth reading")),
            "a single-depth dive leg must warn: {warnings:?}"
        );
    }

    #[test]
    fn two_digit_year_maps_to_1900s_like_walls() {
        // Genuine Walls (`wall-srv.cpp` ParseDate) does `if (y < 100) y += 1900`,
        // so EVERY 2-digit year lands in 1900-1999 — never the 2000s, never the
        // future. `64` => 1964, `17` => 1917, `00` => 1900, `30` => 1930.
        for (s, y) in [
            ("03-15-64", 1964),
            ("05/07/17", 1917),
            ("1-1-00", 1900),
            ("6-6-30", 1930),
        ] {
            assert_eq!(
                parse_walls_date(s).map(|d| d.year()),
                Some(y),
                "{s} should map to {y}"
            );
        }
    }

    #[test]
    fn parse_ref_rejects_infinite_field() {
        // An over-large numeric parses to +inf; it must be rejected, not turned
        // into NaN azimuths downstream.
        let line = "0 0 16 1e400 0 0 20 25 42 87 18 44";
        assert!(parse_ref(line).is_err());
    }
}
