# fn-15-ygz.9 Add FPS monitoring and auto-throttle

## Description
Add FPS monitoring and auto-throttle that reduces detail when frame rate drops below threshold.

**Size:** M
**Files:** 
- `src/hooks/useFpsMonitor.ts` (new hook)
- `src/components/GlobalView/GlobalSurveyLayer.ts` (detail level adjustment)
- `src/types/config.ts` (add throttle config)

## Approach

- Use `requestAnimationFrame` timing to calculate FPS
- Sample over 30 frames, calculate rolling average
- When FPS < 30 (configurable): increase GeoJSON tolerance, reduce max rendered features
- When FPS recovers > 45: gradually restore detail
- Store threshold in config (default 30 FPS)

## Key context

- FPS = 1000 / (currentTime - lastTime)
- Auto-throttle actions: increase tolerance from 0.5 to 1.0+, hide small features
## Acceptance
- [ ] FPS monitored via requestAnimationFrame timing
- [ ] When FPS drops below threshold, detail is reduced
- [ ] When FPS recovers, detail is gradually restored
- [ ] Threshold configurable in config (default 30)
- [ ] No visual stutter from throttle adjustment
## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
