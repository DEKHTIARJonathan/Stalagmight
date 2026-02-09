//! GPX (GPS Exchange Format) file parser.
//!
//! Parses GPX 1.0 and 1.1 files containing waypoints, tracks, and routes.
//! Converts GPS data into import-ready section configurations.

use std::path::Path;

use anyhow::{bail, Context, Result};
use quick_xml::events::Event;
use quick_xml::Reader;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::models::geo::{haversine_distance, initial_bearing};
use crate::models::{GpsCoordinates, ImportPlacement, ImportSectionConfig, ShotData};

// ============================================================================
// IPC-visible types
// ============================================================================

/// Parsed GPX file.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct GpxFile {
    pub name: Option<String>,
    pub waypoints: Vec<GpxWaypoint>,
    pub tracks: Vec<GpxTrack>,
    pub routes: Vec<GpxRoute>,
}

/// A GPX waypoint.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct GpxWaypoint {
    pub name: Option<String>,
    pub comment: Option<String>,
    pub latitude: f64,
    pub longitude: f64,
    pub elevation: Option<f64>,
    pub time: Option<String>,
}

/// A GPX track containing one or more segments.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct GpxTrack {
    pub name: Option<String>,
    pub comment: Option<String>,
    pub segments: Vec<GpxTrackSegment>,
}

/// A single track segment (contiguous sequence of trackpoints).
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct GpxTrackSegment {
    pub points: Vec<GpxTrackPoint>,
}

/// A trackpoint within a track segment.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct GpxTrackPoint {
    pub latitude: f64,
    pub longitude: f64,
    pub elevation: Option<f64>,
    pub time: Option<String>,
}

/// A GPX route.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct GpxRoute {
    pub name: Option<String>,
    pub comment: Option<String>,
    pub points: Vec<GpxRoutePoint>,
}

/// A routepoint within a route.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct GpxRoutePoint {
    pub name: Option<String>,
    pub latitude: f64,
    pub longitude: f64,
    pub elevation: Option<f64>,
    pub time: Option<String>,
}

/// Per-section placement for GPX import (tracks/routes from Step 2).
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct GpxSectionPlacement {
    pub section_index: u32,
    pub placement: ImportPlacement,
    pub name: Option<String>,
    pub color: String,
}

// ============================================================================
// Parser
// ============================================================================

/// Strip XML namespace prefix from a tag name (e.g. "gpx:trk" → "trk").
fn strip_ns(name: &[u8]) -> &[u8] {
    match name.iter().position(|&b| b == b':') {
        Some(i) => &name[i + 1..],
        None => name,
    }
}

/// Get the local tag name from a quick-xml event, stripping any namespace prefix.
fn local_name(e: &quick_xml::events::BytesStart<'_>) -> Vec<u8> {
    let qname = e.name();
    strip_ns(qname.as_ref()).to_vec()
}

/// Parse a GPX file from the given path.
pub fn parse_gpx(path: &Path) -> Result<GpxFile> {
    let contents =
        std::fs::read_to_string(path).with_context(|| format!("Failed to read {}", path.display()))?;
    parse_gpx_str(&contents)
}

/// Parse GPX from a string (for testing).
pub fn parse_gpx_str(xml: &str) -> Result<GpxFile> {
    let mut reader = Reader::from_str(xml);

    let mut gpx = GpxFile {
        name: None,
        waypoints: Vec::new(),
        tracks: Vec::new(),
        routes: Vec::new(),
    };

    let mut buf = Vec::new();

    // Find the <gpx> root element
    loop {
        match reader.read_event_into(&mut buf) {
            Ok(Event::Start(ref e)) => {
                let tag = local_name(e);
                if tag == b"gpx" {
                    break;
                }
            }
            Ok(Event::Eof) => bail!("Not a valid GPX file: no <gpx> root element found"),
            Err(e) => bail!("XML parse error: {e}"),
            _ => {}
        }
        buf.clear();
    }

    buf.clear();

    // Parse children of <gpx>
    let mut depth = 1u32;
    loop {
        match reader.read_event_into(&mut buf) {
            Ok(Event::Start(ref e)) => {
                let tag = local_name(e);
                // Extract lat/lon now while `e` is still alive
                let lat_lon = if tag == b"wpt" || tag == b"trkpt" || tag == b"rtept" {
                    Some(parse_lat_lon(e)?)
                } else {
                    None
                };
                depth += 1;
                match tag.as_slice() {
                    b"metadata" => {
                        gpx.name = parse_metadata_name(&mut reader)?;
                        depth -= 1;
                    }
                    b"wpt" => {
                        let (lat, lon) = lat_lon.unwrap();
                        gpx.waypoints.push(parse_waypoint_children(lat, lon, &mut reader)?);
                        depth -= 1;
                    }
                    b"trk" => {
                        gpx.tracks.push(parse_track(&mut reader)?);
                        depth -= 1;
                    }
                    b"rte" => {
                        gpx.routes.push(parse_route(&mut reader)?);
                        depth -= 1;
                    }
                    _ => {}
                }
            }
            Ok(Event::Empty(ref e)) => {
                let tag = local_name(e);
                if tag == b"wpt" {
                    let (lat, lon) = parse_lat_lon(e)?;
                    gpx.waypoints.push(GpxWaypoint {
                        name: None,
                        comment: None,
                        latitude: lat,
                        longitude: lon,
                        elevation: None,
                        time: None,
                    });
                }
            }
            Ok(Event::End(_)) => {
                depth -= 1;
                if depth == 0 {
                    break;
                }
            }
            Ok(Event::Eof) => break,
            Err(e) => bail!("XML parse error: {e}"),
            _ => {}
        }
        buf.clear();
    }

    Ok(gpx)
}

