//! Minimal JSON writer.
//!
//! The helper's whole output surface is a single flat-ish object per run, so a
//! serde dependency would cost a cold-build tax for nothing. Only the shapes
//! this binary emits are representable; the one input that is not under our
//! control (an app name from the window list) goes through `escape`, which is
//! what the tests below pin.

use std::fmt::Write as _;

/// A JSON value the helper can emit.
pub enum Json {
    Bool(bool),
    Int(i64),
    /// Rendered with no exponent and no trailing `.0`, so screen coordinates
    /// read back as plain numbers on the TypeScript side.
    Num(f64),
    Str(String),
    Arr(Vec<Json>),
    /// Insertion-ordered object: stable output makes the JSON diffable in
    /// action logs and repro reports.
    Obj(Vec<(&'static str, Json)>),
}

impl Json {
    pub fn str(value: impl Into<String>) -> Json {
        Json::Str(value.into())
    }

    pub fn render(&self) -> String {
        let mut out = String::new();
        self.write(&mut out);
        out
    }

    fn write(&self, out: &mut String) {
        match self {
            Json::Bool(v) => out.push_str(if *v { "true" } else { "false" }),
            Json::Int(v) => {
                let _ = write!(out, "{v}");
            }
            Json::Num(v) => out.push_str(&render_f64(*v)),
            Json::Str(v) => escape(v, out),
            Json::Arr(items) => {
                out.push('[');
                for (i, item) in items.iter().enumerate() {
                    if i > 0 {
                        out.push(',');
                    }
                    item.write(out);
                }
                out.push(']');
            }
            Json::Obj(fields) => {
                out.push('{');
                for (i, (key, value)) in fields.iter().enumerate() {
                    if i > 0 {
                        out.push(',');
                    }
                    escape(key, out);
                    out.push(':');
                    value.write(out);
                }
                out.push('}');
            }
        }
    }
}

/// Non-finite values have no JSON spelling; they become `null` rather than
/// emitting `NaN`, which would make the whole document unparseable downstream.
fn render_f64(value: f64) -> String {
    if !value.is_finite() {
        return "null".to_string();
    }
    if value == value.trunc() && value.abs() < 1e15 {
        format!("{}", value as i64)
    } else {
        format!("{value}")
    }
}

fn escape(value: &str, out: &mut String) {
    out.push('"');
    for ch in value.chars() {
        match ch {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            '\u{08}' => out.push_str("\\b"),
            '\u{0c}' => out.push_str("\\f"),
            c if (c as u32) < 0x20 => {
                let _ = write!(out, "\\u{:04x}", c as u32);
            }
            c => out.push(c),
        }
    }
    out.push('"');
}

/// `{"ok":true, ...fields}` - the success envelope every subcommand emits.
pub fn ok(mut fields: Vec<(&'static str, Json)>) -> String {
    let mut all: Vec<(&'static str, Json)> = vec![("ok", Json::Bool(true))];
    all.append(&mut fields);
    Json::Obj(all).render()
}

/// `{"ok":false,"error":"..."}` - the failure envelope, always paired with a
/// nonzero exit code by the caller.
pub fn err(message: &str) -> String {
    Json::Obj(vec![
        ("ok", Json::Bool(false)),
        ("error", Json::str(message)),
    ])
    .render()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Written as a char so no test literal in this file has to contain a
    /// backslash-heavy escape sequence that is easy to mistype.
    const BACKSLASH: char = '\\';

    #[test]
    fn renders_the_success_envelope_with_ok_first() {
        let out = ok(vec![
            ("accessibility", Json::Bool(true)),
            ("screenRecording", Json::Bool(false)),
        ]);
        assert_eq!(
            out,
            r#"{"ok":true,"accessibility":true,"screenRecording":false}"#
        );
    }

    #[test]
    fn renders_the_failure_envelope() {
        assert_eq!(err("no window"), r#"{"ok":false,"error":"no window"}"#);
    }

    #[test]
    fn escapes_quotes_backslashes_and_newlines() {
        let out = err("say \"hi\" back\\forth\nnow");
        let expected = format!(
            r#"{{"ok":false,"error":"say {BACKSLASH}"hi{BACKSLASH}" back{BACKSLASH}{BACKSLASH}forth{BACKSLASH}nnow"}}"#
        );
        assert_eq!(out, expected);
    }

    #[test]
    fn escapes_raw_control_bytes_rather_than_emitting_them() {
        let out = err("bel\u{7}end");
        let expected = format!(r#"{{"ok":false,"error":"bel{BACKSLASH}u0007end"}}"#);
        assert_eq!(out, expected);
        assert!(!out.contains('\u{7}'), "a raw control byte escaped: {out}");
    }

    #[test]
    fn keeps_non_ascii_app_names_verbatim() {
        // App names are UTF-8 and JSON is UTF-8; escaping them to \u would only
        // make the action log harder to read.
        assert_eq!(err("Café"), "{\"ok\":false,\"error\":\"Café\"}");
    }

    #[test]
    fn renders_whole_floats_without_a_trailing_point() {
        let out = ok(vec![("x", Json::Num(100.0)), ("y", Json::Num(12.5))]);
        assert_eq!(out, r#"{"ok":true,"x":100,"y":12.5}"#);
    }

    #[test]
    fn renders_non_finite_numbers_as_null() {
        let out = ok(vec![("x", Json::Num(f64::NAN))]);
        assert_eq!(out, r#"{"ok":true,"x":null}"#);
    }

    #[test]
    fn renders_nested_objects_and_arrays() {
        let out = ok(vec![
            (
                "bounds",
                Json::Obj(vec![("x", Json::Num(1.0)), ("y", Json::Num(2.0))]),
            ),
            ("modifiers", Json::Arr(vec![Json::str("cmd")])),
            ("windowId", Json::Int(42)),
        ]);
        assert_eq!(
            out,
            r#"{"ok":true,"bounds":{"x":1,"y":2},"modifiers":["cmd"],"windowId":42}"#
        );
    }
}
