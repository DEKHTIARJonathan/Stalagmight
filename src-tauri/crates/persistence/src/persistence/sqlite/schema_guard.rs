//! Refusing `.stalx` files whose schema could run SQL the file chose (#608).
//!
//! A `.stalx` is a SQLite database anyone can send, so its schema is input.
//! The app never creates views, triggers or virtual tables, so a file that has
//! one was edited by something else, and opening it would let the file run its
//! own SQL or a virtual-table module's code. [`check_schema`] refuses such a
//! file before anything else reads it; the `stalx-reader` crate runs the same
//! check on server uploads.

use rusqlite::config::DbConfig;
use rusqlite::Connection;

/// A schema object the app never creates, found in a file it was asked to open.
/// Rides inside the open error, so callers can `downcast_ref` it to tell this
/// refusal apart from corruption or an I/O failure.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RefusedSchemaObject {
    /// What it is, in words for a person ("a view", "a virtual table").
    pub what: &'static str,
    /// Its name as stored in the file: untrusted text, see [`Self::display_name`].
    pub name: String,
}

impl RefusedSchemaObject {
    /// The object's name made safe to show: control and bidirectional-override
    /// characters dropped (they could forge a misleading message), at most 60
    /// characters.
    pub fn display_name(&self) -> String {
        let mut shown: String = self
            .name
            .chars()
            .filter(|c| !c.is_control() && !is_bidi_control(*c))
            .take(60)
            .collect();
        if self.name.chars().count() > 60 {
            shown.push_str("...");
        }
        shown
    }
}

fn is_bidi_control(c: char) -> bool {
    matches!(c, '\u{200E}' | '\u{200F}' | '\u{061C}' | '\u{202A}'..='\u{202E}' | '\u{2066}'..='\u{2069}')
}

impl std::fmt::Display for RefusedSchemaObject {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "the file defines {} named '{}'",
            self.what,
            self.display_name()
        )
    }
}

impl std::error::Error for RefusedSchemaObject {}

/// Harden `conn` for a file from outside the app, then refuse it if its schema
/// holds anything the app never creates.
///
/// Hardening first: defensive mode, and `trusted_schema` off so schema code may
/// call only innocuous functions. Then one pass over `sqlite_master`, which a
/// file cannot shadow (`sqlite_` names are reserved) and whose reading runs no
/// module code. It refuses, in order:
/// - any object named `pragma_*` (any case): the file's own table or view of
///   that name would be read in place of SQLite's table-valued pragma by every
///   later probe, and could lie to all of them;
/// - any type other than exactly `table` or `index`: SQLite reads `type` case-
///   insensitively when it loads the schema, so a row typed 'View' or 'TABLE'
///   is still a view or a table to it while slipping past a `type = 'view'`
///   filter. Views and triggers land here too;
/// - virtual tables: rootpage 0, or SQL opening with the `CREATE VIRTUAL`
///   keywords (see [`declares_virtual_table`]).
pub fn check_schema(conn: &Connection) -> anyhow::Result<()> {
    conn.set_db_config(DbConfig::SQLITE_DBCONFIG_DEFENSIVE, true)?;
    conn.set_db_config(DbConfig::SQLITE_DBCONFIG_TRUSTED_SCHEMA, false)?;
    match refused_schema_object(conn)? {
        Some(refused) => Err(anyhow::Error::new(refused)),
        None => Ok(()),
    }
}

/// The first object [`check_schema`] would refuse, if any. Reads only
/// `sqlite_master`.
pub fn refused_schema_object(conn: &Connection) -> rusqlite::Result<Option<RefusedSchemaObject>> {
    let mut stmt = conn.prepare("SELECT type, name, rootpage, sql FROM sqlite_master")?;
    let mut rows = stmt.query([])?;
    while let Some(row) = rows.next()? {
        let kind: String = row.get(0)?;
        let name: String = row.get(1)?;
        let rootpage: Option<i64> = row.get(2)?;
        let sql: Option<String> = row.get(3)?;
        let what = if name.to_ascii_lowercase().starts_with("pragma_") {
            Some("an object named like a SQLite pragma")
        } else if kind != "table" && kind != "index" {
            Some(match kind.to_ascii_lowercase().as_str() {
                "view" => "a view",
                "trigger" => "a trigger",
                _ => "a schema object of an unexpected type",
            })
        } else if rootpage == Some(0)
            || (kind == "table" && declares_virtual_table(sql.as_deref().unwrap_or("")))
        {
            Some("a virtual table")
        } else {
            None
        };
        if let Some(what) = what {
            return Ok(Some(RefusedSchemaObject { what, name }));
        }
    }
    Ok(None)
}

/// Whether a `sqlite_master.sql` text declares a virtual table: its first two
/// keywords, after any whitespace and comments, are `CREATE VIRTUAL`. A token
/// match, not a substring one, so a legacy column such as `is_virtual` does not
/// count. An unterminated comment counts as virtual, so a malformed text is
/// treated as the dangerous case.
pub fn declares_virtual_table(sql: &str) -> bool {
    let mut rest = sql;
    let mut words = Vec::with_capacity(2);
    while words.len() < 2 {
        rest = rest.trim_start();
        if let Some(after) = rest.strip_prefix("/*") {
            match after.find("*/") {
                Some(end) => rest = &after[end + 2..],
                None => return true,
            }
        } else if let Some(after) = rest.strip_prefix("--") {
            rest = after.find('\n').map_or("", |end| &after[end..]);
        } else {
            let end = rest
                .find(|c: char| !(c.is_ascii_alphanumeric() || c == '_'))
                .unwrap_or(rest.len());
            if end == 0 {
                break;
            }
            words.push(rest[..end].to_ascii_uppercase());
            rest = &rest[end..];
        }
    }
    words == ["CREATE", "VIRTUAL"]
}
