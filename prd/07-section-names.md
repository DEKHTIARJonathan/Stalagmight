# PRD: Display Section Names on Live Map

## Overview

**Task ID:** 7
**Priority:** High
**Phase:** 2 - Map Display Features
**Estimated Complexity:** Medium

### Summary

Show section name labels at section midpoints on the map, appearing at medium zoom levels and above, with section-colored text and white halo.

## Background

Section names provide crucial orientation on complex survey maps. Labels help users identify sections at a glance without hovering or clicking.

## Requirements

### Functional Requirements

| ID | Requirement | Priority |
|----|-------------|----------|
| F1 | Display section name at section midpoint | Must |
| F2 | Text color matches section color | Must |
| F3 | White text halo for visibility | Must |
| F4 | Appear at medium zoom and above | Must |
| F5 | Zoom threshold configurable in Settings | Must |
| F6 | Toggle via Display Menu | Must |
| F7 | Unnamed sections show "Section N" | Must |

### Non-Functional Requirements

| ID | Requirement | Priority |
|----|-------------|----------|
| NF1 | Labels should not overlap excessively | Should |
| NF2 | Performance stable with many sections | Must |

## User Decisions

- Appear at medium zoom level and above
- Style: Section color text with white halo
- Unnamed sections: Show "Section N" (with ID number)
- Zoom threshold configurable in Settings

## Technical Specification

### Files to Modify

| File | Changes |
|------|---------|
| `src/components/Map/SurveyLayer.tsx` | Add section label layer |
| `src/store/uiStore.ts` | Add `showSectionNames` toggle |
| `src/types/config.ts` | Add `sectionNameZoomThreshold` setting |

### Implementation Details

1. **Calculate section midpoint:**
   ```typescript
   const calculateSectionMidpoint = (section: Section): [number, number] => {
     const stations = section.shots.map(s => ({
       x: s.computed_x,
       y: s.computed_y,
     }));

     const centerX = stations.reduce((sum, s) => sum + s.x, 0) / stations.length;
     const centerY = stations.reduce((sum, s) => sum + s.y, 0) / stations.length;

     return metersToMapCoords(centerX, centerY);
   };
   ```

2. **GeoJSON source for labels:**
   ```typescript
   const sectionLabelsGeoJSON: GeoJSON.FeatureCollection = {
     type: 'FeatureCollection',
     features: sections.map(section => ({
       type: 'Feature',
       geometry: {
         type: 'Point',
         coordinates: calculateSectionMidpoint(section),
       },
       properties: {
         name: section.name || `Section ${section.id}`,
         color: section.color,
       },
     })),
   };
   ```

3. **Symbol layer configuration:**
   ```typescript
   map.addLayer({
     id: 'section-labels',
     type: 'symbol',
     source: 'section-labels-source',
     minzoom: config.display.sectionNameZoomThreshold,
     layout: {
       'text-field': ['get', 'name'],
       'text-size': 14,
       'text-anchor': 'center',
       'text-allow-overlap': false,
       'text-ignore-placement': false,
     },
     paint: {
       'text-color': ['get', 'color'],
       'text-halo-color': '#ffffff',
       'text-halo-width': 2,
     },
   });
   ```

4. **Visibility toggle:**
   ```typescript
   useEffect(() => {
     if (!map) return;
     map.setLayoutProperty(
       'section-labels',
       'visibility',
       showSectionNames ? 'visible' : 'none'
     );
   }, [showSectionNames]);
   ```

## UI/UX Specification

### Label Appearance

```
         Section A              (Blue section = blue label)
    ●───────●───────●
    │
    │         Entrance          (Green section = green label)
    ●─────●─────●─────●
```

### Text Style

- **Font**: System default, 14px
- **Color**: Section's assigned color
- **Halo**: White, 2px width
- **Position**: Centered at section midpoint

### Display Menu Item

```
Display ▼
├─ [ ] Grid
├─ [x] Scale Bar
├─ [ ] Section Names      <- Toggle this
└─ [ ] Station Labels
```

### Settings UI

```
Map Display Settings
├─ Section name zoom threshold: [14] ▼
│    (Options: 10, 12, 14, 16, 18)
```

## Edge Cases

| Scenario | Handling |
|----------|----------|
| Section with no name | Show "Section {id}" |
| Section with one station | Show label at that station |
| Overlapping sections | MapLibre handles collision |
| Very long section name | Allow full text (no truncation) |
| Section with dark color on dark basemap | White halo ensures visibility |

## Testing

### Manual Tests

1. Toggle Section Names in Display Menu
2. Zoom out below threshold, verify labels disappear
3. Zoom in above threshold, verify labels appear
4. Verify label color matches section color
5. Create unnamed section, verify "Section N" fallback
6. Change zoom threshold in Settings

### Automated Tests

```typescript
describe('SurveyLayer section labels', () => {
  it('creates label GeoJSON with correct midpoints', () => {});
  it('uses section color for text', () => {});
  it('falls back to "Section N" for unnamed', () => {});
  it('respects zoom threshold', () => {});
});
```

## Dependencies

- None (self-contained map feature)

## Acceptance Criteria

- [ ] Section names display at section midpoints
- [ ] Text color matches section color
- [ ] White halo around text for visibility
- [ ] Labels appear only above zoom threshold
- [ ] Zoom threshold configurable in Settings
- [ ] Display Menu toggle works
- [ ] Unnamed sections show "Section N"
- [ ] No excessive overlap between labels
