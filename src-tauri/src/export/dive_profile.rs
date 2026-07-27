//! Dive-profile export (#299): the planned round-trip profile as something a diver can carry out
//! of the app.
//!
//! Two renderers over the same `GasReachField.route_profile` series:
//!
//! - **Subsurface XML** - `<divelog><dives><dive><divecomputer><sample time= depth=>`, written to
//!   match the shape Subsurface's own writer emits so its `File > Import` can read it.
//!   ⚠ The grammar is modelled on Subsurface's format, but this has NOT been round-tripped through
//!   a real Subsurface build - treat "importable" as intent, not a verified fact, until someone
//!   does. `subsurface_xml_matches_the_documented_grammar` pins the shape we believe is required.
//! - **Plain text** - a fixed-width table, because the common case is a diver copying the numbers
//!   onto a slate or retyping them into another planner.
//!
//! Both lead with a header saying what this is NOT. The app has no decompression model at all: no
//! ascent, no stops, no tissue loading. A file that merely *looked* like a dive log, opened in a
//! deco planner months later, is exactly the sort of thing that gets read as a schedule - so the
//! disclaimer is a correctness requirement, not politeness.

use std::fmt::Write as _;
use std::io::Cursor;

use anyhow::Result;
use quick_xml::events::{BytesDecl, BytesEnd, BytesStart, BytesText, Event};
use quick_xml::Writer;

use crate::models::{GasReachField, RouteProfilePoint};

/// What this file is, on every export, in both formats.
const DISCLAIMER: &str =
    "Planned penetration profile from Stalagmight. NOT a decompression schedule: \
no ascent, stops or tissue loading are modelled. Depths and times are the planned \
route only.";

/// Which serialization the caller wants.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProfileFormat {
    /// Subsurface-importable XML.
    SubsurfaceXml,
    /// Fixed-width text table.
    PlainText,
}

impl ProfileFormat {
    /// Parse the wire value the frontend sends. Unknown values are rejected rather than defaulted:
    /// silently writing XML into a `.txt` the diver asked for is worse than a visible error.
    pub fn from_wire(value: &str) -> Result<Self> {
        match value {
            "subsurface-xml" => Ok(Self::SubsurfaceXml),
            "text" => Ok(Self::PlainText),
            other => Err(anyhow::anyhow!("unknown dive-profile format: {other}")),
        }
    }

    /// Stable identifier for logs and telemetry.
    pub(crate) fn label(self) -> &'static str {
        match self {
            Self::SubsurfaceXml => "subsurface-xml",
            Self::PlainText => "text",
        }
    }
}

/// Collapse anything that could forge a line or break the output format.
///
/// The project name is the one caller-controlled string that reaches these documents, and it is
/// loaded straight out of the project database with no validation. A name containing a newline
/// would inject arbitrary lines into a file whose whole purpose is to be read as plan data - a
/// forged `Turn: 400 m in, ...` above the real one, in a `.stalx` shared between cavers. C0 control
/// characters are also forbidden outright by XML 1.0, so leaving them in produces a file Subsurface
/// rejects. Truncated because the name is unbounded.
fn sanitize_name(name: &str) -> String {
    const MAX: usize = 120;
    let cleaned: String = name
        .chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .collect();
    let trimmed = cleaned.trim();
    match trimmed.char_indices().nth(MAX) {
        Some((cut, _)) => format!("{}...", &trimmed[..cut]),
        None => trimmed.to_string(),
    }
}

/// Render the profile in `format`. Errors when the plan has no route to export.
pub fn render_dive_profile(
    field: &GasReachField,
    format: ProfileFormat,
    project_name: &str,
) -> Result<String> {
    // `route_profile` is empty exactly when the engine found no turnaround (see its doc), so this
    // also refuses the way-point-over-budget case where a partial route is still drawn on the map.
    if field.route_profile.is_empty() {
        return Err(anyhow::anyhow!(
            "This plan has no route to export - set an origin and a reachable endpoint first."
        ));
    }
    let name = sanitize_name(project_name);
    match format {
        ProfileFormat::SubsurfaceXml => render_subsurface_xml(field, &name),
        ProfileFormat::PlainText => Ok(render_plain_text(field, &name)),
    }
}

