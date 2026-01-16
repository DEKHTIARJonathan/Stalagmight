# PRD: Add Validation Warnings to Import Dialog

## Overview

**Task ID:** 5
**Priority:** High
**Phase:** 1 - Import Dialog Enhancements
**Estimated Complexity:** Medium

### Summary

Run validation rules during import, showing inline warnings on shot rows, with configurable strict mode where errors block import.

## Background

Survey data often contains errors or anomalies:
- Negative lengths
- Unrealistic azimuths
- Missing required fields
- Inconsistent data patterns

Early validation during import prevents bad data from entering the project.

## Requirements

### Functional Requirements

| ID | Requirement | Priority |
|----|-------------|----------|
| F1 | Run ALL existing validation rules on shot data | Must |
| F2 | Display validation issues as row highlights + icons | Must |
| F3 | Validate on blur (field exit) | Must |
| F4 | Show warning summary with counts at top | Must |
| F5 | Strict mode: errors block import | Must |
| F6 | Permissive mode: allow import with warnings | Must |
| F7 | Include warning rows in stats/preview | Must |

### Non-Functional Requirements

| ID | Requirement | Priority |
|----|-------------|----------|
| NF1 | Validation should not cause UI lag | Must |
| NF2 | Visual indicators should be clear but not overwhelming | Should |

## User Decisions

- Run ALL existing validation rules during import
- In strict mode: Only errors block import (not warnings)
- Display: Row highlight + icon in first column
- Validate on blur (field exit)
- Include warning rows in stats/preview (warnings flag issues, don't exclude data)

## Technical Specification

### Files to Modify/Create

| File | Changes |
|------|---------|
| `src/utils/validation.ts` | New file: frontend validation rules |
| `src/components/Dialogs/ImportDialog.tsx` | Integrate validation, add visual indicators |
| `src/types/config.ts` | Add `strictValidation` setting |

### Validation Rules

Port from `src-tauri/src/core/validation.rs`:

```typescript
// src/utils/validation.ts

export type ValidationSeverity = 'error' | 'warning';

export interface ValidationIssue {
  field: string;
  message: string;
  severity: ValidationSeverity;
}

export const validateShot = (shot: Shot): ValidationIssue[] => {
  const issues: ValidationIssue[] = [];

  // Length validation
  if (shot.length !== null && shot.length < 0) {
    issues.push({
      field: 'length',
      message: 'Length cannot be negative',
      severity: 'error',
    });
  }

  if (shot.length !== null && shot.length > 1000) {
    issues.push({
      field: 'length',
      message: 'Unusually long shot (>1000m)',
      severity: 'warning',
    });
  }

  // Azimuth validation
  if (shot.azimuth !== null && (shot.azimuth < 0 || shot.azimuth >= 360)) {
    issues.push({
      field: 'azimuth',
      message: 'Azimuth must be 0-359.99',
      severity: 'error',
    });
  }

  // Pitch validation
  if (shot.pitch_in !== null && (shot.pitch_in < -90 || shot.pitch_in > 90)) {
    issues.push({
      field: 'pitch_in',
      message: 'Pitch must be -90 to +90',
      severity: 'error',
    });
  }

  // ... more rules

  return issues;
};
```

### Implementation Details

1. **Validation state:**
   ```typescript
   const [validationResults, setValidationResults] = useState<Map<number, ValidationIssue[]>>(
     new Map()
   );

   const handleFieldBlur = (index: number, field: string) => {
     const shot = shots[index];
     const issues = validateShot(shot);
     setValidationResults(prev => new Map(prev).set(index, issues));
   };
   ```

2. **Row rendering with validation:**
   ```typescript
   const ShotRow: React.FC<{ shot: Shot; issues: ValidationIssue[] }> = ({
     shot,
     issues
   }) => {
     const hasErrors = issues.some(i => i.severity === 'error');
     const hasWarnings = issues.some(i => i.severity === 'warning');

     return (
       <tr className={cn(
         hasErrors && 'bg-red-500/10',
         !hasErrors && hasWarnings && 'bg-yellow-500/10'
       )}>
         <td>
           {hasErrors && <ErrorIcon />}
           {!hasErrors && hasWarnings && <WarningIcon />}
         </td>
         {/* ... fields ... */}
       </tr>
     );
   };
   ```

3. **Import blocking:**
   ```typescript
   const canImport = () => {
     if (!config.strictValidation) return true;

     const allIssues = Array.from(validationResults.values()).flat();
     return !allIssues.some(i => i.severity === 'error');
   };
   ```

## UI/UX Specification

### Row Indicators

| State | Background | Icon | Tooltip |
|-------|------------|------|---------|
| Valid | None | None | - |
| Warning | Yellow 10% | ⚠️ | "Warning: {message}" |
| Error | Red 10% | ❌ | "Error: {message}" |

### Summary Banner

```
┌─────────────────────────────────────────────────────────────┐
│ ⚠️ 2 warnings, 1 error found                               │
└─────────────────────────────────────────────────────────────┘
```

### Settings UI

Add to Import Settings tab:
```
Validation Mode:
  ○ Strict (errors block import)
  ○ Permissive (allow import with warnings)
```

### Import Button State

- **Permissive mode**: Always enabled
- **Strict mode with errors**: Disabled with tooltip "Fix errors before importing"
- **Strict mode without errors**: Enabled

## Edge Cases

| Scenario | Handling |
|----------|----------|
| Multiple errors on one row | Show all in tooltip, use error color |
| Error + warning on same row | Show error color (higher priority) |
| Validation during paste | Validate all pasted rows on paste complete |
| Toggle strict mode mid-edit | Re-evaluate import button state |
| Empty required fields | Warning, not error (allow partial entry) |

## Testing

### Manual Tests

1. Enter invalid data, verify row highlighting
2. Hover over icon to see error message
3. Try to import in strict mode with errors (should block)
4. Switch to permissive mode, verify import allowed
5. Fix errors, verify highlights clear

### Automated Tests

```typescript
// src/utils/__tests__/validation.test.ts
describe('validation rules', () => {
  it('detects negative length as error', () => {});
  it('detects unrealistic length as warning', () => {});
  it('validates azimuth range', () => {});
  it('validates pitch range', () => {});
});

// Integration test
describe('ImportDialog validation', () => {
  it('shows validation icons on blur', () => {});
  it('blocks import in strict mode with errors', () => {});
  it('allows import in permissive mode', () => {});
});
```

## Dependencies

- Backend validation rules in `src-tauri/src/core/validation.rs` (reference)

## Acceptance Criteria

- [ ] Validation runs on field blur
- [ ] Error rows highlighted with red background + icon
- [ ] Warning rows highlighted with yellow background + icon
- [ ] Tooltip shows validation message on icon hover
- [ ] Summary banner shows issue counts
- [ ] Strict mode blocks import when errors exist
- [ ] Permissive mode allows import with warnings
- [ ] Settings toggle for validation mode
- [ ] Warning rows included in stats/preview
