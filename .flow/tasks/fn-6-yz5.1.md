# fn-6-yz5.1 Investigate root cause of non-working Save button

## Description

Investigation Complete - Root Cause Found.

### Root Cause

JavaScript truthy/falsy check bug. The code uses `if (!sectionId) return;` which fails when `sectionId === 0` because `0` is falsy in JavaScript.

### Findings

The Rust backend initializes IDs starting from 0:
- `src-tauri/src/models/project.rs:87` - `next_section_id: 0`
- `src-tauri/src/models/section.rs:124` - `next_shot_id: 0`

So the first section always has `sectionId === 0`, and the first shot always has `shotId === 0`.

### Buggy Code Locations

1. `EditSectionDialog.tsx:155` - `if (!sectionId) return;`
2. `EditShotDialog.tsx:82` - `if (!sectionId || !shotId) return;`
3. `SectionAdjustDialog.tsx:30,82,118` - `if (!sectionId) return;` (3 locations)
4. `DataTable.tsx:78` - `if (!selectedSectionId) return null;`

### Correct Pattern

See `ConfirmDialog.tsx:18`:
```typescript
if (type === 'shot' && sectionId !== undefined && shotId !== undefined)
```

### Next Step

This task is investigation only. Proceed to fn-6-yz5.2 for the fix.

## Acceptance

- [x] Root cause identified
- [x] All affected files documented
- [x] Correct fix pattern identified

## Done summary

Investigation complete. Root cause is JavaScript truthy/falsy bug where `!sectionId` returns `true` when `sectionId === 0`. Found 4 affected files with 6 total code locations to fix.

## Evidence

- Research: context-scout, practice-scout, docs-scout, memory-scout agents
- Files analyzed: EditSectionDialog.tsx, EditShotDialog.tsx, SectionAdjustDialog.tsx, DataTable.tsx, ConfirmDialog.tsx
