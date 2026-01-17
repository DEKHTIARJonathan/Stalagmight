# Task 18: Add metadata side panel to GlobalView

## Overview
Add a collapsible side panel to GlobalView that shows details when a system is clicked on the map. Double-click opens the system in SingleSystemView.

## Priority
Medium - Phase 4 (GlobalView Enhancements)

## Risk Level
Medium

## Dependencies
- Task 16: ProjectMetadata with GPS info
- Task 17: GlobalView map (provides selection context)

## Files to Modify
- `src/components/GlobalView/GlobalView.tsx` - Add panel container
- `src/components/GlobalView/MetadataPanel.tsx` - New panel component

## Specifications

### Panel Behavior
- Resizable: User can drag to resize width
- Collapsible: Can collapse to just a thin strip
- Position: Right side of GlobalView

### Selection
- Single selection only
- Click system on map or list to show details
- Double-click opens in SingleSystemView

### Metadata Fields (Full Details)
- Project name
- File path
- Creation date
- Last modified date
- Total length
- Section count
- Station count
- Shot count
- GPS coordinates (if available)
- Zero datums list

### Actions
- Available both in panel and context menu
- "Open" button to open in SingleSystemView
- "Show in Folder" to reveal file location
- "Delete" with confirmation

### Panel UI
- Header with project name
- Scrollable content area
- Action buttons at bottom
- Collapse toggle button
- Add `data-testid` attributes:
  - `metadata-panel`
  - `metadata-panel-collapse`
  - `metadata-project-name`
  - `metadata-open-button`

### ARIA Requirements
- `role="complementary"` or `role="region"`
- `aria-label="Project details"`

## Acceptance Criteria
- [ ] Metadata panel visible in GlobalView
- [ ] Panel shows details on system selection
- [ ] Panel resizable
- [ ] Panel collapsible
- [ ] All metadata fields displayed
- [ ] Open button works
- [ ] Double-click opens system
- [ ] Context menu actions match panel actions
- [ ] Single selection only
- [ ] WCAG 2.1 AA accessible
- [ ] TypeScript types pass (`pnpm tsc --noEmit`)
- [ ] Playwright tests pass

## Test Requirements

### Playwright Tests (e2e-playwright/)
- Test panel visible
- Test panel shows details on selection
- Test panel resize works
- Test panel collapse works
- Test all metadata fields shown
- Test Open button opens system
- Test double-click opens system
- Test keyboard accessibility

## Edge Cases
- No system selected (panel empty or hidden)
- System with minimal metadata
- System with very long name/path
- Rapid selection changes
- Panel resize to very small/large

## Implementation Notes
- Similar to existing detail panels in SingleSystemView
- Consider lazy loading metadata for performance
- Panel state (collapsed/width) could be persisted
