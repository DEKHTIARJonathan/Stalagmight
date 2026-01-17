# fn-20-pp4.1 Add GlobalView map with tabs

## Description
TBD

## Acceptance
- [ ] TBD

## Done summary
Added GPS-based satellite map to GlobalView with Map/List tabs. The Map tab displays all GPS-positioned systems as clickable markers on OpenStreetMap tiles, while the List tab shows all projects as cards. Click selects a system, double-click opens the project.
## Evidence
- Commits: 6a7363d119973f10960febd0c1828b39ed264e4f
- Tests: pnpm tsc --noEmit (0 errors), pnpm test:ui (150 passed), cargo test (69 passed)
- PRs: