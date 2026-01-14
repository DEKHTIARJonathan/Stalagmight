use serde::{Deserialize, Serialize};

use super::Command;
use crate::models::{
    ClosureStrategy, GpsCoordinates, SectionData, SectionId, ShotData, ShotId, StationRef,
};

/// Default maximum number of undo entries to keep in memory
const DEFAULT_UNDO_HISTORY_LIMIT: usize = 100;

/// Undo/redo stack
#[derive(Debug)]
pub struct UndoStack {
    /// Commands that can be undone
    undo_stack: Vec<UndoEntry>,
    /// Commands that can be redone
    redo_stack: Vec<UndoEntry>,
    /// Maximum entries to keep in memory
    history_limit: usize,
}

/// Entry in the undo stack
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UndoEntry {
    /// The command that was executed
    pub command: Command,
    /// Data needed to undo this command
    pub undo_data: UndoData,
}

/// Data needed to undo a command
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum UndoData {
    /// Simple inverse command (e.g., CreateShot -> DeleteShot, MergeStations -> UnmergeStations)
    InverseCommand(Command),

    /// Previous values for an update operation (JSON serialized)
    PreviousValues {
        section_id: SectionId,
        shot_id: Option<ShotId>,
        /// JSON serialized previous values (ShotUpdates or SectionUpdates)
        values_json: String,
    },

    /// Full section snapshot for restoring deleted sections
    SectionSnapshot {
        section_id: SectionId,
        /// Full section data including all shots
        section_data: SectionData,
    },

    /// Shot snapshot for restoring deleted shots
    ShotSnapshot {
        section_id: SectionId,
        shot_id: ShotId,
        shot_data: ShotData,
        /// Position in the section's shot list (for re-insertion)
        position: usize,
    },

    /// Merge info for unmerging stations
    MergeInfo {
        station_a: StationRef,
        station_b: StationRef,
        strategy: ClosureStrategy,
    },

    /// Zero datum info for restoring previous GPS or removing datum
    ZeroDatumInfo {
        station_ref: StationRef,
        /// Previous GPS coordinates, None if there was no previous datum
        previous_gps: Option<GpsCoordinates>,
    },

    /// Full project snapshot for batch operations (JSON serialized)
    ProjectSnapshot(String),

    /// No undo data (for commands that can't be undone)
    None,
}

impl Default for UndoStack {
    fn default() -> Self {
        Self {
            undo_stack: Vec::new(),
            redo_stack: Vec::new(),
            history_limit: DEFAULT_UNDO_HISTORY_LIMIT,
        }
    }
}

impl UndoStack {
    /// Create a new empty undo stack with default limit
    pub fn new() -> Self {
        Self::default()
    }

    /// Create a new empty undo stack with custom limit
    pub fn new_with_limit(history_limit: usize) -> Self {
        Self {
            undo_stack: Vec::new(),
            redo_stack: Vec::new(),
            history_limit,
        }
    }

    /// Get the current history limit
    pub fn history_limit(&self) -> usize {
        self.history_limit
    }

    /// Set the history limit
    pub fn set_history_limit(&mut self, limit: usize) {
        self.history_limit = limit;
        // Trim stack if needed
        while self.undo_stack.len() > self.history_limit {
            self.undo_stack.remove(0);
        }
    }

    /// Push a command with its undo data to the undo stack
    pub fn push_with_data(&mut self, command: Command, undo_data: UndoData) {
        let entry = UndoEntry { command, undo_data };

        self.undo_stack.push(entry);

        // Clear redo stack when new command is executed
        self.redo_stack.clear();

        // Limit stack size
        while self.undo_stack.len() > self.history_limit {
            self.undo_stack.remove(0);
        }
    }

    /// Push a command without undo data (legacy, for backwards compatibility)
    pub fn push(&mut self, command: Command) {
        self.push_with_data(command, UndoData::None);
    }

    /// Pop from undo stack and return the entry
    pub fn pop_undo(&mut self) -> Option<UndoEntry> {
        self.undo_stack.pop()
    }

    /// Push to redo stack
    pub fn push_redo(&mut self, entry: UndoEntry) {
        self.redo_stack.push(entry);
    }

    /// Pop from redo stack
    pub fn pop_redo(&mut self) -> Option<UndoEntry> {
        self.redo_stack.pop()
    }

    /// Push back to undo stack (for redo operations)
    pub fn push_undo(&mut self, entry: UndoEntry) {
        self.undo_stack.push(entry);
        // Don't clear redo stack when pushing for redo
    }

    /// Check if undo is available
    pub fn can_undo(&self) -> bool {
        !self.undo_stack.is_empty()
    }

    /// Check if redo is available
    pub fn can_redo(&self) -> bool {
        !self.redo_stack.is_empty()
    }

    /// Clear both stacks
    pub fn clear(&mut self) {
        self.undo_stack.clear();
        self.redo_stack.clear();
    }

    /// Get the last command that can be undone
    pub fn peek_undo(&self) -> Option<&Command> {
        self.undo_stack.last().map(|e| &e.command)
    }

    /// Get the last command that can be redone
    pub fn peek_redo(&self) -> Option<&Command> {
        self.redo_stack.last().map(|e| &e.command)
    }

    /// Get the undo data for the last undoable command
    pub fn peek_undo_data(&self) -> Option<&UndoData> {
        self.undo_stack.last().map(|e| &e.undo_data)
    }
}
