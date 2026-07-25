use std::collections::HashMap;
use std::path::{Path, PathBuf};

use anyhow::Result;

use super::{
    apply_units_options, parse_srv_contents, read_latin1, split_first_token, ParsedSurvey,
    ParsedWalls, WallsRef, WallsUnits, STATUS_DERIVE_DECL, STATUS_DETACHED,
    STATUS_DONT_DERIVE_DECL, STATUS_GRID_RELATIVE, STATUS_NOT_GRID_RELATIVE, STATUS_TYPE_OTHER,
};

/// Parse a bare `.SRV` file as a one-survey project (no `.WPJ` tree).
pub(crate) fn parse_single_srv(path: &Path) -> Result<ParsedWalls> {
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
pub(crate) struct WpjEntry {
    pub(crate) is_book: bool,
    pub(crate) title: String,
    pub(crate) name: Option<String>,
    pub(crate) status: u32,
    pub(crate) options: Option<String>,
    pub(crate) path: Option<String>,
    pub(crate) reference: Option<WallsRef>,
}

/// Inherited context accumulated down the book tree.
#[derive(Clone)]
pub(crate) struct WpjContext {
    pub(crate) dir: PathBuf,
    /// The `.wpj`'s own directory - the immutable project root. A relative
    /// `.PATH` may not climb above it (traversal guard); an absolute `.PATH`
    /// resets `dir` but leaves `root` unchanged.
    pub(crate) root: PathBuf,
    /// Concatenated `#units`-option strings from root to here.
    pub(crate) options: Vec<String>,
    pub(crate) reference: Option<WallsRef>,
    pub(crate) segment: String,
    pub(crate) derive_decl: bool,
    pub(crate) grid_relative: bool,
}

pub(crate) fn parse_wpj(path: &Path) -> Result<ParsedWalls> {
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
        root: root_dir.clone(),
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
                        // Defense-in-depth: an absolute / drive-qualified `.PATH`
                        // is honored verbatim (genuine Walls does), but if it
                        // escapes the project root the importer is reading outside
                        // the `.wpj`'s own tree - tell the user rather than doing
                        // it silently. (The read is NOT blocked: an explicit
                        // absolute path is the author's deliberate choice.)
                        if ctx.dir.is_absolute() && !ctx.dir.starts_with(&ctx.root) {
                            let label = entry.name.clone().unwrap_or_else(|| entry.title.clone());
                            warnings.push(format!(
                                "survey '{label}' resolves through an absolute .PATH outside \
                                 the project directory ({})",
                                ctx.dir.display()
                            ));
                        }
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
                // Unknown directive - ignore.
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
pub(crate) fn derive_context(parent: &WpjContext, entry: &WpjEntry) -> WpjContext {
    let mut ctx = parent.clone();
    // Resolve `.PATH`.
    if let Some(p) = &entry.path {
        ctx.dir = resolve_path(&parent.dir, &parent.root, p);
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
    // its own name as a segment level - for surveys as well as books
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
pub(crate) fn resolve_survey(entry: &WpjEntry, ctx: &WpjContext) -> Option<PathBuf> {
    let name = entry.name.as_ref()?;
    let name = name.trim();
    if name.is_empty() {
        return None;
    }
    // A `.NAME` is a node identifier that becomes a bare file name, never a
    // path. Reject one carrying a path separator or drive prefix (`/`, `\`,
    // `:`): valid `.wpj` names never contain them, and allowing them would let a
    // crafted project read files outside its directory (e.g.
    // `.NAME ../../../../etc/passwd`). Treated as unresolved (reported missing).
    if name.contains('/') || name.contains('\\') || name.contains(':') {
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

/// Resolve a `.PATH` against a parent directory: an absolute / drive-qualified
/// path REPLACES the base (genuine Walls honors it - `Walls32 prjhier.cpp`
/// `GetPathPrefix` uses an absolute `.PATH` as the prefix), a relative path
/// concatenates; backslashes are normalized. A relative `..` is clamped at
/// `root` (the `.wpj`'s own directory) so a crafted `.PATH ../../../../` can't
/// walk the resolution dir out of the project tree.
pub(crate) fn resolve_path(parent: &Path, root: &Path, path: &str) -> PathBuf {
    let normalized = path.replace('\\', "/");
    let candidate = Path::new(&normalized);
    if candidate.is_absolute() || normalized.contains(':') {
        return PathBuf::from(normalized);
    }
    let mut dir = parent.to_path_buf();
    for part in normalized.split('/') {
        match part {
            "" | "." => {}
            // Never pop above the project root (traversal guard). When `dir`
            // already sits at/above `root` - e.g. a parent set an absolute
            // `.PATH` so `dir` is a different tree - `starts_with` is false and
            // we leave it alone (that absolute base is the user's explicit dir).
            ".." => {
                if dir != root && dir.starts_with(root) {
                    dir.pop();
                }
            }
            other => dir.push(other),
        }
    }
    dir
}

/// Parse a `.REF` line: `northing easting zone conv elev flags latDMS lonDMS
/// datumIdx "datum"`.
pub(crate) fn parse_ref(line: &str) -> Result<WallsRef, String> {
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

pub(crate) fn dms(d: f64, m: f64, s: f64) -> f64 {
    let sign = if d < 0.0 { -1.0 } else { 1.0 };
    sign * (d.abs() + m / 60.0 + s / 3600.0)
}

/// Build the initial `#Units` state and macro table for a survey from inherited
/// `.OPTIONS`. Macros defined in a parent/book/survey `.OPTIONS` string (e.g.
/// `$cave=ABC`) must be visible to the child `.SRV` body, so they are returned
/// alongside the units rather than discarded - otherwise any `$(cave)` reference
/// in the survey fails to expand and those shots are silently dropped.
pub(crate) fn build_initial_units(
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
