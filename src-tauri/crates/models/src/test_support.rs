//! Helpers shared by the workspace's tests. Compiled for this crate's own
//! tests and for every dependent that enables `test-support` in its
//! `[dev-dependencies]`; production builds never see this module.
//!
//! # Opt-in prerequisites (#576 E13)
//!
//! An `#[ignore]`d test that needs something from outside the repo - a live
//! server's credentials, a private survey file, a corpus directory - takes it
//! through [`require_env`], [`require_file`] or [`require_env_file`]. Each
//! panics naming exactly what is missing.
//!
//! `#[ignore]` is already the skip: a default `cargo test` never runs these.
//! Someone who runs one on purpose (`-- --ignored <name>`) and forgot, or
//! mistyped, a variable must see a failure, not an `ok` from a test that
//! returned before its first assertion. The same helpers serve the default
//! tests that read a committed fixture: a fixture that went missing is a
//! failure too, never a silent skip.
//!
//! Blanket `cargo test -- --ignored` therefore fails for every opt-in test
//! whose prerequisites are absent; filter the run to the tests you can feed
//! (docs/testing-recipes.md, "Opt-in tests").

use std::path::{Path, PathBuf};

/// Fail the calling test because `what` - an environment variable, a file, a
/// build-time setting - is not there. The single exit every helper here
/// takes, for the cases they do not cover themselves.
///
/// # Panics
///
/// Always: failing the calling test, with `what` in the message, is the point.
#[track_caller]
#[expect(
    clippy::panic,
    reason = "a test helper: failing the calling test is its whole job"
)]
pub fn missing_prerequisite(what: &str) -> ! {
    panic!(
        "missing test prerequisite: {what}. A test run without what it needs fails \
         instead of passing having tested nothing; provide it, or run only the tests you \
         can feed (docs/testing-recipes.md, \"Opt-in tests\")."
    )
}

/// The value of the environment variable `var`. Unset, empty and non-UTF-8
/// all count as missing: none of them is something a test can use.
///
/// # Panics
///
/// Through [`missing_prerequisite`] when it is not there.
#[track_caller]
pub fn require_env(var: &str) -> String {
    match std::env::var(var) {
        Ok(value) if !value.is_empty() => value,
        Ok(_) => missing_prerequisite(&format!("environment variable {var} is set but empty")),
        Err(std::env::VarError::NotPresent) => {
            missing_prerequisite(&format!("environment variable {var} is not set"))
        }
        Err(std::env::VarError::NotUnicode(_)) => {
            missing_prerequisite(&format!("environment variable {var} is not valid UTF-8"))
        }
    }
}

/// `path`, which must exist (a file or a directory).
///
/// # Panics
///
/// Through [`missing_prerequisite`] when it is not there.
#[track_caller]
pub fn require_file(path: impl AsRef<Path>) -> PathBuf {
    let path = path.as_ref();
    match path.try_exists() {
        Ok(true) => path.to_path_buf(),
        Ok(false) => missing_prerequisite(&format!("{} does not exist", path.display())),
        Err(e) => missing_prerequisite(&format!("{} cannot be checked: {e}", path.display())),
    }
}

/// The path the environment variable `var` names, which must exist.
///
/// # Panics
///
/// Through [`missing_prerequisite`] when it is not there.
#[track_caller]
pub fn require_env_file(var: &str) -> PathBuf {
    let path = PathBuf::from(require_env(var));
    match path.try_exists() {
        Ok(true) => path,
        Ok(false) => missing_prerequisite(&format!(
            "{var}={} names a path that does not exist",
            path.display()
        )),
        Err(e) => missing_prerequisite(&format!("{var}={} cannot be checked: {e}", path.display())),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const UNSET: &str = "STALAGMIGHT_TEST_SUPPORT_NEVER_SET_E13";

    #[test]
    #[should_panic(
        expected = "missing test prerequisite: environment variable STALAGMIGHT_TEST_SUPPORT_NEVER_SET_E13 is not set"
    )]
    fn an_unset_variable_fails_the_test_and_names_the_variable() {
        assert!(
            std::env::var_os(UNSET).is_none(),
            "premise: {UNSET} is unset"
        );
        require_env(UNSET);
    }

    #[test]
    fn a_set_variable_is_returned() {
        // Cargo sets this for every test binary it runs.
        let dir = require_env("CARGO_MANIFEST_DIR");
        assert_eq!(dir, env!("CARGO_MANIFEST_DIR"));
    }

    #[test]
    #[should_panic(expected = "never-there.bin does not exist")]
    fn a_missing_file_fails_the_test_and_names_the_file() {
        require_file(Path::new(env!("CARGO_MANIFEST_DIR")).join("never-there.bin"));
    }

    #[test]
    fn an_existing_file_is_returned() {
        let manifest = Path::new(env!("CARGO_MANIFEST_DIR")).join("Cargo.toml");
        assert_eq!(require_file(&manifest), manifest);
    }

    #[test]
    #[should_panic(
        expected = "missing test prerequisite: environment variable STALAGMIGHT_TEST_SUPPORT_NEVER_SET_E13 is not set"
    )]
    fn a_file_variable_that_is_unset_names_the_variable() {
        require_env_file(UNSET);
    }

    #[test]
    fn a_file_variable_naming_an_existing_path_is_returned() {
        let dir = require_env_file("CARGO_MANIFEST_DIR");
        assert!(dir.join("Cargo.toml").exists());
    }
}
