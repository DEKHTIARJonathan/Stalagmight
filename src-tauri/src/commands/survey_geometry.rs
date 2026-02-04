//! Survey geometry command for GPS-transformed survey data.
//!
//! Provides the `get_survey_geometry` command that returns shot data with
//! GPS-transformed coordinates for map display.
//!
//! Also provides `get_survey_geometry_for_file` for lazy loading geometry
//! from arbitrary project files (used by GlobalView for on-demand loading).

use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use ts_rs::TS;
use tauri::Manager;

use crate::core::AppState;
use crate::models::{GpsCoordinates, Project, SectionId, StationRef};
use crate::persistence::Database;

/// Minimum cosine value to avoid division by near-zero at extreme latitudes.
/// This corresponds to latitudes beyond ±89.4° where the approximation breaks down.
const MIN_COS_LAT: f64 = 0.01;

/// A self-contained shot with GPS coordinates and metadata.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct GeometryShot {
    /// GPS coordinates of the from station [lng, lat] (MapLibre order)
    pub from: [f64; 2],
    /// GPS coordinates of the to station [lng, lat] (MapLibre order)
    pub to: [f64; 2],
    /// Whether this shot is virtual (temporary connection)
    pub is_virtual: bool,
    /// Section ID this shot belongs to (for coloring/filtering)
    pub section_id: SectionId,
}

/// Survey geometry response containing GPS-transformed shot data.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct SurveyGeometry {
    /// Array of shots with GPS coordinates
    pub shots: Vec<GeometryShot>,
    /// GPS origin used for the transformation [lng, lat]
    pub origin: [f64; 2],
}

/// Error response for survey geometry command.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct SurveyGeometryError {
    pub message: String,
}

/// Convert local meters (east, north) to GPS coordinates relative to origin.
///
/// Uses a simplified linear approximation for small distances (<100km):
/// - latitude_delta = north_meters / meters_per_degree_lat
/// - longitude_delta = east_meters / meters_per_degree_lng
///
/// where:
/// - meters_per_degree_lat ≈ 111320 (constant for WGS84)
/// - meters_per_degree_lng = 111320 * cos(origin_lat_rad)
///
/// # Errors
/// Returns an error if the origin latitude is too close to ±90° (beyond ±89.4°).
pub fn local_to_gps(
    east: f64,
    north: f64,
    origin: &GpsCoordinates,
) -> Result<(f64, f64), SurveyGeometryError> {
    const METERS_PER_DEGREE_LAT: f64 = 111320.0;

    let origin_lat_rad = origin.latitude.to_radians();
    let cos_lat = origin_lat_rad.cos();

    // Guard against division by near-zero at extreme latitudes
    if cos_lat.abs() < MIN_COS_LAT {
        return Err(SurveyGeometryError {
            message: format!(
                "Origin latitude {:.2}° is too close to the poles for accurate coordinate conversion",
                origin.latitude
            ),
        });
    }

    let meters_per_degree_lng = METERS_PER_DEGREE_LAT * cos_lat;

    let lat = origin.latitude + (north / METERS_PER_DEGREE_LAT);
    let lng = origin.longitude + (east / meters_per_degree_lng);

    Ok((lng, lat)) // MapLibre order
}

/// Get survey geometry with GPS-transformed coordinates.
///
/// Computes shot geometry relative to the zero-datum station and transforms
/// local coordinates to GPS for map display.
///
/// # Returns
/// - `Ok(SurveyGeometry)` with shots and origin
/// - `Err(SurveyGeometryError)` if project has no GPS reference
#[tauri::command]
pub async fn get_survey_geometry(
    app_handle: tauri::AppHandle,
) -> Result<SurveyGeometry, SurveyGeometryError> {
    // Use spawn_blocking for UI responsiveness
    let result = tauri::async_runtime::spawn_blocking(move || {
        let state = app_handle.state::<AppState>();
        get_survey_geometry_impl(state.inner())
    })
    .await;

    match result {
        Ok(inner) => inner,
        Err(e) => Err(SurveyGeometryError {
            message: format!("Internal error: {}", e),
        }),
    }
}

/// Get survey geometry for a specific file path without loading into AppState.
///
/// This is used by GlobalView for lazy loading geometry from arbitrary projects.
/// Opens the database read-only, computes geometry, and closes it.
///
/// # Returns
/// - `Ok(SurveyGeometry)` with shots and origin
/// - `Err(SurveyGeometryError)` if file doesn't exist or has no GPS reference
#[tauri::command]
pub async fn get_survey_geometry_for_file(
    path: PathBuf,
) -> Result<SurveyGeometry, SurveyGeometryError> {
    // Use spawn_blocking for UI responsiveness
    tauri::async_runtime::spawn_blocking(move || get_survey_geometry_for_file_impl(&path))
        .await
        .map_err(|e| SurveyGeometryError {
            message: format!("Internal error: {}", e),
        })?
}

