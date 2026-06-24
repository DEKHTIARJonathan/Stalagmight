use super::AppState;
use crate::core::{CommandResult, Validator};
use crate::models::{
    shot_display_position, SectionId, ShotData, ShotId, ShotUpdates, FEATURE_ID_STRIDE,
};

impl AppState {
    pub(super) fn create_shot(
        &self,
        section_id: SectionId,
        data: ShotData,
        after_shot_id: Option<ShotId>,
        before_shot_id: Option<ShotId>,
    ) -> CommandResult {
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

    pub(super) fn set_shot_reference(
        &self,
        section_id: SectionId,
        shot_id: ShotId,
        is_reference: bool,
    ) -> CommandResult {
        self.with_project_mut(|project| {
            if project
                .set_shot_reference(section_id, shot_id, is_reference)
                .is_some()
            {
                tracing::info!(
                    section_id,
                    shot_id,
                    is_reference,
                    purpose = "toggle reference shot visibility",
                    "Shot reference status updated"
                );
                CommandResult::success()
            } else {
                CommandResult::failure(format!("Shot {section_id}:{shot_id} not found"))
            }
        })
    }
}
