use std::collections::VecDeque;

use super::{DepthLimit, UndoData, UndoEntry, UndoStack};

impl UndoStack {
    /// [#303] Estimated serialized size of one entry, in bytes.
    ///
    /// An ESTIMATE by design: it exists to bound growth, and measuring exactly would
    /// mean serializing the whole stack on every push - the cost the byte budget is
    /// there to avoid. The dominant terms are exact (the snapshot variants hold their
    /// JSON as `String` already, so their length is the real payload); the structured
    /// variants are approximated from their element counts, and everything else is
    /// small enough that the flat overhead covers it.
    pub fn estimated_size(entry: &UndoEntry) -> usize {
        /// Roughly the JSON size of one serialized shot, from the measured
        /// project-shaped payload (~420 bytes/shot).
        const BYTES_PER_SHOT: usize = 420;
        /// Command JSON plus enum/field scaffolding for any entry.
        const ENTRY_OVERHEAD: usize = 512;

        let payload = match &entry.undo_data {
            // Exact: these hold the serialized project already.
            UndoData::ProjectSnapshot(json) => json.len(),
            UndoData::ProjectSnapshotPair { before, after } => before.len() + after.len(),
            UndoData::PreviousValues { values_json, .. } => values_json.len(),
            // Approximated from element counts - a section snapshot of a big section is
            // the only other variant that can reach megabytes.
            UndoData::SectionSnapshot { section_data, .. }
            | UndoData::CreatedSectionSnapshot { section_data, .. } => {
                section_data.shots.len() * BYTES_PER_SHOT
            }
            UndoData::ShotSnapshot { .. } | UndoData::CreatedShotSnapshot { .. } => BYTES_PER_SHOT,
            UndoData::MergeInfo {
                removed_closures,
                previous_offsets,
                ..
            } => removed_closures.len() * 256 + previous_offsets.len() * 64,
            UndoData::UnmergeInfo {
                removed_closures, ..
            } => removed_closures.len() * 256,
            UndoData::ClosureInfo { .. } => 256,
            UndoData::ZeroDatumInfo {
                previous_offsets, ..
            } => previous_offsets.len() * 64,
            UndoData::SegmentMoveInfo {
                affected_sections,
                previous_offsets,
                ..
            } => affected_sections.len() * 16 + previous_offsets.len() * 64,
            UndoData::StationMoveInfo { .. } => 2 * BYTES_PER_SHOT,
            UndoData::InverseCommand(_) | UndoData::None => 0,
        };
        // Restored rows deliberately do not reserialize their command just to rebuild
        // this cache. They retain the historical 512-byte estimate; snapshot and other
        // undo payloads remain the dominant, separately-counted part of the budget.
        payload + entry.command_bytes.unwrap_or(ENTRY_OVERHEAD)
    }

    /// [#303] Total estimated size of the undo stack (the budget's subject).
    pub fn estimated_undo_bytes(&self) -> usize {
        self.undo_bytes
    }

    /// [#303] Total estimated size of the redo stack.
    pub fn estimated_redo_bytes(&self) -> usize {
        self.redo_bytes
    }

    /// Apply whichever bound is active to BOTH stacks, evicting oldest-first.
    ///
    /// Under `Bytes`, the newest entry is always kept even if it alone exceeds the
    /// budget: dropping it would silently discard the operation the user just did, and
    /// a single entry over the budget is a very large import, not runaway growth.
    pub(super) fn enforce_depth_limit(&mut self) {
        match self.depth_limit {
            DepthLimit::Count(limit) => {
                Self::trim_to_count(&mut self.undo_stack, &mut self.undo_bytes, limit);
                Self::trim_to_count(&mut self.redo_stack, &mut self.redo_bytes, limit);
            }
            DepthLimit::Bytes(budget) => {
                let undo_dropped =
                    Self::trim_to_bytes(&mut self.undo_stack, &mut self.undo_bytes, budget);
                Self::trim_to_bytes(&mut self.redo_stack, &mut self.redo_bytes, budget);
                if undo_dropped > 0 {
                    tracing::info!(
                        dropped = undo_dropped,
                        remaining = self.undo_stack.len(),
                        estimated_bytes = self.undo_bytes,
                        budget,
                        purpose = "bound a Full-mode SpeleoDB project's undo history (#303)",
                        "Trimmed oldest undo entries to stay within the undo byte budget"
                    );
                }
            }
        }
    }

    fn trim_to_count(stack: &mut VecDeque<UndoEntry>, total: &mut usize, limit: usize) {
        while stack.len() > limit {
            if let Some(front) = stack.pop_front() {
                *total = total.saturating_sub(Self::estimated_size(&front));
            }
        }
    }

    /// Evict from the front until the running total is at most `budget`, always
    /// keeping the newest entry. Returns the number evicted.
    fn trim_to_bytes(stack: &mut VecDeque<UndoEntry>, total: &mut usize, budget: usize) -> u64 {
        let mut dropped = 0;
        while *total > budget && stack.len() > 1 {
            if let Some(front) = stack.pop_front() {
                *total = total.saturating_sub(Self::estimated_size(&front));
                dropped += 1;
            }
        }
        dropped
    }
}
