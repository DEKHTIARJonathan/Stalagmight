# Task 18: Implement Error Blocking Logic

## Description

Implement the error detection and blocking logic for the Import button. Errors include: invalid data, missing placement, and merge conflicts. Errors block import but not navigation.

## Files to Modify

- `src/components/Dialogs/DmpSectionConfigDialog.tsx`
- `src/utils/validation.ts`

## Implementation

### 1. Error Types

```tsx
type ImportError =
  | { type: 'invalidData'; sectionIndex: number; shotIndex: number; field: string; message: string }
  | { type: 'missingPlacement'; sectionIndex: number }
  | { type: 'mergeConflict'; sectionIndex: number; message: string };

interface SectionErrors {
  sectionIndex: number;
  errors: ImportError[];
}
```

### 2. Validation Functions

```tsx
// Validate shot data
function validateShotData(shot: EditableShot, index: number): ImportError[] {
  const errors: ImportError[] = [];

  // Length must be positive
  if (shot.length <= 0) {
    errors.push({
      type: 'invalidData',
      sectionIndex: -1, // filled by caller
      shotIndex: index,
      field: 'length',
      message: 'Length must be greater than 0',
    });
  }

  // Azimuth must be 0-360
  if (shot.azimuth_in < 0 || shot.azimuth_in >= 360) {
    errors.push({
      type: 'invalidData',
      sectionIndex: -1,
      shotIndex: index,
      field: 'azimuth_in',
      message: 'Azimuth must be between 0 and 360',
    });
  }

  // Similar for other fields...
  return errors;
}

// Validate section has placement
function validatePlacement(sectionConfig: SectionConfig): ImportError | null {
  if (!sectionConfig.placement) {
    return {
      type: 'missingPlacement',
      sectionIndex: -1,
      message: 'Section must be placed before import',
    };
  }
  return null;
}

// Validate merge target exists
function validateMergeTarget(
  placement: PlacementConfig,
  placedSections: Set<number>,
  project: Project | null
): ImportError | null {
  if (placement.type !== 'fromExisting') return null;

  const { targetSection, targetStation } = placement;

  // Check if target section exists in project or is already placed
  const existsInProject = project?.sections.some(s => s.id === targetSection);
  const existsInPlaced = placedSections.has(targetSection);

  if (!existsInProject && !existsInPlaced) {
    return {
      type: 'mergeConflict',
      sectionIndex: -1,
      message: 'Target section for merge does not exist',
    };
  }

  return null;
}
```

### 3. Aggregate Errors

```tsx
function validateAllSections(
  sectionConfigs: Map<number, SectionConfig>,
  placedSections: Set<number>,
  project: Project | null
): SectionErrors[] {
  const allErrors: SectionErrors[] = [];

  for (const [index, config] of sectionConfigs) {
    const errors: ImportError[] = [];

    // Validate each shot
    config.shots.forEach((shot, shotIndex) => {
      const shotErrors = validateShotData(shot, shotIndex);
      errors.push(...shotErrors.map(e => ({ ...e, sectionIndex: index })));
    });

    // Validate placement
    const placementError = validatePlacement(config);
    if (placementError) {
      errors.push({ ...placementError, sectionIndex: index });
    }

    // Validate merge target if applicable
    if (config.placement) {
      const mergeError = validateMergeTarget(config.placement, placedSections, project);
      if (mergeError) {
        errors.push({ ...mergeError, sectionIndex: index });
      }
    }

    if (errors.length > 0) {
      allErrors.push({ sectionIndex: index, errors });
    }
  }

  return allErrors;
}
```

### 4. Import Button State

```tsx
const allErrors = useMemo(() =>
  validateAllSections(sectionConfigs, placedSections, project),
  [sectionConfigs, placedSections, project]
);

const totalErrors = allErrors.reduce((sum, s) => sum + s.errors.length, 0);
const canImport = totalErrors === 0 && placedSections.size === selectedSections.length;

<Button
  variant="primary"
  onClick={handleImport}
  disabled={!canImport}
  title={!canImport ? `Cannot import: ${totalErrors} errors` : undefined}
>
  Import {selectedSections.length} Sections
</Button>
```

### 5. Error Display in Left Panel

```tsx
// For each section in left panel
const sectionErrors = allErrors.find(e => e.sectionIndex === index);
const errorCount = sectionErrors?.errors.length ?? 0;

{errorCount > 0 && (
  <span className="text-error text-xs">
    <span className="inline-flex items-center justify-center w-4 h-4 bg-error text-white rounded-full text-[10px]">
      !
    </span>
    {errorCount}
  </span>
)}
```

### 6. Navigation Not Blocked

Previous/Next buttons work regardless of errors - only Import is blocked.

## Acceptance Criteria

- [ ] Invalid data errors detected (negative length, bad azimuth, etc.)
- [ ] Missing placement error detected
- [ ] Merge conflict error detected (target doesn't exist)
- [ ] Import button disabled when errors exist
- [ ] Import button shows error count in tooltip
- [ ] Left panel shows error count per section
- [ ] Navigation still works with errors
- [ ] TypeScript compiles without errors

## Existing Tests to Modify

The following existing test files must be updated to account for changes made in this task:

### Playwright Tests
- `e2e-playwright/import-dialog.spec.ts` - Import button state tests need updating for error blocking logic
- `e2e-playwright/dmp-import.spec.ts` - Validation tests need updating for blocking vs non-blocking errors

### WebdriverIO Tests
- `e2e/specs/import-dmp-dialog.spec.ts` - Error display and import blocking tests need updating

### Mock Updates
- `e2e-playwright/mocks/tauri-ipc.ts` - No changes needed (frontend validation logic)

## Test Suggestions

### Unit Tests (Rust)
N/A - Frontend-only task.

### Playwright Tests (3-10)
1. Test Import disabled with zero-length shot
2. Test Import disabled with missing placement
3. Test Import disabled with invalid merge target
4. Test Import enabled when all valid
5. Test error count shown in left panel
6. Test Previous/Next work with errors
7. Test fixing error enables Import
8. Test tooltip shows error count

### WebdriverIO Tests (3-10)
1. Test import blocked with invalid data
2. Test import blocked without placement
3. Test error display with real DMP
4. Test fixing errors and completing import

## Done Summary
(To be filled when complete)

## Evidence
- Commits:
- Tests:
- PRs:
