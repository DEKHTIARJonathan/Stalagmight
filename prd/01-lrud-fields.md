# PRD: Add LRUD Fields to Manual Import Dialog

## Overview

**Task ID:** 1
**Priority:** High
**Phase:** 1 - Import Dialog Enhancements
**Estimated Complexity:** Low-Medium

### Summary

Add Left/Right/Up/Down (LRUD) numeric input fields to shot rows in the manual Import Dialog, enabling users to capture passage dimension data during survey entry.

## Background

LRUD measurements are standard cave survey data representing passage dimensions at each station:
- **Left/Right**: Horizontal passage width
- **Up/Down**: Vertical passage height

Currently, the Import Dialog only captures core shot data (azimuth, length, depth). Adding LRUD support allows users to enter complete survey data during import.

## Requirements

### Functional Requirements

| ID | Requirement | Priority |
|----|-------------|----------|
| F1 | Add 4 numeric input columns (L, R, U, D) to the shots table | Must |
| F2 | Each LRUD field is independent and optional | Must |
| F3 | Support positive numeric values with no maximum constraint | Must |
| F4 | Display units from config (metric/imperial) | Must |
| F5 | Empty fields map to `null`, not `0` | Must |
| F6 | Field visibility controlled via Settings | Must |
| F7 | Preserve existing LRUD values when fields are hidden | Must |

### Non-Functional Requirements

| ID | Requirement | Priority |
|----|-------------|----------|
| NF1 | Fields should not crowd the dialog layout excessively | Must |
| NF2 | Tab navigation should work across all fields | Should |
| NF3 | Performance should remain smooth with 100+ rows | Should |

## User Decisions

- No maximum value constraint (allow any positive value)
- When fields hidden via Settings, preserve existing values
- No "copy from previous" feature
- Display as 4 separate columns (L | R | U | D)
- All LRUD fields optional (each independent, any can be empty)

## Technical Specification

### Files to Modify

| File | Changes |
|------|---------|
| `src/components/Dialogs/ImportDialog.tsx` | Add LRUD input columns to shots table |
| `src/types/project.ts` | Verify Shot type includes LRUD fields |
| `src/types/config.ts` | Add `showLrudFields` setting |
| `src/store/configStore.ts` | Add LRUD visibility state |

### Implementation Details

1. **Update `createEmptyShot` function:**
   ```typescript
   const createEmptyShot = (): Shot => ({
     // ... existing fields
     left: null,
     right: null,
     up: null,
     down: null,
   });
   ```

2. **Add LRUD columns to table:**
   - Position after depth column
   - Use compact numeric inputs (width ~60px each)
   - Show column headers with unit abbreviation

3. **Config setting:**
   ```typescript
   interface Config {
     import: {
       showLrudFields: boolean; // default: true
     }
   }
   ```

4. **Value handling:**
   - Parse input as positive float
   - Empty string → `null`
   - Negative values → show warning, allow entry
   - Show units based on `config.general.units`

### Data Flow

```
User enters LRUD → Local state update → createSection command includes LRUD →
Backend stores in SQLite → DataTable/DetailPanel display
```

## UI/UX Specification

### Layout

```
| From | To | Azimuth | Length | Depth | L | R | U | D | Actions |
|------|----|---------│--------|-------|---|---|---|---|---------|
| 0    | 1  | 45.0    | 10.5   | -2.0  |1.2|1.5|3.0|0.8| [x]     |
```

### Behavior

- **Tab order**: Sequential across all fields in row
- **Validation**:
  - On blur, validate positive number
  - Show warning icon for negative values
  - No blocking validation (permissive)
- **Hidden fields**: When visibility toggled off in Settings, columns hide but data preserved

### Settings UI

Add to Import Settings tab:
```
[ ] Show LRUD fields in Import Dialog
```

## Edge Cases

| Scenario | Handling |
|----------|----------|
| Very large values (e.g., 999999) | Allow without restriction |
| Decimal precision | Allow any precision, display 2 decimals |
| Copy/paste with LRUD | Include LRUD in paste handling |
| Import file with LRUD | Parse and populate fields |
| Hidden fields during import | Preserve any existing values |

## Testing

### Manual Tests

1. Enter LRUD values in Import Dialog, import section
2. Verify values appear in DataTable and DetailPanel
3. Toggle LRUD visibility in Settings, reopen dialog
4. Verify hidden columns don't lose data
5. Test with metric and imperial units

### Automated Tests

```typescript
// src/components/Dialogs/__tests__/ImportDialog.test.tsx
describe('ImportDialog LRUD fields', () => {
  it('renders LRUD columns when enabled', () => {});
  it('hides LRUD columns when disabled', () => {});
  it('preserves LRUD values when columns hidden', () => {});
  it('maps empty inputs to null', () => {});
  it('displays correct units', () => {});
});
```

## Dependencies

- None (self-contained frontend change)

## Acceptance Criteria

- [ ] 4 LRUD columns appear in Import Dialog shots table
- [ ] Each field accepts positive numeric values
- [ ] Empty fields become `null` in imported data
- [ ] Units display correctly based on config
- [ ] Settings toggle controls field visibility
- [ ] Hidden fields preserve existing values
- [ ] Imported LRUD data appears in DataTable and DetailPanel
