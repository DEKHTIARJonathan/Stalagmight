//! Compatibility view for algorithms whose physical unit is a survey chain.
//! Every measurement is an ephemeral one-edge chain. Metadata groups never
//! become rigid bodies, and no native section/shot identifier is allocated.
use super::Project;
use crate::{ClosureStrategy, Section, Shot, Station, StationMerge, StationRef};
use std::collections::HashMap;

pub(super) struct GraphProjection {
    pub project: Project,
    pub to_logical: HashMap<StationRef, StationRef>,
    pub shots: HashMap<u32, (u32, usize)>,
}

fn physical_section(id: u32, source: &Section, shot: Option<Shot>) -> Section {
    Section {
        id,
        name: source.name.clone(),
        surveyor: source.surveyor.clone(),
        explorer: source.explorer.clone(),
        date: source.date,
        color: source.color.clone(),
        direction: source.direction,
        quality: source.quality,
        shots: shot.into_iter().collect(),
        next_shot_id: 0,
        reverse_parity: false,
        gauge_shot_uuid: None,
        gauge_neighbour_uuid: None,
        azimuth_reference: source.azimuth_reference,
    }
}

impl GraphProjection {
    pub(super) fn map_stations(&self, stations: Vec<Station>) -> Vec<Station> {
        let mut mapped = Vec::with_capacity(stations.len());
        for mut station in stations {
            let Some(reference) = self.to_logical.get(&station.station_ref).copied() else {
                continue;
            };
            station.station_ref = reference;
            station.merged_with = station
                .merged_with
                .into_iter()
                .filter_map(|reference| self.to_logical.get(&reference).copied())
                .collect();
            if let Some(closures) = station.closures_with.as_mut() {
                closures.retain_mut(|closure| {
                    if let Some(reference) = self.to_logical.get(&closure.station_ref) {
                        closure.station_ref = *reference;
                        true
                    } else {
                        false
                    }
                });
            }
            mapped.push(station);
        }
        mapped.sort_by_key(|station| {
            (
                station.station_ref.section_id,
                station.station_ref.station_index,
            )
        });
        mapped
    }
}

impl Project {
    /// Linear physical chains for formats whose section syntax encodes topology.
    /// Each chain keeps its original metadata group's descriptive fields.
    pub fn physical_shot_graph_for_export(&self) -> Result<Project, String> {
        if self.shot_graph.explicit {
            Ok(self.shot_graph_projection()?.project)
        } else {
            Ok(self.clone())
        }
    }

