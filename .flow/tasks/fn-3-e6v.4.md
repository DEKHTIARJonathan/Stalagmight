# fn-3-e6v.4 Implement toggle disable relationships in DisplayMenu

## Description
Implement toggle disable relationships in DisplayMenu.

## File to Modify

### `src/components/SingleSystemView/DisplayMenu.tsx`

**Current structure (L11-32):**
The `displayOptions` array contains groups with items. Each item has `key`, `label`, `description`.

## Implementation

Need to make "Virtual Shots" and "Shot Data" toggles disabled when "Shots" is unchecked.

**Option 1: Extend item type with `disabledWhen`:**
```typescript
interface DisplayOption {
  key: DisplayToggleKey;
  label: string;
  description: string;
  disabledWhen?: DisplayToggleKey; // disabled when this toggle is false
}

// In displayOptions:
{ key: 'showVirtualShots', label: 'Virtual Shots', ..., disabledWhen: 'showShots' },
{ key: 'showShotData', label: 'Shot Data', ..., disabledWhen: 'showShots' },
```

**Option 2: Compute in render:**
```typescript
const isDisabled = (key: DisplayToggleKey) => {
  if (key === 'showVirtualShots' || key === 'showShotData') {
    return !showShots;
  }
  return false;
};
```

**Visual indication:**
- Disabled toggles: `opacity: 0.5`, `cursor: not-allowed`
- Checkbox: `disabled` prop set to true
- Retain checked state (don't reset value)

**Behavior:**
- When Shots re-enabled, dependent toggles restore to their previous values
- This happens naturally since we only disable UI interaction, not change the state
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
- [ ] "Virtual Shots" toggle disabled when "Shots" is unchecked
- [ ] "Shot Data" toggle disabled when "Shots" is unchecked
- [ ] Disabled toggles have visual indication (reduced opacity, not-allowed cursor)
- [ ] Disabled checkbox has `disabled` prop
- [ ] Disabled toggles retain their checked state (not reset to false)
- [ ] When "Shots" re-enabled, dependent toggles immediately apply their stored values
- [ ] User cannot click/change disabled toggles
- [ ] `pnpm tsc --noEmit` passes
## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