/// Parse lat/lon attributes from a waypoint-like element.
fn parse_lat_lon(e: &quick_xml::events::BytesStart<'_>) -> Result<(f64, f64)> {
    let mut lat = None;
    let mut lon = None;

    for attr in e.attributes().flatten() {
        match attr.key.as_ref() {
            b"lat" => {
                lat = Some(
                    std::str::from_utf8(&attr.value)
                        .context("Invalid UTF-8 in lat attribute")?
                        .parse::<f64>()
                        .context("Invalid lat value")?,
                );
            }
            b"lon" => {
                lon = Some(
                    std::str::from_utf8(&attr.value)
                        .context("Invalid UTF-8 in lon attribute")?
                        .parse::<f64>()
                        .context("Invalid lon value")?,
                );
            }
            _ => {}
        }
    }

    let lat = lat.context("Missing lat attribute")?;
    let lon = lon.context("Missing lon attribute")?;

    if !(-90.0..=90.0).contains(&lat) {
        bail!("Latitude {lat} out of range [-90, 90]");
    }
    if !(-180.0..=180.0).contains(&lon) {
        bail!("Longitude {lon} out of range [-180, 180]");
    }

    Ok((lat, lon))
}

/// Read the text content of the current element (between start and end tags).
fn read_text(reader: &mut Reader<&[u8]>) -> Result<String> {
    let mut buf = Vec::new();
    let mut text = String::new();
    loop {
        match reader.read_event_into(&mut buf) {
            Ok(Event::Text(ref e)) => {
                text.push_str(&e.unescape().context("Invalid text content")?);
            }
            Ok(Event::End(_)) | Ok(Event::Eof) => break,
            Ok(Event::Start(_)) => {
                // Nested element — skip it entirely
                skip_element(reader)?;
            }
            Err(e) => bail!("XML parse error: {e}"),
            _ => {}
        }
        buf.clear();
    }
    Ok(text)
}

/// Skip past the current element and all its children (after Start has been consumed).
fn skip_element(reader: &mut Reader<&[u8]>) -> Result<()> {
    let mut buf = Vec::new();
    let mut depth = 1u32;
    loop {
        match reader.read_event_into(&mut buf) {
            Ok(Event::Start(_)) => depth += 1,
            Ok(Event::End(_)) => {
                depth -= 1;
                if depth == 0 {
                    return Ok(());
                }
            }
            Ok(Event::Eof) => return Ok(()),
            Err(e) => bail!("XML parse error: {e}"),
            _ => {}
        }
        buf.clear();
    }
}

/// Parse <metadata> and extract the <name> child if present.
fn parse_metadata_name(reader: &mut Reader<&[u8]>) -> Result<Option<String>> {
    let mut buf = Vec::new();
    let mut name = None;
    let mut depth = 1u32;

    loop {
        match reader.read_event_into(&mut buf) {
            Ok(Event::Start(ref e)) => {
                depth += 1;
                let tag = local_name(e);
                if tag == b"name" && depth == 2 {
                    let text = read_text(reader)?;
                    depth -= 1; // read_text consumed the end tag
                    if !text.is_empty() {
                        name = Some(text);
                    }
                }
            }
            Ok(Event::End(_)) => {
                depth -= 1;
                if depth == 0 {
                    break;
                }
            }
            Ok(Event::Eof) => break,
            Err(e) => bail!("XML parse error: {e}"),
            _ => {}
        }
        buf.clear();
    }

    Ok(name)
}

