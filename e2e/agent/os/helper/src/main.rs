//! stalagmight-oshelper - Tier 2 OS input and window queries for the agent
//! harness (see ../README.md).
//!
//! Contract: exactly one JSON object on stdout per run. Success is
//! `{"ok":true,...}` with exit 0; every failure, including a usage error, is
//! `{"ok":false,"error":"..."}` with exit 1. `--help` is the one exception and
//! prints plain text - the TypeScript wrapper never calls it.
//!
//! All coordinates are screen POINTS with a top-left origin, which is the
//! space CGEvent and the window list both speak. Retina scaling only matters
//! when interpreting captured pixels, never when posting events.

mod cli;
mod input;
mod json;
mod keyspec;
mod perms;
mod window;

use cli::{Button, Command};
use json::Json;
use window::WindowInfo;

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match run(&args) {
        Ok(Some(out)) => println!("{out}"),
        Ok(None) => print!("{}", cli::help()),
        Err(message) => {
            println!("{}", json::err(&message));
            std::process::exit(1);
        }
    }
}

/// `Ok(None)` means help was requested; `Ok(Some(json))` is the result line.
fn run(args: &[String]) -> Result<Option<String>, String> {
    match cli::parse(args)? {
        Command::Help => Ok(None),
        Command::Preflight => {
            let perms = perms::preflight();
            Ok(Some(json::ok(vec![
                ("accessibility", Json::Bool(perms.accessibility)),
                ("screenRecording", Json::Bool(perms.screen_recording)),
            ])))
        }
        Command::Move { x, y } => {
            require_accessibility()?;
            input::move_to(x, y)?;
            Ok(Some(json::ok(vec![
                ("action", Json::str("move")),
                ("x", Json::Num(x)),
                ("y", Json::Num(y)),
            ])))
        }
        Command::Click {
            x,
            y,
            button,
            double,
        } => {
            require_accessibility()?;
            input::click(x, y, button, double)?;
            Ok(Some(json::ok(vec![
                ("action", Json::str("click")),
                ("x", Json::Num(x)),
                ("y", Json::Num(y)),
                (
                    "button",
                    Json::str(match button {
                        Button::Left => "left",
                        Button::Right => "right",
                    }),
                ),
                ("clickCount", Json::Int(if double { 2 } else { 1 })),
            ])))
        }
        Command::Drag {
            from,
            to,
            duration_ms,
        } => {
            require_accessibility()?;
            let steps = input::drag(from, to, duration_ms)?;
            Ok(Some(json::ok(vec![
                ("action", Json::str("drag")),
                ("from", point(from)),
                ("to", point(to)),
                ("durationMs", Json::Int(duration_ms as i64)),
                ("steps", Json::Int(steps as i64)),
            ])))
        }
        Command::Keys { spec } => {
            let parsed = keyspec::parse(&spec)?;
            require_accessibility()?;
            input::keys(parsed.key_code, parsed.flags)?;
            Ok(Some(json::ok(vec![
                ("action", Json::str("keys")),
                ("spec", Json::str(spec)),
                ("key", Json::str(parsed.key)),
                ("keyCode", Json::Int(i64::from(parsed.key_code))),
                (
                    "modifiers",
                    Json::Arr(parsed.modifiers.into_iter().map(Json::str).collect()),
                ),
            ])))
        }
        Command::WindowId { pid } => Ok(Some(describe_window(&window::for_pid(pid)?))),
        Command::Frontmost => {
            let front = window::frontmost()?;
            Ok(Some(json::ok(vec![
                ("pid", Json::Int(i64::from(front.pid))),
                ("app", Json::str(front.owner)),
                ("windowId", Json::Int(front.window_id)),
            ])))
        }
        Command::Menu { pid, path } => Err(format!(
            "unimplemented: menu --pid {pid} {path:?} needs the accessibility \
             (AXUIElement) menu-bar walk; use `keys` for menu accelerators until then"
        )),
    }
}

fn require_accessibility() -> Result<(), String> {
    if perms::accessibility() {
        Ok(())
    } else {
        Err(perms::ACCESSIBILITY_DENIED.to_string())
    }
}

fn point((x, y): (f64, f64)) -> Json {
    Json::Obj(vec![("x", Json::Num(x)), ("y", Json::Num(y))])
}

fn describe_window(window: &WindowInfo) -> String {
    json::ok(vec![
        ("windowId", Json::Int(window.window_id)),
        ("pid", Json::Int(i64::from(window.pid))),
        ("app", Json::str(window.owner.clone())),
        (
            "bounds",
            Json::Obj(vec![
                ("x", Json::Num(window.bounds.x)),
                ("y", Json::Num(window.bounds.y)),
                ("w", Json::Num(window.bounds.w)),
                ("h", Json::Num(window.bounds.h)),
            ]),
        ),
    ])
}

#[cfg(test)]
mod tests {
    use super::*;

    /// GUI-touching tests are opt-in: they need a real desktop session (and,
    /// for anything that posts input, a TCC grant), so an unattended run would
    /// otherwise fail on a machine that is doing nothing wrong.
    fn live() -> bool {
        std::env::var("STALAGMIGHT_OSHELPER_LIVE").as_deref() == Ok("1")
    }

    fn args(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| (*s).to_string()).collect()
    }

    #[test]
    fn help_is_not_json() {
        assert_eq!(run(&args(&["--help"])), Ok(None));
    }

    #[test]
    fn preflight_reports_both_grants() {
        // Read-only: AXIsProcessTrusted and CGPreflightScreenCaptureAccess
        // never prompt, so this is safe unattended.
        let out = run(&args(&["preflight"]))
            .expect("preflight succeeds")
            .expect("preflight prints json");
        assert!(out.starts_with(r#"{"ok":true,"accessibility":"#), "{out}");
        assert!(out.contains(r#""screenRecording":"#), "{out}");
    }

    #[test]
    fn usage_errors_never_reach_the_os() {
        // A bad spec must be rejected BEFORE the permission check, so the
        // error a caller sees names the typo and not the missing grant.
        let message = run(&args(&["keys", "cmd+nope"])).expect_err("bad spec is rejected");
        assert!(message.contains("nope"), "{message}");
        assert!(!message.contains("Accessibility"), "{message}");
    }

    #[test]
    fn menu_is_explicitly_unimplemented() {
        let message =
            run(&args(&["menu", "--pid", "1", "File>Save"])).expect_err("menu is not implemented");
        assert!(message.starts_with("unimplemented:"), "{message}");
    }

    #[test]
    fn frontmost_names_a_real_app() {
        if !live() {
            return;
        }
        let out = run(&args(&["frontmost"]))
            .expect("frontmost succeeds")
            .expect("frontmost prints json");
        assert!(out.contains(r#""ok":true"#), "{out}");
        assert!(out.contains(r#""app":""#), "{out}");
    }

    #[test]
    fn window_id_finds_the_frontmost_apps_window() {
        if !live() {
            return;
        }
        let front = window::frontmost().expect("a frontmost window exists");
        let found = window::for_pid(front.pid).expect("the same pid has a window");
        assert_eq!(found.window_id, front.window_id);
        assert!(found.bounds.w >= 1.0 && found.bounds.h >= 1.0);
    }
}
