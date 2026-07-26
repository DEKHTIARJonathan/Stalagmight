//! Reversing a section end-to-end (issue #24).
//!
//! The operation flips which physical end of a section is station 0 **without
//! moving the cave**: after a reverse every station keeps the exact world
//! coordinate it had before, and only the numbering direction changes.
//!
//! Preserving geometry takes more than reversing the shot vec.  A shot's
//! bearing is the circular mean of its two *forward* readings
//! ([`Shot::average_azimuth`](crate::models::Shot::average_azimuth)) -
//! `azimuth_in`/`azimuth_out` are not a
//! foresight/backsight pair - so merely swapping them is a no-op and would
//! leave every bearing pointing the original way.  Walking the reversed chain
//! then produces the same two endpoints (vector addition commutes) but a
//! different polyline in between.  Each shot must therefore be *reciprocated*:
//!
//! | field                    | operation                        |
//! |--------------------------|----------------------------------|
//! | shot order               | reversed; ids stay with positions |
//! | `azimuth_in`             | `(old azimuth_out + 180) % 360`  |
//! | `azimuth_out`            | `(old azimuth_in + 180) % 360`   |
//! | `depth_in` / `depth_out` | swapped                          |
//! | `pitch_in` / `pitch_out` | swapped **and negated**          |
//! | `left` / `right`         | swapped only when `swap_lr`      |
//! | everything else          | travels with its record          |
//!
//! Two things outside the shot vec also move:
//!
//! * **The section anchor.** `section_offsets` positions station 0, which is
//!   now the opposite physical end, so the offset gains the section's old
//!   total displacement or the whole section teleports.
//! * **External station refs.** Merges, loop closures, zero datums, station
//!   offsets and station comments are stored as anchor-based
//!   [`StationKey`](crate::models::StationKey)s.
//!   They still *resolve* after a reverse (UUIDs travel with their records),
//!   but to a different physical station - a zero datum on station 0 would end
//!   up pinning the far end.  Each key in the reversed section is remapped to
//!   its mirrored station so every relationship stays where the surveyor put
//!   it.

use crate::models::{SectionId, Shot, ShotData, StationRef};

use super::Project;

/// Reciprocal of a forward azimuth, normalised to `[0, 360)`.
fn reciprocal(azimuth: f64) -> f64 {
    (azimuth + 180.0).rem_euclid(360.0)
}

/// Re-associate one shot's readings with the opposite direction of travel.
///
/// Reverses the whole vec of shots as well, so the caller gets a section that
/// is fully reversed.  This is THE reverse transform: both the in-app action
/// ([`Project::reverse_section`]) and the import-time toggle route through it,
/// so the two can never drift apart.
///
/// Order-independent per shot, so it is safe to apply before or after the vec
/// is reversed - and applying it twice is the identity.
pub fn reverse_shots(shots: &mut [ShotData], swap_lr: bool) {
    shots.reverse();
    for shot in shots.iter_mut() {
        let azimuth_in = shot.azimuth_in;
        shot.azimuth_in = reciprocal(shot.azimuth_out);
        shot.azimuth_out = reciprocal(azimuth_in);

        std::mem::swap(&mut shot.depth_in, &mut shot.depth_out);

        // Pitch is signed slope, so reversing the traverse flips it as well as
        // re-associating it with the other end.
        let pitch_in = shot.pitch_in.map(|p| -p);
        shot.pitch_in = shot.pitch_out.map(|p| -p);
        shot.pitch_out = pitch_in;

        if swap_lr {
            std::mem::swap(&mut shot.left, &mut shot.right);
        }
    }
}

