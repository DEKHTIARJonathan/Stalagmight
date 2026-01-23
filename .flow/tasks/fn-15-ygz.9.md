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

<!-- Updated by plan-sync: fn-15-ygz.2 source ID and initial tolerance value -->

- Use `requestAnimationFrame` timing to calculate FPS (rolling 30-frame average)
- When FPS < threshold: increase GeoJSON tolerance from 0.5 to 1.0 (primary throttle action)
- When FPS recovers > 45: restore detail
- Source ID is `global-survey-data` (private `sourceId` in GlobalSurveyLayer)
- Add `setTolerance(value: number)` method to GlobalSurveyLayer that updates source options
- Note: MapLibre requires removing/re-adding source to change tolerance, or use `map.getSource(sourceId).setData()` approach
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
Implemented FPS monitoring with auto-throttle for GlobalView. Added useFpsMonitor hook with rolling 30-frame average, hysteresis (30 FPS down / 45 FPS recovery), pause detection for tab switches, and throttled state updates. Added setTolerance method to GlobalSurveyLayer for dynamic GeoJSON simplification. Integrated with GlobalViewConfig (fps_threshold, tolerance, throttle_tolerance) in both Rust and TypeScript.
## Evidence
- Commits: 6c249ac, 7c0a51c
- Tests: pnpm tsc --noEmit, cargo test --manifest-path src-tauri/Cargo.toml, pnpm test:ui
- PRs: