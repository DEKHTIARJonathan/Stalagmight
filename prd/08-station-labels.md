# PRD: Add Station Labels on Map

## Overview

**Task ID:** 8
**Priority:** High
**Phase:** 2 - Map Display Features
**Estimated Complexity:** Medium

### Summary

Show station index labels on the map with configurable format, appearing at high zoom levels, and off by default.

## Background

Station labels help users identify specific survey stations without hovering. The label format is configurable to show different combinations of section ID, station index, station name, depth, etc.

## Requirements

### Functional Requirements

| ID | Requirement | Priority |
|----|-------------|----------|
| F1 | Display station labels at station points | Must |
| F2 | Configurable label format with tokens | Must |
| F3 | Off by default | Must |
| F4 | Appear at high zoom only | Must |
| F5 | Zoom threshold configurable in Settings | Must |
| F6 | Toggle via Display Menu | Must |
| F7 | Support tokens: {section}, {station}, {name}, {depth}, {azimuth}, {length} | Must |

### Non-Functional Requirements

| ID | Requirement | Priority |
|----|-------------|----------|
| NF1 | Labels should not clutter map at dense stations | Should |
| NF2 | Performance stable with many stations | Must |

## User Decisions

- Label format: Configurable (user chooses in Settings)
- Off by default
- Appear at high zoom only (threshold configurable in Settings)
- Full token support: {section}:{station}, {name}, {depth}, {azimuth}, {length}

## Technical Specification

### Files to Modify

| File | Changes |
|------|---------|
| `src/components/Map/SurveyLayer.tsx` | Add station label layer |
| `src/store/uiStore.ts` | Add `showStationLabels` toggle (default: false) |
| `src/types/config.ts` | Add `stationLabelFormat` and `stationLabelZoomThreshold` |
| `src/components/SingleSystemView/DisplayMenu.tsx` | Add toggle |

### Implementation Details

1. **Label format parsing:**
   ```typescript
   const formatStationLabel = (
     station: ComputedStation,
     format: string
   ): string => {
     return format
       .replace('{section}', String(station.section_id))
       .replace('{station}', String(station.index))
       .replace('{name}', station.name || '')
       .replace('{depth}', station.depth?.toFixed(1) || '')
       .replace('{azimuth}', station.azimuth_to?.toFixed(0) || '')
       .replace('{length}', station.length_to?.toFixed(1) || '');
   };
   ```

2. **GeoJSON source for labels:**
   ```typescript
   const stationLabelsGeoJSON: GeoJSON.FeatureCollection = {
     type: 'FeatureCollection',
     features: stations.map(station => ({
       type: 'Feature',
       geometry: {
         type: 'Point',
         coordinates: metersToMapCoords(station.x, station.y),
       },
       properties: {
         label: formatStationLabel(station, config.display.stationLabelFormat),
         section_color: getSectionColor(station.section_id),
       },
     })),
   };
   ```

3. **Symbol layer:**
   ```typescript
   map.addLayer({
     id: 'station-labels',
     type: 'symbol',
     source: 'station-labels-source',
     minzoom: config.display.stationLabelZoomThreshold,
     layout: {
       'text-field': ['get', 'label'],
       'text-size': 10,
       'text-anchor': 'bottom',
       'text-offset': [0, -0.5],
       'text-allow-overlap': false,
     },
     paint: {
       'text-color': '#333333',
       'text-halo-color': '#ffffff',
       'text-halo-width': 1,
     },
   });
   ```

4. **Default format:**
   ```typescript
   // config.ts
   stationLabelFormat: '{section}:{station}', // e.g., "1:5"
   stationLabelZoomThreshold: 17, // High zoom
   ```

## UI/UX Specification

### Label Appearance

```
          1:0
           ●───────●───────●
                  1:1     1:2
```

### Format Examples

| Format | Output |
|--------|--------|
| `{section}:{station}` | "1:5" |
| `{station}` | "5" |
| `{name}` | "Junction" |
| `{station} ({depth}m)` | "5 (-12.3m)" |
| `{section}:{station} {name}` | "1:5 Junction" |

### Display Menu Item

```
Display ▼
├─ [ ] Grid
├─ [x] Scale Bar
├─ [ ] Section Names
└─ [ ] Station Labels    <- Toggle this (off by default)
```

### Settings UI

```
Map Display Settings
├─ Station label format: [{section}:{station}] (text input)
├─ Station label zoom threshold: [17] ▼
│    (Options: 14, 15, 16, 17, 18, 19)
```

## Edge Cases

| Scenario | Handling |
|----------|----------|
| Invalid format token | Leave as literal text |
| Missing station data | Empty string for that token |
| Dense stations | MapLibre collision detection hides overlaps |
| Station without name | {name} becomes empty |
| Format with only invalid tokens | Show empty label (hidden) |

## Testing

### Manual Tests

1. Enable Station Labels in Display Menu
2. Zoom to high level, verify labels appear
3. Zoom out, verify labels disappear
4. Change format in Settings, verify update
5. Change zoom threshold, verify behavior
6. Test various format combinations

### Automated Tests

```typescript
describe('SurveyLayer station labels', () => {
  it('formats labels correctly', () => {
    expect(formatStationLabel(station, '{section}:{station}')).toBe('1:5');
  });
  it('handles missing data gracefully', () => {});
  it('respects zoom threshold', () => {});
  it('off by default', () => {});
});
```

## Dependencies

- None (self-contained map feature)

## Acceptance Criteria

- [ ] Station labels display at station points
- [ ] Off by default in Display Menu
- [ ] Appear only at high zoom (threshold configurable)
- [ ] Format configurable with token support
- [ ] All tokens work: {section}, {station}, {name}, {depth}, {azimuth}, {length}
- [ ] Dense stations don't cause excessive overlap
- [ ] Station markers and hover behavior still work
