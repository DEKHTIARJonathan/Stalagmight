//! Key-spec grammar: `[modifier+]... key`.
//!
//! Examples: `cmd+s`, `cmd+shift+z`, `escape`, `return`, `ctrl+alt+f5`.
//!
//! Rules:
//! - Tokens are separated by `+` and are case-insensitive; surrounding spaces
//!   in a token are trimmed, so `cmd + s` parses.
//! - Every token but the last is a modifier; the last is the key.
//! - An empty token is an error. The literal plus key is `shift+equal`, which
//!   keeps `+` unambiguous as the separator.
//! - Keycodes are US-ANSI virtual keycodes (`kVK_ANSI_*`). They address a
//!   PHYSICAL key position, so on a non-US layout `keys a` presses whatever
//!   that layout puts where a US keyboard has `A`.

use core_graphics::event::{CGEventFlags, CGKeyCode};

#[derive(Debug)]
pub struct ParsedKeys {
    pub key: String,
    pub key_code: CGKeyCode,
    /// Modifier names in the canonical order they were resolved in, for the
    /// result JSON (the recorder wants what was pressed, not a bitmask).
    pub modifiers: Vec<&'static str>,
    pub flags: CGEventFlags,
}

/// Parse a key spec. `Err` carries a message meant for the user.
pub fn parse(spec: &str) -> Result<ParsedKeys, String> {
    let trimmed = spec.trim();
    if trimmed.is_empty() {
        return Err("empty key spec".to_string());
    }
    let tokens: Vec<&str> = trimmed.split('+').map(str::trim).collect();
    let Some((key_token, modifier_tokens)) = tokens.split_last() else {
        return Err(format!("cannot parse key spec {spec:?}"));
    };
    if tokens.iter().any(|token| token.is_empty()) {
        return Err(format!(
            "empty token in key spec {spec:?} (write the plus key as \"shift+equal\")"
        ));
    }

    let mut flags = CGEventFlags::empty();
    let mut modifiers = Vec::new();
    for token in modifier_tokens {
        let lower = token.to_ascii_lowercase();
        let (name, flag) = modifier(&lower)
            .ok_or_else(|| format!("unknown modifier {token:?} in key spec {spec:?}"))?;
        if !modifiers.contains(&name) {
            modifiers.push(name);
        }
        flags |= flag;
    }

    let key = key_token.to_ascii_lowercase();
    let key_code =
        key_code(&key).ok_or_else(|| format!("unknown key {key_token:?} in key spec {spec:?}"))?;
    Ok(ParsedKeys {
        key,
        key_code,
        modifiers,
        flags,
    })
}

fn modifier(token: &str) -> Option<(&'static str, CGEventFlags)> {
    match token {
        "cmd" | "command" | "meta" | "super" | "win" => {
            Some(("cmd", CGEventFlags::CGEventFlagCommand))
        }
        "shift" => Some(("shift", CGEventFlags::CGEventFlagShift)),
        "alt" | "opt" | "option" => Some(("alt", CGEventFlags::CGEventFlagAlternate)),
        "ctrl" | "control" => Some(("ctrl", CGEventFlags::CGEventFlagControl)),
        "fn" | "function" => Some(("fn", CGEventFlags::CGEventFlagSecondaryFn)),
        _ => None,
    }
}

/// US-ANSI virtual keycodes (Carbon `Events.h`, `kVK_*`).
fn key_code(key: &str) -> Option<CGKeyCode> {
    let code = match key {
        "a" => 0,
        "s" => 1,
        "d" => 2,
        "f" => 3,
        "h" => 4,
        "g" => 5,
        "z" => 6,
        "x" => 7,
        "c" => 8,
        "v" => 9,
        "b" => 11,
        "q" => 12,
        "w" => 13,
        "e" => 14,
        "r" => 15,
        "y" => 16,
        "t" => 17,
        "1" => 18,
        "2" => 19,
        "3" => 20,
        "4" => 21,
        "6" => 22,
        "5" => 23,
        "equal" => 24,
        "9" => 25,
        "7" => 26,
        "minus" => 27,
        "8" => 28,
        "0" => 29,
        "rightbracket" => 30,
        "o" => 31,
        "u" => 32,
        "leftbracket" => 33,
        "i" => 34,
        "p" => 35,
        "return" | "enter" => 36,
        "l" => 37,
        "j" => 38,
        "quote" => 39,
        "k" => 40,
        "semicolon" => 41,
        "backslash" => 42,
        "comma" => 43,
        "slash" => 44,
        "n" => 45,
        "m" => 46,
        "period" => 47,
        "tab" => 48,
        "space" => 49,
        "grave" | "backtick" => 50,
        "delete" | "backspace" => 51,
        "escape" | "esc" => 53,
        "keypadenter" => 76,
        "f5" => 96,
        "f6" => 97,
        "f7" => 98,
        "f3" => 99,
        "f8" => 100,
        "f9" => 101,
        "f11" => 103,
        "f10" => 109,
        "f12" => 111,
        "help" => 114,
        "home" => 115,
        "pageup" => 116,
        "forwarddelete" => 117,
        "f4" => 118,
        "end" => 119,
        "f2" => 120,
        "pagedown" => 121,
        "f1" => 122,
        "left" => 123,
        "right" => 124,
        "down" => 125,
        "up" => 126,
        _ => return None,
    };
    Some(code)
}