/// `mm:ss` from fractional minutes - Subsurface's sample-time format.
///
/// Rounds to whole seconds and carries, so 1.9999 min renders as `2:00`, never `1:60`.
fn mmss(minutes: f64) -> String {
    let total = if minutes.is_finite() && minutes > 0.0 {
        (minutes * 60.0).round() as i64
    } else {
        0
    };
    format!("{}:{:02}", total / 60, total % 60)
}

/// One decimal, and never `-0.0` - a station a hair above the datum would otherwise export a
/// negative depth, which some importers reject outright.
fn depth_str(depth_m: f64) -> String {
    let d = if depth_m.is_finite() && depth_m > 0.0 {
        depth_m
    } else {
        0.0
    };
    format!("{d:.1} m")
}

fn max_depth(points: &[RouteProfilePoint]) -> f64 {
    points.iter().map(|p| p.depth_m).fold(0.0_f64, f64::max)
}

/// Subsurface's native dive XML: one `<sample>` per route station, over the whole round trip so the
/// dive returns to the entrance rather than ending at the turnaround.
///
/// The `<divelog>` wrapper and the ` min` suffix on every time are what Subsurface's own writer
/// emits; matching it is the closest we can get to importable without a round-trip through a real
/// build (see the module header - this is unverified).
///
/// Otherwise deliberately minimal - no cylinders, no gas mixes, no date. Emitting a fabricated dive
/// date or a gas mix the diver has not confirmed would make a *plan* indistinguishable from a logged
/// dive on import, which is precisely the confusion the disclaimer exists to prevent.
fn render_subsurface_xml(field: &GasReachField, project_name: &str) -> Result<String> {
    let points = &field.route_profile;
    let mut buf = Vec::new();
    let mut writer = Writer::new_with_indent(Cursor::new(&mut buf), b' ', 2);

    writer.write_event(Event::Decl(BytesDecl::new("1.0", Some("UTF-8"), None)))?;
    writer.write_event(Event::Comment(BytesText::new(DISCLAIMER)))?;

    let mut divelog = BytesStart::new("divelog");
    divelog.push_attribute(("program", "stalagmight"));
    divelog.push_attribute(("version", "3"));
    writer.write_event(Event::Start(divelog))?;
    writer.write_event(Event::Start(BytesStart::new("dives")))?;

    let duration = points.last().map_or(0.0, |p| p.elapsed_min);
    let mut dive = BytesStart::new("dive");
    dive.push_attribute(("number", "1"));
    dive.push_attribute(("duration", minutes_attr(duration).as_str()));
    writer.write_event(Event::Start(dive))?;

    write_text_element(&mut writer, "location", project_name)?;
    write_text_element(&mut writer, "notes", DISCLAIMER)?;

    let mut computer = BytesStart::new("divecomputer");
    computer.push_attribute(("model", "Stalagmight dive plan"));
    writer.write_event(Event::Start(computer))?;

    let mut depth = BytesStart::new("depth");
    depth.push_attribute(("max", depth_str(max_depth(points)).as_str()));
    writer.write_event(Event::Empty(depth))?;

    for point in points {
        let mut sample = BytesStart::new("sample");
        sample.push_attribute(("time", minutes_attr(point.elapsed_min).as_str()));
        sample.push_attribute(("depth", depth_str(point.depth_m).as_str()));
        writer.write_event(Event::Empty(sample))?;
    }

    writer.write_event(Event::End(BytesEnd::new("divecomputer")))?;
    writer.write_event(Event::End(BytesEnd::new("dive")))?;
    writer.write_event(Event::End(BytesEnd::new("dives")))?;
    writer.write_event(Event::End(BytesEnd::new("divelog")))?;

    drop(writer);
    Ok(String::from_utf8(buf)?)
}

