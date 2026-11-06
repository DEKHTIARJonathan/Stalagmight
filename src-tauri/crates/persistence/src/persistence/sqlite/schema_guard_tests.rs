//! [#608] A `.stalx` can come from anywhere, so its own schema must never get
//! to run SQL: the raw-table viewer neither lists nor reads a virtual table,
//! and every open of an existing file refuses a hostile schema before anything
//! reads it (`schema_guard`). The build-flag check that the bundled SQLite has
//! no FTS/RTREE/DBSTAT modules or extension loading stays in `tests` (CI runs it
//! there by its exact path).
//!
//! All files are synthetic projects this build writes, then reshaped with raw
//! SQL. No fixture is read.

use super::*;
use tempfile::TempDir;

// === The raw-table viewer leaves virtual tables out (#608 p1) ===

#[test]
fn test_raw_tables_leave_out_virtual_tables_even_when_pragmas_are_shadowed() {
    // A crafted file's virtual tables would run their module's code over the
    // file's own data; the viewer must neither list nor read them. The file
    // also ships its own `pragma_table_list`, which a table-valued pragma
    // query would read instead of SQLite's and so list `docs` as ordinary.
    // The schema rows are written directly: release builds compile SQLite
    // without FTS5 or RTREE, so `CREATE VIRTUAL TABLE` would fail there.
    let mut db = Database::in_memory().unwrap();
    db.save_project(&Project::new("Hostile Cave".to_string(), None))
        .unwrap();
    db.conn
        .execute_batch(
            "PRAGMA writable_schema = ON;
             INSERT INTO sqlite_master (type, name, tbl_name, rootpage, sql) VALUES
               ('table', 'docs', 'docs', 0, 'CREATE VIRTUAL TABLE docs USING fts5(body)'),
               ('table', 'boxes', 'boxes', 0, 'CREATE VIRTUAL TABLE/**/boxes USING rtree(id, x0, x1)');
             PRAGMA writable_schema = RESET;
             CREATE TABLE pragma_table_list (name, schema, type);
             INSERT INTO pragma_table_list VALUES ('docs', 'main', 'table'),
                                                  ('boxes', 'main', 'table');",
        )
        .unwrap();

    let names = db.list_raw_table_names().unwrap();

    for hidden in ["docs", "boxes"] {
        assert!(
            !names.iter().any(|n| n == hidden),
            "{hidden} listed: {names:?}"
        );
        let err = db.read_raw_table(hidden, 100, 0).unwrap_err();
        assert!(err.to_string().contains("Unknown table"), "{hidden}: {err}");
    }
    assert!(names.iter().any(|n| n == "shots"));
}

#[test]
fn test_raw_tables_keep_a_legacy_table_with_an_is_virtual_column() {
    // Pre-v4 shots tables had an `is_virtual` column; it is still an ordinary table.
    let db = Database::in_memory().unwrap();
    db.conn
        .execute_batch("CREATE TABLE legacy_shots (id INTEGER, is_virtual INTEGER);")
        .unwrap();

    let names = db.list_raw_table_names().unwrap();

    assert!(names.iter().any(|n| n == "legacy_shots"), "{names:?}");
}

#[test]
fn test_declares_virtual_table_matches_keywords_not_substrings() {
    use super::declares_virtual_table as virt;
    assert!(virt("CREATE VIRTUAL TABLE t USING fts5(x)"));
    assert!(virt("create virtual table t using rtree(a, b, c)"));
    assert!(virt("CREATE/**/VIRTUAL  TABLE t USING fts5(x)"));
    assert!(virt("CREATE -- note\n VIRTUAL TABLE t USING fts5(x)"));
    assert!(virt("CREATE /* unterminated"));
    // A legacy (pre-v4) shots table has an `is_virtual` column.
    assert!(!virt("CREATE TABLE shots (id INTEGER, is_virtual INTEGER)"));
    assert!(!virt("CREATE TABLE \"virtual\" (x)"));
    assert!(!virt(""));
}

// === Hostile schema refused at open (#608 p2) ===

/// A saved project with `sql` run on it through a raw connection afterwards.
fn project_file_with(dir: &TempDir, sql: &str) -> std::path::PathBuf {
    let path = dir.path().join("crafted.stalx");
    Database::open(&path)
        .unwrap()
        .save_project(&Project::new("Crafted".to_string(), None))
        .unwrap();
    Connection::open(&path).unwrap().execute_batch(sql).unwrap();
    path
}

