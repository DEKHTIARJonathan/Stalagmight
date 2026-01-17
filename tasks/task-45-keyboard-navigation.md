# Task 45: Keyboard Navigation

## Overview
Enable full keyboard navigation for all UI elements. Arrow keys in panels/tables, Home/End for quick navigation, visible focus indicators, and user-configurable shortcuts.

## Priority
Medium - Phase D (Accessibility)

## Risk Level
Medium

## Dependencies
- Task 42: Focus management
- Existing useKeyboardShortcuts hook

## Files to Modify
- `src/hooks/useKeyboardShortcuts.ts` - Extend with new shortcuts
- `src/components/common/Table.tsx` - Arrow key navigation
- `src/components/common/Panel.tsx` - Panel navigation
- `src/store/uiStore.ts` - Shortcut configuration

## Specifications

### Table Navigation
- Arrow Up/Down: Move between rows
- Arrow Left/Right: Move between cells
- Home: First row
- End: Last row
- Ctrl+Home: First cell
- Ctrl+End: Last cell
- Enter: Select row / enter edit mode
- Space: Toggle row selection

### Panel Navigation
- Tab: Move between panels
- Arrow keys: Navigate within panel
- F6: Cycle between major sections

### Tool Shortcuts
Common tools have default shortcuts:
| Key | Tool |
|-----|------|
| S | Select |
| P | Pan |
| Z | Zoom |
| D | Draw |
| X | Delete |
| M | Merge |
| R | Measure |
| V | Move Section |
| T | Move Station |

### User-Configurable Shortcuts
- All shortcuts can be rebound
- Settings dialog for customization
- Shortcuts can be disabled
- Conflict detection

### Focus Visible
- Clear outline on all focusable elements
- Custom focus style: `--cc-focus-ring`
- Never suppressed with `outline: none`

### Map Accessibility
- Map not keyboard navigable (too complex)
- Users use data table for keyboard access
- Skip link to bypass map

### Skip Links
- "Skip to main content" link
- "Skip to data table" link
- Visible on focus only

## Acceptance Criteria
- [ ] Arrow keys navigate tables
- [ ] Home/End work in tables
- [ ] Tool shortcuts work
- [ ] Shortcuts are configurable
- [ ] Focus visible on all elements
- [ ] Skip links work
- [ ] TypeScript types pass
- [ ] Tests pass

## Test Requirements

### Playwright Tests (Mocked IPC)
1. Test Arrow Up/Down moves between table rows
2. Test Arrow Left/Right moves between table cells
3. Test Home key goes to first row
4. Test End key goes to last row
5. Test Ctrl+Home goes to first cell
6. Test Ctrl+End goes to last cell
7. Test S key activates Select tool
8. Test P key activates Pan tool
9. Test all tool shortcuts (Z, D, X, M, R, V, T)
10. Test skip link "Skip to data table" works

### WebdriverIO Tests (Full App)
1. Test keyboard navigation with real data
2. Test shortcut customization persists
3. Test shortcut conflicts detected
4. Test disabled shortcuts don't trigger
5. Test F6 cycles between major sections

## Edge Cases
- Shortcut conflicts
- Shortcuts during edit mode
- Focus in empty table
- Navigation at boundaries
