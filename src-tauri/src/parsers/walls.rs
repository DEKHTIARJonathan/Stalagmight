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

use anyhow::{Context, Result, anyhow};
use chrono::{Datelike, NaiveDate};
use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::models::section::{ImportClosure, ImportPlacement, ImportSectionConfig};
use crate::models::shot::ShotData;
use crate::models::station::GpsCoordinates;

const FEET_TO_METERS: f64 = 0.3048;

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
    pub has_georeference: bool,
    pub datum: Option<String>,
    pub utm_zone: Option<i32>,
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
}

impl Default for WallsImportOptions {
    fn default() -> Self {
        Self {
            comments_on_stations: true,
            include_splays: false,
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
            AngleUnit::Grads => value * 0.9,        // 400 grad == 360°
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
    order: Vec<OrderElem>,
    d_unit: LengthUnit,
    s_unit: LengthUnit,
    a_unit: AngleUnit,
    ab_unit: AngleUnit,
    v_unit: AngleUnit,
    vb_unit: AngleUnit,
    decl: f64,
    grid: f64,
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
            order: vec![OrderElem::Dist, OrderElem::Azm, OrderElem::Inc],
            d_unit: LengthUnit::Meters,
            s_unit: LengthUnit::Meters,
            a_unit: AngleUnit::Degrees,
            ab_unit: AngleUnit::Degrees,
            v_unit: AngleUnit::Degrees,
            vb_unit: AngleUnit::Degrees,
            decl: 0.0,
            grid: 0.0,
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
    /// True when this survey records dive depth-gauge data: compass-and-tape,
    /// station-to-station taping, distance+azimuth order with no inclination
    /// column (`#Units Order=DA Tape=SS`).
    fn is_depth_gauge(&self) -> bool {
        self.vector_type == VectorType::Ct
            && self.tape_from == TapeEnd::Station
            && self.tape_to == TapeEnd::Station
            && self.order.contains(&OrderElem::Dist)
            && self.order.contains(&OrderElem::Azm)
            && !self.order.contains(&OrderElem::Inc)
    }
}

// ---------------------------------------------------------------------------
// Georeference (.REF / #Fix)
// ---------------------------------------------------------------------------

/// A `.WPJ` `.REF` geographic reference (UTM origin + datum).
#[derive(Clone, Debug)]
struct WallsRef {
    /// UTM origin (meters) — retained for completeness; the importer anchors on
    /// `#Fix` stations / the lat-long fields rather than the origin offset.
    #[allow(dead_code)]
    northing: f64,
    #[allow(dead_code)]
    easting: f64,
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
    /// Declination (`Decl=`) in effect for this vector, degrees.
    units_decl: f64,
    /// `IncH=` vertical adjustment (meters) added to the vertical of non-plumb
    /// CT shots.
    inch: f64,
    grid_relative: bool,
    /// Auto-derive declination from `#Date` (`.STATUS` derive-declination flag).
    derive_decl: bool,
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
        grid_relative: true,
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
                                        let initial = build_initial_units(&ctx, &mut warnings);
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
                                let shown = other
                                    .map(|p| p.display().to_string())
                                    .unwrap_or_else(|| {
                                        entry.name.clone().unwrap_or_else(|| entry.title.clone())
                                    });
                                missing_files.push(shown);
                                surveys.push(ParsedSurvey {
                                    title: entry.title.clone(),
                                    name: entry
                                        .name
                                        .clone()
                                        .unwrap_or_else(|| entry.title.clone()),
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
                    e.status = rest.trim().parse().unwrap_or(0);
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
    if f.len() < 12 || f[..12].iter().any(|v| v.is_nan()) {
        return Err(format!("expected >=12 numeric fields, got {}", f.len()));
    }
    // Fields: 0 N, 1 E, 2 zone, 3 convergence, 4 elev, 5 flags,
    // 6-8 lat d/m/s, 9-11 lon d/m/s, [12 datum index].
    let flags = f[5] as u32;
    let lat = dms(f[6], f[7], f[8]) * if flags & 0x08 != 0 { -1.0 } else { 1.0 };
    let lon = dms(f[9], f[10], f[11]) * if flags & 0x04 != 0 { -1.0 } else { 1.0 };
    Ok(WallsRef {
        northing: f[0],
        easting: f[1],
        zone: f[2] as i32,
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

/// Build the initial `#Units` state for a survey from inherited `.OPTIONS`.
fn build_initial_units(ctx: &WpjContext, warnings: &mut Vec<String>) -> WallsUnits {
    let mut units = WallsUnits::default();
    let mut macros: HashMap<String, String> = HashMap::new();
    let mut stack: Vec<WallsUnits> = Vec::new();
    for opts in &ctx.options {
        apply_units_options(&mut units, opts, &mut stack, &mut macros, warnings);
    }
    units
}

// ---------------------------------------------------------------------------
// .SRV parsing
// ---------------------------------------------------------------------------

/// Parse the contents of one `.SRV` file into normalized vectors.
#[allow(clippy::too_many_arguments)]
fn parse_srv_contents(
    contents: &str,
    title: &str,
    name: &str,
    inherited_segment: &str,
    initial_units: &WallsUnits,
    georef: Option<WallsRef>,
    grid_relative: bool,
    derive_decl: bool,
    warnings: &mut Vec<String>,
) -> ParsedSurvey {
    let mut units = initial_units.clone();
    let mut unit_stack: Vec<WallsUnits> = Vec::new();
    let mut macros: HashMap<String, String> = HashMap::new();
    let mut segment = inherited_segment.to_string();
    let mut date: Option<NaiveDate> = None;
    let mut surveyor: Option<String> = None;
    let mut first_comment_seen = false;
    let mut block_comment_depth: u32 = 0;

    let mut vectors: Vec<WallsVector> = Vec::new();
    let mut fixes: Vec<WallsFix> = Vec::new();

    let grid_rel = grid_relative;

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
        if let Some(vec) = parse_vector_line(
            &expanded,
            &units,
            &segment,
            date,
            grid_rel,
            derive_decl,
            name,
            line_no + 1,
            warnings,
        ) {
            vectors.push(vec);
        }
    }

    let resolved = true;
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
        resolved,
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

#[allow(clippy::too_many_arguments)]
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
    let key = directive.trim_start_matches('#').to_ascii_lowercase();
    match key.as_str() {
        "units" | "u" => {
            apply_units_options(units, rest, unit_stack, macros, warnings);
        }
        "date" => {
            *date = parse_walls_date(rest.trim());
            if date.is_none() && !rest.trim().is_empty() {
                warnings.push(format!("{name}:{line_no}: unrecognized #Date '{}'", rest.trim()));
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

/// Apply a `#Units` argument string to the running units state.
fn apply_units_options(
    units: &mut WallsUnits,
    args: &str,
    unit_stack: &mut Vec<WallsUnits>,
    macros: &mut HashMap<String, String>,
    warnings: &mut Vec<String>,
) {
    for token in args.split_whitespace() {
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
        apply_units_option(units, &key, value, unit_stack, warnings);
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
        "ct" => units.vector_type = VectorType::Ct,
        "rect" => match value {
            None => {
                units.vector_type = VectorType::Rect;
                units.order = vec![OrderElem::East, OrderElem::North, OrderElem::Up];
            }
            Some(v) => units.grid = parse_signed_angle(v).unwrap_or(units.grid), // Rect=<angle>
        },
        "order" | "o" => {
            if let Some(v) = value {
                if let Some(order) = parse_order(v) {
                    units.order = order;
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
        "decl" => units.decl = value.and_then(parse_signed_angle).unwrap_or(0.0),
        "grid" => units.grid = value.and_then(parse_signed_angle).unwrap_or(0.0),
        "incd" => units.incd = value.and_then(|v| parse_length(v, units.d_unit)).unwrap_or(0.0),
        // Azimuth/inclination corrections carry the current instrument's angle
        // unit (a bare `IncV=2` under `V=Grads` means 2 grads).
        "inca" => {
            let u = units.a_unit;
            units.inca = value.and_then(|v| parse_angle(v, u)).unwrap_or(0.0);
        }
        "incab" => {
            let u = units.ab_unit;
            units.incab = value.and_then(|v| parse_angle(v, u)).unwrap_or(0.0);
        }
        "incv" => {
            let u = units.v_unit;
            units.incv = value.and_then(|v| parse_angle(v, u)).unwrap_or(0.0);
        }
        "incvb" => {
            let u = units.vb_unit;
            units.incvb = value.and_then(|v| parse_angle(v, u)).unwrap_or(0.0);
        }
        "incs" => units.incs = value.and_then(|v| parse_length(v, units.s_unit)).unwrap_or(0.0),
        "inch" => units.inch = value.and_then(|v| parse_length(v, units.d_unit)).unwrap_or(0.0),
        "typeab" => apply_type_backsight(value, &mut units.type_ab_corrected, &mut units.type_ab_no_avg),
        "typevb" => apply_type_backsight(value, &mut units.type_vb_corrected, &mut units.type_vb_no_avg),
        "case" => {
            units.case = match value.map(|v| v.chars().next().unwrap_or(' ').to_ascii_uppercase()) {
                Some('U') => Case::Upper,
                Some('L') => Case::Lower,
                _ => Case::Mixed,
            }
        }
        "lrud" => apply_lrud_option(units, value),
        "tape" => apply_tape_option(units, value),
        "prefix" | "prefix1" => set_prefix(units, 0, value.unwrap_or("")),
        "prefix2" => set_prefix(units, 1, value.unwrap_or("")),
        "prefix3" => set_prefix(units, 2, value.unwrap_or("")),
        "flag" => {
            units.flag = value.map(|v| unquote(v).to_string()).filter(|s| !s.is_empty());
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
        if kind.chars().next().map(|c| c.eq_ignore_ascii_case(&'c')).unwrap_or(false) {
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

fn apply_lrud_option(units: &mut WallsUnits, value: Option<&str>) {
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
        }
    }
}

fn apply_tape_option(units: &mut WallsUnits, value: Option<&str>) {
    let Some(v) = value else { return };
    let chars: Vec<char> = v.chars().map(|c| c.to_ascii_uppercase()).collect();
    let end = |c: char| match c {
        'I' => TapeEnd::Instrument,
        'S' => TapeEnd::Station,
        'T' => TapeEnd::Target,
        _ => TapeEnd::Instrument,
    };
    if chars.len() >= 2 {
        units.tape_from = end(chars[0]);
        units.tape_to = end(chars[1]);
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

#[allow(clippy::too_many_arguments)]
fn parse_vector_line(
    line: &str,
    units: &WallsUnits,
    segment: &str,
    date: Option<NaiveDate>,
    grid_relative: bool,
    derive_decl: bool,
    name: &str,
    line_no: usize,
    warnings: &mut Vec<String>,
) -> Option<WallsVector> {
    let _ = segment;
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

    // Anonymous wall point (-): a splay reading, not a connected leg.
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

    for elem in &units.order {
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
                inc = parse_fsbs_incl(tok, units.v_unit, units.vb_unit);
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
        let azimuth_deg = east.atan2(north).to_degrees().rem_euclid(360.0);
        return Some(WallsVector {
            from,
            to,
            length_m: length,
            azimuth_in: Some(azimuth_deg),
            azimuth_out: Some(azimuth_deg),
            inc_deg: Some(up_rect.atan2(horiz).to_degrees()),
            pitch_in: Some(-up_rect.atan2(horiz).to_degrees()),
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
            derive_decl,
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
            cursor += 1;
        }
    }
    let _ = cursor;

    let length_m = length_m.unwrap_or(0.0) + if length_m.is_some() { units.incd } else { 0.0 };

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

    let is_reference = from_anon || to_anon || extracted.floated;

    // Pure station-equate (no distance, no depth) — skip.
    if length_m <= 0.0 && from_depth.is_none() && to_depth.is_none() && az.fs.is_none() {
        if left.is_none() && right.is_none() && up.is_none() && down.is_none() {
            return None;
        }
    }

    let _ = (name, line_no, warnings);

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
        derive_decl,
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
    floated: bool,
}

/// Walk a vector line body, pulling out `<...>`/`*...*` (LRUD) and `(...)`
/// (variance) delimited spans, returning the remaining whitespace tokens.
fn extract_spans(body: &str) -> ExtractedSpans {
    let mut tokens: Vec<String> = Vec::new();
    let mut current = String::new();
    let mut lrud: Option<String> = None;
    let mut floated = false;
    let mut chars = body.chars().peekable();

    let flush = |current: &mut String, tokens: &mut Vec<String>| {
        if !current.is_empty() {
            tokens.push(std::mem::take(current));
        }
    };

    while let Some(c) = chars.next() {
        match c {
            c if c.is_whitespace() => flush(&mut current, &mut tokens),
            '#' => {
                // Inline directive (segment) — stop collecting measurement
                // tokens; the rest of the line doesn't carry geometry.
                flush(&mut current, &mut tokens);
                break;
            }
            '<' => {
                flush(&mut current, &mut tokens);
                let mut span = String::new();
                for d in chars.by_ref() {
                    if d == '>' {
                        break;
                    }
                    span.push(d);
                }
                lrud = Some(span);
            }
            '*' => {
                flush(&mut current, &mut tokens);
                let mut span = String::new();
                for d in chars.by_ref() {
                    if d == '*' {
                        break;
                    }
                    span.push(d);
                }
                lrud = Some(span);
            }
            '(' => {
                flush(&mut current, &mut tokens);
                let mut span = String::new();
                for d in chars.by_ref() {
                    if d == ')' {
                        break;
                    }
                    span.push(d);
                }
                if span.contains('?') || span.contains('*') {
                    floated = true;
                }
            }
            other => current.push(other),
        }
    }
    flush(&mut current, &mut tokens);

    ExtractedSpans {
        tokens,
        lrud,
        floated,
    }
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
    let extracted = extract_spans(rest);
    let tokens = extracted.tokens;
    if tokens.is_empty() {
        return None;
    }
    let name = normalize_station(&tokens[0], units);
    let coords = &tokens[1..];
    // Read up to three coordinates in `order` (default ENU). Each is a length
    // or an N/S/E/W-prefixed geographic angle.
    let mut east_val: Option<f64> = None;
    let mut north_val: Option<f64> = None;
    let mut up_val: Option<f64> = None;
    let mut lat: Option<f64> = None;
    let mut lon: Option<f64> = None;
    let mut idx = 0usize;
    for elem in &units.order {
        let Some(tok) = coords.get(idx) else { break };
        idx += 1;
        match elem {
            OrderElem::East | OrderElem::Dist => {
                if let Some(geo) = parse_geo_coord(tok) {
                    lon = Some(geo);
                } else {
                    east_val = parse_length(tok, units.d_unit);
                }
            }
            OrderElem::North | OrderElem::Azm => {
                if let Some(geo) = parse_geo_coord(tok) {
                    lat = Some(geo);
                } else {
                    north_val = parse_length(tok, units.d_unit);
                }
            }
            OrderElem::Up | OrderElem::Inc => {
                up_val = parse_length(tok, units.d_unit);
            }
        }
    }

    let lat_long = match (lat, lon) {
        (Some(la), Some(lo)) => Some((la, lo)),
        _ => match (east_val, north_val, georef) {
            (Some(e), Some(n), Some(r)) => utm_to_wgs84(e, n, r.zone, &r.datum),
            _ => None,
        },
    };

    Some(WallsFix {
        name,
        lat_long,
        up: up_val,
    })
}

/// Parse a geographic coordinate token like `W97:43:52.5` / `N31:16:45`.
fn parse_geo_coord(tok: &str) -> Option<f64> {
    let first = tok.chars().next()?;
    let (sign, rest) = match first.to_ascii_uppercase() {
        'N' | 'E' => (1.0, &tok[1..]),
        'S' | 'W' => (-1.0, &tok[1..]),
        _ => return None,
    };
    let deg = parse_dms(rest)?;
    Some(sign * deg.abs())
}

// ---------------------------------------------------------------------------
// Numeric token parsers
// ---------------------------------------------------------------------------

fn is_omitted(tok: &str) -> bool {
    tok.len() >= 2 && tok.chars().all(|c| c == '-')
}

fn is_anonymous(tok: &str) -> bool {
    tok == "-"
}

fn non_empty(s: &str) -> Option<String> {
    let t = s.trim();
    if t.is_empty() {
        None
    } else {
        Some(t.to_string())
    }
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

fn split_unit_suffix<'a>(t: &'a str, suffixes: &[char]) -> (&'a str, Option<char>) {
    if let Some(last) = t.chars().last() {
        if suffixes.contains(&last) {
            return (&t[..t.len() - last.len_utf8()], Some(last.to_ascii_lowercase()));
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
        let m = (feet + inches / 12.0) * FEET_TO_METERS;
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

/// Parse an angle token (degrees) with optional `d`/`g`/`m`/`p` suffix or
/// `D:M:S` form.
fn parse_angle(tok: &str, default: AngleUnit) -> Option<f64> {
    let t = tok.trim();
    if t.is_empty() || is_omitted(t) {
        return None;
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
    let val = d.abs() + m / 60.0 + s / 3600.0;
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

fn parse_fsbs_incl(tok: &str, fs_unit: AngleUnit, bs_unit: AngleUnit) -> FsBs {
    parse_fsbs(tok, fs_unit, bs_unit)
}

fn parse_walls_date(s: &str) -> Option<NaiveDate> {
    let s = s.trim();
    if s.is_empty() {
        return None;
    }
    for fmt in [
        "%Y-%m-%d",
        "%Y/%m/%d",
        "%m-%d-%Y",
        "%m/%d/%Y",
        "%m-%d-%y",
        "%m/%d/%y",
    ] {
        if let Ok(d) = NaiveDate::parse_from_str(s, fmt) {
            return Some(d);
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
    let entered: Vec<&str> = cased.split(':').collect();
    let base = entered.last().copied().unwrap_or("");
    let explicit = &entered[..entered.len().saturating_sub(1)];

    let mut levels: [Option<String>; 3] = units.prefix.clone();
    for (k, e) in explicit.iter().rev().take(3).enumerate() {
        // rightmost explicit prefix maps to level 2, then 1, then 0
        let lvl = 2 - k;
        levels[lvl] = if e.trim().is_empty() {
            None
        } else {
            Some(e.trim().to_string())
        };
    }

    let mut out = String::new();
    for lvl in levels.iter() {
        if let Some(p) = lvl {
            if !p.is_empty() {
                out.push_str(p);
                out.push(':');
            }
        }
    }
    out.push_str(base);
    out
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
    let south = if zone < 0 { " +south" } else { "" };
    let zone = zone.unsigned_abs();
    let to = proj4rs::Proj::from_proj_string("+proj=longlat +datum=WGS84 +no_defs").ok()?;
    let from = proj4rs::Proj::from_proj_string(&format!(
        "+proj=utm +zone={zone}{south} +{token} +units=m +no_defs"
    ))
    .ok()?;
    let (lon, lat, _) = proj4rs::adaptors::transform_xyz(&from, &to, easting, northing, 0.0).ok()?;
    Some((lat.to_degrees(), lon.to_degrees()))
}

fn datum_proj_token(datum: &str) -> String {
    let upper = datum.to_ascii_uppercase();
    if upper.contains("NAD83") || upper.contains("NAD 83") {
        "datum=NAD83".to_string()
    } else if upper.contains("NAD27") || upper.contains("NAD 27") {
        "datum=NAD27".to_string()
    } else if upper.contains("WGS72") {
        "ellps=WGS72".to_string()
    } else {
        "datum=WGS84".to_string()
    }
}

// ---------------------------------------------------------------------------
// Preview
// ---------------------------------------------------------------------------

/// Build the import-dialog preview from parsed data.
pub fn build_preview(parsed: &ParsedWalls) -> WallsFile {
    let shot_count = parsed
        .surveys
        .iter()
        .map(|s| s.vectors.len())
        .sum::<usize>() as u32;
    let resolved_survey_count = parsed.surveys.iter().filter(|s| s.resolved).count() as u32;
    let surveys = parsed
        .surveys
        .iter()
        .map(|s| WallsSurveySummary {
            name: s.name.clone(),
            title: s.title.clone(),
            date: s.date.map(|d| d.to_string()).unwrap_or_default(),
            segment: s.segment.clone(),
            shot_count: s.vectors.len() as u32,
            resolved: s.resolved,
        })
        .collect();
    WallsFile {
        project_name: parsed.project_name.clone(),
        book_count: parsed.book_count,
        survey_count: parsed.surveys.len() as u32,
        resolved_survey_count,
        shot_count,
        has_georeference: parsed.georef.is_some(),
        datum: parsed.georef.as_ref().map(|r| r.datum.clone()),
        utm_zone: parsed.georef.as_ref().map(|r| r.zone),
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

    let anchor = resolve_anchor(parsed, &mut warnings);

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
    }

    let mut kept: Vec<KeptSurvey> = Vec::new();
    let mut edges: Vec<(String, String, f64)> = Vec::new();
    let mut known_depth: HashMap<String, f64> = HashMap::new();

    for (si, survey) in parsed.surveys.iter().enumerate() {
        if survey.vectors.is_empty() {
            continue;
        }
        // Use THIS survey's inherited `.REF` (nearest ancestor) for grid
        // convergence + auto-declination, not the project's first reference.
        let survey_georef = &survey.georef;
        let mut kept_vectors = Vec::new();
        for (vi, v) in survey.vectors.iter().enumerate() {
            if v.is_reference && !opts.include_splays {
                continue;
            }
            // Dive shots carry their vertical in the depth gauges, so a leg with
            // an omitted/zero tape distance is still valid if it has a real depth
            // change; only drop a genuine zero-length, zero-depth equate.
            let depth_delta = match (v.from_depth, v.to_depth) {
                (Some(fd), Some(td)) => (td - fd).abs(),
                _ => 0.0,
            };
            if v.length_m <= 0.0 && !(v.is_depth_gauge && depth_delta > 0.0) {
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
            let convergence = if v.grid_relative {
                survey_georef.as_ref().map(|r| r.convergence).unwrap_or(0.0)
            } else {
                0.0
            };
            let declination = resolve_declination(v, survey_georef);
            let finalize = |a: Option<f64>| {
                a.map(|x| (x + declination - convergence).rem_euclid(360.0))
                    .unwrap_or(0.0)
            };
            let azimuth_in = finalize(v.azimuth_in);
            let azimuth_out = finalize(v.azimuth_out);

            // Edge elevation gain (+up).
            let gain = if v.is_depth_gauge {
                match (v.from_depth, v.to_depth) {
                    (Some(fd), Some(td)) => fd - td,
                    _ => 0.0,
                }
            } else {
                let inc = v.inc_deg.unwrap_or(0.0);
                let mut g = v.length_m * inc.to_radians().sin();
                // IncH adjusts the vertical of non-plumb CT shots.
                if inc.abs() < 89.5 {
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

    // Resolve absolute station depths.
    let anchor_seed = anchor.as_ref().map(|a| (a.station.as_str(), a.depth));
    let depths = build_station_depths(&edges, &known_depth, anchor_seed);
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
            for &idx in chain {
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
                shots.push(ShotData {
                    azimuth_in: v.azimuth_in,
                    azimuth_out: v.azimuth_out,
                    length,
                    depth_in,
                    depth_out,
                    pitch_in: v.pitch_in,
                    pitch_out: v.pitch_out,
                    left: v.left,
                    right: v.right,
                    up: v.up,
                    down: v.down,
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

    // Pass 2b: spanning-tree placement over chain connectivity.
    let placements = place_chains(
        &chains.iter().map(|c| c.names.clone()).collect::<Vec<_>>(),
        anchor.as_ref(),
        &mut warnings,
        |idx| chains[idx].label.clone(),
    );

    // Pass 2c: loop closures for shared stations that aren't tree edges.
    let closures = build_closures(&chains.iter().map(|c| (c.section_index, c.names.clone())).collect::<Vec<_>>(), &placements);

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
            placement: placements.placement[ci].clone().unwrap_or(ImportPlacement::Origin),
            station_comments: chain.station_comments.clone(),
        });
    }
    topological_sort_configs(&mut configs);

    Ok((configs, closures, warnings))
}

fn resolve_declination(v: &WallsVector, georef: &Option<WallsRef>) -> f64 {
    // An explicit Decl= always wins.
    if v.units_decl != 0.0 {
        return v.units_decl;
    }
    // Otherwise auto-derive from the IGRF model ONLY when the entry's
    // derive-declination flag is on AND a georeference + date are available.
    // Without the flag, Decl=0 means zero declination (azimuths already
    // true/grid).
    if !v.derive_decl {
        return 0.0;
    }
    match (georef, v.date) {
        (Some(r), Some(date)) => igrf_declination(r.latitude, r.longitude, date).unwrap_or(0.0),
        _ => 0.0,
    }
}

fn igrf_declination(lat: f64, lng: f64, date: NaiveDate) -> Option<f64> {
    let ordinal = u16::try_from(date.ordinal()).ok()?;
    let d = time::Date::from_ordinal_date(date.year(), ordinal).ok()?;
    igrf::declination(lat, lng, 0, d).map(|f| f.d).ok()
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

fn resolve_anchor(parsed: &ParsedWalls, warnings: &mut Vec<String>) -> Option<AnchorGeo> {
    for survey in &parsed.surveys {
        for fix in &survey.fixes {
            if let Some((lat, lon)) = fix.lat_long {
                match GpsCoordinates::new(lat, lon, 0.0) {
                    Ok(coordinates) => {
                        return Some(AnchorGeo {
                            station: fix.name.clone(),
                            coordinates,
                            depth: fix.up.map(|u| -u).unwrap_or(0.0),
                        });
                    }
                    Err(e) => warnings.push(format!("Ignoring invalid #Fix '{}': {e}", fix.name)),
                }
            }
        }
    }
    None
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
/// seeding each component from a known depth-gauge reading, the anchor, or 0.
fn build_station_depths(
    edges: &[(String, String, f64)],
    known: &HashMap<String, f64>,
    anchor: Option<(&str, f64)>,
) -> HashMap<String, f64> {
    // adjacency carries depth deltas (Δdepth = -Δup).
    let mut adjacency: HashMap<&str, Vec<(&str, f64)>> = HashMap::new();
    for (from, to, gain) in edges {
        adjacency.entry(from).or_default().push((to.as_str(), -gain));
        adjacency.entry(to).or_default().push((from.as_str(), *gain));
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
        // Choose seed station + absolute depth.
        let (seed, seed_depth) = if let Some((aname, adepth)) =
            anchor.filter(|(a, _)| component.contains(a))
        {
            (aname, adepth)
        } else if let Some(k) = component
            .iter()
            .filter(|n| known.contains_key(**n))
            .min()
            .copied()
        {
            (k, known[k])
        } else {
            (*component.iter().min().unwrap(), 0.0)
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
                        depth.insert((*m).to_string(), current + delta);
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

/// Spanning-tree placement: anchor chain -> ZeroDatum, reached chains ->
/// FromImporting, disconnected components -> Origin.
fn place_chains(
    chain_names: &[Vec<String>],
    anchor: Option<&AnchorGeo>,
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
    let mut adjacency: Vec<Vec<usize>> = vec![Vec::new(); n];
    for occ in occurrences.values() {
        for a in 0..occ.len() {
            for b in (a + 1)..occ.len() {
                if occ[a] != occ[b] {
                    adjacency[occ[a]].push(occ[b]);
                    adjacency[occ[b]].push(occ[a]);
                }
            }
        }
    }
    for nbrs in adjacency.iter_mut() {
        nbrs.sort_unstable();
        nbrs.dedup();
    }

    let shared_station = |child: usize, parent: usize| -> Option<(u32, u32)> {
        for (ci, cname) in chain_names[child].iter().enumerate() {
            if let Some(pi) = chain_names[parent].iter().position(|pn| pn == cname) {
                return Some((ci as u32, pi as u32));
            }
        }
        None
    };

    let anchor_chain = anchor.and_then(|a| {
        chain_names
            .iter()
            .position(|names| names.iter().any(|nm| nm == &a.station))
    });

    let mut placement: Vec<Option<ImportPlacement>> = vec![None; n];
    let mut merge_station: Vec<Option<u32>> = vec![None; n];
    let mut parent: Vec<Option<usize>> = vec![None; n];
    let mut visited = vec![false; n];
    let mut creation_order: Vec<usize> = Vec::with_capacity(n);
    let mut queue: VecDeque<usize> = VecDeque::new();

    if let (Some(ac), Some(a)) = (anchor_chain, anchor) {
        let aidx = chain_names[ac]
            .iter()
            .position(|nm| nm == &a.station)
            .unwrap_or(0) as u32;
        placement[ac] = Some(ImportPlacement::ZeroDatum {
            coordinates: a.coordinates,
            station_index: aidx,
        });
        visited[ac] = true;
        creation_order.push(ac);
        queue.push_back(ac);
    }

    let mut warn_next_root = anchor_chain.is_some();
    loop {
        while let Some(p) = queue.pop_front() {
            let neighbors = adjacency[p].clone();
            for nb in neighbors {
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
        match (0..n).find(|&i| !visited[i]) {
            Some(seed) => {
                placement[seed] = Some(ImportPlacement::Origin);
                if warn_next_root {
                    warnings.push(format!(
                        "Section '{}' is a separate component; placed at origin",
                        label_of(seed)
                    ));
                }
                warn_next_root = true;
                visited[seed] = true;
                creation_order.push(seed);
                queue.push_back(seed);
            }
            None => break,
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
                if canon_sec == *section_index {
                    continue;
                }
                if Some(k as u32) == merge_st && parent_section == Some(canon_sec) {
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
        assert_eq!(survey.date, Some(NaiveDate::from_ymd_opt(2017, 5, 7).unwrap()));
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
            srv, "Fixed", "FIX", "", &WallsUnits::default(), None, true, false, &mut warnings,
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

    fn test_ref(convergence: f64, lat: f64, lon: f64) -> WallsRef {
        WallsRef {
            northing: 0.0,
            easting: 0.0,
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
            content, "t", "t", "", &WallsUnits::default(), georef, true, derive_decl, &mut w,
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
        assert_eq!(sec.shots.len(), 2, "the zero-distance dive leg must survive");
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
        assert!(approx(off[0].shots[0].azimuth_in, 90.0), "no flag -> no auto declination");

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
            parse_srv_geo("#UNITS meters order=DAV\nA B 10 100 0\n", georef.clone(), false),
            georef.clone(),
            &WallsImportOptions::default(),
        );
        assert!(approx(configs[0].shots[0].azimuth_in, 98.0));
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
        assert!(approx(parse_length("i6", LengthUnit::Meters).unwrap(), 0.5 * FEET_TO_METERS));
        assert!(approx(parse_length("5i", LengthUnit::Meters).unwrap(), 5.0 * FEET_TO_METERS));
        assert!(approx(parse_length("10i6", LengthUnit::Meters).unwrap(), 10.5 * FEET_TO_METERS));
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

    // ----- ignored real-data validation (no project files committed) -------

    #[test]
    #[ignore]
    fn real_qr_project_tree() {
        let home = std::env::var("HOME").unwrap_or_default();
        let wpj = PathBuf::from(home).join("src/cave/data/qr/Quintana Roo.wpj");
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
}
