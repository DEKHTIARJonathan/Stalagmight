# fn-15-ygz.9 Add FPS monitoring and auto-throttle

## Description

Add FPS monitoring and auto-throttle that reduces detail when frame rate drops.

**Size:** M
**Files:**
- `src/hooks/useFpsMonitor.ts` (new hook)
- `src/components/GlobalView/GlobalSurveyLayer.ts` (detail adjustment)
- `src/types/config.ts` (add config types)
- `src-tauri/src/config/mod.rs` (add Rust config)
- `src-tauri/src/config/defaults.rs` (add defaults)

## Approach

- Use `requestAnimationFrame` timing to calculate FPS (rolling 30-frame average)
- When FPS < threshold: increase GeoJSON tolerance from 0.5 to 1.0 (primary throttle action)
- When FPS recovers > 45: restore detail
- Add config to both Rust and TypeScript:
  - `global_view.fps_threshold` (default 30)
  - `global_view.tolerance` (default 0.5)
  - `global_view.throttle_tolerance` (default 1.0)

## Acceptance

- [ ] FPS monitored via requestAnimationFrame
- [ ] Detail reduced (tolerance increased) when FPS drops below threshold
- [ ] Detail restored when FPS recovers
- [ ] Config options added in Rust and TypeScript
- [ ] Config options persisted correctly

## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
