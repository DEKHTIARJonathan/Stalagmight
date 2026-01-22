# fn-19-mmx.1 Add GPS-to-local ENU coordinate conversion

## Description
Add GPS-to-local coordinate conversion using ENU (East-North-Up) projection in the Rust backend. This converts WGS84 GPS coordinates to local meters relative to a reference point.

**Size:** S
**Files:** `src-tauri/src/models/project.rs` (or new `src-tauri/src/utils/geo.rs`)

## Approach

Implement inline ENU projection (no external crate dependency):
1. `geodetic_to_ecef(lat, lon, alt)` - Convert geodetic to ECEF
2. `ecef_to_enu(dx, dy, dz, lat0, lon0)` - Convert ECEF difference to ENU
3. `gps_to_local(gps, origin_gps)` - High-level function for datum positioning

Follow WGS84 constants and formulas from Wikipedia Local_tangent_plane_coordinates.

## Key context

WGS84 ellipsoid constants:
- Semi-major axis (a): 6,378,137.0 meters
- Eccentricity squared (e²): 0.00669437999014

ENU result: East→x (meters), North→y (meters), Up→z (ignored for cave surveys)
## Acceptance
- [ ] `geodetic_to_ecef(lat: f64, lon: f64, alt: f64) -> (f64, f64, f64)` implemented
- [ ] `gps_to_local(gps: &GpsCoordinates, origin: &GpsCoordinates) -> (f64, f64)` implemented
- [ ] Uses WGS84 ellipsoid constants
- [ ] Latitude/longitude inputs in degrees (converted to radians internally)
- [ ] Returns (east, north) offset in meters
- [ ] Handles edge cases: same point returns (0, 0)
- [ ] Unit tests for known GPS coordinate pairs
- [ ] Rust tests pass (cargo test)
## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
