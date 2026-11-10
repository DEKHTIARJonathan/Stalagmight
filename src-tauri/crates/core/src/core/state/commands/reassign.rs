use super::{AppState, Command, CommandResult};
use crate::models::{SectionData, SectionId, ShotId, FEATURE_ID_STRIDE};

impl AppState {
    /// Transfer a shot as one atomic, identity-preserving undo unit.
    pub fn reassign_shot(
        &self,
        source: SectionId,
        shot_id: ShotId,
        destination: Option<SectionId>,
        new_section: Option<SectionData>,
    ) -> CommandResult {
        let Ok(_guard) = self.command_lock.lock() else {
            return CommandResult::failure("Failed to acquire command lock".into());
        };
        if let Err(failure) = self.speleodb_collect_reverify() {
            return failure;
        }
        if let Err(failure) = self.guard_mutation("Reassign shot") {
            return failure;
        }
        self.speleodb_verify_lock_if_expired();
        if destination.is_some() == new_section.is_some() {
            return CommandResult::failure("Choose an existing or new section".into());
        }
        {
            let guard = self.project.lock().ok();
            let valid = guard
                .as_ref()
                .and_then(|g| g.as_ref())
                .and_then(|project| project.get_section(source))
                .is_some_and(|section| section.get_shot(shot_id).is_some());
            if !valid {
                return CommandResult::failure("Source shot not found".into());
            }
        }
        if destination == Some(source) {
            return CommandResult::success()
                .with_section_id(source)
                .with_shot_id(shot_id);
        }
        self.invalidate_adjusted_cache();
        let before = match self.capture_project_snapshot() {
            Ok(snapshot) => snapshot,
            Err(failure) => return failure,
        };
        let critical = self.project_has_critical();
        let frame = self.frame_datum_key();
        let result = (|| -> Result<(SectionId, ShotId), String> {
            {
                let guard = self.project.lock().map_err(|_| "Failed to lock project")?;
                let project = guard.as_ref().ok_or("No project open")?;
                if project.is_shot_frozen_by_id(source, shot_id) {
                    return Err("Cannot move a frozen shot".into());
                }
                let impact = project.preview_delete_shot(source, shot_id)?;
                if impact.shift_blocked {
                    return Err(impact.shift_blocked_reasons.join(" "));
                }
            }
            let target = if let Some(mut data) = new_section {
                data.shots.clear();
                let created = self.create_section(data);
                if !created.success {
                    return Err(created.error.unwrap_or_default());
                }
                created
                    .section_id
                    .ok_or("Section creation returned no ID")?
            } else {
                destination.ok_or("Missing destination")?
            };
            let mut guard = self.project.lock().map_err(|_| "Failed to lock project")?;
            let project = guard.as_mut().ok_or("No project open")?;
            let section = project
                .get_section(target)
                .ok_or("Destination section not found")?;
            if section.shots.len() >= FEATURE_ID_STRIDE.saturating_sub(1) as usize {
                return Err("Destination section is full".into());
            }
            let (shot, _) = project.remove_shot_with_rewire(source, shot_id)?;
            let number = shot.number;
            let added = project
                .add_shot_with_number(target, shot.to_shot_data(), number)
                .ok_or("Cannot append shot")?;
            let id = added.id;
            if let Some(moved) = project
                .get_section_mut(target)
                .and_then(|section| section.get_shot_mut(id))
            {
                moved.number = number;
            }
            project.ensure_shot_numbers()?;
            Ok((target, id))
        })();
        let (target, new_id) = match result {
            Ok(ids) => ids,
            Err(error) => {
                self.rollback_project(&before);
                return CommandResult::failure(error);
            }
        };
        self.convert_orphan_closures_in_open_project();
        self.renormalize_frame_if_changed(frame);
        self.reconcile_geometry();
        if let Some(failure) = self.guard_introduced_corruption(critical, &before, "Reassign shot")
        {
            return failure;
        }
        let after = match self.capture_after_snapshot_or_rollback(&before) {
            Ok(snapshot) => snapshot,
            Err(failure) => return failure,
        };
        self.push_snapshot_undo(
            Command::Batch {
                commands: vec![Command::DeleteShot {
                    section_id: source,
                    shot_id,
                }],
            },
            before,
            after,
        );
        self.mark_remote_forward_edit();
        CommandResult::success()
            .with_section_id(target)
            .with_shot_id(new_id)
    }
}