/// The grammar, for `--help` and the error path. Kept next to the tables it
/// describes so a new key name cannot drift out of the documentation.
pub const GRAMMAR: &str = concat!(
    "  key spec: [modifier+]... key   (case-insensitive, e.g. cmd+s, cmd+shift+z, escape)\n",
    "  modifiers: cmd|command|meta|super|win, shift, alt|opt|option, ctrl|control, fn\n",
    "  keys:      a-z  0-9  f1-f12\n",
    "             return|enter, escape|esc, tab, space, delete|backspace, forwarddelete,\n",
    "             up, down, left, right, home, end, pageup, pagedown, help, keypadenter,\n",
    "             minus, equal, comma, period, slash, backslash, semicolon, quote,\n",
    "             leftbracket, rightbracket, grave|backtick\n",
    "  the literal plus key is \"shift+equal\" (+ is always the separator)\n",
    "  keycodes are US-ANSI physical positions; a non-US layout presses the same\n",
    "  physical key, not the same printed character\n",
);

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_a_bare_key() {
        let parsed = parse("s").expect("s parses");
        assert_eq!(parsed.key_code, 1);
        assert!(parsed.modifiers.is_empty());
        assert_eq!(parsed.flags, CGEventFlags::empty());
    }

    #[test]
    fn parses_a_single_modifier() {
        let parsed = parse("cmd+s").expect("cmd+s parses");
        assert_eq!(parsed.key_code, 1);
        assert_eq!(parsed.modifiers, vec!["cmd"]);
        assert_eq!(parsed.flags, CGEventFlags::CGEventFlagCommand);
    }

    #[test]
    fn parses_stacked_modifiers_into_one_mask() {
        let parsed = parse("cmd+shift+z").expect("cmd+shift+z parses");
        assert_eq!(parsed.key_code, 6);
        assert_eq!(parsed.modifiers, vec!["cmd", "shift"]);
        assert_eq!(
            parsed.flags,
            CGEventFlags::CGEventFlagCommand | CGEventFlags::CGEventFlagShift
        );
    }

    #[test]
    fn is_case_and_space_insensitive() {
        let parsed = parse(" CMD + Shift + Z ").expect("parses");
        assert_eq!(parsed.key_code, 6);
        assert_eq!(
            parsed.flags,
            CGEventFlags::CGEventFlagCommand | CGEventFlags::CGEventFlagShift
        );
    }

    #[test]
    fn accepts_modifier_aliases() {
        for spec in ["command+s", "meta+s", "super+s", "win+s"] {
            let parsed = parse(spec).unwrap_or_else(|_| panic!("{spec} parses"));
            assert_eq!(parsed.flags, CGEventFlags::CGEventFlagCommand, "{spec}");
            assert_eq!(parsed.modifiers, vec!["cmd"], "{spec}");
        }
        for spec in ["alt+s", "opt+s", "option+s"] {
            let parsed = parse(spec).unwrap_or_else(|_| panic!("{spec} parses"));
            assert_eq!(parsed.flags, CGEventFlags::CGEventFlagAlternate, "{spec}");
        }
    }

    #[test]
    fn deduplicates_a_repeated_modifier_without_erroring() {
        let parsed = parse("cmd+cmd+s").expect("parses");
        assert_eq!(parsed.modifiers, vec!["cmd"]);
        assert_eq!(parsed.flags, CGEventFlags::CGEventFlagCommand);
    }

    #[test]
    fn accepts_named_keys_and_their_aliases() {
        assert_eq!(parse("escape").expect("escape").key_code, 53);
        assert_eq!(parse("esc").expect("esc").key_code, 53);
        assert_eq!(parse("return").expect("return").key_code, 36);
        assert_eq!(parse("enter").expect("enter").key_code, 36);
        assert_eq!(parse("delete").expect("delete").key_code, 51);
        assert_eq!(parse("backspace").expect("backspace").key_code, 51);
        assert_eq!(parse("f1").expect("f1").key_code, 122);
        assert_eq!(parse("f12").expect("f12").key_code, 111);
        assert_eq!(parse("up").expect("up").key_code, 126);
    }

    #[test]
    fn rejects_an_empty_spec() {
        assert!(parse("").is_err());
        assert!(parse("   ").is_err());
    }

    #[test]
    fn rejects_an_empty_token_with_the_plus_key_hint() {
        let message = parse("cmd++").expect_err("cmd++ is rejected");
        assert!(message.contains("shift+equal"), "{message}");
    }

    #[test]
    fn rejects_an_unknown_modifier_naming_the_token() {
        let message = parse("hyper+s").expect_err("hyper is rejected");
        assert!(message.contains("hyper"), "{message}");
    }

    #[test]
    fn rejects_an_unknown_key_naming_the_token() {
        let message = parse("cmd+nope").expect_err("nope is rejected");
        assert!(message.contains("nope"), "{message}");
    }

    #[test]
    fn rejects_a_modifier_used_as_the_key() {
        // "cmd" alone is not a key: pressing a bare modifier is not something
        // the harness needs, and silently mapping it would hide a typo.
        assert!(parse("cmd").is_err());
    }

    #[test]
    fn grammar_help_lists_every_alias_group() {
        for token in ["cmd", "shift", "alt", "ctrl", "escape", "shift+equal"] {
            assert!(GRAMMAR.contains(token), "grammar is missing {token}");
        }
    }
}
