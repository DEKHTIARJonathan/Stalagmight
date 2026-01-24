# fn-21-q0u.1 Create DetailLink reusable component

## Description
Create a reusable `DetailLink` component for navigating between survey elements in the Detail Panel.

**Size:** S
**Files:** `src/components/common/DetailLink.tsx`

## Approach
- Use `<button>` element styled as link (actions that change state, not navigation)
- Follow existing link styling pattern at `DetailPanel.tsx:205`: `text-accent underline`
- Add focus ring: `focus:ring-2 focus:ring-accent focus:ring-inset` (pattern in SectionsPanel.tsx:218)
- Props: `type` (station|shot|section), target ref/id, `displayText`, `onSelect` callback, `isMissing`, `onAnnounce`
- Handle missing target with warning indicator (yellow text or warning icon)
- Use `<button>` not `<a>` - per a11y best practices, actions that change app state should be buttons
- aria-label format: "Select [type] [displayText]" (e.g., "Select station 2:5")

## data-testid Format
Use stable ID-based test IDs (not displayText which may contain names/spaces):
- **Station links**: `station-{sectionId}-{position}-link` (e.g., `station-2-5-link`)
- **Shot links**: `shot-{sectionId}-{position}-link` (e.g., `shot-2-3-link`)
- **Section links**: `section-{sectionId}-link` (e.g., `section-2-link`)

Component accepts `testId` prop for explicit control, or generates from type + IDs.

## Acceptance
- [ ] Component created at `src/components/common/DetailLink.tsx`
- [ ] Renders as `<button>` styled with `text-accent underline`
- [ ] Accepts `type`, target identifier, `displayText`, `onSelect`, `isMissing`, `onAnnounce` props
- [ ] Includes descriptive `aria-label`
- [ ] Station/Shot links use `data-testid="{type}-{sectionId}-{position}-link"`
- [ ] Section links use `data-testid="section-{sectionId}-link"`
- [ ] Shows warning indicator when `isMissing={true}` (yellow text or icon)
- [ ] Full keyboard support (focusable, Enter activates)
- [ ] Vitest unit tests for helper functions (testId generation, aria-label formatting)

## Done summary
Created DetailLink reusable component for navigating between survey elements with button-styled-as-link pattern, discriminated union types for type-safe targets, and comprehensive unit tests.
## Evidence
- Commits: bf39da0e7a7f8e6ca78b9e2df4b8c5e5b9f3a1d2, e3396bbc8d0b9b5e45162e3bdc9497b41b185bbd
- Tests: pnpm vitest run src/components/common/__tests__/DetailLink.test.ts, pnpm tsc --noEmit
- PRs: