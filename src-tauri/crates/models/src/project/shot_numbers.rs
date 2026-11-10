use std::collections::{BTreeMap, HashSet};

use serde::{Deserialize, Serialize};

use super::Project;

/// The registry retains retired identities so undo can restore a shot's number.
/// Section-qualified UUIDs distinguish imports sharing the same source UUID.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ShotNumbering {
    pub next: u64,
    pub identities: BTreeMap<String, u32>,
}

impl Default for ShotNumbering {
    fn default() -> Self {
        Self {
            next: 1,
            identities: BTreeMap::new(),
        }
    }
}

impl Project {
    /// Fill legacy or reconstructed shots without renumbering existing records.
    /// Persisted numbers and retired assignments reserve the high watermark.
    pub fn ensure_shot_numbers(&mut self) -> Result<(), String> {
        let numbering = &mut self.shot_numbering;
        numbering.next = numbering.next.max(1);
        for number in numbering.identities.values() {
            numbering.next = numbering.next.max(u64::from(*number) + 1);
        }
        let mut used = HashSet::new();
        for section in &mut self.sections {
            for shot in &mut section.shots {
                if let Some(number) = shot
                    .number
                    .filter(|number| *number > 0 && used.insert(*number))
                {
                    numbering.next = numbering.next.max(u64::from(number) + 1);
                } else {
                    shot.number = None;
                }
            }
        }
        // Legacy numbering is explicitly section/sequence order, independent of
        // a deserialized vector's ordering or any HashMap iteration order.
        let mut sections: Vec<_> = self.sections.iter_mut().collect();
        sections.sort_by_key(|section| section.id);
        for section in sections {
            for (index, shot) in section.shots.iter_mut().enumerate() {
                let identity = shot.uuid.as_ref().map_or_else(
                    || format!("{}:legacy:{index}", section.id),
                    |uuid| format!("{}:{uuid}", section.id),
                );
                if shot.number.is_none() {
                    let exact = numbering
                        .identities
                        .get(&identity)
                        .copied()
                        .filter(|number| *number > 0 && !used.contains(number));
                    let number = if let Some(number) = exact {
                        number
                    } else {
                        let number = u32::try_from(numbering.next)
                            .map_err(|_| "Project has exhausted its shot numbers".to_string())?;
                        numbering.next += 1;
                        number
                    };
                    shot.number = Some(number);
                    used.insert(number);
                }
                if let Some(number) = shot.number {
                    numbering.identities.insert(identity, number);
                }
            }
        }
        Ok(())
    }

    pub fn allocate_shot_number(&mut self) -> Result<u32, String> {
        let number = u32::try_from(self.shot_numbering.next.max(1))
            .map_err(|_| "Project has exhausted its shot numbers".to_string())?;
        self.shot_numbering.next = u64::from(number) + 1;
        Ok(number)
    }

    pub fn has_shot_number_capacity(&self, count: usize) -> bool {
        self.shot_numbering
            .next
            .checked_add(count as u64)
            .is_some_and(|next| next <= u64::from(u32::MAX) + 1)
    }
}

#[cfg(test)]
#[expect(
    clippy::unwrap_used,
    clippy::indexing_slicing,
    reason = "number identity regression assertions"
)]
mod tests {
    use super::*;
    use crate::{SectionData, ShotData};

    #[test]
    fn legacy_assignment_is_section_sequence_order() {
        let mut project = Project::new("Legacy".into(), None);
        for _ in 0..2 {
            project.add_section(SectionData {
                shots: vec![ShotData::default()],
                ..SectionData::default()
            });
        }
        for section in &mut project.sections {
            section.shots[0].number = None;
        }
        project.shot_numbering = ShotNumbering::default();
        project.sections.reverse();
        project.ensure_shot_numbers().unwrap();
        assert_eq!(project.get_section(0).unwrap().shots[0].number, Some(1));
        assert_eq!(project.get_section(1).unwrap().shots[0].number, Some(2));
    }

    #[test]
    fn structural_section_split_preserves_numbers_without_allocating() {
        let mut project = Project::new("Split".into(), None);
        let source = project
            .add_section(SectionData {
                shots: vec![ShotData::default(), ShotData::default()],
                ..SectionData::default()
            })
            .clone();
        let retained = source
            .shots
            .iter()
            .map(|shot| (shot.uuid.clone().unwrap(), shot.number.unwrap()))
            .collect();
        project.remove_section(source.id).unwrap();
        let moved = project.add_section_with_numbers(source.to_section_data(), &retained);
        assert_eq!(
            moved
                .shots
                .iter()
                .map(|shot| shot.number)
                .collect::<Vec<_>>(),
            vec![Some(1), Some(2)]
        );
        assert_eq!(project.shot_numbering.next, 3);
    }
}
