use std::collections::{BTreeMap, HashMap, HashSet, VecDeque};

use super::Project;
use crate::{Coordinates, SectionId, StationRef};
use serde::{Deserialize, Serialize};

/// The high bit distinguishes an interior measurement START from an END index.
/// Station references are opaque u32 pairs; map feature keys must preserve all bits.
pub const SHOT_START_INDEX_FLAG: u32 = 0x8000_0000;

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ShotGraphState {
    #[serde(default)]
    pub initialized: bool,
    #[serde(default)]
    pub explicit: bool,
    #[serde(default)]
    pub origins: BTreeMap<u32, Option<u32>>,
    #[serde(default)]
    pub root_positions: BTreeMap<u32, (f64, f64)>,
    #[serde(default)]
    pub azimuth_overrides: BTreeMap<u32, crate::AzimuthReference>,
    /// User overrides for computed geometry locks, keyed by immutable shot number.
    /// False explicitly unlocks a network-constrained measurement.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub geometry_locks: BTreeMap<u32, bool>,
}

impl Project {
    pub fn shot_start_ref(section_id: SectionId, index: usize) -> StationRef {
        StationRef::new(
            section_id,
            if index == 0 {
                0
            } else {
                SHOT_START_INDEX_FLAG | index as u32
            },
        )
    }

    pub fn shot_start_refs(&self) -> Vec<StationRef> {
        self.sections
            .iter()
            .flat_map(|section| {
                (0..section.shots.len()).map(move |index| {
                    if self.shot_graph.explicit {
                        Self::shot_start_ref(section.id, index)
                    } else {
                        StationRef::new(section.id, index as u32)
                    }
                })
            })
            .collect()
    }

    pub fn section_station_refs(&self, section_id: SectionId) -> Vec<StationRef> {
        let Some(section) = self.get_section(section_id) else {
            return Vec::new();
        };
        let mut refs: Vec<_> = (0..=section.shots.len())
            .map(|index| StationRef::new(section_id, index as u32))
            .collect();
        if self.shot_graph.explicit {
            refs.extend(
                (1..section.shots.len()).map(|index| Self::shot_start_ref(section_id, index)),
            );
        }
        refs
    }

    /// Fill the missing legacy topology once. Explicit null origins remain roots.
    pub fn initialize_shot_graph(&mut self) -> Result<(), String> {
        self.ensure_shot_numbers()?;
        for section in &mut self.sections {
            let mut previous = None;
            let mut xy = self
                .section_offsets
                .get(&section.id)
                .copied()
                .unwrap_or_default();
            let reference = section
                .azimuth_reference
                .unwrap_or(self.default_azimuth_reference.unwrap_or_default());
            for shot in &mut section.shots {
                let number = shot.number.ok_or("Shot has no permanent number")?;
                if !self.shot_graph.initialized || !self.shot_graph.explicit {
                    shot.from_id = previous;
                }
                if shot.from_id != previous {
                    self.shot_graph.explicit = true;
                }
                if self.shot_graph.explicit {
                    self.shot_graph.root_positions.entry(number).or_insert(xy);
                }

                let angle = shot.average_azimuth_true_rad(reference);
                let length = shot.horizontal_length();
                xy.0 += length * angle.sin();
                xy.1 += length * angle.cos();
                previous = shot.number;
            }
        }
        if !self.shot_graph.initialized {
            let mut converted = HashSet::new();
            let mut origins = Vec::new();
            for (index, merge) in self.station_merges.iter().enumerate() {
                let (Some(a), Some(b)) = (
                    self.resolve_key(&merge.station_a),
                    self.resolve_key(&merge.station_b),
                ) else {
                    continue;
                };
                let (start, end) = if a.station_index == 0 && b.station_index > 0 {
                    (a, b)
                } else if b.station_index == 0 && a.station_index > 0 {
                    (b, a)
                } else {
                    continue;
                };
                let source = self
                    .get_section(start.section_id)
                    .and_then(|section| section.shots.first())
                    .and_then(|shot| shot.number);
                let parent = self.endpoint_identity(end).map(|(number, _)| number);
                if let (Some(source), Some(parent)) = (source, parent) {
                    if source != parent && !origins.iter().any(|(old, _)| *old == source) {
                        origins.push((source, parent));
                        converted.insert(index);
                    }
                }
            }
            if !origins.is_empty() {
                for section in &mut self.sections {
                    for shot in &mut section.shots {
                        if let Some((_, parent)) = origins
                            .iter()
                            .find(|(number, _)| Some(*number) == shot.number)
                        {
                            shot.from_id = Some(*parent);
                        }
                    }
                }
                let mut index = 0usize;
                self.station_merges.retain(|_| {
                    let keep = !converted.contains(&index);
                    index += 1;
                    keep
                });
                self.shot_graph.explicit = true;
            }
        }
        self.shot_graph.initialized = true;
        let live: HashSet<_> = self
            .sections
            .iter()
            .flat_map(|section| &section.shots)
            .filter_map(|shot| shot.number)
            .collect();
        for section in &mut self.sections {
            for shot in &mut section.shots {
                let mut seen = HashSet::new();
                while let Some(parent) = shot.from_id.filter(|parent| !live.contains(parent)) {
                    if !seen.insert(parent) {
                        shot.from_id = None;
                        break;
                    }
                    shot.from_id = *self
                        .shot_graph
                        .origins
                        .get(&parent)
                        .ok_or_else(|| format!("Origin shot {parent} does not exist"))?;
                }
                if self.shot_graph.explicit {
                    if let Some(number) = shot.number {
                        self.shot_graph.origins.insert(number, shot.from_id);
                    }
                }
            }
        }
        if !self.shot_graph.explicit {
            self.shot_graph.origins.clear();
            self.shot_graph.root_positions.clear();
        }
        self.validate_shot_origins()
    }

