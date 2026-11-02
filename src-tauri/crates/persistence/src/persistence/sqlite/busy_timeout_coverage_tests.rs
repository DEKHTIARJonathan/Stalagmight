//! [#576 RV5-RL-6] Every way to construct a `Database` is in the busy-timeout test.
//!
//! `busy_timeout_tests` pins the 5000 ms busy timeout on each open path, and it
//! lists those paths by hand: a new constructor was covered by nothing, and
//! nothing said so. This tripwire finds the constructors in the source - every
//! function that builds the struct (`Self { conn` / `Database { conn`; the field is
//! private to `sqlite`, so the struct cannot be built anywhere else) and every
//! function whose signature returns `Self` or `Database` in a `Result` or plainly -
//! and fails for any that `busy_timeout_tests.rs` never calls.

use std::collections::BTreeSet;
use std::path::Path;

/// Constructors the busy-timeout test cannot reach, with why that is safe. Keep it
/// this short: anything here is a construction no test pins the timeout of.
const NOT_AN_OPEN_PATH: &[(&str, &str)] = &[
    (
        "check_candidate_connection",
        "private to repair.rs: wraps a connection its two callers opened with \
         rusqlite's own Connection::open / open_with_flags (the default the busy-timeout \
         test pins) to check a restore candidate",
    ),
    (
        "open_existing_with",
        "private to open.rs: the one body of open_existing and \
         open_existing_refusing_upgrade (#576 RV4-R-M3-OPEN), which are its only callers \
         and are both opened in the busy-timeout test",
    ),
];

/// The production `.rs` files of the `sqlite` module: `sqlite.rs` and its children,
/// test modules (`*tests.rs`) excluded.
fn sqlite_sources() -> Vec<(String, String)> {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("src/persistence");
    let mut files = vec![root.join("sqlite.rs")];
    for entry in std::fs::read_dir(root.join("sqlite")).unwrap() {
        let path = entry.unwrap().path();
        let is_rust = path.extension().is_some_and(|ext| ext == "rs");
        let is_test = path
            .file_stem()
            .is_some_and(|stem| stem.to_string_lossy().ends_with("tests"));
        if is_rust && !is_test {
            files.push(path);
        }
    }
    files
        .into_iter()
        .map(|path| {
            let name = path.file_name().unwrap().to_string_lossy().into_owned();
            (name, std::fs::read_to_string(&path).unwrap())
        })
        .collect()
}

/// The name of the last `fn NAME` that starts before byte `at` in `src`.
fn enclosing_fn(src: &str, at: usize) -> Option<String> {
    let start = src[..at].rfind("fn ")? + 3;
    let name: String = src[start..]
        .chars()
        .take_while(|c| c.is_alphanumeric() || *c == '_')
        .collect();
    (!name.is_empty()).then_some(name)
}

/// Every constructor of `Database` in `src`, by the two rules in the module doc.
fn constructors(src: &str) -> BTreeSet<String> {
    let mut found = BTreeSet::new();
    for literal in ["Self { conn", "Database { conn"] {
        for (at, _) in src.match_indices(literal) {
            found.extend(enclosing_fn(src, at));
        }
    }
    for (at, _) in src.match_indices("fn ") {
        let header = &src[at..];
        let end = header.find(['{', ';']).unwrap_or(header.len());
        let signature: String = header[..end]
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ");
        let returns_one = ["Result<Self>", "Result<Database>"]
            .iter()
            .any(|ret| signature.contains(ret))
            || signature.ends_with("-> Self")
            || signature.ends_with("-> Database");
        if returns_one {
            found.extend(enclosing_fn(src, at + 3));
        }
    }
    found
}

#[test]
fn every_database_constructor_is_in_the_busy_timeout_test() {
    let covered = include_str!("busy_timeout_tests.rs");
    let mut uncovered = Vec::new();
    for (file, src) in sqlite_sources() {
        let in_impl_database = src.contains("impl Database {");
        for name in constructors(&src) {
            // A `Self`-returning fn outside `impl Database` constructs another type.
            if !in_impl_database && !src.contains("Database { conn") {
                continue;
            }
            let called = covered.contains(&format!("Database::{name}("))
                || covered.contains(&format!(".{name}("));
            let excused = NOT_AN_OPEN_PATH.iter().find(|(n, _)| *n == name);
            println!(
                "{file}: constructor {name} - in the busy-timeout test: {called}{}",
                excused.map_or(String::new(), |(_, why)| format!(
                    " (not an open path: {why})"
                ))
            );
            if !called && excused.is_none() {
                uncovered.push(format!("{file}::{name}"));
            }
        }
    }
    assert!(
        uncovered.is_empty(),
        "these Database constructors are not checked by busy_timeout_tests.rs - add an \
         open through each to `every_open_path_waits_at_least_five_seconds_for_a_busy_file`: \
         {uncovered:?}"
    );
}
