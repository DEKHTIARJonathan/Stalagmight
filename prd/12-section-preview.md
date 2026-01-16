# PRD: Add Live Section Preview to Import Dialog

## Overview

**Task ID:** 12
**Priority:** High
**Phase:** 3 - GPS & Placement
**Estimated Complexity:** Medium

### Summary

Add an SVG preview panel on the left side of the Import Dialog showing the section shape as users enter shot data, displaying station dots without labels and rendering valid shots even when some data is invalid.

## Background

A live preview helps users visualize their survey data entry, catching errors like incorrect azimuths that result in unexpected shapes. The preview provides immediate visual feedback.

## Requirements

### Functional Requirements

| ID | Requirement | Priority |
|----|-------------|----------|
| F1 | Display SVG preview on left side of dialog | Must |
| F2 | Update preview as shot data changes | Must |
| F3 | Show station dots (no labels) | Must |
| F4 | Render valid shots even with some invalid data | Must |
| F5 | Show all shots at once (not just selected) | Must |
| F6 | Centerline only (no LRUD outline) | Must |
| F7 | Scale to fit viewbox | Must |

### Non-Functional Requirements

| ID | Requirement | Priority |
|----|-------------|----------|
| NF1 | Preview updates should be smooth | Should |
| NF2 | Large surveys should not cause lag | Should |

## User Decisions

- Preview position: Left side of dialog
- Stations display: Dots only (no labels)
- Invalid data handling: Show partial preview (render valid shots)
- Centerline only; LRUD display deferred to future version
- Preview scope: Show all shots at once (not just selected row)

## Technical Specification

### Files to Create/Modify

| File | Changes |
|------|---------|
| `src/components/Dialogs/SectionPreview.tsx` | New: SVG preview component |
| `src/components/Dialogs/ImportDialog.tsx` | Integrate preview panel |

### Implementation Details

1. **Preview component:**
   ```typescript
   // src/components/Dialogs/SectionPreview.tsx

   interface SectionPreviewProps {
     shots: Shot[];
     sectionColor?: string;
     width?: number;
     height?: number;
   }

   export const SectionPreview: React.FC<SectionPreviewProps> = ({
     shots,
     sectionColor = '#3b82f6',
     width = 200,
     height = 200,
   }) => {
     const { stations, lines, bounds } = useMemo(() => {
       const validShots = shots.filter(s =>
         s.azimuth !== null && s.length !== null && s.length > 0
       );

       if (validShots.length === 0) {
         return { stations: [], lines: [], bounds: null };
       }

       // Calculate station positions
       const stations: { x: number; y: number }[] = [{ x: 0, y: 0 }];
       let x = 0, y = 0;

       for (const shot of validShots) {
         const radians = (shot.azimuth! * Math.PI) / 180;
         x += shot.length! * Math.sin(radians);
         y += shot.length! * Math.cos(radians);
         stations.push({ x, y });
       }

       // Build line segments
       const lines = stations.slice(0, -1).map((start, i) => ({
         x1: start.x,
         y1: start.y,
         x2: stations[i + 1].x,
         y2: stations[i + 1].y,
       }));

       // Calculate bounds
       const xs = stations.map(s => s.x);
       const ys = stations.map(s => s.y);
       const bounds = {
         minX: Math.min(...xs),
         maxX: Math.max(...xs),
         minY: Math.min(...ys),
         maxY: Math.max(...ys),
       };

       return { stations, lines, bounds };
     }, [shots]);

     if (!bounds) {
       return (
         <div className="flex items-center justify-center" style={{ width, height }}>
           <span className="text-muted">Enter shot data to see preview</span>
         </div>
       );
     }

     // Calculate viewBox with padding
     const padding = 10;
     const dataWidth = bounds.maxX - bounds.minX || 1;
     const dataHeight = bounds.maxY - bounds.minY || 1;
     const scale = Math.min(
       (width - padding * 2) / dataWidth,
       (height - padding * 2) / dataHeight
     );

     const viewBox = [
       bounds.minX - padding / scale,
       -(bounds.maxY + padding / scale), // Flip Y for SVG
       dataWidth + (padding * 2) / scale,
       dataHeight + (padding * 2) / scale,
     ].join(' ');

     return (
       <svg width={width} height={height} viewBox={viewBox}>
         <g transform="scale(1, -1)">
           {/* Lines */}
           {lines.map((line, i) => (
             <line
               key={`line-${i}`}
               x1={line.x1}
               y1={line.y1}
               x2={line.x2}
               y2={line.y2}
               stroke={sectionColor}
               strokeWidth={2 / scale}
             />
           ))}

           {/* Stations */}
           {stations.map((station, i) => (
             <circle
               key={`station-${i}`}
               cx={station.x}
               cy={station.y}
               r={4 / scale}
               fill={sectionColor}
             />
           ))}
         </g>
       </svg>
     );
   };
   ```

