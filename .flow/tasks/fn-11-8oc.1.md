# fn-11-8oc.1 Add section name labels to SurveyLayer

## Description
## Overview
Add section name labels at first station with color + halo.
## Files
- src/components/Map/SurveyLayer.tsx
- src/store/uiStore.ts
## Acceptance
- [ ] Labels at first station
- [ ] Section color + halo
- [ ] Toggle works
- [ ] Tests pass
## Done summary
Added section name labels at first station position with section color and dark halo for contrast. Toggle controlled by showSectionNames setting, persisted per project.
## Evidence
- Commits: 8d9cf41, 45829a9
- Tests: pnpm tsc --noEmit, pnpm test:ui
- PRs: