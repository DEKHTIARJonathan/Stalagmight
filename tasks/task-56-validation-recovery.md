# Task 56: Validation Error Recovery

## Overview
Clear validation error states gracefully and allow retry. Provide both individual and batch error clearing without blocking UI on validation errors.

## Priority
Low-Medium - Phase G (Error Handling)

## Risk Level
Low-Medium

## Dependencies
- Existing validation system

## Files to Modify
- `src/components/SingleSystemView/DetailPanel.tsx` - Error clearing
- `src/store/validationStore.ts` - Error state management
- `src/components/common/ValidationError.tsx` - Error display component

## Specifications

### Error Display
```tsx
<ValidationError
  field="azimuth"
  message="Azimuth must be between 0 and 360"
  onClear={() => clearError('azimuth')}
  showClear={true}
/>
```

### Clear Options
1. **Individual Clear**: X button on each error
2. **Clear All**: "Clear All Errors" button
3. **Auto-clear**: When field is corrected

### Error State Persistence
- Cleared errors stay cleared
- Don't re-validate cleared errors automatically
- User must re-trigger validation

### Non-Blocking Behavior
- Validation errors shown inline
- Don't prevent user from continuing
- Errors are warnings, not blocks (configurable)

### Retry Mechanism
```tsx
<ValidationPanel>
  <ValidationError ... />
  <ValidationError ... />
  <div className="actions">
    <button onClick={clearAllErrors}>Clear All</button>
    <button onClick={revalidate}>Revalidate</button>
  </div>
</ValidationPanel>
```

### Error Types
| Type | Behavior |
|------|----------|
| Blocking Error | Prevents save/export |
| Warning | Shows but allows continue |
| Info | Informational only |

### Configurable Severity
Per-validation-type severity in settings:
- Shot length out of range: Warning
- Missing required field: Error
- Unusual value: Info

### State Recovery
- Errors don't persist across sessions
- Fresh validation on project open
- Export triggers fresh validation

## Acceptance Criteria
- [ ] Individual error clear works
- [ ] "Clear All" button works
- [ ] Cleared errors stay cleared
- [ ] Non-blocking validation
- [ ] Revalidate button works
- [ ] TypeScript types pass
- [ ] Tests pass

## Test Requirements

### Playwright Tests (Mocked IPC)
1. Test ValidationError component renders with clear button
2. Test clicking X clears individual error
3. Test "Clear All" button clears all errors
4. Test "Revalidate" button triggers fresh validation
5. Test cleared errors stay cleared
6. Test validation errors shown inline (non-blocking)
7. Test error severity indicator (error/warning/info)
8. Test errors don't prevent editing

### WebdriverIO Tests (Full App)
1. Test error clear with real validation
2. Test revalidate with real project
3. Test errors don't persist across sessions
4. Test export triggers fresh validation
5. Test severity-based behavior (blocking vs warning)

## Edge Cases
- Clear during active validation
- Clear error that reappears on revalidate
- Many errors (scrolling)
- Error in collapsed panel
