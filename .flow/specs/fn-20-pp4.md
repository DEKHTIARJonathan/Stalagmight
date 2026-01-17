# Add GPS-based map to GlobalView

## Overview
Satellite map showing all GPS-positioned systems. Depends on fn-19-5b1.

## Scope
- Map tab + List tab
- Full system shapes at GPS positions
- Click selects, double-click opens
- Fit all systems in view (max 500km x 500km)
- No clustering

## Quick commands
```bash
pnpm tsc --noEmit && pnpm test:ui
```

## Acceptance
- [ ] Map/List tabs
- [ ] Systems at GPS positions
- [ ] Click/double-click interaction
- [ ] No-GPS systems in list only
- [ ] Tests pass

## References
Depends on: fn-19-5b1