2. **Integration with ImportDialog:**
   ```typescript
   // In ImportDialog.tsx
   <div className="flex gap-4">
     {/* Preview on left */}
     <div className="w-[200px] shrink-0 border rounded p-2">
       <h4 className="text-sm font-medium mb-2">Preview</h4>
       <SectionPreview
         shots={shots}
         sectionColor={sectionColor}
       />
     </div>

     {/* Table on right */}
     <div className="flex-1">
       {/* Shot table */}
     </div>
   </div>
   ```

3. **Handling invalid data:**
   ```typescript
   // Filter to valid shots for preview, preserving order
   const validShots = shots.filter(s =>
     s.azimuth !== null &&
     !isNaN(s.azimuth) &&
     s.length !== null &&
     !isNaN(s.length) &&
     s.length > 0
   );
   ```

## UI/UX Specification

### Layout

```
┌─────────────────────────────────────────────────────────────────┐
│ Import Section                                               X │
├─────────────────────────────────────────────────────────────────┤
│ Section Name: [________________]                                │
│                                                                 │
│ ┌─────────┐ ┌──────────────────────────────────────────────┐   │
│ │ Preview │ │ | From | To | Azimuth | Length | Depth | ... │   │
│ │         │ │ |------|----|---------│--------|-------|-----|   │
│ │   ●──●  │ │ | 0    | 1  | 45.0    | 10.5   | -2.0  | ... │   │
│ │   │     │ │ | 1    | 2  | 90.0    | 8.2    | -3.5  | ... │   │
│ │   ●──●  │ │ | 2    | 3  | invalid | 5.0    | -4.0  | ... │   │
│ │         │ └──────────────────────────────────────────────┘   │
│ └─────────┘                                                     │
│                                                                 │
│ Shots: 3  |  Total Length: 23.7 m                              │
└─────────────────────────────────────────────────────────────────┘
```

### Preview States

| State | Display |
|-------|---------|
| No shots | "Enter shot data to see preview" |
| Some valid shots | Render valid shots, skip invalid |
| All invalid | "No valid shots to preview" |
| Single shot | One line segment with two dots |

### Styling

- **Background**: Subtle grid or solid light gray
- **Lines**: Section color, 2px width
- **Stations**: Section color, 4px radius dots
- **Border**: Rounded, subtle shadow

## Edge Cases

| Scenario | Handling |
|----------|----------|
| Zero length shot | Skip in preview |
| Invalid azimuth | Skip that shot in preview |
| Very long section | Scale to fit viewbox |
| Narrow section | Scale appropriately |
| Loop (returns to start) | Render normally (may overlap) |
| Single station | Show single dot |

## Testing

### Manual Tests

1. Enter shots, verify preview updates
2. Enter invalid azimuth, verify shot skipped in preview
3. Verify station dots visible
4. Verify scaling works for various sizes
5. Clear all shots, verify empty state

### Automated Tests

```typescript
describe('SectionPreview', () => {
  it('renders valid shots', () => {});
  it('skips invalid shots', () => {});
  it('scales to fit viewbox', () => {});
  it('shows empty state with no shots', () => {});
  it('renders single shot correctly', () => {});
});
```

## Dependencies

- None (self-contained component)

## Acceptance Criteria

- [ ] Preview displays on left side of Import Dialog
- [ ] Updates as shot data is entered
- [ ] Shows station dots without labels
- [ ] Renders valid shots even with invalid data present
- [ ] Shows all shots (not just selected)
- [ ] Scales to fit preview area
- [ ] Shows appropriate empty state messages
