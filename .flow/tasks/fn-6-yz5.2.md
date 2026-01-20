# fn-6-yz5.2 Fix Edit Section/Shot dialog Save button

## Description
# Fix Edit Section/Shot Dialog Save Button

## Objective
Fix the Save button so it responds to clicks and properly saves changes.

## Fix Requirements

Based on investigation findings, implement the fix that:
1. Allows mouse clicks to trigger handleSave
2. Allows keyboard Enter/Space to trigger handleSave
3. Shows loading state while saving
4. Displays errors if save fails
5. Closes dialog on successful save

## Testing the Fix

1. Open Edit Section dialog via right-click context menu
2. Change any field (name, date, color, direction)
3. Click Save - dialog should close and changes should persist
4. Reopen dialog to verify changes saved

Repeat for Edit Shot dialog with depth and other fields.

## Files to Modify
- Likely: specific file(s) identified during investigation
- Possibly: DialogWrapper.tsx, Button.tsx, or parent components

## Verification
- Manual testing of both dialogs
- Existing Playwright tests still pass
- No TypeScript errors
## Acceptance
- [ ] TBD

## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
