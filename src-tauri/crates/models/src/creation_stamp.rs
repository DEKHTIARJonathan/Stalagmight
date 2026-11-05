//! [#576 RV14-2] A section's creation time, kept as the text it was stored as.
//!
//! The `.stalx` `sections.created_at` column holds RFC 3339 text. What this app
//! writes is always `to_rfc3339()` (UTC, `+00:00`), but a file another tool wrote
//! can hold the same kind of value in another form: another offset (`+05:00`), a
//! `Z`, other fractional digits. Read as a UTC time and printed again by the next
//! save, it came back as the same moment in another text, in a column no edit had
//! touched. A stamp keeps the text it was read from, byte for byte, and the save
//! writes that back; only a section with no readable stamp gets a new one.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

/// When a section was created ([`crate::Section::created_at`]): an RFC 3339 time,
/// held as the exact text it was read from or first stamped as.
///
/// Serialized as that text, so an undo snapshot carries it unchanged. Read back,
/// it takes any RFC 3339 text - which is what the field's earlier type,
/// `DateTime<Utc>`, wrote - and refuses anything else, as that type did.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(try_from = "String", into = "String")]
pub struct CreationStamp(String);

impl CreationStamp {
    /// `text` as a stamp, unchanged, when it is an RFC 3339 time; `None` when it
    /// is not, and the next save stamps the section anew.
    pub fn parse(text: &str) -> Option<Self> {
        DateTime::parse_from_rfc3339(text)
            .ok()
            .map(|_| Self(text.to_owned()))
    }

    /// A new stamp of `at`, in the form this app writes.
    pub fn at(at: DateTime<Utc>) -> Self {
        Self(at.to_rfc3339())
    }

    /// The text: as it was stored, or as this app stamped it.
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl TryFrom<String> for CreationStamp {
    type Error = String;

    fn try_from(text: String) -> Result<Self, Self::Error> {
        match DateTime::parse_from_rfc3339(&text) {
            Ok(_) => Ok(Self(text)),
            Err(e) => Err(format!("not an RFC 3339 time ({e}): {text:?}")),
        }
    }
}

impl From<CreationStamp> for String {
    fn from(stamp: CreationStamp) -> Self {
        stamp.0
    }
}

#[cfg(test)]
#[expect(
    clippy::unwrap_used,
    reason = "test module: a failed assumption panics"
)]
mod tests {
    use super::CreationStamp;
    use chrono::{TimeZone, Utc};

    #[test]
    fn a_readable_text_is_kept_byte_for_byte_and_anything_else_is_no_stamp() {
        for text in [
            "2020-01-02T03:04:05+05:00",
            "2020-01-02T03:04:05Z",
            "2020-01-02T03:04:05.120-03:30",
        ] {
            assert_eq!(CreationStamp::parse(text).unwrap().as_str(), text);
        }
        for text in ["yesterday", "", "2020-01-02 03:04:05"] {
            assert_eq!(CreationStamp::parse(text), None, "{text:?}");
        }
    }

    #[test]
    fn a_new_stamp_is_written_as_this_app_writes_times() {
        let at = Utc.with_ymd_and_hms(2020, 1, 2, 3, 4, 5).unwrap();
        assert_eq!(CreationStamp::at(at).as_str(), "2020-01-02T03:04:05+00:00");
    }

    /// Serde carries the text unchanged (an undo snapshot), reads what the
    /// field's earlier type `DateTime<Utc>` wrote, and refuses what it refused.
    #[test]
    fn serde_carries_the_text_and_reads_the_earlier_form() {
        let stamp = CreationStamp::parse("2020-01-02T03:04:05+05:00").unwrap();
        let json = serde_json::to_string(&stamp).unwrap();
        assert_eq!(json, "\"2020-01-02T03:04:05+05:00\"");
        assert_eq!(serde_json::from_str::<CreationStamp>(&json).unwrap(), stamp);

        let earlier =
            serde_json::to_string(&Utc.with_ymd_and_hms(2020, 1, 2, 3, 4, 5).unwrap()).unwrap();
        let read: CreationStamp = serde_json::from_str(&earlier).unwrap();
        assert_eq!(format!("\"{}\"", read.as_str()), earlier);

        assert!(serde_json::from_str::<CreationStamp>("\"yesterday\"").is_err());
    }
}