impl Project {
    /// Reverse `section_id` end-to-end, preserving every station's world
    /// coordinate.  `swap_lr` also mirrors the `left`/`right` passage
    /// dimensions (the user is now facing the other way); it is opt-in because
    /// whether LRUD was recorded facing along travel is a survey convention we
    /// cannot infer.
    ///
    /// Returns `false` if the section does not exist.  A section with no shots
    /// is a single station and reverses to itself.
    ///
    /// Involutive: `reverse_section(id, s)` twice restores the original section
    /// exactly (`reciprocal` is exact for the 180-degree turn, and every other
    /// step is a swap or a negation).
    pub fn reverse_section(&mut self, section_id: SectionId, swap_lr: bool) -> bool {
        let Some(section) = self.get_section(section_id) else {
            return false;
        };
        let shot_count = section.shots.len();
        if shot_count == 0 {
            return true;
        }

        // ---- Read pass, before anything moves -------------------------------
        // Station `i` of this section becomes station `shot_count - i`.  Resolve
        // every stored key now, while the old order is still in place; the write
        // pass below rebuilds them from the mirrored indices.
        let mirrored: Vec<Option<u32>> = {
            let mut out = Vec::new();
            self.for_each_station_ref(|_label, key| {
                let mirror = if key.section_id == section_id {
                    self.resolve_key(&key)
                        .map(|sr| shot_count as u32 - sr.station_index)
                } else {
                    None
                };
                out.push(mirror);
            });
            out
        };

        // The section's total local displacement, i.e. the local coordinate of
        // the last station (station 0 sits at the local origin by definition).
        let (mut dx, mut dy) = (0.0_f64, 0.0_f64);
        for shot in &section.shots {
            let azimuth_rad = shot.average_azimuth().to_radians();
            let horizontal = shot.horizontal_length();
            dx += horizontal * azimuth_rad.sin();
            dy += horizontal * azimuth_rad.cos();
        }

        // ---- Mutate the shots ----------------------------------------------
        let Some(section) = self.get_section_mut(section_id) else {
            return false;
        };

        // Ids belong to positions, not records: the shot that was 1 becomes N.
        // Identity (uuid) travels with the record instead, so collab reconcile
        // sees moved shots rather than a wholesale delete+add.
        let ids: Vec<_> = section.shots.iter().map(|s| s.id).collect();
        let uuids: Vec<_> = section.shots.iter().map(|s| s.uuid.clone()).collect();

        let mut data: Vec<ShotData> = section.shots.iter().map(Shot::to_shot_data).collect();
        reverse_shots(&mut data, swap_lr);

        // `uuids` is still in the OLD order, and so is `data` after the reverse
        // put record i at position count-1-i - zip them by walking the uuids
        // backwards alongside the reversed data.
        section.shots = data
            .into_iter()
            .zip(uuids.into_iter().rev())
            .zip(ids)
            .map(|((d, uuid), id)| Shot::with_uuid(id, d, uuid))
            .collect();

        // ---- Keep the section where it was ----------------------------------
        // Station 0 is now the far end, so the anchor moves by the displacement
        // the section used to span.
        if dx != 0.0 || dy != 0.0 {
            self.adjust_section_offset(section_id, dx, dy);
        }

        // ---- Write pass: mirror the external refs ---------------------------
        let mut i = 0;
        let mut rebuilt = Vec::with_capacity(mirrored.len());
        for mirror in &mirrored {
            rebuilt.push(
                mirror.and_then(|index| self.key_for_ref(StationRef::new(section_id, index))),
            );
        }
        self.map_station_refs(|key| {
            let next = rebuilt.get(i).cloned().flatten();
            i += 1;
            next.unwrap_or(key)
        });
        debug_assert_eq!(
            i,
            mirrored.len(),
            "reverse_section: map_station_refs visited a different number of refs \
             than for_each_station_ref produced - station-ref traversal order \
             diverged between the read and write passes"
        );

        true
    }
}

#[cfg(test)]
#[expect(
    clippy::unwrap_used,
    clippy::indexing_slicing,
    clippy::float_cmp,
    reason = "test module: panics on a failed assumption are the point"
)]
mod tests {
    use super::*;
    use crate::models::{SectionData, ShotData};

    fn shot(azimuth: f64, length: f64, depth_in: f64, depth_out: f64) -> ShotData {
        ShotData {
            azimuth_in: azimuth,
            azimuth_out: azimuth,
            length,
            depth_in,
            depth_out,
            ..Default::default()
        }
    }