/// Parse children of a <wpt> element (lat/lon already extracted).
fn parse_waypoint_children(
    latitude: f64,
    longitude: f64,
    reader: &mut Reader<&[u8]>,
) -> Result<GpxWaypoint> {
    let mut wpt = GpxWaypoint {
        name: None,
        comment: None,
        latitude,
        longitude,
        elevation: None,
        time: None,
    };

    let mut buf = Vec::new();
    let mut depth = 1u32;

    loop {
        match reader.read_event_into(&mut buf) {
            Ok(Event::Start(ref e)) => {
                depth += 1;
                let tag = local_name(e);
                if depth == 2 {
                    match tag.as_slice() {
                        b"name" => {
                            let t = read_text(reader)?;
                            depth -= 1;
                            if !t.is_empty() {
                                wpt.name = Some(t);
                            }
                        }
                        b"cmt" => {
                            let t = read_text(reader)?;
                            depth -= 1;
                            if !t.is_empty() && wpt.comment.is_none() {
                                wpt.comment = Some(t);
                            }
                        }
                        b"desc" => {
                            let t = read_text(reader)?;
                            depth -= 1;
                            if !t.is_empty() && wpt.comment.is_none() {
                                wpt.comment = Some(t);
                            }
                        }
                        b"ele" => {
                            let t = read_text(reader)?;
                            depth -= 1;
                            wpt.elevation = t.parse::<f64>().ok();
                        }
                        b"time" => {
                            let t = read_text(reader)?;
                            depth -= 1;
                            if !t.is_empty() {
                                wpt.time = Some(t);
                            }
                        }
                        _ => {}
                    }
                }
            }
            Ok(Event::End(_)) => {
                depth -= 1;
                if depth == 0 {
                    break;
                }
            }
            Ok(Event::Eof) => break,
            Err(e) => bail!("XML parse error: {e}"),
            _ => {}
        }
        buf.clear();
    }

    Ok(wpt)
}

/// Parse a <trk> element.
fn parse_track(reader: &mut Reader<&[u8]>) -> Result<GpxTrack> {
    let mut trk = GpxTrack {
        name: None,
        comment: None,
        segments: Vec::new(),
    };

    let mut buf = Vec::new();
    let mut depth = 1u32;

    loop {
        match reader.read_event_into(&mut buf) {
            Ok(Event::Start(ref e)) => {
                depth += 1;
                let tag = local_name(e);
                match tag.as_slice() {
                    b"name" if depth == 2 => {
                        let t = read_text(reader)?;
                        depth -= 1;
                        if !t.is_empty() {
                            trk.name = Some(t);
                        }
                    }
                    b"cmt" if depth == 2 => {
                        let t = read_text(reader)?;
                        depth -= 1;
                        if !t.is_empty() && trk.comment.is_none() {
                            trk.comment = Some(t);
                        }
                    }
                    b"desc" if depth == 2 => {
                        let t = read_text(reader)?;
                        depth -= 1;
                        if !t.is_empty() && trk.comment.is_none() {
                            trk.comment = Some(t);
                        }
                    }
                    b"trkseg" => {
                        trk.segments.push(parse_track_segment(reader)?);
                        depth -= 1;
                    }
                    _ => {}
                }
            }
            Ok(Event::End(_)) => {
                depth -= 1;
                if depth == 0 {
                    break;
                }
            }
            Ok(Event::Eof) => break,
            Err(e) => bail!("XML parse error: {e}"),
            _ => {}
        }
        buf.clear();
    }

    Ok(trk)
}

/// Parse a <trkseg> element.
fn parse_track_segment(reader: &mut Reader<&[u8]>) -> Result<GpxTrackSegment> {
    let mut seg = GpxTrackSegment { points: Vec::new() };
    let mut buf = Vec::new();
    let mut depth = 1u32;

    loop {
        match reader.read_event_into(&mut buf) {
            Ok(Event::Start(ref e)) => {
                depth += 1;
                let tag = local_name(e);
                if tag == b"trkpt" {
                    let (lat, lon) = parse_lat_lon(e)?;
                    seg.points.push(parse_point_children(lat, lon, reader)?);
                    depth -= 1;
                }
            }
            Ok(Event::Empty(ref e)) => {
                let tag = local_name(e);
                if tag == b"trkpt" {
                    let (lat, lon) = parse_lat_lon(e)?;
                    seg.points.push(GpxTrackPoint {
                        latitude: lat,
                        longitude: lon,
                        elevation: None,
                        time: None,
                    });
                }
            }
            Ok(Event::End(_)) => {
                depth -= 1;
                if depth == 0 {
                    break;
                }
            }
            Ok(Event::Eof) => break,
            Err(e) => bail!("XML parse error: {e}"),
            _ => {}
        }
        buf.clear();
    }

    Ok(seg)
}

