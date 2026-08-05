use super::AppState;
use crate::core::{CommandResult, Validator};
use crate::models::{
    shot_display_position, SectionId, ShotData, ShotId, ShotKind, ShotUpdates, FEATURE_ID_STRIDE,
};

impl AppState {
    pub(super) fn create_shot(
        &self,
        section_id: SectionId,
        mut data: ShotData,
        after_shot_id: Option<ShotId>,
        before_shot_id: Option<ShotId>,
    ) -> CommandResult {
        // Identity is not the caller's to name (#423) - see create_shot_impl
        // (commands/shot.rs) for the full rationale. Cleared HERE, at the
        // executor, and not only at the IPC wrapper, so the rule holds for any
        // caller that constructs `Command::CreateShot` itself rather than by
        // grace of the batch allowlist (which refuses CreateShot today - a
        // separate mechanism maintained for a different reason). Undo/redo
        // does not lose identity to this line - it replays through the
        // `UndoData::CreatedShotSnapshot` arms, never through this command.
        data.uuid = None;
        // Reject ambiguous input: both after and before cannot be specified
        if after_shot_id.is_some() && before_shot_id.is_some() {
            return CommandResult::failure(
                "Cannot specify both after_shot_id and before_shot_id".to_string(),
            );
        }

        // Reject non-finite geometry before it reaches the coordinate path
        // (NaN/inf slips past zero/negative-length checks and poisons offsets).
        if !data.all_finite() {
            return CommandResult::failure("Shot has a non-finite (NaN/inf) value".to_string());
        }

        let Ok(mut proj_guard) = self.project.lock() else {
            return CommandResult::failure("Failed to lock project".to_string());
        };

        let Some(project) = proj_guard.as_mut() else {
            return CommandResult::failure("No project open".to_string());
        };

        let max_shots = FEATURE_ID_STRIDE.saturating_sub(1) as usize;

        // Compute the real shot index for validation messages
        let shot_index = {
            let Some(section) = project.sections.iter().find(|s| s.id == section_id) else {
                return CommandResult::failure(format!("Section {section_id} not found"));
            };

            if section.shots.len() >= max_shots {
                return CommandResult::failure(format!(
                    "Section {section_id} has reached the maximum of {max_shots} shots"
                ));
            }

            if let Some(before_id) = before_shot_id {
                section
                    .shots
                    .iter()
                    .position(|shot| shot.id == before_id)
                    .unwrap_or(0)
            } else if let Some(after_id) = after_shot_id {
                section
                    .shots
                    .iter()
                    .position(|shot| shot.id == after_id)
                    .map_or(0, |pos| pos + 1)
            } else {
                section.shots.len()
            }
        };

        if data.length == 0.0 {
            return CommandResult::failure(format!(
                "Shot {}:{} has zero length",
                section_id,
                shot_index + 1
            ));
        }
        if data.length < 0.0 {
            return CommandResult::failure(format!(
                "Shot {}:{} has negative length: {:.1}m",
                section_id,
                shot_index + 1,
                data.length
            ));
        }

        let mut warnings = Vec::new();
        // Per-project thresholds (#57) so create-time warnings match the panel.
        warnings.extend(Validator::validate_shot(
            &data,
            &project.validation,
            section_id,
            shot_index,
        ));

        let shot = if let Some(before_id) = before_shot_id {
            project.insert_shot_before(section_id, before_id, data, None, None)
        } else if let Some(after_id) = after_shot_id {
            project.insert_shot_after(section_id, after_id, data, None, None)
        } else {
            project.add_shot(section_id, data)
        };

        if let Some(new_shot) = shot {
            let new_shot_id = new_shot.id;
            tracing::debug!(
                section_id,
                shot_id = new_shot_id,
                purpose = "add shot to section",
                "Shot created"
            );
            let result = CommandResult::success().with_shot_id(new_shot_id);
            if warnings.is_empty() {
                result
            } else {
                result.with_warnings(warnings)
            }
        } else {
            CommandResult::failure("Failed to create shot".to_string())
        }
    }

    pub(super) fn update_shot(
        &self,
        section_id: SectionId,
        shot_id: ShotId,
        updates: ShotUpdates,
    ) -> CommandResult {
        let Ok(mut proj_guard) = self.project.lock() else {
            return CommandResult::failure("Failed to lock project".to_string());
        };

        let Some(project) = proj_guard.as_mut() else {
            return CommandResult::failure("No project open".to_string());
        };

        // Reject non-finite geometry before it reaches the coordinate path.
        if !updates.all_finite() {
            return CommandResult::failure(
                "Shot update has a non-finite (NaN/inf) value".to_string(),
            );
        }

        // Validate resulting length (disallow zero/negative)
        if let Some(section) = project.sections.iter().find(|s| s.id == section_id) {
            if let Some(existing) = section.shots.iter().find(|s| s.id == shot_id) {
                let new_length = updates.length.unwrap_or(existing.length);
                if new_length == 0.0 {
                    return CommandResult::failure(format!(
                        "Shot {}:{} has zero length",
                        section_id,
                        shot_display_position(shot_id, section_id)
                    ));
                }
                if new_length < 0.0 {
                    return CommandResult::failure(format!(
                        "Shot {}:{} has negative length: {:.1}m",
                        section_id,
                        shot_display_position(shot_id, section_id),
                        new_length
                    ));
                }

                // Reject geometry edits on frozen shots
                if updates.touches_geometry() && project.is_shot_frozen_by_id(section_id, shot_id) {
                    return CommandResult::failure(
                        "Cannot edit geometry of a frozen shot. This shot is part of an adjusted survey network.".to_string()
                    );
                }
            }
        }

        if project.update_shot(section_id, shot_id, &updates).is_some() {
            // Realign merge group offsets if geometry changed (keeps locked
            // stations pinned: merge points, zero datums)
            if updates.touches_geometry() {
                project.realign_after_shot_edit(section_id);
            }
            tracing::debug!(
                section_id,
                shot_id,
                purpose = "update shot measurements",
                "Shot updated"
            );
            CommandResult::success()
        } else {
            CommandResult::failure(format!("Shot {section_id}:{shot_id} not found"))
        }
    }

    pub(super) fn delete_shot(&self, section_id: SectionId, shot_id: ShotId) -> CommandResult {
        let Ok(mut proj_guard) = self.project.lock() else {
            return CommandResult::failure("Failed to lock project".to_string());
        };

        let Some(project) = proj_guard.as_mut() else {
            return CommandResult::failure("No project open".to_string());
        };

        // Defense-in-depth: refuse to delete a frozen shot (collaborator-locked
        // geometry anchored to an adjusted survey network). Mirrors update_shot's
        // frozen-geometry guard; the resolve-flow UI also gates this option. Runs
        // BEFORE the shift-blocked check so a frozen shot reports the clear frozen
        // message rather than the misleading "Use split instead."
        if project.is_shot_frozen_by_id(section_id, shot_id) {
            return CommandResult::failure(
                "Cannot delete a frozen shot. This shot is part of an adjusted survey network."
                    .to_string(),
            );
        }

        if let Ok(impact) = project.preview_delete_shot(section_id, shot_id) {
            if impact.shift_blocked {
                let reasons = if impact.shift_blocked_reasons.is_empty() {
                    "Shift geometry is not allowed for this shot.".to_string()
                } else {
                    impact.shift_blocked_reasons.join(" ")
                };
                return CommandResult::failure(format!("{reasons} Use split instead."));
            }
        }

        match project.remove_shot_with_rewire(section_id, shot_id) {
            Ok(_) => {
                tracing::debug!(
                    section_id,
                    shot_id,
                    purpose = "remove shot and rewire geometry",
                    "Shot deleted"
                );
                CommandResult::success()
            }
            Err(e) => CommandResult::failure(e),
        }
    }

    /// Remove the shot a `CreateShot` created, as the exact inverse of the
    /// insert that made it. Undo's path - NEVER a user's.
    ///
    /// This deliberately does not go through [`Self::delete_shot`]. That
    /// function's guards encode USER INTENT: refuse to tear a loop apart,
    /// refuse to touch collaborator-locked geometry. An inverse must not
    /// consult them, because **if a forward command was permitted, its inverse
    /// must be too** - and the shot being removed is one that did not exist
    /// before the command being undone, so removing it cannot break anything
    /// the insert did not already build. Routing undo through the user-facing
    /// delete produced an undo that FAILS outright, and `undo_inner` pushes a
    /// failed entry back onto the stack, so it fails identically forever and
    /// every entry beneath it becomes permanently unreachable - a wedged
    /// history (#413, finding 6). Both of `delete_shot`'s refusals fire in
    /// practice: the frozen-shot check and the shift-blocked loop/datum pair,
    /// so special-casing either one is not a fix.
    ///
    /// The guards keep applying to a USER delete: `Command::DeleteShot` still
    /// runs `delete_shot`, guards and all.
    ///
    /// `appended_into_empty_section` is the recorded shape of the insert being
    /// undone (both anchors absent and position 0 - an `add_shot` append into a
    /// section that had no shots); it is re-checked against the live section
    /// before it is honored.
    pub(super) fn remove_created_shot(
        &self,
        section_id: SectionId,
        shot_id: ShotId,
        appended_into_empty_section: bool,
    ) -> CommandResult {
        let Ok(mut proj_guard) = self.project.lock() else {
            return CommandResult::failure("Failed to lock project".to_string());
        };

        let Some(project) = proj_guard.as_mut() else {
            return CommandResult::failure("No project open".to_string());
        };

        // The one insert `remove_shot_with_rewire` is not the inverse of: an
        // append into an EMPTY section, whose `pos == 0` compensation displaces
        // the section and drops its station-0 refs (#413, finding 3). Every
        // other shape it mirrors exactly - an append into a non-empty section
        // leaves no station beyond the deletion point, so `anchored_sides_of_edit`
        // sees no anchored tail and compensates nothing; a mid-chain insert and a
        // prepend are undone by the same offset arithmetic that made them.
        let sole_shot = project
            .get_section(section_id)
            .is_some_and(|section| section.shots.len() == 1 && section.shots[0].id == shot_id);
        let removed = if appended_into_empty_section && sole_shot {
            project
                .remove_appended_first_shot(section_id, shot_id)
                .map(|_| ())
        } else {
            project
                .remove_shot_with_rewire(section_id, shot_id)
                .map(|_| ())
        };

        match removed {
            Ok(()) => {
                tracing::debug!(
                    section_id,
                    shot_id,
                    appended_into_empty_section = appended_into_empty_section && sole_shot,
                    purpose = "undo a shot creation",
                    "Created shot removed"
                );
                CommandResult::success()
            }
            Err(e) => CommandResult::failure(e),
        }
    }

    pub(super) fn set_shot_kind(
        &self,
        section_id: SectionId,
        shot_id: ShotId,
        kind: ShotKind,
    ) -> CommandResult {
        self.with_project_mut(|project| {
            if project.set_shot_kind(section_id, shot_id, kind).is_some() {
                tracing::info!(
                    section_id,
                    shot_id,
                    kind = kind.label(),
                    purpose = "set shot kind (permanent/jump/reference)",
                    "Shot kind updated"
                );
                CommandResult::success()
            } else {
                CommandResult::failure(format!("Shot {section_id}:{shot_id} not found"))
            }
        })
    }
}
