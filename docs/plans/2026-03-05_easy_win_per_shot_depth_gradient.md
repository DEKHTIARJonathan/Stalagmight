# Plan: Easy Win from User Feedback - Per-Shot Depth Gradient

Date: 2026-03-05

## Picked easy win

From user feedback in `TODO.md`:
- "Add per-shot depth gradient" (shots that go shallow -> deep currently render as one flat color).

Feedback source:
- `docs/transcripts/1-summary.md` ("Shots lack per-shot depth gradient", ~line 677-679).

## Why this is a good quick win

- Tight scope: mainly map rendering logic, no Rust parser/export workflow changes.
- High visual payoff: makes depth mode immediately more informative for users.
- Low product risk: only applies when depth gradient is already enabled.

## Likely code touchpoints

- `src/components/Map/surveyLayer/features.ts`
  - Shot features currently store a single `color` from average depth.
- `src/components/Map/SurveyLayer.tsx`
  - Shot layer currently paints `line-color` from `['get', 'color']`.
  - Shot GeoJSON source setup (needs `lineMetrics` for `line-progress` gradients).
- `e2e-playwright/depth-gradient.spec.ts`
  - Existing depth-gradient suite can be extended with one per-shot assertion.

## Proposed implementation plan

1. Add endpoint depth colors to shot features
- In `buildSurveyFeatures`, compute `fromColor` from `fromStation.coordinates.z` and `toColor` from `toStation.coordinates.z` when depth gradient is ON.
- Keep current flat `color` property as fallback (used when depth gradient is OFF and by non-gradient layers).

2. Enable line-progress gradients on the shot source
- In `SurveyLayer.initializeSources()`, set `lineMetrics: true` on `survey-data-shots`.
- This enables MapLibre `line-gradient` expressions.

3. Switch shot paint to per-shot gradient in depth mode
- Update the main `survey-shots` layer paint to use:
  - depth mode ON: `line-gradient` interpolating from `fromColor` at `line-progress=0` to `toColor` at `line-progress=1`.
  - depth mode OFF: preserve existing section/reference color behavior.
- Keep existing width/opacity/selection/hover behavior unchanged.

4. Preserve drag and hit-testing behavior
- Keep hitbox and drag-preview layers on flat color to avoid complexity.
- Validate interaction behavior (hover, selection, move shot) remains identical.

5. Add regression coverage
- Extend `e2e-playwright/depth-gradient.spec.ts` with a test that:
  - seeds at least one shot where endpoint depths differ;
  - enables depth gradient;
  - verifies shot feature properties include distinct endpoint colors;
  - verifies a flat-color fallback still works when depth gradient is OFF.

6. Update tracking
- Mark the TODO user-feedback item "Add per-shot depth gradient" as done after merge.

## Acceptance criteria

- With depth gradient ON, a single shot can visibly transition from shallow color to deep color.
- With depth gradient OFF, shot styling remains unchanged from current behavior.
- Hover/selection/move-shot interactions behave the same as before.
- Existing depth legend and station depth coloring continue to work.

## Risks and mitigations

- Risk: `line-gradient` can conflict with assumptions in existing style updates.
  - Mitigation: scope gradient logic to `survey-shots` layer only; keep other layers unchanged.
- Risk: source config change (`lineMetrics`) may affect rendering performance.
  - Mitigation: measure on a representative project; if needed, keep feature payload minimal and avoid extra per-frame work.