/// Parse children of a <trkpt> or <rtept> element, returning a `GpxTrackPoint`.
fn parse_point_children(
    latitude: f64,
    longitude: f64,
    reader: &mut Reader<&[u8]>,
) -> Result<GpxTrackPoint> {
    let mut pt = GpxTrackPoint {
        latitude,
        longitude,
        elevation: None,
        time: None,
    };

    let mut buf = Vec::new();
    let mut depth = 1u32;

    loop {
        match reader.read_event_into(&mut buf) {
            Ok(Event::Start(ref e)) => {
                depth += 1;
                let tag = local_name(e);
                if depth == 2 {
                    match tag.as_slice() {
                        b"ele" => {
                            let t = read_text(reader)?;
                            depth -= 1;
                            pt.elevation = t.parse::<f64>().ok();
                        }
                        b"time" => {
                            let t = read_text(reader)?;
                            depth -= 1;
                            if !t.is_empty() {
                                pt.time = Some(t);
                            }
                        }
                        _ => {}
                    }
                }
            }
            Ok(Event::End(_)) => {
                depth -= 1;
                if depth == 0 {
                    break;
                }
            }
            Ok(Event::Eof) => break,
            Err(e) => bail!("XML parse error: {e}"),
            _ => {}
        }
        buf.clear();
    }

    Ok(pt)
}

/// Parse a <rte> element.
fn parse_route(reader: &mut Reader<&[u8]>) -> Result<GpxRoute> {
    let mut rte = GpxRoute {
        name: None,
        comment: None,
        points: Vec::new(),
    };

    let mut buf = Vec::new();
    let mut depth = 1u32;

    loop {
        match reader.read_event_into(&mut buf) {
            Ok(Event::Start(ref e)) => {
                depth += 1;
                let tag = local_name(e);
                match tag.as_slice() {
                    b"name" if depth == 2 => {
                        let t = read_text(reader)?;
                        depth -= 1;
                        if !t.is_empty() {
                            rte.name = Some(t);
                        }
                    }
                    b"cmt" if depth == 2 => {
                        let t = read_text(reader)?;
                        depth -= 1;
                        if !t.is_empty() && rte.comment.is_none() {
                            rte.comment = Some(t);
                        }
                    }
                    b"desc" if depth == 2 => {
                        let t = read_text(reader)?;
                        depth -= 1;
                        if !t.is_empty() && rte.comment.is_none() {
                            rte.comment = Some(t);
                        }
                    }
                    b"rtept" => {
                        let (lat, lon) = parse_lat_lon(e)?;
                        let pt = parse_route_point_children(lat, lon, reader)?;
                        rte.points.push(pt);
                        depth -= 1;
                    }
                    _ => {}
                }
            }
            Ok(Event::Empty(ref e)) => {
                let tag = local_name(e);
                if tag == b"rtept" {
                    let (lat, lon) = parse_lat_lon(e)?;
                    rte.points.push(GpxRoutePoint {
                        name: None,
                        latitude: lat,
                        longitude: lon,
                        elevation: None,
                        time: None,
                    });
                }
            }
            Ok(Event::End(_)) => {
                depth -= 1;
                if depth == 0 {
                    break;
                }
            }
            Ok(Event::Eof) => break,
            Err(e) => bail!("XML parse error: {e}"),
            _ => {}
        }
        buf.clear();
    }

    Ok(rte)
}

/// Parse children of an <rtept> element, returning a `GpxRoutePoint`.
fn parse_route_point_children(
    latitude: f64,
    longitude: f64,
    reader: &mut Reader<&[u8]>,
) -> Result<GpxRoutePoint> {
    let mut pt = GpxRoutePoint {
        name: None,
        latitude,
        longitude,
        elevation: None,
        time: None,
    };

    let mut buf = Vec::new();
    let mut depth = 1u32;

    loop {
        match reader.read_event_into(&mut buf) {
            Ok(Event::Start(ref e)) => {
                depth += 1;
                let tag = local_name(e);
                if depth == 2 {
                    match tag.as_slice() {
                        b"name" => {
                            let t = read_text(reader)?;
                            depth -= 1;
                            if !t.is_empty() {
                                pt.name = Some(t);
                            }
                        }
                        b"ele" => {
                            let t = read_text(reader)?;
                            depth -= 1;
                            pt.elevation = t.parse::<f64>().ok();
                        }
                        b"time" => {
                            let t = read_text(reader)?;
                            depth -= 1;
                            if !t.is_empty() {
                                pt.time = Some(t);
                            }
                        }
                        _ => {}
                    }
                }
            }
            Ok(Event::End(_)) => {
                depth -= 1;
                if depth == 0 {
                    break;
                }
            }
            Ok(Event::Eof) => break,
            Err(e) => bail!("XML parse error: {e}"),
            _ => {}
        }
        buf.clear();
    }

    Ok(pt)
}

// ============================================================================
// Conversion to import configs
// ============================================================================

/// Section color palette for imported GPX sections.
const GPX_COLORS: &[&str] = &[
    "#2ecc71", "#3498db", "#9b59b6", "#e67e22", "#1abc9c",
    "#e74c3c", "#f39c12", "#2980b9", "#8e44ad", "#27ae60",
];

