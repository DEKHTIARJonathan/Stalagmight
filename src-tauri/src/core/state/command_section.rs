use super::AppState;
use crate::core::{CommandResult, Validator};
use crate::models::{SectionData, SectionId, SectionUpdates, FEATURE_ID_STRIDE};

impl AppState {
    pub(super) fn create_section(&self, data: SectionData) -> CommandResult {
        let Ok(mut proj_guard) = self.project.lock() else {
            return CommandResult::failure("Failed to lock project".to_string());
        };

        let Some(project) = proj_guard.as_mut() else {
            return CommandResult::failure("No project open".to_string());
        };

        let max_shots = FEATURE_ID_STRIDE.saturating_sub(1) as usize;
        if data.shots.len() > max_shots {
            return CommandResult::failure(format!(
                "Section exceeds maximum shots per section (limit = {max_shots})"
            ));
        }

        // Reject non-finite geometry before it reaches the coordinate path (NaN/
        // inf slips past the zero/negative-length checks below). This is the
        // import/create-and-merge ingest path, alongside create_shot/update_shot.
        if data.shots.iter().any(|s| !s.all_finite()) {
            return CommandResult::failure(
                "Section has a shot with a non-finite (NaN/inf) value".to_string(),
            );
        }

        // Validate shots using the section_id that will be assigned
        let section_id_for_validation = project.next_section_id;
        let mut warnings = Vec::new();
        for (i, shot) in data.shots.iter().enumerate() {
            if shot.length == 0.0 {
                return CommandResult::failure(format!(
                    "Shot {}:{} has zero length",
                    section_id_for_validation,
                    i + 1
                ));
            }
            if shot.length < 0.0 {
                return CommandResult::failure(format!(
                    "Shot {}:{} has negative length: {:.1}m",
                    section_id_for_validation,
                    i + 1,
                    shot.length
                ));
            }
            // Per-project thresholds (#57) so create-time warnings match the panel.
            warnings.extend(Validator::validate_shot(
                shot,
                &project.validation,
                section_id_for_validation,
                i,
            ));
        }

        let section = project.add_section(data);
        let section_id = section.id;
        tracing::debug!(
            section_id = section_id,
            purpose = "add section to project",
            "Section created"
        );

        let result = CommandResult::success().with_section_id(section_id);
        if warnings.is_empty() {
            result
        } else {
            result.with_warnings(warnings)
        }
    }

    pub(super) fn delete_section(&self, section_id: SectionId) -> CommandResult {
        self.with_project_mut(|project| {
            if project.get_section(section_id).is_some() {
                project.preserve_connections_for_section_deletion(section_id);
                project.cleanup_section_references(section_id);
                project.remove_section(section_id);
                tracing::debug!(
                    section_id,
                    purpose = "remove section and cleanup references",
                    "Section deleted (with cleanup)"
                );
                CommandResult::success()
            } else {
                CommandResult::failure(format!("Section {section_id} not found"))
            }
        })
    }

    pub(super) fn update_section(
        &self,
        section_id: SectionId,
        updates: SectionUpdates,
    ) -> CommandResult {
        self.with_project_mut(|project| {
            if project.update_section(section_id, &updates).is_some() {
                tracing::debug!(
                    section_id,
                    purpose = "update section metadata or shots",
                    "Section updated"
                );
                CommandResult::success()
            } else {
                CommandResult::failure(format!("Section {section_id} not found"))
            }
        })
    }
}
