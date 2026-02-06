//! GPS-to-local coordinate conversion using ENU (East-North-Up) projection.
//!
//! Converts WGS84 GPS coordinates to local meters relative to a reference point.
//! Uses the WGS84 ellipsoid for accurate geodetic to ECEF conversion.

use super::GpsCoordinates;

/// WGS84 ellipsoid semi-major axis (equatorial radius) in meters
const WGS84_A: f64 = 6_378_137.0;

/// WGS84 ellipsoid eccentricity squared
/// e^2 = (a^2 - b^2) / a^2 where b = 6_356_752.314245 (polar radius)
const WGS84_E2: f64 = 0.00669437999014;

/// Convert geodetic coordinates (lat, lon, alt) to ECEF (Earth-Centered, Earth-Fixed).
///
/// # Arguments
/// * `lat` - Latitude in degrees
/// * `lon` - Longitude in degrees
/// * `alt` - Altitude above ellipsoid in meters (always use 0 for cave survey)
///
/// # Returns
/// (x, y, z) in meters in ECEF coordinate system
pub fn geodetic_to_ecef(lat: f64, lon: f64, alt: f64) -> (f64, f64, f64) {
    let lat_rad = lat.to_radians();
    let lon_rad = lon.to_radians();

    let sin_lat = lat_rad.sin();
    let cos_lat = lat_rad.cos();
    let sin_lon = lon_rad.sin();
    let cos_lon = lon_rad.cos();

    // N = radius of curvature in the prime vertical
    let n = WGS84_A / (1.0 - WGS84_E2 * sin_lat * sin_lat).sqrt();

    let x = (n + alt) * cos_lat * cos_lon;
    let y = (n + alt) * cos_lat * sin_lon;
    let z = (n * (1.0 - WGS84_E2) + alt) * sin_lat;

    (x, y, z)
}

/// Convert ECEF difference to ENU (East-North-Up) coordinates.
///
/// # Arguments
/// * `dx`, `dy`, `dz` - Difference in ECEF coordinates (target - origin)
/// * `lat0` - Origin latitude in degrees
/// * `lon0` - Origin longitude in degrees
///
/// # Returns
/// (east, north, up) in meters relative to origin
fn ecef_to_enu(dx: f64, dy: f64, dz: f64, lat0: f64, lon0: f64) -> (f64, f64, f64) {
    let lat_rad = lat0.to_radians();
    let lon_rad = lon0.to_radians();

    let sin_lat = lat_rad.sin();
    let cos_lat = lat_rad.cos();
    let sin_lon = lon_rad.sin();
    let cos_lon = lon_rad.cos();

    // Rotation matrix from ECEF to ENU
    let east = -sin_lon * dx + cos_lon * dy;
    let north = -sin_lat * cos_lon * dx - sin_lat * sin_lon * dy + cos_lat * dz;
    let up = cos_lat * cos_lon * dx + cos_lat * sin_lon * dy + sin_lat * dz;

    (east, north, up)
}

/// Convert GPS coordinates to local ENU coordinates relative to an origin.
///
/// Returns (east, north) offset in meters. The "Up" component is ignored since
/// cave surveys use depth measurements instead of GPS altitude.
///
/// # Arguments
/// * `gps` - Target GPS coordinates
/// * `origin` - Origin GPS coordinates (reference point)
///
/// # Returns
/// (east, north) offset in meters where:
/// - East is positive towards the east (local x-axis)
/// - North is positive towards the north (local y-axis)
///
/// # Important
/// Always uses altitude=0 for both points. The `GpsCoordinates.depth_reference`
/// field is NOT ellipsoid height - it represents meters below surface and must
/// not be used as altitude in the conversion.
pub fn gps_to_local(gps: &GpsCoordinates, origin: &GpsCoordinates) -> (f64, f64) {
    // Always use alt=0 - depth_reference is not ellipsoid height
    let (x0, y0, z0) = geodetic_to_ecef(origin.latitude, origin.longitude, 0.0);
    let (x1, y1, z1) = geodetic_to_ecef(gps.latitude, gps.longitude, 0.0);

    let dx = x1 - x0;
    let dy = y1 - y0;
    let dz = z1 - z0;

    let (east, north, _up) = ecef_to_enu(dx, dy, dz, origin.latitude, origin.longitude);

    (east, north)
}

#[cfg(test)]
#[expect(clippy::unwrap_used)]
mod tests {
    use super::*;

    #[test]
    fn same_point_returns_zero() {
        let gps = GpsCoordinates::new(45.0, -90.0, 10.0).unwrap();
        let (east, north) = gps_to_local(&gps, &gps);
        assert!(
            east.abs() < 1e-9,
            "East should be ~0 for same point, got {}",
            east
        );
        assert!(
            north.abs() < 1e-9,
            "North should be ~0 for same point, got {}",
            north
        );
    }

