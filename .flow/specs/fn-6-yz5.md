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

```typescript
// WRONG: fails when id === 0
if (!sectionId) return;

// CORRECT: runtime-safe type guard
if (typeof sectionId !== 'number') return;

// For number | null:
if (selectedSectionId == null) return null;
```

## SectionAdjustDialog Cancel/Revert Edge Case

Both `handleCancel` and `handleApply` must clear the timeout FIRST:

```typescript
const handleCancel = async () => {
  if (previewTimeoutRef.current) {
    clearTimeout(previewTimeoutRef.current);
    previewTimeoutRef.current = null;
  }

  if (previewApplied && typeof sectionId === 'number') {
    await moveSection(sectionId, {
      x: -lastPreviewOffset.current.dx,
      y: -lastPreviewOffset.current.dy,
      z: 0
    });
  }
  closeDialog();
};
```

## E2E Test Setup for id=0 Scenarios

### Update tauri-ipc.ts to expose mock setter

```typescript
// In e2e-playwright/mocks/tauri-ipc.ts
(window as any).__E2E_MOCKS__ = {
  setCurrentProject: (project: any) => { currentProject = project; },
  getCurrentProject: () => currentProject,
};
```

### Full Test Pattern

```typescript
// e2e-playwright/id-zero-bug.spec.ts
import { test, expect, Page } from '@playwright/test';
import { setupTauriMocks } from './mocks/tauri-ipc';

async function createProject(page: Page, name: string) {
  const newProjectBtn = page.locator('button:has-text("New Project"), h3:has-text("New Project")').first();
  await newProjectBtn.click();
  await page.waitForSelector('.fixed.inset-0');
  await page.locator('.fixed.inset-0 input').first().fill(name);
  await page.click('.fixed.inset-0 button:has-text("Create")');
  await page.waitForSelector('canvas', { timeout: 10000 });
}

async function injectId0Fixture(page: Page) {
  await page.evaluate(() => {
    const testSection = {
      id: 0, name: 'First Section', surveyor: 'Test', date: '2026-01-20',
      color: '#4ecdc4', direction: 'in',
      shots: [{
        id: 0, azimuth_in: 90, azimuth_out: 270, length: 10,
        depth_in: 0, depth_out: -1, pitch_in: null, pitch_out: null,
        left: 1, right: 1, up: 2, down: 0.5, comment: null,
        is_virtual: false, marker_index: 0, temperature: null,
      }]
    };

    const store = (window as any).__E2E_TEST__.projectStore.getState();
    const project = { ...store.project, sections: [testSection] };
    const mockStations = [
      { station_ref: { section_id: 0, station_index: 0 }, coordinates: { x: 0, y: 0, z: 0 }, is_zero_datum: true, gps_coordinates: null, merged_with: [] },
      { station_ref: { section_id: 0, station_index: 1 }, coordinates: { x: 10, y: 0, z: 0 }, is_zero_datum: false, gps_coordinates: null, merged_with: [] },
    ];
    const mockStats = { section_count: 1, shot_count: 1, total_length: 0, min_depth: 0, max_depth: 0, station_count: 2, loop_count: 0, penetration_distance: 0 };

    (window as any).__E2E_TEST__.projectStore.setState({ project, stations: mockStations, stats: mockStats });
    if ((window as any).__E2E_MOCKS__?.setCurrentProject) {
      (window as any).__E2E_MOCKS__.setCurrentProject(project);
    }
  });
}

test.describe('ID=0 Bug Fixes', () => {
  test.beforeEach(async ({ page }) => {
    await setupTauriMocks(page);
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    await createProject(page, 'ID Zero Test');
    await injectId0Fixture(page);
  });

  test('Edit Section dialog saves when sectionId === 0', async ({ page }) => {
    await page.evaluate(() => {
      (window as any).__E2E_TEST__.uiStore.getState().openDialog('edit-section', { sectionId: 0 });
    });
    await expect(page.getByRole('dialog')).toBeVisible();
    await page.fill('[data-testid="section-name-input"]', 'Modified Section');
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByRole('dialog')).not.toBeVisible();
  });

  test('Edit Shot dialog saves when shotId === 0', async ({ page }) => {
    await page.evaluate(() => {
      (window as any).__E2E_TEST__.uiStore.getState().openDialog('edit-shot', { sectionId: 0, shotId: 0 });
    });
    await expect(page.getByRole('dialog')).toBeVisible();
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByRole('dialog')).not.toBeVisible();
  });

  test('Section Adjust dialog applies when sectionId === 0', async ({ page }) => {
    await page.evaluate(() => {
      (window as any).__E2E_TEST__.uiStore.getState().openDialog('section-adjust', { sectionId: 0 });
    });
    await expect(page.getByTestId('section-adjust-dialog')).toBeVisible();
    await page.fill('[data-testid="dx-input"]', '5');
    await page.getByRole('button', { name: 'Apply' }).click();
    await expect(page.getByTestId('section-adjust-dialog')).not.toBeVisible();
  });
});
```