/// Build a station comment from elevation data.
fn elevation_comment(elevation: Option<f64>) -> Option<String> {
    elevation.map(|e| format!("Elev: {e:.1}m"))
}

/// Convert GPS point pairs into virtual `ShotData`.
fn shots_from_points(points: &[(f64, f64, Option<f64>)]) -> Vec<ShotData> {
    if points.len() < 2 {
        return Vec::new();
    }

    points
        .windows(2)
        .map(|pair| {
            let (lat1, lon1, _ele1) = pair[0];
            let (lat2, lon2, _ele2) = pair[1];

            let length = haversine_distance(lat1, lon1, lat2, lon2);
            let azimuth = initial_bearing(lat1, lon1, lat2, lon2);

            ShotData {
                azimuth_in: azimuth,
                azimuth_out: azimuth,
                length,
                depth_in: 0.0,
                depth_out: 0.0,
                is_virtual: true,
                ..Default::default()
            }
        })
        .collect()
}

/// Station comments from point elevation data.
fn station_comments_from_points(points: &[(f64, f64, Option<f64>)]) -> Vec<(u32, String)> {
    points
        .iter()
        .enumerate()
        .filter_map(|(i, (_lat, _lon, ele))| {
            elevation_comment(*ele).map(|c| (i as u32, c))
        })
        .collect()
}

/// Convert waypoints into zero-datum import configs.
///
/// Each waypoint becomes a single-station section (0 shots) placed at its GPS coordinates.
pub fn waypoints_to_import_configs(
    waypoints: &[GpxWaypoint],
    start_index: u32,
) -> Result<Vec<ImportSectionConfig>> {
    let mut configs = Vec::new();

    for (i, wpt) in waypoints.iter().enumerate() {
        let idx = start_index + i as u32;
        let color_idx = idx as usize % GPX_COLORS.len();

        let gps = GpsCoordinates::new(wpt.latitude, wpt.longitude, 0.0)
            .map_err(|e| anyhow::anyhow!("Invalid waypoint GPS: {e}"))?;

        let mut station_comments = Vec::new();
        if let Some(ref c) = wpt.comment {
            station_comments.push((0u32, c.clone()));
        }
        if let Some(elev_comment) = elevation_comment(wpt.elevation) {
            if let Some((_idx, existing)) = station_comments.first_mut() {
                existing.push_str(&format!(" | {elev_comment}"));
            } else {
                station_comments.push((0u32, elev_comment));
            }
        }

        configs.push(ImportSectionConfig {
            section_index: idx,
            name: wpt.name.clone(),
            surveyor: None,
            date: None,
            color: GPX_COLORS[color_idx].to_string(),
            direction: None,
            quality: 1.0,
            shots: Vec::new(),
            placement: ImportPlacement::ZeroDatum {
                coordinates: gps,
                station_index: 0,
            },
            station_comments,
        });
    }

    Ok(configs)
}

/// Convert a track segment into an import config.
fn track_segment_to_config(
    seg: &GpxTrackSegment,
    section_index: u32,
    name: Option<String>,
    color: &str,
    placement: ImportPlacement,
) -> ImportSectionConfig {
    let points: Vec<(f64, f64, Option<f64>)> = seg
        .points
        .iter()
        .map(|p| (p.latitude, p.longitude, p.elevation))
        .collect();

    ImportSectionConfig {
        section_index,
        name,
        surveyor: None,
        date: None,
        color: color.to_string(),
        direction: None,
        quality: 1.0,
        shots: shots_from_points(&points),
        placement,
        station_comments: station_comments_from_points(&points),
    }
}

/// Convert a route into an import config.
fn route_to_config(
    rte: &GpxRoute,
    section_index: u32,
    color: &str,
    placement: ImportPlacement,
) -> ImportSectionConfig {
    let points: Vec<(f64, f64, Option<f64>)> = rte
        .points
        .iter()
        .map(|p| (p.latitude, p.longitude, p.elevation))
        .collect();

    ImportSectionConfig {
        section_index,
        name: rte.name.clone(),
        surveyor: None,
        date: None,
        color: color.to_string(),
        direction: None,
        quality: 1.0,
        shots: shots_from_points(&points),
        placement,
        station_comments: station_comments_from_points(&points),
    }
}

