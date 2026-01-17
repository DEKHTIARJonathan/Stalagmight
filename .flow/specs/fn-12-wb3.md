# Implement station index labels on map

## Overview
Render station index numbers (0,1,2...) near dots. Zoom-dependent visibility.

## Scope
- Index at each station
- Zoom-dependent (hidden when zoomed out)
- showStationLabels toggle
- Persist per project

## Quick commands
```bash
pnpm tsc --noEmit && pnpm test:ui
```

## Acceptance
- [ ] Labels near station dots
- [ ] Correct index numbers
- [ ] Hidden when zoomed out
- [ ] Toggle works
- [ ] Persists per project
- [ ] Tests pass

## References
- Task spec: `./tasks/task-09-station-index-labels.md`