    pub fn restore_saved_shot_graph(&mut self) -> Result<(), String> {
        if self.shot_graph.initialized {
            for section in &mut self.sections {
                for shot in &mut section.shots {
                    shot.from_id = shot
                        .number
                        .and_then(|number| self.shot_graph.origins.get(&number).copied().flatten());
                }
            }
        }
        if self.shot_graph.initialized {
            for section in &self.sections {
                let mut previous = None;
                for shot in &section.shots {
                    if shot.from_id != previous {
                        self.shot_graph.explicit = true;
                    }
                    previous = shot.number;
                }
            }
        }
        self.initialize_shot_graph()
    }

    pub fn validate_shot_origins(&self) -> Result<(), String> {
        let numbers: HashSet<_> = self
            .sections
            .iter()
            .flat_map(|section| &section.shots)
            .filter_map(|shot| shot.number)
            .collect();
        for shot in self.sections.iter().flat_map(|section| &section.shots) {
            if let Some(parent) = shot.from_id {
                if Some(parent) == shot.number {
                    return Err("A shot cannot originate from itself".into());
                }
                if !numbers.contains(&parent) {
                    return Err(format!("Origin shot {parent} does not exist"));
                }
            }
        }
        Ok(())
    }

    pub fn origin_station_links(&self) -> Vec<(StationRef, StationRef)> {
        if !self.shot_graph.explicit {
            return Vec::new();
        }
        let ends: HashMap<_, _> = self
            .sections
            .iter()
            .flat_map(|section| {
                section
                    .shots
                    .iter()
                    .enumerate()
                    .filter_map(move |(index, shot)| {
                        shot.number
                            .map(|number| (number, StationRef::new(section.id, index as u32 + 1)))
                    })
            })
            .collect();
        self.sections
            .iter()
            .flat_map(|section| {
                section
                    .shots
                    .iter()
                    .enumerate()
                    .filter_map(|(index, shot)| {
                        Some((
                            Self::shot_start_ref(section.id, index),
                            *ends.get(&shot.from_id?)?,
                        ))
                    })
            })
            .collect()
    }

    pub fn shot_graph_cycle_cuts(&self) -> std::collections::BTreeSet<u32> {
        let parents: BTreeMap<_, _> = self
            .sections
            .iter()
            .flat_map(|section| &section.shots)
            .filter_map(|shot| shot.number.map(|number| (number, shot.from_id)))
            .collect();
        let mut visited = HashSet::new();
        let mut cuts = std::collections::BTreeSet::new();
        for &number in parents.keys() {
            if visited.contains(&number) {
                continue;
            }
            let mut path = Vec::new();
            let mut offsets = HashMap::new();
            let mut next = Some(number);
            while let Some(node) = next {
                if let Some(&offset) = offsets.get(&node) {
                    if let Some(cut) = path
                        .get(offset..)
                        .and_then(|cycle| cycle.iter().min())
                        .copied()
                    {
                        cuts.insert(cut);
                    }
                    break;
                }
                if visited.contains(&node) {
                    break;
                }
                offsets.insert(node, path.len());
                path.push(node);
                next = parents.get(&node).copied().flatten();
            }
            visited.extend(path);
        }
        cuts
    }

