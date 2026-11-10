use super::{AppState, Command, CommandResult};

impl AppState {
    /// Persist a lock override as one undoable edit without changing topology.
    pub fn set_shot_locked(&self, shot_number: u32, locked: bool) -> CommandResult {
        let Ok(_guard) = self.command_lock.lock() else {
            return CommandResult::failure("Failed to acquire command lock".into());
        };
        if let Err(failure) = self.speleodb_collect_reverify() {
            return failure;
        }
        if let Err(failure) = self.guard_mutation("Set shot lock") {
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
            let (section_id, shot_id) = project
                .sections
                .iter()
                .find_map(|section| {
                    section
                        .shots
                        .iter()
                        .find(|shot| shot.number == Some(shot_number))
                        .map(|shot| (section.id, shot.id))
                })
                .ok_or("Shot does not exist")?;
            if project.shot_graph.geometry_locks.get(&shot_number) == Some(&locked) {
                return Ok((section_id, shot_id, false));
            }
            project
                .shot_graph
                .geometry_locks
                .insert(shot_number, locked);
            project.touch();
            Ok((section_id, shot_id, true))
        })();
        let (section_id, shot_id, changed) = match result {
            Ok(result) => result,
            Err(error) => {
                self.rollback_project(&before);
                return CommandResult::failure(error);
            }
        };
        if !changed {
            return CommandResult::success()
                .with_section_id(section_id)
                .with_shot_id(shot_id);
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
            .with_shot_id(shot_id)
    }
}
