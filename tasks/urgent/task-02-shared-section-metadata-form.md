# Task 02: Create Shared SectionMetadataForm Component

## Description

Extract section metadata editing (name, surveyor, date, color, direction) into a reusable component. This will be shared between EditSectionDialog and DmpSectionConfigDialog.

## Files to Create

- `src/components/common/SectionMetadataForm.tsx`

## Files to Modify

- `src/components/Dialogs/EditSectionDialog.tsx` (refactor to use SectionMetadataForm)

## Implementation

### 1. Props Interface

```tsx
interface SectionMetadataFormProps {
  name: string;
  surveyor: string;
  date: string;
  color: string;
  direction?: 'in' | 'out';
  onNameChange: (value: string) => void;
  onSurveyorChange: (value: string) => void;
  onDateChange: (value: string) => void;
  onColorChange: (value: string) => void;
  onDirectionChange?: (value: 'in' | 'out') => void;
  showDirection?: boolean;
  disabled?: boolean;
}
```

### 2. Layout

Horizontal grid layout with 4-5 columns:
- Name (text input)
- Surveyor (text input)
- Date (date input)
- Color (color picker + hex input)
- Direction (dropdown, optional)

### 3. Color Picker

- Native color input + hex text input side by side
- Both update each other
- Full palette shown (no marking of used colors per requirements)

### 4. Date Input

- HTML5 date input
- Format: YYYY-MM-DD

### 5. Direction Dropdown

- Only shown when `showDirection={true}`
- Options: "In" and "Out"

## Acceptance Criteria

- [ ] SectionMetadataForm component created
- [ ] All fields editable and controlled
- [ ] Direction dropdown shown only when showDirection=true
- [ ] Color picker syncs with hex input
- [ ] EditSectionDialog refactored to use SectionMetadataForm
- [ ] TypeScript compiles without errors
- [ ] All existing tests pass

## Test Suggestions

### Unit Tests (Rust)
N/A - Frontend-only task.

### Playwright Tests (3-10)
1. Test name field is editable
2. Test surveyor field is editable
3. Test date field accepts valid date
4. Test color picker updates hex input
5. Test hex input updates color picker
6. Test direction dropdown changes value when clicked
7. Test direction dropdown hidden when showDirection=false

### WebdriverIO Tests (3-10)
1. Test SectionMetadataForm renders in EditSectionDialog
2. Test changing section name and saving
3. Test changing section color persists after save
4. Test date field correctly formats dates

## Done Summary
(To be filled when complete)

## Evidence
- Commits:
- Tests:
- PRs:
