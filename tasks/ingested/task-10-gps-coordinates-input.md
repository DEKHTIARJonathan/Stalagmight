# Task 10: Add GPS coordinates input to Import Dialog

## Overview
Add latitude/longitude input fields to the DMP Import Dialog with format auto-detection. Support all major GPS formats and assign GPS coordinates to a station as zero datum.

## Priority
High - Phase 3 (GPS & Placement)

## Risk Level
High

## Dependencies
None - can start immediately

## Files to Modify
- `src/components/Dialogs/DmpImportDialog.tsx` - Add GPS input fields
- `src/utils/gps.ts` - GPS parsing and format detection (create)

## Specifications

### Supported GPS Formats (All Required)
- DD (Decimal Degrees): 40.7128, -74.0060
- DMS (Degrees Minutes Seconds): 40°42'46"N, 74°0'21"W
- DDM (Degrees Decimal Minutes): 40°42.767'N, 74°0.350'W
- UTM: 18T 583960 4507523
- MGRS: 18TWL8396007523
- Plus Codes: 87G8Q2JQ+V8
- What3words: ///filled.count.soap

### Input Method
- Text input fields (Lat and Lon, or combined)
- URL paste support (extract coordinates from Google Maps URLs, etc.)
- No map picker in v1 (text input only)

### Format Detection
- Auto-detect format from input
- Show detected format to user
- Allow manual format override if needed

### GPS APIs
- Work offline by default
- Use external API for Plus Codes and What3words if available
- Graceful fallback if API unavailable

### Zero Datum Assignment
- No default zero datum - user must explicitly mark
- Select which station gets the GPS coordinates
- Options: First station or Last station of section
- Creates zero datum on import

### Storage
- Store internally as DD (Decimal Degrees)
- Display according to user config preference

### Validation
- Range check: Lat -90 to 90, Lon -180 to 180
- Format validation for each supported format
- Show validation errors inline

### UI Requirements
- GPS input section in Import Dialog
- Station selector (first/last or specific)
- Format indicator showing detected format
- Add `data-testid` attributes:
  - `gps-latitude-input`
  - `gps-longitude-input`
  - `gps-format-indicator`
  - `gps-station-selector`

## Acceptance Criteria
- [ ] GPS input fields visible in Import Dialog
- [ ] All 7 GPS formats supported and auto-detected
- [ ] URL paste extracts coordinates
- [ ] Station selector for zero datum assignment
- [ ] Coordinates validated (range check)
- [ ] Store as DD internally
- [ ] Display format matches config
- [ ] Works offline for basic formats
- [ ] Graceful fallback for API-dependent formats
- [ ] TypeScript types pass (`pnpm tsc --noEmit`)
- [ ] Playwright tests pass

## Test Requirements

### Playwright Tests (e2e-playwright/)
- Test GPS input fields visible
- Test DD format parsing
- Test DMS format parsing
- Test DDM format parsing
- Test UTM format parsing
- Test MGRS format parsing
- Test Plus Codes parsing (mock API)
- Test What3words parsing (mock API)
- Test URL paste extraction
- Test validation errors for invalid coordinates
- Test station selector

### Rust Tests
- Test coordinate conversion functions
- Test format detection logic

## Edge Cases
- Invalid coordinates (out of range)
- Malformed format input
- Mixed format (lat in DD, lon in DMS)
- GPS near poles or date line
- Empty GPS input (no zero datum)
- API unavailable for Plus Codes/What3words

## Implementation Notes
- High risk due to many format combinations
- Consider using a GPS parsing library
- What3words requires API key
- Plus Codes can be decoded offline with library
