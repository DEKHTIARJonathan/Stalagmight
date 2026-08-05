use crate::core::{Command, CommandResult};
use crate::models::{Section, SectionData, SectionId, SectionIdentity, Shot, ShotData, ShotId};

use super::AppState;

impl AppState {
    /// Re-derive section offsets so merged stations stay colocated, healing any
    /// drift a just-completed operation left behind.
    ///
    /// Section offsets are treated as *derived* state: rather than trust every
    /// forward / undo / redo path to maintain them perfectly by hand (the source
    /// of the redo-desync and cascade-propagation bugs), the command layer
    /// reconciles them once after each user action. It is a no-op when nothing
    /// drifted (the common case - an `O(shots + merges)` check thanks to the
    /// coordinate precompute) and is skipped during the bulk-import loop
    /// (`cascade_deferred`), so it doesn't reintroduce the per-mutation cost.
    pub(super) fn reconcile_geometry(&self) {
        let mut guard = match self.project.lock() {
            Ok(g) => g,
            Err(poisoned) => poisoned.into_inner(),
        };
        let Some(project) = guard.as_mut() else {
            return;
        };
        if project.cascade_deferred {
            return;
        }
        let fixed = project.realign_merges();
        if fixed > 0 {
            tracing::warn!(
                fixed,
                purpose = "self-heal derived geometry",
                "Re-aligned drifted station merges after an operation"
            );
        }
    }

    /// Execute a command without pushing to undo stack (used for undo operations and batch)
    pub(super) fn execute_without_undo(&self, cmd: Command) -> CommandResult {
        match &cmd {
            Command::CreateSection {
                name,
                surveyor,
                date,
                color,
                direction,
                shots,
            } => self.create_section(SectionData {
                name: name.clone(),
                surveyor: surveyor.clone(),
                date: *date,
                color: color.clone(),
                direction: *direction,
                quality: 1.0,
                // Batch sub-commands arrive verbatim off IPC (#423): strip
                // uuids here like `execute`'s own CreateSection arm does -
                // never in `AppState::create_section`, which the importers
                // share with legitimately-adopted identities.
                shots: shots
                    .iter()
                    .cloned()
                    .map(|mut s| {
                        s.uuid = None;
                        s
                    })
                    .collect(),
            }),
            Command::DeleteSection { section_id } => self.delete_section(*section_id),
            Command::UpdateSectionMetadata {
                section_id,
                updates,
            } => self.update_section(*section_id, updates.clone()),
            // Reachable as a batch sub-command: reversing a multi-selection is
            // one atomic user action (#24).
            Command::ReverseSection {
                section_id,
                swap_left_right,
            } => self.reverse_section(*section_id, *swap_left_right),
            Command::CreateShot {
                section_id,
                shot,
                after_shot_id,
                before_shot_id,
            } => self.create_shot(*section_id, shot.clone(), *after_shot_id, *before_shot_id),
            Command::UpdateShot {
                section_id,
                shot_id,
                updates,
            } => self.update_shot(*section_id, *shot_id, updates.clone()),
            Command::DeleteShot {
                section_id,
                shot_id,
            } => self.delete_shot(*section_id, *shot_id),
            Command::SetShotKind {
                section_id,
                shot_id,
                kind,
            } => self.set_shot_kind(*section_id, *shot_id, *kind),
            Command::MergeStations {
                station_a,
                station_b,
            } => self.merge_stations(*station_a, *station_b),
            Command::UnmergeStations { station_ref } => self.unmerge_stations(*station_ref),
            Command::UnmergeStationPair {
                station_a,
                station_b,
            } => self.unmerge_station_pair(*station_a, *station_b),
            Command::CreateLoopClosure {
                station_a,
                station_b,
                closure_strategy,
            } => self.create_loop_closure(*station_a, *station_b, *closure_strategy),
            Command::RemoveLoopClosure { closure_id } => self.remove_loop_closure(*closure_id),
            Command::SetZeroDatum {
                station_ref,
                coordinates,
            } => self.set_zero_datum(*station_ref, *coordinates),
            Command::RemoveZeroDatum { station_ref } => self.remove_zero_datum(*station_ref),
            Command::MoveSection { section_id, offset } => self.move_section(*section_id, *offset),
            Command::MoveSegment { section_id, offset } => self.move_segment(*section_id, *offset),
            Command::SetStationComment {
                station_ref,
                comment,
            } => self.set_station_comment(*station_ref, comment.clone()),
            Command::MoveStation {
                station_ref,
                offset,
            } => self.move_station(*station_ref, *offset),
            Command::Batch { commands } => self.execute_batch(commands.clone(), false),
            _ => CommandResult::failure("Command cannot be executed in undo context".to_string()),
        }
    }

