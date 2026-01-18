# Task 06: Add Section Parameters Panel to Step 2 Dialog

## Description

Add the section parameters editing panel to DmpSectionConfigDialog. This uses the shared SectionMetadataForm component and adds a Reset Section button.

## Files to Modify

- `src/components/Dialogs/DmpSectionConfigDialog.tsx`

## Implementation

### 1. Parameters Panel Layout

Located in top-right of main panel, next to preview:

```
┌─ Section Parameters ────────────────────────────────────────────┐
│                                                                  │
│ Name: [ABC____________]  Direction: [In ▼]                      │
│                                                                  │
│ Surveyor: [J. Smith____]  Date: [2024-01-10]  Color: [████ ▼]  │
│                                                                  │
│                                          [Reset Section]         │
└──────────────────────────────────────────────────────────────────┘
```

### 2. Pre-filled Values

Values pre-filled from Step 1:
- Name: from DMP section name (editable)
- Direction: from DMP or user edit in Step 1
- Surveyor: from Step 1 default surveyor field
- Date: from DMP date or Step 1 override
- Color: auto-assigned (avoiding duplicates)

### 3. State Management

```tsx
interface SectionFormState {
  name: string;
  surveyor: string;
  date: string;
  color: string;
  direction: 'in' | 'out';
}

// Store original DMP values for reset
const [originalState, setOriginalState] = useState<Map<number, SectionFormState>>();
const [currentState, setCurrentState] = useState<SectionFormState>();
```

### 4. Reset Section Button

When clicked:
- Resets all fields to original DMP values
- Resets shots to original DMP data
- Clears placement selection
- Shows toast: "Section reset to original"

### 5. Auto-save on Navigate

When user navigates away (Previous, Next, or click in list):
- Current section state auto-saved to sectionConfigs map
- No explicit save button needed

### 6. Color Selection

- Use full color palette (no marking of used colors)
- Color picker + hex input combo

## Acceptance Criteria

- [ ] Section parameters panel renders in correct position
- [ ] All fields editable: name, direction, surveyor, date, color
- [ ] Values pre-filled from Step 1 and DMP
- [ ] Reset Section button resets all fields and placement
- [ ] Auto-save on navigation works
- [ ] Color picker works with hex input
- [ ] TypeScript compiles without errors

## Test Suggestions

### Unit Tests (Rust)
N/A - Frontend-only task.

### Playwright Tests (3-10)
1. Test parameters panel displays with pre-filled values
2. Test name field is editable
3. Test direction dropdown changes value
4. Test surveyor field shows Step 1 default
5. Test date field shows DMP date
6. Test Reset Section button resets name to DMP value
7. Test Reset Section clears placement
8. Test auto-save when clicking Next
9. Test auto-save when clicking section in list
10. Test color picker updates section color

### WebdriverIO Tests (3-10)
1. Test editing section name persists after import
2. Test changing direction affects import
3. Test Reset Section with full app state
4. Test surveyor value from Step 1 appears in Step 2

## Done Summary
(To be filled when complete)

## Evidence
- Commits:
- Tests:
- PRs:
