use super::{AppState, Command, CommandResult};

impl AppState {
    /// Replace one incoming graph edge as a single atomic undo unit.
    pub fn set_shot_from_id(&self, shot_number: u32, from_id: Option<u32>) -> CommandResult {
        let Ok(_guard) = self.command_lock.lock() else {
            return CommandResult::failure("Failed to acquire command lock".into());
        };
        if let Err(failure) = self.speleodb_collect_reverify() {
            return failure;
        }
        if let Err(failure) = self.guard_mutation("Set shot origin") {
            return failure;
        }
        self.speleodb_verify_lock_if_expired();
        let before = match self.capture_project_snapshot() {
            Ok(snapshot) => snapshot,
            Err(failure) => return failure,
        };
        let result = (|| -> Result<(u32, u32, bool), String> {
            let mut guard = self.project.lock().map_err(|_| "Failed to lock project")?;
            let project = guard.as_mut().ok_or("No project open")?;
            project.initialize_shot_graph()?;
            let mut location = None;
            let mut target_exists = from_id.is_none();
            for section in &project.sections {
                for (index, shot) in section.shots.iter().enumerate() {
                    if shot.number == Some(shot_number) {
                        location = Some((section.id, index, shot.id, shot.from_id));
                    }
                    if shot.number == from_id {
                        target_exists = true;
                    }
                }
            }
            let (section_id, index, id, old) = location.ok_or("Shot does not exist")?;
            if !target_exists {
                return Err("Origin shot does not exist".into());
            }
            if from_id == Some(shot_number) {
                return Err("A shot cannot originate from itself".into());
            }
            if old == from_id {
                return Ok((section_id, id, false));
            }
            if project.is_shot_frozen_by_id(section_id, id) {
                return Err("Cannot change the origin of a frozen shot".into());
            }
            let reference = if project.shot_graph.explicit {
                crate::models::Project::shot_start_ref(section_id, index)
            } else {
                crate::models::StationRef::new(section_id, index as u32)
            };
            if let Some(position) = project.compute_station_raw_coords(reference) {
                project
                    .shot_graph
                    .root_positions
                    .insert(shot_number, (position.x, position.y));
            }
            let shot = project
                .get_section_mut(section_id)
                .and_then(|section| section.get_shot_mut(id))
                .ok_or("Shot no longer exists")?;
            shot.from_id = from_id;
            project.shot_graph.explicit = true;
            project.initialize_shot_graph()?;
            project.reconcile_shot_graph()?;
            project.touch();
            Ok((section_id, id, true))
        })();
        let (section_id, id, changed) = match result {
            Ok(result) => result,
            Err(error) => {
                self.rollback_project(&before);
                return CommandResult::failure(error);
            }
        };
        if !changed {
            return CommandResult::success()
                .with_section_id(section_id)
                .with_shot_id(id);
        }
        self.invalidate_adjusted_cache();
        let after = match self.capture_after_snapshot_or_rollback(&before) {
            Ok(snapshot) => snapshot,
            Err(failure) => return failure,
        };
        self.push_snapshot_undo(
            Command::Batch {
                commands: Vec::new(),
            },
            before,
            after,
        );
        self.mark_remote_forward_edit();
        CommandResult::success()
            .with_section_id(section_id)
            .with_shot_id(id)
    }
}

#[cfg(test)]
#[expect(
    clippy::unwrap_used,
    clippy::indexing_slicing,
    reason = "native directed graph regression assertions"
)]
mod tests {
    use super::*;
    use crate::models::{Coordinates, ShotData, StationRef};

    fn state() -> AppState {
        let state = AppState::new().unwrap();
        assert!(
            state
                .execute(Command::CreateProject {
                    name: "Native directed graph".into(),
                    location: None
                })
                .success
        );
        for lengths in [vec![10.0, 20.0], vec![30.0]] {
            assert!(
                state
                    .execute(Command::CreateSection {
                        name: None,
                        surveyor: None,
                        date: None,
                        color: "#4ecdc4".into(),
                        direction: None,
                        shots: lengths
                            .into_iter()
                            .map(|length| ShotData {
                                length,
                                azimuth_in: 90.0,
                                azimuth_out: 90.0,
                                ..Default::default()
                            })
                            .collect(),
                    })
                    .success
            );
        }
        state
            .project
            .lock()
            .unwrap()
            .as_mut()
            .unwrap()
            .section_offsets
            .insert(1, (100.0, 0.0));
        state
    }

