# fn-12-szd.2 Add section zoom state to UIStore

## Description
Add section zoom request state to UIStore following the existing `requestFitToBounds` pattern.

**Size:** S
**Files:** `src/store/uiStore.ts`

## Approach

- Follow pattern at `src/store/uiStore.ts:163-165` (`requestFitToBounds`, `triggerFitToBounds`, `clearFitToBoundsRequest`)
- Add `requestZoomToSection: SectionId | null` state
- Add `triggerZoomToSection(sectionId: SectionId)` action
- Add `clearZoomToSectionRequest()` action

## Key context

- `SectionId` is a number type alias from `src/types/project.ts`
- UIStore uses Zustand with immer middleware
## Acceptance
- [ ] `requestZoomToSection: SectionId | null` state added to UIStore
- [ ] `triggerZoomToSection(sectionId)` action triggers zoom request
- [ ] `clearZoomToSectionRequest()` clears the request after handling
- [ ] Type exports updated if needed
- [ ] `pnpm tsc --noEmit` passes
## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