/// Convert a GPX file into import configs.
///
/// Waypoints are always placed as zero-datum sections. Track/route sections
/// use the provided placements (from Step 2 of the import dialog).
///
/// If `placements` is empty, track/route sections default to zero-datum
/// placement at their first station.
pub fn convert_gpx_to_import_configs(
    gpx: &GpxFile,
    import_waypoints: bool,
    import_tracks: bool,
    import_routes: bool,
    placements: &[GpxSectionPlacement],
) -> Result<Vec<ImportSectionConfig>> {
    let mut configs = Vec::new();
    let mut section_index = 0u32;

    // Waypoints → zero-datum sections
    if import_waypoints {
        let wpt_configs = waypoints_to_import_configs(&gpx.waypoints, section_index)?;
        section_index += wpt_configs.len() as u32;
        configs.extend(wpt_configs);
    }

    // Tracks → sections
    if import_tracks {
        for trk in &gpx.tracks {
            for (seg_i, seg) in trk.segments.iter().enumerate() {
                if seg.points.len() < 2 {
                    section_index += 1;
                    continue;
                }

                let first_pt = seg.points.first();
                let (placement, sec_name, color) =
                    resolve_placement(section_index, placements, first_pt, || {
                        if trk.segments.len() == 1 {
                            trk.name.clone()
                        } else {
                            Some(format!(
                                "{} seg {}",
                                trk.name.as_deref().unwrap_or("Track"),
                                seg_i + 1
                            ))
                        }
                    })?;

                configs.push(track_segment_to_config(
                    seg,
                    section_index,
                    sec_name,
                    &color,
                    placement,
                ));
                section_index += 1;
            }
        }
    }

    // Routes → sections
    if import_routes {
        for rte in &gpx.routes {
            if rte.points.len() < 2 {
                section_index += 1;
                continue;
            }

            // Convert first route point to a GpxTrackPoint for resolve_placement
            let first_as_trkpt = rte.points.first().map(|p| GpxTrackPoint {
                latitude: p.latitude,
                longitude: p.longitude,
                elevation: p.elevation,
                time: p.time.clone(),
            });

            let (placement, _sec_name, color) =
                resolve_placement(section_index, placements, first_as_trkpt.as_ref(), || rte.name.clone())?;

            configs.push(route_to_config(rte, section_index, &color, placement));
            section_index += 1;
        }
    }

    Ok(configs)
}

/// Resolve placement for a track/route section.
///
/// Uses user-provided placement from Step 2 if available, otherwise falls back
/// to zero-datum at the first point.
fn resolve_placement(
    section_index: u32,
    placements: &[GpxSectionPlacement],
    first_point: Option<&GpxTrackPoint>,
    default_name: impl FnOnce() -> Option<String>,
) -> Result<(ImportPlacement, Option<String>, String)> {
    if let Some(p) = placements.iter().find(|p| p.section_index == section_index) {
        return Ok((
            p.placement.clone(),
            p.name.clone(),
            p.color.clone(),
        ));
    }

    // Default: zero datum at first point
    let color_idx = section_index as usize % GPX_COLORS.len();
    let color = GPX_COLORS[color_idx].to_string();
    let name = default_name();

    let placement = if let Some(pt) = first_point {
        let gps = GpsCoordinates::new(pt.latitude, pt.longitude, 0.0)
            .map_err(|e| anyhow::anyhow!("Invalid GPS: {e}"))?;
        ImportPlacement::ZeroDatum {
            coordinates: gps,
            station_index: 0,
        }
    } else {
        ImportPlacement::Origin
    };

    Ok((placement, name, color))
}

// ============================================================================
// Tests
// ============================================================================

#[cfg(test)]
#[expect(clippy::unwrap_used)]
mod tests {
    use super::*;

    const SIMPLE_GPX: &str = r#"<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="test"
     xmlns="http://www.topografix.com/GPX/1/1">
  <metadata>
    <name>Test GPX File</name>
  </metadata>
  <wpt lat="45.5" lon="-90.5">
    <name>Cave Entrance</name>
    <cmt>Main entrance</cmt>
    <ele>350.2</ele>
    <time>2024-01-15T10:30:00Z</time>
  </wpt>
  <wpt lat="45.501" lon="-90.499">
    <name>Spring</name>
    <desc>Natural spring</desc>
    <ele>348.0</ele>
  </wpt>
  <trk>
    <name>Surface Path</name>
    <cmt>Path to cave</cmt>
    <trkseg>
      <trkpt lat="45.5" lon="-90.5">
        <ele>350.2</ele>
      </trkpt>
      <trkpt lat="45.5005" lon="-90.4995">
        <ele>351.0</ele>
      </trkpt>
      <trkpt lat="45.501" lon="-90.499">
        <ele>348.0</ele>
      </trkpt>
    </trkseg>
  </trk>
  <rte>
    <name>Planned Route</name>
    <rtept lat="45.5" lon="-90.5">
      <name>Start</name>
      <ele>350.2</ele>
    </rtept>
    <rtept lat="45.502" lon="-90.498">
      <name>End</name>
      <ele>345.0</ele>
    </rtept>
  </rte>
</gpx>"#;