    fn project_with_shots(shots: Vec<ShotData>) -> (Project, SectionId) {
        let mut project = Project::new("t".to_string(), None);
        let section = project.add_section(SectionData {
            name: None,
            surveyor: None,
            date: None,
            color: "#ffffff".to_string(),
            direction: None,
            quality: 1.0,
            shots,
        });
        let id = section.id;
        project.ensure_shot_uuids();
        (project, id)
    }

    /// World coordinates of every station in `section_id`, in station order.
    fn world_coords(project: &Project, section_id: SectionId) -> Vec<(f64, f64)> {
        let (ox, oy) = project.section_offset(section_id);
        let section = project.get_section(section_id).unwrap();
        let mut out = vec![(ox, oy)];
        let (mut x, mut y) = (ox, oy);
        for shot in &section.shots {
            let azimuth_rad = shot.average_azimuth().to_radians();
            let horizontal = shot.horizontal_length();
            x += horizontal * azimuth_rad.sin();
            y += horizontal * azimuth_rad.cos();
            out.push((x, y));
        }
        out
    }

    fn assert_coords_close(a: &[(f64, f64)], b: &[(f64, f64)]) {
        assert_eq!(a.len(), b.len(), "station count changed");
        for (i, (p, q)) in a.iter().zip(b).enumerate() {
            assert!(
                (p.0 - q.0).abs() < 1e-9 && (p.1 - q.1).abs() < 1e-9,
                "station {i} moved: {p:?} -> {q:?}"
            );
        }
    }

    #[test]
    fn reverse_preserves_every_station_world_coordinate() {
        let (mut project, id) = project_with_shots(vec![
            shot(0.0, 10.0, 0.0, 2.0),
            shot(90.0, 5.0, 2.0, 2.0),
            shot(210.0, 7.5, 2.0, 1.0),
        ]);

        let before = world_coords(&project, id);
        assert!(project.reverse_section(id, false));
        let after = world_coords(&project, id);

        // Same physical stations, walked from the other end.
        let mut reversed = after;
        reversed.reverse();
        assert_coords_close(&before, &reversed);
    }

    #[test]
    fn reverse_is_an_involution() {
        let (mut project, id) = project_with_shots(vec![
            shot(17.5, 10.0, 0.0, 2.0),
            shot(359.0, 5.0, 2.0, 2.0),
            shot(210.25, 7.5, 2.0, 1.0),
        ]);
        let original = project.get_section(id).unwrap().clone();

        assert!(project.reverse_section(id, true));
        assert!(project.reverse_section(id, true));

        let round_tripped = project.get_section(id).unwrap();
        assert_eq!(round_tripped.shots.len(), original.shots.len());
        for (a, b) in round_tripped.shots.iter().zip(&original.shots) {
            assert_eq!(a.id, b.id);
            assert_eq!(a.uuid, b.uuid);
            assert_eq!(a.azimuth_in, b.azimuth_in);
            assert_eq!(a.azimuth_out, b.azimuth_out);
            assert_eq!(a.depth_in, b.depth_in);
            assert_eq!(a.depth_out, b.depth_out);
            assert_eq!(a.pitch_in, b.pitch_in);
            assert_eq!(a.pitch_out, b.pitch_out);
            assert_eq!(a.left, b.left);
            assert_eq!(a.right, b.right);
        }
    }

    #[test]
    fn reverse_swaps_azimuth_reciprocally_not_positionally() {
        // The regression this guards: swapping azimuth_in/out alone leaves
        // average_azimuth untouched, so the section would keep its old bearings.
        let (mut project, id) = project_with_shots(vec![shot(90.0, 10.0, 0.0, 0.0)]);
        let before = project.get_section(id).unwrap().shots[0].average_azimuth();

        assert!(project.reverse_section(id, false));

        let after = project.get_section(id).unwrap().shots[0].average_azimuth();
        assert!(
            (after - 270.0).abs() < 1e-9,
            "expected reciprocal bearing 270, got {after}"
        );
        assert!((before - 90.0).abs() < 1e-9);
    }

    #[test]
    fn reverse_swaps_depths_and_negates_pitch() {
        let mut data = shot(0.0, 10.0, 1.0, 4.0);
        data.pitch_in = Some(30.0);
        data.pitch_out = Some(-10.0);
        let (mut project, id) = project_with_shots(vec![data]);

        assert!(project.reverse_section(id, false));

        let s = &project.get_section(id).unwrap().shots[0];
        assert_eq!(s.depth_in, 4.0);
        assert_eq!(s.depth_out, 1.0);
        assert_eq!(s.pitch_in, Some(10.0));
        assert_eq!(s.pitch_out, Some(-30.0));
    }

    #[test]
    fn reverse_swaps_left_right_only_when_opted_in() {
        let mut data = shot(0.0, 10.0, 0.0, 0.0);
        data.left = Some(1.0);
        data.right = Some(4.0);
        data.up = Some(2.0);
        data.down = Some(3.0);

        let (mut project, id) = project_with_shots(vec![data.clone()]);
        assert!(project.reverse_section(id, false));
        let kept = &project.get_section(id).unwrap().shots[0];
        assert_eq!(kept.left, Some(1.0));
        assert_eq!(kept.right, Some(4.0));

        let (mut project, id) = project_with_shots(vec![data]);
        assert!(project.reverse_section(id, true));
        let swapped = &project.get_section(id).unwrap().shots[0];
        assert_eq!(swapped.left, Some(4.0));
        assert_eq!(swapped.right, Some(1.0));
        // Up/down are absolute and never mirror.
        assert_eq!(swapped.up, Some(2.0));
        assert_eq!(swapped.down, Some(3.0));
    }

    #[test]
    fn reverse_moves_ids_to_mirrored_positions() {
        let (mut project, id) = project_with_shots(vec![
            shot(0.0, 1.0, 0.0, 0.0),
            shot(0.0, 2.0, 0.0, 0.0),
            shot(0.0, 3.0, 0.0, 0.0),
        ]);
        let ids: Vec<_> = project
            .get_section(id)
            .unwrap()
            .shots
            .iter()
            .map(|s| s.id)
            .collect();

        assert!(project.reverse_section(id, false));

        let section = project.get_section(id).unwrap();
        // Ids stay ascending by position, records moved under them.
        assert_eq!(
            section.shots.iter().map(|s| s.id).collect::<Vec<_>>(),
            ids,
            "shot ids should stay attached to positions"
        );
        // The 3m shot was last and is now first.
        assert_eq!(section.shots[0].length, 3.0);
    }

    #[test]
    fn reverse_keeps_external_refs_on_their_physical_station() {
        let (mut project, id) =
            project_with_shots(vec![shot(0.0, 10.0, 0.0, 0.0), shot(90.0, 10.0, 0.0, 0.0)]);

        // A comment on station 0 and one on station 1 (the middle).
        let start = project.key_for_ref(StationRef::new(id, 0)).unwrap();
        let middle = project.key_for_ref(StationRef::new(id, 1)).unwrap();
        project
            .station_comments
            .insert(start, "at the entrance".to_string());
        project
            .station_comments
            .insert(middle, "at the bend".to_string());

        let world_before = world_coords(&project, id);
        assert!(project.reverse_section(id, false));
        let world_after = world_coords(&project, id);

        // Station i became station N - i, and nothing physically moved.
        let mut reversed = world_after;
        reversed.reverse();
        assert_coords_close(&world_before, &reversed);

        // The entrance comment now lives on station 2, the bend still on 1 -
        // both are the same physical places as before.
        let at = |index: u32| {
            project
                .station_comments
                .iter()
                .find(|(k, _)| project.resolve_key(k) == Some(StationRef::new(id, index)))
                .map(|(_, v)| v.as_str())
        };
        assert_eq!(at(2), Some("at the entrance"));
        assert_eq!(at(1), Some("at the bend"));
        assert_eq!(at(0), None);
    }

    #[test]
    fn reverse_of_empty_section_is_a_noop() {
        let (mut project, id) = project_with_shots(vec![]);
        assert!(project.reverse_section(id, false));
        assert!(project.get_section(id).unwrap().shots.is_empty());
    }

    #[test]
    fn reverse_of_missing_section_fails() {
        let (mut project, _) = project_with_shots(vec![]);
        assert!(!project.reverse_section(9999, false));
    }
}