    /// Restore a deleted section with its original ID and its original identity.
    ///
    /// `identity` carries what `SectionData` cannot: the shots' uuids, the
    /// reverse parity and the gauge pair. A default `identity` (a legacy
    /// persisted entry, which has no such field) mints fresh uuids and resets
    /// the pair, which is the pre-fix behaviour (#413, finding 1).
    pub(super) fn restore_section(
        &self,
        original_id: SectionId,
        data: SectionData,
        identity: &SectionIdentity,
    ) -> CommandResult {
        let Ok(mut proj_guard) = self.project.lock() else {
            return CommandResult::failure("Failed to lock project".to_string());
        };

        let Some(project) = proj_guard.as_mut() else {
            return CommandResult::failure("No project open".to_string());
        };

        // Create section with original ID
        let section = Section::restore_with_identity(original_id, data, identity);
        // Keep section_index_cache in step.  The matching
        // `remove_section` cleared the cache; without this insert
        // every subsequent `get_section` would fall back to the O(N)
        // linear scan until something else rebuilds the cache.
        project
            .section_index_cache
            .insert(section.id, project.sections.len());
        project.sections.push(section);
        // The restored shots keep the uuids the entry recorded, so the
        // `(section, uuid) -> index` cache `add_section` maintains incrementally
        // has to be refreshed for them too; a missing entry is not wrong (
        // `resolve_key` falls back to a linear scan) but every AfterShot lookup
        // into this section would pay for it.
        project.reindex_section_shot_uuids(original_id);
        project.touch();

        // Update next_section_id if needed
        if original_id >= project.next_section_id {
            project.next_section_id = original_id + 1;
        }

        tracing::info!(section_id = original_id, "Section restored");
        CommandResult::success().with_section_id(original_id)
    }

    /// Restore a deleted shot at its original position with its original ID
    pub(super) fn restore_shot(
        &self,
        section_id: SectionId,
        original_shot_id: ShotId,
        data: ShotData,
        position: usize,
        uuid: Option<String>,
    ) -> CommandResult {
        let Ok(mut proj_guard) = self.project.lock() else {
            return CommandResult::failure("Failed to lock project".to_string());
        };

        let Some(project) = proj_guard.as_mut() else {
            return CommandResult::failure("No project open".to_string());
        };

        let Some(section) = project.get_section_mut(section_id) else {
            return CommandResult::failure(format!("Section {section_id} not found"));
        };

        // Recreate the shot with its original ID and UUID so the restored shot
        // keeps the identity station cross-references anchor on
        // (`StationKey::AfterShot`) and the Ariane export emits as `<UUID>`.
        //
        // Two places the identity can come from, and `Shot::with_uuid` prefers
        // the first: the payload's own `ShotData::uuid` (every entry written
        // since #423), or the `uuid` this entry recorded beside it (entries
        // written between the UUID column landing and #423). An entry older than
        // BOTH carries neither, and `with_uuid` does not mint - so this goes
        // through `uuid_or_mint`, or the restored shot would come back with no
        // identity at all: unindexed, and unnameable by any `AfterShot` anchor
        // until some later save noticed.
        let shot = Shot::with_uuid(original_shot_id, data, Some(Shot::uuid_or_mint(uuid)));

        // The one insert path that takes a payload-borne identity, so it is also
        // the one that could reintroduce a uuid the section acquired in the
        // meantime. Not reachable today: the only door a FOREIGN id enters
        // through is section creation (`Section::new`, which de-dupes), and
        // every other mint is a fresh v4 - so nothing can be holding this shot's
        // recorded uuid while the shot itself is deleted. Asserted rather than
        // argued, because the cheap repairs are both wrong here: clearing or
        // re-minting the restored shot would defeat the restore, whose entire
        // purpose is to bring that anchor back.
        let identity_already_present = section
            .shots
            .iter()
            .any(|s| s.uuid.is_some() && s.uuid == shot.uuid);
        debug_assert!(
            !identity_already_present,
            "restore_shot: section {section_id} already holds the identity being restored"
        );
        if identity_already_present {
            tracing::warn!(
                section_id,
                shot_id = original_shot_id,
                purpose = "shot identity uniqueness (#423)",
                "Restoring a shot whose UUID is already present in the section; the \
                 pre-save repair will re-mint one of them"
            );
        }

        // Update next_shot_id if needed to avoid collisions
        if original_shot_id >= section.next_shot_id {
            section.next_shot_id = original_shot_id + 1;
        }

        if position <= section.shots.len() {
            section.shots.insert(position, shot);
        } else {
            section.shots.push(shot);
        }

        project.touch();

        tracing::info!(
            section_id,
            shot_id = original_shot_id,
            position,
            "Shot restored"
        );
        CommandResult::success()
    }
}
