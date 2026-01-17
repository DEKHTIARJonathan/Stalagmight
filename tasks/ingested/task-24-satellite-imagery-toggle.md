# Task 24: Wire satellite imagery toggle

## Overview
Connect the showSatellite toggle to switch between dark background and satellite imagery tiles on the map canvas.

## Priority
Medium - Phase 6 (Export & Polish)

## Risk Level
High

## Dependencies
None - can start immediately

## Files to Modify
- `src/components/Map/MapCanvas.tsx` - Toggle tile source

## Specifications

### Toggle Behavior
- showSatellite: true → Satellite tiles
- showSatellite: false → Dark background

### Switch Animation
- Instant switch (no fade animation)
- Performance over aesthetics

### Satellite Provider
- Configurable in config.toml
- Default: free provider (e.g., Mapbox, Esri, Bing)
- Support multiple providers

### Config Option
```toml
[map]
satellite_provider = "esri"  # or "mapbox", "bing", etc.
satellite_api_key = ""       # if required
```

### Offline Handling
- Graceful fallback if tiles unavailable
- Show dark background if fetch fails
- Don't crash or show errors for offline use

### Cache Management
- Size limit for cached tiles
- Configurable cache size
- Auto-cache tiles as viewed

### UI Requirements
- Toggle in View menu or map toolbar
- Add `data-testid="satellite-toggle"`

## Acceptance Criteria
- [ ] Toggle switches tile source
- [ ] Satellite tiles load when enabled
- [ ] Dark background when disabled
- [ ] Instant switch (no animation)
- [ ] Provider configurable
- [ ] Graceful offline fallback
- [ ] Tile caching works
- [ ] Cache size limited
- [ ] TypeScript types pass (`pnpm tsc --noEmit`)
- [ ] Rust tests pass (`cargo test`)
- [ ] Playwright tests pass

## Test Requirements

### Playwright Tests (e2e-playwright/)
- Test toggle switches background
- Test satellite tiles visible
- Test dark background visible

### Rust Tests
- Test config parsing for satellite options
- Test cache management

## Edge Cases
- Offline mode (no internet)
- Invalid API key
- Provider URL not responding
- Very slow connection
- Cache full
- Switching rapidly

## Implementation Notes
- High risk due to external dependencies
- Consider multiple provider support
- Test offline scenarios thoroughly
- May need API key management
- Tile URL patterns vary by provider