    /// Measured layout follows explicit origins, independently of metadata order.
    /// Cycles are cut deterministically only for raw layout; their closing links
    /// remain in the graph and are included in the adjusted solve.
    pub fn shot_graph_positions(&self) -> HashMap<StationRef, Coordinates> {
        let mut shots = BTreeMap::new();
        for section in &self.sections {
            for (index, shot) in section.shots.iter().enumerate() {
                if let Some(number) = shot.number {
                    shots.insert(number, (section, index, shot));
                }
            }
        }
        let cuts = self.shot_graph_cycle_cuts();
        let mut children: HashMap<u32, Vec<u32>> = HashMap::new();
        let mut ready = VecDeque::new();
        for (&number, (_, _, shot)) in &shots {
            if let Some(parent) = shot
                .from_id
                .filter(|parent| shots.contains_key(parent) && !cuts.contains(&number))
            {
                children.entry(parent).or_default().push(number);
            } else {
                ready.push_back(number);
            }
        }
        let mut done = HashSet::new();
        let mut end_xy: HashMap<u32, (f64, f64)> = HashMap::new();
        let mut result = HashMap::new();
        while done.len() < shots.len() {
            // All remaining components are cycles. Pick a deterministic gauge.
            if ready.is_empty() {
                if let Some((&number, _)) = shots.iter().find(|(number, _)| !done.contains(*number))
                {
                    ready.push_back(number);
                }
            }
            let Some(number) = ready.pop_front() else {
                break;
            };
            if !done.insert(number) {
                continue;
            }
            let Some((section, index, shot)) = shots.get(&number) else {
                continue;
            };
            let xy = shot
                .from_id
                .filter(|_| !cuts.contains(&number))
                .and_then(|parent| end_xy.get(&parent).copied())
                .or_else(|| self.shot_graph.root_positions.get(&number).copied())
                .unwrap_or_else(|| {
                    self.section_offsets
                        .get(&section.id)
                        .copied()
                        .unwrap_or_default()
                });
            let reference = self
                .shot_graph
                .azimuth_overrides
                .get(&number)
                .copied()
                .unwrap_or_else(|| self.azimuth_reference_for(section));
            let angle = shot.average_azimuth_true_rad(reference);
            let length = shot.horizontal_length();
            let end = (xy.0 + length * angle.sin(), xy.1 + length * angle.cos());
            result.insert(
                Self::shot_start_ref(section.id, *index),
                Coordinates::new(xy.0, xy.1, shot.depth_in),
            );
            result.insert(
                StationRef::new(section.id, *index as u32 + 1),
                Coordinates::new(end.0, end.1, shot.depth_out),
            );
            end_xy.insert(number, end);
            if let Some(next) = children.get(&number) {
                ready.extend(next.iter().copied());
            }
        }
        for section in &self.sections {
            if section.shots.is_empty() {
                let xy = self
                    .section_offsets
                    .get(&section.id)
                    .copied()
                    .unwrap_or_default();
                result.insert(
                    StationRef::new(section.id, 0),
                    Coordinates::new(xy.0, xy.1, 0.0),
                );
            }
        }
        // Individual endpoint offsets are independent of metadata grouping.
        for (station, coords) in &mut result {
            if let Some((x, y, z)) = self.station_offset_for_ref(*station) {
                coords.x += x;
                coords.y += y;
                coords.z += z;
            }
        }
        result
    }
}

impl Project {
    pub fn endpoint_identity(&self, reference: StationRef) -> Option<(u32, bool)> {
        let section = self.get_section(reference.section_id)?;
        if reference.station_index == 0 {
            return Some((section.shots.first()?.number?, true));
        }
        if reference.station_index & SHOT_START_INDEX_FLAG != 0 {
            let index = (reference.station_index & !SHOT_START_INDEX_FLAG) as usize;
            return Some((section.shots.get(index)?.number?, true));
        }
        Some((
            section
                .shots
                .get(reference.station_index as usize - 1)?
                .number?,
            false,
        ))
    }

    pub fn endpoint_ref(&self, number: u32, start: bool) -> Option<StationRef> {
        for section in &self.sections {
            if let Some(index) = section
                .shots
                .iter()
                .position(|shot| shot.number == Some(number))
            {
                return Some(if start {
                    Self::shot_start_ref(section.id, index)
                } else {
                    StationRef::new(section.id, index as u32 + 1)
                });
            }
        }
        None
    }

