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
//! One degenerate case needs care: when the two readings are exactly 180
//! degrees apart the circular mean is undefined, and reciprocate-and-swap maps
//! the pair to itself - the shot would keep its old bearing while the rest of
//! the section turned around, moving the cave.  Such a pair is swapped instead,
//! which preserves both recorded values and flips the arbitrary tie-break that
//! [`average_azimuth`](crate::models::Shot::average_azimuth) resolves it with.
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

use std::collections::HashMap;

use crate::models::{SectionId, Shot, ShotData, StationKey, StationRef};

use super::Project;

/// Reciprocal of a forward azimuth, normalised to `[0, 360)`.
fn reciprocal(azimuth: f64) -> f64 {
    (azimuth + 180.0).rem_euclid(360.0)
}

/// True when reciprocating and swapping a shot's two readings would give the
/// same pair back, i.e. they are exactly 180 degrees apart.
///
/// `reciprocal` is an involution, so for such a pair `reciprocal(azimuth_out) ==
/// azimuth_in` and vice versa - the transform below would be a no-op and the
/// shot would keep pointing the original way while the rest of the section
/// turned around.
///
/// The comparison is deliberately exact. A pair that misses antipodal by even
/// one ulp has a well-defined circular mean and reciprocates correctly on its
/// own; only the precise degenerate case needs the fix-up, and treating a
/// near-antipodal pair as degenerate would give it the *wrong* bearing (the
/// swap-only branch preserves the mean instead of turning it around). Compared
/// through `to_bits` so this reads as "bit-exact by intent" rather than a
/// sloppy float `==`.
fn readings_are_antipodal(azimuth_in: f64, azimuth_out: f64) -> bool {
    (azimuth_out - azimuth_in).rem_euclid(360.0).to_bits() == 180.0_f64.to_bits()
}

/// Total local displacement of a run of shots: the local coordinate of the last
/// station, since station 0 sits at the local origin by definition.
///
/// This is what a reverse has to add to `section_offsets` to keep the cave
/// still - station 0 becomes the far end, so the anchor moves by the span the
/// section used to cover. Shared by the in-app reverse and the import-time
/// toggle so the two placements can never disagree.
pub fn shot_run_displacement(shots: &[ShotData]) -> (f64, f64) {
    let (mut dx, mut dy) = (0.0_f64, 0.0_f64);
    for shot in shots {
        let azimuth_rad = shot.average_azimuth().to_radians();
        let horizontal = shot.horizontal_length();
        dx += horizontal * azimuth_rad.sin();
        dy += horizontal * azimuth_rad.cos();
    }
    (dx, dy)
}