/// `mm:ss min` - the unit-suffixed duration form Subsurface writes into time attributes.
fn minutes_attr(minutes: f64) -> String {
    format!("{} min", mmss(minutes))
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

/// Fixed-width table for a slate or a notes app.
///
/// Metric only, and labelled as such. This renderer has no access to the session's units toggle
/// (the field is canonical SI), and quietly emitting numbers whose unit the reader has to guess is
/// how a 30 m plan gets read as 30 ft.
fn render_plain_text(field: &GasReachField, project_name: &str) -> String {
    let points = &field.route_profile;
    let mut out = String::new();
    let _ = writeln!(out, "{project_name} - planned dive profile");
    out.push_str(DISCLAIMER);
    out.push_str(
        "\n\nAll values metric: distance/depth in metres, runtime in minutes, gas in litres.\n",
    );

    // Turn / drop callouts, keyed on route index so a route that doubles back marks the right pass.
    // `rev().find()` rather than `filter().last()`: the turnaround is the LAST outbound point, and
    // walking forward through the whole round trip to find it is the `double_ended_iterator_last`
    // lint's exact complaint.
    let turn = points.iter().rev().find(|p| p.outbound);
    let turn_index = turn.map(|p| p.route_index);
    let mut notes: Vec<String> = Vec::new();
    for (i, &route_index) in field.stage_drop_route_indices.iter().enumerate() {
        if let Some(p) = points
            .iter()
            .find(|p| p.outbound && p.route_index == route_index)
        {
            let flag = if field.stage_drop_over_reserve.get(i).copied() == Some(true) {
                "  [OVER RESERVE]"
            } else {
                ""
            };
            notes.push(format!(
                "Stage {} drop: {:.0} m in, {:.1} m deep, {} runtime{flag}",
                i + 1,
                p.distance_m,
                p.depth_m,
                mmss(p.elapsed_min)
            ));
        }
    }
    if let Some(turn) = turn {
        notes.push(format!(
            "Turn: {:.0} m in, {:.1} m deep, {} runtime, {:.0} L used",
            turn.distance_m,
            turn.depth_m,
            mmss(turn.elapsed_min),
            turn.gas_l
        ));
    }
    if !notes.is_empty() {
        out.push('\n');
        for note in &notes {
            out.push_str(note);
            out.push('\n');
        }
    }

    // Column stops, matching the row format below exactly (10, +1+10, +1+10, +1+11): 10, 21, 32, 44.
    // A slate is copied by eye, so a header sitting a character off its column is a real defect.
    out.push_str("\n   Dist(m)   Depth(m)    Runtime      Gas(L)  Leg\n");
    for p in points {
        let leg = if Some(p.route_index) == turn_index && p.outbound {
            "turn"
        } else if p.outbound {
            "in"
        } else {
            "out"
        };
        let _ = writeln!(
            out,
            "{:10.1} {:10.1} {:>10} {:11.0}  {leg}",
            p.distance_m,
            p.depth_m,
            mmss(p.elapsed_min),
            p.gas_l
        );
    }
    out
}

#[cfg(test)]
mod tests {
    #![expect(
        clippy::unwrap_used,
        clippy::expect_used,
        reason = "tests construct from known-valid literals; a failed unwrap should fail the test"
    )]

    use super::*;
    use crate::models::StationRef;

    fn point(
        route_index: u32,
        distance_m: f64,
        depth_m: f64,
        min: f64,
        outbound: bool,
    ) -> RouteProfilePoint {
        RouteProfilePoint {
            route_index,
            station_ref: StationRef::new(1, route_index),
            distance_m,
            depth_m,
            gas_l: distance_m * 3.0,
            elapsed_min: min,
            outbound,
        }
    }

    fn field() -> GasReachField {
        GasReachField {
            station_refs: Vec::new(),
            gas_to_reach: Vec::new(),
            reachable: Vec::new(),
            turn_frontier: Vec::new(),
            max_reachable_gas: 0.0,
            budget_litres: 2000.0,
            route: Vec::new(),
            stage_drop_refs: Vec::new(),
            final_turn_ref: None,
            turn_toward_endpoint: false,
            backgas_turn_bar: None,
            stage_drop_bars: Vec::new(),
            stage_drop_over_reserve: Vec::new(),
            stage_drop_distances_m: Vec::new(),
            cylinder_usable_bars: Vec::new(),
            route_line_length_m: 200.0,
            route_max_depth_m: Some(24.0),
            route_avg_depth_m: Some(12.0),
            waypoint_gas_litres: Vec::new(),
            route_profile: vec![
                point(0, 0.0, 0.0, 0.0, true),
                point(1, 100.0, 12.0, 20.0, true),
                point(2, 200.0, 24.0, 40.0, true),
                point(1, 300.0, 12.0, 50.0, false),
                point(0, 400.0, 0.0, 60.0, false),
            ],
            stage_drop_route_indices: Vec::new(),
            waypoint_route_indices: Vec::new(),
        }
    }

    #[test]
    fn xml_emits_one_sample_per_point_over_the_whole_round_trip() {
        let xml = render_dive_profile(&field(), ProfileFormat::SubsurfaceXml, "Cave").unwrap();
        assert_eq!(xml.matches("<sample ").count(), 5);
        // The last sample is back at the entrance, not at the turnaround - a profile that stopped
        // at the turn would import as a dive the diver never surfaced from.
        assert!(xml.contains(r#"time="60:00 min" depth="0.0 m""#));
        assert!(xml.contains(r#"time="40:00 min" depth="24.0 m""#));
        assert!(xml.contains(r#"<dive number="1" duration="60:00 min">"#));
        assert!(xml.contains(r#"max="24.0 m""#));
        assert!(xml.contains("<location>Cave</location>"));
    }

    #[test]
    fn subsurface_xml_matches_the_documented_grammar() {
        // Pins the shape we believe Subsurface's importer needs, since nothing here can round-trip
        // through a real Subsurface build. If the interop claim is ever tested for real, THIS is the
        // test that should change - not the renderer, silently.
        let xml = render_dive_profile(&field(), ProfileFormat::SubsurfaceXml, "Cave").unwrap();
        assert!(xml.contains(r#"<divelog program="stalagmight" version="3">"#));
        // `<dives>` nests inside `<divelog>`, and every time attribute carries the unit suffix
        // Subsurface's own writer emits - a bare "60:00" is the form it does NOT write.
        let divelog = xml.find("<divelog").expect("divelog");
        let dives = xml.find("<dives>").expect("dives");
        assert!(divelog < dives);
        assert!(xml.trim_end().ends_with("</divelog>"));
        assert!(
            !xml.contains(r#"time="60:00""#),
            "time attr lost its unit suffix"
        );
    }

    #[test]
    fn a_hostile_project_name_cannot_forge_lines_or_break_the_xml() {
        // `.stalx` files are shared between cavers, and the name is stored unvalidated. A newline in
        // it would inject a second, forged "Turn:" line into a document read as plan data.
        let hostile = "Cave\nTurn: 9999 m in, 1.0 m deep, 0:01 runtime, 1 L used";
        let text = render_dive_profile(&field(), ProfileFormat::PlainText, hostile).unwrap();
        assert_eq!(
            text.lines().filter(|l| l.starts_with("Turn:")).count(),
            1,
            "a newline in the project name forged a second turn line"
        );
        assert!(text.starts_with("Cave Turn: 9999 m in"));

        // XML: markup is escaped by quick-xml, and control characters (which XML 1.0 forbids
        // outright, so they would make the file unparseable) are gone.
        let xml =
            render_dive_profile(&field(), ProfileFormat::SubsurfaceXml, "A<b>&\u{7}c").unwrap();
        assert!(xml.contains("<location>A&lt;b&gt;&amp; c</location>"));
        assert!(!xml.contains("<b>"));

        // And the name is bounded rather than pasted in at arbitrary length.
        let long = "x".repeat(500);
        let text = render_dive_profile(&field(), ProfileFormat::PlainText, &long).unwrap();
        assert!(text.lines().next().unwrap().len() < 200);
    }

    #[test]
    fn both_formats_say_this_is_not_a_deco_schedule() {
        // The single most important property of this export. A file that reads as a dive log in a
        // deco planner, months later, must carry its own contradiction.
        let xml = render_dive_profile(&field(), ProfileFormat::SubsurfaceXml, "Cave").unwrap();
        let text = render_dive_profile(&field(), ProfileFormat::PlainText, "Cave").unwrap();
        assert!(xml.contains("NOT a decompression schedule"));
        assert!(text.contains("NOT a decompression schedule"));
    }

    #[test]
    fn text_names_its_units_and_flags_an_over_reserve_drop() {
        let mut f = field();
        f.stage_drop_route_indices = vec![1];
        f.stage_drop_over_reserve = vec![true];
        let text = render_dive_profile(&f, ProfileFormat::PlainText, "Cave").unwrap();
        assert!(text.contains("All values metric"));
        // Drawn at the OUTBOUND pass of route index 1 (100 m), not the return one (300 m).
        assert!(text.contains("Stage 1 drop: 100 m in, 12.0 m deep, 20:00 runtime  [OVER RESERVE]"));
        assert!(text.contains("Turn: 200 m in, 24.0 m deep, 40:00 runtime, 600 L used"));
        assert_eq!(text.lines().filter(|l| l.ends_with("  in")).count(), 2);
        assert_eq!(text.lines().filter(|l| l.ends_with("  out")).count(), 2);
        assert_eq!(text.lines().filter(|l| l.ends_with("  turn")).count(), 1);
    }

    #[test]
    fn an_empty_plan_is_an_error_not_an_empty_file() {
        // Writing a zero-sample dive would import cleanly and silently as a dive that never
        // happened, so the caller has to be told instead.
        let mut f = field();
        f.route_profile.clear();
        assert!(render_dive_profile(&f, ProfileFormat::SubsurfaceXml, "Cave").is_err());
        assert!(render_dive_profile(&f, ProfileFormat::PlainText, "Cave").is_err());
    }

    #[test]
    fn mmss_carries_instead_of_emitting_a_sixtieth_second() {
        assert_eq!(mmss(0.0), "0:00");
        assert_eq!(mmss(1.5), "1:30");
        // 1.9999 min is 119.994 s; rounding the SECONDS alone would print "1:60".
        assert_eq!(mmss(1.9999), "2:00");
        assert_eq!(mmss(-3.0), "0:00");
        assert_eq!(mmss(f64::NAN), "0:00");
    }

    #[test]
    fn depth_never_exports_negative_or_minus_zero() {
        // A station a hair above the datum has a slightly negative z; some importers reject it.
        assert_eq!(depth_str(-0.001), "0.0 m");
        assert_eq!(depth_str(-5.0), "0.0 m");
        assert_eq!(depth_str(f64::NAN), "0.0 m");
        assert_eq!(depth_str(12.34), "12.3 m");
    }

    #[test]
    fn format_wire_values_round_trip_and_reject_the_unknown() {
        assert_eq!(
            ProfileFormat::from_wire("subsurface-xml").unwrap(),
            ProfileFormat::SubsurfaceXml
        );
        assert_eq!(
            ProfileFormat::from_wire("text").unwrap(),
            ProfileFormat::PlainText
        );
        assert!(ProfileFormat::from_wire("uddf").is_err());
        assert!(ProfileFormat::from_wire("").is_err());
    }

    #[test]
    fn plain_text_golden() {
        // Replaces a byte-stability check that could not fail: `render_dive_profile` is a pure
        // function over a Vec, with no map iteration, timestamp or RNG, so calling it twice was
        // never able to differ - the assertion held for any implementation, correct or not.
        //
        // A golden actually pins the thing that matters for a fixed-width table meant to be copied
        // onto a slate by eye: the column stops. Header stops are 10 / 21 / 32 / 44, and every row
        // must land on them.
        let text = render_dive_profile(&field(), ProfileFormat::PlainText, "Cave").unwrap();
        let expected = "\
Cave - planned dive profile
Planned penetration profile from Stalagmight. NOT a decompression schedule: no ascent, stops or tissue loading are modelled. Depths and times are the planned route only.

All values metric: distance/depth in metres, runtime in minutes, gas in litres.

Turn: 200 m in, 24.0 m deep, 40:00 runtime, 600 L used

   Dist(m)   Depth(m)    Runtime      Gas(L)  Leg
       0.0        0.0       0:00           0  in
     100.0       12.0      20:00         300  in
     200.0       24.0      40:00         600  turn
     300.0       12.0      50:00         900  out
     400.0        0.0      60:00        1200  out
";
        assert_eq!(text, expected);

        // The header's own column stops, asserted rather than eyeballed.
        let header = text
            .lines()
            .find(|l| l.contains("Dist(m)"))
            .expect("header row");
        assert_eq!(header.find("Dist(m)").unwrap() + "Dist(m)".len(), 10);
        assert_eq!(header.find("Depth(m)").unwrap() + "Depth(m)".len(), 21);
        assert_eq!(header.find("Runtime").unwrap() + "Runtime".len(), 32);
        assert_eq!(header.find("Gas(L)").unwrap() + "Gas(L)".len(), 44);
    }
}
