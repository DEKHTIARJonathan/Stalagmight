# fn-26-ube.1 Add grid overlay layer

## Description
TBD

## Acceptance
- [ ] TBD

## Done summary
Added grid overlay layer to map with configurable spacing options. Grid renders using MapLibre layer that scales with the map, toggle works via Display menu, and spacing can be set to 1m, 5m, 10m, 25m, 50m, or 100m.
## Evidence
- Commits: de1f434620fcffd1897a6c5289a027ff4953078f
- Tests: pnpm tsc --noEmit, cargo test, pnpm test:ui
- PRs: