//! Plan segments and the DPV range cap (#317) - the pure, graph-free half of scooter support.
//!
//! The engine proper ([`super`]) owns the graph walk; everything here is arithmetic over the
//! plan's own inputs, which is what keeps it testable without building a project.

use crate::config::DpvRig;

use super::model::PlanSegment;

/// Normalise the diver's segment list to exactly one entry per route span.
///
/// A plan has `waypoint_count + 1` spans (origin → W0 → … → open-field tail). The stored list can
/// disagree - a hand-edited `.plnx`, or a stale plan loaded after way points were added or removed
/// in Survey - so this is the single place that reconciles it. Missing entries take the default
/// speed and no scooter, which is **exactly the pre-#317 behaviour**: with an empty list every span
/// is priced at the config speed, so the whole feature is inert until a segment is edited.
///
/// A non-finite or non-positive speed also falls back to the default rather than being rejected:
/// it would otherwise divide into the edge cost and poison the field with `+Inf`/`NaN`, and the
/// config boundary guards the default for exactly that reason.
///
/// `has_rig` gates `on_scooter`. Without a rig there is no range to spend and no drop to derive, so
/// a leftover flag would report a scootered distance the plan cannot be held to. The segment's
/// *speed* still applies - variable pace is useful with or without a scooter.
pub(super) fn resolve_segments(
    segments: &[PlanSegment],
    waypoint_count: usize,
    default_speed: f64,
    has_rig: bool,
) -> Vec<PlanSegment> {
    (0..=waypoint_count)
        .map(|k| {
            let seg = segments.get(k);
            PlanSegment {
                speed_m_per_min: seg
                    .map(|s| s.speed_m_per_min)
                    .filter(|s| s.is_finite() && *s > 0.0)
                    .unwrap_or(default_speed),
                on_scooter: has_rig && seg.is_some_and(|s| s.on_scooter),
            }
        })
        .collect()
}

/// Which way point the scooters are parked at, if any.
///
/// The drop is *derived*, never placed: it is the boundary after the last scootered segment. Two
/// cases yield `None` - nothing is flown on a scooter, and the units are carried all the way to the
/// turnaround (the last segment is scootered, so its boundary is the turn, not a way point).
///
/// The returned index is both the segment index and the way-point index, since segment `k` ends at
/// way point `k` for every `k` but the tail.
pub(super) fn scooter_drop_index(segments: &[PlanSegment]) -> Option<usize> {
    let last = segments.iter().rposition(|s| s.on_scooter)?;
    (last + 1 < segments.len()).then_some(last)
}

/// The scootered-penetration cap in metres, or `f64::INFINITY` with no rig (nothing to cap, and
/// `resolve_segments` has already forced every span off the scooter in that case).
pub(super) fn scooter_range_limit(dpv: Option<&DpvRig>) -> f64 {
    dpv.map_or(f64::INFINITY, DpvRig::usable_range_m)
}

#[cfg(test)]
#[expect(
    clippy::float_cmp,
    reason = "exact arithmetic on hand-picked values; a drift of one ULP is a real regression here"
)]
mod tests {
    use super::*;
    use crate::config::DpvUnit;

    fn unit(speed: f64, burn: f64) -> DpvUnit {
        DpvUnit {
            speed_m_per_min: speed,
            burn_minutes: burn,
            label: None,
        }
    }

    fn seg(speed: f64, on_scooter: bool) -> PlanSegment {
        PlanSegment {
            speed_m_per_min: speed,
            on_scooter,
        }
    }

    #[test]
    fn empty_segments_expand_to_the_default_speed_and_no_scooter() {
        let out = resolve_segments(&[], 2, 10.0, true);
        assert_eq!(out.len(), 3);
        assert!(out.iter().all(|s| s.speed_m_per_min == 10.0));
        assert!(out.iter().all(|s| !s.on_scooter));
    }

    #[test]
    fn a_short_list_is_padded_and_a_long_one_truncated() {
        let padded = resolve_segments(&[seg(55.0, true)], 2, 10.0, true);
        assert_eq!(padded.len(), 3);
        assert_eq!(padded[0].speed_m_per_min, 55.0);
        assert!(padded[0].on_scooter);
        assert_eq!(padded[1].speed_m_per_min, 10.0);

        let truncated = resolve_segments(
            &[seg(55.0, true), seg(20.0, false), seg(30.0, true)],
            0,
            10.0,
            true,
        );
        assert_eq!(truncated.len(), 1);
        assert_eq!(truncated[0].speed_m_per_min, 55.0);
    }

    #[test]
    fn a_bad_speed_falls_back_to_the_default() {
        for bad in [0.0, -5.0, f64::NAN, f64::INFINITY] {
            let out = resolve_segments(&[seg(bad, false)], 0, 12.0, true);
            assert_eq!(out[0].speed_m_per_min, 12.0, "speed {bad} should fall back");
        }
    }

    #[test]
    fn without_a_rig_the_scooter_flag_is_dropped_but_the_speed_is_kept() {
        let out = resolve_segments(&[seg(55.0, true)], 0, 10.0, false);
        assert_eq!(out[0].speed_m_per_min, 55.0);
        assert!(!out[0].on_scooter);
    }

    #[test]
    fn the_drop_is_the_boundary_after_the_last_scootered_segment() {
        // scooter, scooter, swim -> parked at way point 1 (the end of segment 1).
        assert_eq!(
            scooter_drop_index(&[seg(55.0, true), seg(55.0, true), seg(10.0, false)]),
            Some(1)
        );
        // A tow: swimming in the middle, back on the scooter after, so the units travel on.
        assert_eq!(
            scooter_drop_index(&[seg(55.0, true), seg(10.0, false), seg(55.0, true)]),
            None
        );
        // Carried to the turnaround - the last span is scootered, so its boundary is the turn.
        assert_eq!(
            scooter_drop_index(&[seg(55.0, true), seg(55.0, true)]),
            None
        );
        // Never on a scooter at all.
        assert_eq!(scooter_drop_index(&[seg(10.0, false)]), None);
    }

    #[test]
    fn the_cap_is_the_weaker_unit_by_range_not_by_burn() {
        // The backup burns for LESS time but the primary is the weaker unit by line covered:
        // 20 x 100 = 2000 m against 60 x 50 = 3000 m.
        let rig = DpvRig {
            primary: unit(20.0, 100.0),
            backup: unit(50.0, 60.0),
            range_reserve_fraction: 0.0,
        };
        assert_eq!(rig.usable_range_m(), 2000.0);
    }

    #[test]
    fn the_cap_is_not_halved_and_the_reserve_scales_it() {
        let rig = DpvRig {
            primary: unit(55.0, 90.0),
            backup: unit(50.0, 60.0),
            range_reserve_fraction: 0.2,
        };
        // min(4950, 3000) = 3000, less 20% = 2400. Not 1500: the primary flies in and the backup
        // flies out, so each is asked for one direction only.
        assert_eq!(rig.usable_range_m(), 2400.0);
    }

    #[test]
    fn no_rig_means_no_cap() {
        assert_eq!(scooter_range_limit(None), f64::INFINITY);
    }
}
