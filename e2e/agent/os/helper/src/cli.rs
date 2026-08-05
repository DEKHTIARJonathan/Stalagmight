//! Argument parsing. Pure: no OS calls, so every accepted and rejected shape
//! is unit-testable without TCC permissions or a desktop.

use crate::keyspec::GRAMMAR;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Button {
    Left,
    Right,
}

#[derive(Debug, Clone, PartialEq)]
pub enum Command {
    Preflight,
    Click {
        x: f64,
        y: f64,
        button: Button,
        double: bool,
    },
    Move {
        x: f64,
        y: f64,
    },
    Drag {
        from: (f64, f64),
        to: (f64, f64),
        duration_ms: u64,
    },
    Keys {
        spec: String,
    },
    WindowId {
        pid: i32,
    },
    Frontmost,
    Menu {
        pid: i32,
        path: String,
    },
    Help,
}

/// Default interpolation time for `drag`, in milliseconds.
pub const DEFAULT_DRAG_MS: u64 = 300;

pub fn parse(args: &[String]) -> Result<Command, String> {
    let Some(first) = args.first() else {
        return Err("missing subcommand (try --help)".to_string());
    };
    let rest = &args[1..];
    match first.as_str() {
        "--help" | "-h" | "help" => Ok(Command::Help),
        "preflight" => expect_no_args(rest, Command::Preflight),
        "frontmost" => expect_no_args(rest, Command::Frontmost),
        "move" => {
            let (x, y) = coords(rest, "move")?;
            reject_extra(&rest[2..], "move")?;
            Ok(Command::Move { x, y })
        }
        "click" => {
            let (x, y) = coords(rest, "click")?;
            let mut button = Button::Left;
            let mut double = false;
            for flag in &rest[2..] {
                match flag.as_str() {
                    "--right" => button = Button::Right,
                    "--double" => double = true,
                    other => return Err(format!("unknown option {other:?} for click")),
                }
            }
            Ok(Command::Click {
                x,
                y,
                button,
                double,
            })
        }
        "drag" => {
            if rest.len() < 4 {
                return Err("drag needs X1 Y1 X2 Y2".to_string());
            }
            let from = (number(&rest[0], "X1")?, number(&rest[1], "Y1")?);
            let to = (number(&rest[2], "X2")?, number(&rest[3], "Y2")?);
            let mut duration_ms = DEFAULT_DRAG_MS;
            let mut tail = rest[4..].iter();
            while let Some(flag) = tail.next() {
                match flag.as_str() {
                    "--duration-ms" => {
                        let value = tail
                            .next()
                            .ok_or_else(|| "--duration-ms needs a value".to_string())?;
                        duration_ms = value.parse::<u64>().map_err(|_| {
                            format!("--duration-ms expects an integer, got {value:?}")
                        })?;
                    }
                    other => return Err(format!("unknown option {other:?} for drag")),
                }
            }
            Ok(Command::Drag {
                from,
                to,
                duration_ms,
            })
        }
        "keys" => {
            let Some(spec) = rest.first() else {
                return Err(format!("keys needs a spec\n{GRAMMAR}"));
            };
            reject_extra(&rest[1..], "keys")?;
            Ok(Command::Keys { spec: spec.clone() })
        }
        "window-id" => {
            let pid = pid_flag(rest, "window-id")?;
            reject_extra(&rest[2..], "window-id")?;
            Ok(Command::WindowId { pid })
        }
        "menu" => {
            let pid = pid_flag(rest, "menu")?;
            let Some(path) = rest.get(2) else {
                return Err("menu needs a path, e.g. \"File>Save\"".to_string());
            };
            reject_extra(&rest[3..], "menu")?;
            Ok(Command::Menu {
                pid,
                path: path.clone(),
            })
        }
        other => Err(format!("unknown subcommand {other:?} (try --help)")),
    }
}

fn expect_no_args(rest: &[String], command: Command) -> Result<Command, String> {
    reject_extra(rest, "this subcommand")?;
    Ok(command)
}

