//! Byte-order-mark handling shared by every text-based importer.
//!
//! Windows tooling writes "UTF-8 with BOM" by default (Notepad, PowerShell 5.1
//! `Out-File`, a common VS Code setting), so a survey file's first line can
//! arrive with `EF BB BF` glued to it.  The Walls and Compass readers map each
//! byte to a Windows-1252 char and the `.dmp` reader parses its first token as
//! an integer, so those three bytes void the file's first `#UNITS` / `.BOOK` /
//! cave name with no warning at all, or fail the import outright (#429). The
//! XML readers (GPX, TML/TMLU) survive a mark today, but only because
//! `quick-xml` skips text ahead of the root element; they read through here too
//! so that stays a property of one place rather than of the XML crate.
//!
//! A UTF-16 mark is refused rather than transcoded.  None of these formats are
//! written as UTF-16 in practice, and reading one anyway yields NUL-separated
//! bytes that match no directive at all - an import that comes back empty with
//! nothing to explain it.

use std::path::Path;

use anyhow::{anyhow, bail, Context, Result};

/// `EF BB BF`, the UTF-8 encoding of U+FEFF.
const UTF8_BOM: [u8; 3] = [0xef, 0xbb, 0xbf];

/// The endianness a leading UTF-16 byte-order mark declares, if any.
fn utf16_endianness(bytes: &[u8]) -> Option<&'static str> {
    match bytes {
        [0xff, 0xfe, ..] => Some("little-endian"),
        [0xfe, 0xff, ..] => Some("big-endian"),
        _ => None,
    }
}

/// Drop a leading UTF-8 byte-order mark, and refuse a UTF-16 one.
///
/// The error is self-contained: callers must not wrap it in a path context,
/// which would hide it behind the context line when the message reaches the
/// import dialog.
pub(crate) fn strip_bom(bytes: &[u8]) -> Result<&[u8]> {
    if let Some(endianness) = utf16_endianness(bytes) {
        bail!(
            "This file is UTF-16 ({endianness}) text; the importer reads UTF-8 or Latin-1. \
             Re-save it as UTF-8 and import it again."
        );
    }
    Ok(bytes.strip_prefix(&UTF8_BOM).unwrap_or(bytes))
}

/// [`strip_bom`] for bytes the caller already owns - a `Data.xml` unpacked
/// from a TML archive is up to half a gigabyte, so this shifts in place rather
/// than copying the remainder.
pub(crate) fn strip_bom_owned(mut bytes: Vec<u8>) -> Result<Vec<u8>> {
    let mark_len = bytes.len() - strip_bom(&bytes)?.len();
    bytes.drain(..mark_len);
    Ok(bytes)
}

/// The Windows-1252 code points for `0x80..=0x9F`, the only range where it
/// differs from ISO-8859-1 (which is byte == code point). Written as escapes so
/// the table stays ASCII in source. `U+FFFD` marks the five undefined slots.
const CP1252_HIGH: [char; 32] = [
    '\u{20ac}', '\u{fffd}', '\u{201a}', '\u{0192}', '\u{201e}', '\u{2026}', '\u{2020}', '\u{2021}',
    '\u{02c6}', '\u{2030}', '\u{0160}', '\u{2039}', '\u{0152}', '\u{fffd}', '\u{017d}', '\u{fffd}',
    '\u{fffd}', '\u{2018}', '\u{2019}', '\u{201c}', '\u{201d}', '\u{2022}', '\u{2013}', '\u{2014}',
    '\u{02dc}', '\u{2122}', '\u{0161}', '\u{203a}', '\u{0153}', '\u{fffd}', '\u{017e}', '\u{0178}',
];

/// Decode one byte as Windows-1252: `0x80..=0x9F` through [`CP1252_HIGH`],
/// every other byte as the code point of the same value.
pub(crate) fn cp1252_char(byte: u8) -> char {
    if (0x80..=0x9f).contains(&byte) {
        CP1252_HIGH[usize::from(byte - 0x80)]
    } else {
        char::from(byte)
    }
}

/// A file decoded by [`read_cp1252`].
pub(crate) struct Cp1252Text {
    pub(crate) text: String,
    /// How many of the file's bytes are among the five that Windows-1252
    /// leaves undefined, each of which became U+FFFD in `text`.
    pub(crate) replaced: usize,
}

/// Read a file written in Windows-1252, the ANSI code page that Compass and
/// Walls (both Windows programs) write their text in. Each byte becomes one
/// `char`, so accented surveyor names and comments never fail the read, and
/// the five bytes the code page leaves undefined become U+FFFD - counted, so
/// the caller can say so with [`cp1252_replacement_warning`].
pub(crate) fn read_cp1252(path: &Path) -> Result<Cp1252Text> {
    let bytes = std::fs::read(path).with_context(|| format!("reading {}", path.display()))?;
    let bytes = strip_bom(&bytes)?;
    let replaced = bytes
        .iter()
        .filter(|&&b| cp1252_char(b) == char::REPLACEMENT_CHARACTER)
        .count();
    Ok(Cp1252Text {
        text: bytes.iter().map(|&b| cp1252_char(b)).collect(),
        replaced,
    })
}