#[test]
fn every_open_of_an_existing_file_refuses_a_hostile_schema() {
    for (sql, what) in [
        ("CREATE VIEW v AS SELECT 1;", "a view"),
        (
            "CREATE TRIGGER t AFTER UPDATE ON project BEGIN SELECT 1; END;",
            "a trigger",
        ),
        (
            "PRAGMA writable_schema = ON;
             INSERT INTO sqlite_master (type, name, tbl_name, rootpage, sql)
             VALUES ('table', 'docs', 'docs', 0, 'CREATE VIRTUAL TABLE docs USING fts5(body)');",
            "a virtual table",
        ),
        (
            "CREATE TABLE pragma_table_info (cid, name, type);",
            "an object named like a SQLite pragma",
        ),
        (
            "CREATE VIEW w AS SELECT 1;
             PRAGMA writable_schema = ON;
             UPDATE sqlite_master SET type = 'View' WHERE name = 'w';",
            "a view",
        ),
        (
            "CREATE TABLE c (x CHECK (length(zeroblob(10)) > 0));",
            "a table with a CHECK constraint the app never writes",
        ),
        (
            "CREATE TABLE g (a, b AS (zeroblob(10)));",
            "a table with a generated column",
        ),
        (
            "CREATE TABLE d (x TEXT DEFAULT (hex(zeroblob(10))));",
            "a table with an expression default",
        ),
        (
            "CREATE INDEX e ON shots (length(hex(zeroblob(10))) + length);",
            "an expression or partial index",
        ),
        (
            "CREATE INDEX p ON shots (length) WHERE length > 0;",
            "an expression or partial index",
        ),
        (
            "PRAGMA writable_schema = ON;
             UPDATE sqlite_master SET name = CAST('project' AS BLOB) WHERE name = 'project';",
            "a schema object of an unexpected type",
        ),
    ] {
        let dir = TempDir::new().unwrap();
        let path = project_file_with(&dir, sql);
        let openers: [(&str, fn(&Path) -> Result<Database>); 6] = [
            ("open", Database::open),
            ("open_existing", Database::open_existing),
            ("open_existing_to_read", Database::open_existing_to_read),
            ("open_readonly", Database::open_readonly),
            ("open_for_metadata", Database::open_for_metadata),
            (
                "open_for_metadata_recovering",
                Database::open_for_metadata_recovering,
            ),
        ];
        for (name, opener) in openers {
            let Err(err) = opener(&path) else {
                unreachable!("{name} opened a file with {what}: {sql}");
            };
            let refused = err
                .chain()
                .find_map(|c| c.downcast_ref::<RefusedSchemaObject>())
                .unwrap_or_else(|| unreachable!("{name}: not a schema refusal: {err:#}"));
            assert_eq!(refused.what, what, "{name}: {sql}");
        }
    }
}

#[test]
fn every_opener_still_opens_what_sqlite_itself_adds_to_a_real_file() {
    // AUTOINCREMENT adds sqlite_sequence, UNIQUE an autoindex with NULL sql, and
    // ANALYZE sqlite_stat1: all ordinary, none written by the app's schema code.
    let dir = TempDir::new().unwrap();
    let path = project_file_with(
        &dir,
        "CREATE TABLE extra (id INTEGER PRIMARY KEY AUTOINCREMENT, tag TEXT UNIQUE,
                             n REAL DEFAULT -1.5, t TEXT DEFAULT CURRENT_TIMESTAMP);
         INSERT INTO extra (tag) VALUES ('a');
         CREATE INDEX extra_tag_n ON extra (tag, n);
         ANALYZE;",
    );

    Database::open(&path).unwrap();
    Database::open_existing(&path).unwrap();
    Database::open_existing_to_read(&path).unwrap();
    Database::open_readonly(&path).unwrap();
    Database::open_for_metadata(&path).unwrap();
    Database::open_for_metadata_recovering(&path).unwrap();
    Database::check_schema_at(&path).unwrap();
}

#[test]
fn a_legacy_is_virtual_column_still_opens() {
    let dir = TempDir::new().unwrap();
    let path = project_file_with(&dir, "ALTER TABLE shots ADD COLUMN is_virtual INTEGER;");

    Database::open_existing(&path).unwrap();
}
