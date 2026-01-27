# GPS-Centric Frontend: Backend Transforms All Coordinates to GPS Before IPC

## Problem

The single system view (MapCanvas/SurveyLayer) shows stations at wrong GPS positions after a zero datum with GPS coordinates is added. The root cause: the frontend transforms local meter coordinates to GPS using `config.map.satellite_gps_origin` (hardcoded default: Florida Keys 24.55°N, 81.78°W) rather than the project's actual zero datum GPS coordinates. The GlobalView correctly uses backend GPS transforms and does not have this bug.

The fix is architectural: make the MapLibre frontend purely GPS-coordinate driven. The backend retains local meters as ground truth internally but transforms all coordinates to GPS `[lng, lat]` before IPC with the frontend. The frontend never computes station/shot positions — it only renders what the backend provides.

## Key Decisions

### Architecture
- **Frontend is GPS-only**: The frontend receives GPS coordinates from the backend and renders them directly. It never performs local-meter ↔ GPS conversions for positioning.
- **Backend retains ground truth**: Backend continues computing station positions in local meters internally. GPS transformation is applied at IPC serialization time.
- **Both coordinate systems on Station**: `Station` struct keeps existing `coordinates: Coordinates { x, y, z }` (local meters) AND adds `gps_lng: f64, gps_lat: f64` fields. Frontend uses GPS for rendering; meters remain available for display purposes (e.g., depth from `coordinates.z`).

### GPS Origin / Anchoring
- **Per-network GPS anchoring via zero datum chains**: Each station's GPS position is determined by the zero datum it's connected to through an uninterrupted chain of stations, shots, and merges (survey network topology).
- **Virtual zero datums for unanchored networks**: If a connected network has no real GPS zero datum, its first station becomes a "virtual zero datum." The GPS position of this virtual datum is determined by where the user placed the section (placement mode position).
- **Config fallback origin**: `satellite_gps_origin` config remains as a last-resort fallback when no placement position is available. Renamed in UI to "Default GPS Position."
- **Auto-assign on disconnection**: When a section deletion disconnects a network from its GPS anchor, the backend automatically assigns virtual zero datums to newly disconnected sub-networks.

### Backend API Changes
- **Station GPS fields**: Add `gps_lng` and `gps_lat` to `Station` struct in `get_project_state()` response. Backend computes these using `local_to_gps()` relative to each station's network's zero datum.
- **Move commands accept GPS**: `move_section` and `move_station` accept absolute GPS positions `(lng, lat)` instead of meter deltas `(dx, dy)`. Backend converts to internal meter offsets.
- **Placement accepts GPS**: Section placement sends GPS `[lng, lat]` click position to backend. Backend computes the meter offset for section placement.
- **Measure tool uses backend**: Frontend asks backend for precise meter distance between two station refs (new command).
- **Ghost sections in GPS**: Backend computes ghost section (merge preview) positions in GPS coordinates and sends them to the frontend.
- **GPS origin in ProjectState**: Include `gps_origin: Option<[f64; 2]>` in ProjectState for map centering.

### Frontend Changes
- **Remove `metersToMapCoords()` and `mapCoordsToMeters()`** entirely from `src/utils/coordinates.ts`.
- **Feature building** (`features.ts`): Use `station.gps_lng/gps_lat` directly instead of calling `metersToMapCoords()`.
- **Snap detection**: Use GPS coords directly with `map.project()`.
- **Bounds calculation**: Compute bounding box directly from station GPS coordinates.
- **Center-on-station/shot**: Use GPS coords directly; shot midpoint computed as average of from/to GPS coords.
- **Optimistic draw rendering**: For the brief period before backend responds, use a rough equirectangular estimate for the new station's GPS position. Backend reconciles with accurate coords.

### Config Changes
- **Keep `satellite_gps_origin`** in config as "Default GPS Position" (fallback for unanchored networks).
- **Rename in UI**: Change label in MapSettings dialog from satellite GPS origin to "Default GPS Position" or similar.

### Export
- **Image export also uses GPS**: Export module switches to GPS coordinates for consistency.

### Undo/Redo
- **Re-center on GPS anchor change**: When undo/redo affects a zero datum (add/remove), the map automatically re-centers to survey bounds.
- **Snap immediately**: When a previously unanchored network gets a real GPS zero datum, all stations snap to correct GPS positions immediately (no animation).

### File Format
- **No file format change**: GPS coordinates are computed at load time from existing data (section_offsets, shots, zero datums). No migration needed.

### IPC Payload
- **Acceptable overhead**: Two extra f64 fields per station (~16 bytes per station, ~160KB for 10k stations) is negligible.

## Edge Cases

- **Project with no zero datums at all**: All networks get virtual zero datums; positions derived from user placement or config fallback origin.
- **Multiple disconnected networks with different GPS anchors**: Each network independently positioned by its own zero datum chain.
- **Section delete breaks anchor chain**: Backend auto-assigns virtual zero datums to newly disconnected sub-networks, preserving their current approximate GPS positions.
- **Zero datum removed via undo**: All affected stations recompute GPS coords; map re-centers.
- **Zero datum added to previously unanchored network**: All stations in that network snap to correct GPS positions immediately.
- **Draw tool optimistic rendering**: Frontend shows rough GPS estimate for ~50ms until backend responds with accurate coordinates.
- **Ghost section preview**: Backend provides full GPS-transformed ghost data; no frontend coordinate math needed.
- **MapLibre precision**: GPS coordinates at sub-meter scale (cave stations) are well within MapLibre's cm-level precision at zoom 24. No precision concerns.

## Open Questions

- Exact Rust struct layout for the GPS fields on Station (inline f64 fields vs nested struct)
- Whether `local_to_gps()` precision (equirectangular approximation) is sufficient for all use cases, or if the more accurate WGS84 ellipsoid math from `gps_to_local()` should be ported to the forward direction too
- How virtual zero datum assignment interacts with the existing `section_offsets` system — whether offsets are recomputed or GPS coords are derived independently

## Acceptance

- [ ] Single system view positions stations at correct GPS coordinates after zero datum with GPS is set
- [ ] Backend `get_project_state()` returns Station with `gps_lng` and `gps_lat` fields
- [ ] Frontend rendering uses GPS coords exclusively (no `metersToMapCoords` calls)
- [ ] `metersToMapCoords()` and `mapCoordsToMeters()` removed from codebase
- [ ] Move section/station commands accept absolute GPS positions
- [ ] Section placement sends GPS click position to backend
- [ ] Measure tool uses backend command for distance calculation
- [ ] Ghost section preview renders using backend-provided GPS coords
- [ ] Projects without GPS zero datums render using virtual zero datums at placement/fallback positions
- [ ] Section deletion auto-assigns virtual zero datums to disconnected networks
- [ ] Undo/redo of zero datum changes triggers map re-center
- [ ] Image export uses GPS coordinates
- [ ] Config `satellite_gps_origin` renamed to "Default GPS Position" in settings UI
- [ ] Rust roundtrip test: local meters → GPS → local meters within sub-centimeter precision
- [ ] Existing Playwright e2e tests updated with GPS coordinate mocks
- [ ] New e2e tests for GPS positioning scenarios added
- [ ] Test scenario created that reproduces the original bug (stations at wrong position after GPS added)
- [ ] No file format changes required (backward compatible with existing .cave files)
