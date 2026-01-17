# Task 59: Keyboard Shortcuts Overlay

## Overview
Create a modal overlay showing all keyboard shortcuts. Accessible via ? or F1 key. Searchable/filterable with link to settings for editing.

## Priority
Low-Medium - Phase H (Polish)

## Risk Level
Low-Medium

## Dependencies
- Task 45: Keyboard navigation (shortcut definitions)

## Files to Modify
- `src/components/Dialogs/ShortcutsOverlay.tsx` - New file
- `src/hooks/useKeyboardShortcuts.ts` - Export shortcut definitions
- `src/store/uiStore.ts` - Overlay state

## Specifications

### Access
- Press `?` key (Shift+/)
- Press `F1` key
- Help > Keyboard Shortcuts menu

### Shortcut Categories
```typescript
const shortcutCategories = [
  {
    name: 'Tools',
    shortcuts: [
      { key: 'S', action: 'Select tool' },
      { key: 'P', action: 'Pan tool' },
      // ...
    ]
  },
  {
    name: 'File',
    shortcuts: [
      { key: 'Ctrl+S', action: 'Save project' },
      { key: 'Ctrl+O', action: 'Open project' },
      // ...
    ]
  },
  {
    name: 'Edit',
    shortcuts: [
      { key: 'Ctrl+Z', action: 'Undo' },
      { key: 'Ctrl+Y', action: 'Redo' },
      // ...
    ]
  },
  // ...
];
```

### Search/Filter
- Type to filter shortcuts
- Matches key or action text
- Highlights matching text
- Real-time filtering

### Layout
```
┌─────────────────────────────────────────┐
│  Keyboard Shortcuts          [Search...] │
│                                          │
│  Tools                                   │
│  ┌──────┬───────────────────────┐        │
│  │ S    │ Select tool           │        │
│  │ P    │ Pan tool              │        │
│  │ Z    │ Zoom tool             │        │
│  └──────┴───────────────────────┘        │
│                                          │
│  File                                    │
│  ┌──────┬───────────────────────┐        │
│  │ ⌘S   │ Save project          │        │
│  │ ⌘O   │ Open project          │        │
│  └──────┴───────────────────────┘        │
│                                          │
│  [Customize Shortcuts]      [Close]      │
└─────────────────────────────────────────┘
```

### Key Display
- Use platform-specific modifiers
- macOS: ⌘, ⌥, ⇧, ⌃
- Windows/Linux: Ctrl, Alt, Shift

### Customize Link
- "Customize Shortcuts" button
- Opens Settings dialog to keyboard tab
- Or direct link if keyboard settings exist

### Modal Behavior
- Modal overlay (blocks background)
- Escape or click outside closes
- ? key toggles (open/close)

### Dynamic Source
- Read shortcuts from same source as useKeyboardShortcuts
- Single source of truth
- Automatically updated when shortcuts change

## Acceptance Criteria
- [ ] Overlay opens with ? or F1
- [ ] All shortcuts displayed by category
- [ ] Search/filter works
- [ ] Platform-specific key symbols
- [ ] Customize link works
- [ ] Escape closes overlay
- [ ] TypeScript types pass
- [ ] Tests pass

## Test Requirements

### Playwright Tests (Mocked IPC)
1. Test overlay opens with ? key
2. Test overlay opens with F1 key
3. Test overlay opens from Help menu
4. Test all shortcut categories displayed
5. Test Tools section shows S, P, Z, etc.
6. Test File section shows Ctrl+S, Ctrl+O
7. Test search filters shortcuts by key
8. Test search filters shortcuts by action
9. Test Escape closes overlay
10. Test "Customize Shortcuts" link works

### WebdriverIO Tests (Full App)
1. Test overlay with real shortcut data
2. Test platform-specific modifier symbols
3. Test search filters in real-time
4. Test overlay doesn't interfere with other shortcuts
5. Test ? key toggles overlay open/close

## Edge Cases
- No shortcuts defined
- Very long action descriptions
- Search with no results
- Shortcut conflicts (show both)