    pub(super) fn shot_graph_projection(&self) -> Result<GraphProjection, String> {
        let positions = self.shot_graph_positions();
        let mut projection = self.clone();
        projection.sections.clear();
        projection.section_offsets.clear();
        projection.station_offsets.clear();
        projection.station_comments.clear();
        projection.station_names.clear();
        projection.station_merges = Default::default();
        projection.zero_datums.clear();
        projection.loop_closures.clear();
        projection.shot_graph.explicit = false;
        let mut to_physical = HashMap::new();
        let mut to_logical = HashMap::new();
        let mut shots = HashMap::new();
        let mut ordered: Vec<_> = self
            .sections
            .iter()
            .flat_map(|section| {
                section
                    .shots
                    .iter()
                    .enumerate()
                    .map(move |(index, shot)| (section, index, shot))
            })
            .collect();
        ordered.sort_by_key(|(_, _, shot)| shot.number);
        for (source, index, shot) in ordered {
            let id = u32::try_from(projection.sections.len())
                .map_err(|_| "Too many graph measurements")?;
            let start = Self::shot_start_ref(source.id, index);
            let end = StationRef::new(source.id, index as u32 + 1);
            let mut section = physical_section(id, source, Some(shot.clone()));
            if let Some(number) = shot.number {
                section.azimuth_reference = Some(
                    self.shot_graph
                        .azimuth_overrides
                        .get(&number)
                        .copied()
                        .unwrap_or_else(|| self.azimuth_reference_for(source)),
                );
            }
            let coordinates = positions
                .get(&start)
                .ok_or("Graph START position is missing")?;
            let offset = self.station_offset_for_ref(start).unwrap_or_default();
            projection
                .section_offsets
                .insert(id, (coordinates.x - offset.0, coordinates.y - offset.1));
            projection.sections.push(section);
            for (logical, physical) in [
                (start, StationRef::new(id, 0)),
                (end, StationRef::new(id, 1)),
            ] {
                to_physical.insert(logical, physical);
                to_logical.insert(physical, logical);
            }
            shots.insert(id, (source.id, index));
        }
        for source in self
            .sections
            .iter()
            .filter(|section| section.shots.is_empty())
        {
            let id = u32::try_from(projection.sections.len())
                .map_err(|_| "Too many graph components")?;
            projection.sections.push(physical_section(id, source, None));
            projection
                .section_offsets
                .insert(id, self.section_offset(source.id));
            to_physical.insert(StationRef::new(source.id, 0), StationRef::new(id, 0));
            to_logical.insert(StationRef::new(id, 0), StationRef::new(source.id, 0));
        }
        projection.rebuild_section_index();
        projection.rebuild_shot_uuid_index();
        for datum in &self.zero_datums {
            if let Some(reference) = self
                .resolve_key(&datum.station_ref)
                .and_then(|reference| to_physical.get(&reference).copied())
            {
                if let Some(key) = projection.key_for_ref(reference) {
                    let mut datum = datum.clone();
                    datum.station_ref = key;
                    projection.zero_datums.push(datum);
                }
            }
        }
        for (key, value) in &self.station_offsets {
            if let Some(key) = self
                .resolve_key(key)
                .and_then(|reference| to_physical.get(&reference).copied())
                .and_then(|reference| projection.key_for_ref(reference))
            {
                projection.station_offsets.insert(key, *value);
            }
        }
        for (source, target) in [
            (&self.station_comments, &mut projection.station_comments),
            (&self.station_names, &mut projection.station_names),
        ] {
            for (key, value) in source {
                if let Some(reference) = self
                    .resolve_key(key)
                    .and_then(|reference| to_physical.get(&reference).copied())
                {
                    let anchor = if reference.station_index == 0 {
                        crate::StationAnchor::SectionStart
                    } else {
                        let shot = projection
                            .sections
                            .get(reference.section_id as usize)
                            .and_then(|section| section.shots.first())
                            .ok_or("Missing graph endpoint")?;
                        crate::StationAnchor::AfterShot(
                            shot.uuid.clone().ok_or("Missing graph shot UUID")?,
                        )
                    };
                    target.insert(
                        crate::StationKey::new(reference.section_id, anchor),
                        value.clone(),
                    );
                }
            }
        }
        // Disjoint sets of physical chains identify cycle-closing origin joins.
        let mut parents: Vec<usize> = (0..projection.sections.len()).collect();
        fn root(parents: &mut [usize], mut index: usize) -> usize {
            while parents[index] != index {
                let next = parents[index];
                parents[index] = parents[next];
                index = next;
            }
            index
        }
        let cuts = self.shot_graph_cycle_cuts();
        let (mut joins, cycle_joins): (Vec<_>, Vec<_>) = self
            .origin_station_links()
            .into_iter()
            .partition(|(start, _)| {
                self.endpoint_identity(*start)
                    .is_none_or(|(number, _)| !cuts.contains(&number))
            });
        joins.extend(self.station_merges.iter().filter_map(|merge| {
            Some((
                self.resolve_key(&merge.station_a)?,
                self.resolve_key(&merge.station_b)?,
            ))
        }));
        joins.extend(cycle_joins);
        let mut closing = Vec::new();
        for (a, b) in joins {
            let (Some(a), Some(b)) = (to_physical.get(&a).copied(), to_physical.get(&b).copied())
            else {
                continue;
            };
            if a == b {
                continue;
            }
            let ra = root(&mut parents, a.section_id as usize);
            let rb = root(&mut parents, b.section_id as usize);
            if ra == rb {
                closing.push((a, b));
                continue;
            }
            parents[rb] = ra;
            let station_a = projection
                .key_for_ref(a)
                .ok_or("Missing graph join endpoint")?;
            let station_b = projection
                .key_for_ref(b)
                .ok_or("Missing graph join endpoint")?;
            projection.station_merges.push(StationMerge {
                station_a,
                station_b,
                merged_at: self.created_at,
            });
        }
        for closure in &self.loop_closures {
            let a = self
                .resolve_key(&closure.station_a)
                .and_then(|reference| to_physical.get(&reference).copied());
            let b = self
                .resolve_key(&closure.station_b)
                .and_then(|reference| to_physical.get(&reference).copied());
            if let (Some(a), Some(b)) = (a, b) {
                let mut closure = closure.clone();
                closure.station_a = projection
                    .key_for_ref(a)
                    .ok_or("Missing closure endpoint")?;
                closure.station_b = projection
                    .key_for_ref(b)
                    .ok_or("Missing closure endpoint")?;
                projection.loop_closures.push(closure);
            }
        }
        for (a, b) in closing {
            if !projection.are_stations_merged(a, b) && !projection.are_stations_in_closure(a, b) {
                projection.create_loop_closure(a, b, ClosureStrategy::Batch)?;
            }
        }
        Ok(GraphProjection {
            project: projection,
            to_logical,
            shots,
        })
    }

    /// Reconcile real rigid joins without translating a metadata section as a body.
    pub fn reconcile_shot_graph(&mut self) -> Result<(), String> {
        let mut projection = self.shot_graph_projection()?;
        projection.project.resolve_offsets();
        let positions = projection.project.compute_station_positions();
        for (reference, coordinates) in positions {
            if reference.station_index != 0 {
                continue;
            }
            if let Some(&(section_id, index)) = projection.shots.get(&reference.section_id) {
                if let Some(number) = self
                    .get_section(section_id)
                    .and_then(|section| section.shots.get(index))
                    .and_then(|shot| shot.number)
                {
                    self.shot_graph
                        .root_positions
                        .insert(number, (coordinates.x, coordinates.y));
                }
            }
        }
        Ok(())
    }
}
