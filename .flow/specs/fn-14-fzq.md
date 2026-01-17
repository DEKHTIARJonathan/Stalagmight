# Add From Existing Station placement option

## Overview
Connect imported section to existing station with auto-merge.

## Scope
- Placement mode selector
- Station dropdown from project
- Click station in preview
- Preview shows connection
- Auto-merge on import
- Disabled when no project

## Quick commands
```bash
pnpm tsc --noEmit && pnpm test:ui
```

## Acceptance
- [ ] Placement mode selector
- [ ] Station dropdown populated
- [ ] Preview shows connection
- [ ] Import merges correctly
- [ ] Disabled without project
- [ ] Tests pass

## References
- Task spec: `./tasks/task-11-existing-station-placement.md`
