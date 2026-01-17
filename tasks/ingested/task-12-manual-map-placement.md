# Task 12: Implement manual map placement mode

## Overview
After import, enable a placement mode where the newly imported section follows the mouse cursor until the user clicks to place it. Cancel with Escape or right-click.

## Priority
High - Phase 3 (GPS & Placement)

## Risk Level
High

## Dependencies
- Task 14: Return section ID from create_section command (needed to identify new section)

## Files to Modify
- `src/components/Map/MapCanvas.tsx` - Add placement mode handling
- `src/store/uiStore.ts` - Add placement mode state
- `src/hooks/useMapTools.ts` - Add placement tool logic

## Specifications

### Activation
- Triggered after section import (optional choice)
- Or via manual placement button in section panel

### Placement UI
- Full section preview follows cursor
- Section rendered at cursor position
- Show all stations and shots
- Snap to nearby stations (see snap behavior)

### Snap Behavior
- Snap to existing stations when nearby
- Visual indicator when snapping
- Snap threshold: configurable or ~20 pixels

### Alignment Point
- User selects which station of new section aligns to cursor
- Default: first station
- Can change during placement

### Confirm/Cancel
- Left click: Confirm placement
- Escape: Cancel placement
- Right-click: Cancel placement

### No Rotation
- Position only in v1
- Rotation deferred to v2

### UI Requirements
- Cursor changes to indicate placement mode
- Visual feedback for snap targets
- Status message: "Click to place section, Escape to cancel"
- Add `data-testid` attributes:
  - `placement-mode-indicator`
  - `placement-preview`

## Acceptance Criteria
- [ ] Section follows cursor in placement mode
- [ ] Click places section
- [ ] Escape cancels placement
- [ ] Right-click cancels placement
- [ ] Snaps to nearby stations
- [ ] Visual snap indicator
- [ ] Section stays where placed after click
- [ ] TypeScript types pass (`pnpm tsc --noEmit`)
- [ ] Playwright tests pass

## Test Requirements

### Playwright Tests (e2e-playwright/)
- Test placement mode activates
- Test section follows cursor
- Test click places section
- Test Escape cancels
- Test right-click cancels
- Test snap to station

## Edge Cases
- Cancel immediately after activation
- Place at map edge
- Place on top of existing section
- Rapid mouse movement
- Zoom/pan during placement

## Implementation Notes
- High risk: complex interaction mode
- Need to track mouse position in map coordinates
- May need temporary section state before confirming
- Consider performance with large sections