#[cfg(test)]
#[expect(
    clippy::unwrap_used,
    clippy::indexing_slicing,
    reason = "test assertions fail loudly"
)]
mod tests {
    use super::*;
    use crate::models::ShotData;

    fn section(state: &AppState, lengths: &[f64]) -> SectionId {
        let result = state.execute(Command::CreateSection {
            name: Some("Synthetic section".into()),
            surveyor: None,
            date: None,
            color: "#4ecdc4".into(),
            direction: None,
            shots: lengths
                .iter()
                .map(|length| ShotData {
                    length: *length,
                    azimuth_in: 90.0,
                    azimuth_out: 90.0,
                    ..ShotData::default()
                })
                .collect(),
        });
        assert!(result.success, "{:?}", result.error);
        result.section_id.unwrap()
    }

    fn state() -> AppState {
        let state = AppState::new().unwrap();
        assert!(
            state
                .execute(Command::CreateProject {
                    name: "Transfer test".into(),
                    location: None
                })
                .success
        );
        state
    }

    #[test]
    fn transfer_preserves_identity_and_undo_redo() {
        for index in 0..3 {
            let state = state();
            let source = section(&state, &[10.0, 20.0, 30.0]);
            let destination = section(&state, &[40.0]);
            let before = state.get_project_state().unwrap();
            let shot = before.get_section(source).unwrap().shots[index].clone();
            let result = state.reassign_shot(source, shot.id, Some(destination), None);
            assert!(result.success, "{:?}", result.error);
            let after = state.get_project_state().unwrap();
            assert_eq!(after.get_section(source).unwrap().shots.len(), 2);
            let moved = after
                .get_section(destination)
                .unwrap()
                .shots
                .last()
                .unwrap();
            assert_eq!(moved.uuid, shot.uuid);
            assert_eq!(moved.length, shot.length);
            assert_eq!(Some(moved.id), result.shot_id);
            assert!(state.undo().success);
            assert_eq!(
                state
                    .get_project_state()
                    .unwrap()
                    .get_section(source)
                    .unwrap()
                    .shots[index]
                    .uuid,
                shot.uuid
            );
            assert!(state.redo().success);
            assert_eq!(
                state
                    .get_project_state()
                    .unwrap()
                    .get_section(destination)
                    .unwrap()
                    .shots
                    .last()
                    .unwrap()
                    .uuid,
                shot.uuid
            );
        }
    }

    #[test]
    fn sole_shot_leaves_empty_source_and_failures_are_atomic() {
        let state = state();
        let source = section(&state, &[10.0]);
        let destination = section(&state, &[]);
        let shot_id = state
            .get_project_state()
            .unwrap()
            .get_section(source)
            .unwrap()
            .shots[0]
            .id;
        let before = state.capture_project_snapshot().unwrap();
        assert!(
            !state
                .reassign_shot(source, shot_id, Some(9999), None)
                .success
        );
        assert_eq!(state.capture_project_snapshot().unwrap(), before);
        assert!(
            state
                .reassign_shot(source, shot_id, Some(destination), None)
                .success
        );
        assert!(state
            .get_project_state()
            .unwrap()
            .get_section(source)
            .unwrap()
            .shots
            .is_empty());
    }

