# Implement manual map placement mode

## Overview
Section follows cursor after import until click to place. HIGH RISK.

## Dependencies
Depends on fn-17-8ua (return section ID).

## Scope
- Section preview follows cursor
- Snap to nearby stations
- Click to place, Escape/right-click to cancel
- Position only (no rotation v1)

## Quick commands
```bash
pnpm tsc --noEmit && pnpm test:ui
```

## Acceptance
- [ ] Section follows cursor
- [ ] Click places
- [ ] Escape/right-click cancels
- [ ] Snaps to stations
- [ ] Tests pass

## References
- Task spec: `./tasks/task-12-manual-map-placement.md`
- Depends on: fn-17-8ua