    #[test]
    fn small_latitude_delta_at_equator() {
        // At the equator, 1 degree of latitude ~ 110574.3 meters (per WGS84)
        // 0.01 degree ~ 1105.7 meters
        let origin = GpsCoordinates::new(0.0, 0.0, 0.0).unwrap();
        let target = GpsCoordinates::new(0.01, 0.0, 0.0).unwrap();

        let (east, north) = gps_to_local(&target, &origin);

        // North should be approximately 1105.7 meters (within tolerance)
        assert!(
            (north - 1105.7).abs() < 5.0,
            "North should be ~1105.7m for 0.01 deg lat, got {}",
            north
        );
        // East should be nearly zero
        assert!(
            east.abs() < 1.0,
            "East should be ~0 for lat-only change, got {}",
            east
        );
    }

    #[test]
    fn small_longitude_delta_at_equator() {
        // At the equator, 1 degree of longitude ~ 111319.5 meters
        // 0.01 degree ~ 1113.2 meters
        let origin = GpsCoordinates::new(0.0, 0.0, 0.0).unwrap();
        let target = GpsCoordinates::new(0.0, 0.01, 0.0).unwrap();

        let (east, north) = gps_to_local(&target, &origin);

        // East should be approximately 1113.2 meters (within tolerance)
        assert!(
            (east - 1113.2).abs() < 5.0,
            "East should be ~1113.2m for 0.01 deg lon, got {}",
            east
        );
        // North should be nearly zero
        assert!(
            north.abs() < 1.0,
            "North should be ~0 for lon-only change, got {}",
            north
        );
    }

    #[test]
    fn depth_reference_is_ignored() {
        // Different depth_reference values should give the same result
        let origin1 = GpsCoordinates::new(45.0, -90.0, 0.0).unwrap();
        let origin2 = GpsCoordinates::new(45.0, -90.0, 100.0).unwrap();
        let target1 = GpsCoordinates::new(45.01, -90.0, 0.0).unwrap();
        let target2 = GpsCoordinates::new(45.01, -90.0, 50.0).unwrap();

        let (east1, north1) = gps_to_local(&target1, &origin1);
        let (east2, north2) = gps_to_local(&target2, &origin2);

        assert!(
            (east1 - east2).abs() < 1e-9,
            "East should be same regardless of depth_reference"
        );
        assert!(
            (north1 - north2).abs() < 1e-9,
            "North should be same regardless of depth_reference"
        );
    }

    #[test]
    fn negative_deltas_give_negative_results() {
        // Moving south should give negative north
        let origin = GpsCoordinates::new(0.01, 0.0, 0.0).unwrap();
        let target = GpsCoordinates::new(0.0, 0.0, 0.0).unwrap();

        let (east, north) = gps_to_local(&target, &origin);

        assert!(north < 0.0, "Moving south should give negative north");
        assert!(east.abs() < 1.0, "East should be ~0 for lat-only change");
    }

    #[test]
    fn mid_latitude_conversion() {
        // Test at 45 degrees latitude (typical cave location)
        // At 45 deg lat, 1 degree of longitude ~ 78847 meters
        // 0.01 degree ~ 788.5 meters
        let origin = GpsCoordinates::new(45.0, -90.0, 0.0).unwrap();
        let target = GpsCoordinates::new(45.0, -89.99, 0.0).unwrap();

        let (east, north) = gps_to_local(&target, &origin);

        // East should be approximately 788.5 meters at 45 deg lat
        assert!(
            (east - 788.5).abs() < 5.0,
            "East should be ~788.5m for 0.01 deg lon at 45 deg lat, got {}",
            east
        );
        assert!(
            north.abs() < 1.0,
            "North should be ~0 for lon-only change, got {}",
            north
        );
    }

    #[test]
    fn geodetic_to_ecef_basic() {
        // At equator, lon=0: should be on X axis at ~6378137m
        let (x, y, z) = geodetic_to_ecef(0.0, 0.0, 0.0);
        assert!((x - WGS84_A).abs() < 1.0, "X at equator/prime meridian should be ~a");
        assert!(y.abs() < 1.0, "Y should be ~0");
        assert!(z.abs() < 1.0, "Z should be ~0");

        // At north pole: should be on Z axis at ~6356752m (polar radius)
        let (x, y, z) = geodetic_to_ecef(90.0, 0.0, 0.0);
        assert!(x.abs() < 1.0, "X at north pole should be ~0");
        assert!(y.abs() < 1.0, "Y at north pole should be ~0");
        // Polar radius b = a * sqrt(1 - e^2) ~ 6356752.314
        let expected_z = WGS84_A * (1.0 - WGS84_E2).sqrt();
        assert!(
            (z - expected_z).abs() < 1.0,
            "Z at north pole should be ~{}, got {}",
            expected_z,
            z
        );
    }
}
