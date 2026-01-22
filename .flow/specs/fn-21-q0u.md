# Details Panel Hyperlinks and Center Button

Add interactive hyperlinks throughout the Detail Panel to enable quick navigation between related survey elements (shots, stations, sections), plus a "center on map" button in each detail header.

## Overview

The Detail Panel currently displays relationships between survey elements as static text. This feature adds clickable hyperlinks that change selection when clicked, enabling users to quickly navigate connected elements without manually finding them on the map.

**Two main components:**
1. **Hyperlinks** - Clickable element IDs that change selection
2. **Center Button** - Crosshairs icon in panel header that pans/zooms map to element

## Scope

**In scope:**
- DetailLink reusable component
- Hyperlinks in Shot, Station, Section detail views
- "Connected" bordered sections in Shot/Station details
- "Endpoints" bordered section in Section details
- Center button using existing `headerActions` prop
- Map centering for stations and shots (extend existing section pattern)
- ARIA live region for selection announcements (hyperlink-triggered only)
- Full keyboard accessibility

**Out of scope:**
- Tooltip previews on link hover
- Link visited state styling
- Map auto-center on link click (user requested no map change)

## Approach

### ID Format (from fn-20-mwj)
All IDs use `sectionId:position` format where position is 1-indexed:
- Station position = `station_index + 1`
- Shot position = `shot array index + 1`
- Section format: `sectionId: sectionName` or `sectionId: Unnamed`

### Shot-to-Station Mapping
Shot at index `i` (0-indexed) connects:
- Start station: `station_index = i`
- End station: `station_index = i + 1`

For 1-indexed display: shot position N connects stations N and N+1.

### Missing Target Detection
When rendering links, validate that the target exists:
- **Station links**: Check if station with `section_id` and `station_index` exists in `stations` array
- **Shot links**: Check if shot with `shotId` exists in `section.shots` array
- **Section links**: Check if section with `sectionId` exists in `project.sections` array

If target not found, pass `isMissing={true}` to DetailLink to show warning indicator.

### Key Patterns to Reuse
- Selection: `setSelection()` from uiStore (pattern in SectionsPanel.tsx)
- Link styling: `text-accent underline` (existing pattern)
- Focus ring: `focus:ring-2 focus:ring-accent focus:ring-inset` (existing pattern)
- ARIA live: `role="status" aria-live="polite"` (pattern in ShortcutRecorder.tsx:325-332)
- Map zoom: `triggerZoomToSection` pattern in uiStore.ts:149-151
- Map fit: `fitToSection()` pattern in MapCanvas.tsx:1186-1262

### Panel Component
Use existing `headerActions` prop (Panel.tsx:9,40-42) instead of adding new `rightAction` prop - functionally equivalent.

## Quick commands
```bash
# Type check
pnpm tsc --noEmit

# Run Playwright tests
pnpm test:ui

# Run specific detail panel tests
pnpm test:ui --grep "detail"
```

## Key Files

| File | Changes |
|------|---------|
| `src/components/common/DetailLink.tsx` | New - reusable hyperlink component |
| `src/components/SingleSystemView/DetailPanel.tsx` | Add hyperlinks to StationDetail (L255-319), ShotDetail (L321-385), SectionDetail (L393-492) |
| `src/components/common/Panel.tsx` | Use existing `headerActions` for center button |
| `src/store/uiStore.ts` | Add `triggerCenterOnStation`, `triggerCenterOnShot` (pattern at L149-151) |
| `src/components/Map/MapCanvas.tsx` | Add station/shot centering handlers (follow fitToSection at L1186-1262) |

## Dependencies

- **fn-20-mwj** (Data Table Improvements): Required for consistent ID format
- **fn-9-d6v** (Selection Highlighting): Uses selection system patterns

## Risks

| Risk | Mitigation |
|------|------------|
| Link target doesn't exist (deleted) | Validate at render time, show warning indicator via `isMissing` prop |
| Duplicate ARIA announcements | Use single live region at DetailPanel level, only announce hyperlink-triggered changes |
| Tab persistence confusion | Switch to Details tab when link clicked from Warnings |

## Acceptance

### Hyperlinks
- [ ] Shot detail shows Start Station and End Station links in "Connected" section
- [ ] Station detail shows Previous/Next Shot links (hidden at section boundaries)
- [ ] Section detail shows first/last station in "Endpoints" section
- [ ] All IDs use 1-indexed format: `sectionId:position`
- [ ] Clicking link changes selection and updates Detail Panel
- [ ] Clicking section link highlights section in Sections Panel
- [ ] Links use accent color + underline style
- [ ] Missing link targets show warning indicator (validated at render time)
- [ ] Full keyboard accessibility (Tab + Enter)

### Center Button
- [ ] Crosshairs button in Shot, Station, Section detail headers (not Project Stats)
- [ ] Uses existing `headerActions` prop pattern
- [ ] Click pans and zooms map to fit element
- [ ] Full keyboard accessibility
- [ ] Dynamic aria-label per element type

### Accessibility
- [ ] All links have descriptive aria-labels: "Select [type] [id]"
- [ ] ARIA live region announces selection changes triggered by hyperlink clicks (not map/panel clicks)
- [ ] Focus ring meets WCAG 2.1 AA standards

### Testing
- [ ] Unit tests for DetailLink component
- [ ] Playwright E2E tests for link clicks and selection changes
- [ ] WebdriverIO tests for center button map behavior

### Documentation
- [ ] Update SPEC.md Section 6 with Detail Panel hyperlink patterns
- [ ] Update TESTING.md with new data-testid conventions

## References

- Panel.tsx `headerActions`: `src/components/common/Panel.tsx:9,40-42`
- Selection pattern: `src/store/uiStore.ts:56-99`
- Zoom pattern: `src/store/uiStore.ts:149-151`
- fitToSection: `src/components/Map/MapCanvas.tsx:1186-1262`
- ARIA live pattern: `src/components/Settings/ShortcutRecorder.tsx:325-332`
- Link styling: `src/components/SingleSystemView/DetailPanel.tsx:205`
