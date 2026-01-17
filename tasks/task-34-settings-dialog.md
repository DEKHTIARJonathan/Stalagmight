# Task 34: Settings Dialog Shell

## Overview
Create a tabbed modal settings dialog with tabs for Display, Validation, Export, and About. Accessible via menu only.

## Priority
Medium - Phase B (Settings)

## Risk Level
Medium

## Dependencies
None - can start immediately

## Files to Modify
- `src/components/Dialogs/SettingsDialog.tsx` - New file
- `src/store/uiStore.ts` - Add settings dialog state
- `src/App.tsx` - Add menu item

## Specifications

### Dialog Structure
```typescript
interface SettingsDialogProps {
  isOpen: boolean;
  onClose: () => void;
  initialTab?: 'display' | 'validation' | 'export' | 'about';
}
```

### Tabs
1. Display - colors, fonts, sizes
2. Validation - thresholds, severity
3. Export - defaults, presets
4. About - version, diagnostics

### Access
- Menu only: Edit > Settings (or File > Preferences)
- No keyboard shortcut
- Modal dialog (blocks app interaction)

### Reset Options (All Three Levels)
- Per-setting: Reset icon next to each setting
- Per-section: "Reset Tab" button on each tab
- Full: "Reset All Settings" in footer

### Apply Behavior
- Changes apply immediately (no Save/Apply buttons)
- Close button only

### UI Requirements
- Draggable dialog
- Tab switching with keyboard (arrow keys)
- `data-testid="settings-dialog"`
- `data-testid="settings-tab-{name}"`

## Acceptance Criteria
- [ ] Dialog opens from menu
- [ ] Four tabs visible and switchable
- [ ] Modal behavior (blocks background)
- [ ] Draggable
- [ ] Reset icons at all three levels
- [ ] Changes apply immediately
- [ ] TypeScript types pass
- [ ] Tests pass

## Test Requirements

### Playwright Tests (Mocked IPC)
1. Test dialog opens from Edit > Settings menu
2. Test all four tabs visible (Display, Validation, Export, About)
3. Test tab switching with click
4. Test tab switching with arrow keys
5. Test per-setting reset icon functionality
6. Test per-tab "Reset Tab" button
7. Test "Reset All Settings" button
8. Test dialog closes on Escape key
9. Test dialog is draggable
10. Test modal blocks background interaction

### WebdriverIO Tests (Full App)
1. Test dialog opens and closes with real app
2. Test settings changes persist to config file
3. Test settings reload correctly after restart
4. Test reset actually restores default values

## Edge Cases
- Open settings with no project loaded
- Tab switching via keyboard
- Rapid setting changes
