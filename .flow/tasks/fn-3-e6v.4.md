# fn-3-e6v.4 Implement toggle disable relationships in DisplayMenu

## Description
Implement toggle disable relationships in DisplayMenu.

## File to Modify
- `src/components/SingleSystemView/DisplayMenu.tsx`

## Implementation Details

When "Shots" (`showShots`) is unchecked:
- "Virtual Shots" toggle should be disabled (grayed out)
- "Shot Data" toggle should be disabled (grayed out)

Visual indication:
- Disabled toggles show reduced opacity (e.g., `opacity: 0.5`)
- Cursor changes to `not-allowed`
- Checkbox is disabled but retains its checked state

Implementation approach:
1. Track `showShots` state
2. For Virtual Shots and Shot Data menu items, conditionally apply:
   - `disabled` prop to the checkbox
   - CSS class for visual styling

The disabled toggles should remember their state - when Shots is re-enabled, they restore to their previous values.

## Depends On
- Task 1: showShots state must exist
## Acceptance
- [ ] "Virtual Shots" toggle is disabled when "Shots" is unchecked
- [ ] "Shot Data" toggle is disabled when "Shots" is unchecked
- [ ] Disabled toggles have visual indication (reduced opacity, not-allowed cursor)
- [ ] Disabled toggles retain their checked state (not reset)
- [ ] When "Shots" is re-enabled, dependent toggles restore to previous values
- [ ] User cannot interact with disabled toggles
- [ ] TypeScript compiles without errors
## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
