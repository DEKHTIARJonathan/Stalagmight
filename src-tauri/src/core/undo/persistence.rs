use chrono::{DateTime, Utc};

use super::{Command, PersistStack, UndoData, UndoEntry, UndoStack};

impl UndoStack {
    /// [#303] Every row a save must write for one stack, in stack order and in the
    /// tuple shape `Database::save_undo_stack_with_timestamps` takes.
    ///
    /// EVERY save writes the whole (windowed) stack. That is forced by the save
    /// pipeline: `save_project` builds a fresh `.stalx.tmp`, renames it over the
    /// target, and only then writes the undo tables into the reopened file.
    ///
    /// `count_limit` is the persisted window: `Some(n)` keeps the last n entries,
    /// while `None` keeps all byte-budgeted Full-mode entries.
    #[must_use]
    pub fn rows_to_persist(
        &self,
        stack: PersistStack,
        count_limit: Option<usize>,
    ) -> Vec<(String, String, Option<String>)> {
        let entries = match stack {
            PersistStack::Undo => &self.undo_stack,
            PersistStack::Redo => &self.redo_stack,
        };

        let skip = match count_limit {
            Some(limit) if entries.len() > limit => entries.len() - limit,
            _ => 0,
        };

        entries
            .iter()
            .skip(skip)
            .filter_map(Self::serialize_entry_with_timestamp)
            .collect()
    }

    /// Serialize an entry to JSON.
    pub fn serialize_entry(entry: &UndoEntry) -> Option<(String, String)> {
        let command_json = serde_json::to_string(&entry.command).ok()?;
        let undo_data_json = serde_json::to_string(&entry.undo_data).ok()?;
        Some((command_json, undo_data_json))
    }

    /// Serialize an entry with its timestamp for database persistence.
    pub fn serialize_entry_with_timestamp(
        entry: &UndoEntry,
    ) -> Option<(String, String, Option<String>)> {
        let command_json = serde_json::to_string(&entry.command).ok()?;
        let undo_data_json = serde_json::to_string(&entry.undo_data).ok()?;
        let timestamp_str = entry.timestamp.map(|t| t.to_rfc3339());
        Some((command_json, undo_data_json, timestamp_str))
    }

    /// Deserialize a legacy entry without a timestamp.
    pub fn deserialize_entry(command_json: &str, undo_data_json: &str) -> Option<UndoEntry> {
        let command = Self::deserialize_command(command_json)?;
        let undo_data: UndoData = serde_json::from_str(undo_data_json).ok()?;
        Some(UndoEntry {
            command_bytes: None,
            command,
            undo_data,
            timestamp: None,
        })
    }

    /// Deserialize an entry with an optional timestamp.
    pub fn deserialize_entry_with_timestamp(
        command_json: &str,
        undo_data_json: &str,
        timestamp_str: Option<&str>,
    ) -> Option<UndoEntry> {
        let command = Self::deserialize_command(command_json)?;
        let undo_data: UndoData = serde_json::from_str(undo_data_json).ok()?;
        let timestamp = match timestamp_str {
            Some(raw) => Some(DateTime::parse_from_rfc3339(raw).ok()?.with_timezone(&Utc)),
            None => None,
        };
        Some(UndoEntry {
            command_bytes: None,
            command,
            undo_data,
            timestamp,
        })
    }

    fn deserialize_command(command_json: &str) -> Option<Command> {
        match serde_json::from_str(command_json) {
            Ok(command) => Some(command),
            Err(e) => {
                tracing::warn!(
                    error = %e,
                    purpose = "load persisted undo history",
                    "Skipping an undo entry whose command could not be deserialized; its undo step is dropped"
                );
                None
            }
        }
    }

    /// True when `undo()` can actually apply this entry.
    fn is_applicable(entry: &UndoEntry) -> bool {
        !matches!(entry.undo_data, UndoData::None)
    }

    fn warn_dropped_unapplicable(dropped: &[String]) {
        if dropped.is_empty() {
            return;
        }
        tracing::warn!(
            count = dropped.len(),
            commands = %dropped.join("; "),
            purpose = "load persisted undo history",
            "Dropped persisted undo entries that carry no undo data; they could not be undone and would have blocked every older entry"
        );
    }

    /// Validate the raw undo timestamp column before any rows are filtered.
    /// Legacy `NULL`s may only be a prefix, followed by parseable non-decreasing stamps.
    fn undo_timestamps_are_valid(entries: &[(String, String, Option<String>)]) -> bool {
        let mut previous: Option<DateTime<Utc>> = None;
        let mut saw_timestamp = false;
        for (_, _, raw) in entries {
            let Some(raw) = raw else {
                if saw_timestamp {
                    return false;
                }
                continue;
            };
            let Ok(stamp) = DateTime::parse_from_rfc3339(raw) else {
                return false;
            };
            let stamp = stamp.with_timezone(&Utc);
            if previous.is_some_and(|prev| stamp < prev) {
                return false;
            }
            previous = Some(stamp);
            saw_timestamp = true;
        }
        true
    }

    fn timestamps_are_parseable(entries: &[(String, String, Option<String>)]) -> bool {
        entries.iter().all(|(_, _, raw)| {
            raw.as_deref()
                .is_none_or(|stamp| DateTime::parse_from_rfc3339(stamp).is_ok())
        })
    }

    /// Load legacy persisted undo data.
    pub fn load_from_persisted(&mut self, entries: Vec<(String, String)>) {
        self.clear();

        let mut dropped: Vec<String> = Vec::new();
        for (command_json, undo_data_json) in entries {
            if let Some(entry) = Self::deserialize_entry(&command_json, &undo_data_json) {
                if Self::is_applicable(&entry) {
                    self.push_undo_tracked(entry);
                } else {
                    dropped.push(entry.command.description());
                }
            }
        }
        Self::warn_dropped_unapplicable(&dropped);
        self.enforce_depth_limit();
    }

    /// Load persisted undo and redo data with timestamps.
    pub fn load_from_persisted_with_timestamps(
        &mut self,
        undo_entries: Vec<(String, String, Option<String>)>,
        redo_entries: Vec<(String, String, Option<String>)>,
    ) {
        self.clear();

        if !Self::undo_timestamps_are_valid(&undo_entries) {
            tracing::warn!(
                entries = undo_entries.len(),
                purpose = "refuse invalid persisted undo timestamps (#303)",
                "loaded undo history has malformed, non-monotonic, or misplaced missing \
                 timestamps; dropping it rather than risk an incorrect push cutoff"
            );
        } else {
            let mut dropped: Vec<String> = Vec::new();
            for (command_json, undo_data_json, timestamp_str) in undo_entries {
                if let Some(entry) = Self::deserialize_entry_with_timestamp(
                    &command_json,
                    &undo_data_json,
                    timestamp_str.as_deref(),
                ) {
                    if Self::is_applicable(&entry) {
                        self.push_undo_tracked(entry);
                    } else {
                        dropped.push(entry.command.description());
                    }
                }
            }
            Self::warn_dropped_unapplicable(&dropped);

            // Stack order is undo order, so a non-monotonic timestamp sequence cannot be
            // sorted safely. Drop it rather than letting the push cutoff delete an arbitrary
            // prefix.
            if !Self::stamps_ascend(&self.undo_stack) {
                tracing::warn!(
                    entries = self.undo_stack.len(),
                    purpose = "refuse a non-monotonic undo stack (#303)",
                    "loaded undo history is not in time order; dropping it rather than risk \
                 deleting the wrong entries on the next push"
                );
                self.clear_undo();
            }
        }

        // A redo entry with `UndoData::None` still re-executes correctly, so the redo
        // side is intentionally not filtered by `is_applicable`.
        if !Self::timestamps_are_parseable(&redo_entries) {
            tracing::warn!(
                entries = redo_entries.len(),
                purpose = "refuse invalid persisted redo timestamps (#303)",
                "loaded redo history has a malformed timestamp; dropping it"
            );
        } else {
            for (command_json, undo_data_json, timestamp_str) in redo_entries {
                if let Some(entry) = Self::deserialize_entry_with_timestamp(
                    &command_json,
                    &undo_data_json,
                    timestamp_str.as_deref(),
                ) {
                    self.push_redo_tracked(entry);
                }
            }
        }

        self.enforce_depth_limit();
    }
}
