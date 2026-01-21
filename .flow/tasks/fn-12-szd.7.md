# fn-12-szd.7 Add tooltip hint to section items

## Description
Add tooltip to section items showing "Double-click to zoom (Ctrl+G)" for discoverability.

**Size:** S
**Files:** `src/components/SingleSystemView/SectionsPanel.tsx`

## Approach

- Add `title` attribute to section list item element
- Text: "Double-click to zoom (Ctrl+G)"
- Native browser tooltip is sufficient (no custom tooltip component needed)

## Key context

- Keep it simple - native `title` attribute provides adequate discoverability
- Tooltip appears on hover after brief delay (browser default)
## Acceptance
- [ ] `title` attribute added to section list items
- [ ] Tooltip text: "Double-click to zoom (Ctrl+G)"
- [ ] Tooltip appears on hover
- [ ] `pnpm tsc --noEmit` passes
## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