    #[test]
    fn parse_basic_gpx() {
        let gpx = parse_gpx_str(SIMPLE_GPX).unwrap();

        assert_eq!(gpx.name.as_deref(), Some("Test GPX File"));
        assert_eq!(gpx.waypoints.len(), 2);
        assert_eq!(gpx.tracks.len(), 1);
        assert_eq!(gpx.routes.len(), 1);

        // Waypoints
        let wpt = &gpx.waypoints[0];
        assert_eq!(wpt.name.as_deref(), Some("Cave Entrance"));
        assert_eq!(wpt.comment.as_deref(), Some("Main entrance"));
        assert!((wpt.latitude - 45.5).abs() < 1e-9);
        assert!((wpt.longitude - (-90.5)).abs() < 1e-9);
        assert!((wpt.elevation.unwrap() - 350.2).abs() < 1e-9);
        assert_eq!(wpt.time.as_deref(), Some("2024-01-15T10:30:00Z"));

        // Second waypoint uses <desc> for comment
        let wpt2 = &gpx.waypoints[1];
        assert_eq!(wpt2.name.as_deref(), Some("Spring"));
        assert_eq!(wpt2.comment.as_deref(), Some("Natural spring"));

        // Track
        let trk = &gpx.tracks[0];
        assert_eq!(trk.name.as_deref(), Some("Surface Path"));
        assert_eq!(trk.comment.as_deref(), Some("Path to cave"));
        assert_eq!(trk.segments.len(), 1);
        assert_eq!(trk.segments[0].points.len(), 3);

        // Route
        let rte = &gpx.routes[0];
        assert_eq!(rte.name.as_deref(), Some("Planned Route"));
        assert_eq!(rte.points.len(), 2);
        assert_eq!(rte.points[0].name.as_deref(), Some("Start"));
    }

    #[test]
    fn parse_gpx_1_0_no_namespace() {
        let xml = r#"<?xml version="1.0"?>
<gpx version="1.0" creator="test">
  <wpt lat="45.0" lon="-90.0">
    <name>Point A</name>
  </wpt>
</gpx>"#;

        let gpx = parse_gpx_str(xml).unwrap();
        assert_eq!(gpx.waypoints.len(), 1);
        assert_eq!(gpx.waypoints[0].name.as_deref(), Some("Point A"));
    }

    #[test]
    fn parse_gpx_with_namespace_prefix() {
        let xml = r#"<?xml version="1.0"?>
<gpx:gpx xmlns:gpx="http://www.topografix.com/GPX/1/1" version="1.1">
  <gpx:wpt lat="10.0" lon="20.0">
    <gpx:name>NS Point</gpx:name>
    <gpx:ele>100.5</gpx:ele>
  </gpx:wpt>
</gpx:gpx>"#;

        let gpx = parse_gpx_str(xml).unwrap();
        assert_eq!(gpx.waypoints.len(), 1);
        assert_eq!(gpx.waypoints[0].name.as_deref(), Some("NS Point"));
        assert!((gpx.waypoints[0].elevation.unwrap() - 100.5).abs() < 1e-9);
    }

    #[test]
    fn reject_invalid_latitude() {
        let xml = r#"<?xml version="1.0"?>
<gpx version="1.1"><wpt lat="91.0" lon="0.0"></wpt></gpx>"#;

        let result = parse_gpx_str(xml);
        assert!(result.is_err());
        assert!(
            result.unwrap_err().to_string().contains("out of range"),
            "Should report lat out of range"
        );
    }

    #[test]
    fn empty_gpx_file() {
        let xml = r#"<?xml version="1.0"?><gpx version="1.1"></gpx>"#;
        let gpx = parse_gpx_str(xml).unwrap();
        assert!(gpx.waypoints.is_empty());
        assert!(gpx.tracks.is_empty());
        assert!(gpx.routes.is_empty());
        assert!(gpx.name.is_none());
    }

    #[test]
    fn waypoints_to_configs() {
        let gpx = parse_gpx_str(SIMPLE_GPX).unwrap();
        let configs = waypoints_to_import_configs(&gpx.waypoints, 0).unwrap();

        assert_eq!(configs.len(), 2);

        let c0 = &configs[0];
        assert_eq!(c0.section_index, 0);
        assert_eq!(c0.name.as_deref(), Some("Cave Entrance"));
        assert!(c0.shots.is_empty());
        assert!(matches!(&c0.placement, ImportPlacement::ZeroDatum { .. }));

        assert!(c0.station_comments.len() == 1);
        assert!(c0.station_comments[0].1.contains("Main entrance"));
        assert!(c0.station_comments[0].1.contains("Elev:"));
    }

    #[test]
    fn track_to_configs() {
        let gpx = parse_gpx_str(SIMPLE_GPX).unwrap();
        let configs =
            convert_gpx_to_import_configs(&gpx, false, true, false, &[]).unwrap();

        assert_eq!(configs.len(), 1);
        let c = &configs[0];
        assert_eq!(c.name.as_deref(), Some("Surface Path"));
        assert_eq!(c.shots.len(), 2);
        assert!(c.shots[0].is_virtual);
        assert!(c.shots[0].length > 0.0);
        assert!(c.shots[0].azimuth_in >= 0.0 && c.shots[0].azimuth_in < 360.0);
    }

    #[test]
    fn route_to_configs() {
        let gpx = parse_gpx_str(SIMPLE_GPX).unwrap();
        let configs =
            convert_gpx_to_import_configs(&gpx, false, false, true, &[]).unwrap();

        assert_eq!(configs.len(), 1);
        let c = &configs[0];
        assert_eq!(c.name.as_deref(), Some("Planned Route"));
        assert_eq!(c.shots.len(), 1);
    }

    #[test]
    fn all_types_combined() {
        let gpx = parse_gpx_str(SIMPLE_GPX).unwrap();
        let configs =
            convert_gpx_to_import_configs(&gpx, true, true, true, &[]).unwrap();

        // 2 waypoints + 1 track segment + 1 route = 4 sections
        assert_eq!(configs.len(), 4);

        for (i, c) in configs.iter().enumerate() {
            assert_eq!(c.section_index, i as u32);
        }
    }

    #[test]
    fn shot_computation_accuracy() {
        let xml = r#"<?xml version="1.0"?>
<gpx version="1.1">
  <trk><name>Test</name><trkseg>
    <trkpt lat="0.0" lon="0.0"><ele>100.0</ele></trkpt>
    <trkpt lat="0.0" lon="0.0005"><ele>100.0</ele></trkpt>
  </trkseg></trk>
</gpx>"#;

        let gpx = parse_gpx_str(xml).unwrap();
        let configs =
            convert_gpx_to_import_configs(&gpx, false, true, false, &[]).unwrap();

        assert_eq!(configs.len(), 1);
        assert_eq!(configs[0].shots.len(), 1);

        let shot = &configs[0].shots[0];
        assert!(
            (shot.length - 55.6).abs() < 1.0,
            "Expected ~55.6m, got {}",
            shot.length
        );
        assert!(
            (shot.azimuth_in - 90.0).abs() < 0.1,
            "Expected ~90°, got {}",
            shot.azimuth_in
        );
        assert!((shot.depth_in).abs() < 1e-9);
        assert!((shot.depth_out).abs() < 1e-9);
        assert!(shot.is_virtual);
    }

    #[test]
    fn multi_segment_track() {
        let xml = r#"<?xml version="1.0"?>
<gpx version="1.1">
  <trk>
    <name>Multi Seg</name>
    <trkseg>
      <trkpt lat="0.0" lon="0.0"/>
      <trkpt lat="0.001" lon="0.0"/>
    </trkseg>
    <trkseg>
      <trkpt lat="1.0" lon="1.0"/>
      <trkpt lat="1.001" lon="1.0"/>
    </trkseg>
  </trk>
</gpx>"#;

        let gpx = parse_gpx_str(xml).unwrap();
        assert_eq!(gpx.tracks[0].segments.len(), 2);

        let configs =
            convert_gpx_to_import_configs(&gpx, false, true, false, &[]).unwrap();
        assert_eq!(configs.len(), 2);
        assert_eq!(configs[0].name.as_deref(), Some("Multi Seg seg 1"));
        assert_eq!(configs[1].name.as_deref(), Some("Multi Seg seg 2"));
    }

    #[test]
    fn skip_single_point_segment() {
        let xml = r#"<?xml version="1.0"?>
<gpx version="1.1">
  <trk><name>T</name>
    <trkseg>
      <trkpt lat="0.0" lon="0.0"/>
    </trkseg>
  </trk>
</gpx>"#;

        let gpx = parse_gpx_str(xml).unwrap();
        let configs =
            convert_gpx_to_import_configs(&gpx, false, true, false, &[]).unwrap();
        assert!(configs.is_empty());
    }

    #[test]
    fn custom_placement_override() {
        let gpx = parse_gpx_str(SIMPLE_GPX).unwrap();
        let placements = vec![GpxSectionPlacement {
            section_index: 0,
            placement: ImportPlacement::Origin,
            name: Some("Custom Name".to_string()),
            color: "#ff0000".to_string(),
        }];

        let configs =
            convert_gpx_to_import_configs(&gpx, false, true, false, &placements).unwrap();

        assert_eq!(configs[0].name.as_deref(), Some("Custom Name"));
        assert_eq!(configs[0].color, "#ff0000");
        assert!(matches!(configs[0].placement, ImportPlacement::Origin));
    }
}
