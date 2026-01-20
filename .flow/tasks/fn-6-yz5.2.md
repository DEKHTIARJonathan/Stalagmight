# fn-6-yz5.2 Fix Edit Section/Shot dialog Save button

## Description
# Fix Falsy ID Checks in Dialog Components

## Type-Aware Fix Strategy

Check TypeScript type annotation to determine correct fix:
- `number | undefined` → check `=== undefined`
- `number | null` → check `=== null`

## Changes Required

### 1. EditSectionDialog.tsx:155 (type: `number | undefined`)

```typescript
// Before
if (!sectionId) return;

// After
if (sectionId === undefined) return;
```

### 2. EditShotDialog.tsx:82 (type: `number | undefined`)

```typescript
// Before
if (!sectionId || !shotId) return;

// After
if (sectionId === undefined || shotId === undefined) return;
```

### 3. SectionAdjustDialog.tsx (type: `number | undefined`)

**Line 30** (applyPreview):
```typescript
// Before
if (!sectionId) return;

// After
if (sectionId === undefined) return;
```

**Line 82** (handleApply):
```typescript
// Before
if (!sectionId) return;

// After
if (sectionId === undefined) return;
```

**Line 118** (handleCancel reversion):
```typescript
// Before
if (previewApplied && sectionId) {

// After
if (previewApplied && sectionId !== undefined) {
```

### 4. DataTable.tsx:78 (type: `number | null`)

```typescript
// Before
if (!selectedSectionId) return null;

// After
if (selectedSectionId === null) return null;
```

**Note**: `selectedSectionId` is typed as `number | null` (not `undefined`), so check for `null` specifically.

## Verification

1. Run `pnpm tsc --noEmit` - no errors (confirms type correctness)
2. Create a new project with a single section (sectionId=0)
3. Right-click section → Edit Section → Change name → Save
4. Verify dialog closes and name is persisted
5. Repeat for Edit Shot with first shot (shotId=0)
6. Run `pnpm test:ui` - all tests pass
## Changes Required

### 1. EditSectionDialog.tsx:155

```typescript
// Before
if (!sectionId) return;

// After
if (sectionId === undefined) return;
```

### 2. EditShotDialog.tsx:82

```typescript
// Before
if (!sectionId || !shotId) return;

// After
if (sectionId === undefined || shotId === undefined) return;
```

### 3. SectionAdjustDialog.tsx (3 locations)

**Line 30** (applyPreview):
```typescript
// Before
if (!sectionId) return;

// After
if (sectionId === undefined) return;
```

**Line 82** (handleApply):
```typescript
// Before
if (!sectionId) return;

// After
if (sectionId === undefined) return;
```

**Line 118** (handleCancel reversion):
```typescript
// Before
if (previewApplied && sectionId) {

// After
if (previewApplied && sectionId !== undefined) {
```

### 4. DataTable.tsx:78

```typescript
// Before
if (!selectedSectionId) return null;

// After
if (selectedSectionId === null) return null;
```

Note: `selectedSectionId` is typed as `number | null`, so check for `null` specifically.

## Verification

1. Create a new project with a single section (sectionId=0)
2. Right-click section → Edit Section → Change name → Save
3. Verify dialog closes and name is persisted
4. Repeat for Edit Shot with first shot (shotId=0)
5. Run `pnpm tsc --noEmit` - no errors
6. Run `pnpm test:ui` - all tests pass
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
- [ ] EditSectionDialog.tsx:155 - changed to `=== undefined`
- [ ] EditShotDialog.tsx:82 - changed to `=== undefined` for both
- [ ] SectionAdjustDialog.tsx:30 - changed to `=== undefined`
- [ ] SectionAdjustDialog.tsx:82 - changed to `=== undefined`
- [ ] SectionAdjustDialog.tsx:118 - changed to `!== undefined`
- [ ] DataTable.tsx:78 - changed to `=== null` (matches type `number | null`)
- [ ] pnpm tsc --noEmit passes
- [ ] pnpm test:ui passes
- [ ] Manual test: Edit section with id=0 saves correctly
- [ ] Manual test: Edit shot with id=0 saves correctly
## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
