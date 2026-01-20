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
```

### For `number | null` (UI state like selectedSectionId)

```typescript
// WRONG: fails when id === 0
if (!selectedSectionId) return null;

// CORRECT: nullish check (catches both null and undefined)
if (selectedSectionId == null) return null;
```

**Reference pattern**: `ConfirmDialog.tsx:18` uses correct pattern: `sectionId !== undefined && shotId !== undefined`

## SectionAdjustDialog Cancel/Revert Edge Case

The preview is debounced (150ms). Both `handleCancel` and `handleApply` must clear the timeout FIRST (before any early returns):

```typescript
// FIXED handleCancel:
const handleCancel = async () => {
  // Clear pending preview timeout FIRST (before any other logic)
  if (previewTimeoutRef.current) {
    clearTimeout(previewTimeoutRef.current);
    previewTimeoutRef.current = null;
  }

  // Use typeof for id=0 safety (was: previewApplied && sectionId)
  if (previewApplied && typeof sectionId === 'number') {
    await moveSection(sectionId, {
      x: -lastPreviewOffset.current.dx,
      y: -lastPreviewOffset.current.dy,
      z: 0
    });
  }
  closeDialog();
};

// FIXED handleApply:
const handleApply = async () => {
  // Clear pending preview timeout FIRST (even before early return)
  if (previewTimeoutRef.current) {
    clearTimeout(previewTimeoutRef.current);
    previewTimeoutRef.current = null;
  }

  if (typeof sectionId !== 'number') return;  // was: if (!sectionId)

  // ...rest of apply logic unchanged
};

// FIXED applyPreview:
const applyPreview = useCallback(async (newDx: number, newDy: number) => {
  if (typeof sectionId !== 'number') return;  // was: if (!sectionId)
  // ...rest unchanged
}, [sectionId, moveSection]);
```

## E2E Test Setup for id=0 Scenarios

### Strategy: Keep tests self-contained with mock-aligned data

The mock `get_project_state` generates stations/stats from `currentProject`. To avoid inconsistency on `refreshProjectState()`:

1. Set fixture data that matches what mock would generate
2. Use `setView('single')` to ensure dialogs are available
3. Use `(window as any)` for type safety in evaluate calls

### Full Test Setup Pattern

```typescript
// e2e-playwright/tests/id-zero-bug.spec.ts
import { test, expect } from '@playwright/test';
import { createAndOpenProject } from './helpers/project-helpers';