    /// Change metadata grouping without changing any measurement or graph edge.
    pub fn reassign_shot_metadata(
        &mut self,
        source: SectionId,
        shot_id: u32,
        target: SectionId,
    ) -> Result<u32, String> {
        self.initialize_shot_graph()?;
        let shot = self
            .get_section(source)
            .and_then(|section| section.get_shot(shot_id))
            .ok_or("Source shot not found")?;
        let destination = self
            .get_section(target)
            .ok_or("Destination section not found")?;
        if destination
            .shots
            .iter()
            .any(|other| shot.uuid.is_some() && other.uuid == shot.uuid)
        {
            return Err("Destination already contains this shot UUID".into());
        }
        let next_id = destination
            .next_shot_id
            .checked_add(1)
            .ok_or("Destination internal shot IDs exhausted")?;
        let new_id = destination.next_shot_id;
        let number = shot.number.ok_or("Source has no permanent number")?;
        let reference = self.azimuth_reference_for_id(source);
        if !self.shot_graph.explicit {
            let positions: HashMap<_, _> = self.compute_station_positions().into_iter().collect();
            for section in &self.sections {
                for (index, shot) in section.shots.iter().enumerate() {
                    if let (Some(number), Some(position)) = (
                        shot.number,
                        positions.get(&StationRef::new(section.id, index as u32)),
                    ) {
                        self.shot_graph
                            .root_positions
                            .insert(number, (position.x, position.y));
                    }
                }
            }
        }
        let mut endpoints = Vec::new();
        self.for_each_station_ref(|_, key| {
            endpoints.push(
                self.resolve_key(&key)
                    .and_then(|station| self.endpoint_identity(station)),
            );
        });
        let section = self
            .get_section_mut(source)
            .ok_or("Source section not found")?;
        let position = section
            .shots
            .iter()
            .position(|shot| shot.id == shot_id)
            .ok_or("Source shot not found")?;
        let mut shot = section.shots.remove(position);
        shot.id = new_id;
        let destination = self
            .get_section_mut(target)
            .ok_or("Destination section not found")?;
        destination.next_shot_id = next_id;
        destination.shots.push(shot);
        self.shot_graph
            .azimuth_overrides
            .entry(number)
            .or_insert(reference);
        self.shot_graph.explicit = true;
        self.rebuild_shot_uuid_index();
        let remapped: Vec<_> = endpoints
            .into_iter()
            .map(|identity| {
                let (number, start) = identity?;
                self.endpoint_ref(number, start)
                    .and_then(|station| self.key_for_ref(station))
            })
            .collect();
        let mut next = remapped.into_iter();
        self.map_station_refs(|old| next.next().flatten().unwrap_or_else(|| old.clone()));
        self.touch();
        self.initialize_shot_graph()?;
        Ok(new_id)
    }
}

#[cfg(test)]
#[expect(
    clippy::unwrap_used,
    clippy::indexing_slicing,
    reason = "directed graph regression assertions"
)]
mod tests {
    use super::*;
    use crate::{SectionData, ShotData};

    fn project() -> Project {
        let mut project = Project::new("Directed survey".into(), None);
        for lengths in [vec![10.0, 20.0], vec![30.0]] {
            project.add_section(SectionData {
                shots: lengths
                    .into_iter()
                    .map(|length| ShotData {
                        length,
                        azimuth_in: 90.0,
                        azimuth_out: 90.0,
                        ..Default::default()
                    })
                    .collect(),
                ..Default::default()
            });
        }
        project.section_offsets.insert(1, (100.0, 0.0));
        project.initialize_shot_graph().unwrap();
        project
    }

    #[test]
    fn from_id_replaces_the_chain_across_sections_and_supports_branches() {
        let mut project = project();
        project.sections[0].shots[1].from_id = Some(3);
        project.shot_graph.explicit = true;
        project.initialize_shot_graph().unwrap();
        let coordinates: HashMap<_, _> = project.compute_station_positions().into_iter().collect();
        let begin = coordinates[&Project::shot_start_ref(0, 1)];
        let end = coordinates[&StationRef::new(0, 2)];
        assert!((begin.x - 130.0).abs() < 1e-9);
        assert!((end.x - 150.0).abs() < 1e-9);
        let stations = project.compute_station_coordinates();
        let origin = stations
            .iter()
            .position(|station| station.station_ref == StationRef::new(0, 0))
            .unwrap();
        let distances = project.compute_distances_from(&stations, &[origin]);
        let moved = stations
            .iter()
            .position(|station| station.station_ref == StationRef::new(0, 2))
            .unwrap();
        assert!(
            distances[moved].is_infinite(),
            "the replaced implicit edge must no longer exist"
        );
        project.sections[0].shots[0].from_id = Some(3);
        let positions: HashMap<_, _> = project.compute_station_positions().into_iter().collect();
        assert!((positions[&StationRef::new(0, 1)].x - 140.0).abs() < 1e-9);
        assert!((positions[&StationRef::new(0, 2)].x - 150.0).abs() < 1e-9);
    }

    #[test]
    fn explicit_none_inside_a_metadata_section_creates_a_detached_root() {
        let mut project = project();
        project.sections[0].shots[1].from_id = None;
        project.shot_graph.explicit = true;
        project.initialize_shot_graph().unwrap();
        let positions: HashMap<_, _> = project.compute_station_positions().into_iter().collect();
        assert!(positions.contains_key(&Project::shot_start_ref(0, 1)));
        assert!((positions[&StationRef::new(0, 2)].x - 30.0).abs() < 1e-9);
        assert!(project
            .shortest_path_shots_merges(StationRef::new(0, 0), StationRef::new(0, 2))
            .is_none());
    }
}
