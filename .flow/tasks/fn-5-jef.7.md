# fn-5-jef.7 Add depth gradient to keyboard shortcuts config

## Description
Add depth gradient toggle to keyboard shortcuts configuration.

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
- [ ] Depth gradient shortcut added to config
- [ ] No default key binding
- [ ] Appears in settings UI under Display category
- [ ] Action correctly toggles showDepthGradient
- [ ] `pnpm tsc --noEmit` passes
## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
