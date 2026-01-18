# Task 05: Create DmpSectionConfigDialog Shell (Step 2)

## Description

Create the Step 2 dialog shell for DMP import. This dialog has a left panel with section list and a main panel for section configuration. This task creates the shell structure only; subsequent tasks add the internal components.

## Files to Create

- `src/components/Dialogs/DmpSectionConfigDialog.tsx`

## Files to Modify

- `src/components/Dialogs/index.ts` (export new dialog)
- `src/App.tsx` (add dialog rendering)

## Implementation

### 1. Dialog Layout (~900x700px fixed)

```
┌─ Import DMP File (Step 2) ────────────────────────────────────────────────┐
│                                                                            │
│ ┌──────────────┐ ┌──────────────────────────────────────────────────────┐ │
│ │ Sections     │ │ ┌──────────┐  Section: ABC                          │ │
│ │              │ │ │ Preview  │  ┌─ Parameters ───────────────────────┐│ │
│ │ ✓ ABC        │ │ │ 250x250  │  │ Name: [___] Surveyor: [___]       ││ │
│ │ ✓ DEF        │ │ │          │  │ Date: [___] Color: [___] Dir: [__]││ │
│ │ ○ GHI        │ │ └──────────┘  └────────────────────────────────────┘│ │
│ │   (3 errors) │ │                                                      │ │
│ │              │ │ ┌─ Placement ──────────────────────────────────────┐│ │
│ │ [Collapse]   │ │ │ ○ Place at 0,0  ○ Zero Datum  ○ From Existing   ││ │
│ │              │ │ │ ○ Manual Placement                               ││ │
│ │              │ │ └──────────────────────────────────────────────────┘│ │
│ │              │ │                                                      │ │
│ │              │ │ ┌─ Shot Table ─────────────────────────────────────┐│ │
│ │              │ │ │ (ShotTableEditor component)                      ││ │
│ │              │ │ └──────────────────────────────────────────────────┘│ │
│ └──────────────┘ └──────────────────────────────────────────────────────┘ │
│                                                                            │
│ [Cancel] [← Back to Selection]          [Previous] [Next / Import X]      │
└────────────────────────────────────────────────────────────────────────────┘
```

### 2. Props Interface

```tsx
interface DmpSectionConfigDialogProps {
  dmpFile: DmpFile;
  selectionConfig: DmpSelectionConfig;
  onCancel: () => void;
  onBack: () => void;
  onImport: (sections: ImportedSectionConfig[]) => void;
  project: Project | null;
  stations: Station[];
}

interface ImportedSectionConfig {
  sectionIndex: number;
  name: string;
  surveyor: string | null;
  date: string | null;
  color: string;
  direction: 'in' | 'out';
  shots: EditableShot[];
  placement: PlacementConfig;
}

type PlacementConfig =
  | { type: 'origin' }
  | { type: 'zeroDatum'; coordinates: GpsCoordinates; stationIndex: number }
  | { type: 'fromExisting'; importStation: number; existingStation: StationRef }
  | { type: 'manual'; alignStation: 'first' | 'last' };
```

### 3. Left Panel - Section List

- Collapsible panel
- Shows all selected sections in DMP order
- Status icons:
  - ✓ (green checkmark): section is placed
  - ○ (empty circle): section not yet placed
  - Red icon + error count: section has errors
- Click section to jump directly (auto-saves current)

### 4. Main Panel Layout

- Top-left: SectionPreview (250x250px)
- Top-right: Section parameters
- Middle: Placement options
- Bottom: Shot table

### 5. Navigation Buttons

- Cancel: confirmation dialog, cancels entire import
- Back to Selection: confirmation, undoes all placements, returns to Step 1
- Previous: go to previous section (disabled on first)
- Next: go to next section (changes to "Import X sections" on last)

### 6. Dialog State

```tsx
const [currentSectionIndex, setCurrentSectionIndex] = useState(0);
const [sectionConfigs, setSectionConfigs] = useState<Map<number, ImportedSectionConfig>>();
const [placedSections, setPlacedSections] = useState<Set<number>>(new Set());
```

### 7. Keyboard Shortcuts

- Ctrl+Enter: proceed (Next or Import)
- Ctrl+← / Ctrl+→: Previous / Next section
- Escape: Cancel (with confirmation)

## Acceptance Criteria

- [ ] Dialog renders with fixed 900x700px size
- [ ] Left panel shows section list with status icons
- [ ] Left panel is collapsible
- [ ] Click section in list navigates to that section
- [ ] Main panel layout with placeholder sections
- [ ] Navigation buttons work (Cancel, Back, Previous, Next)
- [ ] Keyboard shortcuts work
- [ ] TypeScript compiles without errors

## Test Suggestions

### Unit Tests (Rust)
N/A - Frontend-only task.

### Playwright Tests (3-10)
1. Test dialog renders with correct size
2. Test left panel shows selected sections
3. Test clicking section in list navigates to it
4. Test Previous button disabled on first section
5. Test Next button text changes to "Import X" on last section
6. Test Escape key shows cancel confirmation
7. Test Ctrl+Enter triggers Next/Import
8. Test left panel collapse/expand works
9. Test Back button shows confirmation dialog
10. Test section status icons update correctly

### WebdriverIO Tests (3-10)
1. Test Step 2 dialog opens after Step 1 Continue
2. Test navigating between sections
3. Test completing full import flow
4. Test Back button returns to Step 1
5. Test Cancel aborts import

## Done Summary
(To be filled when complete)

## Evidence
- Commits:
- Tests:
- PRs:
