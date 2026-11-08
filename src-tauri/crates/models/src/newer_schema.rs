use serde::Serialize;
use ts_rs::TS;

/// A file a newer Stalagmight saved than this one can read (#649): a `.stalx`
/// whose schema version, or a `.plnx` whose dive-plan format, is above what this
/// build knows.
///
/// One type for every surface that reports the refusal, so they all say the
/// same thing: the persistence error inside an open, the load error's payload,
/// and the SpeleoDB error's payload. Its `Display` is the one English wording;
/// the frontend renders the same sentence from `newerSchema.message` in
/// `en.json` with these fields as parameters.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[ts(export, export_to = "../../bindings/")]
pub struct NewerSchema {
    /// The refused file's name (no directory), as the user knows it.
    pub file: String,
    /// The file's format version.
    pub found: i32,
    /// The newest format version this build reads.
    pub supported: i32,
}

impl std::fmt::Display for NewerSchema {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "\"{}\" was saved by a newer version of Stalagmight (file format {}; this \
             version reads up to {}). Update Stalagmight to open it.",
            self.file, self.found, self.supported
        )
    }
}

impl std::error::Error for NewerSchema {}

#[cfg(test)]
mod tests {
    use super::NewerSchema;

    /// The wording `en.json`'s `newerSchema.message` mirrors; change both together.
    #[test]
    fn the_refusal_reads_as_one_sentence_naming_the_file_and_both_versions() {
        let newer = NewerSchema {
            file: "cave.stalx".to_owned(),
            found: 19,
            supported: 18,
        };
        assert_eq!(
            newer.to_string(),
            "\"cave.stalx\" was saved by a newer version of Stalagmight (file format 19; \
             this version reads up to 18). Update Stalagmight to open it."
        );
    }
}
