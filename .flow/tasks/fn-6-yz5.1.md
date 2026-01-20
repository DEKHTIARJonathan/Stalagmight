# fn-6-yz5.1 Investigate root cause of non-working Save button

## Description
# Investigate Root Cause of Non-Working Save Button

## Objective
Determine why the Save button in Edit Section and Edit Shot dialogs doesn't respond to clicks (mouse or keyboard).

## Investigation Steps

### 1. Verify button rendering
- Check if `<button>` element has correct attributes
- Verify onClick prop is being passed through Button component
- Check for any CSS that might disable pointer events

### 2. Check for event interception
- Search for global event listeners with `capture: true`
- Look for `stopPropagation()` or `stopImmediatePropagation()` calls
- Check DialogWrapper for any event blocking

### 3. Check for invisible overlays
- Inspect z-index stacking of dialog elements
- Look for absolutely positioned elements that might cover the button
- Check react-datepicker for leftover portals or overlays

### 4. Test in isolation
- Create minimal test case with just the button
- Temporarily remove DatePicker and other complex inputs
- Check if issue is specific to these dialogs or affects all dialogs

### 5. Check React DevTools
- Verify component props in React DevTools
- Check if handleSave function is defined and accessible
- Look for any React warnings or errors

## Expected Deliverable
- Root cause identified and documented
- Clear explanation of why clicks don't work
- Proposed fix strategy
## Acceptance
- [ ] TBD

## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