test.describe('ID=0 Bug Fixes', () => {
  test.beforeEach(async ({ page }) => {
    // Use existing helper to create project (puts app in SingleSystemView)
    await createAndOpenProject(page, 'ID Zero Test');
  });

  test('Edit Section dialog saves when sectionId === 0', async ({ page }) => {
    // Inject fixture with id=0 (matching mock's expected shape)
    await page.evaluate(() => {
      const testSection = {
        id: 0,
        name: 'First Section',
        surveyor: 'Test Surveyor',
        date: '2026-01-20',
        color: '#4ecdc4',
        direction: 'in',
        shots: [{
          id: 0,
          azimuth_in: 90,
          azimuth_out: 270,
          length: 10,
          depth_in: 0,
          depth_out: -1,
          pitch_in: null,
          pitch_out: null,
          left: 1, right: 1, up: 2, down: 0.5,
          comment: null,
          is_virtual: false,
          marker_index: 0,
          temperature: null,
        }]
      };

      // Get current project and replace first section with id=0 fixture
      const store = (window as any).__E2E_TEST__.projectStore.getState();
      const project = { ...store.project, sections: [testSection] };

      // Mock generates stations as: section.shots.length + 1 per section
      // with x = station_index * 10, y = 0, z = 0
      const mockStations = [
        { station_ref: { section_id: 0, station_index: 0 }, coordinates: { x: 0, y: 0, z: 0 }, is_zero_datum: true, gps_coordinates: null, merged_with: [] },
        { station_ref: { section_id: 0, station_index: 1 }, coordinates: { x: 10, y: 0, z: 0 }, is_zero_datum: false, gps_coordinates: null, merged_with: [] },
      ];

      const mockStats = {
        section_count: 1,
        shot_count: 1,
        total_length: 0,
        min_depth: 0,
        max_depth: 0,
        station_count: 2,
        loop_count: 0,
        penetration_distance: 0,
      };

      (window as any).__E2E_TEST__.projectStore.setState({
        project,
        stations: mockStations,
        stats: mockStats,
      });
    });

    // Open Edit Section dialog for section id=0
    await page.evaluate(() => {
      (window as any).__E2E_TEST__.uiStore.getState().openDialog('edit-section', { sectionId: 0 });
    });

    // Wait for dialog
    await expect(page.getByTestId('edit-section-dialog')).toBeVisible();

    // Modify something and save
    await page.fill('[data-testid="section-name-input"]', 'Modified Section');
    await page.click('[data-testid="save-button"]');

    // Verify dialog closed (save succeeded)
    await expect(page.getByTestId('edit-section-dialog')).not.toBeVisible();
  });

  // Similar tests for edit-shot and section-adjust...
});
```

### Warnings Test

```typescript
test('DataTable renders warnings for section with id=0', async ({ page }) => {
  // First set up project with id=0 as above, then:
  await page.evaluate(() => {
    (window as any).__E2E_TEST__.projectStore.setState({
      warnings: [{
        section_id: 0,
        shot_id: 0,
        shot_index: 0,
        code: 'TEST_WARNING',
        message: 'Test warning for shot 0',
        severity: 'warning',
        is_resolved: false,
      }]
    });
  });

  // Select section 0 to show in DataTable
  await page.evaluate(() => {
    (window as any).__E2E_TEST__.uiStore.getState().setSelectedSection(0);
  });

  // Verify warning indicator visible (with data-testid)
  await expect(page.getByTestId('warning-0-0')).toBeVisible();
});
```

### Warning UI testability

Add `data-testid` with section and shot IDs:

```typescript
// In DataTable warning column rendering
<span
  data-testid={`warning-${selectedSectionId}-${shot.id}`}
  className="text-warning cursor-help"
  title={tooltipText}
>
  ⚠️
</span>
```

## Pre-fix Scan

Scan entire `src` directory for all ID-related falsy checks:

```bash
# Falsy ID checks with !
rg -n "if \(!\\w+Id\\b\)" src --type ts

# Boolean AND with ID (misses id=0)
rg -n "&&\\s*\\w+Id\\b" src --type ts

# Explicit !id patterns
rg -n "!\\w+Id\\b" src --type ts

# OR with falsy ID checks
rg -n "\\|\\|\\s*!\\w+Id\\b" src --type ts
```

Record results and confirm the list in "Affected Files" is complete.

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
- [ ] Section Adjust dialog clears pending timeout FIRST in cancel/apply
- [ ] Section Adjust dialog reverts preview on cancel when sectionId === 0
- [ ] DataTable renders warnings for section with id=0
- [ ] E2E tests use createAndOpenProject helper (ensures SingleSystemView)
- [ ] E2E fixture data matches mock's generated stations/stats shape
- [ ] E2E tests use `(window as any)` for type-safe evaluate calls
- [ ] E2E tests use correct dialog keys: 'edit-section', 'edit-shot', 'section-adjust'
- [ ] Warning indicators have data-testid with section+shot IDs
- [ ] Codebase scanned for all `!<id>` patterns in src (grep verified)
- [ ] E2E tests added for id=0 scenarios (fn-6-yz5.3)
- [ ] All existing Playwright tests pass
- [ ] No TypeScript errors

## References

- Correct pattern: `src/components/Dialogs/ConfirmDialog.tsx:18`
- Backend ID init: `src-tauri/src/models/project.rs:87` (next_section_id: 0)
- Shot ID init: `src-tauri/src/models/section.rs:124` (next_shot_id: 0)
- TypeScript types: `src/types/project.ts` (Project:158, Shot:9, Section:64)
- Dialog keys: `src/App.tsx:550-557` ('edit-section', 'edit-shot', 'section-adjust')
- E2E hooks: `src/main.tsx:20-23` (window.__E2E_TEST__)
- Mock station generation: `e2e-playwright/mocks/tauri-ipc.ts:233-249`
