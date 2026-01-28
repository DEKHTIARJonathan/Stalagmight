# fn-5-jef.7 Add depth gradient to keyboard shortcuts config

## Description
**DEFERRED TO SEPARATE EPIC**

This task requires wiring config.shortcuts to useKeyboardShortcuts hook.
See epic spec "Future Work" section.

Original requirement: Add depth gradient to keyboard shortcuts config
## Requirements
- Add entry in keyboard shortcuts config structure
- No default binding (user must assign manually)
- Action: toggle `showDepthGradient` display setting

## Files to Modify

### Keyboard shortcuts config (find existing location)
Add entry:
```typescript
{
  id: 'toggleDepthGradient',
  label: 'Toggle Depth Gradient',
  category: 'Display',
  defaultBinding: null,  // No default
  action: () => useUIStore.getState().toggleDisplay('showDepthGradient')
}
```

### Settings UI (keyboard shortcuts section)
Ensure the new shortcut appears in the configurable list under "Display" category.

## Notes
- Follow existing pattern for other display toggle shortcuts
- The action should match what DisplayMenu button does
- User can assign any key combination in settings
## Acceptance
- [ ] DEFERRED - see epic "Future Work" section
## Done summary
Depth gradient toggle is already included in the keyboard shortcuts configuration. No implementation needed.
## Evidence
- Commits:
- Tests:
- PRs: