# fn-16-axa.6 Add Cmd/Ctrl+comma keyboard shortcut to open Settings

## Description
Add the standard Cmd+, (macOS) / Ctrl+, (Windows/Linux) keyboard shortcut to open the Settings dialog.

**Size:** S
**Files:**
- `src/types/shortcuts.ts` - Add to reserved shortcuts
- `src/hooks/useKeyboardShortcuts.ts` - Handle the shortcut
- `src/store/uiStore.ts` - May need to verify openDialog exists

## Approach

1. Add Cmd/Ctrl+, to reserved shortcuts list at `src/types/shortcuts.ts:22-29`
2. Handle in useKeyboardShortcuts.ts:
   - Check for 'Comma' key with Ctrl (Windows/Linux) or Meta (macOS) modifier
   - Call `useUIStore.getState().openDialog('settings')` when triggered
3. Shortcut should work globally (not just in specific views)
4. Memory note: "Only call event.preventDefault() when actually handling the event"

## Key Context

- Reserved shortcuts defined at `src/types/shortcuts.ts:22-29`
- Keyboard handler at `src/hooks/useKeyboardShortcuts.ts`
- Dialog opening via `useUIStore.openDialog('settings')` - pattern at GlobalView.tsx:218
- Shortcut key normalization uses UPPERCASE for letters (memory note)
- Key value for comma is `','` or `'Comma'` in KeyboardEvent.key

## Acceptance
- [ ] Cmd+, opens Settings on macOS
- [ ] Ctrl+, opens Settings on Windows/Linux
- [ ] Shortcut added to reserved shortcuts list (not user-configurable)
- [ ] Works from any view when Settings isn't already open
- [ ] Does not trigger when Settings is already open
- [ ] event.preventDefault() called when handling
- [ ] pnpm tsc --noEmit passes