fn reject_extra(rest: &[String], what: &str) -> Result<(), String> {
    match rest.first() {
        Some(extra) => Err(format!("unexpected argument {extra:?} for {what}")),
        None => Ok(()),
    }
}

fn coords(rest: &[String], what: &str) -> Result<(f64, f64), String> {
    if rest.len() < 2 {
        return Err(format!("{what} needs X and Y"));
    }
    Ok((number(&rest[0], "X")?, number(&rest[1], "Y")?))
}

fn number(raw: &str, name: &str) -> Result<f64, String> {
    let parsed = raw
        .parse::<f64>()
        .map_err(|_| format!("{name} expects a number, got {raw:?}"))?;
    if parsed.is_finite() {
        Ok(parsed)
    } else {
        Err(format!("{name} expects a finite number, got {raw:?}"))
    }
}

fn pid_flag(rest: &[String], what: &str) -> Result<i32, String> {
    match (rest.first().map(String::as_str), rest.get(1)) {
        (Some("--pid"), Some(value)) => value
            .parse::<i32>()
            .map_err(|_| format!("--pid expects an integer, got {value:?}"))
            .and_then(|pid| {
                if pid > 0 {
                    Ok(pid)
                } else {
                    Err(format!("--pid expects a positive pid, got {pid}"))
                }
            }),
        _ => Err(format!("{what} needs --pid N")),
    }
}

