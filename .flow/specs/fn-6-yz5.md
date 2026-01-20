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

Replace falsy checks with explicit nullish checks appropriate to the type:

### For `number | undefined` (dialog data)

```typescript
// WRONG: fails when id === 0
if (!sectionId) return;

// CORRECT: only fails when id is undefined
if (sectionId === undefined) return;
```

### For `number | null` (UI state like selectedSectionId)

```typescript
// WRONG: fails when id === 0
if (!selectedSectionId) return null;

// CORRECT: only fails when id is null
if (selectedSectionId === null) return null;
```

**Key insight**: Check the TypeScript type annotation to determine correct fix:
- `number | undefined` → check `=== undefined`
- `number | null` → check `=== null`
- `number | null | undefined` → use nullish check `== null` (catches both)

**Reference pattern**: `ConfirmDialog.tsx:18` uses correct pattern: `sectionId !== undefined && shotId !== undefined`

## Edge Cases

- First section (id=0): Most common case for new projects
- First shot (id=0): First survey shot in any section
- Both ids = 0: First shot of first section
- SectionAdjustDialog cancel: Must revert preview even when id=0

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
- [ ] Section Adjust dialog reverts preview on cancel when sectionId === 0
- [ ] DataTable renders warnings for section with id=0
- [ ] E2E tests added for id=0 scenarios (fn-6-yz5.3)
- [ ] All existing Playwright tests pass
- [ ] No TypeScript errors

## References

- Correct pattern: `src/components/Dialogs/ConfirmDialog.tsx:18`
- Backend ID init: `src-tauri/src/models/project.rs:87` (next_section_id: 0)
- Shot ID init: `src-tauri/src/models/section.rs:124` (next_shot_id: 0)
