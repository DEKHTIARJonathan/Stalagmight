//! [#619] Every open of an existing file refuses the SQLite features the repo's
//! build leaves out, whether or not the linked SQLite has them: creating a
//! virtual table, reading DBSTAT, and the functions FTS, R-tree and extension
//! loading register. The repo's `LIBSQLITE3_FLAGS` do not travel with a
//! published crate, so a crates.io build has every module compiled in, and the
//! authorizer is what keeps a hostile file away from them there.
//!
//! CI also runs this test on a build without the flags, with
//! `STALAGMIGHT_EXPECT_UNSTRIPPED_SQLITE` set, which makes it check that the
//! modules really are there. All data is synthetic: a project saved by this
//! build.

use std::path::{Path, PathBuf};
use std::time::Duration;

use rusqlite::{Connection, ErrorCode};
use tempfile::TempDir;

use crate::models::Project;
use crate::persistence::Database;

/// What a probe needs from the linked SQLite to get past name resolution.
#[derive(Clone, Copy)]
enum Needs {
    /// Nothing: the authorizer refuses it before SQLite looks the module up.
    Nothing,
    Module(&'static str),
    Function(&'static str),
}

const PROBES: &[(&str, Needs)] = &[
    ("SELECT * FROM dbstat", Needs::Module("dbstat")),
    ("SELECT count(*) FROM main.DBSTAT", Needs::Module("dbstat")),
    ("SELECT name FROM dbstat('main')", Needs::Module("dbstat")),
    (
        "SELECT token FROM fts3tokenize WHERE input = 'a b'",
        Needs::Module("fts3tokenize"),
    ),
    ("CREATE VIRTUAL TABLE t5 USING fts5(x)", Needs::Nothing),
    ("CREATE VIRTUAL TABLE t4 USING fts4(x)", Needs::Nothing),
    ("CREATE VIRTUAL TABLE t3 USING fts3(x)", Needs::Nothing),
    (
        "CREATE VIRTUAL TABLE tr USING rtree(id, x0, x1)",
        Needs::Nothing,
    ),
    (
        "SELECT load_extension('x')",
        Needs::Function("load_extension"),
    ),
    (
        "SELECT LOAD_EXTENSION('x', 'y')",
        Needs::Function("load_extension"),
    ),
    (
        "SELECT fts3_tokenizer('simple')",
        Needs::Function("fts3_tokenizer"),
    ),
    ("SELECT rtreecheck('t')", Needs::Function("rtreecheck")),
    ("SELECT fts5_source_id()", Needs::Function("fts5_source_id")),
];

/// Ordinary SQL the authorizer must still allow, an eponymous virtual table and
/// a table-valued pragma among it.
const ALLOWED: &[&str] = &[
    "SELECT count(*) FROM project",
    "SELECT lower(name) FROM project",
    "SELECT count(*) FROM json_each('[1, 2]')",
    "SELECT count(*) FROM pragma_table_info('project')",
];

type Opener = fn(&Path) -> anyhow::Result<Database>;

const OPENERS: &[(&str, Opener)] = &[
    ("open_existing_untrusted", |p| {
        Database::open_existing_untrusted(p, 64 * 1024 * 1024, Duration::from_secs(30))
    }),
    ("open_existing", Database::open_existing),
    ("open", Database::open),
    ("open_existing_to_read", Database::open_existing_to_read),
    ("open_readonly", Database::open_readonly),
    ("open_for_metadata", Database::open_for_metadata),
    (
        "open_for_metadata_recovering",
        Database::open_for_metadata_recovering,
    ),
    ("open_for_recovery", Database::open_for_recovery),
    ("into_read_only", |p| {
        Database::open_existing(p)?.into_read_only(p)
    }),
];

/// A project saved by this build, at `dir`/CaveU.stalx, after `surgery`.
fn project_file(dir: &Path, surgery: &str) -> PathBuf {
    let path = dir.join("CaveU.stalx");
    Database::open(&path)
        .unwrap()
        .save_project(&Project::new("CaveU".to_string(), None))
        .unwrap();
    if !surgery.is_empty() {
        Connection::open(&path)
            .unwrap()
            .execute_batch(surgery)
            .unwrap();
    }
    path
}

/// Prepare `sql` and step it to the end.
fn run(conn: &Connection, sql: &str) -> rusqlite::Result<()> {
    let mut stmt = conn.prepare(sql)?;
    let mut rows = stmt.query([])?;
    while rows.next()?.is_some() {}
    Ok(())
}

/// The SQLite result code of `e`, also for the `SqlInputError` a failed
/// prepare can be, which `Error::sqlite_error_code` does not read.
fn code_of(e: &rusqlite::Error) -> Option<ErrorCode> {
    match e {
        rusqlite::Error::SqliteFailure(error, _) | rusqlite::Error::SqlInputError { error, .. } => {
            Some(error.code)
        }
        _ => None,
    }
}

/// Whether a plain connection, with no authorizer, has `needs`.
fn plain_has(needs: Needs) -> bool {
    let (sql, name) = match needs {
        Needs::Nothing => return true,
        Needs::Module(name) => (
            "SELECT count(*) FROM pragma_module_list WHERE name = ?1",
            name,
        ),
        Needs::Function(name) => (
            "SELECT count(*) FROM pragma_function_list WHERE name = ?1",
            name,
        ),
    };
    let plain = Connection::open_in_memory().unwrap();
    plain
        .query_row(sql, [name], |r| r.get::<_, i64>(0))
        .unwrap()
        > 0
}

#[test]
fn every_untrusted_open_refuses_what_the_build_flags_strip() {
    let plain = Connection::open_in_memory().unwrap();
    let options: (i64, i64, i64, i64, i64) = plain
        .query_row(
            "SELECT sqlite_compileoption_used('ENABLE_FTS5'), \
             sqlite_compileoption_used('ENABLE_FTS3'), \
             sqlite_compileoption_used('ENABLE_RTREE'), \
             sqlite_compileoption_used('ENABLE_DBSTAT_VTAB'), \
             sqlite_compileoption_used('OMIT_LOAD_EXTENSION')",
            [],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
        )
        .unwrap();
    println!(
        "plain connection: ENABLE_FTS5={} ENABLE_FTS3={} ENABLE_RTREE={} \
         ENABLE_DBSTAT_VTAB={} OMIT_LOAD_EXTENSION={}",
        options.0, options.1, options.2, options.3, options.4
    );
    if std::env::var_os("STALAGMIGHT_EXPECT_UNSTRIPPED_SQLITE").is_some() {
        assert_eq!(
            options,
            (1, 1, 1, 1, 0),
            "STALAGMIGHT_EXPECT_UNSTRIPPED_SQLITE is set, but this SQLite was built \
             with the repo's flags: the test would prove nothing about a crates.io build"
        );
        for needs in [
            Needs::Module("fts5"),
            Needs::Module("dbstat"),
            Needs::Module("fts3tokenize"),
            Needs::Function("load_extension"),
            Needs::Function("rtreecheck"),
        ] {
            assert!(
                plain_has(needs),
                "a plain connection lacks a probed feature"
            );
        }
    }

    let mut failures = Vec::new();
    for (opener, open) in OPENERS {
        // An older file too, so open_existing_to_read takes its upgraded copy
        // in memory, a connection of its own.
        for surgery in [
            "",
            "UPDATE project SET schema_version = 16; PRAGMA user_version = 16;",
        ] {
            let dir = TempDir::new().unwrap();
            let path = project_file(dir.path(), surgery);
            let db = open(&path).unwrap();
            for sql in ALLOWED {
                if let Err(e) = run(&db.conn, sql) {
                    failures.push(format!("{opener}: `{sql}` must run, failed: {e}"));
                }
            }
            for (sql, needs) in PROBES {
                let present = plain_has(*needs);
                // Refused means the prepare fails, so nothing of it runs. The
                // authorizer's code is SQLITE_AUTH, except for a function call:
                // SQLite reports that refusal as SQLITE_ERROR (resolve.c sets it
                // over SQLITE_AUTH when it writes the message). SQLITE_ERROR is
                // also what a table or function this SQLite lacks gets.
                let outcome = match db.conn.prepare(sql) {
                    Ok(_) => Ok(run(&db.conn, sql)),
                    Err(e) => Err(e),
                };
                let refused = outcome
                    .as_ref()
                    .err()
                    .and_then(code_of)
                    .is_some_and(|code| {
                        code == ErrorCode::AuthorizationForStatementDenied
                            || (code == ErrorCode::Unknown
                                && (!present || matches!(needs, Needs::Function(_))))
                    });
                let what = if refused { "refused" } else { "NOT REFUSED" };
                let has = match needs {
                    Needs::Nothing => "",
                    _ if present => " (linked SQLite has it)",
                    _ => " (linked SQLite lacks it)",
                };
                println!(
                    "{opener}{}: `{sql}` -> {what}: {outcome:?}{has}",
                    if surgery.is_empty() {
                        ""
                    } else {
                        " (older file)"
                    }
                );
                if !refused {
                    failures.push(format!("{opener}: `{sql}` -> {outcome:?}"));
                }
            }
        }
    }
    assert!(
        failures.is_empty(),
        "not refused when prepared:\n{}",
        failures.join("\n")
    );
}