/// Internal implementation for file-based geometry loading.
fn get_survey_geometry_for_file_impl(path: &PathBuf) -> Result<SurveyGeometry, SurveyGeometryError> {
    // Open database in read-only mode - never create or modify files
    let db = Database::open_readonly(path).map_err(|e| SurveyGeometryError {
        message: format!("Failed to open project: {}", e),
    })?;

    // Load project from database
    let mut project = db.load_project().map_err(|e| SurveyGeometryError {
        message: format!("Failed to load project: {}", e),
    })?;

    // Assign IDs to any legacy closures with id=0 (in-memory only, read-only DB)
    project.assign_closure_ids();

    // Compute geometry from project
    get_survey_geometry_for_project(&project)
}

/// Compute survey geometry from a project struct.
/// Shared implementation used by both AppState-based and file-based commands.
fn get_survey_geometry_for_project(project: &Project) -> Result<SurveyGeometry, SurveyGeometryError> {
    // Find zero datum for GPS origin
    let zero_datum = project.zero_datums.first().ok_or_else(|| SurveyGeometryError {
        message: "Project has no GPS reference. Set a zero datum with GPS coordinates first."
            .to_string(),
    })?;

    let origin_gps = &zero_datum.gps;
    let origin = [origin_gps.longitude, origin_gps.latitude];

    // Compute station coordinates
    let stations = project.compute_station_coordinates();

    // Build a map for quick station lookup
    let station_map: std::collections::HashMap<StationRef, &crate::models::Station> = stations
        .iter()
        .map(|s| (s.station_ref, s))
        .collect();

    // Find the zero-datum station's local coordinates (x0, y0)
    // All other coordinates are relative to this point
    let datum_station = station_map
        .get(&zero_datum.station_ref)
        .ok_or_else(|| SurveyGeometryError {
            message: format!(
                "Zero datum station {} not found in computed stations",
                zero_datum.station_ref
            ),
        })?;
    let x0 = datum_station.coordinates.x;
    let y0 = datum_station.coordinates.y;

    let mut shots = Vec::new();

    // Iterate through sections and shots
    for section in &project.sections {
        for (shot_idx, shot) in section.shots.iter().enumerate() {
            let from_ref = StationRef::new(section.id, shot_idx as u32);
            let to_ref = StationRef::new(section.id, (shot_idx + 1) as u32);

            let from_station = station_map.get(&from_ref).ok_or_else(|| SurveyGeometryError {
                message: format!("Station {} not found in computed stations", from_ref),
            })?;
            let to_station = station_map.get(&to_ref).ok_or_else(|| SurveyGeometryError {
                message: format!("Station {} not found in computed stations", to_ref),
            })?;

            // Compute coordinates relative to zero-datum station (x0, y0)
            let from_east = from_station.coordinates.x - x0;
            let from_north = from_station.coordinates.y - y0;
            let to_east = to_station.coordinates.x - x0;
            let to_north = to_station.coordinates.y - y0;

            // Convert local coordinates to GPS
            let from_gps = local_to_gps(from_east, from_north, origin_gps)?;
            let to_gps = local_to_gps(to_east, to_north, origin_gps)?;

            shots.push(GeometryShot {
                from: [from_gps.0, from_gps.1],
                to: [to_gps.0, to_gps.1],
                is_virtual: shot.is_virtual,
                section_id: section.id,
            });
        }
    }

    Ok(SurveyGeometry { shots, origin })
}

