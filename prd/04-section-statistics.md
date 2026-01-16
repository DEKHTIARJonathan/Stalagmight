# PRD: Add Section Statistics Display to Import Dialog

## Overview

**Task ID:** 4
**Priority:** High
**Phase:** 1 - Import Dialog Enhancements
**Estimated Complexity:** Low

### Summary

Show live statistics (shot count and total length) in the Import Dialog footer as users enter shot data, providing immediate feedback on section progress.

## Background

Real-time statistics help users:
- Track import progress
- Catch data entry errors (unexpected totals)
- Verify section completeness before import

## Requirements

### Functional Requirements

| ID | Requirement | Priority |
|----|-------------|----------|
| F1 | Display shot count in dialog footer | Must |
| F2 | Display total length with units | Must |
| F3 | Update statistics debounced (500ms) | Must |
| F4 | Exclude virtual shots from length total | Must |
| F5 | Include rows with warnings in statistics | Must |
| F6 | Show units from config | Must |

### Non-Functional Requirements

| ID | Requirement | Priority |
|----|-------------|----------|
| NF1 | Stats calculation should not block UI | Must |
| NF2 | Debouncing should feel responsive | Should |

## User Decisions

- Minimal stats: Shot count and total length only
- Position: Footer area (below table)
- Exclude virtual shots from length totals
- Stats update debounced (500ms after user stops typing)
- Include all rows in stats (warnings just flag issues, don't exclude)

## Technical Specification

### Files to Modify

| File | Changes |
|------|---------|
| `src/components/Dialogs/ImportDialog.tsx` | Add footer stats component with debounced calculation |

### Implementation Details

1. **Stats calculation:**
   ```typescript
   interface SectionStats {
     shotCount: number;
     totalLength: number;
   }

   const calculateStats = (shots: Shot[]): SectionStats => {
     const validShots = shots.filter(s =>
       s.length > 0 && !s.is_virtual
     );

     return {
       shotCount: shots.filter(s => s.length > 0).length,
       totalLength: validShots.reduce((sum, s) => sum + (s.length || 0), 0),
     };
   };
   ```

2. **Debounced update:**
   ```typescript
   const [stats, setStats] = useState<SectionStats>({ shotCount: 0, totalLength: 0 });

   const debouncedCalculate = useMemo(
     () => debounce((shots: Shot[]) => {
       setStats(calculateStats(shots));
     }, 500),
     []
   );

   useEffect(() => {
     debouncedCalculate(shots);
     return () => debouncedCalculate.cancel();
   }, [shots, debouncedCalculate]);
   ```

3. **Display formatting:**
   ```typescript
   const formatLength = (length: number, units: 'metric' | 'imperial'): string => {
     if (units === 'metric') {
       return `${length.toFixed(1)} m`;
     }
     return `${(length * 3.28084).toFixed(1)} ft`;
   };
   ```

## UI/UX Specification

### Layout

```
┌─────────────────────────────────────────────────────────────┐
│ Import Section                                           X │
├─────────────────────────────────────────────────────────────┤
│ Section Name: [________________]                            │
│                                                             │
│ ┌───────────────────────────────────────────────────────┐  │
│ │ | From | To | Azimuth | Length | Depth | ... |        │  │
│ │ |------|----|---------│--------|-------|-----|        │  │
│ │ | 0    | 1  | 45.0    | 10.5   | -2.0  | ... |        │  │
│ │ | 1    | 2  | 90.0    | 8.2    | -3.5  | ... |        │  │
│ └───────────────────────────────────────────────────────┘  │
│                                                             │
│ ──────────────────────────────────────────────────────────  │
│ Shots: 2  |  Total Length: 18.7 m                          │
│                                                             │
│                              [Cancel]  [Import Section]     │
└─────────────────────────────────────────────────────────────┘
```

### Stats Display

- **Position**: Footer, left-aligned
- **Format**: `Shots: {count}  |  Total Length: {length} {unit}`
- **Style**: Muted text color, medium font size
- **Update**: Smooth transition (fade) when values change

### Update Behavior

- Initial load: Show "Shots: 0 | Total Length: 0.0 m"
- During typing: Values update 500ms after last keystroke
- Visual feedback: Optional subtle pulse when values update

## Edge Cases

| Scenario | Handling |
|----------|----------|
| All shots have zero length | Show "Total Length: 0.0 m" |
| All shots are virtual | shotCount includes them, length excludes |
| NaN or invalid length | Treat as 0 in sum |
| Very large totals | No maximum, display full value |
| Mixed units in data | Use config units for display |

## Testing

### Manual Tests

1. Enter multiple shots, verify stats update after typing stops
2. Mark shot as virtual, verify length excluded
3. Enter invalid data, verify still counts in shot count
4. Switch units in config, verify display updates
5. Clear all shots, verify stats reset to 0

### Automated Tests

```typescript
describe('ImportDialog section statistics', () => {
  it('calculates shot count correctly', () => {});
  it('calculates total length correctly', () => {});
  it('excludes virtual shots from length', () => {});
  it('debounces updates at 500ms', () => {});
  it('includes warning rows in stats', () => {});
  it('formats units correctly', () => {});
});
```

## Dependencies

- None (self-contained)

## Acceptance Criteria

- [ ] Stats display appears in dialog footer
- [ ] Shot count updates correctly
- [ ] Total length sums non-virtual shots
- [ ] Updates are debounced (500ms)
- [ ] Units display from config
- [ ] Rows with warnings included in stats
- [ ] Stats match section stats after import