    fn position(state: &AppState, number: u32, start: bool) -> Coordinates {
        let project = state.get_project_state().unwrap();
        let reference = project.endpoint_ref(number, start).unwrap();
        project.compute_station_raw_coords(reference).unwrap()
    }

    #[test]
    fn replacing_origin_changes_real_coordinates_and_removes_previous_path() {
        let state = state();
        let result = state.set_shot_from_id(2, Some(3));
        assert!(result.success, "{:?}", result.error);
        assert!((position(&state, 2, true).x - 130.0).abs() < 1e-9);
        assert!((position(&state, 2, false).x - 150.0).abs() < 1e-9);
        let project = state.get_project_state().unwrap();
        let stations = project.compute_station_coordinates();
        let root = stations
            .iter()
            .position(|station| station.station_ref == StationRef::new(0, 0))
            .unwrap();
        let moved = stations
            .iter()
            .position(|station| station.station_ref == StationRef::new(0, 2))
            .unwrap();
        assert!(project.compute_distances_from(&stations, &[root])[moved].is_infinite());
        let start = project.endpoint_ref(2, true).unwrap();
        assert!(stations
            .iter()
            .find(|station| station.station_ref == start)
            .unwrap()
            .merged_with
            .contains(&StationRef::new(1, 1)));
        assert!(state.undo().success);
        assert_eq!(
            state.get_project_state().unwrap().sections[0].shots[1].from_id,
            Some(1)
        );
        assert!(state.redo().success);
        assert_eq!(
            state.get_project_state().unwrap().sections[0].shots[1].from_id,
            Some(3)
        );
    }

    #[test]
    fn clearing_origin_detaches_at_current_position_and_round_trips() {
        let state = state();
        assert!(state.set_shot_from_id(2, Some(3)).success);
        assert!(state.set_shot_from_id(2, None).success);
        assert!((position(&state, 2, true).x - 130.0).abs() < 1e-9);
        let temp = tempfile::TempDir::new().unwrap();
        let path = temp.path().join("directed.stalx");
        assert!(state.save_project(Some(path.clone())).success);
        let reopened = AppState::new().unwrap();
        assert!(reopened.open_project(path).success);
        assert_eq!(
            reopened.get_project_state().unwrap().sections[0].shots[1].from_id,
            None
        );
        assert!((position(&reopened, 2, true).x - 130.0).abs() < 1e-9);
        assert!(reopened.undo().success);
        assert_eq!(
            reopened.get_project_state().unwrap().sections[0].shots[1].from_id,
            Some(3)
        );
        assert!(reopened.redo().success);
        assert_eq!(
            reopened.get_project_state().unwrap().sections[0].shots[1].from_id,
            None
        );
    }

    #[test]
    fn graph_allows_branches_and_cycles_but_rejects_unknown_and_self_targets_atomically() {
        let state = state();
        assert!(state.set_shot_from_id(2, Some(3)).success);
        assert!(state.set_shot_from_id(1, Some(3)).success);
        assert!((position(&state, 1, false).x - 140.0).abs() < 1e-9);
        let before = state.capture_project_snapshot().unwrap();
        assert!(!state.set_shot_from_id(1, Some(1)).success);
        assert!(!state.set_shot_from_id(1, Some(999)).success);
        assert_eq!(state.capture_project_snapshot().unwrap(), before);
        assert!(state.set_shot_from_id(3, Some(2)).success);
        let project = state.get_project_state().unwrap();
        assert!(!project.shot_graph_cycle_cuts().is_empty());
        let adjusted = project.compute_adjusted_station_coordinates(&Default::default());
        assert!(adjusted
            .iter()
            .all(|station| station.coordinates.is_finite()));
    }

    #[test]
    fn metadata_assignment_preserves_origin_measurements_and_world_coordinates() {
        let state = state();
        let project = state.get_project_state().unwrap();
        let shot = project.sections[0].shots[1].clone();
        let old = project
            .compute_station_raw_coords(StationRef::new(0, 2))
            .unwrap();
        let result = state.reassign_shot(0, shot.id, Some(1), None);
        assert!(result.success, "{:?}", result.error);
        let project = state.get_project_state().unwrap();
        let moved = project.sections[1]
            .shots
            .iter()
            .find(|shot| shot.number == Some(2))
            .unwrap();
        assert_eq!(moved.from_id, Some(1));
        assert_eq!(
            serde_json::to_string(&moved.to_shot_data()).unwrap(),
            serde_json::to_string(&shot.to_shot_data()).unwrap()
        );
        let new = position(&state, 2, false);
        assert!((old.x - new.x).abs() < 1e-9 && (old.y - new.y).abs() < 1e-9);
    }
}