/// Internal implementation for testing.
pub(crate) fn get_survey_geometry_impl(
    state: &AppState,
) -> Result<SurveyGeometry, SurveyGeometryError> {
    // Get project state
    let project = state.get_project_state().ok_or_else(|| SurveyGeometryError {
        message: "No project loaded".to_string(),
    })?;

    get_survey_geometry_for_project(&project)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::gps_to_local;

    // Test vector data from coordinate_transform_vectors.json
    // These tests verify the local_to_gps function matches expected values

    #[test]
    fn test_local_to_gps_at_equator() {
        // At equator, 1 degree ≈ 111320 meters in both directions
        let origin = GpsCoordinates::new(0.0, 0.0, 0.0).unwrap();

        // 1000m east at equator
        let (lng, lat) = local_to_gps(1000.0, 0.0, &origin).unwrap();
        let expected_lng_delta = 1000.0 / 111320.0;
        assert!(
            (lng - expected_lng_delta).abs() < 1e-6,
            "lng: {} expected: {}",
            lng,
            expected_lng_delta
        );
        assert!(lat.abs() < 1e-9, "lat should be ~0");

        // 1000m north at equator
        let (lng, lat) = local_to_gps(0.0, 1000.0, &origin).unwrap();
        let expected_lat_delta = 1000.0 / 111320.0;
        assert!(lng.abs() < 1e-9, "lng should be ~0");
        assert!(
            (lat - expected_lat_delta).abs() < 1e-6,
            "lat: {} expected: {}",
            lat,
            expected_lat_delta
        );
    }

    #[test]
    fn test_local_to_gps_at_45_degrees() {
        // At 45°N, longitude degrees are shorter by cos(45°) ≈ 0.7071
        let origin = GpsCoordinates::new(45.0, -90.0, 0.0).unwrap();

        // 1000m east at 45°N
        let (lng, lat) = local_to_gps(1000.0, 0.0, &origin).unwrap();
        let meters_per_deg_lng = 111320.0 * (45.0_f64.to_radians().cos());
        let expected_lng = -90.0 + (1000.0 / meters_per_deg_lng);
        assert!(
            (lng - expected_lng).abs() < 1e-6,
            "lng: {} expected: {}",
            lng,
            expected_lng
        );
        assert!((lat - 45.0).abs() < 1e-9, "lat should be ~45.0");

        // 1000m north at 45°N
        let (lng, lat) = local_to_gps(0.0, 1000.0, &origin).unwrap();
        let expected_lat = 45.0 + (1000.0 / 111320.0);
        assert!((lng - (-90.0)).abs() < 1e-9, "lng should be ~-90.0");
        assert!(
            (lat - expected_lat).abs() < 1e-6,
            "lat: {} expected: {}",
            lat,
            expected_lat
        );
    }

    #[test]
    fn test_local_to_gps_roundtrip() {
        // Test that gps_to_local and local_to_gps are approximate inverses
        let origin = GpsCoordinates::new(30.0, -80.0, 0.0).unwrap();
        let target = GpsCoordinates::new(30.01, -79.99, 0.0).unwrap();

        // Convert target GPS to local meters
        let (east, north) = gps_to_local(&target, &origin);

        // Convert back to GPS
        let (lng, lat) = local_to_gps(east, north, &origin).unwrap();

        // Should be close to original (within ~1m tolerance for small distances)
        assert!(
            (lat - target.latitude).abs() < 0.0001,
            "lat roundtrip error: {} vs {}",
            lat,
            target.latitude
        );
        assert!(
            (lng - target.longitude).abs() < 0.0001,
            "lng roundtrip error: {} vs {}",
            lng,
            target.longitude
        );
    }

    #[test]
    fn test_local_to_gps_diagonal() {
        let origin = GpsCoordinates::new(0.0, 0.0, 0.0).unwrap();

        // 1000m NE (45 degrees)
        let east = 1000.0 * (45.0_f64.to_radians().sin());
        let north = 1000.0 * (45.0_f64.to_radians().cos());
        let (lng, lat) = local_to_gps(east, north, &origin).unwrap();

        let expected_lng = east / 111320.0;
        let expected_lat = north / 111320.0;

        assert!((lng - expected_lng).abs() < 1e-6);
        assert!((lat - expected_lat).abs() < 1e-6);
    }

    #[test]
    fn test_local_to_gps_negative_coords() {
        let origin = GpsCoordinates::new(0.0, 0.0, 0.0).unwrap();

        // 1000m west (negative east)
        let (lng, lat) = local_to_gps(-1000.0, 0.0, &origin).unwrap();
        let expected_lng = -1000.0 / 111320.0;
        assert!((lng - expected_lng).abs() < 1e-6);
        assert!(lat.abs() < 1e-9);

        // 1000m south (negative north)
        let (lng, lat) = local_to_gps(0.0, -1000.0, &origin).unwrap();
        let expected_lat = -1000.0 / 111320.0;
        assert!(lng.abs() < 1e-9);
        assert!((lat - expected_lat).abs() < 1e-6);
    }

    #[test]
    fn test_local_to_gps_rejects_extreme_latitude() {
        // Near poles, cos(lat) approaches 0, causing division issues
        let near_pole = GpsCoordinates::new(89.5, 0.0, 0.0).unwrap();
        let result = local_to_gps(1000.0, 0.0, &near_pole);
        assert!(result.is_err(), "Should reject latitude near poles");
        assert!(
            result.unwrap_err().message.contains("poles"),
            "Error should mention poles"
        );

        // -89.5 should also fail
        let near_south_pole = GpsCoordinates::new(-89.5, 0.0, 0.0).unwrap();
        let result = local_to_gps(1000.0, 0.0, &near_south_pole);
        assert!(result.is_err(), "Should reject latitude near south pole");
    }

    #[test]
    fn test_local_to_gps_accepts_high_but_valid_latitude() {
        // 89° should still work (cos(89°) ≈ 0.0175 > MIN_COS_LAT)
        let high_lat = GpsCoordinates::new(89.0, 0.0, 0.0).unwrap();
        let result = local_to_gps(1000.0, 0.0, &high_lat);
        assert!(result.is_ok(), "89° latitude should be acceptable");
    }
}
