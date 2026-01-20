# Bugfix: Edit Section/Shot Dialog Save Button Not Working

## Problem

The Save button in both Edit Section and Edit Shot dialogs is non-functional. When users make changes (date, depth, name, or any field) and click Save, nothing happens:

1. **No visual feedback** - button doesn't show any click response
2. **No loading state** - "Saving..." text never appears
3. **No error messages** - no errors displayed in dialog or console
4. **Dialog remains open** - doesn't close after clicking Save
5. **Changes not persisted** - values not saved to backend

This affects both dialogs accessed via:
- Right-click context menu → Edit Section / Edit Shot
- Any other access points (detail panel edit button, etc.)

The dialogs themselves render correctly - section/shot data loads, X button works, clicking backdrop works.

## Investigation Findings

Thorough debugging revealed:
- Button element renders correctly as `<button>`
- DevTools shows no response when button is clicked
- Mouse clicks don't work
- Keyboard (Enter/Space on focused button) doesn't work
- TypeScript compilation succeeds with no errors
- Clean rebuild doesn't fix the issue
- Select tool is active (zoom tool handlers not interfering)
- No console errors when clicking

This suggests the button's event handlers are not being attached or something is preventing event propagation.

## Root Cause Hypothesis

Most likely causes (to investigate):
1. **React event handler not attached** - onClick prop not reaching the button
2. **Invisible overlay blocking clicks** - some element positioned over the button
3. **CSS pointer-events issue** - button or ancestor has pointer-events: none
4. **Capture phase event blocker** - global handler stopping events before they reach button
5. **Component render issue** - button rendered in unexpected state

## Affected Files

- `src/components/Dialogs/EditSectionDialog.tsx` - lines 320-321 (Save button)
- `src/components/Dialogs/EditShotDialog.tsx` - lines 297-298 (Save button)
- `src/components/common/Button.tsx` - button component
- `src/components/Dialogs/DialogWrapper.tsx` - dialog container

## Quick Commands

```bash
# Type check
pnpm tsc --noEmit

# Run dev server
./scripts/dev.sh

# Run Playwright tests for dialogs
pnpm test:ui -- --grep "edit.*dialog"
```

## Acceptance Criteria

- [ ] Edit Section dialog Save button works (closes dialog, persists changes)
- [ ] Edit Shot dialog Save button works (closes dialog, persists changes)
- [ ] Save button shows loading state while saving
- [ ] Errors display in dialog if save fails
- [ ] Changes persist and are visible when dialog is reopened
- [ ] All existing Playwright tests pass
- [ ] No TypeScript errors