    #[test]
    fn same_section_validates_source_and_is_noop() {
        let state = state();
        assert!(!state.reassign_shot(99, 1, Some(99), None).success);
        let source = section(&state, &[10.0]);
        let shot_id = state
            .get_project_state()
            .unwrap()
            .get_section(source)
            .unwrap()
            .shots[0]
            .id;
        let before = state.capture_project_snapshot().unwrap();
        assert!(
            state
                .reassign_shot(source, shot_id, Some(source), None)
                .success
        );
        assert_eq!(state.capture_project_snapshot().unwrap(), before);
    }
    #[test]
    fn transfer_round_trips_through_save_reopen_and_persisted_undo() {
        let temp = tempfile::TempDir::new().unwrap();
        let path = temp.path().join("synthetic-transfer.stalx");
        let state = state();
        let source = section(&state, &[10.0, 20.0]);
        let destination = section(&state, &[]);
        let shot = state
            .get_project_state()
            .unwrap()
            .get_section(source)
            .unwrap()
            .shots[0]
            .clone();
        assert!(
            state
                .reassign_shot(source, shot.id, Some(destination), None)
                .success
        );
        assert!(state.save_project(Some(path.clone())).success);
        let reopened = AppState::new().unwrap();
        assert!(reopened.open_project(path).success);
        assert_eq!(
            reopened
                .get_project_state()
                .unwrap()
                .get_section(destination)
                .unwrap()
                .shots[0]
                .uuid,
            shot.uuid
        );
        assert!(reopened.undo().success);
        assert_eq!(
            reopened
                .get_project_state()
                .unwrap()
                .get_section(source)
                .unwrap()
                .shots[0]
                .uuid,
            shot.uuid
        );
        assert!(reopened.redo().success);
        assert_eq!(
            reopened
                .get_project_state()
                .unwrap()
                .get_section(destination)
                .unwrap()
                .shots[0]
                .uuid,
            shot.uuid
        );
    }

    #[test]
    fn creates_destination_and_transfers_as_one_undo() {
        let state = state();
        let source = section(&state, &[10.0]);
        let shot = state
            .get_project_state()
            .unwrap()
            .get_section(source)
            .unwrap()
            .shots[0]
            .clone();
        let result = state.reassign_shot(
            source,
            shot.id,
            None,
            Some(SectionData {
                name: Some("New destination".into()),
                color: "#4ecdc4".into(),
                ..SectionData::default()
            }),
        );
        assert!(result.success, "{:?}", result.error);
        let destination = result.section_id.unwrap();
        assert_eq!(
            state
                .get_project_state()
                .unwrap()
                .get_section(destination)
                .unwrap()
                .shots[0]
                .uuid,
            shot.uuid
        );
        assert!(state.undo().success);
        assert!(state
            .get_project_state()
            .unwrap()
            .get_section(destination)
            .is_none());
        assert_eq!(
            state
                .get_project_state()
                .unwrap()
                .get_section(source)
                .unwrap()
                .shots[0]
                .uuid,
            shot.uuid
        );
    }
    fn numbers(state: &AppState, id: SectionId) -> Vec<u32> {
        state
            .get_project_state()
            .unwrap()
            .get_section(id)
            .unwrap()
            .shots
            .iter()
            .map(|shot| shot.number.unwrap())
            .collect()
    }

    #[test]
    fn user_numbers_are_project_wide_and_survive_transfer() {
        let state = state();
        let source = section(&state, &[10.0, 20.0]);
        let destination = section(&state, &[30.0]);
        assert_eq!(numbers(&state, source), vec![1, 2]);
        assert_eq!(numbers(&state, destination), vec![3]);
        let shot = state
            .get_project_state()
            .unwrap()
            .get_section(source)
            .unwrap()
            .shots[0]
            .clone();
        assert!(
            state
                .reassign_shot(source, shot.id, Some(destination), None)
                .success
        );
        assert_eq!(numbers(&state, source), vec![2]);
        assert_eq!(numbers(&state, destination), vec![3, 1]);
        assert_eq!(state.get_project_state().unwrap().shot_numbering.next, 4);
        assert!(state.undo().success);
        assert_eq!(numbers(&state, source), vec![1, 2]);
        assert!(state.redo().success);
        assert_eq!(numbers(&state, destination), vec![3, 1]);
    }

