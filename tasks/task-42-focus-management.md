# Task 42: Focus Management

## Overview
Implement proper focus handling for dialogs and panels. Focus trap in modals, return focus on close, and logical tab order throughout the application.

## Priority
High - Phase D (Accessibility)

## Risk Level
High

## Dependencies
- All existing dialog components

## Files to Modify
- `src/components/Dialogs/DialogWrapper.tsx` - New or modify existing
- `src/components/common/Panel.tsx` - Focus handling
- `src/hooks/useFocusTrap.ts` - New hook
- All dialog components - Apply focus wrapper

## Specifications

### Focus Trap (Modal Dialogs)
- Tab cycles within dialog only
- Cannot tab out to background
- Shift+Tab at first element: go to last
- Tab at last element: go to first

### Initial Focus
- Focus first interactive element on open
- Typically first input field
- For confirmation dialogs: focus "Cancel" (safer default)

### Return Focus
- On dialog close, return focus to trigger element
- Store trigger reference on open
- Handle case where trigger no longer exists

### Dialog Navigation
- Dialogs are draggable (per requirements)
- Escape closes dialog
- Click outside closes (for non-critical dialogs)

### Tab Order
- Logical left-to-right, top-to-bottom
- Use `tabIndex` only when necessary
- Skip decorative/disabled elements

### Panel Focus
- Allow free navigation (not trapped)
- Can tab out of panels
- Panels focusable for screen readers

### Focus Visible
- Clear focus indicator (outline)
- High contrast focus ring
- Never hide focus indicator

## Acceptance Criteria
- [ ] Modal dialogs trap focus
- [ ] Initial focus on first input
- [ ] Return focus on dialog close
- [ ] Escape closes dialogs
- [ ] Logical tab order throughout
- [ ] Focus visible indicator works
- [ ] TypeScript types pass
- [ ] Tests pass

## Test Requirements

### Playwright Tests (Mocked IPC)
1. Test Tab key cycles within modal dialog
2. Test Shift+Tab at first element goes to last
3. Test Tab at last element goes to first
4. Test initial focus on first input field
5. Test confirmation dialogs focus Cancel button
6. Test focus returns to trigger on dialog close
7. Test Escape closes dialog
8. Test focus visible outline on all interactive elements
9. Test logical tab order (left-to-right, top-to-bottom)

### WebdriverIO Tests (Full App)
1. Test focus trap with real dialog
2. Test return focus after dialog actions
3. Test keyboard-only dialog navigation
4. Test focus indicator visible in all themes
5. Test focus behavior with nested dialogs

## Edge Cases
- Dialog opened by keyboard vs mouse
- Nested dialogs
- Focus on disabled elements
- Dynamic content changing focus order
