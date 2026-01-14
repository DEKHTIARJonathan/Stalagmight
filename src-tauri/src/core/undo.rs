use serde::{Deserialize, Serialize};

use super::Command;

/// Maximum number of undo entries to keep
const MAX_UNDO_ENTRIES: usize = 100;

/// Undo/redo stack
#[derive(Debug, Default)]
pub struct UndoStack {
    /// Commands that can be undone
    undo_stack: Vec<UndoEntry>,
    /// Commands that can be redone
    redo_stack: Vec<UndoEntry>,
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
    /// Simple inverse command
    InverseCommand(Command),
    /// State snapshot for complex operations
    StateSnapshot(String), // JSON serialized project state
    /// No undo data (for commands that can't be undone)
    None,
}

impl UndoStack {
    /// Create a new empty undo stack
    pub fn new() -> Self {
        Self::default()
    }

    /// Push a command to the undo stack
    pub fn push(&mut self, command: Command) {
        // For now, we just store the command without proper undo data
        // TODO: Generate proper undo data based on command type
        let entry = UndoEntry {
            command,
            undo_data: UndoData::None,
        };

        self.undo_stack.push(entry);

        // Clear redo stack when new command is executed
        self.redo_stack.clear();

        // Limit stack size
        while self.undo_stack.len() > MAX_UNDO_ENTRIES {
            self.undo_stack.remove(0);
        }
    }

    /// Pop from undo stack and push to redo
    pub fn undo(&mut self) -> bool {
        if let Some(entry) = self.undo_stack.pop() {
            self.redo_stack.push(entry);
            true
        } else {
            false
        }
    }

    /// Pop from redo stack and push to undo
    pub fn redo(&mut self) -> bool {
        if let Some(entry) = self.redo_stack.pop() {
            self.undo_stack.push(entry);
            true
        } else {
            false
        }
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
}
