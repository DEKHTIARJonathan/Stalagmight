## Summary

Added section hover/selection methods to SurveyLayer following existing patterns:

1. Added private state properties:
   - `hoveredSectionId: string | null` (line 83)
   - `selectedSectionId: string | null` (line 84)

2. Added public setter methods:
   - `setHoveredSection(sectionId: SectionId | null): void` (lines 1141-1147)
   - `setSelectedSection(sectionId: SectionId | null): void` (lines 1154-1160)

Both methods:
- Accept numeric `SectionId` and convert to string via `String(sectionId)`
- Have early return optimization if ID unchanged
- Call `updateVisualState()` on change
- Include JSDoc comments explaining the type conversion
