# Link Hover Highlights Map Elements

## Overview

Add hover highlighting to DetailLink components in the DetailPanel: when the mouse hovers over or keyboard focuses a link to a station, shot, or section, the corresponding element(s) highlight on the map using the existing blue hover visual style.

## Scope

**In scope:**
- DetailLink hover/focus handlers that call uiStore setters
- MapCanvas sync for hoveredStation (currently missing)
- SurveyLayer.setHoveredStation method (currently missing)

**Out of scope:**
- Links outside DetailPanel (DataTable rows already work independently)
- Visual changes to the link itself during hover
- Pan/zoom on hover
- Touch-specific handling

## Approach

1. **Add SurveyLayer.setHoveredStation()** - New public method mirroring setHoveredShot/setHoveredSection pattern
2. **Add MapCanvas hoveredStation sync** - New useEffect similar to existing hoveredShot/hoveredSectionId syncs
3. **Add DetailLink hover handlers** - onMouseEnter/onMouseLeave/onFocus/onBlur calling appropriate uiStore setters
4. **Handle shot position→shotId conversion** - DetailLink needs access to project data or callback to resolve shot ID

## Key Decisions (from spec)

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Station hover | Station only | Simpler, matches selection behavior |
| Shot hover | Shot line only | Simpler, matches selection behavior |
| Section hover | All elements | Existing setHoveredSectionId already does this |
| Leave behavior | Immediate clear | No debouncing per spec |
| Focus triggers | Yes | Accessibility requirement |
| Missing elements | Silent no-op | Graceful degradation |

## Critical Gaps Identified

1. **SurveyLayer has no setHoveredStation()** - Only has internal hoveredStationId set from map events
2. **MapCanvas doesn't sync hoveredStation** - Has useEffects for hoveredSectionId and hoveredShot only
3. **DetailLink shot target lacks shotId** - Has {sectionId, position} but uiStore needs {sectionId, shotId}

## Quick commands

```bash
# Dev server
./scripts/dev.sh

# Type check (must pass)
pnpm tsc --noEmit

# UI tests (must pass)
pnpm test:ui

# Rust tests
cargo test --manifest-path src-tauri/Cargo.toml
```

## Acceptance

- [ ] Hovering station link in DetailPanel highlights that station on map
- [ ] Hovering shot link in DetailPanel highlights that shot on map
- [ ] Hovering section link in DetailPanel highlights all elements in that section
- [ ] Highlight uses existing blue outline/thicker stroke visual style
- [ ] Highlight clears immediately when mouse leaves link
- [ ] Tab-focusing a link triggers same highlight as hover
- [ ] Blur clears highlight
- [ ] Links outside DetailPanel do not trigger hover highlights
- [ ] Existing map hover behavior continues to work
- [ ] Existing table row hover behavior continues to work
- [ ] Missing/invalid links silently do nothing (no errors)

## References

| File | Lines | What |
|------|-------|------|
| `src/components/common/DetailLink.tsx` | 1-155 | Component to modify |
| `src/components/Map/SurveyLayer.tsx` | 1282-1300 | Existing setHoveredSection/setHoveredShot patterns |
| `src/components/Map/MapCanvas.tsx` | 707-722 | Existing hover sync patterns |
| `src/store/uiStore.ts` | 542-544 | Hover setters |
| `src/components/SingleSystemView/DetailPanel.tsx` | 389-441 | DetailLink usage sites |

## Pitfalls (from memory)

- When clearing hover for one feature type, only fire onFeatureHover(false) if no other type is hovered
- Mouse leave handlers must check if keyboard focus is active to avoid clearing highlight
- useEffect syncing to SurveyLayer needs mapLoaded in deps