    #[test]
    fn numbers_are_not_reused_after_undo_or_save_reopen() {
        let state = state();
        let source = section(&state, &[10.0]);
        let create = |state: &AppState| {
            state.execute(Command::CreateShot {
                section_id: source,
                shot: ShotData {
                    length: 10.0,
                    ..ShotData::default()
                },
                after_shot_id: None,
                before_shot_id: None,
            })
        };
        assert!(create(&state).success);
        assert_eq!(numbers(&state, source), vec![1, 2]);
        assert!(state.undo().success);
        assert!(state.redo().success);
        assert_eq!(numbers(&state, source), vec![1, 2]);
        assert!(state.undo().success);
        assert!(create(&state).success);
        assert_eq!(numbers(&state, source), vec![1, 3]);
        let temp = tempfile::TempDir::new().unwrap();
        let path = temp.path().join("numbered.stalx");
        assert!(state.save_project(Some(path.clone())).success);
        let reopened = AppState::new().unwrap();
        assert!(reopened.open_project(path).success);
        assert_eq!(numbers(&reopened, source), vec![1, 3]);
        assert!(create(&reopened).success);
        assert_eq!(numbers(&reopened, source), vec![1, 3, 4]);
    }

    #[test]
    fn exhausted_number_space_refuses_new_shots_and_sections() {
        let state = state();
        let source = section(&state, &[10.0]);
        state
            .project
            .lock()
            .unwrap()
            .as_mut()
            .unwrap()
            .shot_numbering
            .next = u64::from(u32::MAX) + 1;
        let before = state.capture_project_snapshot().unwrap();
        let result = state.execute(Command::CreateShot {
            section_id: source,
            shot: ShotData {
                length: 10.0,
                ..ShotData::default()
            },
            after_shot_id: None,
            before_shot_id: None,
        });
        assert!(!result.success);
        let result = state.execute(Command::CreateSection {
            name: None,
            surveyor: None,
            date: None,
            color: "#4ecdc4".into(),
            direction: None,
            shots: vec![ShotData {
                length: 10.0,
                ..ShotData::default()
            }],
        });
        assert!(!result.success);
        assert_eq!(state.capture_project_snapshot().unwrap(), before);
    }
    #[test]
    fn whole_project_undo_keeps_the_live_allocation_highwater() {
        let state = state();
        let source = section(&state, &[10.0]);
        let destination = section(&state, &[20.0]);
        let id = state
            .get_project_state()
            .unwrap()
            .get_section(source)
            .unwrap()
            .shots[0]
            .id;
        assert!(
            state
                .reassign_shot(source, id, Some(destination), None)
                .success
        );
        assert!(
            state
                .execute(Command::CreateShot {
                    section_id: destination,
                    shot: ShotData {
                        length: 10.0,
                        ..ShotData::default()
                    },
                    after_shot_id: None,
                    before_shot_id: None,
                })
                .success
        );
        assert_eq!(numbers(&state, destination), vec![2, 1, 3]);
        assert!(state.undo().success);
        assert!(state.undo().success);
        assert!(
            state
                .execute(Command::CreateShot {
                    section_id: source,
                    shot: ShotData {
                        length: 10.0,
                        ..ShotData::default()
                    },
                    after_shot_id: None,
                    before_shot_id: None,
                })
                .success
        );
        assert_eq!(numbers(&state, source), vec![1, 4]);
    }
    #[test]
    fn failed_batch_restores_allocator_byte_for_byte() {
        let state = state();
        section(&state, &[10.0]);
        let before = state.capture_project_snapshot().unwrap();
        let result = state.execute(Command::Batch {
            commands: vec![
                Command::CreateSection {
                    name: None,
                    surveyor: None,
                    date: None,
                    color: "#4ecdc4".into(),
                    direction: None,
                    shots: vec![ShotData {
                        length: 10.0,
                        ..ShotData::default()
                    }],
                },
                Command::UpdateShot {
                    section_id: 999,
                    shot_id: 999,
                    updates: crate::models::ShotUpdates {
                        length: Some(20.0),
                        ..Default::default()
                    },
                },
            ],
        });
        assert!(!result.success);
        assert_eq!(state.capture_project_snapshot().unwrap(), before);
        assert_eq!(state.get_project_state().unwrap().shot_numbering.next, 2);
    }
}
