# fn-17-ygu.2 Add px unit to shot-label font-size

## Description
Fix the shot-label font-size attribute which is missing the `px` unit suffix, causing inconsistent sizing.

**Size:** S
**Files:**
- `src-tauri/src/export/image.rs` (line 375)

## Approach

1. Locate shot-label at line 375: change `font-size="8"` to `font-size="8px"`
2. Verify other font-size attributes have correct units (lines 268, 269, 583)

## Key context

- CSS `font-size` in SVG defaults to user units (viewBox) when no unit specified
- Adding `px` makes it absolute pixels regardless of viewBox scaling
## Acceptance
- [ ] Shot-label font-size has `px` unit suffix
- [ ] Shot labels are readable at ~8px
- [ ] No regression in other label sizes
## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