/// Re-associate one shot's readings with the opposite direction of travel.
///
/// Reverses the whole vec of shots as well, so the caller gets a section that
/// is fully reversed.  This is THE reverse transform: both the in-app action
/// ([`Project::reverse_section`]) and the import-time toggle route through it,
/// so the two can never drift apart.
///
/// Order-independent per shot, so it is safe to apply before or after the vec
/// is reversed.  Applying it twice is the identity in exact arithmetic; in f64
/// the `(az + 180) % 360` round trip can land a couple of ulps off when the
/// shifted value is not representable, which is why undo snapshots instead of
/// re-running the transform.
pub fn reverse_shots(shots: &mut [ShotData], swap_lr: bool) {
    shots.reverse();
    for shot in shots.iter_mut() {
        if readings_are_antipodal(shot.azimuth_in, shot.azimuth_out) {
            // Degenerate pair: the two readings disagree by a full 180 degrees,
            // so the circular mean is undefined and reciprocate-and-swap is the
            // identity.  Swapping the readings instead keeps both values exactly
            // as recorded - they are the same two numbers either way - while
            // flipping which one `average_azimuth` measures its ±180 tie-break
            // from, which is what actually turns the bearing around.  Still an
            // involution, so the round-trip guarantee holds.
            std::mem::swap(&mut shot.azimuth_in, &mut shot.azimuth_out);
        } else {
            let azimuth_in = shot.azimuth_in;
            shot.azimuth_in = reciprocal(shot.azimuth_out);
            shot.azimuth_out = reciprocal(azimuth_in);
        }

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
    /// Involutive up to floating point: every step is a swap, a negation or the
    /// 180-degree turn, so `reverse_section(id, s)` twice restores the original
    /// section - but `(az + 180) % 360` is only *bit*-exact when both the shifted
    /// value and the wrap are representable (e.g. `17.5 -> 197.5 -> 17.5`; `0.1`
    /// comes back a couple of ulps out).  Undo therefore snapshots rather than
    /// re-running the transform - see `AppState::generate_undo_data`.
    pub fn reverse_section(&mut self, section_id: SectionId, swap_lr: bool) -> bool {
        let Some(section) = self.get_section(section_id) else {
            return false;
        };
        let shot_count = section.shots.len();
        if shot_count == 0 {
            return true;
        }

        // Every mirrored station has to be re-keyable, and an `AfterShot` anchor
        // needs the shot's uuid.  A pre-v6 .stalx loaded without uuids would
        // leave `key_for_ref` returning None for the mirrored station, and the
        // write pass below would silently keep the pre-reverse key - parking a
        // merge, datum or comment on the wrong physical end.  Mint the missing
        // ones up front instead; load already does this, so this is belt-and-
        // braces for any path that didn't.  Section-scoped: only this section's
        // anchors are rebuilt below, and a multi-section reverse runs one
        // `ReverseSection` per section.
        self.ensure_section_shot_uuids(section_id);

        // ---- Read pass, before anything moves -------------------------------
        // Station `i` of this section becomes station `shot_count - i`.  Resolve
        // every stored key now, while the old order is still in place; the write
        // pass below rebuilds them from the mirrored indices.
        //
        // Keyed by the stored key rather than by traversal position: the read pass
        // walks `for_each_station_ref` and the write pass walks `map_station_refs`,
        // and the two rebuild the offset/comment HashMaps from independent
        // iterations, so pairing them by index would depend on `keys()` and
        // `into_iter()` agreeing on order.  A key visited twice (two merges can
        // share a station) mirrors to the same index either way.
        let mirrored: HashMap<StationKey, u32> = {
            let mut out: HashMap<StationKey, u32> = HashMap::new();
            self.for_each_station_ref(|_label, key| {
                if key.section_id != section_id || out.contains_key(&key) {
                    return;
                }
                if let Some(sr) = self.resolve_key(&key) {
                    out.insert(key, shot_count as u32 - sr.station_index);
                }
            });
            out
        };

        let Some(section) = self.get_section(section_id) else {
            return false;
        };

        // Ids belong to positions, not records: the shot that was 1 becomes N.
        // Identity (uuid) travels with the record instead, so collab reconcile
        // sees moved shots rather than a wholesale delete+add.
        let ids: Vec<_> = section.shots.iter().map(|s| s.id).collect();
        let uuids: Vec<_> = section.shots.iter().map(|s| s.uuid.clone()).collect();
        let mut data: Vec<ShotData> = section.shots.iter().map(Shot::to_shot_data).collect();

        // Measured on the PRE-reverse order, so it is the offset the anchor has
        // to gain below once station 0 becomes the far end.
        let (dx, dy) = shot_run_displacement(&data);

        // ---- Mutate the shots ----------------------------------------------
        reverse_shots(&mut data, swap_lr);
        let Some(section) = self.get_section_mut(section_id) else {
            return false;
        };

        // `uuids` is still in the OLD order, and so is `data` after the reverse
        // put record i at position count-1-i - zip them by walking the uuids
        // backwards alongside the reversed data.
        section.shots = data
            .into_iter()
            .zip(uuids.into_iter().rev())
            .zip(ids)
            .map(|((d, uuid), id)| Shot::with_uuid(id, d, uuid))
            .collect();

        // Every shot in this section moved, so every cached `(section_id, uuid) ->
        // index` entry for it is stale.  A stale entry is only a slow path (
        // `resolve_key` re-checks and rescans), but the reverse invalidated all of
        // them at once - re-index the one section rather than leave every later
        // merge/closure/datum/comment lookup on the O(shots) fallback.
        self.reindex_section_shot_uuids(section_id);

        // ---- Keep the section where it was ----------------------------------
        // Station 0 is now the far end, so the anchor moves by the displacement
        // the section used to span.
        if dx != 0.0 || dy != 0.0 {
            self.adjust_section_offset(section_id, dx, dy);
        }

        // ---- Write pass: mirror the external refs ---------------------------
        let rebuilt: HashMap<StationKey, StationKey> = mirrored
            .into_iter()
            .filter_map(|(old, index)| {
                let next = self.key_for_ref(StationRef::new(section_id, index));
                // `ensure_section_shot_uuids` above guarantees every `AfterShot`
                // anchor can be built, so a ref we mirrored must be re-keyable.
                // If that ever stops holding, the key is left untouched below -
                // and it now names the OPPOSITE physical station - so trip loudly
                // in dev rather than silently misplacing the relationship.
                debug_assert!(
                    next.is_some(),
                    "reverse_section: station ref in section {section_id} mirrored \
                     to station {index} but could not be re-keyed - it would \
                     silently stay on its pre-reverse station"
                );
                next.map(|n| (old, n))
            })
            .collect();
        self.map_station_refs(|key| rebuilt.get(&key).cloned().unwrap_or(key));

        // Reconcile matches a returned shot to its baseline entry by UUID but
        // applies the edit to `shots[entry.shot_index]`, and the reverse just
        // permuted every index in this section.  Until the next save re-exports
        // the sibling `.tml`, a collaborator's edit would land on the mirrored
        // shot - drop the baseline so the reconcile is deferred, not misapplied.
        self.invalidate_collab_baseline();

        self.touch();
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
    ///
    /// Deliberately routed through the production walk rather than a local copy
    /// of `offset + sum(horizontal * sin/cos(average_azimuth))`: these tests exist
    /// to catch the reverse and the coordinate pipeline disagreeing, and a private
    /// re-implementation would keep passing if both drifted the same way.
    fn world_coords(project: &Project, section_id: SectionId) -> Vec<(f64, f64)> {
        let station_count = project.get_section(section_id).unwrap().shots.len() + 1;
        (0..station_count)
            .map(|i| {
                project
                    .compute_station_raw_xy(StationRef::new(section_id, i as u32))
                    .unwrap()
            })
            .collect()
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

    /// Bit-exact round trip, which holds only because every azimuth here survives
    /// `(az + 180) % 360` exactly (17.5 -> 197.5 -> 17.5, 359 -> 179 -> 359,
    /// 210.25 -> 30.25 -> 210.25). That is the common case, not a guarantee - see
    /// [`reverse_of_an_unrepresentable_azimuth_round_trips_to_within_an_ulp`] for
    /// the general one, and `AppState::generate_undo_data` for why undo snapshots
    /// instead of re-running the transform.
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

    /// The involution is exact in real arithmetic but not in f64: `0.1 + 180`
    /// rounds, and the `% 360` wrap on the way back cannot undo that, so the
    /// azimuth returns 2e-14 off. Pinned because the codebase relies on it in two
    /// places - undo snapshots the project instead of re-running the reverse, and
    /// nothing may promote "involutive" to "bit-exact".
    #[test]
    fn reverse_of_an_unrepresentable_azimuth_round_trips_to_within_an_ulp() {
        let (mut project, id) = project_with_shots(vec![shot(0.1, 10.0, 0.0, 0.0)]);

        assert!(project.reverse_section(id, false));
        assert!(project.reverse_section(id, false));

        let azimuth = project.get_section(id).unwrap().shots[0].azimuth_in;
        assert!(
            (azimuth - 0.1).abs() < 1e-9,
            "round trip drifted more than a rounding error: {azimuth}"
        );
        assert_ne!(
            azimuth, 0.1,
            "if this is now bit-exact the reciprocal changed - revisit the doc \
             comments that say the round trip is only exact for representable \
             shifts, and undo_capture's reason for snapshotting"
        );
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

    /// Readings exactly 180 degrees apart have an undefined circular mean, and
    /// reciprocate-and-swap maps such a pair to itself.  Without the swap
    /// fix-up the shot keeps its original bearing while every other shot turns
    /// around, so the offset compensation no longer cancels and the passage
    /// jumps - the one way a reverse can move the cave.
    #[test]
    fn reverse_turns_around_a_shot_whose_readings_are_exactly_opposite() {
        let mut data = shot(0.0, 10.0, 0.0, 0.0);
        data.azimuth_in = 30.0;
        data.azimuth_out = 210.0;
        let (mut project, id) = project_with_shots(vec![data]);

        let before = project.get_section(id).unwrap().shots[0].average_azimuth();
        let world_before = world_coords(&project, id);

        assert!(project.reverse_section(id, false));

        let after = project.get_section(id).unwrap().shots[0].average_azimuth();
        assert!(
            (after - reciprocal(before)).abs() < 1e-9,
            "bearing did not turn around: {before} -> {after}"
        );

        // Both readings are still on the record, just the other way round.
        let s = &project.get_section(id).unwrap().shots[0];
        assert_eq!(s.azimuth_in, 210.0);
        assert_eq!(s.azimuth_out, 30.0);

        // And the whole point: the cave stayed put.
        let mut reversed = world_coords(&project, id);
        reversed.reverse();
        assert_coords_close(&world_before, &reversed);
    }

    #[test]
    fn reverse_of_opposite_readings_is_still_an_involution() {
        let mut data = shot(0.0, 10.0, 0.0, 0.0);
        data.azimuth_in = 30.0;
        data.azimuth_out = 210.0;
        let (mut project, id) = project_with_shots(vec![data]);

        assert!(project.reverse_section(id, false));
        assert!(project.reverse_section(id, false));

        let s = &project.get_section(id).unwrap().shots[0];
        assert_eq!(s.azimuth_in, 30.0);
        assert_eq!(s.azimuth_out, 210.0);
    }

    /// A near-antipodal pair is NOT degenerate - its mean is well defined, so it
    /// must take the ordinary reciprocate-and-swap path.  Guards against
    /// widening the exact test above into an epsilon window, which would give
    /// these shots the wrong bearing.
    #[test]
    fn reverse_treats_near_opposite_readings_normally() {
        let mut data = shot(0.0, 10.0, 0.0, 0.0);
        data.azimuth_in = 30.0;
        data.azimuth_out = 209.5;
        let (mut project, id) = project_with_shots(vec![data]);

        let before = project.get_section(id).unwrap().shots[0].average_azimuth();
        assert!(project.reverse_section(id, false));
        let after = project.get_section(id).unwrap().shots[0].average_azimuth();

        assert!(
            (after - reciprocal(before)).abs() < 1e-9,
            "bearing did not turn around: {before} -> {after}"
        );
    }

    /// Pre-v6 sections can carry `uuid: None` shots.  Without minting uuids
    /// first, the mirrored station has no `AfterShot` anchor, `key_for_ref`
    /// returns None and the write pass keeps the pre-reverse key - leaving the
    /// comment on the opposite physical end.
    #[test]
    fn reverse_remaps_refs_even_when_shots_arrive_without_uuids() {
        let (mut project, id) =
            project_with_shots(vec![shot(0.0, 10.0, 0.0, 0.0), shot(90.0, 10.0, 0.0, 0.0)]);

        // A comment on station 0, then strip the uuids the way a pre-v6 load would.
        let start = project.key_for_ref(StationRef::new(id, 0)).unwrap();
        project
            .station_comments
            .insert(start, "at the entrance".to_string());
        for shot in &mut project.get_section_mut(id).unwrap().shots {
            shot.uuid = None;
        }

        assert!(project.reverse_section(id, false));

        // Station 0 became station 2, and the comment went with it.
        let at = |index: u32| {
            project
                .station_comments
                .iter()
                .find(|(k, _)| project.resolve_key(k) == Some(StationRef::new(id, index)))
                .map(|(_, v)| v.as_str())
        };
        assert_eq!(at(2), Some("at the entrance"));
        assert_eq!(at(0), None);
    }

    /// Every other mutating `Project` method stamps `modified_at`; without it a
    /// reverse saves a project that still reports the previous session's edit time,
    /// so the recent-projects list and any "changed since?" check read it as
    /// untouched.
    #[test]
    fn reverse_marks_the_project_modified() {
        let (mut project, id) = project_with_shots(vec![shot(0.0, 10.0, 0.0, 0.0)]);
        let before = project.modified_at;

        assert!(project.reverse_section(id, false));

        assert!(
            project.modified_at > before,
            "reverse must touch the project: {before} -> {}",
            project.modified_at
        );
    }

    /// A missing section and an empty section both leave the project alone, so
    /// neither may stamp `modified_at` - an empty section reverses to itself.
    #[test]
    fn reverse_of_a_noop_does_not_mark_the_project_modified() {
        let (mut project, id) = project_with_shots(vec![]);
        let before = project.modified_at;

        assert!(project.reverse_section(id, false));
        assert!(!project.reverse_section(9999, false));

        assert_eq!(project.modified_at, before);
    }

    /// The reverse permutes every shot index in the section, so every cached
    /// `(section_id, uuid) -> index` entry is wrong afterwards. Stale entries are
    /// only a slow path (`resolve_key` rescans), so this asserts the cache itself
    /// rather than a behaviour change.
    #[test]
    fn reverse_refreshes_the_sections_shot_uuid_index() {
        let (mut project, id) = project_with_shots(vec![
            shot(0.0, 1.0, 0.0, 0.0),
            shot(0.0, 2.0, 0.0, 0.0),
            shot(0.0, 3.0, 0.0, 0.0),
        ]);
        project.rebuild_shot_uuid_index();
        let first_uuid = project.get_section(id).unwrap().shots[0].uuid.clone().unwrap();

        assert!(project.reverse_section(id, false));

        // The record that was at index 0 is now last.
        assert_eq!(
            project.shot_uuid_index.get(&(id, first_uuid.clone())),
            Some(&2),
            "the uuid index must follow the record to its mirrored position"
        );
        // And the cache still agrees with the cold scan for every shot.
        for (i, shot) in project.get_section(id).unwrap().shots.iter().enumerate() {
            let uuid = shot.uuid.clone().unwrap();
            assert_eq!(project.shot_uuid_index.get(&(id, uuid)), Some(&(i as u32)));
        }
    }

    /// The collab baseline's identity key is `(section_id, shot_index)`; a reverse
    /// invalidates every one of this section's slots at once. Reconcile matches by
    /// UUID but *applies* by that index, so a collaborator's edit arriving before
    /// the next save would overwrite the mirrored shot. Dropping the baseline
    /// defers the reconcile until the next export re-seeds it.
    #[test]
    fn reverse_invalidates_a_stale_collab_baseline() {
        use crate::models::{CollabState, ShotBaselineEntry};

        let (mut project, id) = project_with_shots(vec![
            shot(0.0, 1.0, 0.0, 0.0),
            shot(90.0, 2.0, 0.0, 0.0),
        ]);
        let uuid = project.get_section(id).unwrap().shots[0].uuid.clone().unwrap();
        project.collab = Some(CollabState {
            enabled: true,
            sibling_tml_relative: "sibling.tml".to_string(),
            last_export_tml_sha256: Some("deadbeef".to_string()),
            shot_baseline: vec![ShotBaselineEntry {
                section_id: id,
                shot_index: 0,
                ariane_id: 1,
                uuid,
                geo_key: String::new(),
                section_name: String::new(),
                station_comment: None,
            }],
            section_name_map: Vec::new(),
            synthetic_section_names: Vec::new(),
            last_reconcile_at: None,
            write_tml_on_autosave: true,
        });

        assert!(project.reverse_section(id, false));

        let collab = project.collab.as_ref().unwrap();
        assert!(
            collab.shot_baseline.is_empty(),
            "a reverse must drop the index-keyed baseline"
        );
        assert_eq!(
            collab.last_export_tml_sha256, None,
            "the sha must go too, or the next open sees the sibling as unchanged"
        );
        assert!(collab.enabled, "collab itself stays on");
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
