use std::cmp::Ordering;

use crate::models::GpsBounds;

use super::{Project, ProjectMetadata, ProjectStats};

impl Project {
    /// Calculate project statistics
    pub fn stats(&self) -> ProjectStats {
        let mut shot_count = 0;
        let mut total_length = 0.0;
        let mut min_depth = f64::MAX;
        let mut max_depth = f64::MIN;

        for section in &self.sections {
            let section_stats = section.stats();
            shot_count += section_stats.shot_count;
            total_length += section_stats.total_length;
            min_depth = min_depth.min(section_stats.min_depth);
            max_depth = max_depth.max(section_stats.max_depth);
        }

        if self.sections.is_empty() {
            min_depth = 0.0;
            max_depth = 0.0;
        }

        // Station count = shots + 1 per section (first station)
        let station_count = shot_count + self.sections.len();

        // Loop count = number of detected loop closures
        let loop_count = self.loop_closures.len();

        ProjectStats {
            section_count: self.sections.len(),
            shot_count,
            total_length,
            min_depth,
            max_depth,
            station_count,
            loop_count,
            penetration_distance: 0.0, // Calculated separately with stations
        }
    }

    /// Get metadata for this project
    pub fn metadata(&self) -> Option<ProjectMetadata> {
        let file_path = self.file_path.clone()?;
        let stats = self.stats();

        // Compute GPS center and bounds from zero datums
        let (gps_center, gps_bounds) = self.compute_gps_info();

        Some(ProjectMetadata {
            name: self.name.clone(),
            location: self.location.clone(),
            file_path,
            modified_at: self.modified_at,
            section_count: stats.section_count,
            total_length: stats.total_length,
            station_count: stats.station_count,
            gps_center,
            gps_bounds,
            collab_enabled: self.collab.as_ref().is_some_and(|c| c.enabled),
            // [Track B] (#189) is_remote is DERIVED from the on-disk speleo_link
            // table (load_metadata), which this in-memory Project does not carry.
            // The recent-projects listing goes through Database::load_metadata
            // (the authoritative probe); this in-memory metadata() path conserves
            // the prior behaviour with a safe default.
            is_remote: false,
        })
    }

    /// Compute GPS center and bounds from zero datums
    /// Returns (center, bounds) where center is from first valid zero datum
    /// and bounds encompass all valid zero datums.
    /// Returns (None, None) if no valid datums exist.
    fn compute_gps_info(&self) -> (Option<(f64, f64)>, Option<GpsBounds>) {
        // Filter to valid datums only to prevent serialization issues
        let valid_datums: Vec<_> = self
            .zero_datums
            .iter()
            .filter(|zd| zd.gps.is_valid())
            .collect();

        if valid_datums.is_empty() {
            return (None, None);
        }

        // Center from first valid zero datum (lng, lat order for MapLibre)
        let first_gps = &valid_datums[0].gps;
        let gps_center = Some((first_gps.longitude, first_gps.latitude));

        // Bounds from all valid zero datums with dateline-aware longitude handling
        let mut south = f64::INFINITY;
        let mut north = f64::NEG_INFINITY;

        // Collect all longitudes for dateline-aware calculation
        let mut longitudes: Vec<f64> = Vec::with_capacity(valid_datums.len());

        for zd in &valid_datums {
            south = south.min(zd.gps.latitude);
            north = north.max(zd.gps.latitude);
            longitudes.push(zd.gps.longitude);
        }

        // Calculate longitude bounds with dateline awareness
        // Sort longitudes and find the largest gap - the bounds are on the opposite side
        let (west, east) = Self::compute_longitude_bounds(&longitudes);

        let gps_bounds = Some(GpsBounds {
            north,
            south,
            east,
            west,
        });

        (gps_center, gps_bounds)
    }

    /// Compute longitude bounds with dateline awareness
    /// Returns (west, east) where east < west indicates crossing the dateline
    pub(crate) fn compute_longitude_bounds(longitudes: &[f64]) -> (f64, f64) {
        if longitudes.is_empty() {
            return (0.0, 0.0);
        }
        if longitudes.len() == 1 {
            return (longitudes[0], longitudes[0]);
        }

        // Sort longitudes
        let mut sorted = longitudes.to_vec();
        sorted.sort_by(|a, b| a.partial_cmp(b).unwrap_or(Ordering::Equal));

        // Find the largest gap between consecutive longitudes (including wrap-around)
        let mut max_gap = 0.0f64;
        let mut max_gap_end_idx = 0;

        for i in 0..sorted.len() {
            let next_idx = (i + 1) % sorted.len();
            let gap = if next_idx == 0 {
                // Wrap-around gap from last to first (crossing -180/180)
                (sorted[0] + 360.0) - sorted[sorted.len() - 1]
            } else {
                sorted[next_idx] - sorted[i]
            };

            if gap > max_gap {
                max_gap = gap;
                max_gap_end_idx = next_idx;
            }
        }

        // The bounds are on the opposite side of the largest gap
        // west is at max_gap_end_idx, east is at (max_gap_end_idx - 1 + len) % len
        let west = sorted[max_gap_end_idx];
        let east_idx = (max_gap_end_idx + sorted.len() - 1) % sorted.len();
        let east = sorted[east_idx];

        (west, east)
    }
}
