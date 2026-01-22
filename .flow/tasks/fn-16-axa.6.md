# fn-16-axa.6 Add Cmd/Ctrl+comma keyboard shortcut to open Settings

## Description
Add the standard Cmd+, (macOS) / Ctrl+, (Windows/Linux) keyboard shortcut to open the Settings dialog. Should work globally, including when focused in input fields.

**Size:** S
**Files:**
- `src/utils/shortcuts.ts` - Add to RESERVED_CTRL_KEYS and description map
- `src/hooks/useKeyboardShortcuts.ts` - Handle the shortcut before input guard

## Approach

1. **Add to RESERVED_CTRL_KEYS** at `src/utils/shortcuts.ts`:
   - Add `','` to `RESERVED_CTRL_KEYS` array (currently only has I/E/A)
   - Add description to `RESERVED_CTRL_DESCRIPTIONS` map: `',': 'Open Settings'`
   - This ensures `checkReservedConflict()` blocks users from assigning Ctrl/Cmd+, to custom shortcuts
2. Handle in useKeyboardShortcuts.ts:
   - **Check BEFORE the input guard** (before `shouldIgnoreInput(e)` check)
   - Use `event.key === ','` (NOT 'Comma' - that's event.code, codebase uses event.key)
   - Check `(e.metaKey || e.ctrlKey)` for Ctrl/Meta modifier
   - Call `useUIStore.getState().openDialog('settings')` when triggered
3. Shortcut should work **globally including in input fields** (handle before input guard)
4. Don't trigger if Settings is already open
5. Call `event.preventDefault()` when handling

## Key Context

- Reserved shortcuts defined via `RESERVED_CTRL_KEYS` and `RESERVED_CTRL_DESCRIPTIONS` at `src/utils/shortcuts.ts`
- `checkReservedConflict()` function uses `RESERVED_CTRL_KEYS` to block conflicts in Shortcuts UI
- Keyboard handler at `src/hooks/useKeyboardShortcuts.ts`
- Dialog opening via `useUIStore.openDialog('settings')` - pattern at GlobalView.tsx:218
- **Key detection uses `event.key`** not `event.code` in this codebase
- `event.key` for comma is `','` (the literal comma character)
- Input guard (`shouldIgnoreInput`) currently blocks non-Escape shortcuts in inputs - need to handle Settings shortcut BEFORE this check

## Acceptance
- [ ] Cmd+, opens Settings on macOS
- [ ] Ctrl+, opens Settings on Windows/Linux
- [ ] **Works even when focused in input/textarea/select fields** (global shortcut)
- [ ] `','` added to `RESERVED_CTRL_KEYS` array
- [ ] `','` added to `RESERVED_CTRL_DESCRIPTIONS` map with 'Open Settings' description
- [ ] `checkReservedConflict()` blocks users from assigning Ctrl/Cmd+, to custom shortcuts
- [ ] Does not trigger when Settings is already open
- [ ] Uses `event.key === ','` (not 'Comma')
- [ ] event.preventDefault() called when handling
- [ ] pnpm tsc --noEmit passes

## Done summary
Added Cmd/Ctrl+, keyboard shortcut to open the Settings dialog globally (including when focused in input fields). Added the comma key to RESERVED_CTRL_KEYS and RESERVED_CTRL_DESCRIPTIONS, updated checkReservedConflict() to use the new descriptions map, and handled the shortcut before the input guard in useKeyboardShortcuts.ts.
## Evidence
- Commits: 3b83cbe, 198f217
- Tests: pnpm tsc --noEmit, pnpm vitest run src/utils/__tests__/shortcuts.test.ts
- PRs: