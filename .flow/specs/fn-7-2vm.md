# Add live statistics footer to DMP Import Dialog

## Overview

Add a statistics footer showing total length, shot count, and depth range for selected sections. Updates in real-time with 500ms debounce.

## Scope

- Add footer component below section table
- Calculate: total length, shot count, depth range
- Debounced updates (500ms)
- Use config units (meters/feet)
- Text selectable for copy/paste

### Out of Scope
- Export functionality
- Additional statistics

## Approach

1. Add footer div below section table with stats display
2. Calculate stats from selected sections:
   - Total length: sum of all shot.length
   - Shot count: sum of section.shots.length
   - Depth range: min/max of shot.depth values
3. Use useMemo + debounce for performance
4. Format with config units

### Key Files
- `src/components/Dialogs/DmpImportDialog.tsx`
- Config for units

### Reuse Points
- Existing selection state in dialog
- Number formatting utilities

## Quick commands

```bash
pnpm tsc --noEmit
pnpm test:ui
```

## Acceptance

- [ ] Stats footer visible below table
- [ ] Total length calculated correctly
- [ ] Shot count accurate
- [ ] Depth range (min to max) displayed
- [ ] Updates on selection change
- [ ] 500ms debounce for performance
- [ ] Uses config units
- [ ] Text selectable
- [ ] data-testid attributes present
- [ ] Tests pass

## References

- Task spec: `./tasks/task-04-statistics-footer.md`
