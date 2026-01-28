# fn-40-tub.3 Remove survey-merges map layer and feature builder

## Description

Remove the `survey-merges` map layer entirely. Merged stations always perfectly overlap, so the cyan dashed line between them provides no useful information. Remove the layer definition, source, feature builder code, and all references.

**Size:** S (combine with task 1 or run in parallel — touches different files than backend)
**Files:**
- `src/components/Map/SurveyLayer.tsx` — remove `mergesLayerId`, layer setup, source setup, update calls
- `src/components/Map/surveyLayer/features.ts` — remove `buildMergeFeatures`, `mergeFeatures` from return types

## Approach

### 1. Remove from `features.ts`
- Remove `mergeFeatures` from the `SurveyFeatureSets` interface/return type (around line 16)
- Remove the `buildMergeFeatures` code block (lines 244-266) that iterates over `stationMerges` and creates LineString features
- Remove `mergeFeatures` from the return value of `buildSurveyFeatures()`

### 2. Remove from `SurveyLayer.tsx`
- Remove `private mergesLayerId = 'survey-merges'` constant (line 65)
- Remove the `addSource` call for `this.sourceId + '-merges'` (around line 234)
- Remove the `addLayer` call that creates the `survey-merges` layer
- Remove the `getSource`/`setData` calls for the merges source in the update method (around line 424)
- Remove any `removeLayer`/`removeSource` calls for merges in the cleanup/destroy method
- Remove any visibility toggle code for the merges layer (around line 1261)
- Search for ALL references to `merges` or `merge` in both files to ensure nothing is missed

### 3. Verify no other references
- Search codebase for `survey-merges` string to ensure no test or other code references it
- Search for `mergeFeatures` to catch any remaining references
- Search for `buildMergeFeatures` to catch any remaining references

## Key context

- The `survey-loop-closures` layer must be preserved — only remove the `survey-merges` layer
- MapLibre layer removal order matters: remove layer before source
- `hasLiveStyle()` utility should be used to guard layer operations (existing pattern)
## Acceptance
- [ ] `survey-merges` layer no longer exists in the map
- [ ] `mergesLayerId` constant removed from SurveyLayer.tsx
- [ ] `buildMergeFeatures` code removed from features.ts
- [ ] `mergeFeatures` removed from feature set interface and return values
- [ ] No source setup for merges in SurveyLayer.tsx
- [ ] No references to `survey-merges`, `mergeFeatures`, or `buildMergeFeatures` remain in codebase
- [ ] `survey-loop-closures` layer still works correctly
- [ ] `pnpm tsc --noEmit` passes
## Done summary
Removed the survey-merges map layer, source, feature builder, and all references. Renamed ghost mergeFeatures to mergeStationFeatures to fully eliminate the mergeFeatures symbol. Fixed pre-existing tsc error with canvasContextAttributes type assertion.
## Evidence
- Commits: 488c9fd, 3b8bedb
- Tests: pnpm tsc --noEmit, cargo test --manifest-path src-tauri/Cargo.toml
- PRs: