# PRD: Add Pitch Fields to Manual Import Dialog

## Overview

**Task ID:** 2
**Priority:** High
**Phase:** 1 - Import Dialog Enhancements
**Estimated Complexity:** Low

### Summary

Add pitch_in and pitch_out input fields (-90 to 90 degrees) to the manual Import Dialog, with auto-sync functionality where pitch_out copies from pitch_in when left empty.

## Background

Pitch (inclination) measurements represent the vertical angle of a shot:
- **pitch_in**: Inclination reading at the "from" station
- **pitch_out**: Inclination reading at the "to" station

Many surveys only record pitch_in, with pitch_out assumed to be the same. This feature supports both use cases.

## Requirements

### Functional Requirements

| ID | Requirement | Priority |
|----|-------------|----------|
| F1 | Add pitch_in and pitch_out numeric inputs to shots table | Must |
| F2 | Validate range: -90 to +90 degrees | Must |
| F3 | Auto-copy pitch_out from pitch_in when pitch_out is empty | Must |
| F4 | Stop auto-sync when user manually edits pitch_out | Must |
| F5 | Display 2 decimal places, store full precision | Must |
| F6 | Hidden by default (enable via Settings) | Must |
| F7 | Empty fields map to `null` | Must |

### Non-Functional Requirements

| ID | Requirement | Priority |
|----|-------------|----------|
| NF1 | Auto-sync should be instant (no perceptible delay) | Must |
| NF2 | Manual edit detection should be reliable | Must |

## User Decisions

- pitch_out auto-copies from pitch_in if left empty
- Hidden by default (show if user enables in Settings)
- Display 2 decimal places, store full internal value
- Degrees only (no other units)
- Stop auto-sync when pitch_out is manually edited (becomes independent)

## Technical Specification

### Files to Modify

| File | Changes |
|------|---------|
| `src/components/Dialogs/ImportDialog.tsx` | Add pitch input columns with auto-sync logic |
| `src/types/config.ts` | Add `showPitchFields` setting |

### Implementation Details

1. **State tracking for auto-sync:**
   ```typescript
   interface ShotRowState {
     pitchOutManuallyEdited: boolean;
   }

   const [rowStates, setRowStates] = useState<Map<number, ShotRowState>>();
   ```

2. **Auto-sync logic:**
   ```typescript
   const handlePitchInChange = (index: number, value: string) => {
     const numValue = parseFloat(value) || null;
     updateShot(index, { pitch_in: numValue });

     // Auto-sync if pitch_out not manually edited
     if (!rowStates.get(index)?.pitchOutManuallyEdited) {
       updateShot(index, { pitch_out: numValue });
     }
   };

   const handlePitchOutFocus = (index: number) => {
     setRowStates(prev => new Map(prev).set(index, { pitchOutManuallyEdited: true }));
   };
   ```

3. **Validation:**
   ```typescript
   const validatePitch = (value: number | null): ValidationResult => {
     if (value === null) return { valid: true };
     if (value < -90 || value > 90) {
       return { valid: false, warning: 'Pitch must be between -90 and +90 degrees' };
     }
     return { valid: true };
   };
   ```

4. **Display formatting:**
   ```typescript
   const formatPitch = (value: number | null): string => {
     if (value === null) return '';
     return value.toFixed(2);
   };
   ```

### Data Flow

```
User enters pitch_in → Auto-copy to pitch_out (if not edited) →
User focuses pitch_out → Mark as manually edited → Stop auto-sync
```

## UI/UX Specification

### Layout

```
| ... | Depth | Pitch In | Pitch Out | L | R | U | D | ... |
|-----|-------|----------|-----------|---|---|---|---|-----|
| ... | -2.0  | 15.50    | 15.50     |...|...|...|...|     |
```

### Input Properties

- **Type**: Text input (allows negative values)
- **Min**: -90
- **Max**: 90
- **Step**: 0.01
- **Width**: ~70px each
- **Placeholder**: "0.00"

### Validation Display

- Out-of-range values: Yellow warning icon with tooltip
- Empty: Allowed, no indicator
- Auto-synced: Subtle indicator (e.g., lighter text or small sync icon)

### Settings UI

Add to Import Settings tab:
```
[ ] Show pitch fields in Import Dialog
```

## Edge Cases

| Scenario | Handling |
|----------|----------|
| pitch_in blank, user enters pitch_out | pitch_out becomes independent |
| pitch_in 0, pitch_out blank | Auto-copy 0 to pitch_out |
| Out-of-range value | Show warning, allow entry |
| Paste row with pitch values | Both fields populated, pitch_out marked as edited |
| Clear pitch_in after pitch_out edited | pitch_out remains unchanged |

## Testing

### Manual Tests

1. Enter pitch_in, verify auto-copies to pitch_out
2. Edit pitch_out manually, verify auto-sync stops
3. Enter out-of-range values (-95, +100), verify warnings
4. Toggle visibility in Settings
5. Import and verify pitch values saved

### Automated Tests

```typescript
describe('ImportDialog pitch fields', () => {
  it('auto-copies pitch_in to pitch_out', () => {});
  it('stops auto-sync when pitch_out focused', () => {});
  it('validates -90 to +90 range', () => {});
  it('displays 2 decimal places', () => {});
  it('stores full precision internally', () => {});
});
```

## Dependencies

- Task 1 (LRUD fields) should be done first or in parallel (shared visibility Settings pattern)

## Acceptance Criteria

- [ ] pitch_in and pitch_out columns appear when enabled in Settings
- [ ] Auto-sync copies pitch_in to pitch_out when pitch_out is empty
- [ ] Manual edit of pitch_out stops auto-sync for that row
- [ ] Values outside -90 to +90 show warning
- [ ] Display shows 2 decimal places
- [ ] Empty fields become `null` in imported data
- [ ] Hidden by default in Settings
