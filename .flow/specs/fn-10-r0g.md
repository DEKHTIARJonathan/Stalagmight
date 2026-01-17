# Wire scale bar toggle to MapLibre control

## Overview

Connect showScaleBar toggle to ScaleControl visibility. Control already exists, just needs toggle connection.

## Scope

- Toggle showScaleBar in uiStore
- ScaleControl visible/hidden based on state
- Position: bottom-left
- Persist per project

## Quick commands

```bash
pnpm tsc --noEmit
pnpm test:ui
```

## Acceptance

- [ ] ScaleControl responds to toggle
- [ ] Shows in bottom-left when enabled
- [ ] Hidden when disabled
- [ ] Persists per project
- [ ] Tests pass

## References

- Task spec: `./tasks/task-07-scale-bar-toggle.md`
- MapCanvas.tsx has ScaleControl
