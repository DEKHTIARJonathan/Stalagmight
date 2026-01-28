# fn-42-elr.2 Remove Ctrl+I and Ctrl+E from reserved shortcuts

## Description
Remove Ctrl+I and Ctrl+E from the reserved shortcuts sets and descriptions, allowing them to be user-configurable.

**Size:** S
**Files:**
- `src/utils/shortcuts.ts`

## Approach
- Remove `'Ctrl+I'` and `'Ctrl+E'` from `RESERVED_SHORTCUTS` set (lines 22-30)
- Remove `'I'` and `'E'` from `RESERVED_CTRL_KEYS` set (lines 340-345)
- Remove entries for `'I'` and `'E'` from `RESERVED_CTRL_DESCRIPTIONS` map (lines 351-356)
- Update unit tests in `src/utils/__tests__/shortcuts.test.ts` that verify Ctrl+I/E are reserved

## Key context
- The `isReservedShortcut()` function uses these sets for validation
- After this change, `checkReservedConflict()` will allow Ctrl+I/E to be assigned
- Ctrl+A and Ctrl+, remain reserved (keep those in the sets)
## Acceptance
- [ ] `Ctrl+I` and `Ctrl+E` removed from RESERVED_SHORTCUTS set
- [ ] `I` and `E` removed from RESERVED_CTRL_KEYS set
- [ ] Descriptions for I and E removed from RESERVED_CTRL_DESCRIPTIONS
- [ ] Unit tests updated to reflect new reserved shortcuts
- [ ] `isReservedShortcut('Ctrl+I')` returns false
- [ ] `isReservedShortcut('Ctrl+E')` returns false
- [ ] `pnpm tsc --noEmit` passes
## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
