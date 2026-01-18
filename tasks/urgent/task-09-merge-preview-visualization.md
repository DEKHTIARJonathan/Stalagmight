# Task 09: Add Merge Preview Visualization

## Description

When "From Existing" placement is selected and stations are chosen, show a preview of how the sections will be positioned relative to each other in both the section preview (in dialog) and on the map (ghost outline).

## Files to Modify

- `src/components/Dialogs/SectionPreview.tsx`
- `src/components/Dialogs/DmpSectionConfigDialog.tsx`
- `src/components/Map/SurveyLayer.tsx`

## Implementation

### 1. Section Preview Enhancement

When From Existing is selected with valid station selections:

```tsx
interface MergePreviewProps {
  currentSection: DmpSection;
  currentStationIndex: number;
  targetSection: Section;
  targetStationIndex: number;
}
```

The preview should:
- Calculate position offset so selected stations align
- Draw both sections in correct relative positions
- Draw dotted connection line between merge stations
- Use different colors (current section color vs existing section color)

### 2. Position Calculation

```tsx
function calculateMergeOffset(
  currentSection: DmpSection,
  currentStationIndex: number,
  targetSection: Section,
  targetStationIndex: number
): { x: number; y: number } {
  // Calculate station positions for both sections
  const currentStationPos = calculateStationPosition(currentSection.shots, currentStationIndex);
  const targetStationPos = getStationPosition(targetSection, targetStationIndex);

  // Offset = target position - current position
  return {
    x: targetStationPos.x - currentStationPos.x,
    y: targetStationPos.y - currentStationPos.y,
  };
}
```

### 3. Preview Drawing

```tsx
// In SectionPreview when merge preview is active:
<g>
  {/* Existing section (gray/dimmed) */}
  <path d={existingSectionPath} stroke="#888" strokeWidth="1" fill="none" />

  {/* Current section (positioned with offset) */}
  <g transform={`translate(${offset.x}, ${offset.y})`}>
    <path d={currentSectionPath} stroke={color} strokeWidth="2" fill="none" />
  </g>

  {/* Connection line (dotted) */}
  <line
    x1={targetStationPos.x}
    y1={targetStationPos.y}
    x2={targetStationPos.x} // Same position after merge
    y2={targetStationPos.y}
    stroke="#4ecdc4"
    strokeWidth="2"
    strokeDasharray="4,4"
  />

  {/* Highlighted merge stations */}
  <circle cx={targetStationPos.x} cy={targetStationPos.y} r="6" fill="#4ecdc4" />
</g>
```

### 4. Map Ghost Outline

When From Existing placement is configured:
- Show ghost outline of current section on the map
- Position it where it will appear after merge
- Semi-transparent, dashed line style

```tsx
// In SurveyLayer.tsx
interface GhostSectionProps {
  shots: EditableShot[];
  offset: { x: number; y: number };
  color: string;
}

// Render ghost section with offset
```

### 5. Live Update

Preview updates live as user:
- Changes station selections in dropdowns
- Clicks stations in preview or table

## Acceptance Criteria

- [ ] Preview shows both sections when From Existing selected
- [ ] Sections positioned correctly relative to each other
- [ ] Connection line shown between merge stations
- [ ] Merge stations highlighted
- [ ] Map shows ghost outline of section in position
- [ ] Preview updates live as dropdowns change
- [ ] TypeScript compiles without errors

## Test Suggestions

### Unit Tests (Rust)
1. Test station position calculation from shots
2. Test merge offset calculation
3. Test shot to coordinate conversion

### Playwright Tests (3-10)
1. Test preview shows existing section when From Existing selected
2. Test preview shows current section with offset
3. Test connection line visible between merge stations
4. Test changing target station updates preview
5. Test changing source station updates preview
6. Test merge stations highlighted in preview

### WebdriverIO Tests (3-10)
1. Test merge preview with full app
2. Test map ghost outline appears
3. Test ghost outline position matches expected merge result
4. Test merged section position after import

## Done Summary
(To be filled when complete)

## Evidence
- Commits:
- Tests:
- PRs:
