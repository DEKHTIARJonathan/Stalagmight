//! The two per-station free-text tables, `station_comments` and
//! `station_names`.
//!
//! Both have the same positional shape - `(section_id, station_index, <text>)`
//! with that pair as the primary key - and the same lifecycle: written from a
//! `StationKey` map by resolving each key against the current shots (orphans
//! skipped), read back as transitional positional keys that the load re-anchor
//! pass canonicalizes. One enum keeps the SQL for both in one place.
//!
//! `station_names` was added WITHOUT a schema version bump, on purpose: readers
//! outside the app (OpenSpeleo's `stalagmight_lib`, which SpeleoDB uses to draw
//! maps) refuse any file whose version is not exactly the one they know, and
//! read only the tables they know by explicit column lists. A new table is
//! invisible to them; a bump would lock them out. The price is that a build
//! without this table drops the names on its next save - every save rebuilds
//! the file from `init_schema`.

/// One of the per-station text tables.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum StationTextTable {
    Comments,
    Names,
}

impl StationTextTable {
    pub(super) fn name(self) -> &'static str {
        match self {
            Self::Comments => "station_comments",
            Self::Names => "station_names",
        }
    }

    pub(super) fn select_sql(self) -> &'static str {
        match self {
            Self::Comments => "SELECT section_id, station_index, comment FROM station_comments",
            Self::Names => "SELECT section_id, station_index, name FROM station_names",
        }
    }

    pub(super) fn insert_sql(self) -> &'static str {
        match self {
            Self::Comments => {
                "INSERT INTO station_comments (section_id, station_index, comment) VALUES (?1, ?2, ?3)"
            }
            Self::Names => {
                "INSERT INTO station_names (section_id, station_index, name) VALUES (?1, ?2, ?3)"
            }
        }
    }
}

/// DDL for `station_names`, shared by `init_schema` (fresh files, and the temp
/// file every save writes) and `migrate_schema` (an opened file of an older
/// shape) so the two cannot drift. Same shape as `station_comments`.
pub(super) const CREATE_STATION_NAMES: &str = "CREATE TABLE IF NOT EXISTS station_names (
                section_id INTEGER NOT NULL,
                station_index INTEGER NOT NULL,
                name TEXT NOT NULL,
                PRIMARY KEY (section_id, station_index),
                FOREIGN KEY (section_id) REFERENCES sections(id) ON DELETE CASCADE
            )";
