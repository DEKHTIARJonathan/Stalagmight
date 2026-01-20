# fn-3-e6v.4 Implement toggle disable relationships in DisplayMenu

## Description
Implement toggle disable relationships in DisplayMenu using existing button-row pattern.

## File: `src/components/SingleSystemView/DisplayMenu.tsx`

### Current Pattern

DisplayMenu uses **button rows** with inline checkbox, NOT standalone Checkbox components.

### Implementation

```typescript
interface DisplayOption {
  key: DisplayToggleKey;
  label: string;
  description: string;
  disabledWhen?: DisplayToggleKey; // disabled when this toggle is false
}

const displayOptions = [
  { key: 'showShots', label: 'Shots', description: 'Show survey shot lines' },
  { key: 'showVirtualShots', label: 'Virtual Shots', ..., disabledWhen: 'showShots' },
  { key: 'showShotData', label: 'Shot Data', ..., disabledWhen: 'showShots' },
  // ... other options
];

// Helper function
const isDisabled = (option: DisplayOption) => 
  option.disabledWhen ? !toggleState[option.disabledWhen] : false;

// In button row render:
<button
  onClick={() => !isDisabled(option) && toggleDisplay(option.key)}
  aria-disabled={isDisabled(option)}
  className={cn(
    "flex items-center gap-2 w-full px-3 py-2 text-sm hover:bg-gray-100",
    isDisabled(option) && "opacity-50 cursor-not-allowed hover:bg-transparent"
  )}
>
  <span className={cn(
    "w-4 h-4 border rounded",
    toggleState[option.key] && "bg-blue-500",
    isDisabled(option) && "border-gray-300"
  )} />
  <span>{option.label}</span>
</button>
```

### Behavior

- When `showShots` is OFF: "Virtual Shots" and "Shot Data" rows show disabled styling
- Disabled rows have `opacity-50` and `cursor-not-allowed`
- Clicking disabled row does nothing (guard in onClick)
- `aria-disabled` for accessibility
- Checkbox visual state retained (just grayed out)
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
- [ ] `disabledWhen` property added to DisplayOption interface
- [ ] `isDisabled(option)` helper function checks parent toggle state
- [ ] "Virtual Shots" has `disabledWhen: 'showShots'`
- [ ] "Shot Data" has `disabledWhen: 'showShots'`
- [ ] Disabled rows have `opacity-50` class
- [ ] Disabled rows have `cursor-not-allowed` class
- [ ] onClick guard prevents toggle when disabled
- [ ] `aria-disabled` attribute set for accessibility
- [ ] Disabled rows retain their checked state visually
- [ ] Re-enabling parent immediately shows correct child states
- [ ] `pnpm tsc --noEmit` passes
## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
