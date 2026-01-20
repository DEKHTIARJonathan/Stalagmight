# Bugfix: Edit Section/Shot Dialog Save Button Not Working

## Problem

The Save button in Edit Section, Edit Shot, and Section Adjust dialogs silently fails when the section or shot ID is `0`.

**Root Cause**: JavaScript truthy/falsy check bug. The code uses `if (!sectionId) return;` which fails when `sectionId === 0` because `0` is falsy in JavaScript. The Rust backend uses IDs starting from 0, so the first section/shot is always affected.

## Affected Files

| File | Line(s) | Buggy Code | Type | Impact |
|------|---------|------------|------|--------|
| `EditSectionDialog.tsx` | 155 | `if (!sectionId) return;` | `number \| undefined` | Save fails for first section |
| `EditShotDialog.tsx` | 82 | `if (!sectionId \|\| !shotId) return;` | `number \| undefined` | Save fails for first shot/section |
| `SectionAdjustDialog.tsx` | 30, 82, 118 | `if (!sectionId) return;` | `number \| undefined` | Adjust and cancel fail |
| `DataTable.tsx` | 78 | `if (!selectedSectionId) return null;` | `number \| null` | Warnings don't render |

## Fix

Replace falsy checks with explicit runtime-safe type guards:

### For `number | undefined` (dialog data)

```typescript
// WRONG: fails when id === 0
if (!sectionId) return;

// CORRECT: runtime-safe type guard (preferred)
if (typeof sectionId !== 'number') return;

// Alternative: explicit undefined check (acceptable)
if (sectionId === undefined) return;
```

### For `number | null` (UI state like selectedSectionId)

```typescript
// WRONG: fails when id === 0
if (!selectedSectionId) return null;

// CORRECT: nullish check (catches both null and undefined)
if (selectedSectionId == null) return null;

// Alternative: explicit null check
if (selectedSectionId === null) return null;
```

**Key insight**: Use runtime-safe guards (`typeof x !== 'number'`) because `dialogData` is `Record<string, unknown>`. Pure `=== undefined` guards won't protect against `null` or wrong runtime types.

**Reference pattern**: `ConfirmDialog.tsx:18` uses correct pattern: `sectionId !== undefined && shotId !== undefined`

## SectionAdjustDialog Cancel/Revert Edge Case

The preview is debounced (150ms). `handleCancel` must clear any pending timeout before reverting:

```typescript
const handleCancel = async () => {
  // Clear pending preview timeout first
  if (previewTimeoutRef.current) {
    clearTimeout(previewTimeoutRef.current);
    previewTimeoutRef.current = null;
  }

  if (previewApplied && typeof sectionId === 'number') {
    // Revert preview...
    await projectStore.moveSection(sectionId, -parseFloat(dx || '0'), -parseFloat(dy || '0'));
  }
  closeDialog();
};
```

Similarly for `handleApply`:

```typescript
const handleApply = async () => {
  // Clear pending preview timeout
  if (previewTimeoutRef.current) {
    clearTimeout(previewTimeoutRef.current);
    previewTimeoutRef.current = null;
  }
  // ...rest of apply logic
};
```

## E2E Mock Setup for id=0 Scenarios

### Issue 1: Mock IPC doesn't produce id=0

Current mock uses `sectionCounter++` which starts at 1. Update `e2e-playwright/mocks/tauri-ipc.ts`:

```typescript
// In create_section handler, change:
sectionCounter++;  // After increment = 1, 2, 3...
// To:
const newId = sectionCounter;
sectionCounter++;  // First call returns 0, then 1, 2...
```

Or add a test fixture that seeds `currentProject` with section `id: 0`:

```typescript
// In test setup
await page.evaluate(() => {
  window.__E2E_TEST__.projectStore.setState({
    project: {
      sections: [{ id: 0, name: 'First Section', shots: [{ id: 0, ... }] }]
    }
  });
});
```

### Issue 2: Mock returns empty warnings

Add a mock path to return warnings with `section_id: 0`:

```typescript
case 'get_project_warnings':
  return [
    { section_id: 0, shot_id: 0, code: 'TEST_WARNING', message: 'Test warning', severity: 'Warning', is_resolved: false }
  ];
```

Or inject warnings via E2E hooks:

```typescript
await page.evaluate(() => {
  window.__E2E_TEST__.projectStore.setState({
    warnings: [{ section_id: 0, shot_id: 0, code: 'TEST', message: 'Test', severity: 'Warning', is_resolved: false }]
  });
});
```

### Issue 3: Warning UI testability

Add `data-testid` to warning indicators in DataTable for stable selectors:

```typescript
// In DataTable warning column
<span data-testid={`warning-${shot.id}`} title={...}>⚠️</span>
```

## Pre-fix Scan

Before implementing fixes, scan for other `!<id>` boolean checks:

```bash
rg "if \(!.*Id\)" src/components --type ts
rg "!\w+Id\b" src/components --type ts
```

Confirm the list in "Affected Files" is complete.

## Edge Cases

- First section (id=0): Most common case for new projects
- First shot (id=0): First survey shot in any section
- Both ids = 0: First shot of first section
- SectionAdjustDialog cancel: Must revert preview even when id=0, after clearing pending timeout

## Quick Commands

```bash
# Type check
pnpm tsc --noEmit

# Run dev server
./scripts/dev.sh

# Run Playwright tests
pnpm test:ui
```

## Acceptance Criteria

- [ ] Edit Section dialog saves when sectionId === 0
- [ ] Edit Shot dialog saves when sectionId === 0 and/or shotId === 0
- [ ] Section Adjust dialog applies changes when sectionId === 0
- [ ] Section Adjust dialog reverts preview on cancel when sectionId === 0 (after clearing pending timeout)
- [ ] DataTable renders warnings for section with id=0
- [ ] E2E mock updated to produce id=0 sections/shots (via fixture or counter change)
- [ ] E2E mock updated to return warnings for id=0 testing
- [ ] Warning indicators have data-testid for stable selectors
- [ ] Codebase scanned for other `!<id>` patterns (grep verified)
- [ ] E2E tests added for id=0 scenarios (fn-6-yz5.3)
- [ ] All existing Playwright tests pass
- [ ] No TypeScript errors

## References

- Correct pattern: `src/components/Dialogs/ConfirmDialog.tsx:18`
- Backend ID init: `src-tauri/src/models/project.rs:87` (next_section_id: 0)
- Shot ID init: `src-tauri/src/models/section.rs:124` (next_shot_id: 0)
