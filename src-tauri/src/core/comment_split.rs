//! Round-trippable shot/station comment encoding for Ariane `.tml` Comment fields.
//!
//! The TML format has one Comment field per shot but no per-station comment field,
//! so a Stalagmight station comment otherwise has nowhere to live in `.tml`. We
//! attach each station comment to the shot whose "to" station matches it and
//! distinguish shot vs station lines using a zero-width-space (`\u{200B}`) prefix:
//!
//! - Lines prefixed with `ZWSP` are shot comments.
//! - Lines without the prefix are station comments.
//!
//! This survives a round-trip through Ariane: the marker is invisible to humans
//! and Ariane preserves Comment text verbatim. New text Ariane users add carries
//! no marker, which routes it to the station — matching how Ariane visually
//! displays Comment text (centered on the station, not along the shot).

/// Zero-width space — the per-line marker that classifies a line as a shot
/// comment. Single Unicode codepoint (3 bytes UTF-8). Invisible in any editor.
pub const SHOT_MARKER: char = '\u{200B}';

/// Encode a shot comment and a station comment into a single TML Comment field.
///
/// Lines of `shot` are prefixed with [`SHOT_MARKER`]; lines of `station` are
/// written verbatim afterwards. Returns `None` when both inputs are empty (so
/// callers can leave the field unset). Empty/whitespace-only inputs are treated
/// as None.
pub fn merge(shot: Option<&str>, station: Option<&str>) -> Option<String> {
    let shot = shot.and_then(non_empty);
    let station = station.and_then(non_empty);
    match (shot, station) {
        (None, None) => None,
        (Some(s), None) => Some(prefix_lines(s)),
        (None, Some(st)) => Some(st.to_string()),
        (Some(s), Some(st)) => Some(format!("{}\n{}", prefix_lines(s), st)),
    }
}

/// Decode a TML Comment field into `(shot_comment, station_comment)`.
///
/// Each line is classified by whether its first char is [`SHOT_MARKER`]. The
/// marker is stripped from shot lines; station lines are kept verbatim. Returns
/// `(None, None)` for an empty input. Either component can be `None` if no lines
/// of that class were present.
pub fn split(s: Option<&str>) -> (Option<String>, Option<String>) {
    let Some(s) = s.and_then(non_empty) else {
        return (None, None);
    };
    let mut shot_lines: Vec<&str> = Vec::new();
    let mut station_lines: Vec<&str> = Vec::new();
    for line in s.split('\n') {
        match line.strip_prefix(SHOT_MARKER) {
            Some(rest) => shot_lines.push(rest),
            None => station_lines.push(line),
        }
    }
    (
        (!shot_lines.is_empty()).then(|| shot_lines.join("\n")),
        (!station_lines.is_empty()).then(|| station_lines.join("\n")),
    )
}

fn non_empty(s: &str) -> Option<&str> {
    if s.is_empty() { None } else { Some(s) }
}

fn prefix_lines(s: &str) -> String {
    s.split('\n')
        .map(|line| {
            let mut out = String::with_capacity(line.len() + SHOT_MARKER.len_utf8());
            out.push(SHOT_MARKER);
            out.push_str(line);
            out
        })
        .collect::<Vec<_>>()
        .join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    const M: char = SHOT_MARKER;

    #[test]
    fn both_none_is_none() {
        assert_eq!(merge(None, None), None);
        assert_eq!(split(None), (None, None));
        assert_eq!(split(Some("")), (None, None));
    }

    #[test]
    fn shot_only_round_trips() {
        let m = merge(Some("broken tape"), None).unwrap();
        assert_eq!(m, format!("{M}broken tape"));
        assert_eq!(split(Some(&m)), (Some("broken tape".into()), None));
    }

    #[test]
    fn station_only_round_trips() {
        let m = merge(None, Some("junction with main")).unwrap();
        assert_eq!(m, "junction with main");
        assert_eq!(split(Some(&m)), (None, Some("junction with main".into())));
    }

    #[test]
    fn both_round_trip() {
        let m = merge(Some("broken tape"), Some("junction with main")).unwrap();
        assert_eq!(m, format!("{M}broken tape\njunction with main"));
        assert_eq!(
            split(Some(&m)),
            (Some("broken tape".into()), Some("junction with main".into()))
        );
    }

    #[test]
    fn multiline_each_round_trips() {
        let shot = "broken tape\nre-survey needed";
        let station = "junction with main\nbeware silt";
        let m = merge(Some(shot), Some(station)).unwrap();
        assert_eq!(
            m,
            format!("{M}broken tape\n{M}re-survey needed\njunction with main\nbeware silt")
        );
        assert_eq!(split(Some(&m)), (Some(shot.into()), Some(station.into())));
    }

    #[test]
    fn ariane_authored_no_marker_routes_to_station() {
        // The whole point of the default: Ariane users have no way to type ZWSP,
        // so any comment they add lands on the station — matching Ariane's
        // visual convention (Comment displayed at the station).
        let (shot, station) = split(Some("muddy water\nfollows main passage"));
        assert_eq!(shot, None);
        assert_eq!(station, Some("muddy water\nfollows main passage".into()));
    }

    #[test]
    fn mid_line_marker_is_ignored() {
        // A ZWSP that isn't the very first character of a line carries no
        // meaning — keep it in the text so the original content round-trips.
        let body = format!("note with{M}embedded zwsp");
        let (shot, station) = split(Some(&body));
        assert_eq!(shot, None);
        assert_eq!(station, Some(body));
    }

    #[test]
    fn empty_shot_line_is_preserved() {
        // A bare marker line is a deliberately empty shot-comment line, not noise.
        let m = format!("{M}line one\n{M}\n{M}line three");
        assert_eq!(
            split(Some(&m)),
            (Some("line one\n\nline three".into()), None)
        );
    }

    #[test]
    fn whitespace_in_inputs_is_kept() {
        // Empty STRINGS map to None (see `non_empty`), but whitespace-only is
        // user content — keep it.
        let m = merge(Some("  "), Some(" ")).unwrap();
        assert_eq!(m, format!("{M}  \n "));
        assert_eq!(split(Some(&m)), (Some("  ".into()), Some(" ".into())));
    }

    #[test]
    fn interleaved_lines_partition() {
        // The split is line-by-line, not block-by-block: Ariane reordering or
        // inserting between marker lines still classifies correctly.
        let body = format!("{M}shot a\nstation a\n{M}shot b\nstation b");
        let (shot, station) = split(Some(&body));
        assert_eq!(shot, Some("shot a\nshot b".into()));
        assert_eq!(station, Some("station a\nstation b".into()));
    }
}