### Warnings Test

```typescript
test('DataTable renders warnings for section with id=0', async ({ page }) => {
  await page.evaluate(() => {
    (window as any).__E2E_TEST__.projectStore.setState({
      warnings: [{
        section_id: 0, shot_id: 0, shot_index: 0,
        code: 'TEST_WARNING', message: 'Test warning',
        severity: 'warning', is_resolved: false,
      }]
    });
  });

  await page.click('canvas');

  // Open DataTable via setState (direct state set, not toggle)
  await page.evaluate(() => {
    (window as any).__E2E_TEST__.uiStore.setState({ dataTableOpen: true });
  });

  await page.waitForSelector('text=Data Table', { timeout: 3000 });
  const dataTableHeader = page.locator('text=Data Table').locator('..').locator('..');
  await dataTableHeader.locator('select').selectOption({ label: 'First Section' });
  await expect(page.getByTestId('warning-0-0')).toBeVisible();
});
```

### Warning UI testability

Add `data-testid` in DataTable:

```typescript
<span
  data-testid={`warning-${selectedSectionId}-${shot.id}`}
  className="text-warning cursor-help"
  title={tooltipText}
>
  ⚠️
</span>
```

## Pre-fix Scan

```bash
rg -n "if \(!\\w+Id\\b\)" src --type ts
rg -n "&&\\s*\\w+Id\\b" src --type ts
rg -n "!\\w+Id\\b" src --type ts
```

## Quick Commands

```bash
pnpm tsc --noEmit
./scripts/dev.sh
pnpm test:ui
```

## Acceptance Criteria

- [ ] Edit Section dialog saves when sectionId === 0
- [ ] Edit Shot dialog saves when sectionId === 0 and/or shotId === 0
- [ ] Section Adjust dialog applies changes when sectionId === 0
- [ ] Section Adjust dialog clears pending timeout FIRST in cancel/apply
- [ ] Section Adjust dialog reverts preview on cancel when sectionId === 0
- [ ] DataTable renders warnings for section with id=0
- [ ] E2E mock exposes `__E2E_MOCKS__.setCurrentProject` hook
- [ ] E2E tests sync mock currentProject after fixture injection
- [ ] E2E tests open DataTable via `uiStore.setState({ dataTableOpen: true })`
- [ ] Warning indicators have data-testid with section+shot IDs
- [ ] Codebase scanned for all `!<id>` patterns (grep verified)
- [ ] E2E tests added for id=0 scenarios (fn-6-yz5.3)
- [ ] All existing Playwright tests pass
- [ ] No TypeScript errors

## References

- Correct pattern: `src/components/Dialogs/ConfirmDialog.tsx:18`
- Backend ID init: `src-tauri/src/models/project.rs:87`
- Dialog keys: `src/App.tsx:550-557`
- E2E hooks: `src/main.tsx:20-23`
- Mock file: `e2e-playwright/mocks/tauri-ipc.ts`
- Helper pattern: `e2e-playwright/section-adjust-dialog.spec.ts:7-14`