/// The tail of an encoding warning that accounts for `replaced` undecodable
/// characters, or an empty string when nothing was lost. Shared by the TML
/// reader and [`cp1252_replacement_warning`], so every importer counts its
/// losses in the same words.
pub(crate) fn describe_replaced_count(replaced: usize) -> String {
    match replaced {
        0 => String::new(),
        1 => "; 1 character was replaced".to_string(),
        n => format!("; {n} characters were replaced"),
    }
}

/// The warning for a file [`read_cp1252`] decoded with `replaced` undefined
/// bytes, or `None` when it had none. `file` names the file when the import
/// reads several (a Walls project); a single-file import passes `None`, since
/// the file is the one the user just picked. `program` is the one that writes
/// the format.
pub(crate) fn cp1252_replacement_warning(
    file: Option<&Path>,
    program: &str,
    replaced: usize,
) -> Option<String> {
    if replaced == 0 {
        return None;
    }
    let subject = file.map_or_else(
        || "The file".to_string(),
        |path| format!("'{}'", path.display()),
    );
    Some(format!(
        "{subject} was read as windows-1252, the encoding {program} writes{}",
        describe_replaced_count(replaced)
    ))
}

/// Read a UTF-8 text file (GPX, mNemo `.dmp`).
pub(crate) fn read_utf8(path: &Path) -> Result<String> {
    let bytes = std::fs::read(path).with_context(|| format!("reading {}", path.display()))?;
    String::from_utf8(strip_bom_owned(bytes)?)
        .map_err(|e| anyhow!("{} is not valid UTF-8 text: {e}", path.display()))
}

#[cfg(test)]
#[expect(clippy::unwrap_used)]
mod tests {
    use super::*;

    #[test]
    fn a_utf8_bom_is_dropped_and_nothing_else_is() {
        assert_eq!(strip_bom(b"\xef\xbb\xbf#UNITS").unwrap(), b"#UNITS");
        assert_eq!(strip_bom(b"#UNITS").unwrap(), b"#UNITS");
        // Only a LEADING mark: the same bytes mid-file are content.
        assert_eq!(
            strip_bom(b"#U\xef\xbb\xbfNITS").unwrap(),
            b"#U\xef\xbb\xbfNITS"
        );
        // A short file cannot be mistaken for a marked one.
        assert_eq!(strip_bom(b"\xef\xbb").unwrap(), b"\xef\xbb");
        assert_eq!(strip_bom(b"").unwrap(), b"");
    }

    /// Every byte decodes to exactly one char: `0x80..=0x9F` through the
    /// Windows-1252 table (the five slots it leaves undefined as U+FFFD, as the
    /// TML reader decodes them), every other byte as the same code point. A
    /// leading UTF-8 mark is still dropped first.
    #[test]
    fn read_cp1252_decodes_the_c1_range_as_windows_1252() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("all-bytes.srv");
        let mut bytes = UTF8_BOM.to_vec();
        bytes.extend(0..=u8::MAX);
        std::fs::write(&path, &bytes).unwrap();

        let decoded = read_cp1252(&path).unwrap();
        assert_eq!(decoded.replaced, 5, "the five undefined bytes are counted");
        let text: Vec<char> = decoded.text.chars().collect();
        assert_eq!(text.len(), 256, "one char per byte, mark dropped");
        for (byte, &c) in (0..=u8::MAX).zip(&text) {
            if (0x80..=0x9f).contains(&byte) {
                assert!(
                    !('\u{80}'..='\u{9f}').contains(&c),
                    "byte {byte:#04x} decoded to the C1 control U+{:04X}",
                    u32::from(c)
                );
            } else {
                assert_eq!(c, char::from(byte), "byte {byte:#04x}");
            }
        }
        for (byte, expected) in [
            (0x80_u8, '\u{20ac}'),
            (0x85, '\u{2026}'),
            (0x92, '\u{2019}'),
            (0x96, '\u{2013}'),
            (0x9f, '\u{0178}'),
            (0x81, '\u{fffd}'),
            (0x8d, '\u{fffd}'),
            (0x8f, '\u{fffd}'),
            (0x90, '\u{fffd}'),
            (0x9d, '\u{fffd}'),
        ] {
            assert_eq!(text[usize::from(byte)], expected, "byte {byte:#04x}");
        }
    }

    #[test]
    fn either_utf16_mark_is_refused_by_name() {
        for (bytes, endianness) in [
            (b"\xff\xfe#\0".as_slice(), "little-endian"),
            (b"\xfe\xff\0#".as_slice(), "big-endian"),
        ] {
            let err = strip_bom(bytes)
                .err()
                .map(|e| e.to_string())
                .unwrap_or_default();
            assert!(
                err.contains("UTF-16") && err.contains(endianness),
                "the error must name the encoding, got {err:?}"
            );
        }
    }
}
