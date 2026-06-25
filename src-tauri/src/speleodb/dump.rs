//! Project "dump" handling: classify what a downloaded dump contains and extract
//! the project `.stalx` from it.
//!
//! The classifier ([`classify`]) is a pure function over entry *names* so it is
//! unit-testable without a real archive; the ZIP I/O ([`Dump`]) opens the archive
//! once and both lists entries and extracts the chosen `.stalx` from it.
//!
//! The `.stalx` is located by **suffix**, never by the expected
//! `misc/project.stalx` path, so a server-side `TARGET_FOLDER` change cannot
//! break the pull (the server stores "other" files under `misc/` today, but that
//! is not part of the contract).

use std::io::{Cursor, Read};
use std::path::Path;

use super::SpeleoDbError;

/// Hard ceiling on a single extracted dump entry. The `.stalx` is a SQLite DB;
/// a few hundred MB is far past any real cave project but small enough that a
/// lying ZIP header (a zip bomb) can't exhaust memory before we reject it.
const MAX_ENTRY_BYTES: u64 = 512 * 1024 * 1024;

/// What a downloaded project dump contains, from the caller's point of view.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum DumpClassification {
    /// Exactly one `*.stalx` — open it. Holds the entry's path within the ZIP.
    Stalx(String),
    /// No `*.stalx` but an `ariane.tml` is present — route to C2 adoption (#214).
    AdoptAriane,
    /// Neither a `*.stalx` nor an `ariane.tml` — nothing to open.
    NothingToOpen,
    /// More than one `*.stalx` — ambiguous; fail closed (never guess which).
    AmbiguousStalx(Vec<String>),
}

/// Classify a dump from its list of entry paths. Pure; never panics.
pub(crate) fn classify(entry_paths: &[String]) -> DumpClassification {
    let stalx: Vec<String> = entry_paths
        .iter()
        .filter(|p| has_stalx_suffix(p))
        .cloned()
        .collect();

    match stalx.as_slice() {
        [only] => DumpClassification::Stalx(only.clone()),
        [] => {
            if entry_paths.iter().any(|p| is_ariane_tml(p)) {
                DumpClassification::AdoptAriane
            } else {
                DumpClassification::NothingToOpen
            }
        }
        _ => DumpClassification::AmbiguousStalx(stalx),
    }
}

/// Case-insensitive `.stalx` extension on the final path component.
fn has_stalx_suffix(path: &str) -> bool {
    Path::new(path)
        .extension()
        .is_some_and(|e| e.eq_ignore_ascii_case("stalx"))
}

/// The server reserves the root filename `ariane.tml` for the Ariane sidecar.
fn is_ariane_tml(path: &str) -> bool {
    Path::new(path)
        .file_name()
        .and_then(|n| n.to_str())
        .is_some_and(|n| n.eq_ignore_ascii_case("ariane.tml"))
}

/// A dump ZIP parsed once. Lists its entry paths and extracts the chosen entry
/// from the *same* archive, so the central directory isn't re-parsed between the
/// classify step and the extract step.
pub(crate) struct Dump<'a> {
    archive: zip::ZipArchive<Cursor<&'a [u8]>>,
}

impl<'a> Dump<'a> {
    /// Parse an in-memory dump ZIP.
    pub(crate) fn open(zip_bytes: &'a [u8]) -> Result<Self, SpeleoDbError> {
        let archive = zip::ZipArchive::new(Cursor::new(zip_bytes))
            .map_err(|e| SpeleoDbError::Parse(format!("dump is not a valid ZIP: {e}")))?;
        Ok(Self { archive })
    }

    /// The entry paths, in central-directory order — what [`classify`] consumes.
    pub(crate) fn entry_paths(&mut self) -> Result<Vec<String>, SpeleoDbError> {
        let mut names = Vec::with_capacity(self.archive.len());
        for i in 0..self.archive.len() {
            let entry = self
                .archive
                .by_index(i)
                .map_err(|e| SpeleoDbError::Parse(format!("could not read ZIP entry {i}: {e}")))?;
            names.push(entry.name().to_owned());
        }
        Ok(names)
    }

    /// Extract a single entry (the one chosen by [`classify`]) to `dest`, creating
    /// parent directories as needed.
    pub(crate) fn extract_entry_to(
        &mut self,
        entry_path: &str,
        dest: &Path,
    ) -> Result<(), SpeleoDbError> {
        self.extract_entry_capped(entry_path, dest, MAX_ENTRY_BYTES)
    }

    /// Extraction with an explicit byte ceiling (parameterized for testing). The
    /// entry's declared size comes from the ZIP central directory — server- /
    /// attacker-controlled — so it is rejected up front when it exceeds `max_bytes`
    /// (a lying-high header that would otherwise trigger a huge up-front
    /// allocation), and the read is bounded by `take(max_bytes + 1)` so a lying-low
    /// header over a deflate stream (a zip bomb: tiny compressed, huge inflated)
    /// can't exhaust memory either.
    fn extract_entry_capped(
        &mut self,
        entry_path: &str,
        dest: &Path,
        max_bytes: u64,
    ) -> Result<(), SpeleoDbError> {
        let entry = self.archive.by_name(entry_path).map_err(|e| {
            SpeleoDbError::Parse(format!("entry `{entry_path}` not found in dump: {e}"))
        })?;

        let declared = entry.size();
        if declared > max_bytes {
            return Err(SpeleoDbError::Parse(format!(
                "dump entry `{entry_path}` declares {declared} bytes, over the {max_bytes}-byte limit"
            )));
        }

        if let Some(parent) = dest.parent() {
            std::fs::create_dir_all(parent).map_err(|e| {
                SpeleoDbError::Io(format!("could not create {}: {e}", parent.display()))
            })?;
        }
        // `declared <= max_bytes`, so the pre-allocation is bounded.
        let limit = usize::try_from(max_bytes).unwrap_or(usize::MAX);
        let mut buf = Vec::with_capacity(usize::try_from(declared).unwrap_or(0));
        entry
            .take(max_bytes + 1)
            .read_to_end(&mut buf)
            .map_err(|e| SpeleoDbError::Io(format!("could not read `{entry_path}`: {e}")))?;
        if buf.len() > limit {
            return Err(SpeleoDbError::Parse(format!(
                "dump entry `{entry_path}` exceeded the {max_bytes}-byte limit while reading"
            )));
        }
        std::fs::write(dest, &buf)
            .map_err(|e| SpeleoDbError::Io(format!("could not write {}: {e}", dest.display())))?;
        Ok(())
    }
}

#[cfg(test)]
#[expect(clippy::expect_used, reason = "unit test fixtures")]
mod tests {
    use super::{classify, Dump, DumpClassification, SpeleoDbError};

    fn paths(items: &[&str]) -> Vec<String> {
        items.iter().map(|s| (*s).to_owned()).collect()
    }

    /// Build an in-memory ZIP from `(name, bytes)` entries (stored, uncompressed).
    fn make_zip(entries: &[(&str, &[u8])]) -> Vec<u8> {
        use std::io::Write as _;
        let mut writer = zip::write::ZipWriter::new(std::io::Cursor::new(Vec::<u8>::new()));
        let opts = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Stored);
        for (name, data) in entries {
            writer.start_file(*name, opts).expect("start_file");
            writer.write_all(data).expect("write entry");
        }
        writer.finish().expect("finish zip").into_inner()
    }

    #[test]
    fn exactly_one_stalx_opens() {
        let got = classify(&paths(&["misc/project.stalx", "ariane.tml", "README.md"]));
        assert_eq!(
            got,
            DumpClassification::Stalx("misc/project.stalx".to_owned())
        );
    }

    #[test]
    fn stalx_located_by_suffix_regardless_of_folder() {
        // A server TARGET_FOLDER change must not break the pull.
        let got = classify(&paths(&["some/other/dir/project.stalx"]));
        assert_eq!(
            got,
            DumpClassification::Stalx("some/other/dir/project.stalx".to_owned())
        );
    }

    #[test]
    fn zero_stalx_with_ariane_routes_to_adoption() {
        let got = classify(&paths(&["ariane.tml", "misc/notes.txt"]));
        assert_eq!(got, DumpClassification::AdoptAriane);
    }

    #[test]
    fn neither_is_nothing_to_open() {
        let got = classify(&paths(&["misc/notes.txt", "README.md"]));
        assert_eq!(got, DumpClassification::NothingToOpen);
    }

    #[test]
    fn two_stalx_fails_closed() {
        let got = classify(&paths(&["misc/project.stalx", "backup/old.stalx"]));
        assert!(
            matches!(&got, DumpClassification::AmbiguousStalx(v) if v.len() == 2),
            "expected AmbiguousStalx with 2 entries, got {got:?}"
        );
    }

    #[test]
    fn case_insensitive_extension() {
        let got = classify(&paths(&["misc/PROJECT.STALX"]));
        assert_eq!(
            got,
            DumpClassification::Stalx("misc/PROJECT.STALX".to_owned())
        );
    }

    #[test]
    fn empty_dump_is_nothing_to_open() {
        let got = classify(&paths(&[]));
        assert_eq!(got, DumpClassification::NothingToOpen);
    }

    #[test]
    fn entry_paths_lists_entries_in_order() {
        let zip = make_zip(&[("misc/project.stalx", b"data"), ("README.md", b"hi")]);
        let mut dump = Dump::open(&zip).expect("valid zip opens");
        let names = dump.entry_paths().expect("valid zip lists entries");
        assert_eq!(
            names,
            vec!["misc/project.stalx".to_owned(), "README.md".to_owned()]
        );
    }

    #[test]
    fn open_rejects_non_zip() {
        let err = Dump::open(b"this is plainly not a zip archive")
            .err()
            .expect("garbage bytes are not a ZIP");
        assert!(
            matches!(err, SpeleoDbError::Parse(_)),
            "non-ZIP bytes should map to Parse, got {err:?}"
        );
    }

    #[test]
    fn extract_entry_to_writes_chosen_entry_creating_parents() {
        let zip = make_zip(&[("misc/project.stalx", b"STALX-BYTES"), ("notes.txt", b"x")]);
        let dir = tempfile::tempdir().expect("tempdir");
        // A nested dest exercises the create_dir_all branch.
        let dest = dir.path().join("nested/out/project.stalx");
        let mut dump = Dump::open(&zip).expect("valid zip opens");
        dump.extract_entry_to("misc/project.stalx", &dest)
            .expect("extract chosen entry");
        let got = std::fs::read(&dest).expect("extracted file readable");
        assert_eq!(got, b"STALX-BYTES");
    }

    #[test]
    fn extract_entry_to_missing_entry_errors() {
        let zip = make_zip(&[("misc/project.stalx", b"data")]);
        let dir = tempfile::tempdir().expect("tempdir");
        let dest = dir.path().join("out.stalx");
        let mut dump = Dump::open(&zip).expect("valid zip opens");
        let err = dump
            .extract_entry_to("does/not/exist.stalx", &dest)
            .expect_err("absent entry must error");
        assert!(
            matches!(err, SpeleoDbError::Parse(_)),
            "missing entry should map to Parse, got {err:?}"
        );
    }

    #[test]
    fn lists_then_extracts_from_one_open() {
        // The orchestration path: open once, list entries (to classify), then
        // extract the chosen one from the same parsed archive.
        let zip = make_zip(&[("misc/project.stalx", b"PAYLOAD"), ("README.md", b"hi")]);
        let dir = tempfile::tempdir().expect("tempdir");
        let dest = dir.path().join("project.stalx");
        let mut dump = Dump::open(&zip).expect("valid zip opens");
        let names = dump.entry_paths().expect("lists entries");
        assert!(names.iter().any(|n| n == "misc/project.stalx"));
        dump.extract_entry_to("misc/project.stalx", &dest)
            .expect("extract after listing");
        assert_eq!(std::fs::read(&dest).expect("readable"), b"PAYLOAD");
    }

    #[test]
    fn extract_entry_rejects_oversized_entry() {
        // An entry whose declared size exceeds the cap is rejected before it can
        // allocate/read — guarding against a zip bomb from a hostile server.
        let zip = make_zip(&[("misc/project.stalx", b"0123456789")]); // 10 bytes
        let dir = tempfile::tempdir().expect("tempdir");
        let dest = dir.path().join("out.stalx");
        let mut dump = Dump::open(&zip).expect("valid zip opens");
        let err = dump
            .extract_entry_capped("misc/project.stalx", &dest, 4)
            .expect_err("oversized entry must be rejected");
        assert!(
            matches!(err, SpeleoDbError::Parse(_)),
            "oversized entry should map to Parse, got {err:?}"
        );
        assert!(
            !dest.exists(),
            "nothing should be written when over the cap"
        );
    }
}