pub fn help() -> String {
    format!(
        "stalagmight-oshelper - OS-level input and window queries for the Stalagmight\n\
         agent harness (Tier 2, macOS). Every run prints ONE JSON object on stdout;\n\
         failures print {{\"ok\":false,\"error\":...}} and exit nonzero.\n\
         \n\
         Coordinates are screen POINTS (the CGEvent native space), origin top-left of\n\
         the main display. They are NOT Retina backing-store pixels.\n\
         \n\
         USAGE\n\
         \x20 preflight                      report Accessibility + Screen Recording grants\n\
         \x20 click X Y [--right] [--double] hover, then press and release\n\
         \x20 move X Y                       move the cursor\n\
         \x20 drag X1 Y1 X2 Y2 [--duration-ms N]\n\
         \x20                                press, interpolate, release (default {DEFAULT_DRAG_MS} ms)\n\
         \x20 keys <spec>                    press one key with real modifier flags\n\
         \x20 window-id --pid N              frontmost on-screen window id + bounds for a pid\n\
         \x20 frontmost                      pid and app name of the frontmost window\n\
         \x20 menu --pid N \"File>Save\"       drive the menu bar over accessibility (UNIMPLEMENTED)\n\
         \x20 --help                         this text\n\
         \n\
         KEY SPEC\n\
         {GRAMMAR}\n\
         PERMISSIONS\n\
         \x20 click/move/drag/keys need Accessibility, and refuse to run without it:\n\
         \x20 posting events untrusted silently does nothing, which would read as a\n\
         \x20 passing test. The grant belongs to the process that SPAWNED this helper\n\
         \x20 (your terminal or editor), not to the helper binary.\n\
         \n\
         ENVIRONMENT\n\
         \x20 STALAGMIGHT_OSHELPER_LIVE=1    opt in to the tests that post real input\n"
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| (*s).to_string()).collect()
    }

    #[test]
    fn parses_the_no_argument_subcommands() {
        assert_eq!(parse(&args(&["preflight"])), Ok(Command::Preflight));
        assert_eq!(parse(&args(&["frontmost"])), Ok(Command::Frontmost));
        assert_eq!(parse(&args(&["--help"])), Ok(Command::Help));
        assert_eq!(parse(&args(&["-h"])), Ok(Command::Help));
    }

    #[test]
    fn rejects_no_subcommand_and_unknown_subcommands() {
        assert!(parse(&[]).is_err());
        let message = parse(&args(&["scroll"])).expect_err("scroll is unknown");
        assert!(message.contains("scroll"), "{message}");
    }

    #[test]
    fn parses_click_with_defaults_and_flags() {
        assert_eq!(
            parse(&args(&["click", "10", "20.5"])),
            Ok(Command::Click {
                x: 10.0,
                y: 20.5,
                button: Button::Left,
                double: false
            })
        );
        assert_eq!(
            parse(&args(&["click", "1", "2", "--right", "--double"])),
            Ok(Command::Click {
                x: 1.0,
                y: 2.0,
                button: Button::Right,
                double: true
            })
        );
    }

    #[test]
    fn rejects_bad_click_arguments() {
        assert!(parse(&args(&["click", "10"])).is_err());
        let message = parse(&args(&["click", "x", "2"])).expect_err("x is not a number");
        assert!(message.contains("number"), "{message}");
        assert!(parse(&args(&["click", "1", "2", "--middle"])).is_err());
        assert!(parse(&args(&["click", "1", "nan"])).is_err());
    }

    #[test]
    fn parses_negative_coordinates_for_secondary_displays() {
        // A display left of or above the main one has negative point coords;
        // rejecting them would make the helper unusable on a two-screen desk.
        assert_eq!(
            parse(&args(&["move", "-100", "-40"])),
            Ok(Command::Move {
                x: -100.0,
                y: -40.0
            })
        );
    }

    #[test]
    fn parses_drag_with_and_without_a_duration() {
        assert_eq!(
            parse(&args(&["drag", "1", "2", "3", "4"])),
            Ok(Command::Drag {
                from: (1.0, 2.0),
                to: (3.0, 4.0),
                duration_ms: DEFAULT_DRAG_MS
            })
        );
        assert_eq!(
            parse(&args(&["drag", "1", "2", "3", "4", "--duration-ms", "50"])),
            Ok(Command::Drag {
                from: (1.0, 2.0),
                to: (3.0, 4.0),
                duration_ms: 50
            })
        );
        assert!(parse(&args(&["drag", "1", "2", "3"])).is_err());
        assert!(parse(&args(&["drag", "1", "2", "3", "4", "--duration-ms"])).is_err());
        assert!(parse(&args(&[
            "drag",
            "1",
            "2",
            "3",
            "4",
            "--duration-ms",
            "fast"
        ]))
        .is_err());
    }

    #[test]
    fn parses_keys_and_rejects_extra_tokens() {
        assert_eq!(
            parse(&args(&["keys", "cmd+s"])),
            Ok(Command::Keys {
                spec: "cmd+s".to_string()
            })
        );
        // Two positional specs is nearly always an unquoted spec with a space.
        assert!(parse(&args(&["keys", "cmd", "s"])).is_err());
        assert!(parse(&args(&["keys"])).is_err());
    }

    #[test]
    fn parses_window_id_and_menu_pids() {
        assert_eq!(
            parse(&args(&["window-id", "--pid", "42"])),
            Ok(Command::WindowId { pid: 42 })
        );
        assert_eq!(
            parse(&args(&["menu", "--pid", "42", "File>Save"])),
            Ok(Command::Menu {
                pid: 42,
                path: "File>Save".to_string()
            })
        );
        assert!(parse(&args(&["window-id"])).is_err());
        assert!(parse(&args(&["window-id", "42"])).is_err());
        assert!(parse(&args(&["window-id", "--pid", "0"])).is_err());
        assert!(parse(&args(&["window-id", "--pid", "-3"])).is_err());
        assert!(parse(&args(&["menu", "--pid", "42"])).is_err());
    }

    #[test]
    fn help_documents_every_subcommand_and_the_points_contract() {
        let text = help();
        for token in [
            "preflight",
            "click",
            "move",
            "drag",
            "keys",
            "window-id",
            "frontmost",
            "menu",
            "POINTS",
            "Accessibility",
            "STALAGMIGHT_OSHELPER_LIVE",
        ] {
            assert!(text.contains(token), "--help is missing {token}");
        }
    }
}
