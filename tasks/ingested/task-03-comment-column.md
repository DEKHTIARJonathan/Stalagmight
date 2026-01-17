# Task 03: Add comment column to DMP Import Dialog table

## Overview
Display comment field per shot in the DMP Import Dialog preview table. Comments are user-entered notes associated with individual shots.

## Priority
High - Phase 1 (Import Dialog Enhancements)

## Risk Level
Medium

## Dependencies
None - can start immediately

## Files to Modify
- `src/components/Dialogs/DmpImportDialog.tsx` - Add comment column with expandable rows

## Specifications

### Display Format
- Show comments in an expandable row format
- Truncate long comments in collapsed state
- Click to expand and see full comment
- Empty cell for shots without comments

### Column Header
- Comment

### Data Source
- Comment data comes from `shot.comment` in parsed DMP data
- User-entered text field (optional)
- NOT device-generated metadata

### Expandable Row Behavior
- Default: Show truncated comment (first ~50 characters + "...")
- Click row or expand icon to show full comment
- Expand icon only visible when comment is truncated
- Consider using a tooltip as alternative for short previews

### UI Requirements
- Column should match existing table styling
- Add expand/collapse icon for long comments
- Add `data-testid` attributes:
  - `comment-{rowIndex}`
  - `comment-expand-{rowIndex}` (for expand button)
- WCAG 2.1 AA compliant (keyboard accessible)

## Acceptance Criteria
- [ ] Comment column visible in import preview table
- [ ] Short comments display in full
- [ ] Long comments truncated with expand option
- [ ] Expand/collapse works correctly
- [ ] Empty cells for shots without comments
- [ ] Keyboard accessible (Tab, Enter to expand)
- [ ] TypeScript types pass (`pnpm tsc --noEmit`)
- [ ] Playwright tests pass

## Test Requirements

### Playwright Tests (e2e-playwright/)
- Test comment column visible in import dialog
- Test short comment displays correctly
- Test long comment truncation
- Test expand/collapse functionality
- Test keyboard accessibility
- Test empty cells for no comment

## Edge Cases
- Very long comments (1000+ characters)
- Comments with special characters
- Comments with newlines
- Empty string vs null comment
- Unicode/emoji in comments

## Implementation Notes
- Comments are optional - field should handle undefined gracefully
- Consider performance for many rows with comments
